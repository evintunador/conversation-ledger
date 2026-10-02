/** Published OpenHands CLI 1.16.0 / SDK 1.21.0 (4110929).
 * https://github.com/OpenHands/software-agent-sdk/tree/v1.21.0/openhands-sdk/openhands/sdk/event
 * https://github.com/OpenHands/software-agent-sdk/blob/v1.21.0/openhands-sdk/openhands/sdk/conversation/event_store.py
 * Native event files, not console JSON. Full rescans preserve revised events.
 */
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, findRepo, gitUserIdentity, sha256Hex, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, sessionStateDraft, type RecordContext } from "./records.js";
import { runTailCapture, scheduleTailCapture } from "./tail.js";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const EPOCH = "1970-01-01T00:00:00.000Z", FORMAT = "openhands-sdk-event-json/1";
const UUID = /^[a-f\d-]{32,36}$/i;
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const canonical = (p: string) => realpath(p).catch(() => resolve(p));
const storeRoot = () => process.env.OPENHANDS_CONVERSATIONS_DIR || join(process.env.OPENHANDS_PERSISTENCE_DIR || join(homedir(), ".openhands"), "conversations");
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : EPOCH;
function safeState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeState);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^(api_key|apiKey|access_token|refresh_token|password|authorization|headers|secret_registry|secrets|secret_sources|env|env_vars)$/i.test(key)
      ? { omitted: "configuration_credentials" } : safeState(child)]));
}
function context(id: string, seq: number, occurredAt: string, parent?: string, identity?: GitUserIdentity): RecordContext {
  return { source: "openhands", sessionId: id, conversationId: `openhands:${id}`, seq, occurredAt, version: packageVersion(), rawFormat: FORMAT,
    ...(parent ? { parentConversationId: `openhands:${parent}` } : {}), ...(identity ? { identity } : {}) };
}
function separate(raw: Obj): { visible: Obj; sealed: unknown[] } {
  const sealed: unknown[] = [];
  const message = (value: Obj): Obj => {
    const next = { ...value };
    if (Array.isArray(value.thinking_blocks)) next.thinking_blocks = value.thinking_blocks.map((block, index) => {
      if (!object(block) || block.type !== "redacted_thinking" || typeof block.data !== "string") return block;
      sealed.push({ field: "thinking_blocks", index, encrypted_content: block.data });
      return { ...block, data: { preserved_as: "reasoning", index: sealed.length - 1 } };
    });
    if (object(value.responses_reasoning_item) && typeof value.responses_reasoning_item.encrypted_content === "string") {
      sealed.push({ field: "responses_reasoning_item", encrypted_content: value.responses_reasoning_item.encrypted_content });
      next.responses_reasoning_item = { ...value.responses_reasoning_item, encrypted_content: { preserved_as: "reasoning", index: sealed.length - 1 } };
    }
    return next;
  };
  const visible = message(raw);
  if (object(raw.llm_message)) visible.llm_message = message(raw.llm_message);
  if (raw.kind === "LLMCompletionLogEvent" && object(raw.log_data)) {
    // Only the declared request/response schema paths are provider envelopes.
    // Never reinterpret arbitrary tool arguments or visible text as ciphertext.
    const providerMessage = (value: unknown): unknown => {
      if (!object(value)) return value;
      const result = message(value);
      if (value.role === "assistant" && Array.isArray(value.content)) result.content = value.content.map(part => {
        if (!object(part) || part.type !== "redacted_thinking" || typeof part.data !== "string") return part;
        sealed.push({ field: "log_data/content/redacted_thinking", encrypted_content: part.data });
        return { ...part, data: { preserved_as: "reasoning", index: sealed.length - 1 } };
      });
      return result;
    };
    const responsesItem = (value: unknown): unknown => {
      if (!object(value) || value.type !== "reasoning" || typeof value.encrypted_content !== "string") return value;
      sealed.push({ field: "log_data/responses/reasoning", encrypted_content: value.encrypted_content });
      return { ...value, encrypted_content: { preserved_as: "reasoning", index: sealed.length - 1 } };
    };
    const request = (value: Obj): Obj => {
      const result = { ...value };
      for (const field of ["messages", "raw_messages"]) if (Array.isArray(value[field])) result[field] = value[field].map(providerMessage);
      if (Array.isArray(value.input)) result.input = value.input.map(responsesItem);
      return result;
    };
    const log = request(raw.log_data);
    if (object(log.kwargs)) log.kwargs = safeState(request(log.kwargs));
    for (const field of ["response", "raw_response"]) if (object(log[field])) {
      const response = { ...log[field] };
      if (Array.isArray(response.output)) response.output = response.output.map(responsesItem);
      if (Array.isArray(response.choices)) response.choices = response.choices.map(choice => object(choice) ? { ...choice, ...(choice.message ? { message: providerMessage(choice.message) } : {}) } : choice);
      log[field] = response;
    }
    visible.log_data = log;
  }
  return { visible, sealed };
}
function contentBlocks(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(part => object(part) && (part.type === "text" && typeof part.text === "string" || part.type === "image" && Array.isArray(part.image_urls) && part.image_urls.every(url => typeof url === "string")))) return null;
  return value.map(part => part.type === "image" ? { ...part, references: (part.image_urls as string[]).map(url => ({ url })) } : part);
}
function reasoning(value: Obj): unknown[] {
  return [ ...(typeof value.reasoning_content === "string" ? [{ type: "thinking", text: value.reasoning_content }] : []),
    ...(Array.isArray(value.thinking_blocks) ? value.thinking_blocks.map(block => object(block) && block.type === "thinking" ? { ...block, text: block.thinking } : block) : []) ];
}
function convert(raw: Obj, ctx: RecordContext): EventDraft | null {
  const source = raw.source, kind = raw.kind;
  if (!["agent", "user", "environment", "hook"].includes(String(source)) || typeof raw.id !== "string" || time(raw.timestamp) === EPOCH) return null;
  let category = "activity", actor = source === "agent" ? "agent" : "system", blocks: unknown[] = [];
  switch (kind) {
    case "MessageEvent": {
      if (!object(raw.llm_message)) return null;
      const message = raw.llm_message, normalized = contentBlocks(message.content);
      if (!normalized || !["user", "assistant", "system", "developer", "tool"].includes(String(message.role))) return null;
      category = "conversation_turn";
      actor = source === "user" && message.role === "user" && !raw.sender && !ctx.parentConversationId ? "human"
        : source === "agent" && message.role === "assistant" ? "agent" : "system";
      blocks = [...normalized, ...reasoning(message)];
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!object(call) || typeof call.id !== "string" || typeof call.name !== "string" || typeof call.arguments !== "string") return null;
          let input: unknown = call.arguments;
          try { input = JSON.parse(call.arguments); } catch { /* Preserve invalid arguments for a native error response. */ }
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
        }
        if (source !== "agent" || message.role !== "assistant") actor = "system";
      }
      if (message.role === "tool") {
        if (typeof message.tool_call_id !== "string") return null;
        blocks = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: blocks }];
      }
      if (Array.isArray(raw.extended_content)) blocks.push(...raw.extended_content);
      break;
    }
    case "ActionEvent": {
      if (typeof raw.tool_call_id !== "string" || typeof raw.tool_name !== "string" || !object(raw.tool_call)) return null;
      category = "conversation_turn";
      let input = raw.action;
      if (input == null && typeof raw.tool_call.arguments === "string") {
        try { input = JSON.parse(raw.tool_call.arguments); } catch { input = raw.tool_call.arguments; }
      }
      blocks = [...(Array.isArray(raw.thought) ? raw.thought : []), ...reasoning(raw), { type: "tool_use", id: raw.tool_call_id, name: raw.tool_name, input }];
      break;
    }
    case "ObservationEvent": case "UserRejectObservation": case "AgentErrorEvent":
      if (typeof raw.tool_call_id !== "string" || typeof raw.tool_name !== "string" || kind === "ObservationEvent" && !object(raw.observation)) return null;
      category = "conversation_turn"; actor = "system";
      blocks = [{ type: "tool_result", tool_use_id: raw.tool_call_id, content: raw.observation ?? raw.rejection_reason ?? raw.error,
        ...(kind !== "ObservationEvent" ? { is_error: true } : {}) }]; break;
    case "SystemPromptEvent":
      if (!object(raw.system_prompt) || typeof raw.system_prompt.text !== "string") return null;
      category = "context_injection"; actor = "system"; blocks = [raw.system_prompt, ...(raw.dynamic_context ? [raw.dynamic_context] : [])]; break;
    case "Condensation": case "CondensationSummaryEvent":
      category = "context_injection"; actor = "system";
      blocks = typeof raw.summary === "string" ? [{ type: "text", text: raw.summary }] : []; break;
    case "ConversationStateUpdateEvent": category = "session_state"; break;
    case "StreamingDeltaEvent": blocks = [...(typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : []), ...reasoning(raw)]; break;
    case "ACPToolCallEvent":
      // ACP title is descriptive, not a guaranteed function name. Preserve
      // explicit input/output and status without inventing tool semantics.
      if (typeof raw.tool_call_id !== "string" || typeof raw.title !== "string") return null;
      blocks = Array.isArray(raw.content) ? raw.content : []; break;
    case "LLMCompletionLogEvent": if (!object(raw.log_data)) return null; break;
    case "TokenEvent": case "PauseEvent": case "CondensationRequest": case "HookExecutionEvent": case "ConversationErrorEvent": break;
    default: return null;
  }
  return recordDraft(ctx, category, actor, { ...raw, blocks,
    ...(category === "activity" ? { activity_type: kind } : category === "session_state" ? { state_type: kind } : category === "context_injection" ? { injection_type: kind } : {}) }, raw);
}
function drafts(raw: unknown, ctx: RecordContext, drift: Record<string, number>): EventDraft[] {
  if (object(raw) && raw.kind === "LLMCompletionLogEvent" && typeof raw.log_data === "string") {
    try {
      const decoded: unknown = JSON.parse(raw.log_data);
      if (object(decoded)) {
        raw = { ...raw, log_data: decoded, cledger_log_data_encoding: "decoded-json-string" };
        ctx = { ...ctx, rawFormat: `${FORMAT}/decoded-log-data` };
      }
    } catch { /* Preserve malformed declared JSON as unrecognized, visibly. */ }
  } else if (object(raw) && raw.kind === "LLMCompletionLogEvent" && raw.cledger_log_data_encoding === "decoded-json-string") {
    ctx = { ...ctx, rawFormat: `${FORMAT}/decoded-log-data` };
  }
  const split = object(raw) ? separate(raw) : { visible: raw, sealed: [] };
  const converted = object(split.visible) ? convert(split.visible, ctx) : null;
  const key = object(raw) ? String(raw.kind ?? "missing-kind") : "invalid-event";
  if (!converted) countUnrecognized(drift, key);
  const result = [converted ?? recordDraft(ctx, "unrecognized", "system", { unrecognized_type: key, raw_sha256: sha256Hex(canonicalJson(split.visible)) }, split.visible)];
  if (split.sealed.length) result.push(recordDraft(ctx, "reasoning", "agent", { opaque: true, encrypted_sha256: sha256Hex(canonicalJson(split.sealed)) }, { native_event_id: object(raw) ? raw.id : null, sealed: split.sealed }));
  return result;
}
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  if (!event.raw || !event.stream || !object(event.raw.data)) return null;
  const result = drafts(event.raw.data, context(event.producer.session_id ?? "", event.stream.seq, event.occurred_at, event.stream.parent?.replace(/^openhands:/, ""), identity), {});
  return result[0]?.kind === "unrecognized" ? null : result;
}
export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null { return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null; }
async function entries(path: string): Promise<import("node:fs").Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** SDK1.21 writes these JSON files directly, without atomic rename. Retry a
 * transient torn write; persistent corruption remains an explicit error. */
