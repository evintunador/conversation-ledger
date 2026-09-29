/** Continue CLI 1.5.47 session snapshots. Native source: continuedev/continue,
 * extensions/cli/src/session.ts and core/index.d.ts. Native rows have neither
 * durable IDs nor timestamps; ledger ordering is first observation, while each
 * snapshot records native row order explicitly. No historical time is invented.
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, findRepo, gitUserIdentity, sha256Hex, type GitUserIdentity } from "annals";
import { appendEvents, readEvents } from "../store.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, unrecognizedDraft, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, sessionStateDraft, type RecordContext } from "./records.js";

import { runWatchedCli } from "./watched-run.js";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const FORMAT = "continue-session-json/1";
const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";
const home = () => process.env.CONTINUE_GLOBAL_DIR || join(homedir(), ".continue");
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const canonical = (path: string) => realpath(path).catch(() => resolve(path));

function parts(value: unknown): unknown[] | null {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return null;
  const blocks: unknown[] = [];
  for (const part of value) {
    if (!object(part)) return null;
    if (part.type === "text" && typeof part.text === "string") blocks.push(part);
    else if (part.type === "imageUrl" && object(part.imageUrl) && typeof part.imageUrl.url === "string") {
      blocks.push({ type: "image", source: part.imageUrl });
    } else return null;
  }
  return blocks;
}

function convert(row: unknown, key: string, ctx: RecordContext, standaloneToolIds = new Set<string>()): EventDraft[] {
  const separateIds = object(row) && Array.isArray(row.toolCallStates)
    ? row.toolCallStates.filter(state => object(state) && typeof state.toolCallId === "string" && standaloneToolIds.has(state.toolCallId)).map(state => state.toolCallId as string) : [];
  const facts = { source_record_key: key, time_basis: "not_recorded", ...(separateIds.length ? { separate_tool_result_ids: separateIds } : {}) };
  const unknown = () => {
    const draft = unrecognizedDraft({ ...ctx, typeKey: object(row) && object(row.message) ? `message/${row.message.role}` : "history/(malformed)", line: row });
    draft.content = { ...draft.content as object, ...facts };
    return [draft];
  };
  if (!object(row) || !object(row.message)) return unknown();
  const message = row.message, role = message.role;
  const blocks = parts(message.content);
  if (!blocks || !["user", "assistant", "system", "tool", "thinking"].includes(String(role))) return unknown();
  const sealed: { path: string; encrypted_content: string }[] = [];
  const preserve = (value: string, path: string) => {
    sealed.push({ path, encrypted_content: value });
    return { preserved_as: "reasoning", sha256: sha256Hex(value) };
  };
  const visibleMessage = { ...message };
  if (typeof message.redactedThinking === "string") visibleMessage.redactedThinking = preserve(message.redactedThinking, "redactedThinking");
  if (Array.isArray(message.reasoning_details)) visibleMessage.reasoning_details = message.reasoning_details.map((detail, index) =>
    object(detail) && typeof detail.encrypted_content === "string"
      ? { ...detail, encrypted_content: preserve(detail.encrypted_content, `reasoning_details/${index}/encrypted_content`) } : detail);
  if (object(message.metadata) && typeof message.metadata.encrypted_content === "string") visibleMessage.metadata = {
    ...message.metadata, encrypted_content: preserve(message.metadata.encrypted_content, "metadata/encrypted_content"),
  };
  const raw = { ...row, message: visibleMessage };
  if (role === "tool") {
    if (typeof message.toolCallId !== "string") return unknown();
    blocks.splice(0, blocks.length, { type: "tool_result", tool_use_id: message.toolCallId, content: message.content });
  } else if (role === "thinking") {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as Obj;
      if (block.type === "text") blocks[i] = { type: "thinking", text: block.text };
    }
  }
  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls)) return unknown();
    for (const call of message.toolCalls) {
      if (!object(call) || !object(call.function) || typeof call.function.name !== "string") return unknown();
      let input = call.function.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* Preserve partial native arguments. */ } }
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
  }
  const actor = role === "user" ? "human" : role === "assistant" || role === "thinking" ? "agent" : "system";
  const { content: _content, redactedThinking: _encrypted, toolCalls: _calls, ...metadata } = visibleMessage;
  const output = [recordDraft(ctx, "conversation_turn", actor, { ...facts, ...metadata, blocks }, raw)];
  const { message: _message, toolCallStates, conversationSummary, reasoning, ...context } = row;
  if (Object.keys(context).length) {
    output.push(recordDraft(ctx, "context_injection", "system", { ...facts, context_type: "history_context", ...context }, context));
  }
  if (toolCallStates !== undefined) {
    output.push(sessionStateDraft(ctx, "tool_call_states", { ...facts, toolCallStates }, { toolCallStates }));
    if (Array.isArray(toolCallStates)) {
      const results = toolCallStates.filter(state => object(state) && typeof state.toolCallId === "string" &&
        !standaloneToolIds.has(state.toolCallId) && ["done", "errored", "canceled"].includes(String(state.status)) && state.output !== undefined)
        .map(state => ({ type: "tool_result", tool_use_id: state.toolCallId, content: state.output, is_error: state.status !== "done", status: state.status }));
      if (results.length) output.push(recordDraft(ctx, "conversation_turn", "system", { ...facts, role: "tool", native_part: "tool_call_state_results", blocks: results }, { toolCallStates }));
    }
  }
  if (typeof conversationSummary === "string") output.push(recordDraft(ctx, "compaction_summary", "system",
    { ...facts, blocks: [{ type: "text", text: conversationSummary }] }, { conversationSummary }));
  if (object(reasoning) && typeof reasoning.text === "string") output.push(recordDraft(ctx, "conversation_turn", "agent",
    { ...facts, role: "thinking", blocks: [{ type: "thinking", text: reasoning.text }], active: reasoning.active, startAt: reasoning.startAt, endAt: reasoning.endAt }, { reasoning }));
  for (const item of sealed) output.push(recordDraft({ ...ctx, rawFormat: "continue-encrypted-reasoning/1" }, "reasoning", "agent",
    { ...facts, opaque: true, native_path: item.path, sha256: sha256Hex(item.encrypted_content) }, { encrypted_content: item.encrypted_content }));
  return output;
}

