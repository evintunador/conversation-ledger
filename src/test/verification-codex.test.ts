import { test } from "node:test";
import assert from "node:assert/strict";
import { codexEvidenceGates, verifyScriptedCodex, startScriptedResponsesProvider } from "../verification/codex.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "codex", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "codex:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "codex:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "exec_command", input: JSON.stringify({ cmd: "cat evidence.txt" }) }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "codex:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "codex:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "codex:fixture", seq: 4 }, kind: "session_state", content: { state_type: "session_meta", id: "fixture" } }),
  ];
}

test("Codex native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(codexEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(codexEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "codex:other";
  otherSession[3]!.stream!.id = "codex:other";
  const gates = codexEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("Codex native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.values(codexEvidenceGates(rawOnly, "marker", "secret")).every((value) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(codexEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(codexEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("Codex verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedCodex({ binary: "/does-not-exist/cledger-test-codex", timeoutMs: 1000 });
  assert.equal(report.cli, "codex");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.mode, "headless");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("Codex Responses fixture derives its answer only from a native tool result and rejects failed reads", async () => {
  const provider = await startScriptedResponsesProvider({ completionPrefix: "TESTONLY_OK " });
  try {
    const request = (input: unknown[]) => fetch(`${provider.endpoint}/responses`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input,
        tools: [{ type: "function", name: "exec_command" }] }) });
    const promptOnly = await request([{ type: "message", role: "user", content: "file-value-aaa" }]);
    const call = await promptOnly.text();
    assert.match(call, /response.function_call_arguments.done/);
    assert.match(call, /cat evidence.txt/);
    assert.doesNotMatch(call, /file-value-aaa/);
    const answered = await request([{ type: "function_call_output", call_id: "call_probe", output: "file-value-bbb" }]);
    assert.match(await answered.text(), /TESTONLY_OK file-value-bbb/);
    const failed = await request([{ type: "function_call_output", call_id: "call_probe", output: "read permission denied" }]);
    assert.equal(failed.status, 400);
    assert.equal(provider.signal.aborted, true);
    assert.match(provider.state.blocked!, /did not contain/);
  } finally { await provider.close(); }
});

test("Codex Responses fixture imposes a hard request limit", async () => {
  const provider = await startScriptedResponsesProvider();
  try {
    for (let index = 0; index < 5; index++) {
      const result = await fetch(`${provider.endpoint}/responses`, { method: "POST",
        body: JSON.stringify({ input: [], tools: [{ name: "shell_command", type: "function" }] }) });
      assert.equal(result.status, index < 4 ? 200 : 400);
      await result.text();
    }
    assert.equal(provider.signal.aborted, true);
    assert.match(provider.state.blocked!, /budget/);
  } finally { await provider.close(); }
});

test("Codex real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_CODEX_BINARY,
}, async () => {
  const report = await verifyScriptedCodex({ binary: process.env.CLEDGER_VERIFY_CODEX_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

 test("codex interactive verification records its requested mode even when blocked", async () => {
  const report = await verifyScriptedCodex({ binary: "/does-not-exist/TESTONLY-cli", interactive: true });
  assert.equal(report.status, "blocked");
  assert.equal(report.mode, "interactive");
});

test("Codex scripted provider recognizes native background title requests without echoing file evidence", async () => {
  const provider = await startScriptedResponsesProvider();
  try {
    const response = await fetch(`${provider.endpoint}/responses`, { method: "POST", body: JSON.stringify({
      tools: [], input: [{ type: "message", role: "user", content: [{ type: "input_text", text:
        "Generate a concise, single-line task title of at most 36 characters. User prompt: file-value-aaa" }] }],
      text: { format: { type: "json_schema", schema: { required: ["title"] } } },
    }) });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Read fixture file/);
    assert.doesNotMatch(body, /file-value-aaa/);
    const invalid = await fetch(`${provider.endpoint}/responses`, { method: "POST", body: JSON.stringify({ input: [], tools: [] }) });
    assert.equal(invalid.status, 400);
  } finally { await provider.close(); }
});

test("Codex fixture retains bounded native sandbox errors while rejecting missing file evidence", async () => {
  const provider = await startScriptedResponsesProvider();
  try {
    const output = "\u001b[31mbwrap: Creating new namespace failed: Operation not permitted\u001b[0m\n" + "x".repeat(5000);
    const response = await fetch(`${provider.endpoint}/responses`, { method: "POST", body: JSON.stringify({
      input: [{ type: "function_call_output", call_id: "call_probe", output }],
      tools: [{ type: "function", name: "exec_command" }],
    }) });
    assert.equal(response.status, 400);
    assert.equal(provider.signal.aborted, true);
    assert.match(provider.state.blocked!, /bwrap: Creating new namespace failed: Operation not permitted/);
    assert.doesNotMatch(provider.state.blocked!, /\u001b/);
    assert.match(provider.state.blocked!, /\[truncated\]$/);
    assert.ok(provider.state.blocked!.length < 4200);
  } finally { await provider.close(); }
});
