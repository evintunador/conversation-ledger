import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUnrecognizedEvidence } from "../verification/drift.js";
import type { EvidenceEvent } from "../schema.js";

test("native drift gate catches nested unrecognized content inside normal turns", () => {
  const event = {
    kind: "conversation_turn",
    producer: { source: "qwen-code" },
    content: {
      blocks: [
        {
          type: "tool_result",
          content: [{ type: "unrecognized", data: "TESTONLY-future" }],
        },
      ],
    },
  } as EvidenceEvent;
  assert.equal(hasUnrecognizedEvidence([event], "qwen-code"), true);
  assert.equal(hasUnrecognizedEvidence([event], "cline"), false);
  assert.equal(
    hasUnrecognizedEvidence(
      [
        {
          ...event,
          content: { blocks: [{ type: "text", text: "unrecognized" }] },
        },
      ],
      "qwen-code",
    ),
    false,
  );
});
