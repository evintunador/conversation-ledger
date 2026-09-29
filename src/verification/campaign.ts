/** Portable campaign entrypoint. Scheduling is separate from execution. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_NPM_RUNTIMES, runtimeBinary } from "./runtimes.js";
import { TARGET_CLIS } from "./roster.js";
import { verifyScriptedOpencode } from "./opencode.js";
import { verifyScriptedCline } from "./cline.js";
import { verifyScriptedCrush } from "./crush.js";
import { verifyScriptedOpenInterpreter } from "./open-interpreter.js";
import { verifyScriptedOpenHands } from "./openhands.js";
import { verifyScriptedContinue } from "./continue.js";
import { verifyScriptedKilo } from "./kilo.js";
import { verifyScriptedAider } from "./aider.js";
import { verifyScriptedDroid } from "./droid.js";
import { verifyScriptedGoose } from "./goose.js";
import { verifyScriptedPi } from "./pi.js";
import { verifyScriptedQwen } from "./qwen-code.js";
import { verifyScriptedClaudeCode } from "./claude-code.js";
import { verifyScriptedCodex } from "./codex.js";
import { verifyScriptedGemini } from "./gemini-cli.js";
import { verifyScriptedCopilot } from "./copilot.js";
import { verifyScriptedKimi } from "./kimi.js";
import { verifyScriptedMistralVibe } from "./mistral-vibe.js";
import { INSTALLABLE_ADAPTERS } from "../install.js";

export interface ReleaseObservation {
  status: "observed" | "unavailable" | "not-configured";
  tag?: string;
  url?: string;
  reason?: string;
}

export async function latestRelease(repository: string | undefined, request: typeof fetch = fetch): Promise<ReleaseObservation> {
  if (!repository) return { status: "not-configured", reason: "No verified public release feed" };
  try {
    const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "conversation-ledger-verification" },
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) return { status: "unavailable", reason: `GitHub HTTP ${response.status}` };
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.tag_name !== "string" || typeof data.html_url !== "string" || data.draft || data.prerelease) {
      return { status: "unavailable", reason: "No stable release in response" };
    }
    return { status: "observed", tag: data.tag_name, url: data.html_url };
  } catch {
    return { status: "unavailable", reason: "Release request failed or timed out" };
  }
}

/** Report smoke evidence separately from the full integration completion gate. */
export function coverageSummary(reports: { cli: string; status: string }[]) {
  return {
    target: TARGET_CLIS.length,
    nativeSmokePassed: new Set(reports.filter(r => r.status === "pass").map(r => r.cli)).size,
    fullyCertified: 0,
    fullyCertifiedPercent: 0,
    reason: "No CLI yet has recorded passes for every record type and both headless/interactive modes on macOS and Linux",
  };
}

export type VerificationMode = "headless" | "interactive";
export const INTERACTIVE_DRIVERS = new Set(["claude-code", "codex", "gemini-cli", "opencode", "qwen-code", "pi", "copilot", "aider", "cline", "continue", "crush", "kimi", "kilo", "droid", "goose", "openhands", "mistral-vibe", "open-interpreter"]);
// Keep implemented drivers separate from checks the maintainer has deferred.
// This also applies to explicit selections and generated scheduled campaigns.
export const DEFERRED_INTERACTIVE: Readonly<Record<string, string>> = {
  cline: "Deferred: interactive welcome screen opened the browser; direct-API headless verification remains enabled",
  droid: "Deferred by maintainer: interactive Factory account authentication; public BYOK headless verification remains enabled",
};

