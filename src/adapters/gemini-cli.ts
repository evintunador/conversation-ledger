/**
 * Gemini CLI adapter.
 *
 * Gemini CLI records a session to
 * `~/.gemini/tmp/<project>/chats/session-<ts>-<id>.jsonl`, and the hook
 * payload hands us that path directly. The file is append-only on disk but it
 * is *not* a transcript: it is a write-ahead log of mutations to a single
 * conversation document, and a line's meaning depends on every line before
 * it. Four record forms exist, discriminated exactly as Gemini CLI's own
 * `loadConversationRecord` discriminates them, and in this precedence order:
 *
 *  1. `{"$rewindTo": "<message id>"}` — the user rewound; that message and
 *     every message after it leave the document. An unknown id clears it.
 *  2. a bare message object (identified by a string `id`) — upsert by id.
 *     Re-appending an existing id *replaces* it, which is how a model turn
 *     grows its `toolCalls` as tools run.
 *  3. `{"$set": {...}}` — metadata patch. When it carries a `messages` array
 *     it replaces the entire message list.
 *  4. the header (`sessionId` + `projectHash`), which may itself carry a
 *     `messages` array.
 *
 * Three consequences drive this adapter's design.
 *
 * **Deletions are not honoured.** Replaying the log the way Gemini CLI does —
 * applying every removal — reconstructs what the CLI would *resume*, which is
 * not the same thing as what happened. Verified on a real session: after a
 * failed API call Gemini rewrote the document with a `$set.messages` snapshot
 * that silently dropped the prompt the user had just typed, so a faithful
 * replay captures no record of it having been asked. The ledger records
 * evidence, and the human did type it. So capture takes the *union* of every
 * message the file ever contained, each at its last-written value, and treats
 * `$rewindTo` and snapshot truncation as facts about Gemini's live view
 * rather than instructions to forget. Each removal is recorded in its own
 * right as an `activity` naming the ids it withdrew — `rewind` for an explicit
 * `$rewindTo`, `snapshot_drop` for a `$set.messages` snapshot that quietly
 * omitted what the document used to hold. Both matter: a consumer
 * reconstructing intent needs to know a turn was withdrawn, not just that it
 * exists, and the snapshot is the path the real incident above took.
 *
 * **Ordering key.** `seq` is the index of the log record a thing was first
 * seen at, counted in file order across messages *and* the mutation records
 * between them, so both share one number space and neither can collide with
 * the other. A message keeps the number it was first sighted under, so a
 * rewind cannot renumber later turns — the positional-`seq` churn the
 * opencode adapter documents and accepts does not arise here.
 *
 * **Settledness.** Because re-appending an id replaces the message, a model
 * turn is mutable while its tools run: capturing it early would freeze a
 * half-finished tool call into an immutable event id. A message whose
 * `toolCalls` contain one that has neither a result nor a terminal status is
 * therefore withheld, and holds the cursor back so the finished version is
 * picked up next time.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion, readCursor, writeCursor } from "./common.js";
import { convertParts, ensurePartArray, isEmptyParts } from "./genai-parts.js";
import {
  countUnrecognized,
  mergeCaptureResult,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";
import {
  activityDraft,
  liftText,
  recordDraft,
  sessionStateDraft,
  type RecordContext,
} from "./records.js";

const RAW_FORMAT = "gemini-cli-chatlog/1";

const CURSOR_FIELD = "messages";

/** Message types carrying a turn someone took. */
const CONVERTIBLE_MESSAGE_TYPES = new Set(["user", "gemini"]);

/**
 * Message types Gemini writes for transient UI notices. They are recorded as
 * `conversation_turn`s spoken by `system` when they carry text, on the same
 * reasoning the claude-code adapter applies to its text-bearing `system`
 * lines: the user read them, so they are part of the conversation even though
 * no participant composed them. A notice with no text becomes an `activity`.
 *
 * Gemini's own history assembly discards these outright. That is right for
 * resuming a chat and wrong for a ledger — "quota exceeded" is often the only
 * explanation for why a turn looks abandoned.
 */
