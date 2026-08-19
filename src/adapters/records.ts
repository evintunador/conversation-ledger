/**
 * Draft builders for the non-conversational record: the state a session
 * declares about itself, the things that happen in the harness around the
 * turns, the material the harness injects into the model's context, and the
 * intermediate file versions a session leaves behind.
 *
 * These are the counterpart to adapters/drift.ts. Drift handles line types an
 * adapter does *not* know: preserve raw, warn, hope a later version can read
 * them. Everything here is a type the adapter *does* know and has chosen to
 * record with structure. Keeping them apart matters for the drift warning to
 * stay meaningful — a warning that fires on every ordinary `mode` line stops
 * being a signal that the upstream format moved.
 *
 * Every builder produces content in the same two-part shape: a `*_type`
 * discriminator naming the source's own type verbatim, and the source's own
 * fields beside it. Adapters do not rename or reinterpret those fields; a
 * consumer that wants Claude Code's `permissionMode` reads `permissionMode`.
 * What the ledger adds is the kind, the ordering, and the provenance.
 *
 * `blocks` appears whenever a record carries human-readable text, using the
 * same `[{type: "text", text}]` shape `conversation_turn` uses. That is the
 * one concession to uniformity: a consumer extracting text across a ledger
 * should not need a per-kind special case to find it.
 */

import type { Actor, EventDraft, ProducerAgentContext } from "../schema.js";
import type { GitUserIdentity } from "../git.js";

/** What every record shares: where it came from and where it sits. */
export interface RecordContext {
  occurredAt: string;
  /** Source system, e.g. "claude-code". */
  source: string;
  sessionId: string;
  /** Position in the source material — line index, part index. */
  seq: number;
  /** cledger's own version. */
  version: string;
  rawFormat: string;
  conversationId: string;
  /** Parent conversation id, for sub-conversations (see ConversationRef). */
  parentConversationId?: string;
  agent?: ProducerAgentContext;
  /**
   * Who the person at the keyboard is. Used only for records attributed to
   * `human` — a record the human drove should name them for the same reason a
   * turn does, or the ledger says "a human did this" while declining to say
   * which one, which is worse than either alternative.
   */
  identity?: GitUserIdentity;
}

/**
 * The shared skeleton every record shares: provenance, conversation position,
 * and the verbatim source line under `raw`. Exported because a few source
 * types map onto an existing kind rather than a new one — Claude Code's
 * `system` lines that print into the conversation are `conversation_turn`s —
 * and those still want this exact envelope.
 */
export function recordDraft(
  ctx: RecordContext,
  kind: string,
  actorType: string,
  content: unknown,
  raw: unknown,
): EventDraft {
  const actor: Actor = { type: actorType };
  if (actorType === "human" && ctx.identity) {
    if (ctx.identity.email) actor.id = ctx.identity.email;
    if (ctx.identity.name) actor.display = ctx.identity.name;
  }
  return {
    kind,
    occurred_at: ctx.occurredAt,
    actor,
    producer: {
      tool: "cledger",
      version: ctx.version,
      source: ctx.source,
      session_id: ctx.sessionId,
      ...ctx.agent,
    },
    conversation: {
      id: ctx.conversationId,
      seq: ctx.seq,
      ...(ctx.parentConversationId ? { parent: ctx.parentConversationId } : {}),
    },
    content,
    raw: { format: ctx.rawFormat, data: raw },
  };
}

/**
 * Text blocks for a record, or nothing when there is no text to carry.
 * Empty and whitespace-only strings are dropped rather than stored as an
 * empty block — a block that renders as nothing is worse than no block,
 * because a consumer cannot tell it apart from real empty output.
 */
export function textBlocks(...texts: unknown[]): { blocks: unknown[] } | Record<string, never> {
  const blocks = texts
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .map((text) => ({ type: "text", text }));
  return blocks.length > 0 ? { blocks } : {};
}

/**
 * Move a source field's text into `blocks`, returning the remaining fields.
 * Lifting rather than copying: a queued prompt or a command's stdout can run
 * to kilobytes, and storing it under both its source field name and `blocks`
 * would double that for no gain — `raw.data` already holds the original
 * under its original name.
 */
export function liftText(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = fields[key];
  if (typeof value !== "string" || value.trim() === "") return fields;
  const { [key]: _lifted, ...rest } = fields;
  return { ...rest, ...textBlocks(value) };
}

