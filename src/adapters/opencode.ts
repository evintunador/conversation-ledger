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
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion, readCursor, writeCursor } from "./common.js";
import {
  countUnrecognized,
  mergeCaptureResult,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";
import { activityDraft, type RecordContext } from "./records.js";

const RAW_FORMAT = "opencode-export-json/1";

const CURSOR_FIELD = "parts";

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
 * Part types recorded as `activity` rather than as turns.
 *
 * `step-start` and `step-finish` carry no prose, which is why they were once
 * dropped, but they carry the two things nothing else in the export does: the
 * git snapshot hash opencode took at each step boundary, and the token counts,
 * cost, and finish reason for the step. The snapshot hash in particular is a
 * real handle on intermediate repository state — the closest opencode analogue
 * to Claude Code's file history.
 *
 * `patch` points into opencode's private snapshot store, and the diff it names
 * is usually already in git. It is recorded anyway, for the same reason the
 * file-history pointers are: "usually already in git" is not "always", and a
 * pointer with provenance beats a hole.
 *
 * Part types opencode's binary references but no session on hand exercises —
 * `file`, `agent`, `snapshot`, `todo` — are still left off every list here.
 * Guessing at their shape would discard content on the first session that used
 * one; leaving them out routes them through the drift path, which preserves
 * them raw, warns, and lets `cledger renormalize` upgrade them later.
 */
const ACTIVITY_PART_TYPES = new Set(["step-start", "step-finish", "patch"]);

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
  /** `step-start`/`step-finish`: opencode's git snapshot hash at the boundary. */
  snapshot?: string;
  /** `step-finish`: why the step ended, e.g. "tool-calls" / "stop". */
  reason?: string;
  /** `step-finish`: token accounting for the step. */
  tokens?: Record<string, unknown>;
  cost?: number;
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

/**
 * The timestamp opencode buries in a part id, or null if this id is not one of
 * opencode's own.
 *
 * opencode mints ids as `prt_` + 12 hex + 14 random base62, where the hex is a
 * 48-bit `Date.now() * 4096 + per-millisecond counter` (its `Identifier`
 * scheme — ULID-shaped, though not a ULID). That prefix is monotonic in
 * creation order, which is the property this adapter needs and the positional
 * index does not have. Verified against a live opencode 1.18.10 store: 859
 * parts, zero ordering violations within any session.
 *
 * The 48-bit field wraps every 2^36 ms (~2.18 years), so lexicographic order
 * is guaranteed only within an epoch. A single session never spans a wrap, and
 * `seq` is only ever compared within one conversation, so that bound does not
 * bite. The value is ~6.7e10 — comfortably inside a safe integer, which
 * matters because `seq` is hashed into event identity and must round-trip
 * exactly.
 */
function idTime(id: unknown): number | null {
  if (typeof id !== "string") return null;
  const match = id.match(/^prt_([0-9a-f]{12})/);
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Flatten messages into parts, numbering each one.
 *
 * **`seq` comes from the part's own id when it can, and from export order when
 * it cannot** — and the choice is made once for the whole session, never per
 * part, so one session's numbers are always on one scale.
 *
 * The positional index was the original scheme and is wrong for a *mutable*
 * store. opencode keeps sessions in SQLite, where `session revert`,
 * `message.removed` and `part.removed` delete parts out of the middle. Every
 * part after the hole then shifts down, and because `seq` is part of event
 * identity, the shifted parts re-capture under new ids — duplicates in the
 * ledger for content that never changed. Deriving `seq` from the id makes it a
 * property of the part rather than of its neighbours, so a deletion renumbers
 * nothing and a rescan dedups.
 *
 * The fallback is not hypothetical: ids not minted by opencode exist in the
 * wild (test harnesses and other tooling write their own), and a session
 * mixing a 48-bit timestamp with a small integer would sort into nonsense.
 * Requiring *every* part to parse before switching keeps each session
 * internally consistent, and leaves such a session behaving exactly as it did
 * before this change.
 */
function flattenParts(data: OpencodeExport): { flat: FlatPart[]; derived: boolean } {
  const positional: FlatPart[] = [];
  let seq = 0;
  for (const message of data.messages ?? []) {
    const info = message.info ?? {};
    for (const part of message.parts ?? []) {
      positional.push({ info, part, seq });
      seq++;
    }
  }

  const times = positional.map((f) => idTime(f.part.id));
  // Distinct as well as present: two parts sharing a seq would collide in the
  // identity hash, which is worse than numbering by position.
  const usable =
    times.every((t): t is number => t !== null) && new Set(times).size === times.length;
  if (!usable) return { flat: positional, derived: false };

  return {
    flat: positional.map((f, i) => ({ ...f, seq: times[i]! })),
    derived: true,
  };
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
  parentId?: string,
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

  const conversation = conversationFor(sessionId, parentId);
  return {
    kind: "conversation_turn",
    occurred_at: partTime(info, part, baseTime),
    actor,
    producer: { tool: "cledger", version, source: "opencode", session_id: sessionId, ...agent },
    conversation: {
      id: conversation.id,
      seq,
      ...(conversation.parent ? { parent: conversation.parent } : {}),
    },
    content,
    raw: { format: RAW_FORMAT, data: rawData(info, part) },
  };
}

/**
 * Which conversation a session's parts belong to. opencode gives a subagent
 * its own session id, so a subagent session is already its own conversation —
 * all it was missing is the pointer back to the session that spawned it, and
 * a capture path that did not return early on sight of `parentID`.
 */
function conversationFor(
  sessionId: string,
  parentId: string | undefined,
): { id: string; parent?: string } {
  const id = `opencode:${sessionId}`;
  return parentId ? { id, parent: `opencode:${parentId}` } : { id };
}

/**
 * The `RecordContext` a non-turn part converts under. Shared by the capture
 * loop and the re-normalization hook so both mint the same event identity.
 */
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
    source: "opencode",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent,
  };
}

