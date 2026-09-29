import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { startGuard } from "./guard.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";

export interface GooseVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }
export interface GooseVerificationReport {
  schema: "cledger-verification/1";
  cli: "goose";
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
export function gooseEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "goose");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "shell" &&
    (block.input as { command?: unknown })?.command === "cat evidence.txt");
  return {
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && block.is_error !== true && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
    nativeSessionState: turns.some((event) => event.kind === "session_state" &&
      (event.content as { state_type?: string }).state_type === "session"),
  };
}

/**
 * Real Goose executable, real installed Stop + SessionEnd hook, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedGoose(options: GooseVerificationOptions = {}): Promise<GooseVerificationReport> {
  const started = Date.now();
  const report: GooseVerificationReport = {
    schema: "cledger-verification/1", cli: "goose", status: "not-run", certification: "native-smoke",
    inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native Stop + SessionEnd plugin hooks", "headless CLI", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions"], durationMs: 0,
  };
  report.mode = options.interactive ? "interactive" : "headless";
  if (options.interactive) {
    report.coverage = report.coverage.map(item => item === "headless CLI" ? "interactive PTY terminal input" : item);
    report.exclusions = report.exclusions.filter(item => item !== "interactive TUI");
  }
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native Goose verification currently supports macOS and Linux";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-goose-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, "goose");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      GOOSE_PATH_ROOT: agentDir, GOOSE_DISABLE_KEYRING: "1", GOOSE_DISABLE_SESSION_NAMING: "true",
      GOOSE_TELEMETRY_ENABLED: "false", GOOSE_MODE: "auto", OPENAI_API_KEY: "FAKE_TESTONLY_LOCAL",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "goose";
    if (options.binary) await symlink(binary, join(bin, "goose"));
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
      report.reason = "Goose executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Goose verification"]);
    provider = await startScriptedProvider({ toolName: "shell", toolArguments: { command: "cat evidence.txt" },
      ...(options.interactive ? { completionPrefix: "TESTONLY_OK " } : {}) });
    guard = await startGuard(provider.endpoint, 4, Math.min(options.timeoutMs ?? 30_000, 30_000));
    const runtimeEnv = env as NodeJS.ProcessEnv;
    runtimeEnv.OPENAI_BASE_URL = guard.endpoint;
    await checked(process.execPath, [cli, "install", "goose"]);
    const hook = await readFile(join(agentDir, ".agents", "plugins", "conversation-ledger", "hooks", "hooks.json"), "utf8");
    report.gates.installedHook = hook.includes("Stop") && hook.includes("SessionEnd") && hook.includes("hook goose");
    const prompt = `${marker}. Read evidence.txt using shell and reply with its exact contents.`;
    if (options.interactive) {
      delete runtimeEnv.CI; delete runtimeEnv.NO_COLOR; runtimeEnv.TERM = "xterm-256color";
      const terminal = await runPty(binary, ["session", "--no-profile", "--with-builtin", "developer", "--provider", "openai", "--model", "gpt-4o", "--max-turns", "3"], {
        cwd: repo, env, timeoutMs: options.timeoutMs ?? 60000, actions: [
          { waitFor: "Enter to send", send: prompt, delayMs: 250 },
          { waitFor: "exact contents", send: "\r", delayMs: 250 },
          { waitFor: "TESTONLY_OK", send: "", delayMs: 250 },
          { waitFor: "Enter to send", send: "/exit", delayMs: 500 },
          { waitFor: "exit", send: "\r", delayMs: 250 },
        ],
      });
      report.gates.interactiveTerminal = terminal.actionsCompleted === 5 && !terminal.timedOut && terminal.code === 0;
      if (!report.gates.interactiveTerminal) throw Error(`Interactive terminal incomplete: actions=${terminal.actionsCompleted}, code=${terminal.code}, timeout=${terminal.timedOut}; tail=${terminalTail(terminal.output)}`);
    } else await checked(binary, ["run", "--no-profile", "--with-builtin", "developer", "--provider", "openai", "--model", "gpt-4o",
      "--max-turns", "3", "--output-format", "json", "--text", prompt], options.timeoutMs ?? 60_000);
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    const nativeEvents = await read();
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(nativeEvents, "goose");
    Object.assign(report.gates, gooseEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("Goose native Stop + SessionEnd hook evidence incomplete; manual backfill was not attempted");
    }
    await checked(process.execPath, [cli, "capture", "goose", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "goose", "--all"]);
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
  const report = await verifyScriptedGoose({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