export async function runCampaign(upstream = false, runtimeDirectory?: string, selected?: string[], ignoreBinaryOverrides = false, mode: VerificationMode = "headless") {
  const unknown = selected?.filter(id => !TARGET_CLIS.some(cli => cli.id === id)) ?? [];
  if (unknown.length) throw new Error(`Unknown CLI IDs: ${unknown.join(", ")}`);
  const started = new Date().toISOString();
  const observations: Record<string, ReleaseObservation> = {};
  // Sequential requests avoid bursts against anonymous GitHub rate limits.
  if (upstream) for (const cli of TARGET_CLIS) observations[cli.id] = await latestRelease(cli.repository);
  const safely = async <T>(cli: string, action: () => Promise<T>) => {
    try { return await action(); }
    catch {
      return { cli, status: "blocked", certification: "none", reason: "Native verification could not initialize; check local executable and loopback permissions" };
    }
  };
  const drivers = [
    ["claude-code", verifyScriptedClaudeCode], ["codex", verifyScriptedCodex],
    ["gemini-cli", verifyScriptedGemini], ["opencode", verifyScriptedOpencode],
    ["qwen-code", verifyScriptedQwen], ["pi", verifyScriptedPi],
    ["mistral-vibe", verifyScriptedMistralVibe], ["copilot", verifyScriptedCopilot],
    ["kimi", verifyScriptedKimi], ["goose", verifyScriptedGoose], ["droid", verifyScriptedDroid], ["aider", verifyScriptedAider], ["continue", verifyScriptedContinue], ["kilo", verifyScriptedKilo], ["cline", verifyScriptedCline], ["openhands", verifyScriptedOpenHands], ["crush", verifyScriptedCrush], ["open-interpreter", verifyScriptedOpenInterpreter],
  ] as const;
  const nativeReports: { cli: string; status: string }[] = [];
  for (const [cli, driver] of drivers) {
    if (selected && !selected.includes(cli)) continue;
    if (mode === "interactive" && DEFERRED_INTERACTIVE[cli]) continue;
    if (mode === "interactive" && !INTERACTIVE_DRIVERS.has(cli)) continue;
    const recipe = PINNED_NPM_RUNTIMES.find(r => r.cli === cli);
    const binary = (ignoreBinaryOverrides ? undefined : process.env[`CLEDGER_VERIFY_${cli.replaceAll("-", "_").toUpperCase()}_BINARY`]) ??
      (runtimeDirectory && recipe ? runtimeBinary(runtimeDirectory, recipe.cli, recipe.binary) : undefined);
    process.stderr.write(`Verifying ${cli} (${mode})...\n`);
    const report = await safely<{ cli: string; status: string }>(cli, () => driver({ ...(binary ? { binary } : {}), ...(mode === "interactive" ? { interactive: true } : {}) }));
    nativeReports.push(report);
    process.stderr.write(`${cli} (${mode}): ${report.status}\n`);
  }
  return {
    schema: "cledger-campaign/1", started, completed: new Date().toISOString(),
    platform: process.platform, arch: process.arch, mode,
    inferenceCostUsd: 0, inference: "scripted", paidInferenceEnabled: false,
    coverage: coverageSummary(nativeReports),
    targets: TARGET_CLIS.map(cli => ({
      ...cli,
      captureImplemented: cli.id in INSTALLABLE_ADAPTERS,
      ...(cli.id in INSTALLABLE_ADAPTERS ? { captureMode: ["aider", "continue", "crush"].includes(cli.id) ? "explicit-launch-wrapper" : "native-hook-or-plugin" } : {}),
      verification: nativeReports.find(report => report.cli === cli.id) ?? {
        status: "not-run", reason: selected && !selected.includes(cli.id) ? "Excluded by requested CLI selection" : mode === "interactive" ? DEFERRED_INTERACTIVE[cli.id] ?? "Interactive scenario driver not implemented" : "Native scenario driver not implemented", certification: "none",
      },
      ...(upstream ? { upstream: observations[cli.id] } : {}),
    })),
  };
}

export const INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
export function isDue(lastAttempt: string | undefined, now = Date.now()): boolean {
  const previous = lastAttempt ? Date.parse(lastAttempt) : NaN;
  return !Number.isFinite(previous) || now - previous >= INTERVAL_MS;
}

export function releaseChanges(previous: Record<string, string>, observations: Record<string, ReleaseObservation>) {
  const tags = { ...previous };
  const changed: { cli: string; previous: string; current: string }[] = [];
  for (const [cli, observation] of Object.entries(observations)) {
    if (observation.status !== "observed" || !observation.tag) continue;
    if (previous[cli] && previous[cli] !== observation.tag) changed.push({ cli, previous: previous[cli]!, current: observation.tag });
    tags[cli] = observation.tag;
  }
  return { tags, changed };
}

/**
 * Call daily from any scheduler; persisted attempts enforce the 14-day cadence.
 * A failure gets a report, not an automatic retry/inference storm. Manual runs
 * without --state-dir remain available immediately for maintenance.
 */
