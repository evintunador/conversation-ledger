import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForgeDriver, ForgePullRequest } from "./forge.js";

const execFileP = promisify(execFile);

/**
 * A hung network call must not hang the command; past this the driver
 * reports unavailable and the caller falls back to offline evidence.
 */
const GH_TIMEOUT_MS = 10_000;

export function isGitHubOrigin(url: string): boolean {
  return /github\.com[:/]/.test(url);
}

/** Run `gh`; null on any failure (missing binary, no auth, network, timeout). */
async function gh(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("gh", args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * GitHub via the user's own `gh` CLI session — cledger never touches
 * credentials. `gh` resolves which GitHub repo from the cwd's origin.
 */
export function githubDriver(repoRoot: string): ForgeDriver {
  return {
    name: "github",
    async pullRequestsForBranch(branch: string): Promise<ForgePullRequest[] | null> {
      const out = await gh(
        [
          "pr", "list", "--head", branch, "--state", "all", "--limit", "10",
          "--json", "number,title,state,headRefName,url",
        ],
        repoRoot,
      );
      if (out === null) return null;
      let rows: unknown;
      try {
        rows = JSON.parse(out);
      } catch {
        return null;
      }
      if (!Array.isArray(rows)) return null;

      const prs: ForgePullRequest[] = [];
      for (const row of rows as Record<string, unknown>[]) {
        if (typeof row["number"] !== "number") continue;
        const pr: ForgePullRequest = {
          number: row["number"],
          title: String(row["title"] ?? ""),
          state: String(row["state"] ?? "").toUpperCase(),
          headBranch: String(row["headRefName"] ?? branch),
          ...(typeof row["url"] === "string" ? { url: row["url"] } : {}),
        };
        // The squash/merge commit needs a second, per-PR call: `pr list`
        // does not expose mergeCommit, `pr view` does.
        if (pr.state === "MERGED") {
          const view = await gh(
            ["pr", "view", String(pr.number), "--json", "mergeCommit"],
            repoRoot,
          );
          if (view !== null) {
            try {
              const oid = (JSON.parse(view) as { mergeCommit?: { oid?: string } }).mergeCommit?.oid;
              if (typeof oid === "string" && /^[0-9a-f]{40}$/.test(oid)) pr.mergeCommit = oid;
            } catch {
              // evidence stays partial; the PR itself is still reportable
            }
          }
        }
        prs.push(pr);
      }
      return prs;
    },
  };
}
