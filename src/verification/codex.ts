import { runPty } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { isolatedEnvironment, runProcess } from "./process.js";


export interface CodexVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean }
export interface CodexVerificationReport {
  schema: "cledger-verification/1";
  cli: "codex";
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

/** Minimal deterministic Responses transport: emit one real shell read, then
 * answer solely from the resulting tool output. No upstream forwarding exists. */
export async function startScriptedResponsesProvider(options: { completionPrefix?: string } = {}): Promise<{
  state: { requests: number; blocked?: string }; endpoint: string; signal: AbortSignal; close(): Promise<void>;
}> {
  const state: { requests: number; blocked?: string } = { requests: 0 };
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    const reject = (reason: string) => {
      state.blocked ??= reason;
      res.writeHead(400); res.end(JSON.stringify({ error: { message: reason } }));
      controller.abort();
    };
    if (req.method !== "POST" || req.url !== "/v1/responses") { reject("Unsupported scripted Responses endpoint"); return; }
    if (++state.requests > 4) { reject("Scripted Responses request budget exceeded"); return; }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2_000_000) { reject("Scripted request too large"); return; }
      }
      const data = JSON.parse(body) as { input?: Record<string, unknown>[]; tools?: Record<string, unknown>[]; text?: { format?: { schema?: { required?: string[] } } } };
      const tool = [...(data.input ?? [])].reverse().find((item) => item.type === "function_call_output");
      const secret = tool ? JSON.stringify(tool.output).match(/file-value-[a-f0-9-]+/)?.[0] : undefined;
      const names: string[] = [];
      const collect = (tools: Record<string, unknown>[]) => {
        for (const tool of tools) {
          if (typeof tool.name === "string") names.push(tool.name);
          if (Array.isArray(tool.tools)) collect(tool.tools as Record<string, unknown>[]);
        }
      };
      collect(data.tools ?? []);
      const name = ["exec_command", "shell_command", "shell"].find((candidate) => names.includes(candidate));
      const titleRequest = names.length === 0 && data.text?.format?.schema?.required?.includes("title") === true &&
        JSON.stringify(data.input).includes("Generate a concise, single-line task title");
      const answer = titleRequest ? JSON.stringify({ title: "Read fixture file" }) : secret ? (options.completionPrefix ?? "") + secret : undefined;
      if (!answer && !name) { reject("No supported shell tool in native Responses request"); return; }
      if (tool && !secret) {
        // This provider only serves disposable verification sessions. Keep the
        // actual failed native tool output so CI can distinguish sandbox setup,
        // missing executables and read errors without relaxing the read gate.
        const output = typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output) ?? "(missing output)";
        const text = stripVTControlCharacters(output).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
        reject("Native shell output did not contain the fixture file value; native tool output: " +
          text.slice(0, 4000) + (text.length > 4000 ? " [truncated]" : ""));
        return;
      }
      const args = name === "exec_command" ? { cmd: "cat evidence.txt", login: false }
        : name === "shell_command" ? { command: "cat evidence.txt" } : { command: ["/bin/cat", "evidence.txt"] };
      const item = answer ? { id: "msg_probe", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: answer, annotations: [] }] }
        : { id: "fc_probe", type: "function_call", call_id: "call_probe", name, arguments: JSON.stringify(args), status: "completed" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (type: string, fields: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      const response = { id: `resp_${state.requests}`, object: "response", created_at: 1, model: "gpt-5.4", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      send("response.created", { response: { ...response, status: "in_progress", output: [] } });
      send("response.output_item.added", { output_index: 0, item: answer ? { ...item, content: [] } : { ...item, arguments: "" } });
      if (answer) {
        send("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: answer });
        send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: answer });
      } else {
        send("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: JSON.stringify(args) });
        send("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: JSON.stringify(args) });
      }
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", { response: { ...response, status: "completed" } });
      res.end();
    } catch { reject("Malformed scripted Responses request"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted Responses server unavailable");
  return { state, endpoint: `http://127.0.0.1:${address.port}/v1`, signal: controller.signal,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

/** The secret is never in the prompt: only a real tool result can supply it. */
export function codexEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "codex");
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
 * Real Codex executable, installed Stop and SessionEnd hooks, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedCodex(options: CodexVerificationOptions = {}): Promise<CodexVerificationReport> {
  const started = Date.now();
  const report: CodexVerificationReport = {
    schema: "cledger-verification/1", cli: "codex", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["installed native Stop + SessionEnd hooks with isolated invocation trust bypass", "headless exec", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency"],
    exclusions: ["real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions", "interactive hook trust review"], durationMs: 0,
  };
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reason = "Native Codex verification currently supports macOS and Linux";
    return report;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "cledger-codex-native-")));
  let provider: Awaited<ReturnType<typeof startScriptedResponsesProvider>> | undefined;

  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".codex");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      CODEX_HOME: agentDir,
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "codex";
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
      report.reason = "Codex executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Codex verification"]);
    provider = await startScriptedResponsesProvider(options.interactive ? { completionPrefix: "TESTONLY_OK " } : {});
    // Official custom Responses provider, confined to the loopback fixture.
    await writeFile(join(agentDir, "config.toml"), [
      'model = "gpt-5.4"', 'model_provider = "verification"', 'approval_policy = "never"',
      '[model_providers.verification]', 'name = "Scripted verification"',
      `base_url = ${JSON.stringify(provider.endpoint)}`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
      ...(options.interactive ? [`[projects.${JSON.stringify(repo)}]`, 'trust_level = "trusted"'] : []),
    ].join("\n") + "\n");
    await checked(process.execPath, [cli, "install", "codex"]);
    const hook = await readFile(join(agentDir, "config.toml"), "utf8");
    report.gates.installedHook = hook.includes("hooks.Stop") && hook.includes("hooks.SessionEnd") && hook.includes("hook codex");
    // https://learn.chatgpt.com/docs/hooks documents this invocation-only
    // bypass for automation that vets its hook sources. Only our disposable
    // generated config is loaded; user trust/config/auth files are untouched.
    const prompt = `${marker}. Read evidence.txt using the shell tool and reply with its exact contents.`;
    if (options.interactive) {
      const terminal = await runPty(binary, ["--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--no-alt-screen", prompt], {
        cwd: repo, env: { ...env, TERM: "xterm-256color" }, timeoutMs: options.timeoutMs ?? 60_000,
        actions: [
          { waitFor: "TESTONLY_OK[\\s\\S]*Ask Codex to do anything", send: "/exit", delayMs: 1000 },
          { waitFor: "/exit", send: "\r", delayMs: 1000 },
        ],
      });
      report.gates.interactiveExit = !terminal.timedOut && terminal.code === 0 && terminal.actionsCompleted === 2;
      report.coverage = report.coverage.map(value => value === "headless exec" ? "interactive PTY session and exit" : value);
      report.exclusions = report.exclusions.filter(value => value !== "interactive TUI");
      if (!report.gates.interactiveExit) throw new Error(`Codex interactive terminal incomplete: ${JSON.stringify({ ...terminal, output: terminal.output.slice(-4000) })}`);
    } else {
    await checked(binary, ["exec", "--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--json", prompt],
      options.timeoutMs ?? 60_000);
    }
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    let nativeEvents: EvidenceEvent[] = [];
    const deadline = Date.now() + 10_000;
    do {
      nativeEvents = await read();
      report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(nativeEvents, "codex");
      Object.assign(report.gates, codexEvidenceGates(nativeEvents, marker, secret));
      if (Object.values(report.gates).every(Boolean)) break;
      await new Promise(done => setTimeout(done, 250));
    } while (Date.now() < deadline);
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;

    if (!Object.values(report.gates).every(Boolean)) {
      const drift = nativeEvents.filter(event => event.kind === "unrecognized").map(event => (event.content as { unrecognized_type?: string }).unrecognized_type ?? "unknown");
      throw new Error("Codex native Stop hook evidence incomplete; manual backfill was not attempted" + (drift.length ? `; drift: ${drift.join(", ")}` : ""));
    }
    const sessions = join(agentDir, "sessions");
    const rollouts = (await readdir(sessions, { recursive: true })).filter((path) => path.endsWith(".jsonl") && path.includes("rollout-"));
    if (rollouts.length !== 1) throw new Error("Expected exactly one isolated native rollout for backfill verification");
    const transcript = join(sessions, rollouts[0]!);
    await checked(process.execPath, [cli, "capture", "codex", "--transcript", transcript]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "codex", "--transcript", transcript]);
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
  const report = await verifyScriptedCodex({ ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
