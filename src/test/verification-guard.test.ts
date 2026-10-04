import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type ServerResponse } from "node:http";
import { startGuard } from "../verification/guard.js";

test("guard rejects unbounded request counts and deadlines before starting a server", async () => {
  for (const [requests, deadline] of [[NaN, 1000], [Infinity, 1000], [0, 1000], [9, 1000], [4, Infinity], [4, 0]])
    await assert.rejects(startGuard("http://127.0.0.1:1/v1", requests, deadline), /bounded positive integers/);
});

test("guard preserves Unicode when a request splits a UTF-8 code point across chunks", async () => {
  let received = "";
  const upstream = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); received = Buffer.concat(chunks).toString("utf8"); res.end("{}"); });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const guard = await startGuard(`http://127.0.0.1:${address.port}/v1`);
  try {
    const body = Buffer.from(JSON.stringify({ prompt: "TESTONLY café 日本語 🦉" }));
    const split = body.indexOf(Buffer.from("🦉")) + 1;
    await new Promise<void>((done, fail) => {
      const req = request(guard.endpoint + "/chat/completions", { method: "POST" }, res => { res.resume(); res.on("end", done); });
      req.on("error", fail); req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 20);
    });
    assert.equal(received, body.toString("utf8"));
  } finally { await guard.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); }
});

test("live guard caps requested output tokens and supplies a cap when omitted", async () => {
  const payloads: Record<string, unknown>[] = [];
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body)); res.end("{}");
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const guard = await startGuard(`http://127.0.0.1:${address.port}/v1`, 4, 1000, "TESTONLY-local", { maxOutputTokens: 2048 });
  try {
    for (const body of [{ max_tokens: 8192 }, { max_completion_tokens: 8192, max_tokens: 8192 }, {}, { max_tokens: 128 }])
      await (await fetch(`${guard.endpoint}/chat/completions`, { method: "POST", body: JSON.stringify(body) })).text();
    assert.deepEqual(payloads, [{ max_tokens: 2048 }, { max_completion_tokens: 2048 }, { max_tokens: 2048 }, { max_tokens: 128 }]);
  } finally { await guard.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); }
});

test("guard queues a tool continuation until split terminal SSE releases an open HTTP stream", async () => {
  let calls = 0;
  let first: ServerResponse | undefined;
  const upstream = createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (calls === 1) {
      first = res;
      res.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n');
    } else res.end('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const guard = await startGuard(`http://127.0.0.1:${address.port}/v1`, 2, 2000);
  try {
    const response = await fetch(`${guard.endpoint}/chat/completions`, { method: "POST", body: "{}" });
    const reader = response.body!.getReader();
    await reader.read();
    const continuation = fetch(`${guard.endpoint}/chat/completions`, { method: "POST", body: "{}" });
    await new Promise(done => setTimeout(done, 40));
    assert.equal(calls, 1, "continuation must wait rather than overlap or receive a premature 429");
    first!.write('data: [DO');
    await new Promise(done => setTimeout(done, 20));
    assert.equal(calls, 1, "a partial terminal event must not release the slot");
    first!.write('NE]\n\n'); // Deliberately never end the underlying HTTP response.
    const second = await continuation;
    assert.equal(second.status, 200);
    assert.match(await second.text(), /finish_reason/);
    while (!(await reader.read()).done) { /* drain */ }
    assert.equal(calls, 2);
    assert.equal(guard.state.forwarded, 2);
    assert.equal(guard.state.blocked, undefined);
    assert.equal(guard.signal.aborted, false);
  } finally {
    await guard.close(); upstream.closeAllConnections();
    await new Promise<void>(done => upstream.close(() => done()));
  }
});

test("queued requests cannot extend a failed stream into another upstream inference", async () => {
  let calls = 0;
  const upstream = createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[]}\n\n'); // No terminal event, no HTTP close.
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const guard = await startGuard(`http://127.0.0.1:${address.port}/v1`, 2, 100);
  try {
    const first = await fetch(`${guard.endpoint}/chat/completions`, { method: "POST", body: "{}" });
    const second = await fetch(`${guard.endpoint}/chat/completions`, { method: "POST", body: "{}" });
    await first.text(); await second.text();
    assert.equal(second.status, 429);
    assert.equal(calls, 1);
    assert.equal(guard.state.forwarded, 1);
    assert.match(guard.state.blocked!, /timed out|interrupted/);
    assert.equal(guard.signal.aborted, true);
  } finally {
    await guard.close(); upstream.closeAllConnections();
    await new Promise<void>(done => upstream.close(() => done()));
  }
});
