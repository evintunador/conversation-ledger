/** Kiro CLI 2.27 native session files, observed with headless and TUI runs. */
import { createHash } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findRepo, gitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, warnUnrecognized, type CaptureResult } from "./drift.js";
import { activityDraft, contextInjectionDraft, recordDraft, sessionStateDraft, type RecordContext } from "./records.js";
import { runWatchedCli } from "./watched-run.js";

const FORMAT = "kiro-cli-session-jsonl/1";
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sessionRoot = (): string => join(process.env.KIRO_HOME || join(homedir(), ".kiro"), "sessions", "cli");
const v3Root = (): string => join(process.env.KIRO_HOME || join(homedir(), ".kiro"), "sessions");

/** Native redactedContent is an integer byte array, not a known text format. */
function textOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(textOnly);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if ((key === "images" || key === "documents") && Array.isArray(child)) return [key, child.map(item => {
      if (!object(item)) return { type: "attachment_reference", sha256: hash(item) };
      const { path, name, uri, url, mimeType, mediaType } = item;
      return { type: "attachment_reference", ...(typeof path === "string" ? { path } : {}), ...(typeof name === "string" ? { name } : {}), ...(typeof uri === "string" ? { uri } : {}), ...(typeof url === "string" && !url.startsWith("data:") ? { url } : {}), mime_type: mimeType ?? mediaType, sha256: hash(item) };
    })];
    if (key === "redactedContent" && Array.isArray(child)) return [key, { type: "binary_reference", sha256: hash(child), bytes: child.length }];
    if (key === "reasoningSignature" && typeof child === "string") return [key, { type: "reasoning_reference", sha256: hash(child) }];
    if (typeof child === "string" && (/^data:[^,]+;base64,/i.test(child) || ((key === "base64" || key === "blob" || key === "bytes") && child.length > 64))) {
      return [key, { type: "binary_reference", sha256: hash(child), bytes: child.length }];
    }
    return [key, textOnly(child)];
  }));
}

function parts(value: unknown, drift: Record<string, number>): unknown[] {
  if (!Array.isArray(value)) { countUnrecognized(drift, "content/malformed"); return [{ type: "unrecognized", data: textOnly(value) }]; }
  return value.map(part => {
    if (!object(part) || typeof part.kind !== "string") { countUnrecognized(drift, "content/malformed-part"); return { type: "unrecognized", data: textOnly(part) }; }
    const data = part.data;
    if (part.kind === "text" && typeof data === "string") return { type: "text", text: data };
    if (part.kind === "thinking" && object(data)) {
      return { type: "thinking", text: typeof data.text === "string" ? data.text : "", ...(Array.isArray(data.redactedContent) ? { sealed_reference: { sha256: hash(data.redactedContent), bytes: data.redactedContent.length } } : {}) };
    }
    if (part.kind === "toolUse" && object(data)) return { type: "tool_use", id: data.toolUseId, name: data.name, input: textOnly(data.input) };
    if (part.kind === "toolResult" && object(data)) return { type: "tool_result", tool_use_id: data.toolUseId, is_error: data.status !== "success", content: parts(data.content, drift) };
    // Images, binary payloads and future record forms remain references. The
    // scrubbed native part also raises a drift signal so maintenance can add a
    // deliberate mapping once a live text/attachment example exists.
    countUnrecognized(drift, `content/${part.kind}`);
    return { type: "unrecognized", kind: part.kind, data: textOnly(data) };
  });
}

