import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { startGuard } from "./guard.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";

export interface PiVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }
export interface PiVerificationReport {
  schema: "cledger-verification/1";
  cli: "pi";
  status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke";
  inference: "scripted";
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
export function piEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "pi");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "read" &&
    (block.input as { path?: string } | undefined)?.path === "evidence.txt");
  return {
    noUnrecognizedRecords: own.length > 0 && !hasUnrecognizedEvidence(events, "pi"),
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
    nativeSessionState: turns.some((event) => event.kind === "session_state" &&
      (event.content as { state_type?: string }).state_type === "session"),
  };
}

/**
 * Real Pi executable, real installed extension, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedPi(options: PiVerificationOptions = {}): Promise<PiVerificationReport> {
  const started = Date.now();
  const report: PiVerificationReport = {
    schema: "cledger-verification/1", cli: "pi", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native extension", "headless CLI", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions"], durationMs: 0,
  };
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native Pi verification currently supports macOS and Linux";
    return report;
  }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 19) {
    report.status = "blocked"; report.reason = "Pi 0.87.1 requires Node >=22.19.0";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-pi-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".pi", "agent");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "pi";
    // The extension discovers cledger through PATH, just as in an installed
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
      report.reason = "Pi executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Pi verification"]);
    provider = await startScriptedProvider({ toolName: "read", toolArguments: { path: "evidence.txt" } });
    guard = await startGuard(provider.endpoint, 4, Math.min(options.timeoutMs ?? 30_000, 30_000));
    // Official Pi models.json custom-provider configuration. No environment
    // credentials are inherited; startup catalog/network fetches are offline.
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      verification: { baseUrl: guard.endpoint, api: "openai-completions", apiKey: "local-verification",
        models: [{ id: "fixture", name: "Scripted verification", contextWindow: 32768, maxTokens: 1024,
          input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "verification", defaultModel: "fixture", retry: { enabled: false }, quietStartup: true }));
    await checked(process.execPath, [cli, "install", "pi"]);
    const extension = await readFile(join(agentDir, "extensions", "cledger.ts"), "utf8");
    report.gates.installedHook = extension.includes("session_shutdown") && extension.includes("getSessionFile");
    const prompt = `${marker}. Read evidence.txt using the read tool and reply with its exact contents. Do not use any other tools.`;
    const nativeArgs = ["--offline", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--tools", "read", "--thinking", "off", "--provider", "verification", "--model", "fixture"];
    if (options.interactive) {
      const terminal = await runPty(binary, [...nativeArgs, prompt], { cwd: repo, env: { ...env, TERM: "xterm-256color" }, timeoutMs: options.timeoutMs ?? 60_000,
        actions: [{ waitFor: secret, send: "/quit\r" }] });
      report.gates.interactiveExit = !terminal.timedOut && terminal.code === 0 && terminal.actionsCompleted === 1;
      report.coverage = report.coverage.map(value => value === "headless CLI" ? "interactive PTY session and exit" : value);
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      if (!report.gates.interactiveExit) throw new Error(`Pi interactive terminal did not complete (${terminal.code}, timeout=${terminal.timedOut}): ${terminal.output.slice(-1600)}`);
    } else await checked(binary, [...nativeArgs, "--mode", "json", "--print", prompt], options.timeoutMs ?? 60_000);
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    const nativeEvents = await read();
    Object.assign(report.gates, piEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("Pi native extension evidence incomplete; manual backfill was not attempted");
    }
    await checked(process.execPath, [cli, "capture", "pi", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "pi", "--all"]);
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
  const report = await verifyScriptedPi(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {});
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
