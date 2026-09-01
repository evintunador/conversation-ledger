import * as A from "annals";
import type { AnnalsConfig } from "annals";
import { asLedger } from "../ledger.js";
import type { RepoInfo } from "../git.js";

export { captureRules, collectEnvValues } from "annals";
export type { AnnalsConfig } from "annals";
/** Kept as an alias for pre-extraction imports. */
export type CledgerConfig = AnnalsConfig;

export function loadConfig(repo: RepoInfo): Promise<AnnalsConfig> {
  return A.loadConfig(asLedger(repo));
}
