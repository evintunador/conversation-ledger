/**
 * Copilot's persisted session event envelope. Inventory follows the official
 * github/copilot-sdk nodejs/src/generated/session-events.ts (2026-09-28).
 * Every known record retains its native data; unknown types remain recoverable.
 * No private database or credential store is opened.
 */
import { readdir, readFile, realpath, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { findRepo, gitUserIdentity, sha256Hex, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { packageVersion, readCursor, writeCursor } from "./common.js";
import { countUnrecognized, mergeCaptureResult, unrecognizedDraft, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, type RecordContext } from "./records.js";

const FORMAT = "copilot-session-events-jsonl/1";
const FIELD = "copilotLines";
export interface CopilotRecord { id?: string; type?: string; timestamp?: string; parentId?: string | null; agentId?: string; data?: Record<string, unknown>; ephemeral?: boolean }

/** Includes ephemeral SDK types defensively if an explicit export persists them. */
export const COPILOT_RECORD_TYPES = new Set(`
session.start session.resume session.remote_steerable_changed session.error session.idle session.title_changed
session.schedule_created session.schedule_cancelled session.schedule_rearmed session.autopilot_objective_changed
session.info session.indexed_search session.warning session.model_change session.model_deselected
session.auto_tier_recommendation session.auto_tier_switch_failed session.mode_changed session.mode_notice_delivered
session.session_limits_changed session.permissions_changed session.plan_changed session.todos_changed
session.workspace_file_changed session.handoff session.truncation session.snapshot_rewind session.shutdown
session.usage_checkpoint session.context_changed session.usage_info session.context_cleared session.compaction_start
session.compaction_complete session.task_complete session.completion_receipt session.fusion_route_started
session.fusion_route_failed session.fusion_resolved session.fusion_completed session.permission_recovery
user.message pending_messages.modified assistant.turn_start assistant.intent assistant.fusion_phase_started
assistant.fusion_phase_activity assistant.fusion_phase_completed assistant.fusion_phase_failed assistant.server_tool_progress
assistant.reasoning assistant.reasoning_delta assistant.tool_call_delta assistant.streaming_delta assistant.message
assistant.message_start assistant.message_delta assistant.turn_end assistant.idle assistant.usage model.call_failure
model.call_finished abort tool.user_requested tool.execution_start tool.execution_partial_result tool.execution_progress
tool.execution_complete tool_search.activated skill.invoked subagent.started subagent.configured subagent.completed
subagent.failed subagent.selected subagent.deselected hook.start hook.end hook.progress session.binary_asset
system.message system.notification permission.requested permission.completed permission.carriedForward
permission.messageAuthorization permission.messageAuthorizationRead permission.messageAuthorizationDegraded
permission.assentDetected permission.contextualAuthorization user_input.requested user_input.completed
elicitation.requested elicitation.completed sampling.requested sampling.completed mcp.oauth_required mcp.oauth_completed
mcp.headers_refresh_required mcp.headers_refresh_completed session.custom_notification ui.ephemeral_query
external_tool.requested external_tool.completed command.queued command.execute command.completed auto_mode_switch.requested
auto_mode_switch.completed session_limits_exhausted.requested session_limits_exhausted.completed session.auto_mode_resolved
session.managed_settings_resolved session.managed_settings_enforced commands.changed capabilities.changed
exit_plan_mode.requested exit_plan_mode.completed session.tools_updated session.background_tasks_changed
workflow.run_updated workflow.run_started workflow.run_settled session.skills_loaded session.custom_agents_updated
session.mcp_servers_loaded session.mcp_server_status_changed session.mcp_server_removed session.mcp_server_needs_reconnect
mcp.tools.list_changed mcp.resources.list_changed mcp.prompts.list_changed session.extensions_loaded session.canvas.opened
session.canvas.registry_changed session.canvas.closed session.canvas.unavailable session.canvas.recorded session.canvas.removed
session.extensions.attachments_pushed mcp_app.tool_call_complete
`.trim().split(/\s+/));

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function plainObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function shapeProblem(line: CopilotRecord): string | undefined {
  if (typeof line.type !== "string" || (line.id !== undefined && typeof line.id !== "string") || (line.agentId !== undefined && typeof line.agentId !== "string")) return "invalid-envelope";
  if (!plainObject(line.data)) return "missing-or-invalid-data";
  const d = line.data;
  if (["user.message", "assistant.message", "assistant.reasoning", "system.message", "skill.invoked"].includes(line.type ?? "") && typeof d.content !== "string") return "missing-content";
  if (["tool.execution_start", "tool.user_requested"].includes(line.type ?? "") && (typeof d.toolCallId !== "string" || typeof d.toolName !== "string")) return "invalid-tool-call";
  if (line.type === "tool.execution_complete" && (typeof d.toolCallId !== "string" || typeof d.success !== "boolean")) return "invalid-tool-result";
  return undefined;
}
function result(): CaptureResult { return { appended: 0, deduped: 0, unrecognized: {} }; }
function home(): string { return process.env.COPILOT_HOME || join(homedir(), ".copilot"); }
async function canonical(path: string): Promise<string> { return realpath(path).catch(() => resolve(path)); }

function convert(line: CopilotRecord, ctx: RecordContext): EventDraft[] {
  const type = typeof line.type === "string" ? line.type : "(untyped)";
  const problem = shapeProblem(line);
  const data = { ...line.data };
  const nativeId = line.id ?? `line-${ctx.seq}`;
  const opaque: { field: string; encrypted_content: string }[] = [];
  if (type === "assistant.message" && !problem) {
    for (const field of ["encryptedContent", "reasoningOpaque"]) {
      if (typeof data[field] === "string") {
        opaque.push({ field, encrypted_content: data[field] });
        data[field] = { opaque: true, preserved_in: "reasoning sibling" };
      }
    }
    const reasoning = object(data.reasoningBlocks);
    if (Array.isArray(reasoning.blocks)) {
      data.reasoningBlocks = { ...reasoning, blocks: reasoning.blocks.map((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const block = { ...object(value) };
        const field = block.type === "reasoning" ? "encrypted_content" : block.type === "redacted_thinking" ? "data" : undefined;
        if (field && typeof block[field] === "string") {
          opaque.push({ field: `reasoningBlocks.blocks[${index}].${field}`, encrypted_content: block[field] });
          block[field] = { opaque: true, preserved_in: "reasoning sibling" };
        }
        return block;
      }) };
    }
  }
  const raw = problem ? line : { ...line, data };
  const native = { source_event_id: nativeId, source_parent_id: line.parentId ?? null, source_type: type };
  const blocks: Record<string, unknown>[] = [];
  const addText = (value: unknown, blockType = "text") => { if (typeof value === "string" && value) blocks.push({ type: blockType, text: value }); };
  let kind = "activity", actor = "system";
  if (type === "user.message" || type === "assistant.message" || type === "assistant.reasoning") {
    kind = "conversation_turn";
    const injected = !!line.agentId || data.isAutopilotContinuation === true || (typeof data.source === "string" && /^(skill-|agent-)/.test(data.source));
    actor = type === "user.message" ? (injected ? "system" : "human") : "agent";
    addText(data.content, type === "assistant.reasoning" ? "thinking" : "text");
    addText(data.reasoningText, "thinking");
    const reasoningBlocks = object(data.reasoningBlocks).blocks;
    for (const value of Array.isArray(reasoningBlocks) ? reasoningBlocks : []) {
      const block = object(value);
      if (block.type === "thinking") addText(block.thinking, "thinking");
      if (block.type === "reasoning" && Array.isArray(block.summary)) for (const summary of block.summary) addText(object(summary).text, "thinking");
    }
    for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
      const r = object(request);
      blocks.push({ type: "tool_use", id: r.toolCallId, name: r.name, input: r.arguments });
    }
  } else if (type === "tool.execution_start" || type === "tool.user_requested") {
    kind = "conversation_turn"; actor = type === "tool.user_requested" ? "human" : "agent";
    blocks.push({ type: "tool_use", id: data.toolCallId, name: data.toolName, input: data.arguments });
  } else if (type === "tool.execution_complete") {
    kind = "conversation_turn";
    blocks.push({ type: "tool_result", tool_use_id: data.toolCallId, content: data.result ?? data.error, is_error: data.success === false });
  } else if (type === "system.message" || type === "skill.invoked" || type === "session.compaction_complete") {
    kind = "context_injection"; addText(data.content); addText(data.summaryContent);
  } else if (type === "session.start" || type === "session.resume" || type.endsWith("_changed") || type.endsWith("_loaded") || type.endsWith("_updated") || type === "session.model_change" || type === "subagent.configured") {
    kind = "session_state";
  } else {
    if (type === "user_input.completed" || type === "command.execute") actor = "human";
    for (const key of ["content", "message", "summary", "response", "answer", "description", "deltaContent", "partialOutput", "progressMessage"]) addText(data[key]);
  }
  let draft: EventDraft;
  if (!COPILOT_RECORD_TYPES.has(type) || problem) {
    draft = unrecognizedDraft({ typeKey: problem ? `${type}/${problem}` : type, line: raw, occurredAt: ctx.occurredAt, source: ctx.source,
      sessionId: ctx.sessionId, seq: ctx.seq, version: ctx.version, rawFormat: FORMAT, conversationId: ctx.conversationId,
      ...(ctx.parentConversationId ? { parentConversationId: ctx.parentConversationId } : {}), ...(ctx.agent ? { agent: ctx.agent } : {}) });
    draft.content = { ...object(draft.content), ...native, source_record_sha256: sha256Hex(JSON.stringify(line)) };
  } else {
    draft = recordDraft(ctx, kind, actor, { ...data, ...native, ...(blocks.length ? { blocks } : {}),
      ...(kind === "activity" ? { activity_type: type } : {}), ...(kind === "session_state" ? { state_type: type } : {}),
      ...(kind === "context_injection" ? { injection_type: type } : {}) }, raw);
  }
  if (actor === "agent" && typeof data.model === "string" && draft.actor) draft.actor.id = data.model;
  return opaque.length ? [draft, recordDraft(ctx, "reasoning", "agent", { opaque: true, ...native }, { ...raw, opaque_fields: opaque })] : [draft];
}

export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null {
  return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null;
}

export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  if (!event.raw || !event.stream) return null;
  const line = event.raw.data as CopilotRecord;
  if (!line.type || !COPILOT_RECORD_TYPES.has(line.type) || shapeProblem(line)) return null;
  return convert(line, { occurredAt: event.occurred_at, source: "copilot", sessionId: event.producer.session_id ?? "",
    seq: event.stream.seq, version: packageVersion(), rawFormat: FORMAT, conversationId: event.stream.id,
    ...(event.stream.parent ? { parentConversationId: event.stream.parent } : {}), identity,
    agent: { ...(event.producer.source_version ? { source_version: event.producer.source_version } : {}),
      ...(event.producer.model ? { model: event.producer.model } : {}),
      ...(event.producer.provider ? { provider: event.producer.provider } : {}) } });
}

