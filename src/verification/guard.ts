import { createServer } from "node:http";

export interface GuardState {
  forwarded: number;
  blocked?: string;
}

/** No redirects, no retry after any upstream failure, bounded requests and bodies. */
export async function startGuard(endpoint: string, maxRequests = 4, timeoutMs = 60_000, apiKey = "TESTONLY-local-verification"): Promise<{
  endpoint: string; state: GuardState; signal: AbortSignal; close(): Promise<void>;
}> {
  const target = new URL(endpoint.replace(/\/$/, "") + "/chat/completions");
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password || target.search || target.hash) {
    throw new Error("Forwarding target must be an HTTP loopback endpoint");
  }
  const state: GuardState = { forwarded: 0 };
  const stopped = new AbortController();
  const block = (reason: string) => { state.blocked ??= reason; stopped.abort(); return state.blocked; };
  const controllers = new Set<AbortController>();
  let tail = Promise.resolve();
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
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2_000_000) { reject(413, "Request exceeds verification limit"); return; }
      }
      // Serialize overlapping title and main-turn requests to limit local load.
      const previous = tail;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
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
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            bytes += chunk.byteLength;
            if (bytes > 4_000_000) throw new Error("response-limit");
            res.write(chunk);
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
