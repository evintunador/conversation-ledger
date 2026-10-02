import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
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

/** The cledger hook inside an event's entries, if it is already installed. */
function findCledgerHook(
  entries: ClaudeHookEntry[] | undefined,
  needle: string,
): { type: string; command?: string; timeout?: number } | undefined {
  for (const entry of entries ?? []) {
    const hook = entry.hooks?.find((h) => h.command?.includes(needle));
    if (hook) return hook;
  }
  return undefined;
}

/**
 * How long a hook may run before the CLI kills it — in whatever unit that CLI
 * reads the field in, which is *not* the same across the three.
 *
 * Claude Code reads `timeout` as **seconds**. Gemini CLI and Qwen Code forked
 * Claude's hook config format but not its unit: both pass the number straight
 * to `setTimeout`, so theirs is **milliseconds**. Their own code says so —
 * `Hook timed out after ${timeout}ms`, with `DEFAULT_HOOK_TIMEOUT = 6e4`.
 *
 * Writing Claude's `120` into their settings therefore asks to be SIGTERMed
 * after 120 *milliseconds*. A cold capture is ~85ms of work on top of node's
 * startup, so the hook loses that race nearly every time: Gemini reported
 * "Hook(s) [...] failed" on almost every turn while its events sometimes still
 * landed, because whether `appendEvents` finished before the signal was a coin
 * flip. Diagnosed by trapping the signal in a wrapper script — the hook logged
 * `caught SIGTERM` in the same second it started.
 */
const HOOK_TIMEOUT_SECONDS = 120;
const HOOK_TIMEOUT_MILLISECONDS = 120_000;

/**
 * A redirect this used to append to the two Gemini-derived CLIs' hook
 * commands, now only recognized so it can be taken back off.
 *
 * **Its rationale was wrong, and the constant survives as the repair.** It was
 * introduced after `qwen -p "..."` failed to capture: the CLI fires its `Stop`
 * hook and exits, and a hook doing a git-notes append was seen to die partway.
 * The explanation recorded at the time -- that the redirection "routes the
 * command through a shell so the work runs as a grandchild that outlives the
 * teardown" -- does not survive reading either CLI's source. Both *always*
 * invoke a hook as `bash -c "<command>"` whether or not it redirects, and
 * `bash -c` with a single simple command `exec`s it rather than forking, so
 * there is no grandchild and nothing is detached. All the redirect ever did
 * was hide the capture's own output.
 *
 * The real cause of hooks dying was the timeout unit (see
 * HOOK_TIMEOUT_MILLISECONDS): every hook was being SIGTERMed after 120ms. With
 * that fixed, the redirect has no job left and one standing cost -- a capture
 * cannot print a format-drift warning anywhere the user would see it, leaving
 * `cledger capture <source> --all` as the only way to watch one.
 *
 * New installs no longer write it. An existing hook that still carries it is
 * repaired in place, for the same reason the timeout is (see below): a setting
 * cledger got wrong should be fixable by re-running `cledger install`, not by
 * hand-editing JSON.
 *
 * The repair only ever touches cledger's own hook, and only when the command
 * ends in this exact string -- any other redirect a user wrote is left as
 * written. The one case it cannot tell apart is a user who appended precisely
 * this suffix to the cledger hook on purpose; they get it removed, and can put
 * it back. Silencing a capture is not worth a config key to preserve.
 */
