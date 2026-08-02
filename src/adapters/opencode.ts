/**
 * opencode adapter.
 *
 * Unlike claude-code and codex, opencode has no append-only transcript file:
 * sessions live in a mutable SQLite database at
 * `~/.local/share/opencode/opencode.db`. Rather than read that database, this
 * adapter shells out to opencode's own `opencode export <sessionID>`, which
 * emits `{info, messages: [{info, parts}]}` JSON. Three reasons:
 *
 *  1. cledger ships with no runtime dependencies and supports Node >= 20;
 *     `node:sqlite` would force both to change.
 *  2. opencode's schema is visibly mid-migration (an empty `session_message`
 *     table sits alongside the populated `message`/`part` tables it is
 *     evidently meant to replace). The export shape is the interface opencode
 *     documents; the tables are not.
 *  3. The same database holds `credential.value` and `account.access_token`.
 *     Reading conversations should not require opening the file that stores
 *     the user's API tokens.
 *
 * `--sanitize` is deliberately *not* passed to the export: cledger has its
 * own redaction stack, and letting opencode rewrite content would make event
 * ids depend on opencode's version.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import {
  countUnrecognized,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";

const RAW_FORMAT = "opencode-export-json/1";

/**
 * Part types carrying visible conversation content.
 *
 * `reasoning` belongs here, and that is a real difference from codex: codex's
 * reasoning items are provider-encrypted (`encrypted_content`) and can only
 * ever be preserved opaquely as `reasoning`-kind events, whereas opencode
 * stores reasoning as plain `text`. So it converts to an ordinary
 * `thinking` block inside a `conversation_turn`, exactly as claude-code's
 * thinking blocks do — no opacity marker, nothing withheld.
 */
const CONVERTIBLE_PART_TYPES = new Set(["text", "reasoning", "tool"]);

/**
 * Part types deliberately not captured: per-step bookkeeping (`step-start` /
 * `step-finish` carry token counts and finish reasons, not content) and
 * `patch`, which is a content hash plus file list pointing into opencode's
 * private snapshot store — meaningless outside opencode, and the diff it
 * refers to is already in git.
 *
 * Kept deliberately short. opencode's binary also references `file`, `agent`,
 * `snapshot` and `todo` part types that no session on hand exercises; listing
 * them here on speculation would silently discard content on the first
 * session that used one. Leaving them out routes them through the drift path
 * instead — preserved raw-only, warned about, and upgradeable later by
 * `cledger renormalize`, which is exactly what that machinery is for.
 */
const KNOWN_SKIPPED_PART_TYPES = new Set(["step-start", "step-finish", "patch"]);

/**
 * Tool-call states that will never change again. A `pending`/`running` part
 * is still being written; capturing it would bake a half-finished tool call
 * into an immutable event id. The capture loop skips unsettled parts *and*
 * holds the cursor back at the first one, so the finished version is picked
 * up on the next capture rather than being skipped forever.
 */
const SETTLED_TOOL_STATUSES = new Set(["completed", "error"]);

/** Payload the installed opencode plugin sends on stdin (see install.ts). */
interface OpencodeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface OpencodeSessionInfo {
  id?: string;
  /** Set on subagent sessions; those are skipped (see captureOpencodeExport). */
  parentID?: string;
  directory?: string;
  title?: string;
  /** opencode's own CLI version, e.g. "1.18.5". */
  version?: string;
  time?: { created?: number; updated?: number };
}

interface OpencodeMessageInfo {
  id?: string;
  sessionID?: string;
  role?: string;
  /** Agent persona, e.g. "build" / "plan". */
  agent?: string;
  mode?: string;
  /** Assistant messages state the model flat; user messages nest it. */
  modelID?: string;
  providerID?: string;
  model?: { modelID?: string; providerID?: string };
  time?: { created?: number; completed?: number };
}

interface OpencodePart {
  id?: string;
  type?: string;
  messageID?: string;
  sessionID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: number; end?: number };
  };
  time?: { start?: number; end?: number };
}