const NOTICE_MESSAGE_TYPES = new Set(["info", "error", "warning"]);

/**
 * Tool-call states that will never change again. A call with a `result` is
 * settled whatever its status says; one with neither is still running.
 */
const SETTLED_TOOL_STATUSES = new Set(["success", "error", "cancelled", "canceled"]);

/**
 * Metadata keys that carry the message list rather than a session fact. They
 * are consumed by the replay itself and would be an enormous, duplicated
 * `session_state` payload if they were also recorded as one.
 */
const MESSAGE_BEARING_KEYS = new Set(["messages"]);

/**
 * Prefixes Gemini CLI uses to inject harness-generated text as a `user`
 * message: the session preamble it builds at startup, and the text a hook
 * contributes. They are recorded as user turns because that is the API role
 * they occupy, but the person at the keyboard did not write them, so they are
 * attributed to `system` rather than carrying the git identity. Slash commands
 * (`/help`) — which Gemini also filters out of its own resume history — *are*
 * attributed to the human, because the human typed them.
 */
const HARNESS_USER_PREFIXES = ["<session_context>", "<hook_context>"];

/** Payload Gemini CLI's hooks engine sends on stdin (subset we read). */
interface GeminiHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  displayName?: string;
  description?: string;
}

/** One message inside the conversation document. */
interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  /** `PartListUnion`: a string, one Part, or a Part array. */
  content?: unknown;
  displayContent?: unknown;
  thoughts?: GeminiThought[];
  toolCalls?: GeminiToolCall[];
  tokens?: unknown;
  model?: string;
}

/** Session-level metadata accumulated from header and `$set` records. */
interface GeminiSessionMetadata {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  kind?: string;
}

/** A replayed message plus the ordering key assigned at first sighting. */
interface OrderedMessage {
  message: GeminiMessage;
  seq: number;
}

/**
 * A log record that is not a message: a metadata patch, a rewind, or a
 * snapshot that withdrew messages. Recorded in its own right rather than only
 * being applied, so the ledger keeps the session's declarations and the fact
 * that messages were withdrawn.
 */
interface OrderedMutation {
  seq: number;
  /**
   * "metadata" for a `$set`/header patch, "rewind" for a `$rewindTo`,
   * "snapshot_drop" for a `$set.messages` snapshot that omitted messages the
   * document previously held.
   */
  kind: "metadata" | "rewind" | "snapshot_drop";
  fields: Record<string, unknown>;
  raw: unknown;
}

