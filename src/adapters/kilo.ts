/** Kilo CLI native export adapter. Audited @kilocode/cli 7.8.1 against
 * Kilo-Org/kilocode 88681cac59ad5e6f3934c1625af03690d0c665f8,
 * packages/schema/src/v1/session.ts (12 Part variants, 4 tool states).
 * Native export avoids opening the database containing provider credentials.
 * Full rescan intentionally catches in-place compaction/revert/metadata edits;
 * native identifiers plus content-based ledger dedup preserve settled revisions.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion } from "./common.js";
import {
  countUnrecognized,
  mergeCaptureResult,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";
import { activityDraft, contextInjectionDraft, liftText, recordDraft, type RecordContext } from "./records.js";

const RAW_FORMAT = "kilo-export-json/1";



const CONVERTIBLE_PART_TYPES = new Set(["text", "reasoning", "tool"]);

const ACTIVITY_PART_TYPES = new Set(["step-start", "step-finish", "patch"]);

const SETTLED_TOOL_STATUSES = new Set(["completed", "error"]);

interface KiloHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface KiloSessionInfo {
  [key: string]: unknown;
  id?: string;
    parentID?: string;
  directory?: string;
  title?: string;
    version?: string;
  time?: { created?: number; updated?: number };
}

interface KiloMessageInfo {
  [key: string]: unknown;
  id?: string;
  sessionID?: string;
  role?: string;
    agent?: string;
  mode?: string;
    modelID?: string;
  providerID?: string;
  model?: { modelID?: string; providerID?: string };
  time?: { created?: number; completed?: number };
}

interface KiloPart {
  [key: string]: unknown;
  id?: string;
  type?: string;
  messageID?: string;
  sessionID?: string;
  text?: string;
  tool?: string;
  callID?: string;
    snapshot?: string;
    reason?: string;
    tokens?: Record<string, unknown>;
  cost?: number;
  state?: {
    [key: string]: unknown;
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    attachments?: unknown[];
    time?: { start?: number; end?: number };
  };
  time?: { start?: number; end?: number; created?: number };
}

interface KiloMessage {
  info?: KiloMessageInfo;
  parts?: KiloPart[];
}

export interface KiloExport {
  info?: KiloSessionInfo;
  messages?: KiloMessage[];
}

interface KiloSessionRow {
  id?: string;
  title?: string;
  directory?: string;
  updated?: number;
}

interface FlatPart {
  info: KiloMessageInfo;
  part: KiloPart;
  seq: number;
}

function isoFromMs(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function runKilo(args: string[], cwd: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "cledger-kilo-"));
  const path = join(dir, "out.json");
  try {
    const handle = await open(path, "w");
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("kilo", args, {
          cwd,
          detached: true,
          stdio: ["ignore", handle.fd, "ignore"],
        });
        const timeout = setTimeout(() => {
          if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
        }, 30_000);
        child.on("error", error => { clearTimeout(timeout); reject(error); });
        child.on("close", code => { clearTimeout(timeout); resolve(code); });
      });
      if (code !== 0) throw new Error(`kilo ${args[0]} exited ${code ?? "after deadline/signal"}`);
    } finally {
      await handle.close();
    }
    return await readFile(path, "utf8");
  } catch (error) {
    process.stderr.write(`cledger: kilo native export warning: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function exportKiloSession(
  sessionId: string,
  cwd: string,
): Promise<KiloExport | null> {
  const stdout = await runKilo(["export", "--pure", sessionId], cwd);
  if (!stdout) return null;
  try {
    return JSON.parse(stdout) as KiloExport;
  } catch {
    return null;
  }
}

export async function listKiloSessions(cwd: string): Promise<KiloSessionRow[]> {
  const stdout = await runKilo(["session", "list", "--pure", "--format", "json"], cwd);
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as KiloSessionRow[]) : [];
  } catch {
    return [];
  }
}

function agentContext(info: KiloMessageInfo, sessionVersion?: string): ProducerAgentContext {
  const agent: ProducerAgentContext = {};
  if (sessionVersion) agent.source_version = sessionVersion;
  const model = info.modelID ?? info.model?.modelID;
  if (typeof model === "string" && model) agent.model = model;
  const provider = info.providerID ?? info.model?.providerID;
  if (typeof provider === "string" && provider) agent.provider = provider;
  return agent;
}

function partTime(info: KiloMessageInfo, part: KiloPart, baseTime: string): string {
  return (
    isoFromMs(part.time?.start) ??
    isoFromMs(part.time?.created) ??
    isoFromMs(part.state?.time?.start) ??
    isoFromMs(info.time?.created) ??
    baseTime
  );
}

function idTime(id: unknown): number | null {
  if (typeof id !== "string") return null;
  const match = id.match(/^prt_([0-9a-f]{12})/);
  if (!match) return parseInt(createHash("sha256").update(id).digest("hex").slice(0, 13), 16);
  const value = parseInt(match[1]!, 16);
  return Number.isSafeInteger(value) ? value : null;
}

function flattenParts(data: KiloExport): { flat: FlatPart[]; derived: boolean } {
  const positional: FlatPart[] = [];
  let seq = 0;
  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    if (!message || !Array.isArray(message.parts)) continue;
    const info = message.info ?? {};
    for (const part of message.parts ?? []) {
      positional.push({ info, part: part && typeof part === "object" ? part : { native_malformed_part: part }, seq });
      seq++;
    }
  }

  const times = positional.map((f) => idTime(f.part.id));
  const usable =
    times.every((t): t is number => t !== null) && new Set(times).size === times.length;
  if (!usable) return { flat: positional, derived: false };

  return {
    flat: positional.map((f, i) => ({ ...f, seq: times[i]! })),
    derived: true,
  };
}

function rawData(info: KiloMessageInfo, part: KiloPart): unknown {
  return { info, part };
}

function isSettledTool(part: KiloPart): boolean {
  const status = part.state?.status;
  return typeof status === "string" && SETTLED_TOOL_STATUSES.has(status);
}

function convertPart(
  info: KiloMessageInfo,
  part: KiloPart,
  seq: number,
  sessionId: string,
  baseTime: string,
  version: string,
  identity: GitUserIdentity,
  agent: ProducerAgentContext,
  parentId?: string,
): EventDraft | null {
  const type = part.type;
  if (typeof type !== "string" || !CONVERTIBLE_PART_TYPES.has(type)) return null;

  if (info.role !== "user" && info.role !== "assistant") return null;
  const role = typeof info.role === "string" ? info.role : "assistant";
  const isHuman = role === "user" && !parentId && type === "text" && part["synthetic"] !== true;

  const actor: Actor = isHuman ? { type: "human" } : { type: "agent" };
  if (role === "user" && (part["synthetic"] === true || parentId)) actor.type = "system";
  if (isHuman) {
    if (identity.email) actor.id = identity.email;
    if (identity.name) actor.display = identity.name;
  } else if (actor.type === "agent" && agent.model) {
    actor.id = agent.model;
  }

  let blocks: unknown[];
  if (type === "text") {
    if (typeof part.text !== "string") return null;
    blocks = [{ type: "text", text: part.text }];
  } else if (type === "reasoning") {
    if (typeof part.text !== "string") return null;
    blocks = [{ type: "thinking", text: part.text }];
  } else {
    if (!isSettledTool(part) || typeof part.tool !== "string" || typeof part.callID !== "string" || !part.state?.input || (part.state.status === "completed" ? typeof part.state.output !== "string" : typeof part.state.error !== "string")) return null;
    const call: Record<string, unknown> = { type: "tool_use" };
    if (typeof part.tool === "string") call["name"] = part.tool;
    if (part.state?.input !== undefined) call["input"] = part.state.input;
    if (typeof part.callID === "string") call["id"] = part.callID;
    const result: Record<string, unknown> = { type: "tool_result" };
    if (typeof part.callID === "string") result["tool_use_id"] = part.callID;
    const failed = part.state?.status === "error";
    result["content"] = failed ? (part.state?.error ?? part.state?.output) : part.state?.output;
    if (failed) result["is_error"] = true;
    if (Array.isArray(part.state?.attachments)) result["attachments"] = part.state.attachments;
    blocks = [call, result];
  }

  const content: Record<string, unknown> = { role, message_id: info.id, part_id: part.id, parent_message_id: info.parentID };
  if (info.editorContext) content["editorContext"] = info.editorContext;
  if (typeof info.agent === "string" && info.agent) content["agent"] = info.agent;
  content["blocks"] = blocks;

  const conversation = conversationFor(sessionId, parentId);
  return {
    kind: "conversation_turn",
    occurred_at: partTime(info, part, baseTime),
    actor,
    producer: { tool: "cledger", version, source: "kilo", session_id: sessionId, ...agent },
    stream: {
      id: conversation.id,
      seq,
      ...(conversation.parent ? { parent: conversation.parent } : {}),
    },
    content,
    raw: { format: RAW_FORMAT, data: rawData(info, part) },
  };
}

function conversationFor(
  sessionId: string,
  parentId: string | undefined,
): { id: string; parent?: string } {
  const id = `kilo:${sessionId}`;
  return parentId ? { id, parent: `kilo:${parentId}` } : { id };
}

function recordContext(
  occurredAt: string,
  seq: number,
  sessionId: string,
  parentId: string | undefined,
  version: string,
  agent: ProducerAgentContext,
): RecordContext {
  const conversation = conversationFor(sessionId, parentId);
  return {
    occurredAt,
    source: "kilo",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent,
  };
}

function convertRecordPart(part: KiloPart, ctx: RecordContext, info: KiloMessageInfo): EventDraft | null {
  const type = part.type;
  if (typeof type !== "string") return null;
  const valid = type === "file" ? (typeof part.url === "string" || (part.url && typeof part.url === "object" && ["attachment_text", "attachment_reference"].includes(String((part.url as any).type)))) && typeof part.mime === "string"
    : type === "agent" ? typeof part.name === "string"
    : type === "snapshot" ? typeof part.snapshot === "string"
    : type === "patch" ? typeof part.hash === "string" && Array.isArray(part.files)
    : type === "subtask" ? typeof part.prompt === "string" && typeof part.agent === "string"
    : type === "retry" ? typeof part.attempt === "number" && !!part.error
    : type === "compaction" ? typeof part.auto === "boolean"
    : type === "step-finish" ? typeof part.reason === "string" && !!part.tokens
    : type === "step-start";
  if (!valid) return null;
  const { type: _type, ...fields } = part as Record<string, unknown>;
  const raw = rawData(info, part);
  if (ACTIVITY_PART_TYPES.has(type)) return activityDraft(ctx, type, fields, raw, "agent");
  if (type === "file" || type === "agent") {
    return contextInjectionDraft(ctx, type, fields, raw, info.role === "user" ? "human" : "system");
  }
  if (type === "snapshot") {
    return recordDraft(ctx, "file_snapshot", "system", { ...fields, operation: "snapshot" }, raw);
  }
  if (type === "subtask") return activityDraft(ctx, type, liftText(fields, "prompt"), raw);
  if (type === "compaction") return recordDraft(ctx, "session_state", "system", { state_type: type, ...fields }, raw);
  if (type === "retry") return activityDraft(ctx, type, fields, raw);
  return null;
}

function preserve(
  typeKey: string,
  info: KiloMessageInfo,
  part: KiloPart,
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
  agent: ProducerAgentContext,
  parentId?: string,
): EventDraft {
  const conversation = conversationFor(sessionId, parentId);
  return unrecognizedDraft({
    typeKey,
    line: rawData(info, part),
    occurredAt,
    source: "kilo",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent: { ...agent },
  });
}

/** Provider metadata and tool inputs are intentionally opaque; native file
 * references and tool attachment variants have a closed upstream schema. */
