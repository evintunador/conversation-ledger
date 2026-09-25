/**
 * cledger's binding of annals' redaction/scan/allowlist stack to its
 * namespace: same flat RepoInfo surface as store.ts, one module.
 */
import * as A from "annals";
import type { AnnalsConfig, RepoInfo } from "annals";
import { asLedger, CLEDGER_NAMESPACE } from "./ledger.js";

export {
  captureRules,
  collectEnvValues,
  collectMatches,
  collectStrings,
  filterFindings,
  FIXTURE_MARKER_RE,
  formatFinding,
  formatGroupedReport,
  groupFindings,
  inAgentSession,
  isExemptFromRedaction,
  redactDraft,
  redactText,
  renderFinding,
  scanEvents,
  walkStrings,
} from "annals";
export type {
  AnnalsConfig,
  ExtraValueGroup,
  Finding,
  FingerprintGroup,
  KnownSecretDigest,
  KnownSecrets,
  RedactionRecord,
  RenderOptions,
} from "annals";
/** Pre-extraction name, kept for older imports. */
export type CledgerConfig = AnnalsConfig;

export function loadConfig(repo: RepoInfo): Promise<AnnalsConfig> {
  return A.loadConfig(asLedger(repo));
}

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

export function loadKnownSecrets(repo: RepoInfo): Promise<A.KnownSecrets> {
  return A.loadKnownSecrets(asLedger(repo));
}

export function addKnownSecrets(repo: RepoInfo, values: string[]): Promise<void> {
  return A.addKnownSecrets(asLedger(repo), values);
}