const STALE_DETACH_SUFFIX = " >/dev/null 2>&1";

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
  options: { timeout: number } = { timeout: HOOK_TIMEOUT_SECONDS },
): Promise<string> {
  const settings: Record<string, unknown> = existsSync(settingsPath)
    ? (JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  const command = await hookCommand(source);
  const hooks = (settings["hooks"] ?? {}) as Record<string, ClaudeHookEntry[]>;
  let changed = false;
  const repairs = new Set<string>();
  for (const event of events) {
    const existing = findCledgerHook(hooks[event], `hook ${source}`);
    if (!existing) {
      hooks[event] = [
        ...(hooks[event] ?? []),
        { hooks: [{ type: "command", command, timeout: options.timeout }] },
      ];
      changed = true;
      continue;
    }
    // An install already here is still repaired in place, because both of
    // these settings have been wrong before (see HOOK_TIMEOUT_MILLISECONDS and
    // STALE_DETACH_SUFFIX) and a user whose capture is being killed mid-write,
    // or silenced, should be able to fix it by re-running install rather than
    // hand-editing JSON.
    if (existing.timeout !== options.timeout) {
      existing.timeout = options.timeout;
      changed = true;
      repairs.add(`timeout corrected to ${options.timeout}`);
    }
    if (existing.command?.endsWith(STALE_DETACH_SUFFIX)) {
      existing.command = existing.command.slice(0, -STALE_DETACH_SUFFIX.length);
      changed = true;
      repairs.add("output no longer discarded");
    }
  }
  if (!changed) return `${source}: already installed (${settingsPath})`;
  if (repairs.size > 0) {
    settings["hooks"] = hooks;
    await backup(settingsPath);
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return `${source}: hook repaired (${[...repairs].join("; ")}) in ${settingsPath}`;
  }
  settings["hooks"] = hooks;
  await backup(settingsPath);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return `${source}: ${events.join(" + ")} hooks added to ${settingsPath}`;
}

export async function installClaudeCode(): Promise<string> {
  return installJsonHooks(
    "claude-code",
    join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "settings.json"),
    ["Stop", "SessionEnd"],
    { timeout: HOOK_TIMEOUT_SECONDS },
  );
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
    join(process.env["GEMINI_CLI_HOME"] || homedir(), ".gemini", "settings.json"),
    ["AfterAgent", "SessionEnd"],
    { timeout: HOOK_TIMEOUT_MILLISECONDS },
  );
}

/** Qwen Code forked Claude Code's event names verbatim, `Stop` included. */
export async function installQwenCode(): Promise<string> {
  return installJsonHooks(
    "qwen-code",
    join(homedir(), ".qwen", "settings.json"),
    ["Stop", "SessionEnd"],
    { timeout: HOOK_TIMEOUT_MILLISECONDS },
  );
}

