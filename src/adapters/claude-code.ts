import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Hex } from "../canonical.js";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
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
  fileSnapshotDraft,
  liftText,
  recordDraft,
  sessionStateDraft,
  type RecordContext,
  type ResolvedFile,
  type SnapshotFile,
} from "./records.js";

const CONVERTIBLE_LINE_TYPES = new Set(["user", "assistant"]);

// Unchanged at /1: `raw.data` is still one verbatim transcript line, which is
// all the format marker promises. What changed is which lines get captured
// and what `content` the ledger derives from them, neither of which affects
// how a consumer re-parses the stored line.
const RAW_FORMAT = "claude-code-jsonl/1";

/**
 * Line types recorded as `session_state` — declarations about the session
 * that hold until restated. Claude Code rewrites most of these on every turn;
 * each restatement is kept as its own event, because "the permission mode was
 * still `auto` at this point" is a fact a consumer judging an old turn needs
 * and cannot recover from the first statement alone.
 */
const SESSION_STATE_LINE_TYPES = new Set([
  "mode",
  "permission-mode",
  "agent-setting",
  "agent-name",
  "ai-title",
  "last-prompt",
  "summary",
  "relocated",
  "worktree-state",
  "pr-link",
  "bridge-session",
]);

/** Line types recorded as `activity` — things that happened, not state. */
const ACTIVITY_LINE_TYPES = new Set(["progress", "queue-operation"]);

/**
 * Line types recorded as `file_snapshot`. Handled apart from the rest of the
 * routing because they are the only ones whose conversion touches the disk —
 * their payload is a set of pointers into Claude Code's backup cache, and
 * resolving those to digests is an async read the pure routing function
 * cannot do.
 */
const FILE_HISTORY_LINE_TYPES = new Set(["file-history-snapshot", "file-history-delta"]);

/**
 * Envelope fields every Claude Code line carries. They are dropped from the
 * structured `content` of state/activity/injection records — not because they
 * are worthless, but because they are already on the event itself
 * (`occurred_at`, `producer.session_id`, `producer.source_version`,
 * `context.cwd`) or in `raw.data`, and repeating them in `content` would put
 * the same fact in three places with three chances to disagree.
 */
const ENVELOPE_KEYS = new Set([
  "type",
  "uuid",
  "parentUuid",
  "sessionId",
  "session_id",
  "timestamp",
  "cwd",
  "version",
  "gitBranch",
  "isSidechain",
  "userType",
  "entrypoint",
  "sessionKind",
]);