function time(value: unknown, fallback: string): string {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const n = Number(value);
  const d = Number.isFinite(n) ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Capture exactly one JSONL session; the adjacent metadata must scope it to cwd. */
export async function captureKiroTranscript(path: string, cwd: string, expectedCwd = cwd): Promise<CaptureResult> {
  const repo = await findRepo(cwd); if (!repo) throw new Error("not inside a git repository");
  const target = resolve(path);
  if (!target.endsWith(".jsonl")) throw new Error("Kiro transcript must be a .jsonl session file");
  const id = basename(target, ".jsonl");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Kiro transcript filename must contain a session UUID");
  const metadata: unknown = JSON.parse(await readFile(join(dirname(target), `${id}.json`), "utf8"));
  if (!object(metadata) || metadata.session_id !== id || typeof metadata.cwd !== "string" || !isAbsolute(metadata.cwd)) throw new Error("Kiro session metadata is invalid");
  if (resolve(metadata.cwd) !== resolve(expectedCwd)) return empty();
  const identity = await gitUserIdentity(repo), version = packageVersion();
  const raw = await readFile(target, "utf8"), lines = raw.split("\n");
  const result = empty(), drafts: EventDraft[] = [];
  const base = time(metadata.created_at, new Date(0).toISOString());
  let lastTime = base;
  const common: RecordContext = { source: "kiro", sessionId: id, conversationId: `kiro:${id}`, seq: 0, occurredAt: base, rawFormat: FORMAT, identity, version };
  // Only text-safe, non-transcript metadata is copied from the adjacent file.
  drafts.push(sessionStateDraft(common, "session_metadata", {
    cwd: metadata.cwd, created_at: metadata.created_at, updated_at: metadata.updated_at,
    title: metadata.title, session_created_reason: metadata.session_created_reason,
  }, { session_id: id, cwd: metadata.cwd, created_at: metadata.created_at, updated_at: metadata.updated_at, title: metadata.title }));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { if (i === lines.length - 1 && !raw.endsWith("\n")) break; entry = line; }
    const data = object(entry) && object(entry.data) ? entry.data : {};
    lastTime = time(object(data.meta) ? data.meta.timestamp : undefined, lastTime);
    const ctx = { ...common, seq: i + 1, occurredAt: lastTime };
    const native = textOnly(entry);
    if (object(entry) && entry.version === "v1" && entry.kind === "Prompt") drafts.push(recordDraft(ctx, "conversation_turn", "human", { role: "user", message_id: data.message_id, blocks: parts(data.content, result.unrecognized) }, native));
    else if (object(entry) && entry.version === "v1" && entry.kind === "AssistantMessage") drafts.push(recordDraft(ctx, "conversation_turn", "agent", { role: "assistant", message_id: data.message_id, blocks: parts(data.content, result.unrecognized) }, native));
    else if (object(entry) && entry.version === "v1" && entry.kind === "ToolResults") drafts.push(recordDraft(ctx, "conversation_turn", "system", { role: "tool_result", message_id: data.message_id, blocks: parts(data.content, result.unrecognized) }, native));
    else {
      const key = object(entry) ? String(entry.kind ?? "(missing-kind)") : "(malformed-record)";
      countUnrecognized(result.unrecognized, key);
      drafts.push(recordDraft(ctx, "unrecognized", "system", { unrecognized_type: key }, native));
    }
  }
  const appended = await appendEvents(repo, drafts); result.appended = appended.appended.length; result.deduped = appended.deduped;
  warnUnrecognized("kiro", result.unrecognized); return result;
}

/** Metadata-only scope check: never open a different project's JSONL. */
async function matchingCwd(meta: string, cwd: string): Promise<boolean> {
  const file = await open(meta, "r");
  try {
    const buffer = Buffer.alloc(8192), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const match = /"cwd"\s*:\s*("(?:\\.|[^"\\])*")/.exec(prefix);
    return !!match && resolve(JSON.parse(match[1]!) as string) === resolve(cwd);
  } finally { await file.close(); }
}

export async function captureKiroAll(cwd: string, limit?: number, root = sessionRoot()): Promise<CaptureResult> {
  if (!(await findRepo(cwd))) throw new Error("not inside a git repository");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("Kiro limit must be non-negative integer");
  const total = empty(); if (limit === 0) return total;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return total; throw error; }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
    const meta = join(root, entry.name);
    if (await matchingCwd(meta, cwd)) matches.push(join(root, entry.name.replace(/\.json$/, ".jsonl")));
  }
  for (const path of matches.sort().slice(0, limit)) mergeCaptureResult(total, await captureKiroTranscript(path, cwd, cwd));
  // V3 stores each session under a workspace-hash bucket rather than cli/.
  // An explicitly supplied root is a V2-only fixture; production scans both.
  if (root === sessionRoot()) mergeCaptureResult(total, await captureKiroV3All(cwd, limit));
  return total;
}

