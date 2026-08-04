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
 *
 * `reasoning` is for content the ledger deliberately never interprets: a
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
  /**
   * The source system's own version — the coding CLI's version, not
   * cledger's (that is `version`), e.g. "2.1.220" for claude-code or
   * "0.145.0" for codex. Not part of event identity.
   */
  source_version?: string;
  /**
   * Model that served this turn, verbatim as the source names it, e.g.
   * "claude-opus-5" or "gpt-5.6-sol". Set only when the source states it
   * for this turn — never guessed, never carried across turns the source
   * did not label. Not part of event identity.
   */
  model?: string;
  /**
   * Inference provider serving `model`, verbatim as the source names it,
   * e.g. "openai". Set only when the source states it — notably *not*
   * inferred from `source` or from the model id, since the same CLI can be
   * pointed at a first-party API, a cloud reseller, or a local endpoint.
   * Not part of event identity.
   */
  provider?: string;
  /** Source system's native session identifier. */
  session_id?: string;
}

/**
 * The source-stated agent facts an adapter attaches to `producer`. Adapters
 * gather these from wherever the source records them — a per-line field, a
 * preceding session/turn-context line — and spread them onto every event
 * they emit for that part of the transcript.
 */
export type ProducerAgentContext = Pick<Producer, "source_version" | "model" | "provider">;

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
  /**
   * The conversation this one was spawned from, when it is a sub-conversation
   * — a Claude Code sidechain, an opencode subagent session. Sub-conversations
   * get their own `id` (so `show` can isolate one) and point back here (so a
   * consumer can reassemble the tree); both halves are needed because a
   * subagent's turns are neither part of its parent's turn sequence nor
   * meaningful without knowing whose subagent it was.
   *
   * Part of event identity, like the rest of `ConversationRef`: it is stated
   * by the source, stable across rescans, and distinguishes a subagent's turn
   * from an identical-looking parent turn.
   */
  parent?: string;
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
   * What the ledger could resolve, at capture time, of pointers the source
   * line only names. A Claude Code `file-history-snapshot` says a file's
   * bytes live at `<backup file>` under a machine-local cache directory; this
   * is where the sha256 and size the ledger read from that file go, so the
   * record can be verified later even though the cache itself is prunable and
   * unshareable.
   *
   * Excluded from the identity subset, and that exclusion is the point: the
   * same transcript line resolves differently on a machine without the cache,
   * or after the cache is pruned, and identity must answer "which piece of
   * source material is this", not "what could this machine see at the time".
   * Folding it in would make a rescan after a prune duplicate every snapshot
   * rather than dedup it.
   *
   * Holds derived facts about local state — digests, sizes, counts — never
   * file bodies: the redaction stack walks `content` and `raw.data`, not this,
   * so anything secret-bearing put here would bypass it.
   */
  resolved?: Record<string, unknown>;
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
 *
 * `producer.model`/`provider`/`source_version` are excluded for the same
 * reason even though they *are* source-determined and stable per line. They
 * were added after events had already been captured without them, so folding
 * them into identity would give the very same transcript line a different id
 * before and after the upgrade — a rescan would duplicate every pre-upgrade
 * turn rather than dedup it. Identity answers "which piece of source material
 * is this"; the model that served it is provenance about that material, not
 * a second copy of it.
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
