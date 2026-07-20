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

export interface GitUserIdentity {
  email: string | null;
  name: string | null;
}

/**
 * The identity a commit made right now would be authored under, resolved by
 * git itself in git's own precedence order (GIT_AUTHOR_EMAIL env, then
 * user.email config — includeIf and all — then EMAIL env).
 * user.useConfigOnly keeps git from auto-detecting a hostname-based
 * identity — hostname anchors churn (DHCP renames) and actor.id is part of
 * event identity, so a guessed value would churn event ids. Strict
 * resolution refuses when *either* field would need guessing, so explicit
 * config is read as a fallback (a repo with user.email but no user.name
 * anywhere still attributes turns). When git would have to guess the email
 * too, turns stay unattributed (both fields null).
 */
export async function gitUserIdentity(repo: RepoInfo): Promise<GitUserIdentity> {
  const ident = (await git(["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  const match = ident.match(/^(.*?)\s*<([^<>]*)>\s+\d+\s+[+-]\d{4}$/);
  if (match) return { email: match[2] || null, name: match[1] || null };

  const email = (await git(["config", "user.email"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  const name = (await git(["config", "user.name"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  return { email: email || null, name: name || null };
}

export async function statusPorcelain(repo: RepoInfo): Promise<string> {
  return git(["status", "--porcelain"], { cwd: repo.root, allowFailure: true });
}

/** Commit SHAs reachable from rev. */
export async function revList(repo: RepoInfo, rev: string): Promise<Set<string>> {
  const out = await git(["rev-list", rev], { cwd: repo.root, allowFailure: true });
  return new Set(out.split("\n").filter(Boolean));
}
