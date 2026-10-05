import { test } from "node:test";
import assert from "node:assert/strict";
import { kimiEvidenceGates, verifyScriptedKimi } from "../verification/kimi.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { startScriptedProvider } from "../verification/scripted.js";

test("Kimi configured provider rejects partial or non-loopback settings before execution", async () => {
  for (const options of [
    { apiKey: "TESTONLY-key" }, { endpoint: "http://127.0.0.1:1/v1" },
    { endpoint: "http://127.0.0.1:1/v1", model: " " },
    { endpoint: "https://example.com/v1", model: "TESTONLY-model" },
    { endpoint: "http://127.0.0.1:1/v1", model: "TESTONLY-model", apiKey: "bad\nkey" },
  ]) await assert.rejects(verifyScriptedKimi({ ...options, binary: "/does-not-exist" }));
});

test("installed Kimi TUI accepts an explicit endpoint with a distinct upstream model ID", {
  skip: !process.env.CLEDGER_VERIFY_KIMI_CONFIGURED_BINARY,
}, async () => {
  const provider = await startScriptedProvider({ toolName: "Read", toolArguments: { path: "evidence.txt" } });
  const observed: { model: unknown; authorization: string | undefined; maxTokens: unknown }[] = [];
  const wrapper = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      observed.push({ model: parsed.model, authorization: req.headers.authorization, maxTokens: parsed.max_tokens ?? parsed.max_completion_tokens });
      const response = await fetch(provider.endpoint + "/chat/completions", { method: "POST", body,
        headers: { "content-type": "application/json", "x-cledger-verification": String(req.headers["x-cledger-verification"] ?? "") } });
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  try {
    await new Promise<void>(resolve => wrapper.listen(0, "127.0.0.1", resolve));
    const address = wrapper.address();
    assert.ok(address && typeof address !== "string");
    const report = await verifyScriptedKimi({ binary: process.env.CLEDGER_VERIFY_KIMI_CONFIGURED_BINARY!, interactive: true,
      endpoint: `http://127.0.0.1:${address.port}/v1`, model: "TESTONLY-provider-model", apiKey: "TESTONLY-provider-key", timeoutMs: 60000 });
    // This endpoint is a model substitute: never present it as real inference.
    report.inference = "scripted";
    report.exclusions.push("real provider/model behavior");
    report.gates.configuredModelForwarded = observed.length >= 2 && observed.every(request => request.model === "TESTONLY-provider-model");
    report.gates.configuredKeyForwarded = observed.length >= 2 && observed.every(request => request.authorization === "Bearer TESTONLY-provider-key");
    report.gates.configuredOutputBounded = observed.length >= 2 && observed.every(request => typeof request.maxTokens === "number" && request.maxTokens <= 1024);
    report.gates.scriptedProviderHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) report.status = "fail";
    if (process.env.CLEDGER_VERIFY_KIMI_CONFIGURED_REPORT) await writeFile(process.env.CLEDGER_VERIFY_KIMI_CONFIGURED_REPORT, JSON.stringify(report, null, 2) + "\n");
    assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
    assert.equal(report.mode, "interactive");
    assert.ok(Object.values(report.gates).every(Boolean));
  } finally {
    wrapper.closeAllConnections();
    await new Promise<void>(resolve => wrapper.close(() => resolve()));
    await provider.close();
  }
});

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "kimi", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "kimi:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "kimi:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "evidence.txt" } }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "kimi:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "kimi:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "kimi:fixture", seq: 4 }, kind: "session_state", content: { state_type: "metadata", id: "fixture" } }),
  ];
}

test("Kimi native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(kimiEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(kimiEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "kimi:other";
  otherSession[3]!.stream!.id = "kimi:other";
  const gates = kimiEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("Kimi native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.entries(kimiEvidenceGates(rawOnly, "marker", "secret")).filter(([key]) => key !== "noUnrecognizedRecords").every(([, value]) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(kimiEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(kimiEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("Kimi verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedKimi({ binary: "/does-not-exist/cledger-test-kimi", timeoutMs: 1000 });
  assert.equal(report.cli, "kimi");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("Kimi real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_KIMI_BINARY,
}, async () => {
  const report = await verifyScriptedKimi({ binary: process.env.CLEDGER_VERIFY_KIMI_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

test("kimi certification fails when native baseline contains drift", () => {
  const valid = evidence();
  valid.push({ ...valid[0]!, kind: "unrecognized" });
  assert.equal(kimiEvidenceGates(valid, "marker", "secret").noUnrecognizedRecords, false);
});
