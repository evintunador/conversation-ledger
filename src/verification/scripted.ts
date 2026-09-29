import { createServer } from "node:http";
import { verifyOpencode, type Options, type Report } from "./opencode.js";

export interface ScriptedOptions { toolName?: string; toolArguments?: Record<string, unknown>; completionText?: string; noToolsCompletionText?: string; completionPrefix?: string }

/** Deterministic OpenAI-compatible provider, useful with the actual CLI executable. */
export async function startScriptedProvider(options: ScriptedOptions = {}) {
  const state = { requests: 0, headersValid: true };
  const server = createServer(async (req, res) => {
    try {
      if (++state.requests > 8) { res.writeHead(429); res.end("scripted request budget exceeded"); return; }
      state.headersValid &&= req.headers["x-cledger-verification"] === "1";
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 2_000_000) { res.writeHead(413); res.end(); return; }
      }
      const data = JSON.parse(body) as { stream?: boolean; tools?: unknown[]; messages?: { role?: string; content?: unknown }[] };
      const tool = [...(data.messages ?? [])].reverse().find(m => m.role === "tool");
      const secret = options.noToolsCompletionText && !data.tools?.length ? options.noToolsCompletionText
        : tool && options.completionText ? options.completionText : JSON.stringify(tool ?? "").match(/file-value-[a-f0-9-]+/)?.[0];
      const delta = secret ? { content: tool ? (options.completionPrefix ?? "") + secret : secret } : { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: {
        name: options.toolName ?? "read", arguments: JSON.stringify(options.toolArguments ?? { filePath: "evidence.txt" }),
      } }] };
      if (data.stream !== true) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl_probe", object: "chat.completion", created: 1, model: "fixture",
          choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: secret ? "stop" : "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [value, reason] of [[delta, null], [{}, secret ? "stop" : "tool_calls"]]) {
        res.write("data: " + JSON.stringify({ id: "chatcmpl_probe", object: "chat.completion.chunk", created: 1,
          model: "fixture", choices: [{ index: 0, delta: value, finish_reason: reason }] }) + "\n\n");
      }
      res.end("data: [DONE]\n\n");
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No scripted endpoint address");
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, state,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Real CLI and installed hooks; deterministic OpenAI-compatible model substitute. No inference. */
export async function verifyScriptedOpencode(options: Options = {}): Promise<Report> {
  const provider = await startScriptedProvider();
  try {
    const report = await verifyOpencode({ ...options, endpoint: provider.endpoint, model: "fixture" });
    report.inference = "scripted";
    report.exclusions.push("real model/provider behavior");
    if (report.status === "pass") {
      report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 8;
      report.gates.agentHeader = provider.state.headersValid;
      if (!Object.values(report.gates).every(Boolean)) report.status = "fail";
    }
    return report;
  } finally { await provider.close(); }
}
