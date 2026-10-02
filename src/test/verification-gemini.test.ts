import test from "node:test";
import assert from "node:assert/strict";
import { geminiEvidenceGates, verifyScriptedGemini } from "../verification/gemini-cli.js";
import type { EvidenceEvent } from "../schema.js";

test("Gemini verification requires linked read results and same-session answers", () => {
  const event = (actor: string, session: string, blocks: unknown[]): EvidenceEvent => ({
    actor: { type: actor }, stream: { id: session, seq: 0 }, producer: { source: "gemini-cli" }, content: { blocks },
  }) as EvidenceEvent;
  const marker = "TESTONLY-probe", value = "TESTONLY-file-value";
  const events = [
    event("human", "one", [{ type: "text", text: marker }]),
    event("agent", "one", [{ type: "tool_use", id: "read-1", name: "read_file", input: { file_path: "evidence.txt" } }]),
    event("agent", "one", [{ type: "tool_result", tool_use_id: "unrelated", content: value }]),
    event("agent", "two", [{ type: "text", text: value }]),
  ];
  assert.deepEqual(geminiEvidenceGates(events, marker, value), { hookPrompt: true, hookToolUse: true, hookToolResult: false, hookAnswer: false });
  events[2] = event("agent", "one", [{ type: "tool_result", tool_use_id: "read-1", content: value }]);
  events[3]!.stream!.id = "one";
  assert.ok(Object.values(geminiEvidenceGates(events, marker, value)).every(Boolean));
});

test("Gemini actual executable captures hook evidence before backfill", {
  skip: !process.env.CLEDGER_VERIFY_GEMINI_CLI_BINARY,
}, async () => {
  const report = await verifyScriptedGemini({ binary: process.env.CLEDGER_VERIFY_GEMINI_CLI_BINARY! });
  assert.equal(report.status, "pass", JSON.stringify(report));
});
