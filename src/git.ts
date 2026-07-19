import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
    public readonly code: number | undefined,
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  cwd: string;
  input?: string;
  allowFailure?: boolean;
}

export async function git(args: string[], opts: GitRunOptions): Promise<string> {
  try {
    const child = execFileP("git", args, {
      cwd: opts.cwd,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (opts.input !== undefined) {
      child.child.stdin?.write(opts.input);
      child.child.stdin?.end();
    }
    const { stdout } = await child;
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: number; message?: string };
    if (opts.allowFailure) return "";
    throw new GitError(
      `git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`,
      args,
      e.stderr ?? "",
      typeof e.code === "number" ? e.code : undefined,
    );
  }
}

export interface RepoInfo {
  root: string;
  gitDir: string;
}

/** Resolve the repo containing dir, or null when outside any git repo. */
export async function findRepo(dir: string): Promise<RepoInfo | null> {
  try {
    const root = (await git(["rev-parse", "--show-toplevel"], { cwd: dir })).trim();
    const gitDir = (await git(["rev-parse", "--absolute-git-dir"], { cwd: dir })).trim();
    return { root, gitDir };
  } catch {
    return null;
  }
}

/** HEAD commit SHA, or null on an unborn branch (no commits yet). */
export async function headSha(repo: RepoInfo): Promise<string | null> {
  const out = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: repo.root,
    allowFailure: true,
  });
  return out.trim() || null;
}

export async function currentBranch(repo: RepoInfo): Promise<string | null> {
  const out = (await git(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  return out && out !== "HEAD" ? out : null;
}

/** Best-known repository identity: origin URL, else top-level dir name. */
export async function repoIdentity(repo: RepoInfo): Promise<string> {
  const url = (await git(["remote", "get-url", "origin"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  return url || (repo.root.split("/").pop() ?? repo.root);
}

export async function statusPorcelain(repo: RepoInfo): Promise<string> {
  return git(["status", "--porcelain"], { cwd: repo.root, allowFailure: true });
}

/** Commit SHAs reachable from rev. */
export async function revList(repo: RepoInfo, rev: string): Promise<Set<string>> {
  const out = await git(["rev-list", rev], { cwd: repo.root, allowFailure: true });
  return new Set(out.split("\n").filter(Boolean));
}