export interface GeminiSession {
  metadata: GeminiSessionMetadata;
  /** Every message the file ever held, at its last-written value, in first-sighting order. */
  messages: OrderedMessage[];
  /** Metadata patches and rewinds, in file order. */
  mutations: OrderedMutation[];
  /**
   * Ids Gemini CLI removed from its own live document — via `$rewindTo` or by
   * omitting them from a `$set.messages` snapshot. Captured anyway (see the
   * module comment); a withheld message that has been removed can never be
   * rewritten, so this is also what stops one holding the cursor forever.
   */
  rewound: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringProp(value: unknown, prop: string): boolean {
  return isRecord(value) && typeof value[prop] === "string";
}

/**
 * Replay the write-ahead log.
 *
 * Record discrimination and precedence mirror Gemini CLI's own
 * `loadConversationRecord` exactly — including its "an unresolvable rewind
 * target drops everything" fallback — so that `live` tracks what the CLI
 * itself would resume. The divergence is what gets *returned*: removals are
 * recorded rather than applied to the captured set.
 */
export function replaySession(text: string): GeminiSession {
  const metadata: GeminiSessionMetadata = {};
  /** Union: every message ever written, at its last-written value. */
  const seen = new Map<string, GeminiMessage>();
  /** What Gemini CLI itself would consider the current document. */
  let live = new Set<string>();
  const firstSeen = new Map<string, number>();
  const mutations: OrderedMutation[] = [];
  let nextSeq = 0;

  const upsert = (candidate: unknown): void => {
    if (!isStringProp(candidate, "id")) return;
    const message = candidate as GeminiMessage;
    const id = message.id!;
    if (!firstSeen.has(id)) firstSeen.set(id, nextSeq++);
    seen.set(id, message);
    live.add(id);
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // partial line — normal at the tail of a live session
    }
    if (!isRecord(record)) continue;

    if (isStringProp(record, "$rewindTo")) {
      const target = record["$rewindTo"] as string;
      const ids = [...live];
      const at = ids.indexOf(target);
      // An unresolvable target drops the whole document, matching the CLI.
      const removed = at === -1 ? ids : ids.slice(at);
      live = at === -1 ? new Set() : new Set(ids.slice(0, at));
      mutations.push({
        seq: nextSeq++,
        kind: "rewind",
        fields: { rewind_to: target, removed_messages: removed, resolved: at !== -1 },
        raw: record,
      });
      continue;
    }

    if (isStringProp(record, "id")) {
      upsert(record);
      continue;
    }

    if (isRecord(record["$set"])) {
      const set = record["$set"] as Record<string, unknown>;
      const stored = withoutMessageList(record);
      if (Array.isArray(set["messages"])) {
        // A snapshot replaces the live document wholesale; anything it omits
        // is dropped from the CLI's view but kept in `seen`. *Which* ids it
        // omitted is the fact worth recording — this is the removal that
        // actually cost a real session its typed prompt (see the module
        // comment), so without this the recovered message is indistinguishable
        // from one nothing ever happened to.
        const kept = new Set<string>();
        for (const message of set["messages"]) {
          if (isStringProp(message, "id")) kept.add(message["id"] as string);
        }
        const removed = [...live].filter((id) => !kept.has(id));
        if (removed.length > 0) {
          mutations.push({
            seq: nextSeq++,
            kind: "snapshot_drop",
            fields: { removed_messages: removed, kept_message_count: kept.size },
            raw: stored,
          });
        }
        live = new Set();
        for (const message of set["messages"]) upsert(message);
      }
      Object.assign(metadata, set);
      const fields = patchFields(set);
      if (Object.keys(fields).length > 0) {
        mutations.push({ seq: nextSeq++, kind: "metadata", fields, raw: stored });
      }
      continue;
    }

    if (isStringProp(record, "sessionId") && isStringProp(record, "projectHash")) {
      Object.assign(metadata, record);
      if (Array.isArray(record["messages"])) {
        for (const message of record["messages"]) upsert(message);
      }
      const fields = patchFields(record);
      if (Object.keys(fields).length > 0) {
        mutations.push({
          seq: nextSeq++,
          kind: "metadata",
          fields,
          raw: withoutMessageList(record),
        });
      }
    }
  }

  const messages = [...seen.entries()]
    .map(([id, message]) => ({ message, seq: firstSeen.get(id) ?? 0 }))
    // Sorting by first sighting makes the emitted order a pure function of the
    // file rather than of Map insertion history, which a snapshot reshuffles.
    .sort((a, b) => a.seq - b.seq);
  const rewound = new Set([...seen.keys()].filter((id) => !live.has(id)));
  return { metadata, messages, mutations, rewound };
}

/**
 * A metadata record as stored in `raw`, minus the message list it may carry.
 *
 * This is the one place an adapter prunes `raw` rather than keeping the source
 * line verbatim, and the amplification is what earns the exception: Gemini
 * rewrites the *entire* conversation into `$set.messages` every time it
 * re-syncs history, so a session that does that N times appends N copies of
 * its whole transcript to the log. Storing them verbatim files N copies into
 * the ledger too — on the five-record real session this adapter was built
 * against, the two snapshots alone were 22% of the captured bytes, and the
 * share grows with the length of the conversation.
 *
 * Nothing is lost. Every message in that list is captured as its own event
 * carrying its own verbatim `raw`, and what the snapshot *did* — which
 * messages it withdrew — is recorded by the `snapshot_drop` activity beside
 * it. What is dropped here is only the duplicate copy.
 */
