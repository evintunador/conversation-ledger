import { test } from "node:test";
import assert from "node:assert/strict";
import { droidEvidenceGates, droidLoginRequired, verifyScriptedDroid } from "../verification/droid.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "droid", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "droid:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "droid:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/fixture/evidence.txt" } }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "droid:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "droid:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "droid:fixture", seq: 4 }, kind: "session_state", content: { state_type: "session_start", id: "fixture" } }),
  ];
}

test("Droid login prerequisite remains blocked when the TUI styles the sentence", () => {
  assert.equal(droidLoginRequired("Please login with your Factory account to continue"), true);
  assert.equal(droidLoginRequired("Please login with your \x1b[1mFactory\x1b[0m account to continue"), true);
  assert.equal(droidLoginRequired("TESTONLY model response or an unrelated startup error"), false);
});

test("Droid native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(droidEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(droidEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "droid:other";
  otherSession[3]!.stream!.id = "droid:other";
  const gates = droidEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("Droid native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.entries(droidEvidenceGates(rawOnly, "marker", "secret")).filter(([key]) => key !== "noUnrecognizedRecords").every(([, value]) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(droidEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(droidEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("Droid verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedDroid({ binary: "/does-not-exist/cledger-test-droid", timeoutMs: 1000 });
  assert.equal(report.cli, "droid");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("Droid real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_DROID_BINARY,
}, async () => {
  const report = await verifyScriptedDroid({ binary: process.env.CLEDGER_VERIFY_DROID_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

test("droid certification fails when native baseline contains drift", () => {
  const valid = evidence();
  valid.push({ ...valid[0]!, kind: "unrecognized" });
  assert.equal(droidEvidenceGates(valid, "marker", "secret").noUnrecognizedRecords, false);
});