export async function scheduledCampaign(stateDir: string, upstream: boolean, runtimeDirectory?: string, selected?: string[], verifyUpdates = false, mode: VerificationMode = "headless") {
  const invalid = selected?.filter(id => !TARGET_CLIS.some(cli => cli.id === id)) ?? [];
  if (invalid.length) throw new Error(`Unknown CLI IDs: ${invalid.join(", ")}`);
  await mkdir(stateDir, { recursive: true });
  const lock = join(stateDir, "running.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "blocked", reason: "Campaign lock exists; inspect before removing a stale lock" };
    throw error;
  }
  try {
    const stateFile = join(stateDir, mode === "headless" ? "state.json" : "interactive-state.json");
    let lastAttempt: string | undefined;
    let releaseTags: Record<string, string> = {};
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as { lastAttempt?: string; releaseTags?: Record<string, string> };
      if (typeof state.lastAttempt !== "string" || !Number.isFinite(Date.parse(state.lastAttempt)) ||
        (state.releaseTags !== undefined && (!state.releaseTags || typeof state.releaseTags !== "object" ||
          Object.values(state.releaseTags).some(tag => typeof tag !== "string")))) throw new Error("Invalid state");
      lastAttempt = state.lastAttempt;
      releaseTags = state.releaseTags ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Campaign state unreadable; refusing to reset schedule silently");
    }
    if (!isDue(lastAttempt)) return { status: "not-due", lastAttempt };
    const stamp = new Date().toISOString();
    await writeFile(`${stateFile}.tmp`, JSON.stringify({ lastAttempt: stamp, releaseTags }) + "\n", { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
    const campaign = await runCampaign(upstream, runtimeDirectory, selected, false, mode);
    const changes = releaseChanges(releaseTags, Object.fromEntries(campaign.targets
      .filter(target => target.upstream).map(target => [target.id, target.upstream!])));
    let maintenance: { reviewRequired: boolean; [key: string]: unknown } | undefined;
    if (verifyUpdates) {
      try {
        const { prepareMaintenance } = await import("./maintenance.js");
        maintenance = await prepareMaintenance(join(stateDir, `${stamp.replace(/[:.]/g, "-")}-maintenance`), true);
      } catch (error) {
        maintenance = { reviewRequired: true, status: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
    }
    const report = { ...campaign, upstreamChanges: changes.changed, ...(maintenance ? { maintenance } : {}),
      reviewRequired: !!maintenance?.reviewRequired || changes.changed.length > 0 || campaign.targets.some(t => (t.verification.status === "fail" || t.verification.status === "blocked")) };
    const reportFile = join(stateDir, `${stamp.replace(/[:.]/g, "-")}.json`);
    await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify({ lastAttempt: stamp, releaseTags: changes.tags, reportFile }) + "\n", { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
    return report;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

/** Proposals need review, while unsuccessful verification needs a failing
 * scheduler status. A baseline pass cannot conceal a failed update candidate. */
export function campaignExitCode(result: unknown): number {
  if (!result || typeof result !== "object") return 1;
  const report = result as Record<string, unknown>;
  if (report.status === "blocked") return 2;
  if (report.status === "failed" || report.status === "fail") return 1;
  if (Array.isArray(report.targets) && report.targets.some(target => target && typeof target === "object" &&
    ["fail", "blocked"].includes(String((target as { verification?: { status?: unknown } }).verification?.status)))) return 1;
  if (Array.isArray(report.observations) && report.observations.some(item => item?.status === "unavailable")) return 1;
  if (report.maintenance && campaignExitCode(report.maintenance) !== 0) return 1;
  if (report.campaign && campaignExitCode(report.campaign) !== 0) return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = new Set(["--state-dir", "--output", "--runtime-dir", "--only", "--mode"]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (values.has(argument)) {
      if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${argument} requires a value`);
      index++;
    } else if (!["--upstream", "--verify-updates"].includes(argument)) throw new Error(`Unknown campaign argument: ${argument}`);
  }
  if (args.includes("--verify-updates") && !args.includes("--state-dir")) throw new Error("--verify-updates requires --state-dir; for an immediate update review use maintenance.js");
  const modeIndex = args.indexOf("--mode");
  const mode = modeIndex < 0 ? "headless" : args[modeIndex + 1];
  if (mode !== "headless" && mode !== "interactive") throw new Error("--mode must be headless or interactive");
  if (mode === "interactive" && args.includes("--verify-updates")) throw new Error("--verify-updates is currently a headless candidate check; run interactive verification separately");
  const stateIndex = args.indexOf("--state-dir");
  const outputIndex = args.indexOf("--output");
  const runtimeIndex = args.indexOf("--runtime-dir");
  const runtimeDirectory = runtimeIndex >= 0 ? args[runtimeIndex + 1] : undefined;
  const onlyIndex = args.indexOf("--only");
  const selected = onlyIndex >= 0 ? args[onlyIndex + 1]?.split(",").filter(Boolean) : undefined;
  if (onlyIndex >= 0 && (!selected?.length || selected.some(id => id.startsWith("--")))) throw new Error("--only requires comma-separated CLI IDs");
  if (runtimeIndex >= 0 && (!runtimeDirectory || runtimeDirectory.startsWith("--"))) throw new Error("--runtime-dir requires a path");
  if ((stateIndex >= 0 && !args[stateIndex + 1]) || (outputIndex >= 0 && !args[outputIndex + 1])) {
    throw new Error("--state-dir and --output require paths");
  }
  const result = stateIndex >= 0
    ? await scheduledCampaign(resolve(args[stateIndex + 1]!), args.includes("--upstream"), runtimeDirectory, selected, args.includes("--verify-updates"), mode)
    : await runCampaign(args.includes("--upstream"), runtimeDirectory, selected, false, mode);
  const json = JSON.stringify(result, null, 2) + "\n";
  if (outputIndex >= 0) {
    const path = resolve(args[outputIndex + 1]!);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, { mode: 0o600 });
  }
  process.stdout.write(json);
  process.exitCode = campaignExitCode(result);
}
