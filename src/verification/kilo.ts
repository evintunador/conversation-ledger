import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { EvidenceEvent } from "../schema.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";
import { startGuard } from "./guard.js";

export interface Report {
  schema: "cledger-verification/1"; cli: "kilo"; status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke"; inference: "configured-loopback" | "scripted"; version?: string; reason?: string; gates: Record<string, boolean>;
  mode?: "interactive" | "headless";
  platform: string; requests?: number;
  coverage: string[]; exclusions: string[]; durationMs: number;
}
export interface Options { apiKey?: string; endpoint?: string; model?: string; binary?: string; timeoutMs?: number; pollMs?: number; interactive?: boolean }

export function validateEndpoint(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("Only explicit HTTP loopback endpoints without URL credentials/query are supported");
  }
}

/** Assertions use normalized content, never raw/stdout where an echoed prompt could pass. */
export function kiloEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const own = events.filter(e => e.producer.source === "kilo");
  const blocks = (e: EvidenceEvent): Record<string, unknown>[] => {
    const c = e.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(c?.blocks) ? c.blocks : [];
  };
  const human = own.find(e => e.actor?.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes(marker)));
  const session = human?.stream?.id;
  const turns = session ? own.filter(e => e.stream?.id === session) : [];
  const calls = new Set(turns.flatMap(e => blocks(e)).filter(b => b.type === "tool_use" && b.name === "read" && typeof b.id === "string" && JSON.stringify(b.input).includes("evidence.txt")).map(b => b.id));
  return {
    noUnrecognizedRecords: own.length > 0 && !hasUnrecognizedEvidence(events, "kilo"),
    hookPrompt: !!human,
    hookToolUse: calls.size > 0,
    hookToolResult: turns.some(e => blocks(e).some(b => b.type === "tool_result" && calls.has(b.tool_use_id) && b.is_error !== true && JSON.stringify(b.content).includes(secret))),
    hookAnswer: turns.some(e => e.actor?.type === "agent" && blocks(e).some(b => b.type === "text" && String(b.text).includes(secret))),
  };
}

