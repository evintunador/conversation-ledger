import { test } from "node:test";
import assert from "node:assert/strict";
import { convertParts, partIssues } from "../adapters/genai-parts.js";

test("GenAI reports and retains malformed or unknown content without dropping siblings", () => {
  const parts = [
    { text: "visible" },
    42,
    null,
    [],
    { futurePayload: "TESTONLY-preserved" },
    { text: 123 },
    { functionCall: "bad" },
  ];
  assert.equal(partIssues(parts).length, 6);
  assert.equal(convertParts(parts).length, parts.length);
  assert.match(JSON.stringify(convertParts(parts)), /TESTONLY-preserved/);
  assert.equal(partIssues(42).length, 1);
  assert.equal(convertParts(42).length, 1);
});

test("GenAI current SDK media, executable code, metadata and provider signatures are known", () => {
  const parts = [
    { inlineData: { mimeType: "text/plain", data: "VEVTVE9OTFk=" } },
    { fileData: { fileUri: "file:///TESTONLY.txt", mimeType: "text/plain" } },
    { executableCode: { language: "PYTHON", code: "print(1)" } },
    { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } },
    { audioTranscription: { text: "heard" } },
    { toolCall: { id: "one" } },
    { toolResponse: { id: "one", response: {} } },
    { thoughtSignature: "TESTONLY-signature" },
    { text: "visible", thought: false, customNativeMetadata: "retained raw" },
  ];
  assert.deepEqual(partIssues(parts), []);
  assert.equal(convertParts(parts).length, parts.length);
});

test("native functionResponse media siblings remain linked to their tool result", () => {
  const parts = [{ inlineData: { mimeType: "image/jpeg", data: { type: "attachment_reference", sha256: "TESTONLY-digest", size: 281 } } }];
  const converted = convertParts([{ functionResponse: { id: "TESTONLY_call", name: "read_file", response: { output: "Image overview: 32x32" }, parts } }]);
  assert.deepEqual(converted, [{ type: "tool_result", tool_use_id: "TESTONLY_call", name: "read_file", content: { output: "Image overview: 32x32" }, parts }]);
});