export async function installCodex(): Promise<string> {
  return installRolloutHooks("codex", join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"));
}

export async function installOpenInterpreter(): Promise<string> {
  return installRolloutHooks("open-interpreter", join(process.env.INTERPRETER_HOME || join(homedir(), ".openinterpreter"), "config.toml"));
}

async function installRolloutHooks(source: string, path: string): Promise<string> {
  const original = existsSync(path) ? await readFile(path, "utf8") : "";
  let existing = original;
  const additions: string[] = [];
  // Scope the switch to [features], never an unrelated table's hooks key.
  const features = /^[ \t]*\[features\][ \t]*(?:#[^\n]*)?(?:\r?\n|$)([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/m;
  const section = features.exec(existing);
  // Dotted keys are relative to the current TOML table. Only keys before the
  // first table header can define root features; leave neighbors untouched.
  const firstTable = existing.search(/^[ \t]*\[/m);
  const rootEnd = firstTable < 0 ? existing.length : firstTable;
  const root = existing.slice(0, rootEnd);
  if (/^[ \t]*\[\s*["']features["']/m.test(existing) || /^[ \t]*["']features["'][ \t]*[.=]/m.test(root)) {
    throw new Error(`${source}: quoted features configuration needs conversion to an unquoted [features] table before installing hooks (${path})`);
  }
  if (section) {
    const body = section[1]!;
    const enabled = /^([ \t]*hooks[ \t]*=[ \t]*)(?:true|false)([^\n]*)$/m;
    if (/^[ \t]*hooks[ \t]*=/m.test(body) && !/^[ \t]*hooks[ \t]*=[ \t]*(?:true|false)[ \t]*(?:#[^\n]*)?$/m.test(body)) {
      throw new Error(`${source}: features.hooks must be a boolean before installing hooks (${path})`);
    }
    const replacement = enabled.test(body) ? body.replace(enabled, "$1true$2") : "hooks = true\n" + body;
    existing = existing.slice(0, section.index) + section[0].slice(0, section[0].length - body.length).replace(/\n?$/, "\n") + replacement + existing.slice(section.index + section[0].length);
  } else if (/^[ \t]*features[ \t]*\./m.test(root)) {
    const dotted = /^([ \t]*features[ \t]*\.[ \t]*hooks[ \t]*=[ \t]*)(true|false)([ \t]*(?:#[^\n]*)?)$/m;
    let replacement = root;
    if (/^[ \t]*features[ \t]*\.[ \t]*hooks[ \t]*=/m.test(root)) {
      if (!dotted.test(root)) throw new Error(`${source}: features.hooks must be a boolean before installing hooks (${path})`);
      replacement = root.replace(dotted, "$1true$3");
    } else replacement = root.replace(/\n?$/, "\n") + "features.hooks = true\n";
    existing = replacement + existing.slice(rootEnd);
  } else if (/^[ \t]*features[ \t]*=/m.test(root)) {
    throw new Error(`${source}: inline features configuration needs conversion to a [features] table before installing hooks (${path})`);
  } else additions.push("[features]", "hooks = true", "");
  const command = await hookCommand(source);
  for (const [event, timeout] of [["Stop", 120], ["SessionEnd", 3]] as const) {
    const sections = existing.split(/(?=^\s*\[\[hooks\.[A-Za-z]+\]\])/m);
    if (sections.some(section => section.trimStart().startsWith(`[[hooks.${event}]]`) && section.includes(`hook ${source}`))) continue;
    additions.push(
      `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`,
      'type = "command"', `command = ${JSON.stringify(command)}`,
      `timeout = ${timeout}`, "",
    );
  }
  if (additions.length === 0 && existing === original) return `${source}: already installed (${path})`;
  // TOML array-of-tables headers reset table scope, so appending at EOF is
  // always valid regardless of what section the file currently ends in.
  const block =
    `\n# conversation-ledger capture (added by cledger install ${source})\n` +
    additions.join("\n");
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, existing.replace(/\n?$/, "\n") + block);
  return (
    `${source}: hook config added to ${path} — run /hooks once inside ${source} ` +
    `to trust the new hook (${source} requires interactive approval)`
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
 *    working rather than silently stopping. The plugin itself warns before
 *    spawning that fallback, because the detached child's stderr is discarded.
 */
export async function installOpencode(): Promise<string> { return installEventPlugin("opencode"); }
export async function installKilo(): Promise<string> { return installEventPlugin("kilo"); }

async function installEventPlugin(source: "opencode" | "kilo"): Promise<string> {
  const configHome = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  const path = join(configHome, source, "plugin", "cledger.js");
  const argv = await hookArgv(source);
  const body = `// conversation-ledger capture for opencode.
// Written by \`cledger install opencode\`. Safe to delete to stop capturing.
const COMMAND = ${JSON.stringify(argv)};

export const server = async ({ directory, worktree }) => {
  const { spawn } = await import("node:child_process");
  return {
    event: async ({ event }) => {
      if (!event || event.type !== "session.idle") return;
      const sessionID = (event.properties && event.properties.sessionID) || undefined;
      const cwd = ${source === "kilo" ? "directory || worktree" : "worktree || directory"} || process.cwd();
      if (!sessionID) {
        console.warn(
          "cledger: ${source} plugin warning: session.idle provided no session id; " +
            "falling back to the project's most recently updated session",
        );
      }
      let child;
      try {
        child = spawn(COMMAND[0], COMMAND.slice(1), {
          cwd,
          detached: true,
          // stderr is discarded, not inherited: this child outlives the
          // plugin and would otherwise write into opencode's TUI while it is
          // drawing. Run \`cledger capture ${source} --all\` to see the
          // capture's own output, including format-drift warnings.
          stdio: ["pipe", "ignore", "ignore"],
        });
      } catch {
        return;
      }
      child.on("error", () => {});
      // The helper can exit before it reads the event. Node reports the
      // resulting broken pipe asynchronously on stdin, outside the try/catch.
      child.stdin.on("error", () => {});
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
    return `${source}: already installed (${path})`;
  }
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return `opencode: session.idle capture plugin written to ${path}`;
}

/** Pi auto-discovers extensions from its configured agent directory. */
export async function installPi(): Promise<string> {
  const root = process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent");
  const path = join(root, "extensions", "cledger.ts");
  const argv = await hookArgv("pi");
  // Plain JS in a .ts extension keeps this compatible with Pi's extension
  // loader without importing a particular version of its type package.
  const body = `// conversation-ledger capture for Pi. Delete this file to disable.
// Native events: packages/coding-agent/docs/extensions.md in earendil-works/pi.
import { spawn } from "node:child_process";
const COMMAND = ${JSON.stringify(argv)};
export default function (pi) {
  let pending = Promise.resolve();
  const capture = async (_event, ctx) => {
    const transcript_path = ctx.sessionManager.getSessionFile();
    if (!transcript_path) return; // --no-session has no persisted transcript.
    const cwd = ctx.cwd;
    pending = pending.then(() => new Promise((resolve) => {
      const child = spawn(COMMAND[0], COMMAND.slice(1), {
        cwd, stdio: ["pipe", "ignore", "inherit"],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
      child.on("error", () => {
        clearTimeout(timer);
        console.warn("cledger: Pi capture process could not start");
        resolve();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) console.warn("cledger: Pi capture did not complete");
        resolve();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ transcript_path, cwd }));
    })).catch(() => console.warn("cledger: Pi capture failed"));
    await pending;
  };
  // agent_end is a fallback for releases predating agent_settled. Capturing
  // both is intentional and idempotent; settled includes final continuations.
  for (const event of ["session_start", "agent_end", "agent_settled", "session_shutdown",
    "session_compact", "session_tree", "session_info_changed"]) pi.on(event, capture);
}
`;
  if (existsSync(path) && (await readFile(path, "utf8")) === body) return `pi: already installed (${path})`;
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return `pi: capture extension written to ${path}`;
}

/** Mistral Vibe's native post_agent hook runs after messages.jsonl is saved. */
export async function installMistralVibe(): Promise<string> {
  const root = process.env["VIBE_HOME"] || join(homedir(), ".vibe");
  const path = join(root, "hooks.toml");
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const start = "# >>> conversation-ledger mistral-vibe";
  const end = "# <<< conversation-ledger mistral-vibe";
  const command = await hookCommand("mistral-vibe");
  const block = `${start}\n[[hooks]]\nname = "conversation-ledger"\ntype = "post_agent"\ncommand = ${JSON.stringify(command)}\ntimeout = 120\n${end}\n`;
  let next: string;
  const beginAt = existing.indexOf(start);
  if (beginAt >= 0) {
    const endAt = existing.indexOf(end, beginAt);
    if (endAt < 0) throw new Error(`mistral-vibe: incomplete managed block in ${path}; refusing to overwrite other hooks`);
    const after = endAt + end.length + (existing[endAt + end.length] === "\n" ? 1 : 0);
    next = existing.slice(0, beginAt) + block + existing.slice(after);
  } else {
    if (existing.includes("hook mistral-vibe")) return `mistral-vibe: existing unmanaged capture hook left unchanged (${path})`;
    next = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + block;
  }
  if (next === existing) return `mistral-vibe: already installed (${path})`;
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return `mistral-vibe: post_agent capture hook written to ${path}`;
}

/** Copilot reads dedicated user hook files, avoiding edits to unrelated hooks. */
export async function installCopilot(): Promise<string> {
  const root = process.env["COPILOT_HOME"] || join(homedir(), ".copilot");
  const path = join(root, "hooks", "cledger.json");
  const hook = {
    type: "command", exec: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "hook", "copilot"],
    timeoutSec: 120,
  };
  const body = JSON.stringify({ version: 1, hooks: {
    agentStop: [hook], sessionEnd: [{ ...hook, args: [...hook.args, "--session-end"] }], subagentStop: [hook],
  } }, null, 2) + "\n";
  if (existsSync(path) && (await readFile(path, "utf8")) === body) return `copilot: already installed (${path})`;
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return `copilot: agentStop + sessionEnd + subagentStop capture hooks written to ${path}`;
}

/** Goose user plugins are discovered under the documented GOOSE_PATH_ROOT. */
export async function installGoose(): Promise<string> {
  const override = process.env["GOOSE_PATH_ROOT"];
  const root = override && isAbsolute(override) ? override : homedir();
  const directory = join(root, ".agents", "plugins", "conversation-ledger");
  const hook = { hooks: [{ type: "command", command: await hookCommand("goose"), timeout: 120 }] };
  const files = [
    [join(directory, "plugin.json"), { name: "conversation-ledger", version: "1.0.0", description: "Capture local Goose conversations into Git notes" }],
    [join(directory, "hooks", "hooks.json"), { hooks: { Stop: [hook], SessionEnd: [hook] } }],
  ] as const;
  let changed = false;
  for (const [path, value] of files) {
    const body = JSON.stringify(value, null, 2) + "\n";
    if (existsSync(path) && await readFile(path, "utf8") === body) continue;
    await backup(path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
    changed = true;
  }
  return `goose: ${changed ? "Stop + SessionEnd plugin installed" : "already installed"} (${directory})`;
}

export async function installKimi(): Promise<string> {
  const root = process.env["KIMI_CODE_HOME"] || join(homedir(), ".kimi-code");
  const path = join(root, "config.toml");
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const start = "# >>> conversation-ledger kimi";
  const end = "# <<< conversation-ledger kimi";
  const command = await hookCommand("kimi");
  const events = ["Stop", "SessionEnd", "PostCompact", "SubagentStop"];
  const block = `${start}\n` + events.map(event =>
    `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = 120\n`,
  ).join("\n") + `${end}\n`;
  let next: string;
  const beginAt = existing.indexOf(start);
  if (beginAt >= 0) {
    const endAt = existing.indexOf(end, beginAt);
    if (endAt < 0) throw new Error(`kimi: incomplete managed block in ${path}; refusing to overwrite other configuration`);
    const after = endAt + end.length + (existing[endAt + end.length] === "\n" ? 1 : 0);
    next = existing.slice(0, beginAt) + block + existing.slice(after);
  } else {
    if (existing.includes("hook kimi")) return `kimi: existing unmanaged capture hook left unchanged (${path})`;
    next = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + block;
  }
  if (next === existing) return `kimi: already installed (${path})`;
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return `kimi: ${events.join(" + ")} capture hooks written to ${path}`;
}

/** Factory's hook file maps event names directly, without a hooks wrapper. */
export async function installDroid(): Promise<string> {
  const path = join(process.env["FACTORY_HOME_OVERRIDE"] || homedir(), ".factory", "hooks.json");
  const config: Record<string, ClaudeHookEntry[]> = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const command = await hookCommand("droid");
  let changed = false;
  for (const event of ["Stop", "SubagentStop", "SessionEnd", "PreCompact"]) {
    const entries = config[event] ?? [];
    const existing = findCledgerHook(entries, "hook droid");
    if (existing) {
      if (existing.timeout !== 120) { existing.timeout = 120; changed = true; }
    } else {
      entries.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 120 }] });
      config[event] = entries; changed = true;
    }
  }
  if (!changed) return `droid: already installed (${path})`;
  await backup(path); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return `droid: native capture hooks installed (${path})`;
}

export async function installContinue(): Promise<string> {
  // 1.5.47 contains hook definitions, but no native lifecycle call sites invoke
  // them. An installed settings entry would falsely promise automatic capture.
  return "continue: use cledger run continue [--binary PATH] -- <arguments>; native lifecycle hooks are not invoked by Continue 1.5.47";
}

export async function installCline(): Promise<string> {
  const root = join(process.env["CLINE_DIR"] || join(homedir(), ".cline"), "hooks");
  const argv = await hookArgv("cline");
  const marker = "// Managed by conversation-ledger: cline capture";
  const body = `#!${process.execPath}\n${marker}\nimport { readFileSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\nconst command = ${JSON.stringify(argv)};\ntry { execFileSync(command[0], command.slice(1), { input: readFileSync(0), stdio: ["pipe", "ignore", "inherit"], timeout: 120000 }); } catch { process.stderr.write("cledger: Cline capture failed; run capture cline --all for diagnostics\\n"); }\nprocess.stdout.write("{}\\n");\n`;
  let changed = false;
  for (const event of ["TaskComplete", "TaskError", "TaskCancel", "SessionShutdown", "PostToolUse", "PreCompact"]) {
    const path = join(root, `${event}.mjs`);
    if (existsSync(path)) {
      const existing = await readFile(path, "utf8");
      if (existing === body) continue;
      if (!existing.includes(marker)) throw new Error(`cline: ${path} is not managed by cledger; refusing to overwrite it`);
    }
    await backup(path); await mkdir(root, { recursive: true });
    await writeFile(path, body, { mode: 0o755 }); changed = true;
  }
  return `cline: ${changed ? "native capture hooks installed" : "already installed"} (${root}); --yolo disables Cline hooks`;
}

export async function installOpenHands(): Promise<string> {
  return installJsonHooks("openhands", join(homedir(), ".openhands", "hooks.json"), ["Stop", "SessionEnd"], { timeout: 120 });
}

/** Cursor uses its own hook schema (lowercase event names, direct command
 * entries) and runs user hooks from ~/.cursor. Preserve unrelated settings. */
export async function installCursor(): Promise<string> {
  const path = join(process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor"), "hooks.json");
  const original = existsSync(path) ? await readFile(path, "utf8") : "";
  const settings = original.trim() ? JSON.parse(original) as Record<string, unknown> : {};
  if (settings.version !== undefined && settings.version !== 1) throw new Error(`cursor: unsupported hooks version (${path})`);
  const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown> : {};
  const command = await hookCommand("cursor");
  let changed = settings.version !== 1;
  for (const event of ["stop", "sessionEnd"]) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as Record<string, unknown>[] : [];
    if (!entries.some(entry => typeof entry.command === "string" && entry.command.includes("hook cursor"))) {
      hooks[event] = [...entries, { command, timeout: 120 }];
      changed = true;
    }
  }
  if (!changed) return `cursor: already installed (${path})`;
  settings.version = 1;
  settings.hooks = hooks;
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
  return `cursor: stop + sessionEnd capture hooks added to ${path}`;
}

/** Kiro V3 has standalone global/project hooks. The installed 2.x default
 * harness still requires the explicit watched launcher (`cledger run kiro`). */
export async function installKiro(): Promise<string> {
  const home = process.env.KIRO_HOME || join(homedir(), ".kiro");
  const path = join(home, "hooks", "cledger.json");
  const command = await hookCommand("kiro");
  const original = existsSync(path) ? await readFile(path, "utf8") : "";
  const config = original.trim() ? JSON.parse(original) as Record<string, unknown> : { version: "v1", hooks: [] };
  if (config.version !== "v1" || !Array.isArray(config.hooks)) throw new Error(`kiro: unsupported hook file (${path})`);
  const hooks = config.hooks as Record<string, unknown>[];
  let changed = false;
  for (const trigger of ["Stop", "SessionEnd"]) {
    const name = `cledger-${trigger.toLowerCase()}`;
    const expected = { name, trigger, action: { type: "command", command }, timeout: 120 };
    const index = hooks.findIndex(item => item.name === name);
    if (index < 0) { hooks.push(expected); changed = true; }
    else if (JSON.stringify(hooks[index]) !== JSON.stringify(expected)) { hooks[index] = expected; changed = true; }
  }
  if (!changed) return `kiro: already installed (${path}); use cledger run kiro -- <args> for the V2/default harness`;
  await backup(path); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...config, hooks }, null, 2) + "\n");
  return `kiro: V3 Stop + SessionEnd hooks added to ${path}; use cledger run kiro -- <args> for V2/default sessions`;
}

/** Every adapter `cledger install` knows how to wire up, in listing order. */
export const INSTALLABLE_ADAPTERS: Record<string, () => Promise<string>> = {
  "claude-code": installClaudeCode,
  codex: installCodex,
  opencode: installOpencode,
  "gemini-cli": installGeminiCli,
  "qwen-code": installQwenCode,
  pi: installPi,
  "mistral-vibe": installMistralVibe,
  copilot: installCopilot,
  cursor: installCursor,
  kiro: installKiro,
  kimi: installKimi,
  goose: installGoose,
  droid: installDroid,
  cline: installCline,
  openhands: installOpenHands,
  "open-interpreter": installOpenInterpreter,
  kilo: installKilo,
  continue: installContinue,
  crush: async () => "crush: use cledger run crush [--binary PATH] -- <arguments>; requires sqlite3; pass -D/--data-dir explicitly for custom data directories",
  aider: async () => "aider: use cledger run aider [--python PATH] -- <arguments>; only wrapper-launched sessions are captured",
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
