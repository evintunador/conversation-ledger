import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { startGuard } from "./guard.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";
import { findRepo } from "annals";
import { readEvents } from "../store.js";

export interface OpenHandsVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }
export interface OpenHandsVerificationReport {
  schema: "cledger-verification/1";
  cli: "openhands";
  status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke";
  inference: "scripted";
  platform: string;
  mode?: "headless" | "interactive";
  version?: string;
  reason?: string;
  gates: Record<string, boolean>;
  requests?: number;
  coverage: string[];
  exclusions: string[];
  durationMs: number;
}

/** The secret is never in the prompt: only a real tool result can supply it. */
export function openhandsEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "openhands");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "file_editor" &&
    (block.input as { command?: unknown })?.command === "view");
  return {
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && block.is_error !== true && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
    hookSelfObservation: turns.some(event => (event.content as { kind?: string; hook_event_type?: string }).kind === "HookExecutionEvent" &&
      (event.content as { hook_event_type?: string }).hook_event_type === "Stop"),
    nativeSessionState: turns.some((event) => event.kind === "session_state" &&
      (event.content as { state_type?: string }).state_type === "base_state"),
  };
}

/** Read-only predicate for a bounded observer subprocess; never imports records. */
export async function openhandsAutomaticEvidenceReady(repo: string, marker: string, secret: string): Promise<boolean> {
  const ledger = await findRepo(repo);
  if (!ledger) return false;
  const events = await readEvents(ledger, { reachableFrom: null });
  return !hasUnrecognizedEvidence(events, "openhands") &&
    Object.values(openhandsEvidenceGates(events, marker, secret)).every(Boolean);
}

