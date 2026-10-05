import { createServer } from "node:http";

export interface GuardState {
  forwarded: number;
  blocked?: string;
}

/** No redirects, no retry after any upstream failure, bounded requests and bodies. */
export async function startGuard(endpoint: string, maxRequests = 4, timeoutMs = 60_000, apiKey = "TESTONLY-local-verification", limits: { maxOutputTokens?: number } = {}): Promise<{
  endpoint: string; state: GuardState; signal: AbortSignal; close(): Promise<void>;
}> {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 8 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new Error("Verification request count and timeout must be bounded positive integers");
  const target = new URL(endpoint.replace(/\/$/, "") + "/chat/completions");
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password || target.search || target.hash) {
    throw new Error("Forwarding target must be an HTTP loopback endpoint");
  }
  const state: GuardState = { forwarded: 0 };
  if (limits.maxOutputTokens !== undefined && (!Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens <= 0))
    throw new Error("Output token limit must be a positive integer");
  const stopped = new AbortController();
  const controllers = new Set<AbortController>();
  const block = (reason: string) => { state.blocked ??= reason; stopped.abort(); for (const controller of controllers) controller.abort(); return state.blocked; };
  let tail = Promise.resolve();
  let queued = 0;
  const server = createServer(async (req, res) => {
    let release: (() => void) | undefined;
    const reject = (status: number, reason: string) => {
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: reason, type: "verification_guard" } }));
    };
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { reject(400, "Unsupported fixture endpoint"); return; }
    if (state.blocked) { reject(503, state.blocked); return; }
    let body = "";
    try {
      const chunks: Buffer[] = [];
      let requestBytes = 0;
      for await (const chunk of req) {
        requestBytes += chunk.length;
        if (requestBytes > 2_000_000) { reject(413, "Request exceeds verification limit"); return; }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString("utf8");
      if (limits.maxOutputTokens !== undefined) {
        const data: unknown = JSON.parse(body);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid-request");
        const payload = data as Record<string, unknown>;
        const field = "max_completion_tokens" in payload ? "max_completion_tokens" : "max_tokens";
        const requested = payload[field];
        payload[field] = typeof requested === "number" && Number.isFinite(requested) && requested > 0
          ? Math.min(requested, limits.maxOutputTokens) : limits.maxOutputTokens;
        if (field === "max_completion_tokens") delete payload.max_tokens;
        body = JSON.stringify(payload);
      }
      // Serialize overlapping title and main-turn requests to limit local load.
      if (state.blocked) { reject(503, state.blocked); return; }
      if (queued >= maxRequests) { reject(429, block("Verification request queue capacity exhausted")); return; }
      queued++;
      const previous = tail;
      tail = new Promise<void>(resolve => { release = resolve; });
      let queueTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([previous, new Promise<never>((_, rejectWait) => {
          queueTimer = setTimeout(() => rejectWait(new Error("queue-deadline")), timeoutMs);
        })]);
      } catch {
        reject(503, block("Queued request timed out; forwarding stopped (no retry)")); return;
      } finally { queued--; clearTimeout(queueTimer); }
      // Re-check after asynchronous body reading, before claiming a forwarding slot.
      if (state.blocked || state.forwarded >= maxRequests) {
        reject(429, block("Upstream request budget exhausted")); return;
      }
      state.forwarded++;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const upstream = await fetch(target, {
          method: "POST", redirect: "manual", signal: controller.signal, body,
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "X-Cledger-Verification": "1" },
        });
        if (!upstream.ok) {
          block(`Upstream HTTP ${upstream.status}; forwarding stopped (no retry)`);
          await upstream.body?.cancel(); reject(503, state.blocked!); return;
        }
        res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream" });
        let bytes = 0;
        const sse = upstream.headers.get("content-type")?.includes("text/event-stream");
        let streamTail = "";
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            bytes += chunk.byteLength;
            if (bytes > 4_000_000) throw new Error("response-limit");
            res.write(chunk);
            if (sse) {
              streamTail = (streamTail + Buffer.from(chunk).toString("utf8")).slice(-4096);
              // OpenAI's terminal SSE event completes inference even when a
              // provider keeps the HTTP response open. Breaking the iterator
              // cancels its remaining body and releases the serial slot.
              if (/(?:^|\r?\n)data:[ \t]*\[DONE\][ \t]*\r?\n\r?\n/.test(streamTail)) break;
            }
          }
        }
        res.end();
      } catch {
        block("Upstream unreachable, timed out, or interrupted; forwarding stopped (no retry)");
        reject(503, state.blocked!);
      } finally { clearTimeout(timer); controllers.delete(controller); }
    } catch { reject(400, "Malformed verification request"); }
    finally { release?.(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Guard endpoint unavailable");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`, state, signal: stopped.signal,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
