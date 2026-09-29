/**
 * Mistral Vibe 2.25.8 native persistence, audited at upstream commit
 * 7c19608af06f6c61d63f8f7a5c3430da73fba2ab:
 * https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/types.py
 * https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/session/session_logger.py
 *
 * meta.json holds session state (including the system prompt); messages.jsonl
 * holds LLMMessage objects. Rewind/compaction can replace the entire JSONL file.
 * Scan complete snapshots, assigning stable sequence numbers to native message
 * IDs, rather than using line-count cursors that silently miss rewritten tails.
 * Metadata's current model selection is NOT historical per-message provenance.
 * Supported backend: legacy (default absent an enabled unified rollout, or
 * explicit --legacy-harness). The optional internal unified backend uses a
 * different store, detected and warned about rather than silently claimed.
 * See the same commit's vibe/_experimental_harness.py:resolve_harness_selection.
 */
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, findRepo, gitUserIdentity, sha256Hex, type GitUserIdentity, type RepoInfo } from "annals";
import { appendEvents, readEvents } from "../store.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, unrecognizedDraft, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, sessionStateDraft, type RecordContext } from "./records.js";

const SOURCE = "mistral-vibe";
const FORMAT = "mistral-vibe-session-jsonl/1";
type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const emptyResult = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const ROLES = new Set(["system", "user", "assistant", "tool"]);

function nativeKey(line: unknown): string {
  return object(line) && typeof line.message_id === "string" ? `message:${line.message_id}`
    : object(line) && line.role === "tool" && typeof line.tool_call_id === "string" ? `tool:${line.tool_call_id}`
    : `legacy:${sha256Hex(canonicalJson(line))}`;
}

interface PositionState { next: number; positions: Record<string, number> }
function statePath(repo: RepoInfo, session: string): string {
  return join(repo.commonDir, "conversation-ledger", "cursors", `mistral-vibe-${sha256Hex(session)}.json`);
}
async function readPositions(repo: RepoInfo, session: string): Promise<PositionState> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath(repo, session), "utf8"));
    if (object(value) && Number.isSafeInteger(value.next) && (value.next as number) > 0 && object(value.positions) &&
      Object.values(value.positions).every((n) => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) < (value.next as number))) {
      return value as unknown as PositionState;
    }
  } catch { /* Recover native positions from durable events below. */ }
  const state: PositionState = { next: 1, positions: {} };
  const events = (await readEvents(repo, { source: SOURCE })).filter((event) =>
    event.producer.session_id === session && event.stream && event.stream.seq > 0 && event.kind !== "reasoning" && event.raw);
  const bySeq = new Map(events.map((event) => [event.stream!.seq, event]));
  const occurrences = new Map<string, number>();
  for (const [seq, event] of [...bySeq].sort(([a], [b]) => a - b)) {
    const persisted = event.meta?.["vibe_position_key"];
    if (typeof persisted === "string") {
      state.positions[persisted] = seq;
      state.next = Math.max(state.next, seq + 1);
      continue;
    }
    const native = nativeKey(event.raw!.data);
    const occurrence = occurrences.get(native) ?? 0;
    occurrences.set(native, occurrence + 1);
    state.positions[sha256Hex(`${native}:${occurrence}`)] = seq;
    state.next = Math.max(state.next, seq + 1);
  }
  return state;
}
async function savePositions(repo: RepoInfo, session: string, state: PositionState): Promise<void> {
  const path = statePath(repo, session);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state) + "\n");
  await rename(tmp, path);
}
function position(state: PositionState, key: string): number {
  const encoded = sha256Hex(key); // Cursor holds no transcript text or credentials.
  return state.positions[encoded] ?? (state.positions[encoded] = state.next++);
}
function context(session: string, time: string, seq: number, parent?: string): RecordContext {
  return { source: SOURCE, sessionId: session, occurredAt: time, seq, version: packageVersion(), rawFormat: FORMAT,
    conversationId: `${SOURCE}:${session}`, ...(parent ? { parentConversationId: `${SOURCE}:${parent}` } : {}) };
}
function drift(line: unknown, ctx: RecordContext, key: string): EventDraft {
  return unrecognizedDraft({ typeKey: key, line, occurredAt: ctx.occurredAt, source: SOURCE,
    sessionId: ctx.sessionId, seq: ctx.seq, version: ctx.version, rawFormat: FORMAT,
    conversationId: ctx.conversationId,
    ...(ctx.parentConversationId ? { parentConversationId: ctx.parentConversationId } : {}) });
}

