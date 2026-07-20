import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, type RepoInfo } from "./git.js";
import { type CledgerConfig } from "./redact/config.js";

const execFileP = promisify(execFile);

export const NOTES_NAME = "conversation-ledger";
export const NOTES_REF = `refs/notes/${NOTES_NAME}`;

/**
 * Staging ref for events arriving from a remote. `git fetch` lands the
 * remote's ledger ref here (via the refspec ensureTransport configures);
 * absorbIncoming() folds it into the local ref lazily at read time. The
 * local ref is never force-overwritten — absorption is always the
 * cat_sort_uniq union.
 */
export const INCOMING_NAME = "cledger-incoming";
export const INCOMING_REF = `refs/notes/${INCOMING_NAME}`;

const FETCH_REFSPEC = `+${NOTES_REF}:${INCOMING_REF}`;
const HOOK_MARKER = "conversation-ledger pre-push";

export async function ensureMergeConfig(repo: RepoInfo): Promise<void> {
  const key = `notes.${NOTES_NAME}.mergeStrategy`;
  const current = (await git(["config", "--get", key], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (current !== "cat_sort_uniq") {
    await git(["config", key, "cat_sort_uniq"], { cwd: repo.root });
  }
}

/**
 * The command hook scripts should run. Prefers this exact installation
 * (absolute node + cli.js — immune to PATH differences and to an older
 * global `cledger` that predates a subcommand), with a PATH fallback baked
 * into the script itself for when this installation moves.
 */
function cledgerInvocation(): { node: string; cli: string } {
  return {
    node: process.execPath,
    cli: fileURLToPath(new URL("./cli.js", import.meta.url)),
  };
}

function hookBlock(): string {
  const { node, cli } = cledgerInvocation();
  return [
    `# >>> ${HOOK_MARKER} (added by cledger) >>>`,
    `# Shares this repo's conversation records (${NOTES_REF}) when you push.`,
    `# Delete this block to disable, or set {"transport": {"hook": false}} in`,
    `# .cledger.json / ~/.config/cledger/config.json.`,
    `if [ -z "$CLEDGER_INTERNAL" ]; then`,
    `  if [ -x "${node}" ] && [ -e "${cli}" ]; then`,
    `    "${node}" "${cli}" transport-push "$1" </dev/null || exit $?`,
    `  elif command -v cledger >/dev/null 2>&1; then`,
    `    cledger transport-push "$1" </dev/null || exit $?`,
    `  fi`,
    `fi`,
    `# <<< ${HOOK_MARKER} <<<`,
  ].join("\n");
}

/** Warnings that should print once per repo, not on every capture. */
async function warnOnce(repo: RepoInfo, key: string, message: string): Promise<void> {
  const stateDir = join(repo.gitDir, "conversation-ledger");
  const path = join(stateDir, "transport-warnings.json");
  let warned: string[] = [];
  try {
    warned = JSON.parse(await readFile(path, "utf8")) as string[];
  } catch {
    // first warning, or unreadable state — state is rebuildable
  }
  if (warned.includes(key)) return;
  process.stderr.write(message);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path, JSON.stringify([...warned, key]) + "\n");
}

export interface TransportSetup {
  hook: "installed" | "present" | "appended" | "skipped-config" | "skipped-hookspath" | "skipped-foreign";
  refspec: "added" | "present" | "skipped-config" | "no-remote";
}

/**
 * Transport is default-on but must cost the user nothing to get: the first
 * capture in a repo wires it up. Installs the pre-push hook (chain-safe:
 * appends to an existing shell hook, backs off with a one-time warning when
 * core.hooksPath or a non-shell hook owns the file) and adds the fetch
 * refspec that stages the remote's ledger ref on normal `git fetch`.
 * Runs on every append — each check is a cheap stat/config read — so a
 * remote added later still gets wired. Never throws: this runs inside
 * capture, which must never fail a user's session.
 */
export async function ensureTransport(
  repo: RepoInfo,
  config: CledgerConfig,
): Promise<TransportSetup | null> {
  try {
    return {
      hook: await ensurePrePushHook(repo, config),
      refspec: await ensureFetchRefspec(repo, config),
    };
  } catch {
    return null;
  }
}

async function ensurePrePushHook(
  repo: RepoInfo,
  config: CledgerConfig,
): Promise<TransportSetup["hook"]> {
  if (config.transport?.hook === false) return "skipped-config";

  const hooksPath = (await git(["config", "--get", "core.hooksPath"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (hooksPath) {
    await warnOnce(
      repo,
      "hookspath",
      `cledger: core.hooksPath is set (${hooksPath}), so the ledger pre-push hook was not ` +
        `installed. To share conversation records on push, add\n` +
        `  cledger transport-push "$1"\n` +
        `to that pre-push hook, or run \`cledger sync\` manually.\n`,
    );
    return "skipped-hookspath";
  }

  const hookPath = join(repo.gitDir, "hooks", "pre-push");
  if (!existsSync(hookPath)) {
    await mkdir(join(repo.gitDir, "hooks"), { recursive: true });
    await writeFile(hookPath, `#!/bin/sh\n${hookBlock()}\n`);
    await chmod(hookPath, 0o755);
    return "installed";
  }

  const existing = await readFile(hookPath, "utf8");
  if (existing.includes(HOOK_MARKER)) return "present";

  const shebang = existing.split("\n", 1)[0] ?? "";
  if (!/^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(shebang)) {
    await warnOnce(
      repo,
      "foreign-hook",
      `cledger: this repo's pre-push hook is not a shell script, so the ledger hook was not ` +
        `chained onto it. Run \`cledger sync\` to share conversation records manually.\n`,
    );
    return "skipped-foreign";
  }

  await writeFile(hookPath, existing.replace(/\n?$/, "\n") + "\n" + hookBlock() + "\n");
  await chmod(hookPath, 0o755);
  return "appended";
}

async function ensureFetchRefspec(
  repo: RepoInfo,
  config: CledgerConfig,
): Promise<TransportSetup["refspec"]> {
  if (config.transport?.fetchRefspec === false) return "skipped-config";

  const originUrl = (await git(["remote", "get-url", "origin"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!originUrl) return "no-remote";

  const fetchSpecs = await git(["config", "--get-all", "remote.origin.fetch"], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (fetchSpecs.includes(INCOMING_REF)) return "present";

  await git(["config", "--add", "remote.origin.fetch", FETCH_REFSPEC], { cwd: repo.root });
  return "added";
}

/**
 * Fold the staged incoming ref (populated by `git fetch` via the refspec)
 * into the local ledger ref — the lazy, read-time half of transport. The
 * merge is the same cat_sort_uniq union sync() uses, so absorbing can only
 * add events. Returns true when new remote state was absorbed. Never
 * throws: a concurrent notes merge just means the next read tries again.
 */
export async function absorbIncoming(repo: RepoInfo): Promise<boolean> {
  const incoming = (await git(["rev-parse", "--verify", "--quiet", INCOMING_REF], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!incoming) return false;

  const local = (await git(["rev-parse", "--verify", "--quiet", NOTES_REF], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (local === incoming) {
    await git(["update-ref", "-d", INCOMING_REF], { cwd: repo.root, allowFailure: true });
    return false;
  }

  try {
    await ensureMergeConfig(repo);
    if (!local) {
      await git(["update-ref", NOTES_REF, incoming], { cwd: repo.root });
    } else {
      await git(["notes", "--ref", NOTES_NAME, "merge", "-s", "cat_sort_uniq", INCOMING_REF], {
        cwd: repo.root,
      });
    }
  } catch {
    return false;
  }
  await git(["update-ref", "-d", INCOMING_REF], { cwd: repo.root, allowFailure: true });
  return true;
}

/**
 * True when git can produce an explicit author identity (config or env —
 * never a hostname guess; see gitUserIdentity). Used by `cledger install`
 * to warn that captured human turns would be unattributed.
 */
export async function hasAuthorIdentity(): Promise<boolean> {
  try {
    await execFileP("git", ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
    return true;
  } catch {
    return false;
  }
}
