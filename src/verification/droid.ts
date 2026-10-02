import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { DROID_TAIL_DIRECTORY } from "../adapters/droid.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { startGuard } from "./guard.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startScriptedProvider } from "./scripted.js";

export interface DroidVerificationOptions { binary?: string; timeoutMs?: number; interactive?: boolean; factoryApiKey?: string }
export interface DroidVerificationReport {
  schema: "cledger-verification/1";
  cli: "droid";
  status: "pass" | "fail" | "blocked" | "not-run";
  certification: "native-smoke";
  inference: "scripted";
  platform: string;
  mode?: "interactive" | "headless";
  version?: string;
  reason?: string;
  reasonCode?: "login-required" | "cli-unavailable" | "unsupported-platform";
  gates: Record<string, boolean>;
  requests?: number;
  coverage: string[];
  exclusions: string[];
  durationMs: number;
}

export function droidLoginRequired(output: string): boolean {
  return /Please login with your Factory account to continue/.test(terminalTail(output));
}

/** The secret is never in the prompt: only a real tool result can supply it. */
export function droidEvidenceGates(events: EvidenceEvent[], marker: string, secret: string): Record<string, boolean> {
  const blocks = (event: EvidenceEvent): Record<string, unknown>[] => {
    const value = event.content as { blocks?: Record<string, unknown>[] };
    return Array.isArray(value?.blocks) ? value.blocks : [];
  };
  const own = events.filter((event) => event.producer.source === "droid");
  const prompt = own.find((event) => event.actor.type === "human" &&
    blocks(event).some((block) => block.type === "text" && String(block.text).includes(marker)));
  const session = prompt?.stream?.id;
  const turns = session ? own.filter((event) => event.stream?.id === session) : [];
  const call = turns.flatMap(blocks).find((block) => block.type === "tool_use" && block.name === "Read" &&
    typeof (block.input as { file_path?: unknown } | undefined)?.file_path === "string" && String((block.input as { file_path: string }).file_path).endsWith("/evidence.txt"));
  return {
    noUnrecognizedRecords: own.length > 0 && !hasUnrecognizedEvidence(events, "droid"),
    hookPrompt: !!prompt,
    hookToolUse: !!call && typeof call.id === "string",
    hookToolResult: !!call && turns.some((event) => event.actor.type === "system" && blocks(event).some((block) =>
      block.type === "tool_result" && block.tool_use_id === call.id && JSON.stringify(block.content).includes(secret))),
    hookAnswer: turns.some((event) => event.actor.type === "agent" && blocks(event).some((block) =>
      block.type === "text" && String(block.text).includes(secret))),
    nativeSessionState: turns.some((event) => event.kind === "session_state" &&
      (event.content as { state_type?: string }).state_type === "session_start"),
  };
}