export async function captureCopilotTranscript(path: string, cwd: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const out = result();
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch { return out; }
  const lines = raw.split("\n"), records: { record: CopilotRecord; index: number; invalid?: { raw: unknown; key: string; digest: string; occurrence: number } }[] = [];
  const occurrences = new Map<string, number>();
  // An unterminated line may still be complete JSON; wait until its newline lands.
  const complete = lines.length - 1;
  for (let i = 0; i < complete; i++) {
    const source = lines[i]!;
    if (!source.trim()) continue;
    let value: unknown = source, key = "malformed-json";
    try { value = JSON.parse(source); key = "non-object-json"; } catch { /* preserve exact text */ }
    if (plainObject(value)) records.push({ record: value as CopilotRecord, index: i });
    else {
      const digest = sha256Hex(source), occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      records.push({ record: {}, index: i, invalid: { raw: value, key, digest, occurrence } });
    }
  }
  const start = records.find(r => r.record.type === "session.start")?.record.data ?? {};
  const sessionId = text(start.sessionId) ?? basename(dirname(path));
  const sourceVersion = text(start.copilotVersion);
  const scope = await canonical(cwd), identity = await gitUserIdentity(repo), drafts: EventDraft[] = [];
  const version = packageVersion();
  const locations = new Map<string, Promise<string>>();
  const location = (path: string) => { let value = locations.get(path); if (!value) { value = canonical(path); locations.set(path, value); } return value; };
  const parents = new Map<string, string>();
  for (const { record } of records) {
    if (record.agentId && record.type === "subagent.started" && typeof record.data?.parentId === "string") parents.set(record.agentId, record.data.parentId);
  }
  let eventCwd = text(object(start.context).cwd);
  for (const { record, index, invalid } of records) {
    const data = object(record.data);
    if (["session.start", "session.resume", "session.context_changed"].includes(record.type ?? "")) eventCwd = text(object(data.context).cwd) ?? text(data.cwd) ?? eventCwd;
    if (!eventCwd || await location(eventCwd) !== scope) continue;
    const base = text(start.startTime);
    const date = typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : base && Number.isFinite(Date.parse(base)) ? base : "1970-01-01T00:00:00.000Z";
    // Timestamp + source UUID in content yields stable identity even when a compaction
    // rewrites/removes earlier lines. Equal-millisecond native order remains in parentId.
    const seq = record.id || invalid ? Date.parse(date) : index;
    const agentId = text(record.agentId);
    const conversationId = agentId ? `copilot:${sessionId}:agent:${agentId}` : `copilot:${sessionId}`;
    const ctx: RecordContext = { occurredAt: date, source: "copilot", sessionId, seq, version, rawFormat: FORMAT,
      conversationId, ...(agentId ? { parentConversationId: parents.has(agentId) ? `copilot:${sessionId}:agent:${parents.get(agentId)}` : `copilot:${sessionId}` } : {}), identity,
      agent: { ...(sourceVersion ? { source_version: sourceVersion } : {}), ...(typeof data.model === "string" ? { model: data.model } : {}) } };
    if (invalid) {
      countUnrecognized(out.unrecognized, invalid.key);
      const draft = unrecognizedDraft({ typeKey: invalid.key, line: invalid.raw, occurredAt: date, source: "copilot",
        sessionId, seq, version, rawFormat: FORMAT, conversationId });
      draft.content = { ...object(draft.content), source_record_sha256: invalid.digest, occurrence: invalid.occurrence };
      drafts.push(draft);
    } else {
      const type = typeof record.type === "string" ? record.type : "(untyped)", problem = shapeProblem(record);
      if (!COPILOT_RECORD_TYPES.has(type) || problem) countUnrecognized(out.unrecognized, problem ? `${type}/${problem}` : type);
      drafts.push(...convert(record, ctx));
    }
  }
  if (drafts.length) { const appended = await appendEvents(repo, drafts); out.appended = appended.appended.length; out.deduped = appended.deduped; }
  await writeCursor(repo, `copilot-${sessionId}`, FIELD, complete, Buffer.byteLength(lines.slice(0, complete).join("\n")) + (complete ? 1 : 0));
  warnUnrecognized("copilot", out.unrecognized);
  return out;
}