/** Configuration can contain literal headers/MCP environment credentials.
 * Capture their presence, never their values; ordinary message text still
 * goes through the shared content redactor rather than this config policy. */
function safeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeConfig);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^(?:api_key|access_token|refresh_token|token|secret|password|authorization|headers|extra_headers|env|environment)$/i.test(key)
      ? { omitted: "configuration_credentials" } : safeConfig(child)]));
}

/** Only explicit encrypted_content fields are sealed. Signed thinking text
 * and other provider metadata remain subject to ordinary redaction. */
function separateEncrypted(value: unknown, encrypted: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((item) => separateEncrypted(item, encrypted));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === "encrypted_content" && child != null) {
      encrypted.push(child);
      return [key, { preserved_as: "reasoning" }];
    }
    return [key, separateEncrypted(child, encrypted)];
  }));
}

/** All LLMMessage fields not normalized into blocks stay explicit in content,
 * and the complete native object remains in raw (subject to central redaction
 * and attachment policy). Null content is valid on tool-call-only messages. */
function convertMessage(line: unknown, ctx: RecordContext, identity: GitUserIdentity, subagent = false): EventDraft | null {
  if (!object(line) || typeof line.role !== "string" || !ROLES.has(line.role)) return null;
  if (line.content != null && typeof line.content !== "string") return null;
  if (line.reasoning_content != null && typeof line.reasoning_content !== "string") return null;
  if (line.tool_calls != null && (!Array.isArray(line.tool_calls) || line.tool_calls.some((call) =>
    !object(call) || call.type !== "function" || !object(call.function)))) return null;
  if (line.images != null && !Array.isArray(line.images)) return null;
  const safeLine: Obj = { ...line, ...(line.reasoning_payloads !== undefined ? {
    reasoning_payloads: separateEncrypted(line.reasoning_payloads, []),
  } : {}) };
  const { content, reasoning_content, tool_calls, images, ...fields } = safeLine;
  const blocks: unknown[] = [];
  if (typeof reasoning_content === "string") blocks.push({ type: "thinking", text: reasoning_content });
  if (line.role === "tool") {
    blocks.push({ type: "tool_result", ...(typeof line.tool_call_id === "string" ? { tool_use_id: line.tool_call_id } : {}),
      content: content ?? "", ...(line.tool_result !== undefined ? { result: line.tool_result } : {}) });
  } else if (typeof content === "string") blocks.push({ type: "text", text: content });
  if (Array.isArray(tool_calls)) for (const call of tool_calls as Obj[]) {
    const fn = call.function as Obj;
    blocks.push({ type: "tool_use", ...(typeof call.id === "string" ? { id: call.id } : {}),
      ...(typeof fn.name === "string" ? { name: fn.name } : {}),
      ...(fn.arguments !== undefined ? { input: fn.arguments } : {}),
      ...(call.presentation !== undefined ? { presentation: call.presentation } : {}) });
  }
  if (Array.isArray(images)) for (const attachment of images) blocks.push({ type: "image", attachment });
  const injected = line.injected === true;
  // parent_session_id also links reset/continuation sessions. Only a verified
  // child_sessions link proves delegation; absent that evidence parent-linked
  // user messages have unknown authorship, rather than a guessed human name.
  const actor = line.role === "assistant" ? "agent"
    : line.role === "user" && !injected ? subagent ? "system" : ctx.parentConversationId ? "unknown" : "human" : "system";
  const kind = line.context_boundary === "compaction" ? "activity" : injected ? "context_injection" : "conversation_turn";
  return recordDraft({ ...ctx, identity }, kind, actor, { ...fields, blocks,
    ...(kind === "activity" ? { activity_type: "compaction" } : {}),
    ...(kind === "context_injection" ? { injection_type: "injected_message" } : {}) }, safeLine);
}

export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null {
  if (!event.raw || !event.stream) return null;
  return convertMessage(event.raw.data, context(event.producer.session_id ?? "", event.occurred_at, event.stream.seq,
    event.stream.parent?.replace(/^mistral-vibe:/, "")), identity, event.meta?.["vibe_subagent"] === true);
}