function withoutMessageList(record: Record<string, unknown>): unknown {
  const set = record["$set"];
  if (isRecord(set) && Array.isArray(set["messages"])) {
    const { messages: _messages, ...rest } = set;
    return { ...record, $set: rest };
  }
  if (Array.isArray(record["messages"])) {
    const { messages: _messages, ...rest } = record;
    return rest;
  }
  return record;
}

/** A metadata record's own fields, minus the message list it may carry. */
function patchFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!MESSAGE_BEARING_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Whether every tool call on a message has reached a state that cannot change. */
function isSettled(message: GeminiMessage): boolean {
  for (const call of message.toolCalls ?? []) {
    if (call.result !== undefined) continue;
    if (typeof call.status === "string" && SETTLED_TOOL_STATUSES.has(call.status)) continue;
    return false;
  }
  return true;
}

/**
 * The agent facts a message states about itself. Gemini CLI labels model turns
 * with the serving model and states no provider anywhere in the file (the same
 * CLI reaches AI Studio, Vertex, or a Code Assist tier depending on how the
 * user authenticated), so `provider` is left unset rather than assumed.
 *
 * `source_version` is not recorded per message either — unlike claude-code and
 * qwen-code, Gemini CLI stamps no CLI version into its session file — so it is
 * supplied by the caller when one is known, and otherwise omitted. Guessing it
 * from the installed binary would be wrong for a backfill of an old session.
 */
function agentContext(message: GeminiMessage, sourceVersion?: string): ProducerAgentContext {
  const agent: ProducerAgentContext = {};
  if (sourceVersion) agent.source_version = sourceVersion;
  if (typeof message.model === "string" && message.model) agent.model = message.model;
  return agent;
}

