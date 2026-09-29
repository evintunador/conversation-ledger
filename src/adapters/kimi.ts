import { scheduleTailCapture, runTailCapture } from "./tail.js";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, activityDraft, contextInjectionDraft, sessionStateDraft, type RecordContext } from "./records.js";

// MoonshotAI/kimi-code TypeScript successor, wire protocol 1.5, checked
// 2026-09-28: agent-core-v2/docs/wire-manifest.d.ts, wire/tree/tree.ts,
// human/llm/message.ts, agent/contextMemory/loopEventFold.ts. The archived
// Python kimi-cli protocol is deliberately not interpreted as this format.
const FORMAT = "kimi-code-wire-jsonl/1";
const KNOWN = new Set(["config.update", "context.append_loop_event", "context.append_message", "context.apply_compaction", "context.clear", "context.undo", "cron.add", "cron.cursor", "cron.delete", "file_history.checkpoint", "file_history.tracked", "forked", "full_compaction.begin", "full_compaction.cancel", "full_compaction.complete", "goal.clear", "goal.create", "goal.update", "interaction.request", "interaction.resolved", "interruptionReminder.recorded", "llm.request", "llm.tools_snapshot", "mcp.tools_discovered", "permission.record_approval_result", "permission.set_mode", "plan_mode.cancel", "plan_mode.enter", "plan_mode.exit", "plan.revision", "plugin.session_start", "profile.bind", "prompt.aborted", "prompt.completed", "prompt.steered", "runtime.set_binding", "subagent.cancelled", "subagent.completed", "subagent.failed", "subagent.spawned", "subagent.started", "swarm_mode.enter", "swarm_mode.exit", "task.started", "task.terminated", "task.waitDelivered", "token_counting.measured", "token_counting.rebased", "token_counting.truncated", "token_counting.turn_recorded", "tools.register_user_tool", "tools.reset_active_tools", "tools.set_active_tools", "tools.unregister_user_tool", "tools.update_store", "tower_mode.enter", "tower_mode.exit", "turn.cancel", "turn.ended", "turn.prompt", "turn.steer", "turn.step.interrupted", "turn.step.retrying", "usage.record"]);
// State declarations/mutations persist until superseded; operational records
// below remain activity. Keep this explicit rather than prefix guessing.
const STATE_TYPES = new Set([
  "config.update", "profile.bind", "runtime.set_binding", "permission.set_mode",
  "plan_mode.enter", "plan_mode.exit", "plan_mode.cancel", "plan.revision",
  "goal.create", "goal.update", "goal.clear", "cron.add", "cron.delete", "cron.cursor",
  "tools.register_user_tool", "tools.unregister_user_tool", "tools.set_active_tools",
  "tools.reset_active_tools", "tools.update_store", "llm.tools_snapshot", "mcp.tools_discovered",
  "tower_mode.enter", "tower_mode.exit", "swarm_mode.enter", "swarm_mode.exit",
  "context.clear", "context.undo", "forked",
]);
const EPOCH = "1970-01-01T00:00:00.000Z";
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
function timestamp(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") return EPOCH;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? EPOCH : date.toISOString();
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex"); }
function unknown(raw: unknown, key: string, ctx: RecordContext): EventDraft {
  return recordDraft(ctx, "unrecognized", "system", { unrecognized_type: key, raw_sha256: hash(raw) }, raw);
}
function parts(value: unknown, drift: Record<string, number>): unknown[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) { countUnrecognized(drift, "content/(malformed)"); return [{ type: "unrecognized", data: value ?? null }]; }
  return value.map((part) => {
    if (!object(part)) { countUnrecognized(drift, "content/(non-object)"); return part; }
    const field = part.type === "image_url" ? "imageUrl" : part.type === "audio_url" ? "audioUrl" : part.type === "video_url" ? "videoUrl" : undefined;
    if (part.type === "text" && typeof part.text !== "string" || part.type === "think" && typeof part.think !== "string" || field && (!object(part[field]) || !(typeof (part[field] as Obj).url === "string" || object((part[field] as Obj).url) && ["attachment_reference","attachment_text"].includes(String(((part[field] as Obj).url as Obj).type))))) {
      countUnrecognized(drift, `content/${String(part.type)}/malformed`);
      return part;
    }
    if (part.type === "think") {
      const { think, encrypted: _encrypted, ...rest } = part;
      return { ...rest, type: "thinking", text: think };
    }
    if (!["text", "image_url", "audio_url", "video_url"].includes(String(part.type))) countUnrecognized(drift, `content/${String(part.type)}`);
    return part;
  });
}
// Only explicitly provider-encrypted think fields receive the reasoning
// redaction exemption; native location markers support reconstruction.
function separateEncrypted(entry: Obj): { visible: Obj; signatures: Obj[] } {
  const signatures: Obj[] = [];
  function walk(value: unknown, path: (string | number)[]): unknown {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, i]));
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (value.type === "think" && key === "encrypted" && typeof child === "string") {
        signatures.push({ path: [...path, key], native_field: "encrypted", encrypted_content: child });
        return [key, { type: "reasoning_reference", index: signatures.length - 1 }];
      }
      return [key, walk(child, [...path, key])];
    }));
  }
  return { visible: walk(entry, []) as Obj, signatures };
}
function originKind(value: unknown): unknown { return object(value) ? value.kind : value; }
function convert(entry: Obj, ctx: RecordContext, drift: Record<string, number>): EventDraft | null {
  const { type, ...fields } = entry;
  if (type === "metadata" || type === "agent.switched" || type === "session_metadata") return sessionStateDraft(ctx, String(type), fields, entry);
  if (type === "agent.message.appended") {
    // Native machine journal mirrors context messages. Preserve the sealed
    // history snapshot as activity, not a second human/assistant utterance.
    if (!object(entry.message) || !object(entry.message.message)) return null;
    const m = entry.message.message;
    return activityDraft(ctx, String(type), { ...fields, role: m.role,
      blocks: parts(m.content, drift), message_metadata: entry.message.meta }, entry);
  }
  if (type === "agent.turn.started" || type === "agent.turn.ended") return activityDraft(ctx, String(type), fields, entry);
  if (type === "file_history.checkpoint" || type === "file_history.tracked") {
    const entries = type === "file_history.tracked"
      ? (typeof entry.path === "string" && object(entry.entry) ? { [entry.path]: entry.entry } : undefined)
      : (object(entry.entries) ? entry.entries : undefined);
    if (!entries) return null;
    const files = Object.entries(entries).map(([path, backup]) => {
      if (!object(backup) || typeof backup.version !== "number" || !(backup.key === null || typeof backup.key === "string")) {
        countUnrecognized(drift, "file_history/(malformed-entry)");
        return { path, unrecognized: backup };
      }
      return { path, ...backup, backup_file: backup.key, availability: backup.key === null ? "not_backed_up" : "native_backup_reference" };
    });
    return recordDraft(ctx, "file_snapshot", "system", { ...fields, snapshot_type: type,
      operation: type === "file_history.checkpoint" ? "snapshot" : "delta", files }, entry);
  }
  if (type === "context.append_loop_event") {
    if (!object(entry.event)) return null;
    const e = entry.event;
    const details = { ...fields, event_type: e.type, ...e };
    if (e.type === "content.part") return recordDraft(ctx, "conversation_turn", "agent", { ...details, role: "assistant", blocks: parts([e.part], drift) }, entry);
    if (e.type === "tool.call" && typeof e.toolCallId === "string" && typeof e.name === "string") return recordDraft(ctx, "conversation_turn", "agent", { ...details, role: "assistant", blocks: [{ type: "tool_use", id: e.toolCallId, name: e.name, input: e.args, extras: e.extras, display: e.display }] }, entry);
    if (e.type === "tool.result" && typeof e.toolCallId === "string" && object(e.result)) return recordDraft(ctx, "conversation_turn", "system", { ...details, role: "tool_result", blocks: [{ type: "tool_result", tool_use_id: e.toolCallId, is_error: e.result.isError, content: parts(e.result.output, drift), note: e.result.note, durationMs: e.result.durationMs }] }, entry);
    if (e.type === "step.begin" || e.type === "step.end") return activityDraft(ctx, String(e.type), details, entry);
    return null;
  }
  if (type === "context.append_message" && object(entry.message)) {
    const m = entry.message;
    const { content, toolCalls, ...metadata } = m;
    const blocks = parts(content, drift);
    if (Array.isArray(toolCalls)) for (const call of toolCalls) {
      if (!object(call) || typeof call.id !== "string" || (typeof call.name !== "string" && !object(call.function))) { countUnrecognized(drift, "toolCall/(malformed)"); blocks.push(call); continue; }
      const fn = object(call.function) ? call.function : call;
      let input = fn.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* Partial/native-invalid argument strings stay reconstructible. */ } }
      blocks.push({ ...call, type: "tool_use", name: fn.name, input });
    }
    const details = { ...fields, message: undefined, ...metadata, blocks };
    if (m.role === "assistant") return recordDraft(ctx, "conversation_turn", "agent", details, entry);
    if (m.role === "tool") return recordDraft(ctx, "conversation_turn", "system", { ...details, role: "tool_result", blocks: [{ type: "tool_result", tool_use_id: m.toolCallId, is_error: m.isError, content: blocks }] }, entry);
    if (m.role === "user" && (m.origin === undefined || originKind(m.origin) === "user")) return recordDraft(ctx, "conversation_turn", "human", details, entry);
    if (m.role === "user" || m.role === "system") return contextInjectionDraft(ctx, String(originKind(m.origin) ?? m.role), details, entry);
    return null;
  }
  if (type === "context.append_message") return null;
  if (type === "turn.prompt" || type === "turn.steer" || type === "prompt.steered") {
    // This is submission/queue metadata. The canonical human message arrives
    // separately in context.append_message; don't fabricate duplicate turns.
    return activityDraft(ctx, String(type), { ...fields, blocks: parts(entry.input ?? entry.content, drift) }, entry, originKind(entry.origin) === "user" ? "human" : "system");
  }
  if (type === "context.apply_compaction") {
    const summary = entry.summary ?? entry.contextSummary;
    return contextInjectionDraft(ctx, String(type), { ...fields, blocks: parts(object(summary) ? summary.content : summary, drift) }, entry);
  }
  if (typeof type === "string" && STATE_TYPES.has(type)) return sessionStateDraft(ctx, String(type), fields, entry);
  if (type === "llm.request" || type === "plugin.session_start") return contextInjectionDraft(ctx, String(type), fields, entry);
  if (typeof type === "string" && KNOWN.has(type)) return activityDraft(ctx, type, fields, entry);
  return null;
}