interface OpencodeMessage {
  info?: OpencodeMessageInfo;
  parts?: OpencodePart[];
}

export interface OpencodeExport {
  info?: OpencodeSessionInfo;
  messages?: OpencodeMessage[];
}

/** What `opencode session list --format json` returns, per row. */
interface OpencodeSessionRow {
  id?: string;
  title?: string;
  directory?: string;
  updated?: number;
}

/** One part, paired with the message that owns it and its session position. */
interface FlatPart {
  info: OpencodeMessageInfo;
  part: OpencodePart;
  seq: number;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function cursorPath(repo: RepoInfo, sessionId: string): string {
  return join(repo.commonDir, "conversation-ledger", "cursors", `${sanitizeId(sessionId)}.json`);
}

async function readCursor(repo: RepoInfo, sessionId: string): Promise<number> {
  try {
    const raw = await readFile(cursorPath(repo, sessionId), "utf8");
    const data = JSON.parse(raw) as { parts?: number };
    return typeof data.parts === "number" ? data.parts : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(repo: RepoInfo, sessionId: string, parts: number): Promise<void> {
  const path = cursorPath(repo, sessionId);
  await mkdir(join(repo.commonDir, "conversation-ledger", "cursors"), { recursive: true });
  await writeFile(path, JSON.stringify({ parts }) + "\n");
}

/** opencode stores times as epoch milliseconds; the ledger wants ISO 8601. */
function isoFromMs(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Run an opencode subcommand and return its stdout.
 *
 * The child's stdout goes to a temp *file*, never a pipe. opencode (a Bun
 * binary) exits without draining a piped stdout, so anything past ~64KB is
 * silently lost — a large session's export still parses as JSON right up to
 * the truncation point in some cases, which would quietly capture a partial
 * conversation. Writing to a real file descriptor returns the full output.
 *
 * Returns null when opencode is not installed or the command fails; every
 * caller treats that as "nothing to capture" rather than an error, so a
 * missing opencode never breaks a hook.
 */
async function runOpencode(args: string[], cwd: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "cledger-opencode-"));
  const path = join(dir, "out.json");
  try {
    const handle = await open(path, "w");
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("opencode", args, {
          cwd,
          stdio: ["ignore", handle.fd, "ignore"],
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
      if (code !== 0) return null;
    } finally {
      await handle.close();
    }
    return await readFile(path, "utf8");
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Export one session as JSON. `--pure` skips external plugins, which matters
 * because the capture this call belongs to was very likely triggered *by* an
 * opencode plugin — loading that plugin again inside the export would invite
 * re-entrancy.
 */
export async function exportOpencodeSession(
  sessionId: string,
  cwd: string,
): Promise<OpencodeExport | null> {
  const stdout = await runOpencode(["export", "--pure", sessionId], cwd);
  if (!stdout) return null;
  try {
    return JSON.parse(stdout) as OpencodeExport;
  } catch {
    return null;
  }
}

/**
 * List opencode sessions. opencode scopes this to the project containing
 * `cwd`, which is exactly the scoping a repo-local capture wants — a sweep
 * never reaches into conversations that belong to other checkouts.
 */
export async function listOpencodeSessions(cwd: string): Promise<OpencodeSessionRow[]> {
  const stdout = await runOpencode(["session", "list", "--pure", "--format", "json"], cwd);
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as OpencodeSessionRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * The agent facts a message states about itself. opencode labels every
 * message with its model and provider — including *user* messages, which
 * carry the model selected to answer them. That is a genuine difference from
 * claude-code, where a user line states no model and none is invented; here
 * the source does state it, so it is recorded, per `Producer.model`'s rule of
 * "set only when the source states it for this turn".
 *
 * `providerID` is opencode's *config* provider key (e.g. "ds4", "local-mlx"),
 * which the user names themselves rather than a canonical vendor name. It is
 * passed through verbatim anyway — the schema asks for the provider as the
 * source names it, and rewriting it would be interpretation.
 */
function agentContext(info: OpencodeMessageInfo, sessionVersion?: string): ProducerAgentContext {
  const agent: ProducerAgentContext = {};
  if (sessionVersion) agent.source_version = sessionVersion;
  const model = info.modelID ?? info.model?.modelID;
  if (typeof model === "string" && model) agent.model = model;
  const provider = info.providerID ?? info.model?.providerID;
  if (typeof provider === "string" && provider) agent.provider = provider;
  return agent;
}

/**
 * When this part happened: its own start time, else the message's creation
 * time, else the session base time. Every step is a pure function of the
 * export, so rescans and re-normalization land on the same value — which
 * matters because `occurred_at` is part of event identity.
 */
function partTime(info: OpencodeMessageInfo, part: OpencodePart, baseTime: string): string {
  return (
    isoFromMs(part.time?.start) ??
    isoFromMs(part.state?.time?.start) ??
    isoFromMs(info.time?.created) ??
    baseTime
  );
}

/** Flatten messages into parts, numbering every part in export order. */
function flattenParts(data: OpencodeExport): FlatPart[] {
  const flat: FlatPart[] = [];
  let seq = 0;
  for (const message of data.messages ?? []) {
    const info = message.info ?? {};
    for (const part of message.parts ?? []) {
      flat.push({ info, part, seq });
      seq++;
    }
  }
  return flat;
}

/**
 * `raw.data` for one part. The part alone would be lossy: it carries ids but
 * no role, model, or timing for the message that owns it, so an exported
 * event could not be replayed without the rest of the session. Pairing it
 * with its message info keeps every event independently lossless, at the cost
 * of repeating a small object across the parts of one message.
 */
function rawData(info: OpencodeMessageInfo, part: OpencodePart): unknown {
  return { info, part };
}

/**
 * True when a part carries nothing a reader would see. Empty text and
 * reasoning parts do occur (a step that produced only a tool call, say), and
 * emitting an event whose only block is an empty string adds a line to
 * `cledger log` that says nothing.
 */
function isEmptyText(part: OpencodePart): boolean {
  return typeof part.text !== "string" || part.text.trim() === "";
}

/** Whether a tool part has reached a state that will not change again. */
function isSettledTool(part: OpencodePart): boolean {
  const status = part.state?.status;
  return typeof status === "string" && SETTLED_TOOL_STATUSES.has(status);
}

function convertPart(
  info: OpencodeMessageInfo,
  part: OpencodePart,
  seq: number,
  sessionId: string,
  baseTime: string,
  version: string,
  identity: GitUserIdentity,
  agent: ProducerAgentContext,
): EventDraft | null {
  const type = part.type;
  if (typeof type !== "string" || !CONVERTIBLE_PART_TYPES.has(type)) return null;

  const role = typeof info.role === "string" ? info.role : "assistant";
  const isHuman = role === "user" && type === "text";

  const actor: Actor = isHuman ? { type: "human" } : { type: "agent" };
  if (isHuman) {
    if (identity.email) actor.id = identity.email;
    if (identity.name) actor.display = identity.name;
  } else if (agent.model) {
    actor.id = agent.model;
  }

  let blocks: unknown[];
  if (type === "text") {
    if (isEmptyText(part)) return null;
    blocks = [{ type: "text", text: part.text }];
  } else if (type === "reasoning") {
    if (isEmptyText(part)) return null;
    blocks = [{ type: "thinking", text: part.text }];
  } else {
    // tool: opencode keeps the call and its result on one part, so both
    // blocks belong to one event. The actor stays `agent` rather than the
    // `system` other adapters give a standalone tool result — opencode does
    // not model the result as a separate speaker, and splitting it here
    // would be inventing structure the source does not have.
    if (!isSettledTool(part)) return null;
    const call: Record<string, unknown> = { type: "tool_use" };
    if (typeof part.tool === "string") call["name"] = part.tool;
    if (part.state?.input !== undefined) call["input"] = part.state.input;
    if (typeof part.callID === "string") call["id"] = part.callID;
    const result: Record<string, unknown> = { type: "tool_result" };
    if (typeof part.callID === "string") result["tool_use_id"] = part.callID;
    const failed = part.state?.status === "error";
    result["content"] = failed ? (part.state?.error ?? part.state?.output) : part.state?.output;
    if (failed) result["is_error"] = true;
    blocks = [call, result];
  }

  const content: Record<string, unknown> = { role };
  // opencode's agent persona ("build", "plan", ...) has no home in `Producer`,
  // which describes the model and the capture tool, not which persona the
  // user was driving. It goes in `content` next to `role`, the way codex's
  // agent_message author/recipient do.
  if (typeof info.agent === "string" && info.agent) content["agent"] = info.agent;
  content["blocks"] = blocks;

  return {
    kind: "conversation_turn",
    occurred_at: partTime(info, part, baseTime),
    actor,
    producer: { tool: "cledger", version, source: "opencode", session_id: sessionId, ...agent },
    conversation: { id: `opencode:${sessionId}`, seq },
    content,
    raw: { format: RAW_FORMAT, data: rawData(info, part) },
  };
}

/** Raw-only preservation event for an unrecognized opencode part (see drift.ts). */
function preserve(
  typeKey: string,
  info: OpencodeMessageInfo,
  part: OpencodePart,
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
  agent: ProducerAgentContext,
): EventDraft {
  return unrecognizedDraft({
    typeKey,
    line: rawData(info, part),
    occurredAt,
    source: "opencode",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: `opencode:${sessionId}`,
    agent: { ...agent },
  });
}

/**
 * Re-normalization hook (see renormalize.ts): turn a preserved `unrecognized`
 * event back into the `conversation_turn` a live capture would now produce.
 *
 * Id fidelity works the same way as in the claude-code and codex twins, and
 * the `{info, part}` shape stored in `raw.data` is what makes it possible
 * here: the message info a part needs for its role, model and time fallback
 * travels with the part instead of living in a session header this path can
 * no longer see. `baseTime` falls back to the preserved event's own
 * `occurred_at`, which is the value the preservation path computed — so a
 * part with no time of its own reconstructs to the same instant, and
 * therefore the same id.
 */
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  if (!event.raw || event.conversation === undefined) return null;
  const stored = event.raw.data as { info?: OpencodeMessageInfo; part?: OpencodePart } | null;
  if (!stored || !stored.part) return null;
  const info = stored.info ?? {};
  const agent: ProducerAgentContext = {};
  if (event.producer.source_version) agent.source_version = event.producer.source_version;
  if (event.producer.model) agent.model = event.producer.model;
  if (event.producer.provider) agent.provider = event.producer.provider;
  return convertPart(
    info,
    stored.part,
    event.conversation.seq,
    event.producer.session_id ?? "",
    event.occurred_at,
    packageVersion(),
    identity,
    agent,
  );
}

/**
 * Capture a session from an already-parsed export. Split out from the
 * subprocess plumbing so tests (and offline backfill from a saved export
 * file) exercise the conversion without needing opencode installed.
 */
export async function captureOpencodeExport(
  data: OpencodeExport,
  cwd: string,
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");

  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };

  const sessionId = data.info?.id;
  if (typeof sessionId !== "string" || !sessionId) return result;

  // Subagent sessions are skipped, matching claude-code's treatment of
  // sidechain lines: the parent's `task` tool part already stores the child's
  // final output, so only the subagent's internal steps are missed. Capturing
  // them properly needs a way to express the parent/child relation, which is
  // a cross-adapter schema question rather than an opencode one.
  if (typeof data.info?.parentID === "string" && data.info.parentID) return result;

  const flat = flattenParts(data);
  let cursor = await readCursor(repo, sessionId);
  // A session shorter than the cursor means parts were removed (a revert, or
  // a deleted message). Rescan from the start; identical events dedup.
  if (cursor > flat.length) cursor = 0;

  const baseTime =
    isoFromMs(data.info?.time?.created) ?? isoFromMs(data.info?.time?.updated) ?? new Date().toISOString();
  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  const sessionVersion = typeof data.info?.version === "string" ? data.info.version : undefined;

  // Where the cursor stops. An unsettled tool call holds it back so the
  // finished part is seen again next time; parts after it still convert now
  // and simply dedup on the rescan.
  let nextCursor = flat.length;

  const drafts: EventDraft[] = [];
  for (let i = cursor; i < flat.length; i++) {
    const { info, part, seq } = flat[i]!;
    const type = typeof part.type === "string" ? part.type : "(untyped)";
    const agent = agentContext(info, sessionVersion);

    if (!CONVERTIBLE_PART_TYPES.has(type)) {
      if (!KNOWN_SKIPPED_PART_TYPES.has(type)) {
        countUnrecognized(result.unrecognized, type);
        const occurredAt = partTime(info, part, baseTime);
        drafts.push(preserve(type, info, part, occurredAt, seq, sessionId, version, agent));
      }
      continue;
    }

    if (type === "tool" && !isSettledTool(part)) {
      nextCursor = Math.min(nextCursor, i);
      continue;
    }

    const draft = convertPart(info, part, seq, sessionId, baseTime, version, identity, agent);
    if (draft) drafts.push(draft);
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  await writeCursor(repo, sessionId, nextCursor);
  process.stderr.write(`cledger: opencode +${result.appended} events (${result.deduped} deduped)\n`);
  warnUnrecognized("opencode", result.unrecognized);
  return result;
}

/** Export one session via the opencode CLI, then capture it. */
export async function captureOpencodeSession(
  sessionId: string,
  cwd: string,
): Promise<CaptureResult> {
  const data = await exportOpencodeSession(sessionId, cwd);
  if (!data) return { appended: 0, deduped: 0, unrecognized: {} };
  return captureOpencodeExport(data, cwd);
}

/** Capture a session from a saved `opencode export` JSON file (backfill). */
export async function captureOpencodeExportFile(
  path: string,
  cwd: string,
): Promise<CaptureResult> {
  const raw = await readFile(path, "utf8");
  return captureOpencodeExport(JSON.parse(raw) as OpencodeExport, cwd);
}

/**
 * Capture every session opencode associates with `cwd`'s project. Used by
 * `cledger capture opencode --all`, and as the hook's fallback when the
 * plugin could not tell us which session went idle.
 */
export async function captureOpencodeAll(
  cwd: string,
  limit?: number,
): Promise<CaptureResult> {
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const sessions = await listOpencodeSessions(cwd);
  const ordered = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const selected = typeof limit === "number" ? ordered.slice(0, limit) : ordered;
  for (const session of selected) {
    if (typeof session.id !== "string" || !session.id) continue;
    const one = await captureOpencodeSession(session.id, cwd);
    total.appended += one.appended;
    total.deduped += one.deduped;
    for (const [key, count] of Object.entries(one.unrecognized)) {
      total.unrecognized[key] = (total.unrecognized[key] ?? 0) + count;
    }
  }
  return total;
}

/**
 * Hook entrypoint, invoked by the plugin `cledger install opencode` writes.
 *
 * `session_id` is optional on purpose. The plugin reads it out of opencode's
 * `session.idle` event, whose exact payload shape is not something cledger
 * can pin down across opencode versions; when it is missing, capture falls
 * back to the most recently updated session for this project, which is the
 * session that just went idle in every realistic case.
 */
export async function runOpencodeHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as OpencodeHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    if (payload.session_id) {
      await captureOpencodeSession(payload.session_id, cwd);
      return;
    }
    await captureOpencodeAll(cwd, 1);
  } catch (err) {
    process.stderr.write(
      `cledger: opencode hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
