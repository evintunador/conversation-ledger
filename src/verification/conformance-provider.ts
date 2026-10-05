/** Bounded model substitute; emits tool calls, never native transcript fixtures. */
import { createServer } from "node:http";
import { join } from "node:path";
export type CoreCli = "claude-code" | "codex" | "opencode";
export type ConformanceCli = CoreCli | "gemini-cli" | "qwen-code" | "pi" | "kilo" | "copilot" | "kimi" | "open-interpreter" | "continue" | "cline" | "goose" | "openhands" | "droid" | "mistral-vibe" | "crush";
export async function startConformanceProvider(cli: ConformanceCli, repository?: string) {
  const state = { requests: 0, typedInputs: [] as string[], inputImage: false, imageToolResult: false, toolError: false, nativeTools: [] as string[] };
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "HEAD" && req.url === "/api/hello") { res.writeHead(200); res.end(); return; }
    const google = cli === "gemini-cli" && /:(?:countTokens|generateContent|streamGenerateContent)/.test(req.url ?? "");
    if (req.method !== "POST" || (!google && !/^\/v1\/(?:messages|responses|chat\/completions)(?:\?.*)?$/.test(req.url ?? ""))) { res.writeHead(400); res.end(); return; }
    if (++state.requests > 16) { res.writeHead(429); res.end(); return; }
    try {
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 2000000) throw Error("fixture request too large"); }
      const data = JSON.parse(body);
      const advertised = (data.tools ?? []).flatMap((t: Record<string, any>) => t.function ? [t.function] : t.functionDeclarations ?? t.tools ?? [t]);
      state.nativeTools = [...new Set([...state.nativeTools, ...advertised.map((t: Record<string, any>) => t.name).filter((name: unknown): name is string => typeof name === "string")])];
      if (google && req.url?.includes(":countTokens")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"totalTokens":64}'); return; }
      const rows: Record<string, unknown>[] = data.input ?? data.messages ?? data.contents ?? [];
      const flat = rows.flatMap(r => Array.isArray(r.content) ? r.content : Array.isArray(r.parts) ? r.parts : []);
      for (const row of rows.filter(r => r.role === "user")) {
        const text = typeof row.content === "string" ? row.content : JSON.stringify(row.content ?? row.parts);
        if (text?.includes("TESTONLY_CONFORMANCE")) state.typedInputs.push(text);
      }
      const humanParts = rows.filter(r => r.role === "user").flatMap(r => {
        const parts = Array.isArray(r.content) ? r.content : Array.isArray(r.parts) ? r.parts : [];
        return !JSON.stringify(parts).includes("TESTONLY_CONFORMANCE") || parts.some(b => b.type === "tool_result" || b.functionResponse) ? [] : parts;
      });
      state.inputImage ||= humanParts.some(b => ["input_image", "image", "image_url"].includes(b.type) || b.inlineData?.mimeType?.startsWith("image/"));
      const results = cli === "claude-code" ? flat.filter(b => b.type === "tool_result")
        : ["codex", "open-interpreter"].includes(cli) ? rows.filter(r => r.type === "function_call_output") : google ? flat.filter(b => b.functionResponse) : rows.filter(r => r.role === "tool");
      const latest = results.at(-1);
      const output = JSON.stringify(latest?.content ?? latest?.output ?? latest?.functionResponse ?? "");
      const content = latest?.content;
      state.toolError ||= !!latest && (latest.is_error === true || /No such file|does not exist|not found|exit code: 1|Process exited with code 1|ENOENT/i.test(output));
      state.imageToolResult ||= !!latest && Array.isArray(content) && content.some(b => b.type === "image" || b.type === "image_url");
      const all = JSON.stringify(results);
      const value = all.match(/TESTONLY_CANARY_[a-f0-9-]+/)?.[0];
      const auxiliary = !data.tools?.length;
      const answer = auxiliary ? "TESTONLY title" : calls >= (["codex", "open-interpreter"].includes(cli) ? 2 : 3) && value ? "TESTONLY_CONFORMANCE_DONE " + value : undefined;
      // Calls are a per-run finite sequence; resume repeats an ordinary assistant
      // reply against the native saved conversation, without fabricating history.
      const filename = calls === 0 ? "missing-TESTONLY.txt" : calls === 1 ? "evidence.txt" : "image-TESTONLY.png";
      const target = repository ? join(repository, filename) : filename;
      const id = "TESTONLY_call_" + calls;
      if (!answer && !auxiliary) calls++;
      let name = cli === "claude-code" ? "Read" : "read";
      let input: Record<string, unknown> = cli === "claude-code" ? { file_path: target } : { filePath: target };
      if (cli === "pi" || cli === "kimi" || cli === "copilot") { name = cli === "kimi" ? "Read" : cli === "copilot" ? "view" : "read"; input = { path: target }; }
      if (cli === "continue") { name = "Read"; input = { filepath: target }; }
      if (cli === "cline") { name = "read_files"; input = { files: [{ path: target }] }; }
      if (cli === "goose") { name = "shell"; input = { command: "/bin/cat " + target }; }
      if (cli === "openhands") { name = "file_editor"; input = { command: "view", path: target, security_risk: "LOW" }; }
      if (cli === "droid" || cli === "mistral-vibe") { name = cli === "droid" ? "Read" : "read_file"; input = { file_path: target }; }
      if (cli === "crush") { name = "view"; input = { file_path: target }; }
      if (cli === "kimi" && filename === "image-TESTONLY.png") name = "ReadMediaFile";
      if (cli === "gemini-cli" || cli === "qwen-code") { name = "read_file"; input = { file_path: target }; }
      if (["codex", "open-interpreter"].includes(cli)) {
        const tools = (data.tools ?? []).flatMap((t: Record<string, unknown>) => Array.isArray(t.tools) ? t.tools : [t]);
        name = ["exec_command", "shell_command", "shell"].find(n => tools.some((t: Record<string, unknown>) => t.name === n)) ?? "exec_command";
        input = name === "exec_command" ? { cmd: "/bin/cat " + target, login: false }
          : name === "shell_command" ? { command: "/bin/cat " + target } : { command: ["/bin/cat", target] };
      }
      if (google) {
        const parts = answer ? [{ text: answer }] : [{ functionCall: { name, args: input } }];
        const response = JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: "fixture" });
        const stream = req.url?.includes(":streamGenerateContent");
        res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" });
        res.end(stream ? `data: ${response}\n\n` : response); return;
      }
      if (!["claude-code", "codex", "open-interpreter"].includes(cli) && data.stream !== true) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", created: 1, model: data.model,
          choices: [{ index: 0, message: answer ? { role: "assistant", content: answer } : { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: answer ? "stop" : "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
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
      } else if (["codex", "open-interpreter"].includes(cli)) {
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