/**
 * Convert a part that is not a turn into the record it deserves, or null when
 * the part type is unknown (the caller routes it to the drift path).
 *
 * The actor is `agent`: a step boundary or a patch is the model's own work
 * being recorded, not the harness reporting on itself.
 */
function convertRecordPart(part: OpencodePart, ctx: RecordContext, info: OpencodeMessageInfo): EventDraft | null {
  const type = part.type;
  if (typeof type !== "string" || !ACTIVITY_PART_TYPES.has(type)) return null;
  const { type: _type, ...fields } = part as Record<string, unknown>;
  return activityDraft(ctx, type, fields, rawData(info, part), "agent");
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
  parentId?: string,
): EventDraft {
  const conversation = conversationFor(sessionId, parentId);
  return unrecognizedDraft({
    typeKey,
    line: rawData(info, part),
    occurredAt,
    source: "opencode",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
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
  const sessionId = event.producer.session_id ?? "";
  const version = packageVersion();
  // The parent session id is not in `raw.data` — it lives on the session
  // export, which this path cannot see. It is read back off the preserved
  // event's own `conversation.parent`, where the capture that preserved the
  // part recorded it, and stripped of its `opencode:` namespace so
  // `conversationFor` re-derives the identical ref.
  const parentId = event.conversation.parent?.replace(/^opencode:/, "");
  const turn = convertPart(
    info,
    stored.part,
    event.conversation.seq,
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
    recordContext(event.occurred_at, event.conversation.seq, sessionId, parentId, version, agent),
    info,
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

  // Subagent sessions are captured, as their own conversation pointing back
  // at the parent (see `conversationFor`). They used to be skipped for want of
  // a way to express that relation; `ConversationRef.parent` is that way. What
  // was being lost was every internal step of every subagent — the parent's
  // `task` tool part keeps only the child's final answer, so the reasoning
  // that produced it, and every tool call behind it, went unrecorded.
  const parentId =
    typeof data.info?.parentID === "string" && data.info.parentID ? data.info.parentID : undefined;

  const { flat, derived } = flattenParts(data);
  let cursor = (await readCursor(repo, sessionId, CURSOR_FIELD))?.count ?? 0;
  // Under the positional scheme the cursor is a part *count*, so a session
  // shorter than it means parts were removed (a revert, a deleted message):
  // rescan from the start and let identical events dedup. Under the derived
  // scheme the cursor is the highest `seq` already captured, and a deletion
  // renumbers nothing, so there is no shrink to detect and nothing to reset —
  // the surviving parts simply keep the seqs they always had.
  if (!derived && cursor > flat.length) cursor = 0;

  const baseTime =
    isoFromMs(data.info?.time?.created) ?? isoFromMs(data.info?.time?.updated) ?? new Date().toISOString();
  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  const sessionVersion = typeof data.info?.version === "string" ? data.info.version : undefined;

  /**
   * Where the cursor stops, in whichever unit this session is using: a count
   * of parts consumed under the positional scheme, the highest `seq` captured
   * under the derived one. An unsettled tool call holds it back so the
   * finished part is seen again next time; parts after it still convert now
   * and simply dedup on the rescan.
   *
   * The derived form is what makes the cursor survive a mid-session deletion.
   * A count only notices parts going away when the session gets *shorter*, so
   * a revert offset by new parts left the count looking healthy while pointing
   * at the wrong place. A high-water mark over ids has nothing to be offset
   * by.
   */
  let nextCursor = derived ? cursor : flat.length;
  let hold: number | null = null;

  const drafts: EventDraft[] = [];
  for (let i = 0; i < flat.length; i++) {
    const { info, part, seq } = flat[i]!;
    // Both schemes ask the same question — "is this past where I stopped?" —
    // of the number the scheme uses.
    if (derived ? seq <= cursor : i < cursor) continue;
    if (derived) nextCursor = Math.max(nextCursor, seq);
    const type = typeof part.type === "string" ? part.type : "(untyped)";
    const agent = agentContext(info, sessionVersion);

    if (!CONVERTIBLE_PART_TYPES.has(type)) {
      const occurredAt = partTime(info, part, baseTime);
      const ctx = recordContext(occurredAt, seq, sessionId, parentId, version, agent);
      const record = convertRecordPart(part, ctx, info);
      if (record) {
        drafts.push(record);
        continue;
      }
      countUnrecognized(result.unrecognized, type);
      drafts.push(preserve(type, info, part, occurredAt, seq, sessionId, version, agent, parentId));
      continue;
    }

    if (type === "tool" && !isSettledTool(part)) {
      // Hold at the earliest unsettled part. Under the derived scheme the
      // cursor is an exclusive lower bound, so it must land strictly below
      // this part's seq for the next capture to see it again; seqs are not
      // contiguous, which is exactly why `seq - 1` is safe to use as that
      // bound rather than as a neighbour's number.
      hold = hold === null ? seq : Math.min(hold, seq);
      if (!derived) nextCursor = Math.min(nextCursor, i);
      continue;
    }

    const draft = convertPart(info, part, seq, sessionId, baseTime, version, identity, agent, parentId);
    if (draft) drafts.push(draft);
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  if (derived && hold !== null) nextCursor = Math.min(nextCursor, hold - 1);
  await writeCursor(repo, sessionId, CURSOR_FIELD, nextCursor);
  process.stderr.write(`cledger: opencode +${result.appended} events (${result.deduped} deduped)\n`);
  warnUnrecognized("opencode", result.unrecognized);
  return result;
}

/**
 * The subagent sessions a session spawned, read off its own `task` tool
 * parts: opencode records the child's session id in the part's
 * `state.metadata.sessionId`.
 *
 * This is how subagent conversations are found at all. `opencode session list`
 * returns only top-level sessions, so a child is reachable only from the
 * parent that spawned it — which means a capture that stopped at the parent
 * could never have found them, no matter how the ledger modelled the relation.
 */
function childSessionIds(data: OpencodeExport): string[] {
  const ids: string[] = [];
  for (const message of data.messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool" || part.tool !== "task") continue;
      const metadata = (part.state as { metadata?: { sessionId?: unknown } } | undefined)?.metadata;
      const id = metadata?.sessionId;
      if (typeof id === "string" && id && id !== data.info?.id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Export one session via the opencode CLI, then capture it — and every
 * subagent session it spawned, depth-first.
 *
 * `visited` guards the recursion. opencode's task metadata is not guaranteed
 * acyclic by anything the ledger can see, and an export that named its own
 * ancestor would otherwise loop forever inside a capture hook.
 */
export async function captureOpencodeSession(
  sessionId: string,
  cwd: string,
  visited: Set<string> = new Set(),
): Promise<CaptureResult> {
  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  if (visited.has(sessionId)) return result;
  visited.add(sessionId);

  const data = await exportOpencodeSession(sessionId, cwd);
  if (!data) return result;
  mergeCaptureResult(result, await captureOpencodeExport(data, cwd));
  for (const child of childSessionIds(data)) {
    mergeCaptureResult(result, await captureOpencodeSession(child, cwd, visited));
  }
  return result;
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
  // One `visited` set across the sweep: two top-level sessions can name the
  // same subagent session, and it should be exported once.
  const visited = new Set<string>();
  for (const session of selected) {
    if (typeof session.id !== "string" || !session.id) continue;
    mergeCaptureResult(total, await captureOpencodeSession(session.id, cwd, visited));
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