/** A line's own fields, envelope stripped — the payload the type is about. */
function payloadFields(line: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Claude Code hooks-engine payload (subset we read). */
interface ClaudeCodeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

/** One line of a `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl` transcript. */
interface ClaudeTranscriptLine {
  type?: string;
  isSidechain?: boolean;
  /** Subagent this line belongs to; present on every sidechain line. */
  agentId?: string;
  /** Subagent type that produced an assistant sidechain line, e.g. "Explore". */
  attributionAgent?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
  /** `system` lines: which kind of system line, e.g. "local_command". */
  subtype?: string;
  /** `system` / `queue-operation` lines: the text the harness emitted. */
  content?: unknown;
  /** `attachment` lines: the injected material. */
  attachment?: { type?: string } & Record<string, unknown>;
  /** `file-history-snapshot` lines. */
  snapshot?: {
    messageId?: string;
    trackedFileBackups?: Record<string, ClaudeFileBackup>;
    timestamp?: string;
  };
  isSnapshotUpdate?: boolean;
  /** `file-history-delta` lines. */
  messageId?: string;
  snapshotMessageId?: string;
  trackingPath?: string;
  backup?: ClaudeFileBackup;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

/** One tracked file version, as Claude Code's file-history machinery records it. */
interface ClaudeFileBackup {
  /** Name of the copy under `<config>/file-history/<session>/`, or null when
   *  the file is tracked but no copy was taken. */
  backupFileName?: string | null;
  version?: number;
  backupTime?: string;
  realParentDir?: string;
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

/**
 * How far a transcript has been captured: the line count consumed, and the
 * file size that line count corresponded to.
 *
 * `size` exists for the catch-up sweep (see `sweepStaleTranscripts`), which
 * needs to answer "did this file grow since we last read it" for every
 * session in a project without reading them all. A cursor written by an
 * older cledger has no `size`; that reads as 0, so the file looks grown and
 * gets re-read once, which dedups.
 */
interface Cursor {
  lines: number;
  size: number;
}

async function readCursor(repo: RepoInfo, sessionId: string): Promise<Cursor> {
  try {
    const raw = await readFile(cursorPath(repo, sessionId), "utf8");
    const data = JSON.parse(raw) as { lines?: number; size?: number };
    return {
      lines: typeof data.lines === "number" ? data.lines : 0,
      size: typeof data.size === "number" ? data.size : 0,
    };
  } catch {
    return { lines: 0, size: 0 };
  }
}

async function writeCursor(
  repo: RepoInfo,
  sessionId: string,
  lines: number,
  size: number,
): Promise<void> {
  const path = cursorPath(repo, sessionId);
  await mkdir(join(repo.commonDir, "conversation-ledger", "cursors"), { recursive: true });
  await writeFile(path, JSON.stringify({ lines, size }) + "\n");
}

function convertContentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(convertBlock);
}

function convertBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const b = block as Record<string, unknown>;
  if (b["type"] === "thinking") {
    // signature is a provider-internal verification token, not visible content
    return { type: "thinking", text: b["thinking"] };
  }
  // text / tool_use / tool_result / unknown block shapes pass through verbatim
  return b;
}

/**
 * A deterministic session time for preserving unrecognized lines that carry
 * no timestamp of their own: the first timestamp anywhere in the transcript
 * (stable across rescans), falling back to the file mtime. Claude lines
 * almost always carry a timestamp, so this is a rarely-hit safety net.
 */
function firstTimestamp(lines: string[]): string | null {
  for (const text of lines) {
    if (!text.trim()) continue;
    try {
      const parsed = JSON.parse(text) as ClaudeTranscriptLine;
      if (typeof parsed.timestamp === "string" && !Number.isNaN(Date.parse(parsed.timestamp))) {
        return parsed.timestamp;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** File mtime as ISO, else now — last-resort deterministic-ish base time. */
async function sessionMtime(transcriptPath: string): Promise<string> {
  try {
    return (await stat(transcriptPath)).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * The agent facts this line states about itself. Claude Code stamps every
 * transcript line with the CLI `version`, and labels assistant lines with the
 * model that produced them; user lines carry no model, and none is invented
 * for them — the model that will answer a prompt is not knowable from the
 * prompt's own line, and the session's model can change mid-conversation.
 * The provider is never stated (the same CLI can talk to the first-party API,
 * Bedrock, or Vertex), so `provider` is left unset rather than assumed.
 *
 * Values pass through verbatim, including Claude Code's `"<synthetic>"`
 * placeholder for harness-generated assistant messages: that is a true and
 * useful statement about the turn ("no model produced this"), and rewriting
 * it would be interpretation.
 */
function agentContext(line: ClaudeTranscriptLine): ProducerAgentContext {
  const agent: ProducerAgentContext = {};
  if (typeof line.version === "string" && line.version) agent.source_version = line.version;
  const model = line.message?.model;
  if (typeof model === "string" && model) agent.model = model;
  return agent;
}

/**
 * Which conversation a line belongs to.
 *
 * Sidechain lines are a subagent's conversation, not the parent's. They were
 * dropped outright until now, which lost every subagent turn in every session
 * — often most of the work in an agent-heavy transcript. They are recorded as
 * their own conversation, keyed by the `agentId` Claude Code stamps on them,
 * pointing back at the session that spawned them. That keeps `show` able to
 * read one subagent in isolation while `show <session-prefix>` still matches
 * parent and children together, and it keeps a subagent's turns out of the
 * parent's turn sequence, where they never belonged.
 */
function conversationFor(
  line: ClaudeTranscriptLine,
  sessionId: string,
): { id: string; parent?: string } {
  const root = `claude-code:${sessionId}`;
  if (line.isSidechain !== true) return { id: root };
  const agentId = typeof line.agentId === "string" && line.agentId ? line.agentId : "unknown";
  return { id: `${root}#agent:${agentId}`, parent: root };
}

/**
 * Where Claude Code keeps the bytes a file-history line points at:
 * `<config>/file-history/<session>/<backup file>`.
 *
 * `<config>` is derived from the transcript path rather than assumed to be
 * `~/.claude`, so a `CLAUDE_CONFIG_DIR` override still resolves. It is found
 * by walking up to the `projects` directory rather than by counting segments,
 * because transcripts sit at two different depths: a session is
 * `<config>/projects/<escaped cwd>/<session>.jsonl`, but a subagent is
 * `<config>/projects/<escaped cwd>/<session>/subagents/agent-<id>.jsonl`, and
 * a fixed number of `dirname` calls gets one of the two wrong.
 *
 * Returns null when no `projects` ancestor is there to anchor on — a
 * hand-placed transcript, a test fixture — in which case there is no cache to
 * resolve against and the pointers are stored unresolved.
 */
function fileHistoryDir(transcriptPath: string, sessionId: string): string | null {
  let dir = dirname(transcriptPath);
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    if (basename(dir) === "projects") return join(parent, "file-history", sessionId);
    dir = parent;
  }
}

/**
 * Read one backup file and describe it: sha256 and size, never the bytes.
 *
 * Storing the digest rather than the content is the deliberate middle ground
 * between a dangling pointer (useless once the cache is pruned) and inlining
 * file bodies into git notes (which would grow the ledger without bound and
 * put whole source files through the redaction stack). A digest makes the
 * record self-verifying: a consumer that still has the bytes — from the cache,
 * from a git object, from its own copy — can prove they are the ones this
 * event refers to.
 *
 * Returns null when the backup is gone or unreadable, which is expected: the
 * cache is Claude Code's to prune.
 */
async function resolveBackup(dir: string, backupFileName: string): Promise<ResolvedFile | null> {
  try {
    const bytes = await readFile(join(dir, backupFileName));
    return { backup_file: backupFileName, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  } catch {
    return null;
  }
}

/** Flatten a source backup record into the ledger's file shape. */
function snapshotFile(path: string, backup: ClaudeFileBackup | undefined): SnapshotFile {
  const file: SnapshotFile = { path };
  if (typeof backup?.realParentDir === "string") file.dir = backup.realParentDir;
  if (typeof backup?.version === "number") file.version = backup.version;
  if (typeof backup?.backupTime === "string") file.backup_time = backup.backupTime;
  file.backup_file = typeof backup?.backupFileName === "string" ? backup.backupFileName : null;
  return file;
}

/**
 * The file versions one file-history line names, and what the ledger could
 * read of them. `snapshot` lines state every tracked file (an empty set is
 * itself a fact — nothing was tracked at that message); `delta` lines state
 * one file's new version.
 */
async function fileSnapshotRecord(
  line: ClaudeTranscriptLine,
  ctx: RecordContext,
  historyDir: string | null,
): Promise<EventDraft> {
  const isDelta = line.type === "file-history-delta";
  const files: SnapshotFile[] = isDelta
    ? [snapshotFile(line.trackingPath ?? "", line.backup)]
    : Object.entries(line.snapshot?.trackedFileBackups ?? {}).map(([path, backup]) =>
        snapshotFile(path, backup),
      );

  const resolvedFiles: ResolvedFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const name = file.backup_file;
    if (historyDir === null || typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    const resolved = await resolveBackup(historyDir, name);
    if (resolved) resolvedFiles.push(resolved);
  }

  const detail: { message_id?: string; snapshot_message_id?: string; is_update?: boolean } = {};
  const messageId = line.messageId ?? line.snapshot?.messageId;
  if (typeof messageId === "string") detail.message_id = messageId;
  if (typeof line.snapshotMessageId === "string") detail.snapshot_message_id = line.snapshotMessageId;
  if (typeof line.isSnapshotUpdate === "boolean") detail.is_update = line.isSnapshotUpdate;

  return fileSnapshotDraft(ctx, isDelta ? "delta" : "snapshot", detail, files, line, resolvedFiles);
}

/**
 * Convert a line that is not a `user`/`assistant` turn into the record it
 * deserves, or return null when the type is genuinely unknown (the caller
 * then routes it to the drift path).
 *
 * `system` lines split on whether they carry text. Claude Code uses the type
 * for two unrelated things: printing into the conversation (a slash command's
 * stdout, an away summary, a refusal fallback — all of which the user read,
 * so they are turns spoken by the system) and recording harness bookkeeping
 * (turn durations, hook summaries — which nobody read, so they are activity).
 * A string `content` field is exactly the difference, so that is the test,
 * rather than a subtype list that would go stale the moment Claude Code adds
 * a subtype.
 */
function convertRecordLine(line: ClaudeTranscriptLine, ctx: RecordContext): EventDraft | null {
  const type = line.type;
  if (typeof type !== "string") return null;
  const fields = payloadFields(line as unknown as Record<string, unknown>);

  if (type === "system") {
    if (typeof line.content === "string" && line.content.trim() !== "") {
      return recordDraft(
        ctx,
        "conversation_turn",
        "system",
        { ...liftText(fields, "content"), role: "system" },
        line,
      );
    }
    return activityDraft(ctx, `system/${line.subtype ?? "untyped"}`, fields, line);
  }

  if (type === "attachment") {
    const attachmentType = line.attachment?.type;
    return contextInjectionDraft(
      ctx,
      `attachment/${typeof attachmentType === "string" ? attachmentType : "untyped"}`,
      fields,
      line,
    );
  }

  if (SESSION_STATE_LINE_TYPES.has(type)) {
    return sessionStateDraft(ctx, type, fields, line);
  }

  if (ACTIVITY_LINE_TYPES.has(type)) {
    // A `queue-operation` enqueue carries the queued prompt or task
    // notification verbatim — the one activity type that is mostly text.
    return activityDraft(ctx, type, liftText(fields, "content"), line);
  }

  return null;
}

/** Raw-only preservation event for an unrecognized claude-code line (see drift.ts). */
function preserve(
  type: string,
  line: ClaudeTranscriptLine,
  occurredAt: string,
  seq: number,
  fileSessionId: string,
  version: string,
): EventDraft {
  const sessionId = line.sessionId ?? fileSessionId;
  const conversation = conversationFor(line, sessionId);
  return unrecognizedDraft({
    typeKey: type,
    line,
    occurredAt,
    source: "claude-code",
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
 * The `RecordContext` a non-turn line converts under. Split out so the
 * capture loop and the re-normalization hook build it identically — the
 * context feeds `conversation` and `occurred_at`, both of which are part of
 * event identity, so any divergence between the two paths would mint a second
 * copy of an event instead of deduping against the first.
 */
function recordContext(
  line: ClaudeTranscriptLine,
  occurredAt: string,
  seq: number,
  fileSessionId: string,
  version: string,
): RecordContext {
  const sessionId = line.sessionId ?? fileSessionId;
  const conversation = conversationFor(line, sessionId);
  return {
    occurredAt,
    source: "claude-code",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: conversation.id,
    ...(conversation.parent ? { parentConversationId: conversation.parent } : {}),
    agent: agentContext(line),
  };
}

/**
 * A `user`/`assistant` line, as a turn.
 *
 * Sidechain lines convert here now rather than being dropped: they are the
 * subagent's side of the conversation, and the only reason to skip them was
 * that the ledger had no way to say whose subagent they were. `conversationFor`
 * gives them one. The subagent *type* Claude Code attributes an assistant
 * sidechain line to (`attributionAgent`, e.g. "Explore") goes in `content`
 * beside `role`, where opencode's agent persona already lives — it describes
 * which agent spoke, which `producer` (the capture tool and the model) has no
 * field for.
 */
function convertLine(
  line: ClaudeTranscriptLine,
  seq: number,
  version: string,
  identity: GitUserIdentity,
): EventDraft | null {
  if (line.type !== "user" && line.type !== "assistant") return null;
  if (!line.message) return null;
  if (typeof line.timestamp !== "string") return null;
  const sessionId = line.sessionId ?? "";
  const conversation = conversationFor(line, sessionId);
  const isSidechain = line.isSidechain === true;

  const actor: Actor = line.type === "user" ? { type: "human" } : { type: "agent" };
  // A sidechain `user` line is the harness handing a subagent its prompt, not
  // the person typing; attributing it to the git identity would put words in
  // their mouth. Every other user line is theirs.
  if (line.type === "user" && !isSidechain) {
    if (identity.email) actor.id = identity.email;
    if (identity.name) actor.display = identity.name;
  }
  if (line.type === "user" && isSidechain) actor.type = "system";
  if (line.type === "assistant" && line.message.model) actor.id = line.message.model;

  return {
    kind: "conversation_turn",
    occurred_at: line.timestamp,
    actor,
    producer: {
      tool: "cledger",
      version,
      source: "claude-code",
      session_id: sessionId,
      ...agentContext(line),
    },
    conversation: { id: conversation.id, seq, ...(conversation.parent ? { parent: conversation.parent } : {}) },
    content: {
      role: line.message.role,
      ...(typeof line.attributionAgent === "string" && line.attributionAgent
        ? { agent: line.attributionAgent }
        : {}),
      blocks: convertContentBlocks(line.message.content),
    },
    raw: { format: RAW_FORMAT, data: line },
  };
}

/**
 * Re-normalization hook (see renormalize.ts): given a preserved
 * `unrecognized` event this adapter's `producer.source` owns, try to turn its
 * stored `raw.data` into the `conversation_turn` a live capture would produce.
 *
 * Id fidelity is the whole point: `convertLine` is fed the exact inputs the
 * capture loop used — the same source line (`raw.data`), the same seq
 * (`conversation.seq`), the same session id (carried in the line) — so the
 * turn's identity subset, and therefore its id, is byte-identical to what a
 * later live capture of the same line yields, and the two dedup instead of
 * duplicating. `version`/`identity` are the current ones (version is not part
 * of identity; identity is the same git identity a live capture here would
 * read). Returns null when this adapter still cannot interpret the line —
 * timestampless lines included, since `convertLine` requires a timestamp — in
 * which case it stays preserved raw-only.
 *
 * Non-turn types (`worktree-state`, `pr-link`, and the rest that reached
 * ledgers as `unrecognized` before this adapter knew them) re-normalize too,
 * into whichever record kind they now map to. Their `RecordContext` is rebuilt
 * from the preserved event rather than from the line: `occurred_at` is the
 * value the preservation path computed, including the session-base-time
 * fallback for a line with no timestamp of its own, so the reconstructed
 * record lands on the same instant and therefore the same id.
 *
 * `file_snapshot` is the one type deliberately left out. Its identity would be
 * fine, but its `resolved` digests would not: the backup cache the pointers
 * name is long pruned by the time anyone runs `renormalize`, so the upgrade
 * would produce a snapshot record with no digests and permanently displace the
 * preserved line that could have been resolved by a timelier capture. Leaving
 * it preserved keeps the raw pointers intact and loses nothing.
 */
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  if (!event.raw || event.conversation === undefined) return null;
  const line = event.raw.data as ClaudeTranscriptLine;
  const version = packageVersion();
  const turn = convertLine(line, event.conversation.seq, version, identity);
  if (turn) return turn;
  if (typeof line.type === "string" && FILE_HISTORY_LINE_TYPES.has(line.type)) return null;
  return convertRecordLine(
    line,
    recordContext(
      line,
      event.occurred_at,
      event.conversation.seq,
      event.producer.session_id ?? "",
      version,
    ),
  );
}

/**
 * Capture any *other* session in this project whose transcript has grown
 * since it was last read.
 *
 * This exists because a session's own last lines are unreachable to it. The
 * hook fires, capture reads to end-of-file, and Claude Code then writes more
 * — the closing bookkeeping of the final turn, and crucially the session's
 * last `file-history-snapshot`, which is the most complete one it will ever
 * write. No further hook fires for that session, so those lines sat stranded
 * behind a cursor nothing would ever advance again. Observed live: a cursor
 * resting at line 40 of a 50-line transcript, with the only snapshot naming a
 * real backup at line 49.
 *
 * The next session in the same project closes the gap. Staleness is decided
 * by file size against the size recorded with the cursor, so the sweep stats
 * each transcript rather than parsing it, and reads only the ones that grew.
 *
 * Failures are swallowed per session: a sweep is a bonus pass over
 * conversations the user is not currently having, and must never be the
 * reason their live capture reports an error.
 */
async function sweepStaleTranscripts(
  transcriptPath: string,
  cwd: string,
  seen: Set<string>,
): Promise<void> {
  const repo = await findRepo(cwd);
  if (!repo) return;
  let entries: string[];
  try {
    entries = await readdir(dirname(transcriptPath));
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dirname(transcriptPath), name);
    if (seen.has(path)) continue;
    try {
      const cursor = await readCursor(repo, basename(name, ".jsonl"));
      const info = await stat(path);
      if (info.size <= cursor.size) continue; // nothing new since the last read
      await captureClaudeTranscript(path, cwd, seen);
    } catch {
      continue;
    }
  }
}

export async function runClaudeCodeHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as ClaudeCodeHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    if (!payload.transcript_path) return;
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    const seen = new Set<string>();
    await captureClaudeTranscript(payload.transcript_path, cwd, seen);
    await sweepStaleTranscripts(payload.transcript_path, cwd, seen);
  } catch (err) {
    process.stderr.write(
      `cledger: claude-code hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Capture one transcript file. Does not print, does not follow subagents —
 * `captureClaudeTranscript` wraps this to do both.
 */
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
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sessionId = basename(transcriptPath, ".jsonl");
  const stored = await readCursor(repo, sessionId);
  let cursor = stored.lines;
  if (cursor > lines.length) cursor = 0; // transcript is shorter than expected — rescan from the start

  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  let baseTime: string | null = null; // computed lazily, only if a timestampless unrecognized line needs it
  const drafts: EventDraft[] = [];
  for (let i = cursor; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    let parsed: ClaudeTranscriptLine;
    try {
      parsed = JSON.parse(text) as ClaudeTranscriptLine;
    } catch {
      continue; // partial line — normal at the tail of a live transcript
    }
    const type = typeof parsed.type === "string" ? parsed.type : "(untyped)";
    if (!CONVERTIBLE_LINE_TYPES.has(type)) {
      // Most non-turn lines carry no timestamp of their own, so the session
      // base time is now needed on the common path rather than the rare one;
      // it stays lazy so a transcript of nothing but turns never computes it.
      if (baseTime === null) baseTime = firstTimestamp(lines) ?? (await sessionMtime(transcriptPath));
      const occurredAt = typeof parsed.timestamp === "string" ? parsed.timestamp : baseTime;
      const ctx = recordContext(parsed, occurredAt, i, sessionId, version);

      if (FILE_HISTORY_LINE_TYPES.has(type)) {
        drafts.push(await fileSnapshotRecord(parsed, ctx, fileHistoryDir(transcriptPath, ctx.sessionId)));
        continue;
      }
      const record = convertRecordLine(parsed, ctx);
      if (record) {
        drafts.push(record);
        continue;
      }
      // Neither a turn nor a type this adapter knows: preserve raw and warn.
      countUnrecognized(result.unrecognized, type);
      drafts.push(preserve(type, parsed, occurredAt, i, sessionId, version));
      continue;
    }
    const draft = convertLine(parsed, i, version, identity);
    if (draft) drafts.push(draft);
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  await writeCursor(repo, sessionId, lines.length, Buffer.byteLength(raw));
  return result;
}

/**
 * Subagent transcripts belonging to a session.
 *
 * Claude Code writes a subagent's turns to
 * `<dir>/<session>/subagents/agent-<id>.jsonl` — a sibling of the session
 * transcript, never mentioned in it and never named by the hook payload,
 * which carries only the main `transcript_path`. Nothing pointed capture at
 * these files, so every subagent conversation was invisible no matter how
 * well the adapter could convert its lines. (Older Claude Code versions
 * inlined the same content as `isSidechain` lines in the main transcript;
 * both layouts convert identically, since the lines carry the same fields.)
 */
async function subagentTranscripts(transcriptPath: string): Promise<string[]> {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".jsonl")).sort().map((name) => join(dir, name));
  } catch {
    return []; // no subagents ran, or an older layout
  }
}

/**
 * Capture a Claude Code session: the transcript itself, then every subagent
 * transcript beneath it, depth-first.
 *
 * `seen` guards the recursion, which is otherwise unbounded — a subagent may
 * spawn its own subagents, and the directory layout nests accordingly.
 */
export async function captureClaudeTranscript(
  transcriptPath: string,
  cwd: string,
  seen: Set<string> = new Set(),
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");

  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const queue = [transcriptPath];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    mergeCaptureResult(total, await captureTranscriptFile(repo, path));
    queue.push(...(await subagentTranscripts(path)));
  }

  process.stderr.write(
    `cledger: claude-code +${total.appended} events (${total.deduped} deduped)\n`,
  );
  warnUnrecognized("claude-code", total.unrecognized);
  return total;
}
