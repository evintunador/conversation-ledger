import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { readCrushDatabase } from "../adapters/crush.js";
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

export type CrushReport = Omit<Report, "cli"> & { cli: "crush" };
export function crushEvidenceGates(events: EvidenceEvent[], prompt: string, value: string) {
  const blocks = (e: EvidenceEvent) => (e.content as { blocks?: Record<string, unknown>[] }).blocks ?? [];
  const own = events.filter(e => e.producer.source === "crush");
  const human = own.find(e => e.actor.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes(prompt)));
  const turns = own.filter(e => human && e.stream?.id === human.stream?.id);
  const calls = new Set(turns.flatMap(blocks).filter(b => b.type === "tool_use" && b.name === "view" && typeof b.id === "string" && JSON.stringify(b.input).includes("evidence.txt")).map(b => b.id));
  return {
    noUnrecognizedRecords: own.length > 0 && !hasUnrecognizedEvidence(events, "crush"),
    automaticPrompt: !!human,
    automaticToolUse: calls.size > 0,
    automaticToolResult: turns.some(e => e.actor.type === "system" && blocks(e).some(b => b.type === "tool_result" && calls.has(b.tool_use_id) && JSON.stringify(b.content).includes(value))),
    automaticAnswer: turns.some(e => e.actor.type === "agent" && blocks(e).some(b => b.type === "text" && String(b.text).includes(value))),
  };
}
export async function verifyScriptedCrush(options: { binary?: string; timeoutMs?: number; interactive?: boolean } = {}): Promise<CrushReport> {
  const started = Date.now();
  const report: CrushReport = { schema: "cledger-verification/1", cli: "crush", status: "not-run", certification: "native-smoke", inference: "scripted",
    mode: options.interactive ? "interactive" : "headless", platform: `${process.platform}/${process.arch}`, gates: {}, durationMs: 0,
    coverage: ["explicit launch wrapper", "human prompt", "linked file read", "assistant answer", "native SQLite persistence", "backfill idempotency"],
    exclusions: ["unwrapped sessions", "interactive TUI", "compaction/resume", "all record types", "real provider authentication"] };
  const root = await mkdtemp(join(tmpdir(), "cledger-crush-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo");
    await Promise.all([repo,join(root,"tmp")].map(path=>mkdir(path,{recursive:true})));
    const env = isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin");
    env.CRUSH_DISABLE_METRICS = "1"; env.CRUSH_DISABLE_PROVIDER_AUTO_UPDATE = "true"; env.CRUSH_DISABLE_DEFAULT_PROVIDERS = "true"; env.CRUSH_CLIENT_SERVER = "false"; env.DO_NOT_TRACK = "1";
    const binary = options.binary ? resolve(options.binary) : "crush";
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const checked = async (command: string, args: string[], timeoutMs = 20_000) => {
      const outcome = await runProcess(command, args, { cwd: repo, env, timeoutMs, ...(guard ? { signal: guard.signal } : {}) });
      if (outcome.code !== 0 || outcome.timedOut) throw new Error(`${command} ${args[0]} failed (${outcome.timedOut ? "deadline" : outcome.code}): ${outcome.stderr.slice(-1500)}`);
      return outcome.stdout;
    };
    try { report.version = (await checked(binary, ["--version"])).trim(); }
    catch { report.status = "blocked"; report.reason = "Crush executable unavailable or version probe failed"; return report; }
    await checked("git", ["init", "--quiet"]);
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    await checked("git", ["add", "."]); await checked("git", ["commit", "--quiet", "-m", "isolated verification"]);
    provider = await startScriptedProvider({ toolName: "view", toolArguments: { file_path: "evidence.txt" }, noToolsCompletionText: "Verification Session",
      ...(options.interactive ? { completionPrefix: "TESTONLY_OK " } : {}) });
    guard = await startGuard(provider.endpoint);
    const config = join(repo, "crush.json");
    await writeFile(config, JSON.stringify({
      providers: { verification: { id: "verification", name: "Verification", type: "openai-compat", base_url: guard.endpoint, api_key: "FAKE_TESTONLY_LOCAL_PROVIDER",
        models: [{ id: "fixture", name: "Fixture", context_window: 32768, default_max_tokens: 1024, can_reason: false, supports_attachments: false,
          cost_per_1m_in: 0, cost_per_1m_out: 0, cost_per_1m_in_cached: 0, cost_per_1m_out_cached: 0 }] } },
      models: { large: { provider: "verification", model: "fixture" }, small: { provider: "verification", model: "fixture" } },
      permissions: { allowed_tools: ["view"] }, options: { disable_provider_auto_update: true, disable_default_providers: true, disable_metrics: true }
    }));
    const prompt = `${marker}. Use the view tool to read evidence.txt and reply with its exact contents.`;
    const wrapper = [cli,"run","crush","--binary",binary,"--","--data-dir",join(repo,".crush")];
    if (options.interactive) {
      const terminal = await runPty(process.execPath, wrapper, {cwd:repo,env:{...env,TERM:"xterm-256color"},timeoutMs:options.timeoutMs??45_000,
        // Crush repaints a typed prompt in fragments, including backspaces.
        // Send Enter after the driver's separate text write instead of waiting
        // for a contiguous echo. Only the assistant's distinct completion
        // prefix triggers quit; linked exact-value evidence is checked below.
        actions:[{waitFor:"Would you like to initialize",send:"n"},{waitFor:"Ready[!.?]|Ready for instructions",send:prompt+"\r",delayMs:1000},{waitFor:"TESTONLY_OK",send:"\x03",delayMs:1000},{waitFor:"Are you sure you want to quit",send:"y"}]});
      report.gates.interactiveExit=!terminal.timedOut&&terminal.code===0&&terminal.actionsCompleted===4;
      report.coverage.push("interactive PTY keyboard prompt and exit");report.exclusions=report.exclusions.filter(value=>value!=="interactive TUI");
      if(!report.gates.interactiveExit)throw new Error(`Crush interactive terminal incomplete (${terminal.code}, actions=${terminal.actionsCompleted}, timeout=${terminal.timedOut}): ${terminal.output.slice(-2200)}`);
    } else await checked(process.execPath,[...wrapper,"run","--quiet",prompt],options.timeoutMs??90_000);
    const read = async () => (await checked(process.execPath, [cli, "export", "--all"])).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as EvidenceEvent);
    const before = await read(); Object.assign(report.gates, crushEvidenceGates(before, marker, secret));
    report.gates.noUnrecognizedRecords = before.some(e => e.producer.source === "crush") && !hasUnrecognizedEvidence(before,"crush");
    if (!Object.values(report.gates).every(Boolean)) {
      // Read-only diagnosis never imports records or repairs the capture gate.
      const native = await readCrushDatabase(join(repo,".crush","crush.db"));
      throw new Error(`Automatic wrapper evidence incomplete (${before.filter(e=>e.producer.source==="crush").length} records, ${native.tables.messages?.length ?? 0} native messages); manual backfill not attempted`);
    }
    await checked(process.execPath, [cli, "capture", "crush", "--all"]); const first = await read();
    await checked(process.execPath, [cli, "capture", "crush", "--all"]); const second = await read();
    const ids = (events: EvidenceEvent[]) => events.map(e => e.id).sort().join();
    report.gates.backfillIdempotent = ids(before) === ids(first) && ids(first) === ids(second);
    report.gates.agentHeader = provider.state.headersValid;
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
  } catch (error) { report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error); }
  finally {
    report.durationMs = Date.now() - started; report.requests = provider?.state.requests ?? 0;
    if (guard?.state.blocked) { report.status = "blocked"; report.reason = guard.state.blocked; }
    await guard?.close(); await provider?.close(); await rm(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = process.env.CLEDGER_VERIFY_BINARY;
  const report = await verifyScriptedCrush(binary ? { binary } : {});
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "pass" ? 0 : 1;
}
