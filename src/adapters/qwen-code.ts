/**
 * Qwen Code adapter.
 *
 * Qwen Code is a fork of Gemini CLI, but its conversation store is the one
 * piece it did *not* inherit: where gemini-cli keeps a replayed write-ahead
 * log (see gemini-cli.ts), Qwen Code writes a plain append-only JSONL
 * transcript at `~/.qwen/projects/<escaped-cwd>/chats/<session-id>.jsonl`,
 * one JSON object per line, with nearly the same envelope fields as
 * claude-code (`uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`,
 * `gitBranch`, `version`). So this adapter is the claude-code adapter's twin
 * in structure — per-line conversion, line-index `seq`, a line-count cursor,
 * a catch-up sweep — and differs in two places: message content is a Google
 * GenAI `Part` list (shared with gemini-cli in genai-parts.ts), and every
 * non-turn record arrives as a `system` line discriminated by `subtype`
 * rather than as its own top-level type.
 *
 * Verified against a live Qwen Code 0.21.5 session and against its shipped
 * sources: `RECORD_TYPES` is exactly `user`/`assistant`/`tool_result`/
 * `system`, assistant lines carry the serving model at the *top level*
 * (`line.model`, not inside `message`), and `message.role` is Google's
 * `"user"`/`"model"` rather than `"user"`/`"assistant"`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion, readCursor, writeCursor } from "./common.js";
import { convertParts, isEmptyParts } from "./genai-parts.js";
import {
  countUnrecognized,
  mergeCaptureResult,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";
import {
  activityDraft,
  contextInjectionDraft,
  liftText,
  recordDraft,
  sessionStateDraft,
  type RecordContext,
} from "./records.js";

const RAW_FORMAT = "qwen-code-jsonl/1";

const CURSOR_FIELD = "lines";

/**
 * Line types carrying visible conversation content. `tool_result` is its own
 * top-level type here, unlike claude-code where a tool result rides inside a
 * `user` message — hence three convertible types rather than two.
 */
const CONVERTIBLE_LINE_TYPES = new Set(["user", "assistant", "tool_result"]);

/**
 * Every top-level record type Qwen Code writes, taken verbatim from its own
 * `RECORD_TYPES` set. A line whose type is outside this set is genuinely new
 * upstream content and routes to the drift path — preserved raw, warned
 * about, upgradeable later by `cledger renormalize`.
 */
const RECORD_TYPES = new Set(["user", "assistant", "tool_result", "system"]);

/**
 * How a `system` line's `subtype` maps onto a record kind.
 *
 * Qwen Code funnels everything that is not a turn through `system`, so the
 * subtype is the real discriminator; the names below are its own
 * `KNOWN_RECORD_SUBTYPES`. The split follows the same reasoning the
 * claude-code adapter applies to its top-level types: a declaration that
 * holds until restated is `session_state`, material the harness put in front
 * of the model is `context_injection`, and intermediate file state is
 * `file_snapshot`.
 *
 * Anything not listed — including a subtype a future Qwen Code adds — falls
 * through to `activity`, which is the honest default: `system` is a type this
 * adapter knows, so preserving it raw-only and warning about drift would be a
 * false alarm, but claiming to know that an unseen subtype is *state* would
 * be a guess. "Something happened, here are its fields verbatim" is true of
 * all of them.
 */
const SESSION_STATE_SUBTYPES = new Set([
  "custom_title",
  "session_source",
  "parent_session",
  "goal_state",
]);
const CONTEXT_INJECTION_SUBTYPES = new Set([
  "at_command",
  "agent_bootstrap",
  "agent_launch_prompt",
]);
const FILE_SNAPSHOT_SUBTYPES = new Set(["attribution_snapshot", "file_history_snapshot"]);

/**
 * `system` subtypes the person at the keyboard drove, rather than the harness.
 *
 * They stay `activity` — Qwen records `sentToModel: false` on them, so they
 * are not turns in the conversation the model saw — but the actor is the human,
 * because a human typed them. Verified on a live session: a `slash_command`
 * record carries the literal `rawCommand` ("/chat save smoke-test"), which is
 * keystrokes, not harness bookkeeping. Filing that under `system` would be the
 * ledger recording a person's action as the machine's.
 *
 * This matches the rule the gemini-cli adapter already states for the same
 * class of thing: harness-authored preambles are `system`, slash commands are
 * the human's.
 */
const HUMAN_DRIVEN_SUBTYPES = new Set(["slash_command"]);