/** Observe installed background capture; never repair it by importing data. */
async function awaitNativeTail(repo: string): Promise<boolean> {
  const directory = join(repo, ".git", "cledger-openhands-tail"), deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const names = await readdir(directory), statuses = names.filter(name => name.endsWith(".json"));
      if (statuses.length && !names.some(name => name.endsWith(".lock"))) {
        let complete = true;
        for (const name of statuses) {
          const status = JSON.parse(await readFile(join(directory, name), "utf8")) as { status: string; pid: number };
          if (status.status !== "complete") return false;
          try { process.kill(status.pid, 0); complete = false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") complete = false; }
        }
        if (complete) return true;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return false;
}

/**
 * Real OpenHands executable, real installed prompt/tool/session hooks, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedOpenHands(options: OpenHandsVerificationOptions = {}): Promise<OpenHandsVerificationReport> {
  const started = Date.now();
  const report: OpenHandsVerificationReport = {
    schema: "cledger-verification/1", cli: "openhands", status: "not-run", certification: "native-smoke",
    inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native prompt/tool/session hooks", "bounded tail worker", "final hook self-observation", "headless CLI", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions",
      "CLI 1.16.0 / SDK 1.21.0 fails to persist SessionEnd self-observation at atexit: visualizer raises App is not running; persisted Stop self-observation is required"], durationMs: 0,
  };
  report.mode = options.interactive ? "interactive" : "headless";
  if (options.interactive) {
    report.coverage = report.coverage.map(item => item === "headless CLI" ? "interactive PTY terminal input" : item);
    report.exclusions = report.exclusions.filter(item => item !== "interactive TUI");
  }
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native OpenHands verification currently supports macOS and Linux";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-openhands-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, "openhands");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      OPENHANDS_PERSISTENCE_DIR: agentDir, OPENHANDS_CONVERSATIONS_DIR: join(agentDir, "conversations"),
      LLM_API_KEY: "FAKE_TESTONLY_LOCAL", LLM_MODEL: "openai/gpt-4o", LITELLM_LOCAL_MODEL_COST_MAP: "True",
      OPENHANDS_SUPPRESS_BANNER: "1", DO_NOT_TRACK: "1",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "openhands";
    if (options.binary) await symlink(binary, join(bin, "openhands"));
    // The hook discovers cledger through PATH, just as in an installed
    // user's environment; it invokes the built CLI, never parser functions.
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    const run = (command: string, args: string[], timeoutMs = 20_000) => runProcess(command, args, {
      cwd: repo, env, timeoutMs, ...(guard ? { signal: guard.signal } : {}),
    });
    const checked = async (command: string, args: string[], timeoutMs?: number): Promise<string> => {
      const result = await run(command, args, timeoutMs);
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`${command} ${args[0]} failed${result.timedOut ? " (deadline)" : ` (exit ${result.code})`}: ${result.stderr.slice(-1200)}`);
      }
      return result.stdout;
    };
    try { report.version = (await checked(binary, ["--version"])).trim(); }
    catch {
      report.status = "blocked";
      report.reason = "OpenHands executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated OpenHands verification"]);
    provider = await startScriptedProvider({ toolName: "file_editor", toolArguments: { command: "view", path: join(repo, "evidence.txt"), security_risk: "LOW" } });
    guard = await startGuard(provider.endpoint, 4, Math.min(options.timeoutMs ?? 30_000, 30_000));
    const runtimeEnv = env as NodeJS.ProcessEnv;
    runtimeEnv.LLM_BASE_URL = guard.endpoint;
    await checked(process.execPath, [cli, "install", "openhands"]);
    const hook = await readFile(join((env as NodeJS.ProcessEnv).HOME!, ".openhands", "hooks.json"), "utf8");
    report.gates.installedHook = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]
      .every(event => hook.includes(`"${event}"`)) && hook.includes("hook openhands");
    const prompt = `${marker}. Read evidence.txt using file_editor view and reply with its exact contents.`;
    if (options.interactive) {
      delete runtimeEnv.CI; delete runtimeEnv.NO_COLOR; runtimeEnv.TERM = "xterm-256color";
      const ready = join(root, "automatic-evidence-ready");
      let observing = true;
      let observerFailure: unknown;
      const observer = (async () => {
        while (observing) {
          // UI repaints can split the file value. Observe the actual automatic
          // ledger instead, in a bounded child which emits only its predicate.
          const observation = await runProcess(process.execPath, ["--input-type=module", "-e",
            `import {openhandsAutomaticEvidenceReady} from ${JSON.stringify(import.meta.url)}; if(await openhandsAutomaticEvidenceReady(${JSON.stringify(repo)},${JSON.stringify(marker)},${JSON.stringify(secret)})) process.stdout.write("ready");`],
            { cwd: repo, env, timeoutMs: 5000 });
          if (observation.code === 0 && !observation.timedOut && observation.stdout === "ready") {
            await writeFile(ready, "automatic native evidence complete", { mode: 0o600 });
            return;
          }
          await new Promise(resolveWait => setTimeout(resolveWait, 250));
        }
      })().catch(error => { observerFailure = error; });
      let terminal;
      try {
        terminal = await runPty(binary, ["--always-approve", "--override-with-envs", "--exit-without-confirmation"], {
        cwd: repo, env, timeoutMs: options.timeoutMs ?? 120000, actions: [
          // The driver separates text and Enter by 150ms. No contiguous
          // terminal echo is required when the editor repaints the prompt.
          { waitFor: "Loaded:.*skills,.*hooks", send: prompt + "\r", delayMs: 250 },
          { waitFor: "", waitForPath: ready, send: "\x11", delayMs: 750 },
        ],
        });
      } finally {
        observing = false;
        await observer;
      }
      if (observerFailure) throw observerFailure;
      report.gates.interactiveTerminal = terminal.actionsCompleted === 2 && !terminal.timedOut && terminal.code === 0;
      if (!report.gates.interactiveTerminal) throw Error(`Interactive terminal incomplete: actions=${terminal.actionsCompleted}, code=${terminal.code}, timeout=${terminal.timedOut}; tail=${terminalTail(terminal.output)}`);
    } else await checked(binary, ["--headless", "--json", "--always-approve", "--override-with-envs", "--task", prompt], options.timeoutMs ?? 60_000);
    report.gates.tailWorkerCompleteAndExited = await awaitNativeTail(repo);
    // Early hooks retain additional full native state snapshots. Read the
    // actual ledger through annals rather than truncating a large JSONL export
    // at the subprocess driver's diagnostic-output limit.
    const ledger = await findRepo(repo);
    if (!ledger) throw new Error("Disposable OpenHands verification repository unavailable");
    const read = async (): Promise<EvidenceEvent[]> => readEvents(ledger, { reachableFrom: null });
    const nativeEvents = await read();
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(nativeEvents, "openhands");
    Object.assign(report.gates, openhandsEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("OpenHands native prompt/tool/session hook evidence incomplete; manual backfill was not attempted");
    }
    await checked(process.execPath, [cli, "capture", "openhands", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "openhands", "--all"]);
    const repeated = await read();
    const ids = (events: EvidenceEvent[]) => events.map((event) => event.id).sort().join("\n");
    report.gates.backfillIdempotent = ids(nativeEvents) === ids(backfilled) && ids(backfilled) === ids(repeated);
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
  } catch (error) {
    report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    if (guard) {
      report.requests = guard.state.forwarded;
      if (guard.state.blocked) { report.status = "blocked"; report.reason = guard.state.blocked; }
      await guard.close();
    }
    if (provider) await provider.close();
    await rm(root, { recursive: true, force: true });
    report.durationMs = Date.now() - started;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyScriptedOpenHands({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
