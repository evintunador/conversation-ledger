import * as A from "annals";
import { asLedger } from "../ledger.js";
import type { RepoInfo } from "../git.js";

export function loadKnownSecrets(repo: RepoInfo): Promise<string[]> {
  return A.loadKnownSecrets(asLedger(repo));
}

export function addKnownSecrets(repo: RepoInfo, values: string[]): Promise<void> {
  return A.addKnownSecrets(asLedger(repo), values);
}
