import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { EvidenceEvent } from "../schema.js";
import type { Report } from "./opencode.js";
import { isolatedEnvironment, runProcess } from "./process.js";

export type GeminiReport = Omit<Report, "cli"> & { cli: "gemini-cli" };

/** Google generateContent protocol fixture; never forwards to a real provider. */
export async function startScriptedGeminiProvider(): Promise<{
  endpoint: string; state: { requests: number }; signal: AbortSignal; close(): Promise<void>;
}> {
  const state = { requests: 0 };
  const stopped = new AbortController();
  const server = createServer(async (req, res) => {
    try {
      if (++state.requests > 8) { res.writeHead(429); res.end(); stopped.abort(); return; }
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 2_000_000) { res.writeHead(413); res.end(); stopped.abort(); return; }
      }
      const data = JSON.parse(body) as { contents?: unknown; tools?: unknown };
      if (req.url?.includes(":countTokens")) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"totalTokens":32}'); return;
      }
      if (!req.url?.includes(":generateContent") && !req.url?.includes(":streamGenerateContent")) {
        res.writeHead(404); res.end(); return;
      }
      const contents = JSON.stringify(data.contents ?? []);
      const secret = contents.includes('"functionResponse"') ? contents.match(/file-value-[a-f0-9-]+/)?.[0] : undefined;
      const parts = secret ? [{ text: secret }] : (JSON.stringify(data.tools) ?? "").includes('"read_file"')
        ? [{ functionCall: { name: "read_file", args: { file_path: "evidence.txt" } } }]
        : [{ text: "Verification fixture" }];
      const response = JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: "fixture" });
      if (req.url.includes(":streamGenerateContent")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${response}\n\n`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(response);
      }
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  return { endpoint: `http://127.0.0.1:${address.port}`, state, signal: stopped.signal,
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}

export function geminiEvidenceGates(events: EvidenceEvent[], marker: string, secret: string) {
  const blocks = (e: EvidenceEvent) => (e.content as { blocks?: Record<string, unknown>[] })?.blocks ?? [];
  const own = events.filter(e => e.producer.source === "gemini-cli");
  const human = own.find(e => e.actor.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes(marker)));
  const turns = human ? own.filter(e => e.stream?.id === human.stream?.id) : [];
  const callIds = new Set(turns.flatMap(blocks).filter(b => b.type === "tool_use" && b.name === "read_file" && typeof b.id === "string" && JSON.stringify(b.input).includes("evidence.txt")).map(b => b.id));
  return {
    hookPrompt: !!human,
    hookToolUse: callIds.size > 0,
    hookToolResult: turns.some(e => blocks(e).some(b => b.type === "tool_result" && callIds.has(b.tool_use_id) && JSON.stringify(b.content).includes(secret))),
    hookAnswer: turns.some(e => e.actor.type === "agent" && blocks(e).some(b => b.type === "text" && String(b.text).includes(secret))),
  };
}

