import { test } from "node:test";
import assert from "node:assert/strict";
import { mistralVibeEvidenceGates, verifyScriptedMistralVibe } from "../verification/mistral-vibe.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "mistral-vibe", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "mistral-vibe:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "mistral-vibe:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "read_file", input: JSON.stringify({ file_path: "/tmp/evidence.txt" }) }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "mistral-vibe:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "mistral-vibe:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "mistral-vibe:fixture", seq: 4 }, kind: "session_state", content: { state_type: "metadata", id: "fixture" } }),
  ];
}

test("Mistral Vibe native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(mistralVibeEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(mistralVibeEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "mistral-vibe:other";
  otherSession[3]!.stream!.id = "mistral-vibe:other";
  const gates = mistralVibeEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("Mistral Vibe native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.values(mistralVibeEvidenceGates(rawOnly, "marker", "secret")).every((value) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(mistralVibeEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(mistralVibeEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("Mistral Vibe verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedMistralVibe({ binary: "/does-not-exist/cledger-test-vibe", timeoutMs: 1000 });
  assert.equal(report.cli, "mistral-vibe");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("Mistral Vibe real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_MISTRAL_VIBE_BINARY,
}, async () => {
  const report = await verifyScriptedMistralVibe({ binary: process.env.CLEDGER_VERIFY_MISTRAL_VIBE_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

test("mistral-vibe interactive verification preserves mode on unavailable executable", async () => {
  const report = await verifyScriptedMistralVibe({ binary: "/does-not-exist/TESTONLY-cli", interactive: true });
  assert.equal(report.status, "blocked");
  assert.equal(report.mode, "interactive");
});
