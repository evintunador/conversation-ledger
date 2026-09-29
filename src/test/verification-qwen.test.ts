import test from "node:test";
import assert from "node:assert/strict";
import { qwenEvidenceGates } from "../verification/qwen-code.js";
import type { EvidenceEvent } from "../schema.js";

test("Qwen native gates require native tool result actor and same-session assistant evidence", () => {
  const event = (actor: string, session: string, blocks: unknown[]): EvidenceEvent => ({
    actor: { type: actor }, stream: { id: session, seq: 0 }, producer: { source: "qwen-code" }, content: { blocks },
  }) as EvidenceEvent;
  const marker = "TESTONLY-probe", value = "TESTONLY-file-value";
  const events = [
    event("human", "one", [{ type: "text", text: marker }]),
    event("agent", "one", [{ type: "tool_use", id: "read-call", name: "read_file", input: { file_path: "evidence.txt" } }]),
    event("human", "one", [{ type: "tool_result", tool_use_id: "read-call", content: value }]),
    event("agent", "two", [{ type: "text", text: value }]),
  ];
  assert.deepEqual(qwenEvidenceGates(events, marker, value), { hookPrompt: true, hookToolUse: true, hookToolResult: false, hookAnswer: false });
  events[2]!.actor.type = "system";
  events[3]!.stream!.id = "one";
  assert.ok(Object.values(qwenEvidenceGates(events, marker, value)).every(Boolean));
  const result = events.flatMap(e => (e.content as { blocks: Record<string, unknown>[] }).blocks).find(b => b.type === "tool_result")!;
  result.tool_use_id = "unrelated-call";
  assert.equal(qwenEvidenceGates(events, marker, value).hookToolResult, false);
  events.forEach(e => { e.producer.source = "opencode"; });
  assert.ok(Object.values(qwenEvidenceGates(events, marker, value)).every(v => !v));
});
