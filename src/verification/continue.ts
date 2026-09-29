import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";
import { startGuard } from "./guard.js";
import type { EvidenceEvent } from "../schema.js";
import type { Report } from "./opencode.js";

export type ContinueReport = Omit<Report, "cli"> & { cli: "continue" };
export function continueEvidenceGates(events: EvidenceEvent[], prompt: string, value: string) {
  const blocks = (e: EvidenceEvent) => (e.content as { blocks?: Record<string, unknown>[] }).blocks ?? [];
  const own = events.filter(e => e.producer.source === "continue");
  const human = own.find(e => e.actor.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes(prompt)));
  const turns = own.filter(e => human && e.stream?.id === human.stream?.id);
  const calls = new Set(turns.flatMap(blocks).filter(b => b.type === "tool_use" && b.name === "Read" && typeof b.id === "string" && JSON.stringify(b.input).includes("evidence.txt")).map(b => b.id));
  return {
    automaticPrompt: !!human,
    automaticToolUse: calls.size > 0,
    automaticToolResult: turns.some(e => e.actor.type === "system" && blocks(e).some(b => b.type === "tool_result" && calls.has(b.tool_use_id) && JSON.stringify(b.content).includes(value))),
    automaticAnswer: turns.some(e => e.actor.type === "agent" && blocks(e).some(b => b.type === "text" && String(b.text).includes(value))),
  };
}
export async function verifyScriptedContinue(options: { binary?: string; timeoutMs?: number; interactive?: boolean } = {}): Promise<ContinueReport> {
  const started = Date.now();
  const report: ContinueReport = { schema: "cledger-verification/1", cli: "continue", status: "not-run", certification: "native-smoke", inference: "scripted",
    platform: `${process.platform}/${process.arch}`, gates: {}, durationMs: 0,
    coverage: ["explicit launch wrapper", "human prompt", "linked file read", "assistant answer", "native snapshot revisions", "backfill idempotency"],
    exclusions: ["unwrapped sessions", "interactive TUI", "compaction/resume", "all record types", "real provider authentication"] };
  report.mode = options.interactive ? "interactive" : "headless";
  const root = await mkdtemp(join(tmpdir(), "cledger-continue-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), configRoot = join(root, ".continue");
    await Promise.all([repo, configRoot, join(root, "tmp")].map(p => mkdir(p, { recursive: true })));
    const env = isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin");
    env.CONTINUE_GLOBAL_DIR = configRoot; env.DO_NOT_TRACK = "1";
    const binary = options.binary ? resolve(options.binary) : "cn";
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const checked = async (command: string, args: string[], timeoutMs = 20_000) => {
      const outcome = await runProcess(command, args, { cwd: repo, env, timeoutMs, ...(guard ? { signal: guard.signal } : {}) });
      if (outcome.code !== 0 || outcome.timedOut) throw new Error(`${command} ${args[0]} failed (${outcome.timedOut ? "deadline" : outcome.code}): ${outcome.stderr.slice(-1500)}`);
      return outcome.stdout;
    };
    try { report.version = (await checked(binary, ["--version"])).trim(); }
    catch { report.status = "blocked"; report.reason = "Continue executable unavailable or version probe failed"; return report; }
    await checked("git", ["init", "--quiet"]);
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    await checked("git", ["add", "."]); await checked("git", ["commit", "--quiet", "-m", "isolated verification"]);
    provider = await startScriptedProvider({ toolName: "Read", toolArguments: { filepath: "evidence.txt" } });
    guard = await startGuard(provider.endpoint);
    const config = join(configRoot, "config.yaml");
    await writeFile(config, `name: Verification\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: fixture\n    provider: openai\n    model: gpt-4o\n    apiBase: ${guard.endpoint}\n    apiKey: TESTONLY-local-verification\n    roles: [chat]\n`);
    const prompt = `${marker}. Read evidence.txt and reply with the exact file contents.`;
    const launchArgs = [cli, "run", "continue", "--binary", binary, "--", "--config", config];
    if (options.interactive) {
      delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
      report.coverage.push("interactive PTY prompt and exit");
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      const terminal = await runPty(process.execPath, [...launchArgs, "--allow", "Read"], { cwd: repo, env, timeoutMs: options.timeoutMs ?? 30_000,
        actions: [{ waitFor: "Ask anything", send: prompt }, { waitFor: marker, send: "\r", delayMs: 600 }, { waitFor: secret, send: "/exit", delayMs: 600 }, { waitFor: "/exit", send: "\r", delayMs: 600 }] });
      report.gates.interactiveTerminal = terminal.actionsCompleted === 4 && !terminal.timedOut && terminal.code === 0;
      if (!report.gates.interactiveTerminal) throw new Error(`Interactive terminal incomplete: actions=${terminal.actionsCompleted}, code=${terminal.code}, timeout=${terminal.timedOut}; tail=${terminalTail(terminal.output)}`);
    } else await checked(process.execPath, [...launchArgs, "-p", prompt], options.timeoutMs ?? 90_000);
    const read = async () => (await checked(process.execPath, [cli, "export", "--all"])).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as EvidenceEvent);
    const before = await read(); Object.assign(report.gates, continueEvidenceGates(before, marker, secret));
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(before, "continue");
    if (!Object.values(report.gates).every(Boolean)) throw new Error("Automatic wrapper evidence incomplete; manual backfill not attempted");
    await checked(process.execPath, [cli, "capture", "continue", "--all"]); const first = await read();
    await checked(process.execPath, [cli, "capture", "continue", "--all"]); const second = await read();
    const ids = (events: EvidenceEvent[]) => events.map(e => e.id).sort().join();
    report.gates.backfillIdempotent = ids(before) === ids(first) && ids(first) === ids(second);
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
  } catch (error) { report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error); }
  finally {
    report.durationMs = Date.now() - started; report.requests = provider?.state.requests ?? 0;
    await guard?.close(); await provider?.close(); await rm(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = process.env.CLEDGER_VERIFY_BINARY;
  const report = await verifyScriptedContinue({ ...(binary ? { binary } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "pass" ? 0 : 1;
}
