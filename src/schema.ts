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

export {
  eventId,
  finalizeEvent,
  parseEventLine,
  serializeEvent,
  validateEvent,
  SCHEMA_VERSION,
} from "annals";
export type {
  Actor,
  EventDraft,
  EventLink,
  EvidenceEvent,
  Producer,
  ProducerAgentContext,
  RepoContext,
  StreamRef,
} from "annals";
/** Pre-extraction name for StreamRef: for cledger a stream is a conversation. */
export type { StreamRef as ConversationRef } from "annals";
