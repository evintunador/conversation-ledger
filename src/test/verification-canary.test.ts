import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verifyOpencodeCanary } from "../verification/canary.js";

test("canary without explicit inference configuration cannot pass any gate", async () => {
  const report = await verifyOpencodeCanary({ inference: "local", provider: "ds4", model: "TESTONLY" });
  assert.equal(report.status, "not-run");
  assert.ok(Object.values(report.gates).every(g => g === false));
  assert.equal(report.requests, 0);
});

for (const interactive of [false, true]) {
  test(`installed OpenCode ${interactive ? "TUI" : "headless"} canary driver reads a fresh value after resume`, {
    skip: !process.env.CLEDGER_CONFORMANCE_OPENCODE_BINARY, timeout: 300000,
  }, async () => {
    let requests = 0;
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || req.url !== "/v1/chat/completions" || ++requests > 8) throw Error("Fixture request rejected");
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw Error("Fixture body limit"); }
        const data = JSON.parse(body), latest = data.messages.at(-1);
        const value = latest.role === "tool" ? JSON.stringify(latest.content).match(/file-value-[a-f0-9-]+/)?.[0] : undefined;
        const delta = value ? { role: "assistant", content: value } : { role: "assistant", content: null, tool_calls: [{ index: 0, id: "TESTONLY_read_" + requests, type: "function", function: { name: "read", arguments: '{"filePath":"evidence.txt"}' } }] };
        const frame = { id: "TESTONLY_completion", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: " + JSON.stringify(frame) + "\n\n");
        res.write("data: " + JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: value ? "stop" : "tool_calls" }] }) + "\n\n");
        res.end("data: [DONE]\n\n");
      } catch { res.writeHead(400); res.end(); }
    });
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const report = await verifyOpencodeCanary({ inference: "scripted", provider: "TESTONLY-fixture", model: "fixture", interactive,
        binary: process.env.CLEDGER_CONFORMANCE_OPENCODE_BINARY!, endpoint: `http://127.0.0.1:${address.port}/v1` });
      assert.equal(report.status, "pass", JSON.stringify(report));
      assert.equal(report.inference, "scripted"); // This is driver proof, never real-model certification.
      assert.ok(Object.values(report.gates).every(Boolean));
      assert.ok(requests >= 4 && requests <= 8);
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });
}
