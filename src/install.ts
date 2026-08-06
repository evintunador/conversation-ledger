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

/**
 * Appended to a hook command so the capture is not killed mid-write.
 *
 * Verified against Qwen Code 0.21.5: in one-shot headless mode (`qwen -p ...`)
 * the CLI fires its `Stop` hook and then exits immediately, tearing down the
 * hook process along with the stdio pipes it inherited. A hook that finishes
 * instantly survives; one that takes a few hundred milliseconds -- which a
 * git-notes append does -- is killed partway, and nothing is captured. A
 * deliberately slow probe hook reproduced it every time: it logged its start
 * and never its finish.
 *
 * Redirecting the command's output fixes it, reliably and repeatably: the
 * redirection forces the CLI to route the command through a shell, so the
 * work runs as a grandchild that outlives the teardown, and it stops the
 * capture from writing into pipes that are being closed underneath it. This
 * is the same trade the opencode plugin already makes -- capture that survives
 * a one-shot run, at the cost of not seeing its own output -- so
 * `cledger capture <source> --all` remains the way to watch a capture,
 * format-drift warnings included.
 *
 * Interactive sessions never needed this (the CLI is still running when the
 * hook fires), and claude-code and codex await their hooks properly, so
 * neither of those installs pays for it.
 */
const DETACH_SUFFIX = " >/dev/null 2>&1";

/**
 * Install command hooks into a Claude-Code-shaped `settings.json`.
 *
 * Three of the supported CLIs share this exact config format -- a top-level
 * `hooks` object mapping an event name to an array of
 * `{matcher?, hooks:[{type:"command", command, timeout}]}` definitions. That
 * is not a coincidence: Gemini CLI ships a `gemini hooks migrate` command
 * whose whole job is importing Claude Code's hook config, and Qwen Code
 * inherited the same engine. Only the file path and the event names differ,
 * so they are the parameters here.
 */
async function installJsonHooks(
  source: string,
  settingsPath: string,
  events: string[],
  options: { detach?: boolean } = {},
): Promise<string> {
  const settings: Record<string, unknown> = existsSync(settingsPath)
    ? (JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  const command = (await hookCommand(source)) + (options.detach ? DETACH_SUFFIX : "");
  const hooks = (settings["hooks"] ?? {}) as Record<string, ClaudeHookEntry[]>;
  let changed = false;
  for (const event of events) {
    if (!hasCledgerHook(hooks[event], `hook ${source}`)) {
      hooks[event] = [
        ...(hooks[event] ?? []),
        { hooks: [{ type: "command", command, timeout: 120 }] },
      ];
      changed = true;
    }
  }
  if (!changed) return `${source}: already installed (${settingsPath})`;
  settings["hooks"] = hooks;
  await backup(settingsPath);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return `${source}: ${events.join(" + ")} hooks added to ${settingsPath}`;
}

export async function installClaudeCode(): Promise<string> {
  return installJsonHooks("claude-code", join(homedir(), ".claude", "settings.json"), [
    "Stop",
    "SessionEnd",
  ]);
}

/**
 * Gemini CLI names its lifecycle events differently from Claude Code:
 * `AfterAgent` is the "the agent finished responding" event (Claude's `Stop`),
 * and `SessionEnd` matches by name. Both are used, for the same reason
 * claude-code installs both -- `AfterAgent` captures each turn as it lands, and
 * `SessionEnd` is the backstop for a session that exits mid-turn.
 */
export async function installGeminiCli(): Promise<string> {
  return installJsonHooks(
    "gemini-cli",
    join(homedir(), ".gemini", "settings.json"),
    ["AfterAgent", "SessionEnd"],
    { detach: true },
  );
}

/** Qwen Code forked Claude Code's event names verbatim, `Stop` included. */
export async function installQwenCode(): Promise<string> {
  return installJsonHooks(
    "qwen-code",
    join(homedir(), ".qwen", "settings.json"),
    ["Stop", "SessionEnd"],
    { detach: true },
  );
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

/** Every adapter `cledger install` knows how to wire up, in listing order. */
export const INSTALLABLE_ADAPTERS: Record<string, () => Promise<string>> = {
  "claude-code": installClaudeCode,
  codex: installCodex,
  opencode: installOpencode,
  "gemini-cli": installGeminiCli,
  "qwen-code": installQwenCode,
};

export async function installAdapters(which: string): Promise<void> {
  const names =
    which === "all"
      ? Object.keys(INSTALLABLE_ADAPTERS)
      : which in INSTALLABLE_ADAPTERS
        ? [which]
        : [];
  const results: string[] = [];
  for (const name of names) results.push(await INSTALLABLE_ADAPTERS[name]!());
  if (results.length === 0) {
    process.stderr.write(
      `unknown adapter: ${which} (expected ${Object.keys(INSTALLABLE_ADAPTERS).join("|")}|all)\n`,
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