/** V3 session.json + messages.jsonl, observed in installed 2.27.0 V3 TUI. */
export async function captureKiroV3Transcript(path: string, cwd: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd); if (!repo) throw new Error("not inside a git repository");
  const directory = resolve(path), metadata: unknown = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
  if (!object(metadata) || typeof metadata.id !== "string" || !/^sess_[a-f0-9-]{36}$/.test(metadata.id) || !Array.isArray(metadata.workspacePaths) || !metadata.workspacePaths.some(p => typeof p === "string" && resolve(p) === resolve(cwd))) return empty();
  const id = metadata.id, version = packageVersion(), identity = await gitUserIdentity(repo), result = empty(), drafts: EventDraft[] = [];
  const base: RecordContext = { source: "kiro", sessionId: id, conversationId: `kiro:${id}`, seq: 0,
    occurredAt: time(metadata.createdAt, new Date(0).toISOString()), rawFormat: "kiro-cli-v3-messages-jsonl/1", identity, version,
    agent: { ...(typeof metadata.modelId === "string" ? { model: metadata.modelId } : {}) } };
  drafts.push(sessionStateDraft(base, "session_metadata", { id, title: metadata.title, agentMode: metadata.agentMode,
    workspacePaths: metadata.workspacePaths, createdAt: metadata.createdAt, lastModifiedAt: metadata.lastModifiedAt,
    status: metadata.status, modelId: metadata.modelId },
  { id, title: metadata.title, workspacePaths: metadata.workspacePaths, createdAt: metadata.createdAt, lastModifiedAt: metadata.lastModifiedAt }));
  const raw = await readFile(join(directory, "messages.jsonl"), "utf8"), lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { if (i === lines.length - 1 && !raw.endsWith("\n")) break; entry = line; }
    const payload = object(entry) && object(entry.payload) ? entry.payload : {};
    const ctx = { ...base, seq: i + 1, occurredAt: time(object(entry) ? entry.timestamp : undefined, base.occurredAt) };
    const native = textOnly(entry);
    const fields = textOnly(payload) as Obj;
    if (payload.type === "user") drafts.push(recordDraft(ctx, "conversation_turn", "human", {
      role: "user", id: object(entry) ? entry.id : undefined,
      blocks: [...(typeof payload.content === "string" ? [{ type: "text", text: payload.content }] : []),
        ...((fields.documents as unknown[] | undefined) ?? []), ...((fields.images as unknown[] | undefined) ?? [])],
    }, native));
    else if (payload.type === "assistant" && payload.operationType === "Reasoning") drafts.push(recordDraft(ctx, "reasoning", "agent", {
      opaque: true, operationType: payload.operationType,
      ...(typeof payload.content === "string" && payload.content !== "..." ? { blocks: [{ type: "thinking", text: payload.content }] } : {}),
      ...(typeof payload.reasoningSignature === "string" ? { signature_reference: { sha256: hash(payload.reasoningSignature) } } : {}),
    }, native));
    else if (payload.type === "assistant") drafts.push(recordDraft(ctx, "conversation_turn", "agent", {
      role: "assistant", operationType: payload.operationType, id: object(entry) ? entry.id : undefined,
      blocks: typeof payload.content === "string" ? [{ type: "text", text: payload.content }] : [],
    }, native));
    else if (payload.type === "tool_call") drafts.push(recordDraft(ctx, "conversation_turn", "agent", {
      role: "assistant", blocks: [{ type: "tool_use", id: payload.toolCallId, name: payload.toolName, input: fields.args,
        status: payload.status, kind: payload.kind }],
    }, native));
    else if (payload.type === "tool_result") drafts.push(recordDraft(ctx, "conversation_turn", "system", {
      role: "tool_result", blocks: [{ type: "tool_result", tool_use_id: payload.toolCallId, is_error: payload.success === false,
        content: typeof payload.content === "string" ? [{ type: "text", text: payload.content }] : [fields.content] }],
    }, native));
    else if (payload.type === "agent_note" || payload.type === "session_start") drafts.push(contextInjectionDraft(ctx, String(payload.type), {
      ...fields, ...(typeof payload.content === "string" ? { blocks: [{ type: "text", text: payload.content }], content: undefined } : {}),
    }, native));
    else if (payload.type === "session_metadata") drafts.push(sessionStateDraft(ctx, String(payload.type), fields, native));
    else if (["turn_start", "turn_end", "usage_summary", "session_event"].includes(String(payload.type))) drafts.push(activityDraft(ctx, String(payload.type), fields, native));
    else {
      const key = String(payload.type ?? "(malformed-record)"); countUnrecognized(result.unrecognized, key);
      drafts.push(recordDraft(ctx, "unrecognized", "system", { unrecognized_type: key }, native));
    }
  }
  const appended = await appendEvents(repo, drafts); result.appended = appended.appended.length; result.deduped = appended.deduped;
  warnUnrecognized("kiro", result.unrecognized); return result;
}

export async function captureKiroV3All(cwd: string, limit?: number, root = v3Root()): Promise<CaptureResult> {
  const total = empty();
  let buckets;
  try { buckets = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return total; throw error; }
  const matches: string[] = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || !/^[a-f0-9]{16}$/.test(bucket.name)) continue;
    const base = join(root, bucket.name);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^sess_[a-f0-9-]{36}$/.test(entry.name)) continue;
      const directory = join(base, entry.name), meta = join(directory, "session.json");
      try {
        // V3 workspacePaths is near the start of session.json. No other
        // workspace's messages.jsonl is opened.
        const file = await open(meta, "r"); let prefix = "";
        try { const buffer = Buffer.alloc(8192), { bytesRead } = await file.read(buffer, 0, buffer.length, 0); prefix = buffer.subarray(0, bytesRead).toString("utf8"); }
        finally { await file.close(); }
        const match = /"workspacePaths"\s*:\s*(\[[^\]]*\])/.exec(prefix);
        if (match && (JSON.parse(match[1]!) as unknown[]).some(p => typeof p === "string" && resolve(p) === resolve(cwd))) matches.push(directory);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  for (const path of matches.sort().slice(0, limit)) mergeCaptureResult(total, await captureKiroV3Transcript(path, cwd));
  return total;
}

/** V3 project/global hook command can call `cledger hook kiro`. */
export async function runKiroHook(stdinJson: string): Promise<void> {
  try {
    const payload: unknown = stdinJson.trim() ? JSON.parse(stdinJson) : {};
    const cwd = object(payload) && typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    if (await findRepo(cwd)) await captureKiroAll(cwd);
  } catch (error) { process.stderr.write(`cledger: kiro hook error: ${error instanceof Error ? error.message : String(error)}\n`); }
}

/** V2 has no universal hook; observe only this explicitly launched session. */
export async function runKiro(args: string[], binary = "kiro-cli"): Promise<number> {
  return runWatchedCli(binary, args, "kiro");
}
