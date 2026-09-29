import { test } from "node:test";
import assert from "node:assert/strict";
import { kimiEvidenceGates, verifyScriptedKimi } from "../verification/kimi.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

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
