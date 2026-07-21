import { canonicalJson, sha256Hex } from "./canonical.js";
import type { RedactionRecord } from "./redact/apply.js";

export const SCHEMA_VERSION = "conversation-ledger/v1";

/**
 * The well-known event kinds. `kind` is an open string so downstream tools
 * can extend the ledger without a schema release; unknown kinds are stored
 * verbatim. The ledger never interprets content, whatever the kind.
 *
 * `unrecognized` is the one kind the ledger emits for content it could *not*
 * interpret: an adapter that meets a transcript line type it has no mapping
 * for preserves the line raw-only under `raw.data` rather than dropping it,
 * so a later adapter version can re-normalize (and supersede) it. Its
 * `content` carries only a `{unrecognized_type}` label — the payload lives in
 * `raw` — but identity still separates distinct lines via `conversation.seq`.
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
] as const;

export interface Actor {
  /** "human" | "agent" | "system" */
  type: string;
  /** Stable identity when known, e.g. git author email or model id. */
  id?: string;
  display?: string;
}

export interface Producer {
  /** Capture tool that wrote this event, e.g. "cledger". */
  tool: string;
  /** Capture tool version. Not part of event identity. */
  version?: string;
  /** Source system the content came from, e.g. "claude-code", "codex". */
  source?: string;
  /** Source system's native session identifier. */
  session_id?: string;
}

export interface RepoContext {
  /** Best-known repository identity (origin URL or top-level dir name). */
  repo?: string;
  branch?: string;
  /** HEAD commit SHA at capture time. */
  head?: string;
  /** Working directory the conversation ran in. */
  cwd?: string;
  /** sha256 of `git status --porcelain` output when the tree was dirty. */
  dirty_fingerprint?: string;
}

export interface ConversationRef {
  /** Namespaced conversation id, e.g. "claude-code:<session uuid>". */
  id: string;
  /** Stable ordering key within the conversation (source line index). */
  seq: number;
}

export interface EventLink {
  /** e.g. "redacts", "supersedes", "annotates", "replies_to" */
  rel: string;
  /** Target event id. */
  target: string;
}

export interface EvidenceEvent {
  /** "ev1-" + sha256 of the identity subset (see eventId). */
  id: string;
  schema: typeof SCHEMA_VERSION;
  kind: string;
  /** When the content happened, ISO 8601 UTC (from the source when known). */
  occurred_at: string;
  /** When this event was appended to the ledger. Not part of identity. */
  recorded_at: string;
  actor: Actor;
  producer: Producer;
  /** IANA media type of `content`; defaults to application/json. */
  media_type?: string;
  /** The visible content itself, stored inline and never reinterpreted. */
  content: unknown;
  /** Repository context at capture time. Not part of identity. */
  context?: RepoContext;
  conversation?: ConversationRef;
  links?: EventLink[];
  /**
   * Opaque source-native payload for lossless export, e.g. the original
   * transcript line(s). Versioned by `format`. Not part of identity.
   */
  raw?: { format: string; data: unknown };
  /**
   * Capture-time redaction records (rule id, ruleset version, fingerprint,
   * location path), present when the capture-tier ruleset rewrote part of
   * `content`/`raw.data` before this event was finalized. Deliberately
   * excluded from the identity subset: the rewritten `content` already
   * determines `id`, so including this here would double-count the same
   * fact and would churn ids on ruleset upgrades even when the visible
   * content is unchanged.
   */
  redactions?: RedactionRecord[];
}

/** Fields an adapter supplies; id/schema/recorded_at are filled at append. */
export type EventDraft = Omit<EvidenceEvent, "id" | "schema" | "recorded_at"> &
  Partial<Pick<EvidenceEvent, "id" | "schema" | "recorded_at">>;

/**
 * Event identity is derived from the durable, source-determined subset so
 * that re-scanning the same source material always yields the same id
 * (idempotent capture). Volatile provenance — recorded_at, context, raw,
 * producer.version/tool — is deliberately excluded: a re-ingestion under a
 * different HEAD or adapter version must dedup, not duplicate.
 */
export function eventId(event: EventDraft): string {
  const identity = {
    schema: SCHEMA_VERSION,
    kind: event.kind,
    occurred_at: event.occurred_at,
    actor: { type: event.actor.type, id: event.actor.id },
    source: event.producer.source,
    session_id: event.producer.session_id,
    conversation: event.conversation,
    media_type: event.media_type,
    content: event.content,
    links: event.links,
  };
  return "ev1-" + sha256Hex(canonicalJson(identity));
}

export function finalizeEvent(draft: EventDraft, now = new Date()): EvidenceEvent {
  const event: EvidenceEvent = {
    ...draft,
    id: draft.id ?? eventId(draft),
    schema: SCHEMA_VERSION,
    recorded_at: draft.recorded_at ?? now.toISOString(),
  };
  const problems = validateEvent(event);
  if (problems.length > 0) {
    throw new Error(`invalid event: ${problems.join("; ")}`);
  }
  return event;
}

export function validateEvent(event: EvidenceEvent): string[] {
  const problems: string[] = [];
  if (!event.id?.startsWith("ev1-")) problems.push("id must start with ev1-");
  if (event.schema !== SCHEMA_VERSION) problems.push(`schema must be ${SCHEMA_VERSION}`);
  if (!event.kind) problems.push("kind is required");
  if (!isIsoDate(event.occurred_at)) problems.push("occurred_at must be ISO 8601");
  if (!isIsoDate(event.recorded_at)) problems.push("recorded_at must be ISO 8601");
  if (!event.actor?.type) problems.push("actor.type is required");
  if (!event.producer?.tool) problems.push("producer.tool is required");
  if (event.content === undefined) problems.push("content is required");
  return problems;
}

function isIsoDate(s: unknown): boolean {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

/** One event per line, canonical bytes — the note storage format. */
export function serializeEvent(event: EvidenceEvent): string {
  return canonicalJson(event);
}

export function parseEventLine(line: string): EvidenceEvent {
  return JSON.parse(line) as EvidenceEvent;
}
