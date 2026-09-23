/**
 * cledger's vocabulary over the annals envelope. The envelope itself —
 * identity, serialization, validation — lives in annals and is re-exported
 * here; what this module owns is the set of kinds cledger writes and what
 * they mean. `kind` stays an open string: downstream tools extend the ledger
 * by writing their own kinds, identified by `(producer.tool, kind)`, without
 * a schema release here.
 *
 * `unrecognized` is the one kind cledger emits for content it could *not*
 * interpret: an adapter that meets a transcript line type it has no mapping
 * for preserves the line raw-only under `raw.data` rather than dropping it,
 * so a later adapter version can re-normalize (and supersede) it. Its
 * `content` carries only a `{unrecognized_type}` label — the payload lives in
 * `raw` — but identity still separates distinct lines via `stream.seq`.
 *
 * `reasoning` is for content cledger deliberately never interprets: a
 * provider-encrypted reasoning/thinking blob (e.g. Codex's `reasoning`
 * response_items) that only the originating provider can decrypt. Its
 * `content` carries only an opacity marker; the ciphertext lives in `raw`,
 * for a consumer to opt into replaying back through the same provider.
 * Unlike `unrecognized`, this is not a placeholder awaiting a smarter
 * cledger version — no future version will ever be able to read it either.
 *
 * The four kinds below `reasoning` cover what a source records *around* the
 * conversation. Every one of them was previously discarded at capture as
 * "bookkeeping"; they are kept because the ledger's job is the whole record,
 * and because the things a session declares about itself (which model, which
 * sandbox, which worktree) are exactly what a consumer needs to judge whether
 * a turn still applies. They are non-conversational by construction, so
 * `log`/`show` hide them unless asked — recorded always, displayed on request.
 *
 * `session_state` is a *declaration that holds until restated*: the session's
 * mode, permission mode, model settings, sandbox and approval policy, title,
 * worktree or cwd relocation. Sources restate these freely, and each
 * restatement is its own event — "still true at this point in the transcript"
 * is a fact, not a duplicate.
 *
 * `activity` is a *point-in-time occurrence that is not a turn*: a hook run,
 * a turn duration, a token count, a task starting or finishing, a queue
 * operation, a context compaction, an aborted turn, a step boundary.
 *
 * `context_injection` is material the harness inserted into the model's
 * context that no participant typed — Claude Code's `attachment` lines
 * (task reminders, skill listings, diagnostics, pasted files). It is content
 * the model read, which is why it is not `activity`, but nobody said it,
 * which is why it is not `conversation_turn`.
 *
 * `file_snapshot` is intermediate file state: the versions a file passed
 * through between commits. Tool calls cannot reconstruct this — a `Bash`
 * mutation records the command, not the result — so without it the record of
 * how a file got from one commit to the next has holes. Sources describe
 * these versions with pointers into a machine-local cache, so the pointers
 * live in `content` and what the ledger could resolve of them at capture time
 * lives in `resolved`.
 */
export const KNOWN_KINDS = [
  "conversation_turn",
  "decision",
  "document",
  "annotation",
  "redaction",
  "supersession",
  "re_anchor",
  "unrecognized",
  "reasoning",
  "session_state",
  "activity",
  "context_injection",
  "file_snapshot",
] as const;

/**
 * The kinds that record machinery around the conversation rather than
 * anything a participant said. `log`/`show` hide these unless `--with-state`
 * (or an explicit `--kind`) asks for them: a session restates its mode and
 * its tracked-file set constantly, and letting that outnumber the turns
 * ten-to-one would make the default view useless. Capture, export, and sync
 * are unaffected — this list is a display default, nothing more.
 */
export const SESSION_MACHINERY_KINDS = new Set<string>([
  "session_state",
  "activity",
  "context_injection",
  "file_snapshot",
]);

import * as A from "annals";

export { SCHEMA_VERSION } from "annals";
export type {
  EventLink,
  RepoContext,
  StreamRef,
} from "annals";
/** Pre-extraction name for StreamRef: for cledger a stream is a conversation. */
export type { StreamRef as ConversationRef } from "annals";

/** Who a record is about/by: "human" | "agent" | "system". cledger
 * vocabulary — the annals envelope has no actor; it rides in `meta`. */
export interface Actor {
  type: string;
  /** Stable identity when known, e.g. git author email or model id. */
  id?: string;
  display?: string;
}

