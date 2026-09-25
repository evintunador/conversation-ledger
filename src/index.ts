/** Public library surface for programmatic clients (e.g. turnbridge). */
export { asLedger, CLEDGER_NAMESPACE } from "./ledger.js";
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
  runReAnchor,
  manualReAnchor,
} from "./store.js";
export type { AppendResult, ReadOptions, ReAnchorRunResult, TransportPushResult } from "./store.js";
export { absorbIncoming, ensureTransport } from "./transport.js";
export { INCOMING_REF, NOTES_NAME, NOTES_REF } from "./store.js";
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
} from "annals";
export type { GitUserIdentity, RepoInfo } from "annals";
export { captureClaudeTranscript, runClaudeCodeHook } from "./adapters/claude-code.js";
export { captureCodexTranscript, runCodexHook } from "./adapters/codex.js";
export {
  captureOpencodeAll,
  captureOpencodeExport,
  captureOpencodeExportFile,
  captureOpencodeSession,
  exportOpencodeSession,
  listOpencodeSessions,
  runOpencodeHook,
} from "./adapters/opencode.js";
export type { OpencodeExport } from "./adapters/opencode.js";
export { renormalize } from "./renormalize.js";
export type { RenormalizeResult } from "./renormalize.js";
export { defaultRewriteTarget, detectRewrites, parseReAnchor, reAnchorDraft } from "annals";
export type {
  DetectedRewrite,
  DetectRewritesResult,
  ReAnchorMapping,
  ReAnchorDraftOptions,
  UnmatchedBranch,
} from "annals";
export { suggestMappings } from "annals";
export type { BranchSuggestions, Suggestion } from "annals";
export { forgeForRepo } from "annals";
export type { ForgeDriver, ForgePullRequest } from "annals";
