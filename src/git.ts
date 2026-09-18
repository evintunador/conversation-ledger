/** Re-exported from annals so cledger-internal imports keep one path. */
export {
  currentBranch,
  findRepo,
  git,
  GitError,
  gitUserIdentity,
  headSha,
  repoIdentity,
} from "annals";
export type { GitUserIdentity, RepoInfo } from "annals";
