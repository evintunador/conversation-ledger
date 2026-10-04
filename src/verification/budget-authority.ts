/** Key-holding service. Deploy on a persistent trusted host behind HTTPS. */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { BudgetStore, reservationCost, type ReviewedPrice } from "./budget.js";
import { TARGET_CLIS } from "./roster.js";
export interface BudgetRoute { price: ReviewedPrice; apiKey: string }
const equal = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function boundedChat(body: unknown, price: ReviewedPrice): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Invalid chat request");
  reservationCost(price);
  const value = body as Record<string, unknown>;
  const allowed = new Set(["model", "messages", "tools", "tool_choice", "stream", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stream_options", "parallel_tool_calls"]);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.model !== price.model || !Array.isArray(value.messages) || !value.messages.length) throw Error("Unsupported or mismatched chat request");
  let callCount = 0;
  for (const message of value.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw Error("Invalid message");
    const m = message as Record<string, unknown>;
    if (!["system", "developer", "user", "assistant", "tool"].includes(String(m.role)) ||
        (m.content !== null && m.content !== undefined && typeof m.content !== "string") ||
        Object.keys(m).some(key => !["role", "content", "tool_calls", "tool_call_id", "name"].includes(key))) throw Error("Only audited text/tool messages are supported");
    if ((m.name !== undefined && typeof m.name !== "string") || (m.tool_call_id !== undefined && typeof m.tool_call_id !== "string")) throw Error("Invalid message metadata");
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || m.tool_calls.some(c => !object(c) || !keys(c, ["id", "type", "function"]) || typeof c.id !== "string" || c.type !== "function" ||
          !object(c.function) || !keys(c.function, ["name", "arguments"]) || typeof c.function.name !== "string" || typeof c.function.arguments !== "string")) throw Error("Unsupported tool call shape");
      callCount += m.tool_calls.length;
    }
  }
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some(t => !object(t) || !keys(t, ["type", "function"]) || t.type !== "function" ||
      !object(t.function) || !keys(t.function, ["name", "description", "parameters", "strict"]) || typeof t.function.name !== "string" ||
      (t.function.description !== undefined && typeof t.function.description !== "string") ||
      (t.function.parameters !== undefined && !object(t.function.parameters)) ||
      (t.function.strict !== undefined && typeof t.function.strict !== "boolean")))) throw Error("Only audited function tools are supported");
  if (value.tool_choice !== undefined && !["auto", "none", "required"].includes(String(value.tool_choice)) &&
      !(object(value.tool_choice) && keys(value.tool_choice, ["type", "function"]) && value.tool_choice.type === "function" &&
        object(value.tool_choice.function) && keys(value.tool_choice.function, ["name"]) && typeof value.tool_choice.function.name === "string")) throw Error("Unsupported tool choice");
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") throw Error("Invalid parallel tool option");
  for (const field of ["temperature", "top_p"]) if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) throw Error("Invalid sampling option");
  if (value.stream_options !== undefined && (!value.stream_options || typeof value.stream_options !== "object" || Array.isArray(value.stream_options) ||
      Object.keys(value.stream_options).some(k => k !== "include_usage") || typeof (value.stream_options as Record<string, unknown>).include_usage !== "boolean")) throw Error("Unknown streaming feature");
  if (value.stream !== undefined && typeof value.stream !== "boolean") throw Error("Invalid streaming option");
  const requested = value.max_completion_tokens ?? value.max_tokens ?? price.maxOutputTokens;
  if (!Number.isSafeInteger(requested) || Number(requested) <= 0) throw Error("Invalid output limit");
  const result: Record<string, unknown> = { ...value, max_tokens: Math.min(Number(requested), price.maxOutputTokens) };
  delete result.max_completion_tokens;
  const accounting = price.inputAccounting;
  // The reviewed contract covers UTF-8 tokenization plus ALL hidden template/input
  // overhead. JSON bytes deliberately overcount visible fields; not an exact
  // tokenizer. Reject providers where such an upper bound cannot be established.
  const bound = BigInt(Buffer.byteLength(JSON.stringify(result), "utf8")) * BigInt(accounting.tokensPerUtf8ByteUpperBound) +
    BigInt(accounting.fixedOverheadTokens) + BigInt(value.messages.length) * BigInt(accounting.perMessageOverheadTokens) +
    BigInt((Array.isArray(value.tools) ? value.tools.length : 0) + callCount) * BigInt(accounting.perToolOverheadTokens);
  if (bound > BigInt(price.maxBillableInputTokens) || bound + BigInt(price.maxOutputTokens) > BigInt(accounting.modelContextTokens)) throw Error("Request exceeds reviewed input token upper bound");
  return result;
}
export async function startBudgetAuthority(options: {
  store: BudgetStore; adminToken: string; routes: BudgetRoute[]; port?: number;
  timeoutMs?: number; request?: typeof fetch;
}) {
  if (options.adminToken.length < 32) throw Error("Authority administration requires a strong separate token");
  for (const route of options.routes) {
    reservationCost(route.price);
    const url = new URL(route.price.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !route.apiKey) throw Error("Invalid reviewed provider route");
  }
  if (new Set(options.routes.map(r => r.price.provider + "/" + r.price.model)).size !== options.routes.length) throw Error("Duplicate route");
  const controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const fail = (status: number, message: string) => { if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message, type: "budget_authority" } })); };
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (req.method !== "POST" || !["/sessions", "/v1/chat/completions"].includes(req.url ?? "")) { fail(404, "Unsupported authority route"); return; }
    if (req.url === "/sessions" && !equal(token, options.adminToken)) { fail(403, "Administration denied"); return; }
    let input: Record<string, unknown>;
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) throw Error("Request exceeds audited size limit"); chunks.push(chunk); }
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid request");
    } catch { fail(400, "Malformed or oversized authority request"); return; }
    if (req.url === "/sessions") {
      try {
        const route = options.routes.find(r => r.price.provider === input.provider && r.price.model === input.model);
        if (!route || !TARGET_CLIS.some(c => c.id === input.cli)) throw Error("Unreviewed CLI/provider/model selection");
        reservationCost(route.price);
        const scoped = await options.store.createSession({ cli: String(input.cli), provider: route.price.provider, model: route.price.model,
          revision: route.price.revision, phase: input.phase as "initial" | "maintenance", expires: Date.now() + 900000,
          maxRequests: Number(input.maxRequests), maxMicroUsd: Number(input.maxMicroUsd) });
        res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ token: scoped, pricingRevision: route.price.revision, reservationMicroUsd: reservationCost(route.price) }));
      } catch { fail(403, "Run authorization denied; review selection, pricing and persistent budget authority"); }
      return;
    }
    const route = options.routes.find(r => r.price.provider === req.headers["x-cledger-provider"] && r.price.model === input.model);
    if (!route) { fail(403, "Unreviewed provider/model"); return; }
    let body: Record<string, unknown>;
    try { body = boundedChat(input, route.price); await options.store.reserve(token, route.price); }
    catch { fail(429, "Authorization, pricing or budget rejected; request not forwarded"); return; }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? 180000, 180000));
    try {
      const upstream = await (options.request ?? fetch)(route.price.endpoint, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` }, body: JSON.stringify(body) });
      if (!upstream.ok) { await upstream.body?.cancel(); fail(502, "Provider rejected request; full reservation retained"); return; }
      res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      let bytes = 0;
      if (upstream.body) for await (const chunk of upstream.body) { bytes += chunk.length; if (bytes > 4000000) throw Error("Output exceeded limit"); res.write(chunk); }
      res.end();
    } catch { if (res.headersSent) res.destroy(); else fail(502, "Provider unavailable; full reservation retained"); }
    finally { clearTimeout(timer); controllers.delete(controller); }
  });
  server.requestTimeout = 200000;
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(options.port ?? 0, "127.0.0.1", yes); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("Authority bind failed");
  return { endpoint: `http://127.0.0.1:${address.port}`, async close() { for (const c of controllers) c.abort(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "init" && process.argv[3]) {
    await new BudgetStore(process.argv[3]).initialize();
    process.stderr.write("Created new persistent allocation. Never reinitialize or relocate it to reset spending.\n");
  } else {
  if (!process.env.CLEDGER_BUDGET_CONFIG || !process.env.CLEDGER_BUDGET_STATE || !process.env.CLEDGER_BUDGET_ADMIN_TOKEN) throw Error("Explicit reviewed config, persistent state path and admin token required");
  const config = JSON.parse(await readFile(process.env.CLEDGER_BUDGET_CONFIG, "utf8")) as { routes: { price: ReviewedPrice; apiKeyEnv: string }[] };
  await startBudgetAuthority({ store: new BudgetStore(process.env.CLEDGER_BUDGET_STATE), adminToken: process.env.CLEDGER_BUDGET_ADMIN_TOKEN,
    routes: config.routes.map(r => ({ price: r.price, apiKey: process.env[r.apiKeyEnv] ?? "" })), port: Number(process.env.CLEDGER_BUDGET_PORT ?? "8787") });
  process.stderr.write("Budget authority bound to loopback; persistent state and reviewed prices required. Provider credentials remain here.\n");
  }
}
