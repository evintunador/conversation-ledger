/**
 * cledger's store: annals bound to the cledger namespace. Every function
 * here takes a plain RepoInfo and delegates with the namespace attached, so
 * callers (the CLI, the capture adapters, turnbridge) never handle a Ledger.
 */
import * as A from "annals";
import type { EventDraft, EvidenceEvent, ReadOptions, RepoContext, RepoInfo } from "annals";
import { asLedger, CLEDGER_NAMESPACE } from "./ledger.js";

export { ScanBlockedError, RedactAfterShareError, parsePrePushRefs, sortEvents } from "annals";
export type {
  AppendResult,
  ReadOptions,
  ReAnchorRunResult,
  RedactResult,
  SyncResult,
  TransportPushResult,
} from "annals";

export const NOTES_NAME = CLEDGER_NAMESPACE.name;
export const NOTES_REF = A.notesRef(CLEDGER_NAMESPACE);
export const INCOMING_REF = A.incomingRef(CLEDGER_NAMESPACE);

export function appendEvents(
  repo: RepoInfo,
  events: EventDraft[],
  opts: { context?: RepoContext; anchor?: string } = {},
): Promise<A.AppendResult> {
  return A.appendEvents(asLedger(repo), events, opts);
}

export function readEvents(repo: RepoInfo, opts: ReadOptions = {}): Promise<EvidenceEvent[]> {
  return A.readEvents(asLedger(repo), opts);
}

export function readPending(repo: RepoInfo): Promise<EvidenceEvent[]> {
  return A.readPending(asLedger(repo));
}

export function readNoteEvents(
  repo: RepoInfo,
  anchor: string,
  refName?: string,
): Promise<EvidenceEvent[]> {
  const ledger = asLedger(repo);
  return A.readNoteEvents(ledger, anchor, refName ?? ledger.ns.name);
}

export function listAnchors(repo: RepoInfo, refName?: string): Promise<string[]> {
  const ledger = asLedger(repo);
  return A.listAnchors(ledger, refName ?? ledger.ns.name);
}

export function captureContext(repo: RepoInfo): Promise<RepoContext> {
  return A.captureContext(asLedger(repo));
}

export function runReAnchor(
  repo: RepoInfo,
  opts: { target?: string; apply: boolean },
): Promise<A.ReAnchorRunResult> {
  return A.runReAnchor(asLedger(repo), opts);
}

export function manualReAnchor(
  repo: RepoInfo,
  supersededRevs: string[],
  ontoRev: string,
): Promise<{ event: EvidenceEvent | null; superseded: string[]; successor: string }> {
  return A.manualReAnchor(asLedger(repo), supersededRevs, ontoRev);
}

export function redactEvent(
  repo: RepoInfo,
  idPrefix: string,
  opts: { pattern?: string; all?: boolean; reason?: string },
): Promise<A.RedactResult> {
  return A.redactEvent(asLedger(repo), idPrefix, opts);
}

export function sync(
  repo: RepoInfo,
  remote = "origin",
  mode: "both" | "push" | "fetch" = "both",
  opts: { skipScan?: boolean; paranoid?: boolean; scope?: string | string[] | null } = {},
): Promise<A.SyncResult> {
  return A.sync(asLedger(repo), remote, mode, opts);
}

export function transportPush(
  repo: RepoInfo,
  remote: string,
  revs?: string[],
): Promise<A.TransportPushResult> {
  return A.transportPush(asLedger(repo), remote, revs);
}