async function awaitNativeTail(repo: string): Promise<boolean> {
  const directory = join(repo, ".git", "cledger-gemini-cli-tail"), deadline = Date.now() + 12_000;
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

export async function verifyScriptedGemini(options: { binary?: string; timeoutMs?: number; interactive?: boolean } = {}): Promise<GeminiReport> {
  const start = Date.now();
  const report: GeminiReport = { schema: "cledger-verification/1", cli: "gemini-cli", status: "not-run", certification: "native-smoke",
    inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {}, durationMs: 0,
    coverage: ["native headless hooks", "human text", "read tool call/result", "assistant text", "backfill idempotency"],
    exclusions: ["interactive TUI", "subagents", "attachments", "compaction/rewind", "real provider authentication", "full record coverage"] };
  report.mode = options.interactive ? "interactive" : "headless";
  if (!["darwin", "linux"].includes(process.platform)) { report.reason = "Unsupported platform"; return report; }
  const root = await mkdtemp(join(tmpdir(), "cledger-gemini-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedGeminiProvider>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    await Promise.all([repo, bin, join(root, "tmp"), join(root, ".gemini")].map(p => mkdir(p, { recursive: true })));
    const env = isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    const binary = options.binary ? resolve(options.binary) : "gemini";
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    const checked = async (command: string, args: string[], timeoutMs = 20_000) => {
      const result = await runProcess(command, args, { cwd: repo, env, timeoutMs, ...(provider ? { signal: provider.signal } : {}) });
      if (result.code !== 0 || result.timedOut) throw new Error(`${command} ${args[0]} failed (${result.timedOut ? "deadline" : result.code}): ${result.stderr.slice(-1500)}`);
      return result.stdout;
    };
    try { report.version = (await checked(binary, ["--version"])).trim(); }
    catch { report.status = "blocked"; report.reason = "Gemini executable unavailable or version probe failed"; return report; }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated verification"]);
    provider = await startScriptedGeminiProvider();
    env.GEMINI_API_KEY = "TESTONLY-local-verification";
    env.GOOGLE_GEMINI_BASE_URL = provider.endpoint;
    // Gemini treats this as the HOME parent of .gemini, not the config dir.
    env.GEMINI_CLI_HOME = root;
    env.GEMINI_CLI_TRUST_WORKSPACE = "true"; // Only this disposable fixture repo.
    await writeFile(join(root, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } },
      telemetry: { enabled: false }, model: { name: "gemini-2.5-flash" } }));
    await checked(process.execPath, [cli, "install", "gemini-cli"]);
    const config = JSON.parse(await readFile(join(root, ".gemini", "settings.json"), "utf8"));
    report.gates.installedHooks = !!config.hooks?.AfterAgent && !!config.hooks?.SessionEnd;
    const prompt = `${marker}. Read evidence.txt using read_file and reply with its exact contents.`;
    if (options.interactive) {
      delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
      report.coverage[0] = "interactive PTY terminal input and native hooks";
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      const terminal = await runPty(binary, [], { cwd: repo, env, timeoutMs: options.timeoutMs ?? 60_000,
        actions: [{ waitFor: "Type your message|Type a message|> ", send: prompt + "\r" },
          // The final text can render while AfterAgent is still running. Slash
          // commands are rejected until Gemini returns to its ready state.
          { waitFor: `${secret}[\\s\\S]*Ready \\(repo\\)`, send: "/quit", delayMs: 1000 },
          { waitFor: "Exit the cli", send: "\r", delayMs: 1000 }] });
      report.gates.interactiveTerminal = terminal.actionsCompleted === 3 && !terminal.timedOut && terminal.code === 0;
      if (!report.gates.interactiveTerminal) throw new Error(`Interactive terminal incomplete: actions=${terminal.actionsCompleted}, code=${terminal.code}, timeout=${terminal.timedOut}; tail=${terminalTail(terminal.output)}`);
    } else await checked(binary, ["-p", prompt, "--output-format", "stream-json"], options.timeoutMs ?? 60_000);
    report.gates.tailWorkerCompleteAndExited = await awaitNativeTail(repo);
    const read = async () => (await checked(process.execPath, [cli, "export", "--all"])).trim().split("\n").filter(Boolean).map(s => JSON.parse(s) as EvidenceEvent);
    let events: EvidenceEvent[] = [];
    const deadline = Date.now() + 10_000;
    do {
      events = await read(); Object.assign(report.gates, geminiEvidenceGates(events, marker, secret));
      report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(events, "gemini-cli");
      if (Object.values(report.gates).every(Boolean)) break;
      await new Promise(done => setTimeout(done, 250));
    } while (Date.now() < deadline);
    if (!Object.values(report.gates).every(Boolean)) throw new Error("Native Gemini hook evidence incomplete; no manual capture attempted");
    await checked(process.execPath, [cli, "capture", "gemini-cli", "--all"]);
    const first = await read();
    await checked(process.execPath, [cli, "capture", "gemini-cli", "--all"]);
    const second = await read();
    report.gates.backfillIdempotent = events.map(e => e.id).sort().join() === first.map(e => e.id).sort().join() && first.map(e => e.id).sort().join() === second.map(e => e.id).sort().join();
    if (!report.gates.backfillIdempotent) report.reason = "Backfill added native evidence: " + JSON.stringify(first.filter(e => !events.some(prior => prior.id === e.id)).map(e => ({ kind: e.kind, content: e.content })));
    report.gates.hookEvidenceRetained = events.every(e => second.some(s => s.id === e.id));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 8;
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
  } catch (error) { report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error); }
  finally { report.durationMs = Date.now() - start; report.requests = provider?.state.requests ?? 0; await provider?.close(); await rm(root, { recursive: true, force: true }); }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = process.env["CLEDGER_VERIFY_BINARY"];
  const report = await verifyScriptedGemini({ ...(binary ? { binary } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2;
}
