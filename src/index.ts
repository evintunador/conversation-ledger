/** Public library surface for programmatic clients (e.g. turnbridge). */
export {
  appendEvents,
  readEvents,
  sortEvents,
  sync,
  transportPush,
  ScanBlockedError,
  listAnchors,
  readNoteEvents,
  captureContext,
} from "./store.js";
export type { AppendResult, ReadOptions, TransportPushResult } from "./store.js";
export { absorbIncoming, ensureTransport, INCOMING_REF, NOTES_NAME, NOTES_REF } from "./transport.js";
export type { TransportSetup } from "./transport.js";
export type { CaptureResult } from "./adapters/drift.js";
export {
  finalizeEvent,
  eventId,
  validateEvent,
  serializeEvent,
  parseEventLine,
} from "./schema.js";
export type { Actor, EventDraft, EvidenceEvent, RepoContext } from "./schema.js";
export {
  findRepo,
  headSha,
  currentBranch,
  repoIdentity,
  gitUserIdentity,
  git,
  GitError,
} from "./git.js";
export type { GitUserIdentity, RepoInfo } from "./git.js";
export { captureClaudeTranscript, runClaudeCodeHook } from "./adapters/claude-code.js";
export { captureCodexTranscript, runCodexHook } from "./adapters/codex.js";
export { renormalize } from "./renormalize.js";
export type { RenormalizeResult } from "./renormalize.js";
export { parseReAnchor, reAnchorDraft } from "./reanchor.js";
export type { ReAnchorMapping, ReAnchorDraftOptions } from "./reanchor.js";