function partListText(content: unknown): string {
  return ensurePartArray(content)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function isHarnessAuthored(content: unknown): boolean {
  const text = partListText(content).trim();
  return HARNESS_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Which conversation a session's messages belong to. Gemini gives a subagent
 * its own session file under `<chats>/<parent session id>/`, so the directory
 * name is the parent link — the file itself never states one.
 */
function conversationFor(sessionId: string, parentId?: string): { id: string; parent?: string } {
  const id = `gemini-cli:${sessionId}`;
  return parentId ? { id, parent: `gemini-cli:${parentId}` } : { id };
}

/** Blocks for a `gemini` message, mirroring the CLI's own history assembly. */
function modelBlocks(message: GeminiMessage): unknown[] {
  const parts = ensurePartArray(message.content);
  const callsInContent = parts.some((part) => part.functionCall !== undefined);
  const thoughtsInContent = parts.some((part) => part.thought === true);

  const blocks: unknown[] = [];
  // When the content parts already carry the calls or the reasoning, Gemini CLI
  // uses them alone and ignores the sibling `thoughts`/`toolCalls` fields —
  // they are the same facts recorded twice. Mirroring that precedence is what
  // keeps a turn from emitting each tool call as two blocks.
  if (callsInContent || thoughtsInContent) {
    blocks.push(...convertParts(message.content));
  } else {
    for (const thought of message.thoughts ?? []) {
      const text = thought.description ?? thought.subject;
      if (typeof text !== "string" || !text.trim()) continue;
      const block: Record<string, unknown> = { type: "thinking", text };
      if (typeof thought.subject === "string" && thought.subject) block["subject"] = thought.subject;
      blocks.push(block);
    }
    blocks.push(...convertParts(message.content));
    for (const call of message.toolCalls ?? []) {
      const block: Record<string, unknown> = { type: "tool_use" };
      if (typeof call.id === "string") block["id"] = call.id;
      if (typeof call.name === "string") block["name"] = call.name;
      if (call.args !== undefined) block["input"] = call.args;
      blocks.push(block);
    }
  }

  // Results are appended either way: the content parts hold the *call*, never
  // its outcome — Gemini CLI emits those as a separate synthetic message.
  for (const call of message.toolCalls ?? []) {
    if (call.result === undefined) continue;
    const block: Record<string, unknown> = { type: "tool_result" };
    if (typeof call.id === "string") block["tool_use_id"] = call.id;
    if (typeof call.name === "string") block["name"] = call.name;
    block["content"] = call.result;
    if (call.status === "error") block["is_error"] = true;
    blocks.push(block);
  }
  return blocks;
}

/** The `RecordContext` a message or mutation converts under. */
function recordContext(
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
  parentId: string | undefined,
  agent: ProducerAgentContext,
): RecordContext {
  const conversation = conversationFor(sessionId, parentId);
  return {
    occurredAt,
    source: "gemini-cli",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent,
  };
}

function convertMessage(
  message: GeminiMessage,
  seq: number,
  sessionId: string,
  baseTime: string,
  version: string,
  identity: GitUserIdentity,
  sourceVersion: string | undefined,
  parentId: string | undefined,
): EventDraft | null {
  const type = message.type;
  if (typeof type !== "string") return null;

  const agent = agentContext(message, sourceVersion);
  const occurredAt = typeof message.timestamp === "string" ? message.timestamp : baseTime;
  const ctx = recordContext(occurredAt, seq, sessionId, version, parentId, agent);

  if (NOTICE_MESSAGE_TYPES.has(type)) {
    const text = partListText(message.content).trim();
    if (text) {
      return recordDraft(
        ctx,
        "conversation_turn",
        "system",
        { role: "system", notice_type: type, blocks: [{ type: "text", text }] },
        message,
      );
    }
    const { content: _content, ...fields } = message as Record<string, unknown>;
    return activityDraft(ctx, `notice/${type}`, fields, message);
  }

  if (!CONVERTIBLE_MESSAGE_TYPES.has(type)) return null;

  let blocks: unknown[];
  let actor: Actor;
  if (type === "user") {
    if (isEmptyParts(message.content)) return null;
    blocks = convertParts(message.content);
    if (isHarnessAuthored(message.content)) {
      actor = { type: "system" };
    } else {
      actor = { type: "human" };
      if (identity.email) actor.id = identity.email;
      if (identity.name) actor.display = identity.name;
    }
  } else {
    blocks = modelBlocks(message);
    if (blocks.length === 0) return null;
    actor = { type: "agent" };
    if (agent.model) actor.id = agent.model;
  }

  const conversation = conversationFor(sessionId, parentId);
  return {
    kind: "conversation_turn",
    occurred_at: occurredAt,
    actor,
    producer: {
      tool: "cledger",
      version,
      source: "gemini-cli",
      session_id: sessionId,
      ...agent,
    },
    conversation: {
      id: conversation.id,
      seq,
      ...(conversation.parent ? { parent: conversation.parent } : {}),
    },
    content: { role: type === "user" ? "user" : "model", blocks },
    raw: { format: RAW_FORMAT, data: message },
  };
}

/**
 * A metadata patch or a rewind, as its own event.
 *
 * A `$set` is a declaration about the session that holds until restated —
 * `session_state`, exactly like claude-code's `mode` and `summary` lines,
 * restatements included.
 *
 * Removals are `activity`, because they are things that happened, and they are
 * what make the withdrawn turns above them legible as withdrawn rather than
 * merely present. Gemini has two ways to withdraw a message and the ledger
 * records both: an explicit `$rewindTo`, and a `$set.messages` snapshot that
 * quietly omits what it no longer wants. The second is the one that cost a
 * real session its typed prompt, so recording only the first would leave the
 * motivating case exactly as illegible as it was.
 */
function convertMutation(mutation: OrderedMutation, ctx: RecordContext): EventDraft {
  if (mutation.kind === "rewind" || mutation.kind === "snapshot_drop") {
    return activityDraft(ctx, mutation.kind, mutation.fields, mutation.raw);
  }
  return sessionStateDraft(ctx, "metadata", liftText(mutation.fields, "summary"), mutation.raw);
}

/** Raw-only preservation event for an unrecognized gemini-cli message. */
function preserve(
  typeKey: string,
  message: GeminiMessage,
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
  sourceVersion: string | undefined,
  parentId: string | undefined,
): EventDraft {
  const conversation = conversationFor(sessionId, parentId);
  return unrecognizedDraft({
    typeKey,
    line: message,
    occurredAt,
    source: "gemini-cli",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent: agentContext(message, sourceVersion),
  });
}

/**
 * Re-normalization hook (see renormalize.ts). The whole message object is what
 * `raw.data` stores — not the log line it arrived on — so reconstruction needs
 * no replay: the same message, the same `seq` and session id go back through
 * `convertMessage`, yielding the id a live capture would produce. `baseTime`
 * falls back to the preserved event's own `occurred_at`, which is the value
 * the preservation path computed, so a timestampless message reconstructs to
 * the same instant and the same id.
 */
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  if (!event.raw || event.conversation === undefined) return null;
  const message = event.raw.data as GeminiMessage | null;
  if (!message || typeof message !== "object") return null;
  return convertMessage(
    message,
    event.conversation.seq,
    event.producer.session_id ?? "",
    event.occurred_at,
    packageVersion(),
    identity,
    event.producer.source_version,
    event.conversation.parent?.replace(/^gemini-cli:/, ""),
  );
}

/**
 * Capture an already-read session log. Split out from the file plumbing so
 * tests and offline backfill exercise replay + conversion directly.
 *
 * `sourceVersion` is the Gemini CLI version, which the session file does not
 * record; a live hook capture does not know it either, so it is optional and
 * omitted rather than guessed.
 */
export async function captureGeminiSession(
  text: string,
  cwd: string,
  fallbackSessionId: string,
  sourceVersion?: string,
  parentId?: string,
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  // No file behind this entrypoint, so the caller's id is also the cursor key.
  const result = await captureSessionInto(
    repo,
    text,
    fallbackSessionId,
    fallbackSessionId,
    sourceVersion,
    parentId,
    0,
  );
  process.stderr.write(
    `cledger: gemini-cli +${result.appended} events (${result.deduped} deduped)\n`,
  );
  warnUnrecognized("gemini-cli", result.unrecognized);
  return result;
}

/**
 * The conversion half, without printing — shared by every capture entrypoint.
 *
 * `cursorKey` is deliberately separate from the session id the events carry.
 * The session id comes from inside the file (`metadata.sessionId`, a uuid);
 * the cursor is keyed by the file's own name, because that is the only
 * identifier the catch-up sweep has before it reads anything. Keying the
 * cursor by the declared id instead means the sweep looks under a name capture
 * never writes, finds nothing, and silently skips every session forever — the
 * exact bug this parameter exists to prevent.
 */
async function captureSessionInto(
  repo: RepoInfo,
  text: string,
  fallbackSessionId: string,
  cursorKey: string,
  sourceVersion: string | undefined,
  parentId: string | undefined,
  fileSize: number,
): Promise<CaptureResult> {
  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const session = replaySession(text);
  const sessionId = session.metadata.sessionId ?? fallbackSessionId;
  if (!sessionId) return result;

  const baseTime =
    session.metadata.startTime ?? session.metadata.lastUpdated ?? new Date().toISOString();
  const version = packageVersion();
  const identity = await gitUserIdentity(repo);

  // The cursor is the lowest ordering key not yet finalized — not a position
  // in the replayed list. Because keys are assigned at first sighting and never
  // reused, a rewind that shortens the document cannot make the cursor skip
  // past records written after it.
  const cursor = (await readCursor(repo, cursorKey, CURSOR_FIELD))?.count ?? 0;
  let nextCursor = cursor;
  let held = false;

  const drafts: EventDraft[] = [];
  // Monotonic: messages and mutations are examined in two separate passes, and
  // whichever runs last must not be able to drag the cursor back to its own
  // highest key. Backwards is safe (re-emitted records dedup) but it means the
  // tail is re-converted on every hook fire, forever.
  const advance = (seq: number) => {
    if (!held && seq + 1 > nextCursor) nextCursor = seq + 1;
  };

  for (const mutation of session.mutations) {
    if (mutation.seq < cursor) continue;
    const ctx = recordContext(baseTime, mutation.seq, sessionId, version, parentId, {
      ...(sourceVersion ? { source_version: sourceVersion } : {}),
    });
    drafts.push(convertMutation(mutation, ctx));
  }

  for (const { message, seq } of session.messages) {
    if (seq < cursor) continue;
    const type = typeof message.type === "string" ? message.type : "(untyped)";

    // A message Gemini has already dropped from its live document can never be
    // rewritten, so a tool call left mid-flight on one is settled by
    // abandonment — without this it would hold the cursor back forever.
    if (!session.rewound.has(message.id ?? "") && !isSettled(message)) {
      held = true;
      continue;
    }

    const draft = convertMessage(
      message,
      seq,
      sessionId,
      baseTime,
      version,
      identity,
      sourceVersion,
      parentId,
    );
    if (draft) {
      drafts.push(draft);
      continue;
    }
    if (CONVERTIBLE_MESSAGE_TYPES.has(type) || NOTICE_MESSAGE_TYPES.has(type)) continue; // empty
    countUnrecognized(result.unrecognized, type);
    const occurredAt = typeof message.timestamp === "string" ? message.timestamp : baseTime;
    drafts.push(preserve(type, message, occurredAt, seq, sessionId, version, sourceVersion, parentId));
  }

  // The cursor advances to the highest seq examined, unless a withheld message
  // held it back at its own position.
  for (const { seq } of session.messages) if (seq >= cursor) advance(seq);
  for (const { seq } of session.mutations) if (seq >= cursor) advance(seq);

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  await writeCursor(repo, cursorKey, CURSOR_FIELD, nextCursor, fileSize);
  return result;
}

/**
 * A session file's name, without the extension.
 *
 * Two jobs. It is the cursor key (see `captureSessionInto`), because the sweep
 * has to identify a session from its path alone. And it is the fallback
 * session id for a file too young to have written its header yet — Gemini
 * embeds the session's short id in the name (`session-<ts>-<short id>`), so
 * the stem is at least session-specific, and the real uuid replaces it as soon
 * as the header lands.
 */
function sessionIdFromPath(path: string): string {
  return basename(path, ".jsonl");
}

/** Capture one session file, plus any subagent sessions filed beneath it. */
async function captureSessionFile(
  repo: RepoInfo,
  path: string,
  parentId?: string,
): Promise<CaptureResult> {
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return total; // not written yet
  }
  mergeCaptureResult(
    total,
    await captureSessionInto(
      repo,
      text,
      sessionIdFromPath(path),
      sessionIdFromPath(path),
      undefined,
      parentId,
      Buffer.byteLength(text),
    ),
  );
  for (const child of await subagentSessions(path)) {
    mergeCaptureResult(total, await captureSessionFile(repo, child, sessionIdOf(text, path)));
  }
  return total;
}

