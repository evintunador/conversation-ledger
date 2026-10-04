/** Bounded model substitute; emits tool calls, never native transcript fixtures. */
import { createServer } from "node:http";
export type CoreCli = "claude-code" | "codex" | "opencode";
export async function startConformanceProvider(cli: CoreCli) {
  const state = { requests: 0, typedInputs: [] as string[], inputImage: false, imageToolResult: false, toolError: false };
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "HEAD" && req.url === "/api/hello") { res.writeHead(200); res.end(); return; }
    if (req.method !== "POST" || !/^\/v1\/(?:messages|responses|chat\/completions)(?:\?.*)?$/.test(req.url ?? "")) { res.writeHead(400); res.end(); return; }
    if (++state.requests > 16) { res.writeHead(429); res.end(); return; }
    try {
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 2000000) throw Error("fixture request too large"); }
      const data = JSON.parse(body);
      const rows: Record<string, unknown>[] = data.input ?? data.messages ?? [];
      const flat = rows.flatMap(r => Array.isArray(r.content) ? r.content : []);
      for (const row of rows.filter(r => r.role === "user")) {
        const text = typeof row.content === "string" ? row.content : JSON.stringify(row.content);
        if (text?.includes("TESTONLY_CONFORMANCE")) state.typedInputs.push(text);
      }
      state.inputImage ||= flat.some(b => ["input_image", "image", "image_url"].includes(b.type));
      const results = cli === "claude-code" ? flat.filter(b => b.type === "tool_result")
        : cli === "codex" ? rows.filter(r => r.type === "function_call_output") : rows.filter(r => r.role === "tool");
      const latest = results.at(-1);
      const output = JSON.stringify(latest?.content ?? latest?.output ?? "");
      const content = latest?.content;
      state.toolError ||= !!latest && (latest.is_error === true || /No such file|does not exist|not found|exit code: 1|Process exited with code 1/i.test(output));
      state.imageToolResult ||= !!latest && Array.isArray(content) && content.some(b => b.type === "image" || b.type === "image_url");
      const all = JSON.stringify(results);
      const value = all.match(/TESTONLY_CANARY_[a-f0-9-]+/)?.[0];
      const auxiliary = !data.tools?.length;
      const answer = auxiliary ? "TESTONLY title" : calls >= (cli === "codex" ? 2 : 3) && value ? "TESTONLY_CONFORMANCE_DONE " + value : undefined;
      // Calls are a per-run finite sequence; resume repeats an ordinary assistant
      // reply against the native saved conversation, without fabricating history.
      const target = calls === 0 ? "missing-TESTONLY.txt" : calls === 1 ? "evidence.txt" : "image-TESTONLY.png";
      const id = "TESTONLY_call_" + calls;
      if (!answer && !auxiliary) calls++;
      let name = cli === "claude-code" ? "Read" : "read";
      let input: Record<string, unknown> = cli === "claude-code" ? { file_path: target } : { filePath: target };
      if (cli === "codex") {
        const tools = (data.tools ?? []).flatMap((t: Record<string, unknown>) => Array.isArray(t.tools) ? t.tools : [t]);
        name = ["exec_command", "shell_command", "shell"].find(n => tools.some((t: Record<string, unknown>) => t.name === n)) ?? "exec_command";
        input = name === "exec_command" ? { cmd: "/bin/cat " + target, login: false }
          : name === "shell_command" ? { command: "/bin/cat " + target } : { command: ["/bin/cat", target] };
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (cli === "claude-code") {
        const block = answer ? { type: "text", text: answer } : { type: "tool_use", id, name, input };
        const message = { id: "TESTONLY_msg_" + state.requests, type: "message", role: "assistant", model: data.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        const send = (type: string, fields: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send("message_start", { message }); send("content_block_start", { index: 0, content_block: answer ? { type: "text", text: "" } : { ...block, input: {} } });
        send("content_block_delta", { index: 0, delta: answer ? { type: "text_delta", text: answer } : { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        send("content_block_stop", { index: 0 }); send("message_delta", { delta: { stop_reason: answer ? "end_turn" : "tool_use" }, usage: { output_tokens: 1 } }); send("message_stop", {});
      } else if (cli === "codex") {
        const item = answer ? { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }
          : { id, type: "function_call", call_id: id, name, arguments: JSON.stringify(input), status: "completed" };
        const response = { id: "TESTONLY_resp_" + state.requests, object: "response", created_at: 1, model: data.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const send = (type: string, fields: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send("response.created", { response: { ...response, status: "in_progress", output: [] } });
        send("response.output_item.added", { output_index: 0, item: answer ? { ...item, content: [] } : { ...item, arguments: "" } });
        if (answer) {
          send("response.content_part.added", { item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          send("response.output_text.delta", { item_id: id, output_index: 0, content_index: 0, delta: answer });
          send("response.output_text.done", { item_id: id, output_index: 0, content_index: 0, text: answer });
        } else {
          send("response.function_call_arguments.delta", { item_id: id, output_index: 0, delta: JSON.stringify(input) });
          send("response.function_call_arguments.done", { item_id: id, output_index: 0, arguments: JSON.stringify(input) });
        }
        send("response.output_item.done", { output_index: 0, item }); send("response.completed", { response: { ...response, status: "completed" } });
      } else {
        const delta = answer ? { content: answer } : { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] };
        for (const [part, finish] of [[delta, null], [{}, answer ? "stop" : "tool_calls"]]) res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: data.model,
          choices: [{ index: 0, delta: part, finish_reason: finish }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("Fixture unavailable");
  return { state, endpoint: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); } };
}
