import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hasAuthorIdentity } from "./transport.js";

const execFileP = promisify(execFile);

/**
 * Hook commands prefer the bare `cledger` binary so installs survive this
 * repo moving; when it isn't on PATH yet we fall back to an absolute
 * node+script invocation so hooks work immediately after `cledger install`.
 */
async function hookCommand(source: string): Promise<string> {
  try {
    await execFileP("cledger", ["--version"]);
    return `cledger hook ${source}`;
  } catch {
    const script = fileURLToPath(new URL("./cli.js", import.meta.url));
    return `"${process.execPath}" "${script}" hook ${source}`;
  }
}

async function backup(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(path, `${path}.bak-${stamp}`);
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number }[];
}

function hasCledgerHook(entries: ClaudeHookEntry[] | undefined, needle: string): boolean {
  return (entries ?? []).some((entry) =>
    entry.hooks?.some((h) => h.command?.includes(needle)),
  );
}

export async function installClaudeCode(): Promise<string> {
  const path = join(homedir(), ".claude", "settings.json");
  const settings: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)
    : {};
  const command = await hookCommand("claude-code");
  const hooks = (settings["hooks"] ?? {}) as Record<string, ClaudeHookEntry[]>;
  let changed = false;
  for (const event of ["Stop", "SessionEnd"]) {
    if (!hasCledgerHook(hooks[event], "hook claude-code")) {
      hooks[event] = [
        ...(hooks[event] ?? []),
        { hooks: [{ type: "command", command, timeout: 120 }] },
      ];
      changed = true;
    }
  }
  if (!changed) return `claude-code: already installed (${path})`;
  settings["hooks"] = hooks;
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
  return `claude-code: Stop + SessionEnd hooks added to ${path}`;
}

export async function installCodex(): Promise<string> {
  const path = join(homedir(), ".codex", "config.toml");
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const additions: string[] = [];
  // Hooks are silently ignored unless features.hooks is enabled.
  if (!/^\s*hooks\s*=\s*true/m.test(existing)) {
    if (existing.includes("[features]")) {
      return (
        `codex: config has a [features] section without hooks = true — ` +
        `add it there manually, then re-run install (${path})`
      );
    }
    additions.push("[features]", "hooks = true", "");
  }
  if (!existing.includes("hook codex")) {
    const command = await hookCommand("codex");
    additions.push(
      "[[hooks.Stop]]",
      "[[hooks.Stop.hooks]]",
      'type = "command"',
      `command = '${command}'`,
      "timeout = 120",
      "",
    );
  }
  if (additions.length === 0) return `codex: already installed (${path})`;
  // TOML array-of-tables headers reset table scope, so appending at EOF is
  // always valid regardless of what section the file currently ends in.
  const block =
    "\n# conversation-ledger capture (added by `cledger install codex`)\n" +
    additions.join("\n");
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, existing.replace(/\n?$/, "\n") + block);
  return (
    `codex: hook config added to ${path} — run /hooks once inside codex ` +
    `to trust the new hook (codex requires interactive approval)`
  );
}

export async function installAdapters(which: string): Promise<void> {
  const results: string[] = [];
  if (which === "claude-code" || which === "all") results.push(await installClaudeCode());
  if (which === "codex" || which === "all") results.push(await installCodex());
  if (results.length === 0) {
    process.stderr.write(`unknown adapter: ${which} (expected claude-code|codex|all)\n`);
    process.exit(2);
  }
  for (const line of results) process.stdout.write(line + "\n");
  if (!(await hasAuthorIdentity())) {
    process.stderr.write(
      "cledger: warning — git has no author identity configured, so your conversation turns " +
        "will be recorded unattributed (no actor.id). Fix with:\n" +
        '  git config --global user.email "you@example.com"\n' +
        '  git config --global user.name "Your Name"\n',
    );
  }
}
