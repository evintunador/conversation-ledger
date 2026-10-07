import { hasUnrecognizedEvidence } from "./drift.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { EvidenceEvent } from "../schema.js";
import { runPty, terminalTail } from "./pty.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { verifyScriptedOpencode } from "./scripted.js";
export { verifyScriptedOpencode } from "./scripted.js";
import { startGuard } from "./guard.js";

export interface Report {
  schema: "cledger-verification/1"; cli: "opencode"; status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke"; inference: "configured-loopback" | "scripted"; version?: string; reason?: string; gates: Record<string, boolean>;
  mode?: "headless" | "interactive";
  platform: string; requests?: number;
  coverage: string[]; exclusions: string[]; durationMs: number;
}
export interface Options { interactive?: boolean; apiKey?: string; endpoint?: string; model?: string; binary?: string; timeoutMs?: number; pollMs?: number; resume?: boolean }

export function validateEndpoint(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("Only explicit HTTP loopback endpoints without URL credentials/query are supported");
  }
}

/** Assertions use normalized content, never raw/stdout where an echoed prompt could pass. */
export function evidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const own = events.filter(e => e.producer.source === "opencode");
  const blocks = (e: EvidenceEvent): Record<string, unknown>[] => {
    const c = e.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(c?.blocks) ? c.blocks : [];
  };
  const human = own.find(e => e.actor?.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes(marker)));
  const session = human?.stream?.id;
  const turns = session ? own.filter(e => e.stream?.id === session) : [];
  const calls = new Set(turns.flatMap(e => blocks(e)).filter(b => b.type === "tool_use" && b.name === "read" && typeof b.id === "string" && JSON.stringify(b.input).includes("evidence.txt")).map(b => b.id));
  return {
    hookPrompt: !!human,
    hookToolUse: calls.size > 0,
    hookToolResult: turns.some(e => blocks(e).some(b => b.type === "tool_result" && calls.has(b.tool_use_id) && b.is_error !== true && JSON.stringify(b.content).includes(secret))),
    hookAnswer: turns.some(e => e.actor?.type === "agent" && blocks(e).some(b => b.type === "text" && String(b.text).includes(secret))),
  };
}

