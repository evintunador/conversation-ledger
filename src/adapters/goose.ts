/** Goose v1.52.0 (302b608) native JSON export; no direct SQLite dependency.
 * https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose-provider-types/src/conversation/message.rs
 * https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/session/session_manager.rs
 * https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose-cli/src/commands/session.rs
 * Full exports include agent-only messages; markdown exports deliberately do
 * not. Native JSON deserialization can migrate old records; this adapter
 * preserves the exported representation, not historical SQLite bytes.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, findRepo, gitUserIdentity, sha256Hex, type GitUserIdentity, type RepoInfo } from "annals";
import { appendEvents, readEvents } from "../store.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, unrecognizedDraft, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, sessionStateDraft, type RecordContext } from "./records.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const FORMAT = "goose-session-export-json/1";
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
async function canonical(path: string): Promise<string> { return realpath(path).catch(() => resolve(path)); }

/** Native CLI arguments are passed as argv; no shell or SQL interpolation. */
async function native(args: string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("goose", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", bytes = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("goose session export timed out")); }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("goose session export exceeds 64 MiB")); }
      else output += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`goose session command failed (exit ${code})`)); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error("goose session command returned invalid JSON")); }
    });
  });
}
const exported = (id: string, cwd: string) => native(["session", "export", "--session-id", id, "--format", "json"], cwd);
async function listed(cwd: string): Promise<Obj[]> {
  const value = await native(["session", "list", "--format", "json"], cwd);
  if (!Array.isArray(value) || !value.every(object)) throw new Error("goose session list format changed");
  return value;
}
function context(session: string, time: string, seq: number, parent?: string): RecordContext {
  return { source: "goose", sessionId: session, occurredAt: time, seq, version: packageVersion(), rawFormat: FORMAT,
    conversationId: `goose:${session}`, ...(parent ? { parentConversationId: `goose:${parent}` } : {}) };
}
function safeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeConfig);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^(?:api_key|apiKey|access_token|refresh_token|token|secret|password|authorization|headers|env|envs)$/i.test(key)
      ? { omitted: "configuration_credentials" } : safeConfig(child)]));
}
function seal(blocks: unknown[]): { visible: unknown[]; encrypted: unknown[] } {
  const encrypted: unknown[] = [];
  const visible = blocks.map((block) => {
    if (object(block) && block.type === "redactedThinking" && typeof block.data === "string") {
      encrypted.push(block.data);
      return { ...block, data: { preserved_as: "reasoning" } };
    }
    return block;
  });
  return { visible, encrypted };
}
function encryptedDraft(message: Obj, encrypted: unknown[], ctx: RecordContext): EventDraft {
  return recordDraft(ctx, "reasoning", "agent", { opaque: true, encrypted_sha256: sha256Hex(canonicalJson(encrypted)) },
    { encrypted_content: encrypted, message_id: message.id ?? null });
}
function validBlock(block: unknown): block is Obj {
  if (!object(block)) return false;
  switch (block.type) {
    case "text": return typeof block.text === "string";
    case "image": case "document": return typeof block.mimeType === "string" && (typeof block.data === "string" || object(block.data));
    case "thinking": return typeof block.thinking === "string" && typeof block.signature === "string";
    case "redactedThinking": return typeof block.data === "string" || object(block.data);
    case "toolRequest": return typeof block.id === "string" && object(block.toolCall) &&
      (block.toolCall.status === "error" && typeof block.toolCall.error === "string" || block.toolCall.status === "success" &&
        object(block.toolCall.value) && typeof block.toolCall.value.name === "string");
    case "toolResponse": return typeof block.id === "string" && object(block.toolResult) &&
      (block.toolResult.status === "error" && typeof block.toolResult.error === "string" || block.toolResult.status === "success" &&
        (object(block.toolResult.value) || Array.isArray(block.toolResult.value)));
    case "toolConfirmationRequest": return typeof block.id === "string" && typeof block.toolName === "string" && object(block.arguments);
    case "actionRequired": return object(block.data) && ["toolConfirmation", "elicitation", "elicitationResponse", "toolConfirmationResponse"].includes(String(block.data.actionType));
    case "systemNotification": return typeof block.msg === "string" && ["thinkingMessage", "progressMessage", "inlineMessage", "creditsExhausted"].includes(String(block.notificationType));
    case "error": return typeof block.message === "string" && typeof block.kind === "string";
    default: return false;
  }
}
function convert(message: unknown, ctx: RecordContext, identity: GitUserIdentity, sessionType: unknown): EventDraft[] | null {
  if (!object(message) || !["user", "assistant"].includes(String(message.role)) || !Array.isArray(message.content) || !message.content.every(validBlock)) return null;
  const { visible, encrypted } = seal(message.content);
  const blocks = visible.map((block) => {
    const part = block as Obj;
    if (part.type === "toolRequest") {
      const call = part.toolCall as Obj;
      const value = object(call.value) ? call.value : {};
      return { ...part, type: "tool_use", id: part.id, ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(value.arguments !== undefined ? { input: value.arguments } : {}), ...(call.status === "error" ? { error: call.error } : {}) };
    }
    if (part.type === "toolResponse") {
      const result = part.toolResult as Obj;
      const content = object(result.value) ? result.value.content ?? result.value : result.value;
      return { ...part, type: "tool_result", tool_use_id: part.id, content: result.status === "error" ? result.error : content,
        ...(result.status === "error" || object(result.value) && result.value.isError === true ? { is_error: true } : {}) };
    }
    if (part.type === "thinking") return { ...part, text: part.thinking };
    return part;
  });
  const metadata = object(message.metadata) ? message.metadata : {};
  const toolResult = message.content.some((block) => block.type === "toolResponse");
  const control = message.content.some((block) => ["systemNotification", "error", "actionRequired", "toolConfirmationRequest"].includes(String(block.type)));
  const injected = metadata.turnContext === true || message.role === "user" && metadata.userVisible === false;
  const kind = injected ? "context_injection" : control ? "activity" : "conversation_turn";
  const actor = toolResult || control || injected ? "system" : message.role === "assistant" ? "agent"
    : ["sub_agent", "scheduled", "hidden"].includes(String(sessionType)) ? "system"
      : ["user", "terminal"].includes(String(sessionType)) ? "human" : "unknown";
  const inference = object(metadata.inference) ? metadata.inference : {};
  const agent = { ...(typeof inference.provider === "string" ? { provider: inference.provider } : {}),
    ...(typeof inference.resolvedModel === "string" ? { model: inference.resolvedModel } : {}) };
  const { content: _content, ...fields } = message;
  const normalized = recordDraft({ ...ctx, identity, agent }, kind, actor, { ...fields, blocks,
    ...(kind === "activity" ? { activity_type: "native_control_message" } : {}),
    ...(kind === "context_injection" ? { injection_type: "native_context" } : {}) }, { ...message, content: visible });
  normalized.meta = { goose_session_type: sessionType ?? null };
  const drafts = [normalized];
  if (encrypted.length) drafts.push(encryptedDraft(message, encrypted, { ...ctx, agent }));
  return drafts;
}
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  if (!event.raw || !event.stream) return null;
  return convert(event.raw.data, context(event.producer.session_id ?? "", event.occurred_at, event.stream.seq,
    event.stream.parent?.replace(/^goose:/, "")), identity, event.meta?.["goose_session_type"]);
}
export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null {
  return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null;
}

