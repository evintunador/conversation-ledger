import * as A from "annals";
import type { AnnalsConfig, RepoInfo, TransportSetup } from "annals";
import { asLedger } from "./ledger.js";

export { hasAuthorIdentity } from "annals";
export type { TransportSetup } from "annals";

export function ensureTransport(
  repo: RepoInfo,
  config: AnnalsConfig,
): Promise<TransportSetup | null> {
  return A.ensureTransport(asLedger(repo), config);
}

export function absorbIncoming(repo: RepoInfo): Promise<boolean> {
  return A.absorbIncoming(asLedger(repo));
}

export function ensureMergeConfig(repo: RepoInfo): Promise<void> {
  return A.ensureMergeConfig(asLedger(repo));
}