/** Observe installed background capture; never repair it by importing data. */
async function awaitNativeTail(repo: string): Promise<boolean> {
  const directory = join(repo, ".git", DROID_TAIL_DIRECTORY), deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const names = await readdir(directory), statuses = names.filter(name => name.endsWith(".json"));
      if (statuses.length && !names.some(name => name.endsWith(".lock"))) {
        let complete = true;
        for (const name of statuses) {
          const status = JSON.parse(await readFile(join(directory, name), "utf8")) as { status: string; pid: number };
          if (status.status !== "complete") return false;
          try { process.kill(status.pid, 0); complete = false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") complete = false; }
        }
        if (complete) return true;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return false;
}

/**
 * Real Droid executable, real installed hooks, real git ledger, synthetic
 * loopback inference only. No authentication/subscription or gateway needed.
 * No manual import can repair the hook before the evidence gates pass.
 */
export async function verifyScriptedDroid(options: DroidVerificationOptions = {}): Promise<DroidVerificationReport> {
  const started = Date.now();
  const report: DroidVerificationReport = {
    schema: "cledger-verification/1", cli: "droid", status: "not-run", certification: "native-smoke",
    mode: options.interactive ? "interactive" : "headless", inference: "scripted", platform: `${process.platform}/${process.arch}`, gates: {},
    coverage: ["public BYOK startup (no enterprise overrides)", "installed native hooks", "headless CLI", "human prompt", "tool call/result linkage", "assistant answer", "session header", "backfill idempotency", "bounded tail worker exit"],
    exclusions: ["Factory account authentication", "real provider/model behavior", "interactive TUI", "attachments", "branching/forks", "compaction", "full record coverage", "ephemeral sessions"], durationMs: 0,
  };
  if (!["darwin", "linux"].includes(process.platform)) {
    report.status = "blocked"; report.reasonCode = "unsupported-platform"; report.reason = "Native Droid verification currently supports macOS and Linux";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-droid-native-"));
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    const repo = join(root, "repo"), bin = join(root, "bin"), agentDir = join(root, ".factory");
    await Promise.all([repo, bin, agentDir, join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })));
    const env: NodeJS.ProcessEnv = {
      ...isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      FACTORY_HOME_OVERRIDE: root, FACTORY_DISABLE_KEYRING: "1", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    };
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const binary = options.binary ? resolve(options.binary) : "droid";
    // A dedicated opt-in test key is allowed; never borrow FACTORY_API_KEY or
    // credentials from the user's ordinary profile. The key is never reported.
    const factoryApiKey = options.factoryApiKey ?? process.env.CLEDGER_VERIFY_DROID_FACTORY_API_KEY;
    const nativeAuth = factoryApiKey ? { FACTORY_API_KEY: factoryApiKey } : {};
    // The extension discovers cledger through PATH, just as in an installed
    // user's environment; it invokes the built CLI, never parser functions.
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    const run = (command: string, args: string[], timeoutMs = 20_000) => runProcess(command, args, {
      cwd: repo, env: command === binary ? { ...env, ...nativeAuth } : env, timeoutMs, ...(guard ? { signal: guard.signal } : {}),
    });
    const checked = async (command: string, args: string[], timeoutMs?: number): Promise<string> => {
      const result = await run(command, args, timeoutMs);
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`${command} ${args[0]} failed${result.timedOut ? " (deadline)" : ` (exit ${result.code})`}: ${result.stderr.slice(-1200)}`);
      }
      return result.stdout;
    };
    try { report.version = (await checked(binary, ["--version"])).trim(); }
    catch {
      report.status = "blocked";
      report.reasonCode = "cli-unavailable";
      report.reason = "Droid executable unavailable or version probe failed; install a supported CLI separately and supply its path";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `cledger-probe-${randomUUID()}`, secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated Droid verification"]);
    provider = await startScriptedProvider({ toolName: "Read", toolArguments: { file_path: join(repo, "evidence.txt") } });
    guard = await startGuard(provider.endpoint, 4, Math.min(options.timeoutMs ?? 30_000, 30_000));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cloudSessionSync: false, model: "custom:Verification-0",
      customModels: [{ model: "fixture", displayName: "Verification", baseUrl: guard.endpoint,
        apiKey: "FAKE_TESTONLY_LOCAL_PROVIDER", provider: "generic-chat-completion-api", maxOutputTokens: 1024 }] }));
    await checked(process.execPath, [cli, "install", "droid"]);
    const hooks = JSON.parse(await readFile(join(agentDir, "hooks.json"), "utf8"));
    report.gates.installedHook = Array.isArray(hooks.Stop) && Array.isArray(hooks.SessionEnd);
    const prompt = `${marker}. Read evidence.txt using the Read tool and reply with its exact contents. Do not use any other tools.`;
    if(options.interactive){
      const { CI: _ci, NO_COLOR: _noColor, ...terminalEnv } = env;
      // Interactive Droid selects settings.model; --model is an exec-only
      // option and the TUI otherwise treats it as part of the human prompt.
      const terminal=await runPty(binary,["--disable-builtin-skills",prompt],{cwd:repo,env:{...terminalEnv,...nativeAuth,TERM:"xterm-256color"},timeoutMs:options.timeoutMs??45_000,
        stopWhen:"Please login with your Factory account to continue",
        actions:[{waitFor:secret,send:"/quit",delayMs:1000},{waitFor:"/quit",send:"\r",delayMs:250}]});
      report.gates.interactiveExit=!terminal.timedOut&&terminal.code===0&&terminal.actionsCompleted===2;
      report.coverage=report.coverage.map(value=>value==="headless CLI"?"interactive PTY session and exit (initial argv prompt)":value);report.exclusions=report.exclusions.filter(value=>value!=="interactive TUI");
      if (droidLoginRequired(terminal.output)) {
        report.status = "blocked";
        report.reasonCode = "login-required";
        report.reason = "Public Droid interactive mode requires Factory account login. Headless BYOK works without it; no isolated test-account authentication has been supplied. Configure CLEDGER_VERIFY_DROID_FACTORY_API_KEY outside chat with an authorized test key; the verifier maps it to documented FACTORY_API_KEY only for Droid in the isolated profile.";
        return report;
      }
      if(!report.gates.interactiveExit)throw new Error(`Droid public interactive startup/capture incomplete; authentication unverified (${terminal.code}, actions=${terminal.actionsCompleted}, timeout=${terminal.timedOut}): ${terminal.output.slice(-2200)}`);
    } else await checked(binary, ["--disable-builtin-skills", "exec", "--model", "custom:Verification-0", "--only-tools", "Read", "--output-format", "stream-json", prompt], options.timeoutMs ?? 60_000);
    const read = async (): Promise<EvidenceEvent[]> => (await checked(process.execPath, [cli, "export", "--all"]))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent);
    report.gates.tailWorkerCompleteAndExited = await awaitNativeTail(repo);
    const nativeEvents = await read();
    Object.assign(report.gates, droidEvidenceGates(nativeEvents, marker, secret));
    report.gates.scriptedRequests = provider.state.requests > 0 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
    if (!Object.values(report.gates).every(Boolean)) {
      throw new Error("Droid native hook evidence incomplete; manual backfill was not attempted");
    }
    await checked(process.execPath, [cli, "capture", "droid", "--all"]);
    const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "droid", "--all"]);
    const repeated = await read();
    const ids = (events: EvidenceEvent[]) => events.map((event) => event.id).sort().join("\n");
    report.gates.backfillIdempotent = ids(nativeEvents) === ids(backfilled) && ids(backfilled) === ids(repeated);
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
    if (!report.gates.backfillIdempotent) report.reason = "Native Droid hooks missed final persisted tail; first backfill changed ledger identities";
  } catch (error) {
    report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    if (guard) {
      report.requests = guard.state.forwarded;
      if (guard.state.blocked) { report.status = "blocked"; report.reason = guard.state.blocked; }
      await guard.close();
    }
    if (provider) await provider.close();
    await rm(root, { recursive: true, force: true });
    report.durationMs = Date.now() - started;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyScriptedDroid(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {});
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.status === "blocked") process.stderr.write(`WARNING: droid verification blocked (${report.reasonCode ?? "prerequisite-unavailable"}): ${report.reason}\n`);
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
