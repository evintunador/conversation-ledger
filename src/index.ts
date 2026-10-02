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
export { capturePiTranscript, capturePiAll, runPiHook } from "./adapters/pi.js";
export { captureCopilotTranscript, captureCopilotAll, runCopilotHook } from "./adapters/copilot.js";
export { captureCursorTranscript, runCursorHook, runCursor } from "./adapters/cursor.js";
export { captureKimiTranscript, captureKimiAll, runKimiHook } from "./adapters/kimi.js";
export { captureKiroTranscript, captureKiroAll, captureKiroV3Transcript, captureKiroV3All, runKiroHook, runKiro } from "./adapters/kiro.js";
export { captureMistralVibeTranscript, captureMistralVibeAll, runMistralVibeHook } from "./adapters/mistral-vibe.js";
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

export { captureGooseTranscript, captureGooseAll, captureGooseSession } from "./adapters/goose.js";
export { captureDroidTranscript, captureDroidAll } from "./adapters/droid.js";
export { runAider, captureAiderTranscript, captureAiderAll } from "./adapters/aider.js";
export { captureClineTranscript, captureClineAll } from "./adapters/cline.js";
export { runContinue, captureContinueTranscript, captureContinueAll } from "./adapters/continue.js";
export { captureOpenHandsTranscript, captureOpenHandsAll } from "./adapters/openhands.js";
export { captureKiloExportFile, captureKiloSession, captureKiloAll } from "./adapters/kilo.js";

export { runCrush, captureCrushDatabase, captureCrushAll } from "./adapters/crush.js";

export { captureOpenInterpreterTranscript, captureOpenInterpreterAll } from "./adapters/open-interpreter.js";
