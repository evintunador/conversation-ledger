import test from "node:test";
import assert from "node:assert/strict";
import { clineEvidenceGates } from "../verification/cline.js";
import type { EvidenceEvent } from "../schema.js";
test("Cline native proof requires linked read result in the prompt session", () => {
  const event = (actor: string, session: string, blocks: unknown[]) =>
    ({
      actor: { type: actor },
      stream: { id: session },
      producer: { source: "cline" },
      content: { blocks },
    }) as EvidenceEvent;
  const events = [
    event("human", "one", [
      { type: "text", text: "TESTONLY marker TESTONLY value" },
    ]),
    event("agent", "one", [
      {
        type: "tool_use",
        id: "read",
        name: "read_files",
        input: { files: [{ path: "evidence.txt" }] },
      },
    ]),
    event("system", "one", [
      { type: "tool_result", tool_use_id: "other", content: "TESTONLY value" },
    ]),
    event("agent", "two", [{ type: "text", text: "TESTONLY value" }]),
  ];
  assert.deepEqual(
    clineEvidenceGates(events, "TESTONLY marker", "TESTONLY value"),
    {
      hookPrompt: true,
      hookToolUse: true,
      hookToolResult: false,
      hookAnswer: false,
    },
  );
});
