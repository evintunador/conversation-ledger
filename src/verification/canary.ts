/** Real-model canaries are smaller than the eight-case scripted scenarios. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOpencode, type Options } from "./opencode.js";
import { verifyConfiguredPi, type PiVerificationOptions } from "./pi.js";

export interface CanaryReport {
  schema: "cledger-canary/1";
  cli: "opencode" | "pi";
  version?: string;
  platform: string;
  mode: "headless" | "interactive";
  inference: "local" | "usual-provider" | "scripted";
  provider: string;
  model: string;
  status: "pass" | "fail" | "blocked" | "not-run";
  gates: Record<string, boolean>;
  requests: number;
  started: string;
  completed: string;
  reason?: string;
}

export async function verifyPiCanary(options: PiVerificationOptions & {
  endpoint?: string; apiKey?: string; inference: CanaryReport["inference"]; provider: string; model: string;
}): Promise<CanaryReport> {
  const started = new Date().toISOString();
  const native = options.endpoint && options.model ? await verifyConfiguredPi({ ...options, endpoint: options.endpoint, resume: true }) : undefined;
  const gates = {
    prompt: native?.gates.hookPrompt === true,
    linkedReadResult: native?.gates.hookToolUse === true && native?.gates.hookToolResult === true,
    answer: native?.gates.hookAnswer === true,
    normalExit: native?.gates.normalExit === true && native?.gates.resumeNormalExit === true,
    resume: native?.gates.resume === true,
    backfillTwice: native?.gates.backfillIdempotent === true,
    automaticBeforeBackfill: native?.gates.automaticBeforeBackfill === true,
    noUnrecognized: native?.gates.noUnrecognizedRecords === true,
  };
  return { schema: "cledger-canary/1", cli: "pi", ...(native?.version ? { version: native.version } : {}),
    platform: native?.platform ?? `${process.platform}/${process.arch}`, mode: options.interactive ? "interactive" : "headless",
    inference: options.inference, provider: options.provider, model: options.model,
    status: native?.status === "pass" && !Object.values(gates).every(Boolean) ? "fail" : native?.status ?? "not-run",
    gates, requests: native?.requests ?? 0, started, completed: new Date().toISOString(),
    ...(native?.reason ? { reason: native.reason } : !native ? { reason: "Explicit endpoint and model are required" } : {}) };
}

/** The caller owns the local model readiness or durable paid-budget authority. */
export async function verifyOpencodeCanary(options: Options & { inference: CanaryReport["inference"]; provider: string; model: string }): Promise<CanaryReport> {
  const started = new Date().toISOString();
  const native = await verifyOpencode({ ...options, resume: true });
  const gates = {
    prompt: native.gates.hookPrompt === true,
    linkedReadResult: native.gates.hookToolUse === true && native.gates.hookToolResult === true,
    answer: native.gates.hookAnswer === true,
    normalExit: native.gates.normalExit === true && native.gates.resumeNormalExit === true,
    resume: native.gates.resume === true,
    backfillTwice: native.gates.backfillIdempotent === true && native.gates.hookEvidenceRetained === true,
    automaticBeforeBackfill: native.gates.automaticBeforeBackfill === true,
    noUnrecognized: native.gates.noUnrecognizedRecords === true,
  };
  return { schema: "cledger-canary/1", cli: "opencode", ...(native.version ? { version: native.version } : {}), platform: native.platform,
    mode: options.interactive ? "interactive" : "headless", inference: options.inference, provider: options.provider, model: options.model,
    status: native.status === "pass" && !Object.values(gates).every(Boolean) ? "fail" : native.status,
    gates, requests: native.requests ?? 0, started, completed: new Date().toISOString(), ...(native.reason ? { reason: native.reason } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Paid calls run through budget-client, which retains worst-case reservations.
  if (![3, 4].includes(process.argv.length) || process.argv[2] !== "--local" || process.argv[3] && !["opencode", "pi"].includes(process.argv[3])) throw Error("Usage: canary.js --local [opencode|pi]; paid canaries use budget-client");
  const model = process.env.CLEDGER_VERIFY_MODEL;
  if (!model || !process.env.CLEDGER_VERIFY_ENDPOINT) throw Error("Explicit local endpoint/model required; run only when local cooling and power are ready");
  const verify = process.argv[3] === "pi" ? verifyPiCanary : verifyOpencodeCanary;
  const report = await verify({ inference: "local", provider: "ds4", model,
    endpoint: process.env.CLEDGER_VERIFY_ENDPOINT, ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}),
    interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "pass" ? 0 : report.status === "blocked" ? 2 : 1;
}
