import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { createServer } from "node:http";
import { isolatedEnvironment, runProcess } from "./process.js";


export interface ClaudeCodeVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }
export interface ClaudeCodeVerificationReport {
  schema: "cledger-verification/1";
  cli: "claude-code";
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

/** Anthropic Messages SSE fixture, bounded and incapable of upstream calls. */
export async function startScriptedAnthropicProvider(): Promise<{
  state: { requests: number; blocked?: string }; endpoint: string; signal: AbortSignal; close(): Promise<void>;
}> {
  const state: { requests: number; blocked?: string } = { requests: 0 };
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    const reject = (reason: string) => {
      state.blocked ??= reason;
      res.writeHead(400); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reason } }));
      controller.abort();
    };
    // Native 2.1.280 probes connectivity before its Messages request.
    if (req.method === "HEAD" && req.url === "/api/hello") { res.writeHead(200); res.end(); return; }
    if (req.method !== "POST" || !/^\/v1\/messages(?:\?[^#]*)?$/.test(req.url ?? "")) {
      reject(`Unsupported scripted Anthropic endpoint: ${req.method} ${new URL(req.url ?? "/", "http://localhost").pathname}`); return;
    }
    if (++state.requests > 4) { reject("Scripted Anthropic request budget exceeded"); return; }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2_000_000) { reject("Scripted request too large"); return; }
      }
      const data = JSON.parse(body) as { messages?: { role: string; content: unknown }[]; tools?: { name: string }[]; stream?: boolean; model?: string };
      const blocks = (data.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []);
      const result = [...blocks].reverse().find((block) => block.type === "tool_result");
      const secret = result ? JSON.stringify(result.content).match(/file-value-[a-f0-9-]+/)?.[0] : undefined;
      if (result && !secret) { reject("Native Read output did not contain the fixture file value"); return; }
      const titleRequest = !data.tools?.length && JSON.stringify(data.messages).includes("<session>") &&
        JSON.stringify(data.messages).includes("Write the title in the predominant language of the session");
      const answer = titleRequest ? "Read fixture file" : secret;
      if (!answer && !data.tools?.some((tool) => tool.name === "Read")) { reject("Native request lacks Read tool"); return; }
      const input = { file_path: "evidence.txt" };
      const block = answer ? { type: "text", text: answer } : { type: "tool_use", id: "toolu_probe", name: "Read", input };
      const message = { id: `msg_${state.requests}`, type: "message", role: "assistant", model: data.model ?? "fixture",
        content: [block], stop_reason: answer ? "end_turn" : "tool_use", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } };
      if (data.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(message)); return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (type: string, fields: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      send("message_start", { message: { ...message, content: [], stop_reason: null } });
      send("content_block_start", { index: 0, content_block: answer ? { type: "text", text: "" } : { ...block, input: {} } });
      send("content_block_delta", { index: 0, delta: answer ? { type: "text_delta", text: answer }
        : { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      res.end();
    } catch { reject("Malformed scripted Anthropic request"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted Anthropic server unavailable");
  return { state, endpoint: `http://127.0.0.1:${address.port}`, signal: controller.signal,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

/** The secret is never in the prompt: only a real tool result can supply it. */
export function claudeCodeEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "claude-code");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "Read" &&
    typeof (block.input as { file_path?: unknown })?.file_path === "string" &&
    /(?:^|\/)evidence\.txt$/.test(String((block.input as { file_path: string }).file_path)));
  return {
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
  };
}

/**
 * Real Claude Code executable, real installed Stop hook, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedClaudeCode(options: ClaudeCodeVerificationOptions = {}): Promise<ClaudeCodeVerificationReport> {
  const started = Date.now();
  const report: ClaudeCodeVerificationReport = {
    schema: "cledger-verification/1", cli: "claude-code", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native Stop + SessionEnd hooks", "headless print", "human prompt", "tool call/result linkage", "assistant answer", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions"], durationMs: 0,
  };
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native Claude Code verification currently supports macOS and Linux";
    return report;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "cledger-claude-native-")));
  let provider: Awaited<ReturnType<typeof startScriptedAnthropicProvider>> | undefined;

  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".claude");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      CLAUDE_CONFIG_DIR: agentDir, ANTHROPIC_API_KEY: "FAKE_TESTONLY_LOCAL",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "claude";
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
      report.reason = "Claude Code executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Claude Code verification"]);
    provider = await startScriptedAnthropicProvider();
    // https://code.claude.com/docs/en/llm-gateway-connect: custom Messages
    // gateway with nonessential traffic disabled. Only disposable config loads.
    const runtimeEnv = env as NodeJS.ProcessEnv;
    runtimeEnv.ANTHROPIC_BASE_URL = provider.endpoint;
    await checked(process.execPath, [cli, "install", "claude-code"]);
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { hooks?: Record<string, unknown> };
    report.gates.installedHooks = !!settings.hooks?.Stop && !!settings.hooks?.SessionEnd;
    const prompt = `${marker}. Read evidence.txt using Read and reply with its exact contents.`;
    if (options.interactive) {
      await writeFile(join(agentDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: ["FAKE_TESTONLY_LOCAL"], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
      const terminal = await runPty(binary, ["--model", "claude-sonnet-4-6", "--tools", "Read", "--allowedTools", "Read",
        "--strict-mcp-config", "--", prompt], { cwd: repo, env: { ...env, TERM: "xterm-256color" },
        timeoutMs: options.timeoutMs ?? 60_000, actions: [{ waitFor: secret, send: "/exit\r" }] });
      report.gates.interactiveExit = !terminal.timedOut && terminal.code === 0 && terminal.actionsCompleted === 1;
      report.coverage = report.coverage.map(value => value === "headless print" ? "interactive PTY session and exit" : value);
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      if (!report.gates.interactiveExit) throw new Error(`Claude interactive terminal incomplete: ${JSON.stringify({ ...terminal, output: terminal.output.slice(-4000) })}`);
    } else {
    await checked(binary, ["--print", "--verbose", "--output-format", "stream-json", "--model", "claude-sonnet-4-6",
      "--tools", "Read", "--allowedTools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--", prompt],
      options.timeoutMs ?? 60_000);
    }
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    const nativeEvents = await read();
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(nativeEvents, "claude-code");
    Object.assign(report.gates, claudeCodeEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;

    if (!Object.values(report.gates).every(Boolean)) {
      const drift = nativeEvents.filter(event => event.kind === "unrecognized").map(event => (event.content as { unrecognized_type?: string }).unrecognized_type ?? "unknown");
      throw new Error("Claude Code native Stop hook evidence incomplete; manual backfill was not attempted" + (drift.length ? `; drift: ${drift.join(", ")}` : ""));
    }
    await checked(process.execPath, [cli, "capture", "claude-code", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "claude-code", "--all"]);
    const repeated = await read();
    const ids = (events: EvidenceEvent[]) => events.map((event) => event.id).sort().join("\n");
    report.gates.hookCapturedFinalTail = ids(nativeEvents) === ids(backfilled);
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
  const report = await verifyScriptedClaudeCode({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
