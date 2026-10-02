import { test } from "node:test";
import assert from "node:assert/strict";
import { openhandsEvidenceGates, verifyScriptedOpenHands } from "../verification/openhands.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment, runProcess } from "../verification/process.js";
import { runPty, terminalTail } from "../verification/pty.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "openhands", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "openhands:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "openhands:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "file_editor", input: { command: "view" } }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "openhands:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "openhands:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "openhands:fixture", seq: 4 }, kind: "session_state", content: { state_type: "base_state", id: "fixture" } }),
    event({ producer, actor: { type: "system" }, stream: { id: "openhands:fixture", seq: 5 }, kind: "activity", content: { kind: "HookExecutionEvent", hook_event_type: "Stop" } }),
  ];
}

test("OpenHands native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(openhandsEvidenceGates(valid, "marker", "secret")).every(Boolean));
  assert.equal(openhandsEvidenceGates(valid.slice(0, -1), "marker", "secret").hookSelfObservation, false);
  const failed = structuredClone(valid);
  (failed[2]!.content as any).blocks[0].is_error = true;
  assert.equal(openhandsEvidenceGates(failed, "marker", "secret").hookToolResult, false);
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(openhandsEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "openhands:other";
  otherSession[3]!.stream!.id = "openhands:other";
  const gates = openhandsEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("OpenHands native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.values(openhandsEvidenceGates(rawOnly, "marker", "secret")).every((value) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(openhandsEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(openhandsEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("OpenHands verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedOpenHands({ binary: "/does-not-exist/cledger-test-openhands", timeoutMs: 1000 });
  assert.equal(report.cli, "openhands");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("OpenHands real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_OPENHANDS_BINARY,
}, async () => {
  const report = await verifyScriptedOpenHands({ binary: process.env.CLEDGER_VERIFY_OPENHANDS_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

test("OpenHands installed TUI captures submitted prompt while its first model request is stalled", {
  skip: !process.env.CLEDGER_VERIFY_OPENHANDS_BINARY,
  timeout: 180000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-openhands-stalled-"));
  const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, "openhands");
  const trace = join(root, "terminal.log");
  let requests = 0, terminal: ReturnType<typeof runPty> | undefined;
  // Deliberately send no model response at all. Native capture must not depend
  // on an assistant completion, Stop, SessionEnd, or a manual import.
  const server = createServer(async req => { for await (const _ of req) { /* drain */ } requests++; });
  try {
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map(path => mkdir(path, { recursive: true })));
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env: NodeJS.ProcessEnv = { ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      OPENHANDS_PERSISTENCE_DIR: agentDir, OPENHANDS_CONVERSATIONS_DIR: join(agentDir, "conversations"),
      LLM_API_KEY: "FAKE_TESTONLY_LOCAL", LLM_MODEL: "openai/gpt-4o", LITELLM_LOCAL_MODEL_COST_MAP: "True",
      LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OPENHANDS_SUPPRESS_BANNER: "1", DO_NOT_TRACK: "1" };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    const checked = async (...args: string[]) => {
      const result = await runProcess(args[0]!, args.slice(1), { cwd: repo, env, timeoutMs: 5000 });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.timedOut, false);
      return result.stdout;
    };
    await checked("git", "init", "--quiet");
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    await checked("git", "add", ".");
    await checked("git", "commit", "--quiet", "-m", "TESTONLY stalled prompt verification");
    await checked(process.execPath, cli, "install", "openhands");
    const hooks = JSON.parse(await readFile(join(root, ".openhands", "hooks.json"), "utf8"));
    for (const name of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"])
      assert.ok(hooks.hooks[name], `installed ${name} hook`);
    delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
    const marker = "TESTONLY-stalled-human-prompt";
    terminal = runPty(resolve(process.env.CLEDGER_VERIFY_OPENHANDS_BINARY!),
      ["--always-approve", "--override-with-envs", "--exit-without-confirmation"], {
        // Hosted macOS initialization and native hooks took over 40 seconds
        // in the complete interactive smoke. Preserve the same bounded TUI
        // budget here rather than mistaking slow startup for a capture failure.
        cwd: repo, env, timeoutMs: 120000, transcriptPath: trace, actions: [
          { waitFor: "Loaded:.*skills,.*hooks", send: marker, delayMs: 250 },
          { waitFor: marker, send: "\r", delayMs: 250 },
        ],
      });
    let settled = false;
    void terminal.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + 105000;
    // Run the real ledger reader in a bounded child process: annals' Git reads
    // have no timeout of their own. Emit only the evidence predicate rather
    // than truncating full native state snapshots at runProcess's output cap.
    const readScript = `
      const { findRepo } = await import(${JSON.stringify(import.meta.resolve("annals"))});
      const { readEvents } = await import(${JSON.stringify(new URL("../store.js", import.meta.url).href)});
      const repo = await findRepo(process.argv[1]);
      if (!repo) throw new Error("Disposable OpenHands repository unavailable");
      const events = await readEvents(repo, { reachableFrom: null });
      process.stdout.write(JSON.stringify({ promptCaptured: events.some(item =>
        item.producer.source === "openhands" && item.actor.type === "human" &&
        JSON.stringify(item.content).includes(process.argv[2])) }));
    `;
    let promptCaptured = false;
    while (Date.now() < deadline && !settled) {
      if (requests) {
        const observed = JSON.parse(await checked(process.execPath, "--input-type=module", "-e", readScript, repo, marker));
        promptCaptured = observed.promptCaptured === true;
        if (promptCaptured) break;
      }
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(settled, false, "capture occurs while the installed TUI is still running");
    assert.equal(requests, 1, "only the first model request is pending");
    assert.ok(promptCaptured,
      "submitted human prompt must already exist in annals without backfill");
    const result = await terminal;
    assert.equal(result.timedOut, true, "the deliberately stalled request cannot complete");
    assert.equal(result.actionsCompleted, 2);
  } finally {
    const result = await terminal?.catch(() => undefined);
    if (terminal && (!result || requests !== 1 || result.actionsCompleted !== 2)) {
      // Only this disposable test's synthetic terminal is printed. Preserve
      // startup/input diagnostics even if an earlier assertion failed.
      process.stderr.write(`OpenHands stalled TUI: requests=${requests}, actions=${result?.actionsCompleted ?? "unavailable"}, code=${result?.code ?? "unavailable"}, timeout=${result?.timedOut ?? "unavailable"}; tail=${terminalTail(await readFile(trace, "utf8").catch(() => ""))}\n`);
    }
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