/** Raw upgrades must retain the encrypted sibling as well as visible text. */
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  const visible = renormalizeUnrecognized(event, identity);
  if (!visible || !event.raw || !event.stream) return null;
  const line = event.raw.data;
  const encrypted: unknown[] = [];
  if (object(line)) separateEncrypted(line.reasoning_payloads, encrypted);
  const drafts = [visible];
  if (encrypted.length) drafts.push(encryptedDraft(line, encrypted, context(event.producer.session_id ?? "",
    event.occurred_at, event.stream.seq, event.stream.parent?.replace(/^mistral-vibe:/, ""))));
  return drafts;
}

function encryptedDraft(line: unknown, encrypted: unknown[], ctx: RecordContext): EventDraft {
  return recordDraft(ctx, "reasoning", "agent", { opaque: true, encrypted_sha256: sha256Hex(canonicalJson(encrypted)) },
    { encrypted_content: encrypted, ...(object(line) ? { message_id: line.message_id ?? null } : {}) });
}

async function metadataAt(dir: string): Promise<Obj | null> {
  try { const value: unknown = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")); return object(value) ? value : null; }
  catch { return null; }
}
async function canonical(path: string): Promise<string> { try { return await realpath(path); } catch { return resolve(path); } }
function contained(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

async function verifiedDelegation(dir: string, session: string, parent: string | undefined): Promise<boolean> {
  if (!parent) return false;
  let ancestor = dirname(dir);
  while (ancestor !== dirname(ancestor)) {
    const meta = await metadataAt(ancestor);
    if (meta?.session_id === parent && Array.isArray(meta.child_sessions)) {
      for (const link of meta.child_sessions) {
        if (object(link) && link.session_id === session && typeof link.relative_path === "string" &&
          !isAbsolute(link.relative_path) && await canonical(resolve(ancestor, link.relative_path)) === dir && contained(ancestor, dir)) return true;
      }
      return false;
    }
    ancestor = dirname(ancestor);
  }
  return false;
}

async function captureDirectory(repo: RepoInfo, dir: string, visited: Set<string>, expected?: { session: string; parent: string }): Promise<CaptureResult> {
  dir = await canonical(dir);
  if (visited.has(dir)) return emptyResult();
  const lock = `${statePath(repo, dir)}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await mkdir(lock); await writeFile(join(lock, "owner"), String(process.pid)); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Reclaim an old lock only when its process is gone. A slow but live
      // capture must never lose ownership to a second hook.
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 120_000) {
          const pid = Number(await readFile(join(lock, "owner"), "utf8").catch(() => ""));
          let alive = false;
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); alive = true; }
            catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== "ESRCH"; }
          }
          if (!alive) await rm(lock, { recursive: true, force: true });
        }
      }
      catch { /* The owner may have just released it. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new Error("mistral-vibe capture is busy; retry after the active capture finishes");
  try { return await captureDirectoryUnlocked(repo, dir, visited, expected); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function captureDirectoryUnlocked(repo: RepoInfo, dir: string, visited: Set<string>, expected?: { session: string; parent: string }): Promise<CaptureResult> {
  const result = emptyResult();
  dir = await canonical(dir);
  if (visited.has(dir)) return result;
  visited.add(dir);
  const meta = await metadataAt(dir);
  if (!meta || typeof meta.session_id !== "string" || !iso(meta.start_time)) {
    if (await stat(join(dir, "CURRENT")).then(() => true, () => false)) {
      process.stderr.write("cledger: mistral-vibe unified harness store is not supported; only legacy meta.json/messages.jsonl sessions are captured\n");
    }
    return result;
  }
  const session = meta.session_id;
  const parent = typeof meta.parent_session_id === "string" ? meta.parent_session_id : undefined;
  if (expected && (session !== expected.session || parent !== expected.parent)) return result;
  let raw: string;
  try { raw = await readFile(join(dir, "messages.jsonl"), "utf8"); } catch { return result; }
  const identity = await gitUserIdentity(repo);
  const state = await readPositions(repo, session);
  const drafts: EventDraft[] = [];
  const subagent = expected !== undefined || await verifiedDelegation(dir, session, parent);
  // One state event per distinct persisted metadata snapshot; repeated reads
  // dedup. System prompts/tool definitions/config/stats are never discarded.
  const safeMeta = { ...meta, ...(meta.config !== undefined ? { config: safeConfig(meta.config) } : {}),
    ...(object(meta.agent_profile) ? { agent_profile: safeConfig(meta.agent_profile) } : {}) };
  drafts.push(sessionStateDraft(context(session, meta.start_time, 0, parent), "metadata", safeMeta, safeMeta));
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const occurrences = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    let line: unknown;
    try { line = JSON.parse(text); }
    catch {
      // The writer appends JSONL; an incomplete tail is retried on the next
      // snapshot. Interior corruption is preserved rather than silently lost.
      if (i === lines.length - 1 && !raw.endsWith("\n")) continue;
      line = { malformed_json: text };
    }
    const native = nativeKey(line);
    const occurrence = occurrences.get(native) ?? 0;
    occurrences.set(native, occurrence + 1);
    const seq = position(state, `${native}:${occurrence}`);
    // Native LLMMessage has no wall-clock timestamp. Use the session start,
    // not mutable end_time or capture time, and keep native IDs for ordering.
    const ctx = context(session, meta.start_time, seq, parent);
    const draft = convertMessage(line, ctx, identity, subagent);
    if (draft) {
      draft.meta = { vibe_position_key: sha256Hex(`${native}:${occurrence}`), ...(subagent ? { vibe_subagent: true } : {}) };
      drafts.push(draft);
      const encrypted: unknown[] = [];
      if (object(line)) separateEncrypted(line.reasoning_payloads, encrypted);
      if (encrypted.length) drafts.push(encryptedDraft(line, encrypted, ctx));
    }
    else {
      const key = object(line) && typeof line.role === "string" ? `message/${line.role}/invalid-shape` : "message/unrecognized";
      countUnrecognized(result.unrecognized, key);
      const preserved = drift(line, ctx, key);
      preserved.meta = { vibe_position_key: sha256Hex(`${native}:${occurrence}`), ...(subagent ? { vibe_subagent: true } : {}) };
      drafts.push(preserved);
    }
  }
  // Persist positions before appending: failed appends can retry with the same
  // IDs, and an interrupted write never causes surviving messages to renumber.
  await savePositions(repo, session, state);
  const appended = await appendEvents(repo, drafts);
  result.appended += appended.appended.length;
  result.deduped += appended.deduped;
  if (Array.isArray(meta.child_sessions)) for (const link of meta.child_sessions) {
    if (!object(link) || typeof link.relative_path !== "string" || typeof link.session_id !== "string") continue;
    if (isAbsolute(link.relative_path)) continue;
    const child = await canonical(resolve(dir, link.relative_path));
    if (!contained(dir, child)) continue; // No traversal or symlink escape.
    mergeCaptureResult(result, await captureDirectory(repo, child, visited, { session: link.session_id, parent: session }));
  }
  return result;
}

/** Accept the hook's messages.jsonl path or an explicitly selected session directory. */
export async function captureMistralVibeTranscript(path: string, cwd: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  let dir = path;
  try { if (!(await stat(path)).isDirectory()) dir = dirname(path); } catch { return emptyResult(); }
  const result = await captureDirectory(repo, dir, new Set());
  warnUnrecognized(SOURCE, result.unrecognized);
  return result;
}

/** Exact cwd scoping prevents adopting other projects from the global store.
 * Pass sessionRoot for a custom session_logging.save_dir; VIBE_HOME is honored. */
export async function captureMistralVibeAll(cwd: string, sessionRoot?: string): Promise<CaptureResult> {
  const root = sessionRoot ?? join(process.env["VIBE_HOME"] || join(homedir(), ".vibe"), "logs", "session");
  const target = await canonical(cwd);
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const total = emptyResult();
  const visited = new Set<string>();
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return total; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (entry.name === "unified") {
      process.stderr.write("cledger: mistral-vibe unified harness store is not supported; only meta.json/messages.jsonl sessions are captured\n");
      continue;
    }
    const meta = await metadataAt(dir);
    const workdir = object(meta?.environment) ? meta.environment.working_directory : undefined;
    if (typeof workdir !== "string" || await canonical(workdir) !== target) continue;
    mergeCaptureResult(total, await captureDirectory(repo, dir, visited));
  }
  warnUnrecognized(SOURCE, total.unrecognized);
  return total;
}

export async function runMistralVibeHook(stdinJson: string): Promise<void> {
  try {
    const payload: unknown = JSON.parse(stdinJson);
    if (!object(payload) || typeof payload.transcript_path !== "string" || !payload.transcript_path) return;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    if (!(await findRepo(cwd))) return;
    await captureMistralVibeTranscript(payload.transcript_path, cwd);
  } catch (error) {
    process.stderr.write(`cledger: mistral-vibe hook error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