/** The session id a file declares, falling back to its name. */
function sessionIdOf(text: string, path: string): string {
  return replaySession(text).metadata.sessionId ?? sessionIdFromPath(path);
}

/**
 * Subagent session files belonging to a session.
 *
 * Gemini files a sub-session's chats under `<chats>/<parent session id>/`, a
 * sibling directory of the parent's own file that nothing in the parent
 * transcript points at — so, exactly as with claude-code's `subagents/`
 * directory, capture has to go looking or the whole sub-conversation is
 * invisible however well the adapter can convert its lines.
 */
async function subagentSessions(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (!text) return [];
  const id = sessionIdOf(text, path);
  const dir = join(path.slice(0, path.lastIndexOf("/")), id);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return []; // no subagents ran
  }
}

export async function captureGeminiTranscript(
  transcriptPath: string,
  cwd: string,
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const result = await captureSessionFile(repo, transcriptPath);
  process.stderr.write(
    `cledger: gemini-cli +${result.appended} events (${result.deduped} deduped)\n`,
  );
  warnUnrecognized("gemini-cli", result.unrecognized);
  return result;
}

/**
 * Resolve the directory Gemini CLI keeps `cwd`'s chats in.
 *
 * Gemini names each project directory after the workspace's basename (with a
 * disambiguating suffix when two workspaces share one), and records the
 * mapping in `~/.gemini/projects.json`. That file is consulted first; if it is
 * missing or stale, the fallback reads the `.project_root` marker Gemini writes
 * inside each directory, which states the absolute workspace path. Guessing
 * from the basename alone would collide across checkouts.
 */