/** Explicit capture accepts a session directory or agents/<id>/wire.jsonl. */
export async function captureKimiTranscript(path: string, cwd: string, expectedCwd?: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd); if (!repo) throw new Error("not inside a git repository");
  const target = resolve(path);
  let directory: string;
  try { directory = (await lstat(target)).isDirectory() ? target : dirname(dirname(dirname(target))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw e; }
  const metadata: unknown = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  if (!object(metadata) || typeof metadata.id !== "string" || !metadata.id) throw new Error("Kimi Code capture requires native state.json session id");
  if (expectedCwd !== undefined && (typeof metadata.cwd !== "string" || !isAbsolute(metadata.cwd) || resolve(metadata.cwd) !== resolve(expectedCwd))) return empty();
  const identity = await gitUserIdentity(repo), version = packageVersion(), result = empty();
  const drafts: EventDraft[] = [];
  const base: RecordContext = { source: "kimi", sessionId: metadata.id, conversationId: `kimi:${metadata.id}:main`, seq: 0, occurredAt: timestamp(metadata.updatedAt ?? metadata.createdAt), rawFormat: FORMAT, identity, version };
  drafts.push(sessionStateDraft({ ...base, conversationId: `kimi:${metadata.id}:metadata` }, "session_metadata", metadata, metadata));
  let agentPaths: string[];
  if (target !== directory) {
    if (basename(target) !== "wire.jsonl" || basename(dirname(dirname(target))) !== "agents") throw new Error("Kimi Code transcript must be agents/<agent-id>/wire.jsonl");
    agentPaths = [dirname(target)];
  } else {
    agentPaths = (await readdir(join(directory, "agents"), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => join(directory, "agents", e.name)).sort();
  }
  for (const agentPath of agentPaths) {
    const agentId = basename(agentPath), wire = join(agentPath, "wire.jsonl");
    let data: string;
    try { if (!(await lstat(wire)).isFile()) continue; data = await readFile(wire, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    const lines = data.split("\n"), agentMeta = object(metadata.agents) && object(metadata.agents[agentId]) ? metadata.agents[agentId] as Obj : {};
    let agent: ProducerAgentContext = {}, branch = "main";
    const lineage = new Map<number, ProducerAgentContext>();
    let headerSeen = false;
    for (let seq = 0; seq < lines.length; seq++) {
      const line = lines[seq]!; if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch { if (seq === lines.length - 1 && !data.endsWith("\n")) break; raw = line; }
      if (!headerSeen) {
        if (!object(raw) || raw.type !== "metadata" || typeof raw.protocol_version !== "string" || !/^1\.[0-5]$/.test(raw.protocol_version)) throw new Error("Unsupported Kimi Code wire protocol (expected successor metadata 1.0–1.5)");
        headerSeen = true;
      }
      const entry = object(raw) ? raw : undefined;
      if (entry?.type === "agent.switched" && object(entry.base) && typeof entry.base.line === "number") agent = { ...lineage.get(entry.base.line) };
      if (entry?.type === "llm.request") {
        if (typeof entry.model === "string") agent.model = entry.model;
        if (typeof entry.provider === "string") agent.provider = entry.provider;
      }
      const ctx = { ...base, occurredAt: timestamp(entry?.time ?? entry?.created_at ?? metadata.createdAt), conversationId: `kimi:${metadata.id}:${agentId}`, seq, agent: { ...agent }, ...(typeof agentMeta.parentAgentId === "string" ? { parentConversationId: `kimi:${metadata.id}:${agentMeta.parentAgentId}` } : {}) };
      const separated = entry ? separateEncrypted(entry) : undefined;
      const nested: Record<string,number> = {};
      const draft = separated ? convert(separated.visible, ctx, nested) : null;
      for (const [key,count] of Object.entries(nested)) result.unrecognized[key] = (result.unrecognized[key] ?? 0) + count;
      if (draft) {
        if (object(draft.content)) draft.content = { ...draft.content, native_agent_id: agentId, native_branch: branch };
        drafts.push(draft);
        if (Object.keys(nested).length && separated) {
          const preserved = unknown(separated.visible, "nested/content", ctx);
          preserved.content = { ...preserved.content as object, unrecognized_types: nested, native_agent_id: agentId, native_branch: branch };
          drafts.push(preserved);
        }
        if (separated!.signatures.length) drafts.push(recordDraft({ ...ctx, rawFormat: "kimi-code-encrypted-reasoning/1" }, "reasoning", "agent", { opaque: true, native_agent_id: agentId, native_branch: branch, sealed_parts: separated!.signatures.map(item => ({ path: item.path, sha256: hash(item.encrypted_content) })) }, { native_format: FORMAT, signatures: separated!.signatures }));
      } else {
        const key = entry?.type === "context.append_loop_event" && object(entry.event) ? `context.append_loop_event/${String(entry.event.type)}` : String(entry?.type ?? "(malformed-record)");
        countUnrecognized(result.unrecognized, key);
        const fallback = unknown(raw, key, ctx);
        fallback.content = { ...(fallback.content as Obj), native_agent_id: agentId, native_branch: branch };
        drafts.push(fallback);
      }
      lineage.set(seq + 1, { ...agent }); // Native tree line numbers are one-based.
      if (entry?.type === "agent.switched" && typeof entry.branch === "string") branch = entry.branch;
    }
  }
  const appended = await appendEvents(repo, drafts); result.appended = appended.appended.length; result.deduped = appended.deduped;
  warnUnrecognized("kimi", result.unrecognized); return result;
}
export function kimiWorkDirKey(cwd: string): string {
  const normalized = resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  let slug = (normalized.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "");
  if (!slug || slug === "." || slug === "..") slug = "workspace";
  return `wd_${slug}_${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}
function home(): string { return process.env.KIMI_CODE_HOME ? resolve(process.env.KIMI_CODE_HOME) : join(homedir(), ".kimi-code"); }
export async function captureKimiAll(cwd: string, limit?: number, kimiHome = home()): Promise<CaptureResult> {
  if (!(await findRepo(cwd))) throw new Error("not inside a git repository");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("Kimi capture limit must be a non-negative integer");
  const total = empty(); if (limit === 0) return total;
  const bucket = join(kimiHome, "sessions", kimiWorkDirKey(cwd));
  let entries;
  try { entries = await readdir(bucket, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return total; throw e; }
  const candidates: { path: string; time: number }[] = [];
  for (const entry of entries) if (entry.isDirectory()) {
    const path = join(bucket, entry.name);
    try {
      if (!(await lstat(join(path, "state.json"))).isFile()) continue;
      const m: unknown = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
      if (object(m) && typeof m.cwd === "string" && isAbsolute(m.cwd) && resolve(m.cwd) === resolve(cwd)) candidates.push({ path, time: typeof m.updatedAt === "number" ? m.updatedAt : 0 });
    } catch (e) { if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  candidates.sort((a,b) => b.time-a.time || a.path.localeCompare(b.path));
  for (const candidate of candidates.slice(0, limit)) mergeCaptureResult(total, await captureKimiTranscript(candidate.path, cwd, cwd));
  return total;
}
export async function runKimiHook(stdinJson: string): Promise<void> {
  try {
    const p: unknown = JSON.parse(stdinJson);
    if (!object(p) || typeof p.cwd !== "string" || typeof p.session_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(p.session_id) || !(await findRepo(p.cwd))) return;
    const directory = join(home(), "sessions", kimiWorkDirKey(p.cwd), p.session_id);
    await captureKimiTranscript(directory, p.cwd, p.cwd);
    // Stop is blocking and precedes native turn-end persistence. A narrowly
    // scoped bounded child must outlive this hook to observe that tail.
    if (p.hook_event_name === "Stop") await scheduleTailCapture(directory, p.cwd, "kimi", fileURLToPath(import.meta.url));
  } catch (e) { process.stderr.write(`cledger: kimi hook error: ${e instanceof Error ? e.message : String(e)}\n`); }
}
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  if (!event.stream || !event.raw || !object(event.raw.data)) return null;
  const ctx: RecordContext = { occurredAt: event.occurred_at, source: "kimi", sessionId: event.producer.session_id ?? "", seq: event.stream.seq, version: packageVersion(), rawFormat: FORMAT, conversationId: event.stream.id,
    ...(event.stream.parent ? { parentConversationId: event.stream.parent } : {}), identity,
    agent: { ...(event.producer.model ? { model: event.producer.model } : {}), ...(event.producer.provider ? { provider: event.producer.provider } : {}) } };
  const separated = separateEncrypted(event.raw.data);
  const nested: Record<string,number> = {};
  const visible = convert(separated.visible, ctx, nested);
  if (!visible || Object.keys(nested).length) return null;
  const nativeAgent = typeof event.raw.data.agentId === "string" ? event.raw.data.agentId : event.stream.id.split(":").at(-1);
  const prior = object(event.content) ? event.content : {};
  const branch = typeof prior.native_branch === "string" ? prior.native_branch : "main";
  if (object(visible.content)) visible.content = { ...visible.content, native_agent_id: nativeAgent, native_branch: branch };
  const drafts = [visible];
  if (separated.signatures.length) drafts.push(recordDraft({ ...ctx, rawFormat: "kimi-code-encrypted-reasoning/1" }, "reasoning", "agent",
    { opaque: true, native_agent_id: nativeAgent, native_branch: branch, sealed_parts: separated.signatures.map(item => ({ path: item.path, sha256: hash(item.encrypted_content) })) }, { native_format: FORMAT, signatures: separated.signatures }));
  return drafts;
}
export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null {
  return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null;
}


export const KIMI_TAIL_DIRECTORY = "cledger-kimi-tail";
async function tailFingerprint(directory: string): Promise<string> {
  const paths = [join(directory, "state.json")];
  for (const entry of await readdir(join(directory, "agents"), { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(join(directory, "agents", entry.name, "wire.jsonl"));
  }
  const values: unknown[] = [];
  for (const path of paths.sort()) {
    try { const info = await lstat(path); if (info.isFile()) values.push([path, info.size, info.mtimeMs]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return JSON.stringify(values);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--cledger-tail") {
  const [directory, cwd, lock, status] = process.argv.slice(3);
  if (!directory || !cwd || !lock || !status) throw new Error("Missing Kimi tail worker arguments");
  await runTailCapture(lock, status, "kimi", () => tailFingerprint(directory), () => captureKimiTranscript(directory, cwd, cwd));
}