function nestedDrift(part: KiloPart): string[] {
  const errors: string[] = [];
  const file = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const p = value as Record<string,unknown>;
    return p.type === "file" && typeof p.mime === "string" && (typeof p.url === "string" ||
      !!p.url && typeof p.url === "object" && ["attachment_text","attachment_reference"].includes(String((p.url as Record<string,unknown>).type)));
  };
  if (part.type === "tool" && part.state?.attachments !== undefined) {
    if (!Array.isArray(part.state.attachments) || part.state.attachments.some(item => !file(item))) errors.push("tool/attachments");
  }
  if (part.type === "file" && part.source !== undefined) {
    const source = part.source;
    if (!source || typeof source !== "object" || Array.isArray(source) || !["file","symbol","resource"].includes(String((source as Record<string,unknown>).type))) errors.push("file/source");
  }
  return errors;
}

export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  if (!event.raw || event.stream === undefined) return null;
  const stored = event.raw.data as { info?: KiloMessageInfo; part?: KiloPart } | null;
  if (!stored || !stored.part) return null;
  if (nestedDrift(stored.part).length) return null;
  const info = stored.info ?? {};
  const agent: ProducerAgentContext = {};
  if (event.producer.source_version) agent.source_version = event.producer.source_version;
  if (event.producer.model) agent.model = event.producer.model;
  if (event.producer.provider) agent.provider = event.producer.provider;
  const sessionId = event.producer.session_id ?? "";
  const version = packageVersion();
  const parentId = event.stream.parent?.replace(/^kilo:/, "");
  const turn = convertPart(
    info,
    stored.part,
    event.stream.seq,
    sessionId,
    event.occurred_at,
    version,
    identity,
    agent,
    parentId,
  );
  if (turn) return turn;
  return convertRecordPart(
    stored.part,
    { ...recordContext(event.occurred_at, event.stream.seq, sessionId, parentId, version, agent), identity },
    info,
  );
}

