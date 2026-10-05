import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceGates, validateEndpoint, verifyOpencode } from "../verification/opencode.js";
import { isolatedEnvironment, runProcess } from "../verification/process.js";
import type { EvidenceEvent } from "../schema.js";
import { createServer } from "node:http";
import { startGuard } from "../verification/guard.js";

test("verification requires an explicit loopback endpoint; missing configuration never runs inference", async () => {
  assert.equal((await verifyOpencode({})).status, "not-run");
  for (const url of ["https://api.example.com/v1", "http://127.0.0.1.evil/v1", "http://TESTONLY:TESTONLY@localhost/v1", "http://localhost/v1?key=TESTONLY"]) {
    assert.throws(() => validateEndpoint(url));
  }
  validateEndpoint("http://127.0.0.1:8080/v1");
});

test("fixture evidence cannot pass by echoing tool results in prompts or a different session", () => {
  const event = (actor: string, stream: string, blocks: unknown[]): EvidenceEvent => ({
    actor: { type: actor }, stream: { id: stream, seq: 0 }, producer: { source: "opencode" }, content: { blocks },
  }) as EvidenceEvent;
  const events = [event("human", "a", [{ type: "text", text: "marker secret" }]),
    event("agent", "b", [{ type: "tool_use", id: "read-call", name: "read", input: "evidence.txt" }, { type: "tool_result", tool_use_id: "read-call", content: "secret" }, { type: "text", text: "secret" }])];
  assert.deepEqual(evidenceGates(events, "marker", "secret"), { hookPrompt: true, hookToolUse: false, hookToolResult: false, hookAnswer: false });
  events[1]!.stream!.id = "a";
  assert.ok(Object.values(evidenceGates(events, "marker", "secret")).every(Boolean));
  const result = events.flatMap(e => (e.content as { blocks: Record<string, unknown>[] }).blocks).find(b => b.type === "tool_result")!;
  result.tool_use_id = "unrelated-call";
  assert.equal(evidenceGates(events, "marker", "secret").hookToolResult, false);
});

test("fixture subprocess gets isolated config and no inherited API credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-runner-test-"));
  try {
    const env = isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin");
    const result = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify({home:process.env.HOME, key:process.env.OPENAI_API_KEY, config:process.env.GIT_CONFIG_GLOBAL}))"], { cwd: root, env, timeoutMs: 2000 });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { home: root, config: "/dev/null" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixture subprocess deadline terminates a child holding inherited pipes", { skip: process.platform === "win32" }, async () => {
  const result = await runProcess(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"], {
    cwd: tmpdir(), env: isolatedEnvironment(tmpdir(), process.env.PATH ?? ""), timeoutMs: 150,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});

test("forwarding guard never retries refusal, follows redirects, or exceeds request budget", async (t) => {
  let calls = 0, status = 503, header: unknown, authorization: unknown;
  const server = createServer((req, res) => {
    calls++; header = req.headers["x-ds4-client"]; authorization = req.headers.authorization;
    res.writeHead(status, { Location: "http://127.0.0.1:1/do-not-follow" }); res.end("fixture");
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox disallows loopback servers"); return; }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const upstreamStatus of [503, 302, 200]) {
      calls = 0; status = upstreamStatus;
      const guard = await startGuard(`http://127.0.0.1:${address.port}/v1`, 1, 60_000, "TESTONLY-configured-key");
      try {
        await Promise.all([0, 1].map(async () => {
          const response = await fetch(`${guard.endpoint}/chat/completions`, { method: "POST", body: "{}" });
          await response.text();
        }));
        assert.equal(calls, 1, "only one upstream call, including caller retries");
        assert.equal(header, undefined, "no coupling to the retired gateway");
        assert.equal(authorization, "Bearer TESTONLY-configured-key");
        assert.equal(guard.state.forwarded, 1);
        assert.equal(guard.signal.aborted, true);
        assert.match(guard.state.blocked!, upstreamStatus === 200 ? /budget/ : new RegExp(`HTTP ${upstreamStatus}`));
      } finally { await guard.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
