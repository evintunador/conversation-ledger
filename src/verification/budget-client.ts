/** Runner-side relay: scoped authorization only, never provider/admin keys. */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOpencode } from "./opencode.js";
import { verifyOpencodeCanary, verifyPiCanary } from "./canary.js";
interface SessionFile { authority: string; cli: string; provider: string; model: string; token: string; pricingRevision: string; campaign?: "issue27"; purpose?: "canary" }
function authorityUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw Error("External persistent authority must have an explicit HTTPS origin");
  return u.origin;
}
export async function authorizeLiveRun(options: { authority: string; adminToken: string; cli: string; provider: string; model: string; phase: string; maxMicroUsd: number; output: string; canary?: boolean }) {
  // Register only consumers with an installed canary driver.
  if (options.cli !== "opencode" && !(options.canary && options.cli === "pi")) throw Error("Live automation unavailable for this CLI; unverified, no authorization issued");
  const authority = authorityUrl(options.authority);
  const response = await fetch(authority + "/sessions", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${options.adminToken}` },
    body: JSON.stringify({ cli: options.cli, provider: options.provider, model: options.model, phase: options.phase, maxRequests: options.canary ? 8 : 4, maxMicroUsd: options.maxMicroUsd, ...(options.canary ? { campaign: "issue27" } : {}) }) });
  if (!response.ok) throw Error("Persistent authority denied live run; no CLI launched");
  const grant = await response.json() as { token: string; pricingRevision: string; campaign?: "issue27" };
  if (typeof grant.token !== "string" || typeof grant.pricingRevision !== "string" || options.canary && grant.campaign !== "issue27") throw Error("Invalid authority grant");
  await writeFile(options.output, JSON.stringify({ authority, cli: options.cli, provider: options.provider, model: options.model, ...grant, ...(options.canary ? { purpose: "canary" } : {}) }), { flag: "wx", mode: 0o600 });
}
async function runSession(file: string, output: string, binary: string, canaryMode?: "headless" | "interactive") {
  const session = JSON.parse(await readFile(file, "utf8")) as SessionFile;
  if (session.cli !== "opencode" && !(canaryMode && session.cli === "pi")) throw Error("No registered live consumer; CLI remains unverified");
  if (canaryMode && (session.campaign !== "issue27" || session.purpose !== "canary")) throw Error("Canary requires an issue27 campaign-scoped authorization");
  const authority = authorityUrl(session.authority);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(400); res.end(); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 262144) throw Error("Request too large"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model !== session.model) throw Error("Model mismatch");
      const upstream = await fetch(authority + "/v1/chat/completions", { method: "POST", redirect: "error", signal: AbortSignal.timeout(185000),
        headers: { "content-type": "application/json", authorization: `Bearer ${session.token}`, "x-cledger-provider": session.provider }, body: JSON.stringify(body) });
      if (!upstream.ok) { await upstream.body?.cancel(); res.writeHead(503); res.end(JSON.stringify({ error: { message: "Budget authority blocked request; no fallback" } })); return; }
      res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch { if (res.headersSent) res.destroy(); else { res.writeHead(503); res.end(); } }
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  try {
    const address = server.address(); if (!address || typeof address === "string") throw Error("Relay unavailable");
    const options = { binary, endpoint: `http://127.0.0.1:${address.port}/v1`, model: session.model, interactive: !canaryMode || canaryMode === "interactive", timeoutMs: 600000 };
    const verifyCanary = session.cli === "pi" ? verifyPiCanary : verifyOpencodeCanary;
    const report = canaryMode ? await verifyCanary({ ...options, inference: "usual-provider", provider: session.provider }) : await verifyOpencode(options);
    const evidence = { ...report, ...(!canaryMode ? { inference: "budget-authority-live" } : {}), budget: { provider: session.provider, pricingRevision: session.pricingRevision, ...(canaryMode ? { campaign: "issue27", ceilingUsd: 20 } : {}),
      accounting: "Durable worst-case reservations retained at external authority; report is not the spending ledger" } };
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
    process.exitCode = report.status === "pass" ? 0 : report.status === "blocked" ? 2 : 1;
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (["authorize", "authorize-canary"].includes(process.argv[2]!)) {
    const { CLEDGER_BUDGET_AUTHORITY: authority, CLEDGER_BUDGET_ADMIN_TOKEN: adminToken, CLEDGER_LIVE_CLI: cli,
      CLEDGER_LIVE_PROVIDER: provider, CLEDGER_LIVE_MODEL: model, CLEDGER_LIVE_PHASE: phase, CLEDGER_LIVE_SESSION: output } = process.env;
    if (!authority || !adminToken || !cli || !provider || !model || !phase || !output) throw Error("Explicit approved selection and authority configuration required");
    await authorizeLiveRun({ authority, adminToken, cli, provider, model, phase, output, maxMicroUsd: Number(process.env.CLEDGER_LIVE_MAX_MICRO_USD), canary: process.argv[2] === "authorize-canary" });
  } else if (process.argv[2] === "run" && process.argv.length === 6) await runSession(process.argv[3]!, process.argv[4]!, process.argv[5]!);
  else if (process.argv[2] === "run-canary" && process.argv.length === 7 && ["headless", "interactive"].includes(process.argv[6]!)) await runSession(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6] as "headless" | "interactive");
  else throw Error("Usage: budget-client authorize | authorize-canary | run SESSION OUTPUT OPENCODE_BINARY | run-canary SESSION OUTPUT OPENCODE_OR_PI_BINARY headless|interactive");
}