export async function captureKiloExport(
  data: KiloExport,
  cwd: string,
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");

  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };

  const sessionId = data.info?.id;
  if (typeof sessionId !== "string" || !sessionId) return result;
  const parentId =
    typeof data.info?.parentID === "string" && data.info.parentID ? data.info.parentID : undefined;

  if (typeof data.info?.directory === "string" && await realpath(data.info.directory).catch(() => data.info!.directory) !== await realpath(cwd).catch(() => cwd)) return result;
  const { flat } = flattenParts(data);
  const baseTime =
    isoFromMs(data.info?.time?.created) ?? isoFromMs(data.info?.time?.updated) ?? new Date(0).toISOString();
  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  const sessionVersion = typeof data.info?.version === "string" ? data.info.version : undefined;

  const drafts: EventDraft[] = [recordDraft(
    recordContext(baseTime, 0, sessionId, parentId, version, { ...(sessionVersion ? { source_version: sessionVersion } : {}) }),
    "session_state", "system", { state_type: "session", ...data.info }, { info: data.info },
  )];
  if (data.messages !== undefined && !Array.isArray(data.messages)) {
    countUnrecognized(result.unrecognized, "messages/invalid-shape");
    drafts.push(unrecognizedDraft({ typeKey: "messages/invalid-shape", line: data, occurredAt: baseTime,
      source: "kilo", sessionId, seq: 0, version, rawFormat: RAW_FORMAT, conversationId: `kilo:${sessionId}` }));
  }
  for (const [index, message] of (Array.isArray(data.messages) ? data.messages : []).entries()) {
    if (message && Array.isArray(message.parts) && message.parts.length) continue;
    const nativeInfo = message?.info ?? {};
    const ctx = recordContext(isoFromMs(nativeInfo.time?.created) ?? baseTime,
      idTime(nativeInfo.id) ?? index, sessionId, parentId, version, agentContext(nativeInfo, sessionVersion));
    if (message && Array.isArray(message.parts)) {
      drafts.push(recordDraft(ctx, "session_state", "system", { state_type: "message", ...nativeInfo }, message));
    } else {
      countUnrecognized(result.unrecognized, "message/invalid-shape");
      drafts.push(unrecognizedDraft({ typeKey: "message/invalid-shape", line: message, occurredAt: ctx.occurredAt,
        source: "kilo", sessionId, seq: ctx.seq, version, rawFormat: RAW_FORMAT, conversationId: ctx.conversationId,
        ...(ctx.parentConversationId ? { parentConversationId: ctx.parentConversationId } : {}) }));
    }
  }
  for (let i = 0; i < flat.length; i++) {
    const { info, part, seq } = flat[i]!;
    const type = typeof part.type === "string" ? part.type : "(untyped)";
    const agent = agentContext(part.type === "step-finish" && part.model ? { ...info, modelID: (part.model as KiloMessageInfo["model"])?.modelID ?? "", providerID: (part.model as KiloMessageInfo["model"])?.providerID ?? "" } as KiloMessageInfo : info, sessionVersion);

    for (const nested of nestedDrift(part)) {
      countUnrecognized(result.unrecognized, nested);
      drafts.push(preserve(`nested/${nested}`,info,part,partTime(info,part,baseTime),seq,sessionId,version,agent,parentId));
    }
    if (!CONVERTIBLE_PART_TYPES.has(type)) {
      const occurredAt = partTime(info, part, baseTime);
      const ctx = { ...recordContext(occurredAt, seq, sessionId, parentId, version, agent), identity };
      const record = convertRecordPart(part, ctx, info);
      if (record) {
        drafts.push(record);
        continue;
      }
      countUnrecognized(result.unrecognized, type);
      drafts.push(preserve(type, info, part, occurredAt, seq, sessionId, version, agent, parentId));
      continue;
    }

    if (type === "tool" && ["pending", "running"].includes(part.state?.status ?? "")) {
      const ctx = recordContext(partTime(info, part, baseTime), seq, sessionId, parentId, version, agent);
      drafts.push(activityDraft(ctx, "tool_pending", { ...part }, rawData(info, part), "agent"));
      continue;
    }

    const draft = convertPart(info, part, seq, sessionId, baseTime, version, identity, agent, parentId);
    if (draft) drafts.push(draft);
    else {
      const typeKey = `${type}/invalid-shape`;
      countUnrecognized(result.unrecognized, typeKey);
      drafts.push(preserve(typeKey, info, part, partTime(info, part, baseTime), seq, sessionId, version, agent, parentId));
    }
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }

  process.stderr.write(`cledger: kilo +${result.appended} events (${result.deduped} deduped)\n`);
  warnUnrecognized("kilo", result.unrecognized);
  return result;
}