/** No cursor is required: recover stable native-ID positions from durable
 * events on every capture. A rewind cannot renumber surviving messages. */
async function captureExport(value: unknown, cwd: string): Promise<CaptureResult> {
  if (!object(value) || typeof value.id !== "string" || !iso(value.created_at) || !Array.isArray(value.conversation)) throw new Error("goose session export shape changed");
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const lock = join(repo.commonDir, "conversation-ledger", "cursors", `goose-${sha256Hex(value.id)}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await mkdir(lock); await writeFile(join(lock, "owner"), String(process.pid)); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 120_000) {
          const pid = Number(await readFile(join(lock, "owner"), "utf8").catch(() => ""));
          let alive = false;
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); alive = true; } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== "ESRCH"; }
          }
          if (!alive) await rm(lock, { recursive: true, force: true });
        }
      } catch { /* Owner may have just released it. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new Error("goose capture is busy; retry after the active capture finishes");
  try { return await captureUnlocked(value as Obj & { id: string; created_at: string; conversation: unknown[] }, repo); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
async function captureUnlocked(session: Obj & { id: string; created_at: string; conversation: unknown[] }, repo: RepoInfo): Promise<CaptureResult> {
  const result = empty();
  const identity = await gitUserIdentity(repo);
  const parent = typeof session.parent_session_id === "string" ? session.parent_session_id : undefined;
  const previous = (await readEvents(repo, { source: "goose" })).filter((event) => event.producer.session_id === session.id);
  const positions = new Map<string, number>();
  let next = 1;
  for (const event of previous) if (event.stream && event.stream.seq > 0) {
    next = Math.max(next, event.stream.seq + 1);
    if (typeof event.meta?.["goose_position_key"] === "string") positions.set(event.meta["goose_position_key"], event.stream.seq);
  }
  const { conversation, ...metadata } = session;
  const order = conversation.map((message) => object(message) && typeof message.id === "string" ? message.id : sha256Hex(canonicalJson(message)));
  const safeMeta = safeConfig(metadata);
  const drafts: EventDraft[] = [sessionStateDraft(context(session.id, session.created_at, 0, parent), "session",
    { ...(safeMeta as Obj), message_order: order }, safeMeta)];
  const occurrences = new Map<string, number>();
  for (const message of conversation) {
    const key = object(message) && typeof message.id === "string" ? `id:${message.id}` : `legacy:${sha256Hex(canonicalJson(message))}`;
    const count = occurrences.get(key) ?? 0;
    occurrences.set(key, count + 1);
    const positionKey = sha256Hex(`${key}:${count}`);
    const seq = positions.get(positionKey) ?? next++;
    positions.set(positionKey, seq);
    const created = object(message) && typeof message.created === "number" ? new Date(message.created * 1000) : null;
    const time = created && Number.isFinite(created.getTime()) ? created.toISOString() : session.created_at;
    const ctx = context(session.id, time, seq, parent);
    const converted = convert(message, ctx, identity, session.session_type);
    if (converted) {
      for (const draft of converted) draft.meta = { ...draft.meta, goose_position_key: positionKey };
      drafts.push(...converted);
    } else {
      const typeKey = object(message) && Array.isArray(message.content)
        ? message.content.map((block) => object(block) ? String(block.type) : "invalid").join("+") : "invalid-message";
      countUnrecognized(result.unrecognized, typeKey);
      // Even when a sibling block drifts, recognize the explicit native
      // encrypted block so ordinary redaction never rewrites its ciphertext.
      const split = object(message) && Array.isArray(message.content) ? seal(message.content) : undefined;
      const rawMessage = split ? { ...(message as Obj), content: split.visible } : message;
      const preserved = unrecognizedDraft({ source: "goose", sessionId: session.id, occurredAt: time, seq, version: packageVersion(),
        rawFormat: FORMAT, typeKey, line: rawMessage, conversationId: `goose:${session.id}`,
        ...(parent ? { parentConversationId: `goose:${parent}` } : {}) });
      preserved.meta = { goose_position_key: positionKey, goose_session_type: session.session_type ?? null };
      drafts.push(preserved);
      if (split?.encrypted.length && object(message)) drafts.push(encryptedDraft(message, split.encrypted, ctx));
    }
  }
  const appended = await appendEvents(repo, drafts);
  result.appended = appended.appended.length; result.deduped = appended.deduped;
  warnUnrecognized("goose", result.unrecognized);
  return result;
}

export async function captureGooseTranscript(path: string, cwd: string): Promise<CaptureResult> {
  return captureExport(JSON.parse(await readFile(path, "utf8")), cwd);
}
export async function captureGooseSession(id: string, cwd: string): Promise<CaptureResult> {
  return captureTree(id, cwd, await listed(cwd), new Set());
}
async function captureTree(id: string, cwd: string, sessions: Obj[], visited: Set<string>, initial?: Obj): Promise<CaptureResult> {
  const result = empty();
  const queue: { id: string; parent?: string }[] = [{ id }];
  while (queue.length) {
    const item = queue.shift()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    const value = item.id === id && initial ? initial : await exported(item.id, cwd);
    if (!object(value) || value.id !== item.id) throw new Error("goose exported a different session");
    if (item.parent && value.parent_session_id !== item.parent) continue;
    mergeCaptureResult(result, await captureExport(value, cwd));
    for (const child of sessions) if (child.parent_session_id === item.id && typeof child.id === "string" && !visited.has(child.id)) {
      queue.push({ id: child.id, parent: item.id });
    }
  }
  return result;
}
export async function captureGooseAll(cwd: string): Promise<CaptureResult> {
  const target = await canonical(cwd);
  const result = empty();
  const sessions = await listed(cwd);
  const visited = new Set<string>();
  for (const session of sessions) if (typeof session.id === "string" && typeof session.working_dir === "string" && await canonical(session.working_dir) === target) {
    mergeCaptureResult(result, await captureTree(session.id, cwd, sessions, visited));
  }
  return result;
}
export async function runGooseHook(stdinJson: string): Promise<void> {
  try {
    const payload: unknown = JSON.parse(stdinJson);
    if (!object(payload) || typeof payload.session_id !== "string") return;
    const value = await exported(payload.session_id, typeof payload.working_dir === "string" ? payload.working_dir : process.cwd());
    if (!object(value) || value.id !== payload.session_id || typeof value.working_dir !== "string" || !(await findRepo(value.working_dir))) return;
    await captureTree(payload.session_id, value.working_dir, await listed(value.working_dir), new Set(), value);
  } catch (error) { process.stderr.write(`cledger: goose hook error: ${error instanceof Error ? error.message : String(error)}\n`); }
}
