import { test } from "node:test";
import assert from "node:assert/strict";
import { startConformanceProvider } from "../verification/conformance-provider.js";

test("tool-output images projected into user rows cannot prove native human image entry", async () => {
  const provider = await startConformanceProvider("claude-code");
  try {
    const response = await fetch(provider.endpoint + "/v1/messages", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [
      { type: "text", text: "TESTONLY_CONFORMANCE" },
      { type: "tool_result", content: [{ type: "image", source: { type: "base64", data: "TESTONLY" } }] },
    ] }] }) });
    await response.text();
    assert.equal(provider.state.inputImage, false);
  } finally { await provider.close(); }
});
test("Responses native image-only human input is distinct from function output", async () => {
  const provider = await startConformanceProvider("codex");
  try {
    for (const input of [
      [{ type: "function_call_output", output: [{ type: "input_image", image_url: "data:image/png;base64,TESTONLY" }] }],
      [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,TESTONLY" }] }],
    ]) {
      const response = await fetch(provider.endpoint + "/v1/responses", { method: "POST", body: JSON.stringify({ input }) });
      await response.text();
      assert.equal(provider.state.inputImage, "role" in input[0]!);
    }
  } finally { await provider.close(); }
});

test("Pi's image-only human message qualifies while its explicit tool projection does not", async () => {
  const provider = await startConformanceProvider("pi");
  try {
    for (const content of [
      [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: "data:image/png;base64,TESTONLY" } }],
      [{ type: "image_url", image_url: { url: "data:image/png;base64,TESTONLY" } }],
    ]) {
      const response = await fetch(provider.endpoint + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content }] }) });
      await response.text();
      assert.equal(provider.state.inputImage, content.length === 1);
    }
  } finally { await provider.close(); }
});