export async function verifyOpencode(options: Options): Promise<Report> {
  const start = Date.now();
  const report: Report = { schema: "cledger-verification/1", cli: "opencode", status: "not-run", certification: "native-smoke", inference: "configured-loopback", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["native hook", "human text", "tool call/result", "assistant text", "backfill idempotency"],
    exclusions: ["interactive TUI", "attachments", "subagents", "compaction/rewind", "paid providers", "full record coverage"], durationMs: 0 };
  report.mode = options.interactive ? "interactive" : "headless";
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
    await Promise.all([repo, bin, join(root, "tmp"), join(root, "config", "opencode")].map(p => mkdir(p, { recursive: true })));
    const env = isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nif (process.argv[2] === "hook") require("node:fs").appendFileSync(${JSON.stringify(join(root, "hook-pids"))}, process.pid + "\\n");\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    if (options.binary) await symlink(resolve(options.binary), join(bin, "opencode"));
    const run = (cmd: string, args: string[], timeoutMs = 20_000) => runProcess(cmd, args, { cwd: repo, env, timeoutMs, ...(guard ? { signal: guard.signal } : {}) });
    const checked = async (cmd: string, args: string[], timeoutMs?: number) => {
      const result = await run(cmd, args, timeoutMs);
      if (result.code !== 0 || result.timedOut) throw new Error(`${cmd} ${args[0]} failed${result.timedOut ? " (deadline)" : ` (exit ${result.code})`}`);
      return result.stdout;
    };
    try { report.version = (await checked("opencode", ["--version"])).trim(); }
    catch { report.status = "blocked"; report.reason = "OpenCode executable unavailable or version probe failed"; return report; }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated verification"]);
    guard = await startGuard(options.endpoint, options.resume ? 8 : 4, 60_000, options.apiKey, { maxOutputTokens: 1024 });
    // Official custom-provider configuration: https://opencode.ai/docs/providers/#custom-provider
    await writeFile(join(root, "config", "opencode", "opencode.json"), JSON.stringify({
      enabled_providers: ["verification"], model: `verification/${options.model}`, small_model: `verification/${options.model}`,
      share: "disabled", permission: { "*": "deny", read: "allow" }, agent: { build: { steps: 3 } },
      provider: { verification: { npm: "@ai-sdk/openai-compatible", name: "Verification loopback", options: {
        baseURL: guard.endpoint, apiKey: "TESTONLY-local-verification",
      }, models: { [options.model]: { name: options.model, limit: { context: 32768, output: 1024 } } } } },
    }));
    await checked(process.execPath, [cli, "install", "opencode"]);
    const plugin = await readFile(join(root, "config", "opencode", "plugin", "cledger.js"), "utf8");
    report.gates.installedHook = plugin.includes("session.idle");
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"])).split("\n").filter(Boolean).map(s => JSON.parse(s) as EvidenceEvent);
    let events: EvidenceEvent[] = [], nativeSession: string | undefined;
    for (const resume of options.resume ? [false, true] : [false]) {
      const turnMarker = resume ? `cledger-resume-${randomUUID()}` : marker;
      const turnSecret = resume ? `file-value-${randomUUID()}` : secret;
      if (resume) await writeFile(join(repo, "evidence.txt"), turnSecret + "\n");
      const prompt = `${turnMarker}. Use the read tool to read evidence.txt now. Reply with its exact contents. Do not call any other tool.`;
      if (options.interactive) {
        delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
        report.coverage = ["interactive PTY terminal input", "native hook", "human text", "tool call/result", "assistant text", "backfill idempotency"];
        report.exclusions = report.exclusions.filter(x => x !== "interactive TUI");
        const complete = join(root, resume ? "resume-answer-complete" : "native-answer-complete");
        let stopObservation = false;
        const observer = (async () => {
          while (!stopObservation) {
            try {
              const snapshot = await read();
              if (!hasUnrecognizedEvidence(snapshot, "opencode") && Object.values(evidenceGates(snapshot, turnMarker, turnSecret)).every(Boolean)) {
                await writeFile(complete, ""); return;
              }
            } catch { /* Native hooks may still be writing. */ }
            await new Promise(done => setTimeout(done, 250));
          }
        })();
        let terminal;
        try {
          terminal = await runPty("opencode", resume ? ["--session", nativeSession!] : [], { cwd: repo, env, answerTerminalQueries: false, timeoutMs: options.timeoutMs ?? 120000, actions: [
            { waitFor: "Ask anything|Ask a question|Build", send: `${prompt}\r` },
            { waitFor: "^", waitForPath: complete, send: "/exit\r" },
          ] });
        } finally { stopObservation = true; await observer; }
        const exited = terminal.actionsCompleted === 2 && !terminal.timedOut && terminal.code === 0;
        report.gates[resume ? "resumeTerminal" : "interactiveTerminal"] = exited;
        if (!exited) throw Error(`Interactive terminal incomplete: ${terminalTail(terminal.output)}`);
      } else await checked("opencode", ["run", "--format", "json", "-m", `verification/${options.model}`, ...(resume ? ["--session", nativeSession!] : []), prompt], options.timeoutMs ?? 120000);
      report.gates[resume ? "resumeNormalExit" : "normalExit"] = true;
      const deadline = Date.now() + (options.pollMs ?? 20000);
      let passed = false;
      do {
        events = await read();
        const gates = evidenceGates(events, turnMarker, turnSecret);
        passed = !hasUnrecognizedEvidence(events, "opencode") && Object.values(gates).every(Boolean);
        if (passed) {
          report.gates.noUnrecognizedRecords = true;
          if (!resume) Object.assign(report.gates, gates);
          break;
        }
        await new Promise(done => setTimeout(done, 250));
      } while (Date.now() < deadline);
      if (!passed) throw Error("Native hook evidence incomplete before deadline; backfill not attempted");
      const human = events.find(e => e.actor.type === "human" && JSON.stringify(e.content).includes(turnMarker));
      if (!resume) nativeSession = human?.producer.session_id;
      else report.gates.resume = !!nativeSession && human?.producer.session_id === nativeSession;
      if (!nativeSession) throw Error("Native session ID missing");
    }
    report.gates.automaticBeforeBackfill = true;
    await checked(process.execPath, [cli, "capture", "opencode", "--all"]);
    const firstBackfill = await read();
    await checked(process.execPath, [cli, "capture", "opencode", "--all"]);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options: Options = { interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1",
    ...(process.env.CLEDGER_VERIFY_API_KEY ? { apiKey: process.env.CLEDGER_VERIFY_API_KEY } : {}),
    ...(process.env.CLEDGER_VERIFY_ENDPOINT ? { endpoint: process.env.CLEDGER_VERIFY_ENDPOINT } : {}),
    ...(process.env.CLEDGER_VERIFY_MODEL ? { model: process.env.CLEDGER_VERIFY_MODEL } : {}),
    ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}),
  };
  const report = process.argv.includes("--scripted")
    ? await verifyScriptedOpencode(options)
    : await verifyOpencode(options);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