async function nativeJson(path: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError) || attempt >= 4) throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
}
export async function captureOpenHandsSession(directory: string, cwd: string, expectedCwd?: string, parent?: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd); if (!repo) throw new Error("not inside a git repository");
  const state = await nativeJson(join(directory, "base_state.json"));
  if (!object(state) || typeof state.id !== "string" || !object(state.workspace) || typeof state.workspace.working_dir !== "string") throw new Error("OpenHands base_state shape changed");
  if (expectedCwd !== undefined && await canonical(state.workspace.working_dir) !== await canonical(expectedCwd)) return empty();
  const identity = await gitUserIdentity(repo), result = empty(), safe = safeState(state) as Obj;
  const output: EventDraft[] = [sessionStateDraft(context(state.id, 0, EPOCH, parent), "base_state", safe, safe)];
  const files = (await entries(join(directory, "events"))).filter(e => e.isFile() && e.name.endsWith(".json")).sort((a,b) => a.name.localeCompare(b.name));
  for (const file of files) {
    if (!/^event-\d{5,}-[\da-f-]{8,}\.json$/i.test(file.name)) {
      const raw = await nativeJson(join(directory, "events", file.name));
      countUnrecognized(result.unrecognized, "event-filename");
      output.push(recordDraft(context(state.id, 0, object(raw) ? time(raw.timestamp) : EPOCH, parent), "unrecognized", "system",
        { unrecognized_type: "event-filename", native_filename: file.name, raw_sha256: sha256Hex(canonicalJson(raw)) }, raw));
      continue;
    }
    const seq = Number(file.name.split("-")[1]) + 1;
    if (!Number.isSafeInteger(seq)) throw new Error("OpenHands event position exceeds safe integer");
    const raw = await nativeJson(join(directory, "events", file.name));
    output.push(...drafts(raw, context(state.id, seq, object(raw) ? time(raw.timestamp) : EPOCH, parent, identity), result.unrecognized));
  }
  const appended = await appendEvents(repo, output); result.appended = appended.appended.length; result.deduped = appended.deduped;
  for (const child of await entries(join(directory, "subagents"))) if (child.isDirectory() && UUID.test(child.name)) {
    mergeCaptureResult(result, await captureOpenHandsSession(join(directory, "subagents", child.name), cwd, undefined, state.id));
  }
  warnUnrecognized("openhands", result.unrecognized); return result;
}
export const captureOpenHandsTranscript = captureOpenHandsSession;
export async function captureOpenHandsAll(cwd: string, sessionRoot = storeRoot()): Promise<CaptureResult> {
  const result = empty();
  for (const item of await entries(sessionRoot)) if (item.isDirectory() && UUID.test(item.name)) {
    mergeCaptureResult(result, await captureOpenHandsSession(join(sessionRoot, item.name), cwd, cwd));
  }
  return result;
}
export async function runOpenHandsHook(stdinJson: string): Promise<void> {
  try {
    const payload: unknown = JSON.parse(stdinJson);
    if (!object(payload) || typeof payload.session_id !== "string" || !UUID.test(payload.session_id) || typeof payload.working_dir !== "string") return;
    if (!(await findRepo(payload.working_dir))) return;
    const directory = join(storeRoot(), payload.session_id.replaceAll("-", ""));
    // SDK persists this very HookExecutionEvent after the command exits.
    await scheduleTailCapture(directory, payload.working_dir, "openhands", fileURLToPath(import.meta.url));
    await captureOpenHandsSession(directory, payload.working_dir, payload.working_dir);
  } catch (error) { process.stderr.write(`cledger: openhands hook error: ${error instanceof Error ? error.message : String(error)}\n`); }
}
async function fingerprint(directory: string): Promise<string> {
  const values: unknown[] = [];
  for (const entry of await entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && (entry.name === "events" || entry.name === "subagents" || UUID.test(entry.name))) values.push([entry.name, await fingerprint(path)]);
    else if (entry.isFile()) { const stat = await lstat(path); values.push([entry.name, stat.size, stat.mtimeMs]); }
  }
  return JSON.stringify(values.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--cledger-tail") {
  const [directory, cwd, lock, status] = process.argv.slice(3);
  if (!directory || !cwd || !lock || !status) throw new Error("Missing OpenHands tail worker arguments");
  await runTailCapture(lock, status, "openhands", () => fingerprint(directory), () => captureOpenHandsSession(directory, cwd, cwd));
}
