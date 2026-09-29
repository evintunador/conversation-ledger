import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeEvidenceGates, verifyScriptedClaudeCode, startScriptedAnthropicProvider } from "../verification/claude-code.js";
import { event } from "./helpers.js";
import type { EvidenceEvent } from "../schema.js";

function evidence(): EvidenceEvent[] {
  const producer = { tool: "cledger", source: "claude-code", session_id: "fixture" };
  return [
    event({ producer, actor: { type: "human" }, stream: { id: "claude-code:fixture", seq: 0 }, content: { blocks: [{ type: "text", text: "marker" }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "claude-code:fixture", seq: 1 }, content: { blocks: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "evidence.txt" } }] } }),
    event({ producer, actor: { type: "system" }, stream: { id: "claude-code:fixture", seq: 2 }, content: { blocks: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "secret" }] }] } }),
    event({ producer, actor: { type: "agent" }, stream: { id: "claude-code:fixture", seq: 3 }, content: { blocks: [{ type: "text", text: "secret" }] } }),
  ];
}

test("Claude Code native certification requires linked tool evidence and normalized answer in the prompt's session", () => {
  const valid = evidence();
  assert.ok(Object.values(claudeCodeEvidenceGates(valid, "marker", "secret")).every(Boolean));
  const disconnected = structuredClone(valid);
  (disconnected[2]!.content as any).blocks[0].tool_use_id = "unrelated-call";
  assert.equal(claudeCodeEvidenceGates(disconnected, "marker", "secret").hookToolResult, false);
  const otherSession = structuredClone(valid);
  otherSession[2]!.stream!.id = "claude-code:other";
  otherSession[3]!.stream!.id = "claude-code:other";
  const gates = claudeCodeEvidenceGates(otherSession, "marker", "secret");
  assert.equal(gates.hookToolResult, false);
  assert.equal(gates.hookAnswer, false);
});

test("Claude Code native certification rejects raw-only evidence, prompt echoes, and other adapters", () => {
  const rawOnly = evidence().map((item) => ({ ...item, content: {}, raw: { format: "fixture", data: item.content } }));
  assert.ok(Object.values(claudeCodeEvidenceGates(rawOnly, "marker", "secret")).every((value) => !value));
  const echo = evidence();
  echo[3]!.actor = { type: "human" };
  assert.equal(claudeCodeEvidenceGates(echo, "marker", "secret").hookAnswer, false);
  const wrongSource = evidence().map((item) => ({ ...item, producer: { ...item.producer, source: "other" } }));
  assert.ok(Object.values(claudeCodeEvidenceGates(wrongSource, "marker", "secret")).every((value) => !value));
});

test("Claude Code verification reports unavailable executable as blocked without starting inference", async () => {
  const report = await verifyScriptedClaudeCode({ binary: "/does-not-exist/cledger-test-claude-code", timeoutMs: 1000 });
  assert.equal(report.cli, "claude-code");
  assert.equal(report.status, "blocked");
  assert.equal(report.inference, "scripted");
  assert.equal(report.mode, "headless");
  assert.equal(report.requests, undefined);
  assert.deepEqual(report.gates, {});
});

test("Anthropic fixture answers only from tool results, supports the native health probe, and caps requests", async () => {
  const provider = await startScriptedAnthropicProvider();
  try {
    assert.equal((await fetch(`${provider.endpoint}/api/hello`, { method: "HEAD" })).status, 200);
    const request = (content: unknown) => fetch(`${provider.endpoint}/v1/messages?beta=true`, { method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content }], tools: [{ name: "Read" }], stream: true }) });
    const call = await (await request("Prompt echo file-value-aaa")).text();
    assert.match(call, /input_json_delta/);
    assert.doesNotMatch(call, /file-value-aaa/);
    const answer = await (await request([{ type: "tool_result", tool_use_id: "toolu_probe", content: "file-value-bbb" }])).text();
    assert.match(answer, /file-value-bbb/);
    for (let index = 0; index < 3; index++) {
      const result = await request("Read file");
      assert.equal(result.status, index < 2 ? 200 : 400);
      await result.text();
    }
    assert.equal(provider.signal.aborted, true);
    assert.match(provider.state.blocked!, /budget/);
  } finally { await provider.close(); }
});

test("Claude Code real CLI smoke runs only when an explicit isolated binary is supplied", {
  skip: !process.env.CLEDGER_VERIFY_CLAUDE_CODE_BINARY,
}, async () => {
  const report = await verifyScriptedClaudeCode({ binary: process.env.CLEDGER_VERIFY_CLAUDE_CODE_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.ok((report.requests ?? 0) >= 2 && (report.requests ?? 0) <= 4);
});

 test("claude-code interactive verification records its requested mode even when blocked", async () => {
  const report = await verifyScriptedClaudeCode({ binary: "/does-not-exist/TESTONLY-cli", interactive: true });
  assert.equal(report.status, "blocked");
  assert.equal(report.mode, "interactive");
});

test("Anthropic fixture recognizes Claude's native title request without returning prompt evidence", async () => {
  const provider = await startScriptedAnthropicProvider();
  try {
    const response = await fetch(`${provider.endpoint}/v1/messages`, { method: "POST", body: JSON.stringify({
      messages: [{ role: "user", content: [{ type: "text", text:
        "<session>file-value-aaa</session> Write the title in the predominant language of the session" }] }],
      stream: false,
    }) });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Read fixture file/);
    assert.doesNotMatch(body, /file-value-aaa/);
    const invalid = await fetch(`${provider.endpoint}/v1/messages`, { method: "POST", body: JSON.stringify({ messages: [] }) });
    assert.equal(invalid.status, 400);
  } finally { await provider.close(); }
});
