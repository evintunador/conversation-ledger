import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KIMI_TAIL_DIRECTORY } from "../adapters/kimi.js";
import type { EvidenceEvent } from "../schema.js";
import { startGuard } from "./guard.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";

export interface KimiVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean; endpoint?: string; model?: string; apiKey?: string }
export interface KimiVerificationReport {
  schema: "cledger-verification/1";
  cli: "kimi";
  status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke";
  inference: "scripted" | "configured-loopback";
  model?: string;
  platform: string;
  mode?: "interactive" | "headless";
  version?: string;
  reason?: string;
  gates: Record<string, boolean>;
  requests?: number;
  coverage: string[];
  exclusions: string[];
  durationMs: number;
}

/** The secret is never in the prompt: only a real tool result can supply it. */
export function kimiEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "kimi");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "Read" &&
    (block.input as { path?: string } | undefined)?.path === "evidence.txt");
  return {
    noUnrecognizedRecords: own.length > 0 && !hasUnrecognizedEvidence(events, "kimi"),
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
    nativeSessionState: turns.some((event) => event.kind === "session_state" &&
      (event.content as { state_type?: string }).state_type === "metadata"),
  };
}

/** Observe installed background capture; never repair it by importing data. */
async function awaitNativeTail(repo: string): Promise<boolean> {
  const directory = join(repo, ".git", KIMI_TAIL_DIRECTORY), deadline = Date.now() + 12_000;
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
 * Real Kimi executable, real installed hooks, real git ledger, synthetic
 * loopback provider only. Defaults to a scripted provider; an explicitly
 * configured endpoint can run a local model without a subscription.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedKimi(options: KimiVerificationOptions = {}): Promise<KimiVerificationReport> {
  const started = Date.now();
  const report: KimiVerificationReport = {
    schema: "cledger-verification/1", cli: "kimi", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native hooks", "headless CLI", "human prompt", "tool call/result linkage", "assistant answer", "wire metadata", "backfill idempotency", "bounded tail worker exit"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions"], durationMs: 0,
  };
  const live = options.endpoint !== undefined || options.model !== undefined || options.apiKey !== undefined;
  if (live) {
    if (!options.endpoint || !options.model?.trim() || /[\r\n]/.test(options.model)) throw new Error("An explicit loopback endpoint and model are both required");
    const target = new URL(options.endpoint);
    if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password || target.search || target.hash)
      throw new Error("Configured provider must be an HTTP loopback endpoint");
    if (options.apiKey !== undefined && (!options.apiKey || /[\r\n]/.test(options.apiKey))) throw new Error("Configured API key must be nonempty and contain no newlines");
    report.inference = "configured-loopback"; report.model = options.model;
    report.exclusions = report.exclusions.filter(value => value !== "real provider/model behavior");
  }
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native Kimi verification currently supports macOS and Linux";
    return report;
  }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 19) {
    report.status = "blocked"; report.reason = "Kimi 2.1.1 requires Node >=22.19.0";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-kimi-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".kimi-code");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      KIMI_CODE_HOME: agentDir, KIMI_DISABLE_TELEMETRY: "1", KIMI_DISABLE_CRON: "1", KIMI_CODE_BUILTIN_PRODUCT_SKILLS: "0", KIMI_LOOP_MAX_STEPS_PER_TURN: "3", KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "1",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "kimi";
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
      report.reason = "Kimi executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Kimi verification"]);
    if (!live) provider = await startScriptedProvider({ toolName: "Read", toolArguments: { path: "evidence.txt" } });
    const model = live ? options.model! : "fixture";
    guard = await startGuard(live ? options.endpoint! : provider!.endpoint, 4, live ? 180_000 : Math.min(options.timeoutMs ?? 30_000, 30_000), options.apiKey ?? "TESTONLY-local-verification", { maxOutputTokens: 1024 });
    await writeFile(join(agentDir, "config.toml"), `default_model = "fixture"
telemetry = false
[providers.verification]
type = "openai"
base_url = ${JSON.stringify(guard.endpoint)}
api_key = "local-verification"
[models.fixture]
provider = "verification"
model = ${JSON.stringify(model)}
max_context_size = 32768
capabilities = ["tool_use"]
[loop_control]
max_steps_per_turn = 3
max_attempts_per_step = 1
`);
    await checked(process.execPath, [cli, "install", "kimi"]);
    const config = await readFile(join(agentDir, "config.toml"), "utf8");
    report.gates.installedHook = config.includes('event = "SessionEnd"') && config.includes('event = "Stop"');
    const prompt = `${marker}. Read evidence.txt using the Read tool and reply with its exact contents. Do not use any other tools.`;
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    if (options.interactive) {
      const ready = join(root, "automatic-answer-ready");
      let stopped = false;
      const observer = (async () => {
        while (!stopped) {
          try {
            if (guard!.state.blocked || Object.values(kimiEvidenceGates(await read(), marker, secret)).every(Boolean)) { await writeFile(ready, "ready"); return; }
          } catch { /* Initial export can precede the first native hook. */ }
          await new Promise(done => setTimeout(done, 250));
        }
      })();
      let terminal: Awaited<ReturnType<typeof runPty>>;
      try {
        terminal = await runPty(binary, ["--model", "fixture", "--auto"], { cwd: repo, env: { ...env, TERM: "xterm-256color" }, timeoutMs: options.timeoutMs ?? (live ? 360_000 : 45_000),
          // Native versions display either the selected alias or upstream ID.
          // Both routes select our isolated fixture alias; escape the ID before
          // using it as a terminal predicate.
          actions: [{waitFor:"Trust this folder",send:"\r"},{waitFor:"fixture|" + model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),send:prompt},{waitFor:"tools[.]",send:"\r",delayMs:250},{waitFor:"^",waitForPath:ready,send:"/exit",delayMs:1000},{waitFor:"/exit",send:"\r",delayMs:250}] });
      } finally { stopped = true; await observer; }
      report.gates.interactiveExit = !terminal.timedOut && terminal.code === 0 && terminal.actionsCompleted === 5;
      report.coverage=report.coverage.map(value=>value==="headless CLI"?"interactive PTY keyboard prompt and exit":value);
      report.exclusions=report.exclusions.filter(value=>value!=="interactive TUI");
      if (!report.gates.interactiveExit) throw new Error(`Kimi interactive terminal incomplete (${terminal.code}, actions=${terminal.actionsCompleted}, timeout=${terminal.timedOut}): ${terminal.output.slice(-2200)}`);
    } else await checked(binary, ["--model", "fixture", "--output-format", "stream-json", "--prompt", prompt], options.timeoutMs ?? (live ? 360_000 : 60_000));
    report.gates.tailWorkerCompleteAndExited = await awaitNativeTail(repo);
    const nativeEvents = await read();
    Object.assign(report.gates, kimiEvidenceGates(nativeEvents, marker, secret));
    report.gates.requestBudget = guard.state.forwarded > 0 && guard.state.forwarded <= 4;
    if (provider) report.gates.agentHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("Kimi native hook evidence incomplete; manual backfill was not attempted");
    }
    await checked(process.execPath, [cli, "capture", "kimi", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "kimi", "--all"]);
    const repeated = await read();
    const ids = (events: EvidenceEvent[]) => events.map((event) => event.id).sort().join("\n");
    report.gates.backfillIdempotent = ids(nativeEvents) === ids(backfilled) && ids(backfilled) === ids(repeated);
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
    if (!report.gates.backfillIdempotent) report.reason = "Native automatic capture missed persisted tail records; first backfill changed ledger identities";
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
  const report = await verifyScriptedKimi({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}),
    interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1",
    ...(process.env.CLEDGER_VERIFY_ENDPOINT ? { endpoint: process.env.CLEDGER_VERIFY_ENDPOINT, timeoutMs: 360_000 } : {}),
    ...(process.env.CLEDGER_VERIFY_MODEL ? { model: process.env.CLEDGER_VERIFY_MODEL, timeoutMs: 360_000 } : {}),
    ...(process.env.CLEDGER_VERIFY_API_KEY ? { apiKey: process.env.CLEDGER_VERIFY_API_KEY } : {}) });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
