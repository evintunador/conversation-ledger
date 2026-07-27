import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
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
  /**
   * This working tree's *own* git directory. In the main checkout that is
   * `<root>/.git`, but in a linked worktree — created by `git worktree add`,
   * whether under the repo or at an arbitrary path elsewhere — git gives each
   * worktree a private directory at `<main>/.git/worktrees/<name>/` for the
   * state that is genuinely per-worktree (HEAD, index, reflogs).
   *
   * Almost nothing in cledger belongs here, and putting it here is a silent
   * bug rather than a loud one: state written under a worktree is invisible
   * from every other working tree, and git itself only ever runs hooks out of
   * the *common* directory. Use `commonDir` unless you specifically want
   * something scoped to one working tree. Nothing does today.
   */
  gitDir: string;
  /**
   * The repository's shared git directory — identical for the main checkout
   * and every linked worktree. Refs (including the ledger's notes ref),
   * objects, config, and hooks all live here, which is why the ledger data
   * itself was never worktree-scoped. All of cledger's local state hangs off
   * this, so a worktree sees the same allowlist, known secrets, capture
   * cursors, and installed hook as everyone else.
   */
  commonDir: string;
}

/** Resolve the repo containing dir, or null when outside any git repo. */
export async function findRepo(dir: string): Promise<RepoInfo | null> {
  try {
    const root = (await git(["rev-parse", "--show-toplevel"], { cwd: dir })).trim();
    const gitDir = (await git(["rev-parse", "--absolute-git-dir"], { cwd: dir })).trim();
    return { root, gitDir, commonDir: await resolveCommonDir(dir, gitDir) };
  } catch {
    return null;
  }
}

/**
 * The shared git directory for the working tree at `dir`.
 *
 * There is no `--absolute-git-common-dir`, and plain `--git-common-dir`
 * answers relative to the process cwd in the main checkout (it prints a bare
 * `.git`) while already being absolute from a linked worktree — so the result
 * has to be resolved either way. `--path-format=absolute` does it directly on
 * git >= 2.31; older git falls back to resolving by hand against the same
 * `cwd` the command ran in. If both fail, `gitDir` is the honest answer: it is
 * correct in the main checkout, which is where a git this old is most likely
 * to be running anyway.
 */
async function resolveCommonDir(dir: string, gitDir: string): Promise<string> {
  try {
    return (
      await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir })
    ).trim();
  } catch {
    // git < 2.31: no --path-format
  }
  try {
    const raw = (await git(["rev-parse", "--git-common-dir"], { cwd: dir })).trim();
    if (raw) return isAbsolute(raw) ? raw : resolve(dir, raw);
  } catch {
    // no --git-common-dir at all (git < 2.5, before worktrees existed)
  }
  return gitDir;
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