async function paths(): Promise<string[]> {
  const root = join(home(), "session-state");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isDirectory()).map(e => join(root, e.name, "events.jsonl"));
}
export async function captureCopilotAll(cwd: string, limit?: number): Promise<CaptureResult> {
  const total = result();
  const candidates = await paths();
  const requested = await canonical(cwd);
  // Scope before applying limit; another project's sessions must not consume it.
  let matched = 0;
  for (const path of candidates.sort()) {
    const raw = await readFile(path, "utf8").catch(() => "");
    let scoped = false;
    for (const row of raw.split("\n")) {
      try {
        const r = JSON.parse(row);
        if (!["session.start", "session.resume", "session.context_changed"].includes(r.type)) continue;
        const location = r.data?.context?.cwd ?? r.data?.cwd;
        if (typeof location === "string" && await canonical(location) === requested) { scoped = true; break; }
      } catch { /* incomplete or malformed line */ }
    }
    if (!scoped) continue;
    if (limit !== undefined && matched++ >= limit) break;
    mergeCaptureResult(total, await captureCopilotTranscript(path, cwd));
  }
  return total;
}

export async function runCopilotHook(stdinJson: string): Promise<void> {
  try {
    const input = JSON.parse(stdinJson) as Record<string, unknown>;
    const cwd = text(input.cwd) ?? process.cwd(), repo = await findRepo(cwd);
    if (!repo) return;
    const session = text(input.sessionId) ?? text(input.session_id);
    const direct = text(input.transcriptPath) ?? text(input.transcript_path);
    const path = direct ?? (session && /^[A-Za-z0-9_-]+$/.test(session) ? join(home(), "session-state", session, "events.jsonl") : undefined);
    if (path) {
      // Native 1.0.89 can invoke agentStop before events.jsonl even exists.
      // Wait for its hook milestone to reach disk, not an arbitrary fixed sleep.
      const stamp = typeof input.timestamp === "number" ? input.timestamp : typeof input.timestamp === "string" ? Date.parse(input.timestamp) : NaN;
      const deadline = Date.now() + 2_000;
      let ready = false;
      do {
        try {
          const bytes = await readFile(path, "utf8");
          const complete = bytes.slice(0, bytes.lastIndexOf("\n")).trimEnd();
          const last = JSON.parse(complete.slice(complete.lastIndexOf("\n") + 1)) as CopilotRecord;
          ready = !Number.isFinite(stamp) || (typeof last.timestamp === "string" && Date.parse(last.timestamp) >= stamp);
        } catch { /* absent or partial while native writer flushes */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      if (!ready) process.stderr.write("cledger: copilot transcript flush deadline reached; capturing available records\n");
    }
    const total = path ? await captureCopilotTranscript(path, cwd) : result();
    for (const other of await paths()) {
      if (other === path) continue;
      if (!(await readCursor(repo, `copilot-${basename(dirname(other))}`, FIELD))) continue;
      mergeCaptureResult(total, await captureCopilotTranscript(other, cwd));
    }
    if (path && process.argv.includes("--session-end")) await scheduleCopilotTail(path, cwd, typeof input.timestamp === "number" ? input.timestamp : Date.now());
    process.stderr.write(`cledger: copilot +${total.appended} events (${total.deduped} deduped)\n`);
  } catch (error) { process.stderr.write(`cledger: copilot hook error: ${error instanceof Error ? error.message : String(error)}\n`); }
}

export const COPILOT_TAIL_DIRECTORY = "cledger-copilot-tail";
async function scheduleCopilotTail(path: string, cwd: string, since: number): Promise<void> {
  const repo = await findRepo(cwd); if (!repo) return;
  const base = join(repo.commonDir, COPILOT_TAIL_DIRECTORY);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const key = sha256Hex(resolve(path)), lock = join(base, key + ".lock"), status = join(base, key + ".json");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      try { process.kill(owner.pid, 0); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return; }
    } catch { if (Date.now() - (await stat(lock)).mtimeMs < 15_000) return; }
    await rm(lock, { recursive: true, force: true });
    try { await mkdir(lock); } catch { return; }
  }
  // No source content or subprocess output is logged; status is bounded metadata.
  await writeFile(status, JSON.stringify({ status: "running" }), { mode: 0o600 });
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--copilot-tail", path, cwd, lock, status, String(since)], { detached: true, stdio: "ignore", cwd });
    await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
    child.unref();
  } catch (error) { await writeFile(status, JSON.stringify({ status: "failed", reason: "spawn failed" }), { mode: 0o600 }); await rm(lock, { recursive: true, force: true }); throw error; }
}
export async function runCopilotTail(path: string, cwd: string, lock: string, status: string, since = 0): Promise<void> {
  const save = (state: string, reason?: string) => writeFileSync(status, JSON.stringify({ status: state, pid: process.pid, ...(reason ? { reason } : {}) }), { mode: 0o600 });
  const timer = setTimeout(() => {
    try { save("failed", "hard deadline"); } catch { /* best effort status */ }
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 10_000);
  try {
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
      const bytes = await readFile(path, "utf8").catch(() => "");
      const complete = bytes.slice(0, bytes.lastIndexOf("\n"));
      const shutdown = complete.split("\n").some(row => { try { const event = JSON.parse(row); return event.type === "session.shutdown" && Date.parse(event.timestamp) >= since; } catch { return false; } });
      if (shutdown) { await captureCopilotTranscript(path, cwd); save("complete"); return; }
      await new Promise(r => setTimeout(r, 100));
    }
    await captureCopilotTranscript(path, cwd);
    save("failed", "session.shutdown not observed before deadline");
  } catch { save("failed", "tail capture failed"); }
  finally { clearTimeout(timer); await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--copilot-tail") {
  const [path, cwd, lock, status, since] = process.argv.slice(3);
  if (!path || !cwd || !lock || !status) throw new Error("Missing Copilot tail arguments");
  await runCopilotTail(path, cwd, lock, status, Number(since));
}
