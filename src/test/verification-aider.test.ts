import test from "node:test";
import assert from "node:assert/strict";
import { aiderEvidenceGates } from "../verification/aider.js";
import type { EvidenceEvent } from "../schema.js";

test("Aider native proof rejects prompt echoes, unrelated file results and other sessions", () => {
  const event = (actor: string, stream: string, content: Record<string, unknown>) => ({ actor: { type: actor }, producer: { source: "aider" }, stream: { id: stream }, content }) as EvidenceEvent;
  const events = [
    event("human", "one", { blocks: [{ type: "text", text: "TESTONLY marker TESTONLY value" }] }),
    event("system", "one", { event_type: "file.operation", method: "read_text", path: "evidence.txt", call_id: "read" }),
    event("system", "one", { event_type: "file.result", call_id: "unrelated", attachment: { text: "TESTONLY value" } }),
    event("agent", "two", { blocks: [{ type: "text", text: "TESTONLY value" }] }),
  ];
  const gates = aiderEvidenceGates(events, "TESTONLY marker", "TESTONLY value");
  assert.equal(gates.prompt, true);
  assert.equal(gates.readResult, false);
  assert.equal(gates.answer, false);
  (events[2]!.content as Record<string, unknown>).call_id = "read";
  assert.equal(aiderEvidenceGates(events, "TESTONLY marker", "TESTONLY value").readResult, true);
});
