import { scheduleTailCapture, runTailCapture } from "./tail.js";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, activityDraft, contextInjectionDraft, sessionStateDraft, type RecordContext } from "./records.js";

// Factory Droid 0.229.0 persisted JSONL v2 (not exec stream-json or SDK RPC).
// Checked native synthetic transcripts, official @factory/droid-sdk schemas,
// and shipped CLI SessionService/WR/Q1 serialization, 2026-09-29.
const FORMAT = "droid-session-jsonl/1";
const EPOCH = "1970-01-01T00:00:00.000Z";
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v) ?? "undefined").digest("hex");
function timestamp(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return EPOCH;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? EPOCH : date.toISOString();
}
function unknown(raw: unknown, key: string, ctx: RecordContext): EventDraft {
  return recordDraft(ctx, "unrecognized", "system", { unrecognized_type: key, raw_sha256: hash(raw) }, raw);
}
function blocks(value: unknown, drift: Record<string, number>): unknown[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) { countUnrecognized(drift, "message/content"); return [{ type: "unrecognized", data: value ?? null }]; }
  return value.map(part => {
    if (!object(part)) { countUnrecognized(drift, "block/(non-object)"); return part; }
    switch (part.type) {
      case "text":
        if (typeof part.text !== "string") countUnrecognized(drift, "block/text/malformed");
        return part;
      case "thinking": {
        const { thinking, signature: _signature, ...rest } = part;
        if (typeof thinking !== "string") countUnrecognized(drift, "block/thinking/malformed");
        return { ...rest, text: thinking };
      }
      case "redacted_thinking": return { type: "redacted_thinking", opaque: true };
      case "tool_use":
        if (typeof part.id !== "string" || typeof part.name !== "string" || !object(part.input)) countUnrecognized(drift, "block/tool_use/malformed");
        return part;
      case "tool_result":
        if (typeof part.tool_use_id !== "string") countUnrecognized(drift, "block/tool_result/malformed");
        return { ...part, ...(part.content !== undefined ? { content: blocks(part.content, drift) } : {}) };
      case "image":
      case "document":
        if (!object(part.source)) countUnrecognized(drift, `block/${part.type}/malformed`);
        return part;
      default: countUnrecognized(drift, `block/${String(part.type)}`); return part;
    }
  });
}
/** Provider-sealed values are exempt from redaction only in their sibling. */
function separate(entry: Obj): { visible: Obj; signatures: Obj[] } {
  if (entry.type !== "message" || !object(entry.message)) return { visible: entry, signatures: [] };
  const m = entry.message, signatures: Obj[] = [];
  const message = { ...m };
  if (typeof m.openaiEncryptedContent === "string") {
    signatures.push({ path: ["message", "openaiEncryptedContent"], native_field: "openaiEncryptedContent", encrypted_content: m.openaiEncryptedContent });
    message.openaiEncryptedContent = { type: "reasoning_reference", index: 0 };
  }
  if (Array.isArray(m.content)) message.content = m.content.map((part, index) => {
    if (!object(part) || part.type !== "redacted_thinking" || typeof part.data !== "string") return part;
    signatures.push({ path: ["message", "content", index, "data"], native_field: "redacted_thinking.data", encrypted_content: part.data });
    return { ...part, data: { type: "reasoning_reference", index: signatures.length - 1 } };
  });
  return { visible: { ...entry, message }, signatures };
}
function convert(entry: Obj, ctx: RecordContext, drift: Record<string, number>, delegated = false): EventDraft | null {
  const { type, message: _message, ...fields } = entry;
  switch (type) {
    case "session_start": case "todo_state": case "session_settings":
      return sessionStateDraft(ctx, String(type), fields, entry);
    case "agent_turn_outcome":
      return activityDraft(ctx, String(type), fields, entry);
    case "compaction_state":
      return contextInjectionDraft(ctx, String(type), { ...fields, blocks: blocks(entry.summaryText, drift) }, entry);
    case "message": break;
    default: return null;
  }
  if (!object(entry.message)) return null;
  const m = entry.message, { content, ...metadata } = m;
  const normalized = blocks(content, drift), details = { ...fields, ...metadata, blocks: normalized };
  if (typeof m.hookEventName === "string") return activityDraft(ctx, "hook", details, entry);
  if (m.visibility === "llm_only" || m.visibility === "user_only" || m.role === "system") {
    return contextInjectionDraft(ctx, m.visibility === "user_only" ? "user_notice" : "system_context", details, entry);
  }
  if (m.role === "assistant") {
    const draft = recordDraft(ctx, "conversation_turn", "agent", details, entry);
    if (typeof m.modelId === "string" && draft.actor) draft.actor.id = m.modelId;
    return draft;
  }
  if (m.role === "user" || m.role === "tool") {
    if (m.role === "tool" || normalized.some(part => object(part) && part.type === "tool_result")) {
      return recordDraft(ctx, "conversation_turn", "system", { ...details, role: "tool_result" }, entry);
    }
    if (delegated || ["automation", "readiness-remediation", "readiness-evaluation", "wiki-generation", "wiki-ci-setup"].includes(String(m.userMessageSource))) {
      return contextInjectionDraft(ctx, delegated ? "delegated_prompt" : "automation", details, entry);
    }
    return recordDraft(ctx, "conversation_turn", "human", details, entry);
  }
  return null;
}
function draftsFor(entry: Obj, ctx: RecordContext, drift: Record<string, number>, delegated = false): EventDraft[] | null {
  const { visible, signatures } = separate(entry), nested: Record<string,number> = {};
  const draft = convert(visible, ctx, nested, delegated);
  for (const [key,count] of Object.entries(nested)) drift[key] = (drift[key] ?? 0) + count;
  if (!draft) return null;
  const drafts = [draft];
  if (Object.keys(nested).length) {
    const preserved = unknown(visible, "nested/message", ctx);
    preserved.content = { ...preserved.content as object, unrecognized_types: nested };
    drafts.push(preserved);
  }
  if (signatures.length) drafts.push(recordDraft({ ...ctx, rawFormat: "droid-encrypted-reasoning/1" }, "reasoning", "agent",
    { opaque: true, native_message_id: entry.id, parentId: entry.parentId, sealed_parts: signatures.map(item => ({ path: item.path, sha256: hash(item.encrypted_content) })) }, { native_format: FORMAT, signatures }));
  return drafts;
}

