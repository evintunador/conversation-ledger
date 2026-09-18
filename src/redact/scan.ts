import * as A from "annals";
import type { AnnalsConfig } from "annals";
import { asLedger, CLEDGER_NAMESPACE } from "../ledger.js";
import type { RepoInfo } from "../git.js";

export {
  collectStrings,
  filterFindings,
  FIXTURE_MARKER_RE,
  formatFinding,
  formatGroupedReport,
  groupFindings,
  inAgentSession,
  renderFinding,
  scanEvents,
} from "annals";
export type { Finding, FingerprintGroup, RenderOptions } from "annals";

/** Guidance text with cledger's CLI named in the command hints. */
export function findingGuidance(eventIds: string[]): string {
  return A.findingGuidance(CLEDGER_NAMESPACE.cliName, eventIds);
}

export function loadAllowlist(repo: RepoInfo, config?: AnnalsConfig): Promise<Set<string>> {
  return A.loadAllowlist(asLedger(repo), config);
}

export function addToAllowlist(
  repo: RepoInfo,
  fingerprints: string[],
  scope: "local" | "global" = "local",
): Promise<void> {
  return A.addToAllowlist(asLedger(repo), fingerprints, scope);
}
