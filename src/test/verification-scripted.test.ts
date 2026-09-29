import { test } from "node:test";
import assert from "node:assert/strict";
import { startScriptedProvider } from "../verification/scripted.js";

test("optional auxiliary title response cannot replace tool execution and answer evidence", async () => {
  const server = await startScriptedProvider({ noToolsCompletionText: "Fixture title", toolName: "view", completionPrefix: "TESTONLY-answer-complete " });
  try {
    const request = async (body: unknown) => {
      const response = await fetch(server.endpoint + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "X-Cledger-Verification": "1" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return await response.json() as { choices: { message: { content?: string; tool_calls?: unknown[] } }[] };
    };
    const title = await request({ stream: false, messages: [{ role: "user", content: "Give this session a title" }] });
    assert.equal(title.choices[0]!.message.content, "Fixture title");
    assert.equal(title.choices[0]!.message.tool_calls, undefined);
    const tools = [{ type: "function", function: { name: "view" } }];
    const call = await request({ stream: false, tools, messages: [{ role: "user", content: "Read evidence.txt" }] });
    assert.equal(call.choices[0]!.message.content, undefined);
    assert.equal(call.choices[0]!.message.tool_calls?.length, 1);
    const answer = await request({ stream: false, tools, messages: [{ role: "tool", content: "file-value-0123-abcd" }] });
    assert.equal(answer.choices[0]!.message.content, "TESTONLY-answer-complete file-value-0123-abcd");
    assert.ok(!JSON.stringify(call).includes("TESTONLY-answer-complete"));
    assert.ok(!JSON.stringify(title).includes("TESTONLY-answer-complete"));
    assert.equal(server.state.requests, 3);
  } finally { await server.close(); }
});