/** Full rescans capture native in-place revisions, forks and mutable headers. */
export async function captureDroidTranscript(path: string, cwd: string, expectedCwd?: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd); if (!repo) throw new Error("not inside a git repository");
  let data: string;
  try { data = await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw e; }
  const lines = data.split("\n"), records: { value: unknown; seq: number }[] = [];
  for (const [seq, line] of lines.entries()) {
    if (!line.trim()) continue;
    try { records.push({ value: JSON.parse(line), seq }); }
    catch { if (seq === lines.length - 1 && !data.endsWith("\n")) break; records.push({ value: line, seq }); }
  }
  if (!records.length) return empty();
  const header = records[0]!.value;
  if (!object(header) || header.type !== "session_start") throw new Error("Droid transcript must start with native session_start header");
  const id = typeof header.id === "string" ? header.id : typeof header.sessionId === "string" ? header.sessionId : basename(path, ".jsonl");
  if (!id) throw new Error("Droid transcript requires native session id");
  if (expectedCwd !== undefined && (typeof header.cwd !== "string" || !isAbsolute(header.cwd) || await canonicalCwd(header.cwd) !== await canonicalCwd(expectedCwd))) return empty();
  const identity = await gitUserIdentity(repo), version = packageVersion(), result = empty(), drafts: EventDraft[] = [];
  const parent = typeof header.callingSessionId === "string" ? header.callingSessionId : typeof header.parent === "string" ? header.parent : undefined;
  const base: RecordContext = { occurredAt: EPOCH, source: "droid", sessionId: id, conversationId: `droid:${id}`, version, seq: 0, rawFormat: FORMAT, identity,
    ...(parent ? { parentConversationId: `droid:${parent}` } : {}) };
  const contexts = new Map<string, ProducerAgentContext>();
  for (const { value, seq } of records) {
    const entry = object(value) ? value : undefined;
    const agent: ProducerAgentContext = { ...(typeof entry?.parentId === "string" ? contexts.get(entry.parentId) : {}) };
    if (entry && object(entry.message) && entry.message.role === "assistant") {
      if (typeof entry.message.modelId === "string") agent.model = entry.message.modelId;
      if (typeof entry.message.apiProvider === "string") agent.provider = entry.message.apiProvider;
    }
    if (typeof entry?.id === "string") contexts.set(entry.id, agent);
    const ctx = { ...base, seq, occurredAt: timestamp(entry?.timestamp), agent };
    const converted = entry ? draftsFor(entry, ctx, result.unrecognized, typeof header.callingSessionId === "string") : null;
    if (converted) drafts.push(...converted);
    else {
      const key = entry?.type === "message" && object(entry.message) ? `message/${String(entry.message.role)}` : String(entry?.type ?? "(malformed-record)");
      countUnrecognized(result.unrecognized, key); drafts.push(unknown(value, key, ctx));
    }
  }
  // Session-local settings carry usage, model/autonomy, custom prompt, tags,
  // mission/child metadata and archive state. Never read global credentials.
  const settingsPath = join(dirname(path), basename(path, ".jsonl") + ".settings.json");
  try {
    if ((await lstat(settingsPath)).isFile()) {
      const raw: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
      const ctx = { ...base, conversationId: `droid:${id}:settings`, rawFormat: "droid-session-settings/1" };
      if (object(raw)) drafts.push(sessionStateDraft(ctx, "session_settings", raw, raw));
      else { countUnrecognized(result.unrecognized, "session_settings/(malformed)"); drafts.push(unknown(raw, "session_settings/(malformed)", ctx)); }
    }
  } catch (e) { if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; /* A torn settings rewrite is retried. */ }
  const appended = await appendEvents(repo, drafts); result.appended = appended.appended.length; result.deduped = appended.deduped;
  warnUnrecognized("droid", result.unrecognized); return result;
}
async function canonicalCwd(cwd: string): Promise<string> { try { return await realpath(cwd); } catch { return resolve(cwd); } }
export async function droidProjectKey(cwd: string): Promise<string> {
  const normalized = (await canonicalCwd(cwd)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? `-${normalized.replace(/^([A-Z]):/i, "$1").replace(/[\\/]+/g, "-")}` : `-${normalized.replace(/^\/+/, "").replace(/\/+/g, "-")}`;
}
function factoryHome(): string { return join(process.env.FACTORY_HOME_OVERRIDE || homedir(), ".factory"); }
async function firstHeader(path: string): Promise<Obj | undefined> {
  const file = await open(path, "r");
  try { const buffer = Buffer.alloc(64 * 1024), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "");
    return object(value) && value.type === "session_start" ? value : undefined;
  } catch (e) { if (e instanceof SyntaxError) return; throw e; } finally { await file.close(); }
}
export async function captureDroidAll(cwd: string, limit?: number, sessionsDir = join(factoryHome(), "sessions")): Promise<CaptureResult> {
  if (!(await findRepo(cwd))) throw new Error("not inside a git repository");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("Droid capture limit must be a non-negative integer");
  const result = empty(); if (limit === 0) return result;
  const target = await canonicalCwd(cwd), candidates: { path: string; modified: number }[] = [];
  // Native current bucket, legacy flat storage and side-question storage only.
  // Header cwd validation prevents sanitized-path collisions and cross-project reads.
  for (const directory of [sessionsDir, join(sessionsDir, await droidProjectKey(target)), join(sessionsDir, "btw")]) {
    let entries;
    try { if (!(await lstat(directory)).isDirectory()) continue; entries = await readdir(directory, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const path = join(directory, entry.name), header = await firstHeader(path);
      if (typeof header?.cwd !== "string" || !isAbsolute(header.cwd) || await canonicalCwd(header.cwd) !== target) continue;
      candidates.push({ path, modified: (await lstat(path)).mtimeMs });
    }
  }
  candidates.sort((a,b) => b.modified - a.modified || a.path.localeCompare(b.path));
  for (const candidate of candidates.slice(0, limit)) mergeCaptureResult(result, await captureDroidTranscript(candidate.path, target, target));
  return result;
}
export async function runDroidHook(stdinJson: string): Promise<void> {
  try {
    const p: unknown = JSON.parse(stdinJson);
    if (!object(p) || typeof p.transcript_path !== "string" || typeof p.cwd !== "string" || !(await findRepo(p.cwd))) return;
    await captureDroidTranscript(p.transcript_path, p.cwd, p.cwd);
    if (p.hook_event_name === "Stop" || p.hook_event_name === "SessionEnd" || p.hook_event_name === "SubagentStop") {
      await scheduleTailCapture(p.transcript_path, p.cwd, "droid", fileURLToPath(import.meta.url));
    }
  } catch (e) { process.stderr.write(`cledger: droid hook error: ${e instanceof Error ? e.message : String(e)}\n`); }
}
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  if (!event.stream || !event.raw || !object(event.raw.data)) return null;
  const drafts = draftsFor(event.raw.data, { occurredAt: event.occurred_at, source: "droid", sessionId: event.producer.session_id ?? "", seq: event.stream.seq, version: packageVersion(), rawFormat: FORMAT,
    conversationId: event.stream.id, ...(event.stream.parent ? { parentConversationId: event.stream.parent } : {}), identity,
    agent: { ...(event.producer.model ? { model: event.producer.model } : {}), ...(event.producer.provider ? { provider: event.producer.provider } : {}) } }, {});
  return drafts?.some(draft => draft.kind === "unrecognized") ? null : drafts;
}
export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null { return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null; }

export const DROID_TAIL_DIRECTORY = "cledger-droid-tail";
async function droidFingerprint(path: string): Promise<string> {
  const stats: unknown[] = [];
  for (const candidate of [path, join(dirname(path), basename(path, ".jsonl") + ".settings.json")]) {
    try { const info = await lstat(candidate); if (info.isFile()) stats.push([candidate, info.size, info.mtimeMs]); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return JSON.stringify(stats);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--cledger-tail") {
  const [path, cwd, lock, status] = process.argv.slice(3);
  if (!path || !cwd || !lock || !status) throw new Error("Missing Droid tail worker arguments");
  await runTailCapture(lock, status, "droid", () => droidFingerprint(path), () => captureDroidTranscript(path, cwd, cwd));
}
