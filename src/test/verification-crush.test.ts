import { test } from "node:test";
import assert from "node:assert/strict";
import { crushEvidenceGates, verifyScriptedCrush } from "../verification/crush.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "crush", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "crush:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "crush:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "view", input: { file_path: "/fixture/evidence.txt" } }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "crush:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "crush:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "crush:fixture", seq: 4 }, kind: "session_state", content: { state_type: "session", id: "fixture" } }),
  ];
}

test("Crush native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(crushEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(crushEvidenceGates(disconnected, "marker", "secret").automaticToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "crush:other";
  otherSession[3]!.stream!.id = "crush:other";
  const gates = crushEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.automaticToolResult, false);
  assert.equal(gates.automaticAnswer, false);
});

test("Crush native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.entries(crushEvidenceGates(rawOnly, "marker", "secret")).filter(([key]) => key !== "noUnrecognizedRecords").every(([, value]) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(crushEvidenceGates(echo, "marker", "secret").automaticAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(crushEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("Crush real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_CRUSH_BINARY,
}, async () => {
  const report = await verifyScriptedCrush({ binary: process.env.CLEDGER_VERIFY_CRUSH_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

test("crush certification fails when native baseline contains drift", () => {
  const valid = evidence();
  valid.push({ ...valid[0]!, kind: "unrecognized" });
  assert.equal(crushEvidenceGates(valid, "marker", "secret").noUnrecognizedRecords, false);
});
