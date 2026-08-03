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

/**
 * The same invocation as `hookCommand`, but as an argv array: the opencode
 * integration is a JS plugin that spawns the hook directly rather than a
 * shell command string in a config file.
 */
async function hookArgv(source: string): Promise<string[]> {
  try {
    await execFileP("cledger", ["--version"]);
    return ["cledger", "hook", source];
  } catch {
    const script = fileURLToPath(new URL("./cli.js", import.meta.url));
    return [process.execPath, script, "hook", source];
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

/**
 * opencode has no shell-hook config the way claude-code and codex do; it
 * loads JS plugins from `<config>/plugin/*.js` (verified: a bare
 * `export const server` in that directory is picked up on every command).
 * So installation writes a small plugin that listens for `session.idle` and
 * spawns the normal `cledger hook opencode` entrypoint.
 *
 * Two deliberate choices in the generated plugin:
 *
 *  - The child is detached and unref'd rather than awaited. `session.idle`
 *    fires inside the TUI's event loop; blocking it for the length of an
 *    export plus a git-notes append would stall the interface, and detaching
 *    also keeps capture alive when a one-shot `opencode run` exits straight
 *    after going idle.
 *  - The session id is read from `properties.sessionID`, confirmed against a
 *    live `session.idle` from opencode 1.18.5. It is still passed as optional:
 *    the hook falls back to the most recently updated session for the
 *    directory if a future opencode renames the field, which keeps capture
 *    working rather than silently stopping.
 */
export async function installOpencode(): Promise<string> {
  const configHome = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  const path = join(configHome, "opencode", "plugin", "cledger.js");
  const argv = await hookArgv("opencode");
  const body = `// conversation-ledger capture for opencode.
// Written by \`cledger install opencode\`. Safe to delete to stop capturing.
const COMMAND = ${JSON.stringify(argv)};

export const server = async ({ directory, worktree }) => {
  const { spawn } = await import("node:child_process");
  return {
    event: async ({ event }) => {
      if (!event || event.type !== "session.idle") return;
      const sessionID = (event.properties && event.properties.sessionID) || undefined;
      const cwd = worktree || directory || process.cwd();
      let child;
      try {
        child = spawn(COMMAND[0], COMMAND.slice(1), {
          cwd,
          detached: true,
          // stderr is discarded, not inherited: this child outlives the
          // plugin and would otherwise write into opencode's TUI while it is
          // drawing. Run \`cledger capture opencode --all\` to see the
          // capture's own output, including format-drift warnings.
          stdio: ["pipe", "ignore", "ignore"],
        });
      } catch {
        return;
      }
      child.on("error", () => {});
      try {
        child.stdin.end(
          JSON.stringify({ session_id: sessionID, cwd, hook_event_name: "session.idle" }),
        );
      } catch {
        /* child already gone */
      }
      child.unref();
    },
  };
};
`;
  if (existsSync(path) && (await readFile(path, "utf8")) === body) {
    return `opencode: already installed (${path})`;
  }
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return `opencode: session.idle capture plugin written to ${path}`;
}

export async function installAdapters(which: string): Promise<void> {
  const results: string[] = [];
  if (which === "claude-code" || which === "all") results.push(await installClaudeCode());
  if (which === "codex" || which === "all") results.push(await installCodex());
  if (which === "opencode" || which === "all") results.push(await installOpencode());
  if (results.length === 0) {
    process.stderr.write(
      `unknown adapter: ${which} (expected claude-code|codex|opencode|all)\n`,
    );
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
