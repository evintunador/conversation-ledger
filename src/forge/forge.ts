import { git, type RepoInfo } from "../git.js";
import { githubDriver, isGitHubOrigin } from "./github.js";

/**
 * A forge is the place PRs/MRs live (GitHub, GitLab, ...). The ledger core
 * never depends on one: forge metadata only ever *suggests* re-anchor
 * mappings in the explicit `cledger re-anchor` command — the auto read path
 * stays offline, and nothing a forge says is recorded until a human
 * confirms it. Drivers therefore degrade to null (unavailable) rather than
 * erroring: no CLI installed, not authenticated, offline, unknown host —
 * all mean "offline evidence only", never a failed command.
 */
export interface ForgePullRequest {
  number: number;
  title: string;
  /** "OPEN" | "MERGED" | "CLOSED" (normalized upper-case). */
  state: string;
  headBranch: string;
  url?: string;
  /** Full SHA of the merge/squash commit, when the forge reports one. */
  mergeCommit?: string;
}

export interface ForgeDriver {
  /** e.g. "github" — used in output so evidence names its source. */
  name: string;
  /**
   * PRs whose head is `branch`, any state. Null means the forge could not
   * be queried at all — distinct from [] (queried fine, no PRs).
   */
  pullRequestsForBranch(branch: string): Promise<ForgePullRequest[] | null>;
}

/** The driver for this repo's origin, or null when no driver matches. */
export async function forgeForRepo(repo: RepoInfo): Promise<ForgeDriver | null> {
  const originUrl = (await git(["remote", "get-url", "origin"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!originUrl) return null;
  if (isGitHubOrigin(originUrl)) return githubDriver(repo.root);
  return null;
}