export async function verifyKilo(options: Options): Promise<Report> {
  const start = Date.now();
  const report: Report = { schema: "cledger-verification/1", cli: "kilo", status: "not-run", certification: "native-smoke", inference: "configured-loopback", mode: options.interactive ? "interactive" : "headless", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["native hook", "human text", "tool call/result", "assistant text", "backfill idempotency"],
    exclusions: ["interactive TUI", "attachments", "subagents", "compaction/rewind", "paid providers", "full record coverage"], durationMs: 0 };
  if (!["darwin", "linux"].includes(process.platform)) { report.reason = "Unsupported platform"; return report; }
  if (!options.endpoint || !options.model) { report.reason = "Set CLEDGER_VERIFY_ENDPOINT and CLEDGER_VERIFY_MODEL; no implicit inference endpoint"; return report; }
  try { validateEndpoint(options.endpoint); } catch (e) { report.status = "blocked"; report.reason = String(e); return report; }
  const root = await mkdtemp(join(tmpdir(), "cledger-native-"));
  const lock = join(tmpdir(), "cledger-native-inference.lock");
  let locked = false;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    try { await mkdir(lock); locked = true; } catch { report.status = "blocked"; report.reason = "Another native verification holds the inference lock (remove stale lock only after checking no runner is active)"; return report; }
    const repo = join(root, "repo"), bin = join(root, "bin");
    await Promise.all([repo, bin, join(root, "tmp"), join(root, "config", "kilo")].map(p => mkdir(p, { recursive: true })));
    const env = { ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`), KILO_DISABLE_AUTOUPDATE: "true", KILO_DISABLE_MODELS_FETCH: "true", KILO_DISABLE_DEFAULT_PLUGINS: "true", KILO_DISABLE_CLAUDE_CODE: "true", KILO_DISABLE_EXTERNAL_SKILLS: "true", KILO_DISABLE_LSP_DOWNLOAD: "true" };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nif (process.argv[2] === "hook") require("node:fs").appendFileSync(${JSON.stringify(join(root, "hook-pids"))}, process.pid + "\\n");\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    if (options.binary) await symlink(resolve(options.binary), join(bin, "kilo"));
    const run = (cmd: string, args: string[], timeoutMs = 20_000) => runProcess(cmd, args, { cwd: repo, env, timeoutMs, ...(guard ? { signal: guard.signal } : {}) });
    const checked = async (cmd: string, args: string[], timeoutMs?: number) => {
      const result = await run(cmd, args, timeoutMs);
      if (result.code !== 0 || result.timedOut) throw new Error(`${cmd} ${args[0]} failed${result.timedOut ? " (deadline)" : ` (exit ${result.code})`}: ${result.stderr.slice(-1500)}`);
      return result.stdout;
    };
    try { report.version = (await checked("kilo", ["--version"])).trim(); }
    catch { report.status = "blocked"; report.reason = "Kilo executable unavailable or version probe failed"; return report; }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated verification"]);
    guard = await startGuard(options.endpoint, 4, 60_000, options.apiKey);
    // Official custom-provider configuration: https://kilo.ai/docs/code-with-ai/platforms/cli-reference
    await writeFile(join(root, "config", "kilo", "kilo.json"), JSON.stringify({
      enabled_providers: ["verification"], model: `verification/${options.model}`, small_model: `verification/${options.model}`,
      share: "disabled", permission: { "*": "deny", read: "allow" }, agent: { build: { steps: 3 } },
      provider: { verification: { npm: "@ai-sdk/openai-compatible", name: "Verification loopback", options: {
        baseURL: guard.endpoint, apiKey: "TESTONLY-local-verification",
      }, models: { [options.model]: { name: options.model, limit: { context: 32768, output: 1024 } } } } },
    }));
    await checked(process.execPath, [cli, "install", "kilo"]);
    const plugin = await readFile(join(root, "config", "kilo", "plugin", "cledger.js"), "utf8");
    report.gates.installedHook = plugin.includes("session.idle");
    const prompt = `${marker}. Use the read tool to read evidence.txt. Reply with its exact contents. Do not call any other tool.`;
    if(options.interactive){
      const terminal=await runPty("kilo",["-m",`verification/${options.model}`,"--prompt",prompt],{cwd:repo,env:{...env,TERM:"xterm-256color"},timeoutMs:options.timeoutMs??45_000,
        actions:[{waitFor:secret,send:"/exit",delayMs:1000},{waitFor:"/exit",send:"\r",delayMs:250}]});
      report.gates.interactiveExit=!terminal.timedOut&&terminal.code===0&&terminal.actionsCompleted===2;
      report.coverage.push("interactive PTY session and exit (initial argv prompt)");report.exclusions=report.exclusions.filter(value=>value!=="interactive TUI");
      if(!report.gates.interactiveExit)throw new Error(`Kilo interactive terminal incomplete (${terminal.code}, actions=${terminal.actionsCompleted}, timeout=${terminal.timedOut}): ${terminal.output.slice(-2200)}`);
    }else await checked("kilo", ["run", "--format", "json", "-m", `verification/${options.model}`, prompt], options.timeoutMs ?? 120_000);
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"])).split("\n").filter(Boolean).map(s => JSON.parse(s) as EvidenceEvent);
    let events: EvidenceEvent[] = [];
    const deadline = Date.now() + (options.pollMs ?? 20_000);
    do {
      events = await read();
      Object.assign(report.gates, kiloEvidenceGates(events, marker, secret));
      if (Object.values(report.gates).every(Boolean)) break;
      await new Promise(r => setTimeout(r, 250));
    } while (Date.now() < deadline);
    // Never repair a failed hook via manual capture and then report success.
    if (!Object.values(report.gates).every(Boolean)) throw new Error("Native hook evidence incomplete before deadline; backfill not attempted");
    await checked(process.execPath, [cli, "capture", "kilo", "--all"]);
    const firstBackfill = await read();
    await checked(process.execPath, [cli, "capture", "kilo", "--all"]);
    const secondBackfill = await read();
    const ids = (list: EvidenceEvent[]) => list.map(e => e.id).sort().join("\n");
    report.gates.backfillIdempotent = ids(events) === ids(firstBackfill) && ids(firstBackfill) === ids(secondBackfill);
    report.gates.hookEvidenceRetained = events.every(e => secondBackfill.some(s => s.id === e.id));
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
  } catch (e) { report.status = "fail"; report.reason = e instanceof Error ? e.message : String(e); }
  finally {
    if (guard) {
      report.requests = guard.state.forwarded;
      if (guard.state.blocked) { report.status = "blocked"; report.reason = guard.state.blocked; }
      await guard.close();
    }
    report.durationMs = Date.now() - start;
    // The installed plugin detaches capture into its own process group.
    const pids = await readFile(join(root, "hook-pids"), "utf8").catch(() => "");
    for (const value of pids.trim().split("\n")) {
      const pid = Number(value);
      if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid, "SIGKILL"); } catch { /* already finished */ } }
    }
    await rm(root, { recursive: true, force: true });
    if (locked) await rm(lock, { recursive: true, force: true });
  }
  return report;
}

export async function verifyScriptedKilo(options: Options = {}): Promise<Report> {
  const provider = await startScriptedProvider({ noToolsCompletionText: "Verification Session" });
  try {
    const report = await verifyKilo({ ...options, endpoint: provider.endpoint, model: "fixture" });
    report.inference = "scripted";
    report.exclusions.push("real model/provider behavior");
    report.gates.scriptedRequests = provider.state.requests >= 2 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
    if (report.status === "pass" && !Object.values(report.gates).every(Boolean)) report.status = "fail";
    return report;
  } finally { await provider.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options: Options = {
    ...(process.env.CLEDGER_VERIFY_API_KEY ? { apiKey: process.env.CLEDGER_VERIFY_API_KEY } : {}),
    ...(process.env.CLEDGER_VERIFY_ENDPOINT ? { endpoint: process.env.CLEDGER_VERIFY_ENDPOINT } : {}),
    ...(process.env.CLEDGER_VERIFY_MODEL ? { model: process.env.CLEDGER_VERIFY_MODEL } : {}),
    ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}),
  };
  const report = process.argv.includes("--scripted")
    ? await verifyScriptedKilo(options)
    : await verifyKilo(options);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