/**
 * A declaration the session makes about itself, holding until restated.
 *
 * The actor is `system`: a mode change is the harness recording its own
 * configuration, not the user speaking, even when the user is what caused it.
 * Sources restate this constantly and each restatement is kept — `seq` makes
 * them distinct events, so "the mode was still `auto` here" survives as a
 * fact rather than collapsing into the first statement.
 */
export function sessionStateDraft(
  ctx: RecordContext,
  stateType: string,
  state: Record<string, unknown>,
  raw: unknown,
): EventDraft {
  // Discriminator last: a source field that happened to be named
  // `state_type` must not be able to overwrite the label the ledger set.
  return recordDraft(ctx, "session_state", "system", { ...state, state_type: stateType }, raw);
}

/**
 * Something that happened in the harness and is not a turn.
 *
 * The actor is `system` for harness bookkeeping and `agent` for things the
 * model drove (a task it started, a step it finished); callers pass whichever
 * the source supports, defaulting to `system` because most of this is the
 * harness talking about itself.
 */
export function activityDraft(
  ctx: RecordContext,
  activityType: string,
  detail: Record<string, unknown>,
  raw: unknown,
  actorType = "system",
): EventDraft {
  return recordDraft(ctx, "activity", actorType, { ...detail, activity_type: activityType }, raw);
}

/**
 * Material that entered the model's context as something other than a turn.
 *
 * What separates this from `activity` is that the model read it — a consumer
 * reconstructing what the model knew at a point in the conversation needs
 * these, and does not need turn durations.
 *
 * The actor defaults to `system` because most of it is the harness stuffing
 * its own preamble in, but it is a parameter for the same reason
 * `activityDraft`'s is: an injection can be something a person asked for by
 * name (Qwen's `@file` command), and filing that as the machine's doing loses
 * the one fact that distinguishes it from a bootstrap prompt.
 */
export function contextInjectionDraft(
  ctx: RecordContext,
  injectionType: string,
  injection: Record<string, unknown>,
  raw: unknown,
  actorType = "system",
): EventDraft {
  return recordDraft(
    ctx,
    "context_injection",
    actorType,
    { ...injection, injection_type: injectionType },
    raw,
  );
}

/** One file version a snapshot record points at. */
export interface SnapshotFile {
  /** Path as the source states it — relative to the project for snapshots,
   *  absolute for deltas. Left exactly as stated rather than normalized. */
  path: string;
  /** Directory the file really lived in, when the source states it. */
  dir?: string;
  /** Source's own version counter for this file within the session. */
  version?: number;
  /** When the source took the backup, ISO 8601. */
  backup_time?: string;
  /**
   * Name of the backup file in the source's local cache. A pointer, not
   * content: the cache is machine-local and prunable, so this is stored for
   * traceability while `resolved` carries what the ledger could actually read
   * from it. Null when the source recorded no backup (a tracked file it had
   * not yet copied).
   */
  backup_file?: string | null;
}

/** What the ledger read from a backup file, keyed by the pointer that named it. */
export interface ResolvedFile {
  backup_file: string;
  sha256: string;
  bytes: number;
}

/**
 * Intermediate file state: the versions a file passed through between
 * commits.
 *
 * `operation` distinguishes the source's two shapes — a full statement of
 * every tracked file (`snapshot`) from a single file's change (`delta`) —
 * because a consumer reconstructing file history needs to know whether an
 * absent file means "unchanged" or "no longer tracked".
 *
 * `resolved` is passed separately from `content` and stays out of event
 * identity on purpose (see EvidenceEvent.resolved): the digests come from a
 * cache that may be gone by the next rescan, and an id that moved when the
 * cache was pruned would duplicate every snapshot in the ledger.
 */
export function fileSnapshotDraft(
  ctx: RecordContext,
  operation: "snapshot" | "delta",
  detail: { message_id?: string; snapshot_message_id?: string; is_update?: boolean },
  files: SnapshotFile[],
  raw: unknown,
  resolvedFiles: ResolvedFile[],
): EventDraft {
  const draft = recordDraft(
    ctx,
    "file_snapshot",
    "system",
    { ...detail, operation, files },
    raw,
  );
  if (resolvedFiles.length > 0) draft.resolved = { files: resolvedFiles };
  return draft;
}
