import { test } from "node:test";
import assert from "node:assert/strict";
import { openhandsEvidenceGates, verifyScriptedOpenHands } from "../verification/openhands.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

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