export async function geminiProjectChatsDir(cwd: string): Promise<string | null> {
  const tmpRoot = join(homedir(), ".gemini", "tmp");
  try {
    const raw = await readFile(join(homedir(), ".gemini", "projects.json"), "utf8");
    const parsed = JSON.parse(raw) as { projects?: Record<string, string> };
    const name = parsed.projects?.[cwd];
    if (typeof name === "string" && name) return join(tmpRoot, name, "chats");
  } catch {
    /* fall through to the marker scan */
  }
  let names: string[];
  try {
    names = await readdir(tmpRoot);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const root = (await readFile(join(tmpRoot, name, ".project_root"), "utf8")).trim();
      if (root === cwd) return join(tmpRoot, name, "chats");
    } catch {
      continue;
    }
  }
  return null;
}

/** Every top-level session file for this workspace, newest first. */
async function projectSessions(cwd: string): Promise<string[]> {
  const dir = await geminiProjectChatsDir(cwd);
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const stamped = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(dir, name);
        return { path, mtime: await stat(path).then((s) => s.mtimeMs, () => 0) };
      }),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.map((s) => s.path);
}

/**
 * Capture every Gemini CLI chat recorded for this workspace, seen before or
 * not — the explicit backfill behind `cledger capture gemini-cli --all`.
 */
