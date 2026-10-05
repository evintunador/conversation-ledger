import { test } from "node:test";
import assert from "node:assert/strict";
import { openInterpreterEvidenceGates, verifyScriptedOpenInterpreter } from "../verification/open-interpreter.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "open-interpreter", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "open-interpreter:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "open-interpreter:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "exec_command", input: JSON.stringify({ cmd: "cat evidence.txt" }) }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "open-interpreter:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "open-interpreter:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "open-interpreter:fixture", seq: 4 }, kind: "session_state", content: { state_type: "session_meta", id: "fixture" } }),
  ];
}

test("OpenInterpreter native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(openInterpreterEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(openInterpreterEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "open-interpreter:other";
  otherSession[3]!.stream!.id = "open-interpreter:other";
  const gates = openInterpreterEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("OpenInterpreter native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.values(openInterpreterEvidenceGates(rawOnly, "marker", "secret")).every((value) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(openInterpreterEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(openInterpreterEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("OpenInterpreter verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedOpenInterpreter({ binary: "/does-not-exist/cledger-test-open-interpreter", timeoutMs: 1000 });
  assert.equal(report.cli, "open-interpreter");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("OpenInterpreter real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_OPEN_INTERPRETER_BINARY,
}, async () => {
  const report = await verifyScriptedOpenInterpreter({ binary: process.env.CLEDGER_VERIFY_OPEN_INTERPRETER_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

test("open-interpreter interactive verification preserves mode on unavailable executable", async () => {
  const report = await verifyScriptedOpenInterpreter({ binary: "/does-not-exist/TESTONLY-cli", interactive: true });
  assert.equal(report.status, "blocked");
  assert.equal(report.mode, "interactive");
});