/**
 * cledger's producer view. Only `tool`/`version` live on the annals
 * envelope; the rest is cledger vocabulary carried in `meta` — the
 * translation in this module folds it back and forth so adapters and
 * consumers keep one flat shape.
 */
export interface Producer {
  tool: string;
  version?: string;
  /** Source system the content came from, e.g. "claude-code", "codex". */
  source?: string;
  /** The source system's own version, e.g. the coding CLI's. */
  source_version?: string;
  /** Model that served this turn, verbatim, only when the source states it. */
  model?: string;
  /** Inference provider serving `model`, verbatim, never inferred. */
  provider?: string;
  /** Source system's native session identifier. */
  session_id?: string;
}

export type ProducerAgentContext = Pick<Producer, "source_version" | "model" | "provider">;

export interface EvidenceEvent extends Omit<A.EvidenceEvent, "producer"> {
  actor: Actor;
  producer: Producer;
}

/** Fields an adapter supplies; id/schema/recorded_at are filled at append. */
export type EventDraft = Omit<EvidenceEvent, "id" | "schema" | "recorded_at" | "actor"> &
  Partial<Pick<EvidenceEvent, "id" | "schema" | "recorded_at" | "actor">>;

const META_PRODUCER_KEYS = ["source", "source_version", "model", "provider", "session_id"] as const;

/** Fold cledger vocabulary (actor, producer extras) into the annals meta. */
export function toAnnals(draft: EventDraft): A.EventDraft {
  const { actor, producer, meta, ...rest } = draft;
  const outMeta: Record<string, unknown> = { ...(meta ?? {}) };
  if (actor && outMeta["actor"] === undefined) outMeta["actor"] = actor;
  for (const key of META_PRODUCER_KEYS) {
    const value = producer[key];
    if (value !== undefined && outMeta[key] === undefined) outMeta[key] = value;
  }
  const outProducer: A.Producer = { tool: producer.tool };
  if (producer.version !== undefined) outProducer.version = producer.version;
  return {
    ...rest,
    producer: outProducer,
    ...(Object.keys(outMeta).length > 0 ? { meta: outMeta } : {}),
  } as A.EventDraft;
}

/**
 * Lift the flat cledger shape back out of an annals event. Tolerant of
 * pre-extraction (ev1) lines, which carried `actor` and the full producer
 * at the top level rather than in `meta`.
 */
export function fromAnnals(event: A.EvidenceEvent): EvidenceEvent {
  const legacy = event as A.EvidenceEvent & { actor?: Actor; producer: Producer };
  const meta = { ...(event.meta ?? {}) };
  const actor = (meta["actor"] as Actor | undefined) ?? legacy.actor ?? { type: "unknown" };
  delete meta["actor"];
  const producer: Producer = { tool: event.producer.tool };
  if (event.producer.version !== undefined) producer.version = event.producer.version;
  for (const key of META_PRODUCER_KEYS) {
    const value = (meta[key] as string | undefined) ?? legacy.producer[key];
    if (value !== undefined) producer[key] = value;
    delete meta[key];
  }
  const out = { ...event, actor, producer } as EvidenceEvent;
  if (Object.keys(meta).length > 0) out.meta = meta;
  else delete out.meta;
  return out;
}

export function eventId(draft: EventDraft): string {
  return A.eventId(toAnnals(draft));
}

export function finalizeEvent(draft: EventDraft, now?: Date): EvidenceEvent {
  return fromAnnals(A.finalizeEvent(toAnnals(draft), now));
}

export function validateEvent(event: EvidenceEvent): string[] {
  const { id, schema, recorded_at, ...rest } = event;
  const annalsEvent = { ...toAnnals(rest as EventDraft), id, schema, recorded_at } as A.EvidenceEvent;
  return A.validateEvent(annalsEvent);
}

/** Canonical stored bytes — the annals shape, vocabulary folded into meta. */
export function serializeEvent(event: EvidenceEvent): string {
  const { id, schema, recorded_at, ...rest } = event;
  return A.serializeEvent({ ...toAnnals(rest as EventDraft), id, schema, recorded_at } as A.EvidenceEvent);
}

/** Parse a stored note line into the flat cledger shape. */
export function parseEventLine(line: string): EvidenceEvent {
  return fromAnnals(A.parseEventLine(line));
}
