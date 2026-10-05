import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { startScriptedResponsesProvider } from "./codex.js";
import { isolatedEnvironment, runProcess } from "./process.js";


export interface OpenInterpreterVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }

async function awaitNativeTail(repo: string): Promise<boolean> {
  const directory = join(repo, ".git", "cledger-open-interpreter-tail"), deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const names = await readdir(directory), statuses = names.filter(name => name.endsWith(".json"));
      if (statuses.length && !names.some(name => name.endsWith(".lock"))) {
        let exited = true;
        for (const name of statuses) {
          const status = JSON.parse(await readFile(join(directory, name), "utf8")) as { status?: string; pid?: number };
          if (status.status !== "complete" || !status.pid) return false;
          try { process.kill(status.pid, 0); exited = false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") exited = false; }
        }
        if (exited) return true;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(done => setTimeout(done, 100));
  }
  return false;
}
export interface OpenInterpreterVerificationReport {
  schema: "cledger-verification/1";
  cli: "open-interpreter";
  status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke";
  mode: "headless" | "interactive";
  inference: "scripted";
  platform: string;
  version?: string;
  reason?: string;
  gates: Record<string, boolean>;
  requests?: number;
  coverage: string[];
  exclusions: string[];
  durationMs: number;
}

/** The secret is never in the prompt: only a real tool result can supply it. */
export function openInterpreterEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "open-interpreter");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && ["exec_command", "shell_command", "shell"].includes(String(block.name)) &&
    typeof block.input === "string" && block.input.includes("evidence.txt"));
  return {
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
    nativeSessionState: turns.some((event) => event.kind === "session_state" &&
      (event.content as { state_type?: string }).state_type === "session_meta"),
  };
}

/**
 * Real OpenInterpreter executable, installed Stop and SessionEnd hooks, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedOpenInterpreter(options: OpenInterpreterVerificationOptions = {}): Promise<OpenInterpreterVerificationReport> {
  const started = Date.now();
  const report: OpenInterpreterVerificationReport = {
    schema: "cledger-verification/1", cli: "open-interpreter", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native Stop + SessionEnd hooks with isolated invocation trust bypass", "headless exec", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions", "interactive hook trust review"], durationMs: 0,
  };
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native OpenInterpreter verification currently supports macOS and Linux";
    return report;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "cledger-open-interpreter-native-")));
  let provider: Awaited<ReturnType<typeof startScriptedResponsesProvider>> | undefined;

  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".openinterpreter");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      INTERPRETER_HOME: agentDir,
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "interpreter";
    // The hook discovers cledger through PATH, just as in an installed
    // user's environment; it invokes the built CLI, never parser functions.
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    const run = (command: string, args: string[], timeoutMs = 20_000) => runProcess(command, args, {
      cwd: repo, env, timeoutMs, ...(provider ? { signal: provider.signal } : {}),
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
      report.reason = "OpenInterpreter executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated OpenInterpreter verification"]);
    provider = await startScriptedResponsesProvider();
    // Official custom Responses provider, confined to the loopback fixture.
    await writeFile(join(agentDir, "config.toml"), [
      options.interactive ? 'model = "ledger-test"' : 'model = "gpt-5.4"', 'check_for_update_on_startup = false', 'model_provider = "verification"', 'approval_policy = "never"',
      '[model_providers.verification]', 'name = "Scripted verification"',
      `base_url = ${JSON.stringify(provider.endpoint)}`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
      ...(options.interactive ? [`[projects.${JSON.stringify(repo)}]`, 'trust_level = "trusted"'] : []),
    ].join("\n") + "\n");
    await checked(process.execPath, [cli, "install", "open-interpreter"]);
    const hook = await readFile(join(agentDir, "config.toml"), "utf8");
    report.gates.installedHook = hook.includes("hooks.Stop") && hook.includes("hooks.SessionEnd") && hook.includes("hook open-interpreter");
    // https://www.openinterpreter.com/docs/terminal/hooks documents this invocation-only
    // bypass for automation that vets its hook sources. Only our disposable
    // generated config is loaded; user trust/config/auth files are untouched.
    const prompt = `${marker}. Read evidence.txt using the shell tool and reply with its exact contents.`;
    if (options.interactive) {
      const terminal = await runPty(binary, ["--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--no-alt-screen", prompt], {
        cwd: repo, env: { ...env, TERM: "xterm-256color" }, timeoutMs: options.timeoutMs ?? 60_000,
        // A streamed answer can precede Stop. Wait for its native hook to
        // write a note before closing the TUI; final tail remains gated below.
        actions: [{ waitFor: secret, waitForPath: join(repo, ".git", "refs", "notes", "conversation-ledger"), send: "/exit\r" }],
      });
      report.gates.interactiveExit = !terminal.timedOut && terminal.code === 0 && terminal.actionsCompleted === 1;
      report.coverage = report.coverage.map(value => value === "headless exec" ? "interactive PTY session and exit" : value);
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      if (!report.gates.interactiveExit) throw new Error(`Open Interpreter interactive terminal incomplete: ${JSON.stringify({ ...terminal, output: terminal.output.slice(-4000) })}`);
    } else {
    await checked(binary, ["exec", "--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--json", prompt],
      options.timeoutMs ?? 60_000);
    }
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    report.gates.tailWorkerCompleteAndExited = await awaitNativeTail(repo);
    const nativeEvents = await read();
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(nativeEvents, "open-interpreter");
    Object.assign(report.gates, openInterpreterEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;

    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("OpenInterpreter native Stop hook evidence incomplete; manual backfill was not attempted");
    }
    const sessions = join(agentDir, "sessions");
    const rollouts = (await readdir(sessions, { recursive: true })).filter((path) => path.endsWith(".jsonl") && path.includes("rollout-"));
    if (rollouts.length !== 1) throw new Error("Expected exactly one isolated native rollout for backfill verification");
    const transcript = join(sessions, rollouts[0]!);
    await checked(process.execPath, [cli, "capture", "open-interpreter", "--transcript", transcript]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "open-interpreter", "--transcript", transcript]);
    const repeated = await read();
    const ids = (events: EvidenceEvent[]) => events.map((event) => event.id).sort().join("\n");
    report.gates.hookCapturedFinalTail = ids(nativeEvents) === ids(backfilled);
    if (!report.gates.hookCapturedFinalTail) {
      const missing = backfilled.filter((event) => !nativeEvents.some((captured) => captured.id === event.id));
      report.reason = `Native hooks missed ${missing.length} final record(s): ` + missing.map((event) => {
        const raw = event.raw?.data as { type?: string; payload?: { type?: string } } | undefined;
        return `${event.kind}/${raw?.type ?? "unknown"}/${raw?.payload?.type ?? "unknown"}`;
      }).join(", ");
    }
    report.gates.backfillIdempotent = ids(backfilled) === ids(repeated);
    report.gates.hookEvidenceRetained = nativeEvents.every((event) => repeated.some((after) => after.id === event.id));
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
  } catch (error) {
    report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    if (provider) {
      report.requests = provider.state.requests;
      if (provider.state.blocked) { report.status = "blocked"; report.reason = provider.state.blocked; }
    }
    if (provider) await provider.close();
    await rm(root, { recursive: true, force: true });
    report.durationMs = Date.now() - started;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyScriptedOpenInterpreter({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
