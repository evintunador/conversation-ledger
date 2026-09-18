import * as A from "annals";
import type { RepoInfo, ReviewOptions, ReviewSummary } from "annals";
import { asLedger } from "./ledger.js";

export type { ReviewOptions, ReviewSummary } from "annals";
export { escapeLiteral, wrapRuns } from "annals";
export type { Run } from "annals";

export function runReview(repo: RepoInfo, opts: ReviewOptions): Promise<ReviewSummary> {
  return A.runReview(asLedger(repo), opts);
}
