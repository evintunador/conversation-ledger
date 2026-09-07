/**
 * cledger's store: annals bound to the cledger namespace. Every function
 * here takes a plain RepoInfo and delegates with the namespace attached, so
 * callers (the CLI, the capture adapters, turnbridge) never handle a Ledger.
 */
import * as A from "annals";
import type { RepoContext, RepoInfo } from "annals";
import { asLedger, CLEDGER_NAMESPACE } from "./ledger.js";
import { fromAnnals, toAnnals, type EventDraft, type EvidenceEvent } from "./schema.js";

export { ScanBlockedError, RedactAfterShareError, parsePrePushRefs } from "annals";
export type { SyncResult, TransportPushResult } from "annals";

/** annals' options plus the cledger-vocabulary filters lifted from meta. */
export interface ReadOptions extends A.ReadOptions {
  /** Exact match on producer.source (a meta field on the wire). */
  source?: string;
  /** Exact match on producer.model; events without one are excluded. */
  model?: string;
}

export interface AppendResult {
  appended: EvidenceEvent[];
  deduped: number;
  anchor: string | null;
}

export interface ReAnchorRunResult extends Omit<A.ReAnchorRunResult, "applied"> {
  applied: EvidenceEvent[];
}

export interface RedactResult extends Omit<A.RedactResult, "event" | "redactionEvent"> {
  event: EvidenceEvent;
  redactionEvent: EvidenceEvent;
}

/** Stable order: stream, then seq, then time, then id. */
export function sortEvents(events: EvidenceEvent[]): EvidenceEvent[] {
  return A.sortEvents(events) as EvidenceEvent[];
}

export const NOTES_NAME = CLEDGER_NAMESPACE.name;
export const NOTES_REF = A.notesRef(CLEDGER_NAMESPACE);
export const INCOMING_REF = A.incomingRef(CLEDGER_NAMESPACE);

export async function appendEvents(
  repo: RepoInfo,
  events: EventDraft[],
  opts: { context?: RepoContext; anchor?: string } = {},
): Promise<AppendResult> {
  const result = await A.appendEvents(asLedger(repo), events.map(toAnnals), opts);
  return { ...result, appended: result.appended.map(fromAnnals) };
}

export async function readEvents(repo: RepoInfo, opts: ReadOptions = {}): Promise<EvidenceEvent[]> {
  const { source, model, ...annalsOpts } = opts;
  const events = (await A.readEvents(asLedger(repo), annalsOpts)).map(fromAnnals);
  if (source === undefined && model === undefined) return events;
  return events.filter(
    (e) =>
      (source === undefined || e.producer.source === source) &&
      (model === undefined || e.producer.model === model),
  );
}

export async function readPending(repo: RepoInfo): Promise<EvidenceEvent[]> {
  return (await A.readPending(asLedger(repo))).map(fromAnnals);
}

export async function readNoteEvents(
  repo: RepoInfo,
  anchor: string,
  refName?: string,
): Promise<EvidenceEvent[]> {
  const ledger = asLedger(repo);
  return (await A.readNoteEvents(ledger, anchor, refName ?? ledger.ns.name)).map(fromAnnals);
}

export function listAnchors(repo: RepoInfo, refName?: string): Promise<string[]> {
  const ledger = asLedger(repo);
  return A.listAnchors(ledger, refName ?? ledger.ns.name);
}

export function captureContext(repo: RepoInfo): Promise<RepoContext> {
  return A.captureContext(asLedger(repo));
}

export async function runReAnchor(
  repo: RepoInfo,
  opts: { target?: string; apply: boolean },
): Promise<ReAnchorRunResult> {
  const result = await A.runReAnchor(asLedger(repo), opts);
  return { ...result, applied: result.applied.map(fromAnnals) };
}

export async function manualReAnchor(
  repo: RepoInfo,
  supersededRevs: string[],
  ontoRev: string,
): Promise<{ event: EvidenceEvent | null; superseded: string[]; successor: string }> {
  const result = await A.manualReAnchor(asLedger(repo), supersededRevs, ontoRev);
  return { ...result, event: result.event ? fromAnnals(result.event) : null };
}

export async function redactEvent(
  repo: RepoInfo,
  idPrefix: string,
  opts: { pattern?: string; all?: boolean; reason?: string },
): Promise<RedactResult> {
  const result = await A.redactEvent(asLedger(repo), idPrefix, opts);
  return {
    ...result,
    event: fromAnnals(result.event),
    redactionEvent: fromAnnals(result.redactionEvent),
  };
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
