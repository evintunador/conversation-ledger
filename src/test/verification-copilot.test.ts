import test from "node:test";
import assert from "node:assert/strict";
import { copilotEvidenceGates } from "../verification/copilot.js";
import type { EvidenceEvent } from "../schema.js";

test("Copilot native gates cannot mistake a quoted tool result or another session for hook success", () => {
  const event = (actor: string, session: string, blocks: unknown[]): EvidenceEvent => ({
    actor: { type: actor }, stream: { id: session, seq: 0 }, producer: { source: "copilot" }, content: { blocks },
  }) as EvidenceEvent;
  const events = [event("human", "one", [{ type: "text", text: "TESTONLY marker TESTONLY value" }]),
    event("agent", "two", [{ type: "tool_use", id: "read-call", name: "view", input: { path: "evidence.txt" } }, { type: "text", text: "TESTONLY value" }]),
    event("human", "one", [{ type: "tool_result", tool_use_id: "read-call", content: "TESTONLY value" }])];
  assert.deepEqual(copilotEvidenceGates(events, "TESTONLY marker", "TESTONLY value"), { hookPrompt: true, hookToolUse: false, hookToolResult: false, hookAnswer: false });
  events[1]!.stream!.id = "one";
  events[2]!.actor.type = "system";
  assert.ok(Object.values(copilotEvidenceGates(events, "TESTONLY marker", "TESTONLY value")).every(Boolean));
  const result = events.flatMap(e => (e.content as { blocks: Record<string, unknown>[] }).blocks).find(b => b.type === "tool_result")!;
  result.tool_use_id = "unrelated-call";
  assert.equal(copilotEvidenceGates(events, "TESTONLY marker", "TESTONLY value").hookToolResult, false);
});