/**
 * Envelope fields every Qwen Code line carries. Dropped from the structured
 * `content` of record events because they are already on the event itself
 * (`occurred_at`, `producer.session_id`, `producer.source_version`) or in
 * `raw.data` — repeating them in `content` would put one fact in three places
 * with three chances to disagree. Mirrors claude-code's `ENVELOPE_KEYS`.
 */
const ENVELOPE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "cwd",
  "version",
  "gitBranch",
  "provenance",
]);

function payloadFields(line: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Payload Qwen Code's hooks engine sends on stdin (subset we read). */
interface QwenHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

/** One line of a `~/.qwen/projects/<escaped-cwd>/chats/<id>.jsonl` transcript. */
interface QwenTranscriptLine {
  type?: string;
  /** `system` lines: which kind, e.g. "ui_telemetry" / "parent_session". */
  subtype?: string;
  /** `system` lines: the subtype's own payload. */
  systemPayload?: Record<string, unknown>;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  provenance?: string;
  cwd?: string;
  gitBranch?: string;
  /** Qwen Code's own CLI version, e.g. "0.21.5". */
  version?: string;
  /** Serving model, stated top-level on assistant lines only. */
  model?: string;
  message?: { role?: string; parts?: unknown };
  /** Present on `tool_result` lines alongside the functionResponse part. */
  toolCallResult?: { callId?: string; status?: string; executionStatus?: string };
}

/** One file's state inside an `attribution_snapshot` payload. */
interface QwenFileState {
  contentHash?: string;
  aiContribution?: number;
  aiCreated?: boolean;
}

/**
 * Where Qwen Code keeps a working directory's chats. The directory name is
 * the absolute cwd with every `/` and `.` replaced by `-`, the same escaping
 * claude-code uses for `~/.claude/projects/`.
 */
export function qwenProjectChatsDir(cwd: string): string {
  return join(homedir(), ".qwen", "projects", cwd.replace(/[/.]/g, "-"), "chats");
}

/**
 * A deterministic session time for records that carry no timestamp of their
 * own: the first timestamp anywhere in the transcript (stable across
 * rescans), falling back to the file mtime.
 */
function firstTimestamp(lines: string[]): string | null {
  for (const text of lines) {
    if (!text.trim()) continue;
    try {
      const parsed = JSON.parse(text) as QwenTranscriptLine;
      if (typeof parsed.timestamp === "string" && !Number.isNaN(Date.parse(parsed.timestamp))) {
        return parsed.timestamp;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function sessionMtime(transcriptPath: string): Promise<string> {
  try {
    return (await stat(transcriptPath)).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * The parent session this transcript belongs to, if any.
 *
 * Qwen Code gives a subagent its own chat file and records the link once, as
 * a `system`/`parent_session` line written right after the sub-session is
 * created. The whole file is scanned rather than just the lines past the
 * cursor: a cursor-resumed capture starts mid-file and would otherwise never
 * see the record, and every event in the file needs the same parent to keep
 * their ids stable across resumes. (The codex adapter re-scans its prefix for
 * the same reason.)
 */
function parentSessionId(lines: string[]): string | undefined {
  for (const text of lines) {
    if (!text.trim()) continue;
    let parsed: QwenTranscriptLine;
    try {
      parsed = JSON.parse(text) as QwenTranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type !== "system" || parsed.subtype !== "parent_session") continue;
    const id = parsed.systemPayload?.["parentSessionId"];
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** Which conversation a transcript's lines belong to. */
function conversationFor(sessionId: string, parentId?: string): { id: string; parent?: string } {
  const id = `qwen-code:${sessionId}`;
  return parentId ? { id, parent: `qwen-code:${parentId}` } : { id };
}

/**
 * The agent facts this line states about itself. Qwen Code stamps every line
 * with the CLI `version`, and labels assistant lines with the model that
 * produced them; user and tool_result lines carry no model, and none is
 * invented for them — the same rule the claude-code adapter follows, and for
 * the same reason (the model that will answer a prompt is not knowable from
 * the prompt's own line, and it can change mid-session).
 *
 * The provider is deliberately left unset even though Qwen Code knows it: the
 * value appears as `auth_type` inside `ui_telemetry` payloads, and it names an
 * *auth mode* ("openai", "qwen-oauth") rather than the inference provider
 * `Producer.provider` asks for. Reading it off a neighbouring line would also
 * break the per-line independence a cursor-resumed capture depends on.
 */
function agentContext(line: QwenTranscriptLine): ProducerAgentContext {
  const agent: ProducerAgentContext = {};
  if (typeof line.version === "string" && line.version) agent.source_version = line.version;
  if (typeof line.model === "string" && line.model) agent.model = line.model;
  return agent;
}

/**
 * The `RecordContext` a non-turn line converts under. Shared by the capture
 * loop and the re-normalization hook so both mint the same event identity —
 * `conversation` and `occurred_at` are both part of the identity subset, so
 * any divergence would write a second copy instead of deduping.
 */
function recordContext(
  line: QwenTranscriptLine,
  occurredAt: string,
  seq: number,
  fileSessionId: string,
  version: string,
  parentId: string | undefined,
  identity: GitUserIdentity,
): RecordContext {
  const sessionId = line.sessionId ?? fileSessionId;
  const conversation = conversationFor(sessionId, parentId);
  return {
    occurredAt,
    source: "qwen-code",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent: agentContext(line),
    identity,
  };
}

/**
 * An `attribution_snapshot` as a `file_snapshot`.
 *
 * Qwen tracks, per file, a content hash and how much of the file it attributes
 * to the model. Unlike Claude Code's file history there is no local cache to
 * resolve — the digest is in the record itself — so nothing goes in
 * `resolved`, and `content` carries the source's own per-file fields beside
 * the path they were keyed by.
 */
function attributionSnapshot(line: QwenTranscriptLine, ctx: RecordContext): EventDraft {
  const snapshot = (line.systemPayload?.["snapshot"] ?? {}) as Record<string, unknown>;
  const { fileStates, ...rest } = snapshot;
  const states = (fileStates ?? {}) as Record<string, QwenFileState>;
  const files = Object.entries(states).map(([path, state]) => ({ path, ...state }));
  return recordDraft(
    ctx,
    "file_snapshot",
    "system",
    { ...rest, operation: "snapshot", files },
    line,
  );
}

/**
 * Convert a line that is not a turn into the record it deserves, or null when
 * the type is outside Qwen's own record set (the caller routes it to drift).
 */
function convertRecordLine(line: QwenTranscriptLine, ctx: RecordContext): EventDraft | null {
  if (line.type !== "system") return null;
  const subtype = typeof line.subtype === "string" ? line.subtype : "untyped";
  const fields = payloadFields(line as unknown as Record<string, unknown>);

  if (FILE_SNAPSHOT_SUBTYPES.has(subtype)) {
    if (subtype === "attribution_snapshot") return attributionSnapshot(line, ctx);
    // Any other file-history subtype keeps its payload verbatim: same kind,
    // no invented shape, because its fields have not been seen.
    return recordDraft(ctx, "file_snapshot", "system", { ...fields, operation: subtype }, line);
  }
  if (SESSION_STATE_SUBTYPES.has(subtype)) {
    return sessionStateDraft(ctx, subtype, fields, line);
  }
  if (CONTEXT_INJECTION_SUBTYPES.has(subtype)) {
    return contextInjectionDraft(ctx, subtype, fields, line);
  }
  // `content` is where a text-bearing system record (a notification, a queued
  // mid-turn message) puts its prose; lifting it gives `blocks` for free and
  // is a no-op when there is none.
  return activityDraft(
    ctx,
    `system/${subtype}`,
    liftText(fields, "content"),
    line,
    HUMAN_DRIVEN_SUBTYPES.has(subtype) ? "human" : "system",
  );
}

function convertLine(
  line: QwenTranscriptLine,
  seq: number,
  version: string,
  identity: GitUserIdentity,
  fileSessionId: string,
  parentId: string | undefined,
): EventDraft | null {
  const type = line.type;
  if (typeof type !== "string" || !CONVERTIBLE_LINE_TYPES.has(type)) return null;
  if (!line.message) return null;
  if (typeof line.timestamp !== "string") return null;
  if (isEmptyParts(line.message.parts)) return null;
  const sessionId = line.sessionId ?? fileSessionId;

  // `tool_result` lines are stored with `message.role: "user"` because that is
  // how the GenAI API frames a function response, but the human did not say
  // them. They get the `system` actor every other adapter gives a standalone
  // tool result, rather than being attributed to the person at the keyboard.
  const actor: Actor =
    type === "user"
      ? { type: "human" }
      : type === "assistant"
        ? { type: "agent" }
        : { type: "system" };
  if (type === "user") {
    if (identity.email) actor.id = identity.email;
    if (identity.name) actor.display = identity.name;
  }
  if (type === "assistant" && typeof line.model === "string" && line.model) actor.id = line.model;

  const content: Record<string, unknown> = {};
  if (typeof line.message.role === "string") content["role"] = line.message.role;
  content["blocks"] = convertParts(line.message.parts);

  const conversation = conversationFor(sessionId, parentId);
  return {
    kind: "conversation_turn",
    occurred_at: line.timestamp,
    actor,
    producer: {
      tool: "cledger",
      version,
      source: "qwen-code",
      session_id: sessionId,
      ...agentContext(line),
    },
    conversation: {
      id: conversation.id,
      seq,
      ...(conversation.parent ? { parent: conversation.parent } : {}),
    },
    content,
    raw: { format: RAW_FORMAT, data: line },
  };
}

/** Raw-only preservation event for an unrecognized qwen-code line (see drift.ts). */
function preserve(
  type: string,
  line: QwenTranscriptLine,
  occurredAt: string,
  seq: number,
  fileSessionId: string,
  version: string,
  parentId: string | undefined,
): EventDraft {
  const sessionId = line.sessionId ?? fileSessionId;
  const conversation = conversationFor(sessionId, parentId);
  return unrecognizedDraft({
    typeKey: type,
    line,
    occurredAt,
    source: "qwen-code",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent: agentContext(line),
  });
}

/**
 * Re-normalization hook (see renormalize.ts): re-feed a preserved line's
 * stored `raw.data` through the same convert paths a live capture uses, with
 * the same seq and session id, so the reconstructed event's id is identical
 * to what a later live capture of that line would produce.
 *
 * The parent link is recovered from the preserved event's own
 * `conversation.parent` rather than by re-reading the transcript, which may
 * be long gone; that is the same value the capture path used.
 */
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  if (!event.raw || event.conversation === undefined) return null;
  const line = event.raw.data as QwenTranscriptLine;
  const sessionId = event.producer.session_id ?? "";
  const parentId = event.conversation.parent?.replace(/^qwen-code:/, "");
  const version = packageVersion();
  const turn = convertLine(line, event.conversation.seq, version, identity, sessionId, parentId);
  if (turn) return turn;
  if (line?.type !== "system") return null;
  const ctx = recordContext(
    line,
    event.occurred_at,
    event.conversation.seq,
    sessionId,
    version,
    parentId,
    identity,
  );
  return convertRecordLine(line, ctx);
}

/** Capture one transcript file. Does not print — `captureQwenTranscript` wraps it. */
async function captureTranscriptFile(
  repo: RepoInfo,
  transcriptPath: string,
): Promise<CaptureResult> {
  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return result; // transcript not written yet
  }
  // Whether the writer had finished the last line when we read. A transcript
  // that does not end in a newline was caught mid-write, which is how the
  // final line comes to be torn — see `tornTail` below.
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sessionId = basename(transcriptPath, ".jsonl");
  const stored = (await readCursor(repo, sessionId, CURSOR_FIELD)) ?? { count: 0, size: 0 };
  let cursor = stored.count;
  if (cursor > lines.length) cursor = 0; // shorter than expected — rescan from the start

  /**
   * Index of a half-written final line, when there is one. Advancing past it
   * would skip that line permanently once its bytes land. Both conditions are
   * load-bearing: a parse failure anywhere but the unterminated last line is
   * real corruption, and holding the cursor there would stall capture forever.
   */
  let tornTail: number | null = null;

  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  const parentId = parentSessionId(lines);
  let baseTime: string | null = null; // lazy: only a timestampless record needs it
  const drafts: EventDraft[] = [];
  for (let i = cursor; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    let parsed: QwenTranscriptLine;
    try {
      parsed = JSON.parse(text) as QwenTranscriptLine;
    } catch {
      // Partial line — normal at the tail of a live transcript. Remember it so
      // the cursor stops here rather than stepping over it for good.
      if (!endsWithNewline && i === lines.length - 1) tornTail = i;
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "(untyped)";

    if (!CONVERTIBLE_LINE_TYPES.has(type)) {
      if (baseTime === null) {
        baseTime = firstTimestamp(lines) ?? (await sessionMtime(transcriptPath));
      }
      const occurredAt = typeof parsed.timestamp === "string" ? parsed.timestamp : baseTime;
      const ctx = recordContext(parsed, occurredAt, i, sessionId, version, parentId, identity);
      const record = RECORD_TYPES.has(type) ? convertRecordLine(parsed, ctx) : null;
      if (record) {
        drafts.push(record);
        continue;
      }
      // Outside Qwen's own record set: preserve raw and warn.
      countUnrecognized(result.unrecognized, type);
      drafts.push(preserve(type, parsed, occurredAt, i, sessionId, version, parentId));
      continue;
    }
    const draft = convertLine(parsed, i, version, identity, sessionId, parentId);
    if (draft) drafts.push(draft);
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  // With a torn tail the cursor stops before it, and the recorded size is the
  // byte offset that line starts at — not the file's size, which would tell
  // the next sweep nothing had changed and strand the very line held back.
  const consumed = tornTail ?? lines.length;
  const size =
    tornTail === null
      ? Buffer.byteLength(raw)
      : Buffer.byteLength(lines.slice(0, consumed).join("\n")) + (consumed > 0 ? 1 : 0);
  await writeCursor(repo, sessionId, CURSOR_FIELD, consumed, size);
  return result;
}

export async function captureQwenTranscript(
  transcriptPath: string,
  cwd: string,
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const result = await captureTranscriptFile(repo, transcriptPath);
  process.stderr.write(`cledger: qwen-code +${result.appended} events (${result.deduped} deduped)\n`);
  warnUnrecognized("qwen-code", result.unrecognized);
  return result;
}

/** Every `.jsonl` chat file Qwen Code has written for this project, newest first. */
async function projectTranscripts(cwd: string): Promise<string[]> {
  const dir = qwenProjectChatsDir(cwd);
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
 * Capture every Qwen Code chat recorded for this project, whether or not
 * cledger has seen it before. This is the explicit backfill behind
 * `cledger capture qwen-code --all`, and is deliberately *not* what the hook
 * runs — see `sweepStaleTranscripts`.
 */
export async function captureQwenAll(cwd: string, limit?: number): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const paths = await projectTranscripts(cwd);
  // The chats directory is derived from the exact cwd, so running this from a
  // subdirectory of the project finds nothing. Say so rather than reporting a
  // `+0 events` that reads as "already captured".
  if (paths.length === 0) {
    process.stderr.write(
      `cledger: qwen-code found no sessions for ${cwd} (looked in ${qwenProjectChatsDir(cwd)})\n`,
    );
  }
  for (const path of typeof limit === "number" ? paths.slice(0, limit) : paths) {
    mergeCaptureResult(total, await captureTranscriptFile(repo, path));
  }
  process.stderr.write(`cledger: qwen-code +${total.appended} events (${total.deduped} deduped)\n`);
  warnUnrecognized("qwen-code", total.unrecognized);
  return total;
}

/**
 * Capture any *other* transcript in this project that has grown since it was
 * last read — the same gap-closing pass the claude-code adapter runs, and for
 * the same reason: a session's own final lines are unreachable to it, because
 * the hook fires, capture reads to end-of-file, and Qwen Code then writes the
 * closing bookkeeping of that turn with no further hook to pick it up.
 *
 * A transcript with *no* cursor is skipped, and that bound is the point. A
 * missing cursor means cledger never captured that session at all — it
 * predates the install, or the user did not want it — and adopting those
 * would turn a gap-closing sweep into a silent backfill of every conversation
 * ever held in the project, anchored to whatever HEAD is checked out now
 * rather than the commit it was about. `--all` is where that belongs, on
 * purpose and by request.
 *
 * Failures are swallowed per session: a sweep is a bonus pass over
 * conversations the user is not currently having, and must never be the
 * reason their live capture reports an error.
 */
async function sweepStaleTranscripts(
  repo: RepoInfo,
  cwd: string,
  seen: Set<string>,
): Promise<CaptureResult> {
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  for (const path of await projectTranscripts(cwd)) {
    if (seen.has(path)) continue;
    try {
      const cursor = await readCursor(repo, basename(path, ".jsonl"), CURSOR_FIELD);
      if (cursor === null) continue; // never captured — not this pass's business
      const info = await stat(path);
      if (info.size <= cursor.size) continue; // nothing new since the last read
      mergeCaptureResult(total, await captureTranscriptFile(repo, path));
    } catch {
      continue;
    }
  }
  return total;
}

export async function runQwenHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as QwenHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
    const seen = new Set<string>();
    if (payload.transcript_path) {
      seen.add(payload.transcript_path);
      mergeCaptureResult(total, await captureTranscriptFile(repo, payload.transcript_path));
    }
    mergeCaptureResult(total, await sweepStaleTranscripts(repo, cwd, seen));
    process.stderr.write(`cledger: qwen-code +${total.appended} events (${total.deduped} deduped)\n`);
    warnUnrecognized("qwen-code", total.unrecognized);
  } catch (err) {
    process.stderr.write(
      `cledger: qwen-code hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