function childSessionIds(data: KiloExport): string[] {
  const ids: string[] = [];
  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    if (!message || !Array.isArray(message.parts)) continue;
    for (const part of message.parts ?? []) {
      if (!part || part.type !== "tool" || part.tool !== "task") continue;
      const metadata = (part.state as { metadata?: { sessionId?: unknown } } | undefined)?.metadata;
      const id = metadata?.sessionId;
      if (typeof id === "string" && id && id !== data.info?.id) ids.push(id);
    }
  }
  return ids;
}

export async function captureKiloSession(
  sessionId: string,
  cwd: string,
  visited: Set<string> = new Set(),
): Promise<CaptureResult> {
  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  if (visited.has(sessionId)) return result;
  visited.add(sessionId);

  const data = await exportKiloSession(sessionId, cwd);
  if (!data) return result;
  mergeCaptureResult(result, await captureKiloExport(data, cwd));
  for (const child of childSessionIds(data)) {
    mergeCaptureResult(result, await captureKiloSession(child, cwd, visited));
  }
  return result;
}

export async function captureKiloExportFile(
  path: string,
  cwd: string,
): Promise<CaptureResult> {
  const raw = await readFile(path, "utf8");
  return captureKiloExport(JSON.parse(raw) as KiloExport, cwd);
}

export async function captureKiloAll(
  cwd: string,
  limit?: number,
): Promise<CaptureResult> {
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const sessions = await listKiloSessions(cwd);
  const ordered = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const selected = typeof limit === "number" ? ordered.slice(0, limit) : ordered;
  const visited = new Set<string>();
  for (const session of selected) {
    if (typeof session.id !== "string" || !session.id) continue;
    if (session.directory && await realpath(session.directory).catch(() => session.directory) !== await realpath(cwd).catch(() => cwd)) continue;
    mergeCaptureResult(total, await captureKiloSession(session.id, cwd, visited));
  }
  return total;
}

export async function runKiloHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as KiloHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    if (payload.session_id) {
      await captureKiloSession(payload.session_id, cwd);
      return;
    }
    process.stderr.write(
      "cledger: kilo hook warning: session.idle provided no session id; " +
        "falling back to the project's most recently updated session\n",
    );
    await captureKiloAll(cwd, 1);
  } catch (err) {
    process.stderr.write(
      `cledger: kilo hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