export async function captureGeminiAll(cwd: string, limit?: number): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const paths = await projectSessions(cwd);
  // Gemini scopes chats to the workspace root it was launched in, so running
  // this from a subdirectory finds nothing. Say so: a silent `+0 events` is
  // indistinguishable from "captured everything already".
  if (paths.length === 0) {
    const dir = await geminiProjectChatsDir(cwd);
    process.stderr.write(
      `cledger: gemini-cli found no sessions for ${cwd} ` +
        `(${dir ? `looked in ${dir}` : "no Gemini project directory is registered for this path"})\n`,
    );
  }
  for (const path of typeof limit === "number" ? paths.slice(0, limit) : paths) {
    mergeCaptureResult(total, await captureSessionFile(repo, path));
  }
  process.stderr.write(`cledger: gemini-cli +${total.appended} events (${total.deduped} deduped)\n`);
  warnUnrecognized("gemini-cli", total.unrecognized);
  return total;
}

/**
 * Capture any *other* session in this workspace whose file has grown since it
 * was last read. Bounded to sessions that already have a cursor, for the same
 * reason claude-code's sweep is: a missing cursor means cledger never captured
 * that session, and adopting it would be a silent backfill anchored to the
 * wrong commit rather than the gap-closing pass this is meant to be.
 */
async function sweepStaleSessions(
  repo: RepoInfo,
  cwd: string,
  seen: Set<string>,
): Promise<CaptureResult> {
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  for (const path of await projectSessions(cwd)) {
    if (seen.has(path)) continue;
    try {
      const cursor = await readCursor(repo, sessionIdFromPath(path), CURSOR_FIELD);
      if (cursor === null) continue; // never captured — not this pass's business
      const info = await stat(path);
      if (info.size <= cursor.size) continue; // nothing new since the last read
      mergeCaptureResult(total, await captureSessionFile(repo, path));
    } catch {
      continue;
    }
  }
  return total;
}

export async function runGeminiHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as GeminiHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
    const seen = new Set<string>();
    if (payload.transcript_path) {
      seen.add(payload.transcript_path);
      mergeCaptureResult(total, await captureSessionFile(repo, payload.transcript_path));
    }
    mergeCaptureResult(total, await sweepStaleSessions(repo, cwd, seen));
    process.stderr.write(
      `cledger: gemini-cli +${total.appended} events (${total.deduped} deduped)\n`,
    );
    warnUnrecognized("gemini-cli", total.unrecognized);
  } catch (err) {
    process.stderr.write(
      `cledger: gemini-cli hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
