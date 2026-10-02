import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { startGuard } from "./guard.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";

export interface MistralVibeVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }
export interface MistralVibeVerificationReport {
  schema: "cledger-verification/1";
  cli: "mistral-vibe";
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
export function mistralVibeEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "mistral-vibe");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "read_file" &&
    typeof block.input === "string" && block.input.includes("evidence.txt"));
  return {
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

/**
 * Real Mistral Vibe executable, real installed post_agent hook, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedMistralVibe(options: MistralVibeVerificationOptions = {}): Promise<MistralVibeVerificationReport> {
  const started = Date.now();
  const report: MistralVibeVerificationReport = {
    schema: "cledger-verification/1", cli: "mistral-vibe", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native post_agent hook", "legacy backend headless CLI", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions", "unified backend (including rollout-selected installations)"], durationMs: 0,
  };
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native Mistral Vibe verification currently supports macOS and Linux";
    return report;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "cledger-vibe-native-")));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".vibe");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      VIBE_HOME: agentDir, VIBE_VERIFICATION_KEY: "FAKE_TESTONLY_LOCAL",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "vibe";
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
      report.reason = "Mistral Vibe executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Mistral Vibe verification"]);
    provider = await startScriptedProvider({ toolName: "read_file", toolArguments: { file_path: join(repo, "evidence.txt") } });
    guard = await startGuard(provider.endpoint, 4, Math.min(options.timeoutMs ?? 30_000, 30_000));
    // Pinned Vibe 2.25.8 config schema: custom generic OpenAI-compatible
    // provider; explicitly select the supported legacy backend below.
    await writeFile(join(agentDir, "config.toml"), [
      'active_model = "fixture"', 'enable_telemetry = false',
      'enable_update_checks = false', 'enable_auto_update = false',
      '[[providers]]', 'name = "verification"', `api_base = ${JSON.stringify(guard.endpoint)}`,
      'api_key_env_var = "VIBE_VERIFICATION_KEY"', 'api_style = "openai"',
      '[[models]]', 'name = "fixture"', 'provider = "verification"', 'alias = "fixture"',
      '[session_logging]', 'enabled = true', 'generate_titles = false',
    ].join("\n") + "\n");
    await checked(process.execPath, [cli, "install", "mistral-vibe"]);
    const hook = await readFile(join(agentDir, "hooks.toml"), "utf8");
    report.gates.installedHook = hook.includes("post_agent") && hook.includes("hook mistral-vibe");
    const prompt = `${marker}. Read evidence.txt using the read_file tool and reply with its exact contents.`;
    if (options.interactive) {
      const terminal = await runPty(binary, ["--legacy-harness", "--trust", "--auto-approve", "--enabled-tools", "read_file", "--", prompt], {
        cwd: repo, env: { ...env, TERM: "xterm-256color" }, timeoutMs: options.timeoutMs ?? 60_000,
        // The answer can stream before post_agent runs. Exit only after the
        // installed hook has committed its first note in this fresh repo.
        actions: [{ waitFor: secret, waitForPath: join(repo, ".git", "refs", "notes", "conversation-ledger"), send: "/exit\r" }],
      });
      report.gates.interactiveExit = !terminal.timedOut && terminal.code === 0 && terminal.actionsCompleted === 1;
      report.coverage = report.coverage.map(value => value === "legacy backend headless CLI" ? "legacy backend interactive PTY session and exit" : value);
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      if (!report.gates.interactiveExit) throw new Error(`Vibe interactive terminal incomplete: ${JSON.stringify({ ...terminal, output: terminal.output.slice(-4000) })}`);
    } else {
    await checked(binary, ["--legacy-harness", "--auto-approve", "--enabled-tools", "read_file",
      "--max-turns", "3", "--output", "json", "--prompt", prompt], options.timeoutMs ?? 60_000);
    }
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    const nativeEvents = await read();
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(nativeEvents, "mistral-vibe");
    Object.assign(report.gates, mistralVibeEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("Mistral Vibe native post_agent hook evidence incomplete; manual backfill was not attempted");
    }
    await checked(process.execPath, [cli, "capture", "mistral-vibe", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "mistral-vibe", "--all"]);
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
  const report = await verifyScriptedMistralVibe({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