export async function captureContinueTranscript(path: string, cwd: string): Promise<CaptureResult> {
  const result = empty(), repo = await findRepo(cwd);
  if (!repo) return result;
  let session: unknown;
  try { session = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    if (error instanceof SyntaxError) throw new Error("Continue session is malformed or being rewritten; retry capture after the native write completes");
    throw error;
  }
  if (!object(session) || typeof session.sessionId !== "string" || typeof session.workspaceDirectory !== "string" || !Array.isArray(session.history)) {
    throw new Error("Continue session schema changed: expected sessionId, workspaceDirectory and history");
  }
  if (await canonical(session.workspaceDirectory) !== await canonical(cwd)) return result;
  const id = session.sessionId, stream = `continue:${id}`;
  // A heartbeat lock expires after a killed capture worker, without relying on
  // PID reuse or unsafe competing stale-directory cleanup. Never vary these
  // stale/update values between capture entrypoints for the same session.
  const release = await lockfile.lock(join(repo.commonDir, `cledger-continue-sequence-${sha256Hex(id)}`), {
    realpath: false, stale: 10_000, update: 1_000,
    retries: { retries: 40, factor: 1, minTimeout: 500, maxTimeout: 500 },
  });
  try {
    const existing = (await readEvents(repo, { reachableFrom: null })).filter(e => e.stream?.id === stream);
    const positions = new Map<string, number>();
    let next = 0;
    for (const event of existing) {
      const key = object(event.content) ? event.content.source_record_key : undefined;
      if (typeof key === "string") positions.set(key, event.stream!.seq);
      next = Math.max(next, event.stream!.seq + 1);
    }
    const identity = await gitUserIdentity(repo);
    const ctx = (seq: number): RecordContext => ({ source: "continue", sessionId: id, conversationId: stream, seq,
      occurredAt: UNKNOWN_TIME, version: packageVersion(), rawFormat: FORMAT, identity });
    const drafts: EventDraft[] = [], ordered: string[] = [], occurrences = new Map<string, number>();
    const standaloneToolIds = new Set(session.history.filter(row => object(row) && object(row.message) && row.message.role === "tool" && typeof row.message.toolCallId === "string").map(row => (row as { message: { toolCallId: string } }).message.toolCallId));
    for (const row of session.history) {
      const hash = sha256Hex(canonicalJson(row)), occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      const key = `${hash}:${occurrence}`;
      let seq = positions.get(key);
      if (seq === undefined) { seq = next++; positions.set(key, seq); }
      ordered.push(key);
      const converted = convert(row, key, ctx(seq), standaloneToolIds);
      for (const draft of converted) {
        if (draft.kind === "unrecognized") countUnrecognized(result.unrecognized, "history/(unrecognized)");
        drafts.push(draft);
      }
    }
    const { history: _history, ...metadata } = session;
    const snapshot = { ...metadata, source_order: ordered, time_basis: "not_recorded" };
    const key = `snapshot:${sha256Hex(canonicalJson(snapshot))}`;
    drafts.push(sessionStateDraft(ctx(positions.get(key) ?? next), "session_snapshot", { ...snapshot, source_record_key: key }, metadata));
    const appended = await appendEvents(repo, drafts);
    result.appended = appended.appended.length; result.deduped = appended.deduped;
    warnUnrecognized("continue", result.unrecognized);
    return result;
  } finally { await release(); }
}

export async function captureContinueAll(cwd: string): Promise<CaptureResult> {
  const result = empty(), directory = join(home(), "sessions");
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".json") || name === "sessions.json") continue;
    const path = join(directory, name);
    if ((await stat(path)).isFile()) mergeCaptureResult(result, await captureContinueTranscript(path, cwd));
  }
  return result;
}
export async function runContinueHook(input: string): Promise<void> {
  try {
    const payload: unknown = JSON.parse(input);
    if (!object(payload) || typeof payload.cwd !== "string" || typeof payload.session_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(payload.session_id)) return;
    // Continue intentionally sends transcript_path:""; derive its documented store.
    await captureContinueTranscript(join(home(), "sessions", payload.session_id + ".json"), payload.cwd);
  } catch (error) { process.stderr.write(`cledger: continue hook error: ${error instanceof Error ? error.message : String(error)}\n`); }
}
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  if (!event.raw || !event.stream || !object(event.content) || typeof event.content.source_record_key !== "string") return null;
  const drafts = convert(event.raw.data, event.content.source_record_key, { source: "continue", sessionId: event.producer.session_id ?? "", conversationId: event.stream.id,
    seq: event.stream.seq, occurredAt: event.occurred_at, version: packageVersion(), rawFormat: FORMAT, identity }, new Set(Array.isArray(event.content.separate_tool_result_ids) ? event.content.separate_tool_result_ids.filter((id): id is string => typeof id === "string") : []));
  return drafts.some(d => d.kind === "unrecognized") ? null : drafts;
}


export async function runContinue(args: string[], binary = "cn"): Promise<number> {
  if (!(await findRepo(process.cwd()))) throw new Error("Continue capture requires a Git repository");
  return runWatchedCli(binary, args, "continue");
}
