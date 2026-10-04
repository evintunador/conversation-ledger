/** Installed core TUI data-entry/lifecycle scenarios. No model inference. */
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { runPty, terminalTail } from "./pty.js";
import { startConformanceProvider, type CoreCli } from "./conformance-provider.js";
// Synthetic valid 32x32 RGB PNG, generated from PNG chunks with CRCs (no user image).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4EFBBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAF2O4Fut+99pAAAAAElFTkSuQmCC";
const textOf = (e: EvidenceEvent) => JSON.stringify(e.content);
const blocks = (e: EvidenceEvent) => (e.content as { blocks?: Record<string, unknown>[] }).blocks ?? [];
export function attachmentEvidence(value: unknown): { references: number; embeddedBinary: boolean } {
  let references = 0, embeddedBinary = false;
  function walk(item: unknown) {
    if (!item || typeof item !== "object") { if (typeof item === "string" && /^data:(?:image|application)\/[^;]+;base64,/i.test(item)) embeddedBinary = true; return; }
    if (Array.isArray(item)) { item.forEach(walk); return; }
    const record = item as Record<string, unknown>;
    if (record.type === "attachment_reference" && typeof record.sha256 === "string" && typeof record.size === "number") references++;
    if (record.type === "base64" && typeof record.data === "string") embeddedBinary = true;
    if (typeof record.base64 === "string" && typeof record.type === "string" && /^(?:image|application)\//.test(record.type)) embeddedBinary = true;
    Object.values(record).forEach(walk);
  }
  walk(value); return { references, embeddedBinary };
}
export interface ConformanceReport {
  schema: "cledger-conformance/1"; cli: CoreCli; version?: string; platform: string;
  inference: "scripted"; mode: "interactive"; status: "pass" | "partial" | "fail" | "blocked";
  cases: Record<string, { status: "pass" | "fail" | "not-run"; detail: string }>;
  requests: number; events: number; fullyCertified: false; exclusions: string[]; reason?: string; fileSearchBackend?: string;
}
export async function verifyCoreConformance(cli: CoreCli, options: { binary?: string; retain?: boolean; timeoutMs?: number; fileSearchBackend?: "ripgrep" } = {}): Promise<ConformanceReport> {
  const report: ConformanceReport = { schema: "cledger-conformance/1", cli, platform: process.platform + "/" + process.arch,
    mode: "interactive", inference: "scripted", status: "blocked", cases: {}, requests: 0, events: 0, fullyCertified: false,
    exclusions: ["live provider/model behavior", "headless mode", "clipboard/drag-and-drop image entry", "text-file editor attachment (native UTF-8 tool read is covered)",
      "PDF/archive/oversized or invalid text input", "compaction/fork/subagent lifecycle", "complete record-type coverage", "other operating systems"] };
  const root = await realpath(await mkdtemp(join(tmpdir(), "cledger-conformance-" + cli + "-")));
  let provider: Awaited<ReturnType<typeof startConformanceProvider>> | undefined;
  const sourceCli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const repo = join(root, "repo"), bin = join(root, "bin"), home = join(root, cli === "claude-code" ? ".claude" : ".codex");
  try {
    for (const dir of [repo, bin, home, join(root, "tmp"), join(root, "config", "opencode")]) await mkdir(dir, { recursive: true });
    const env = isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
    if (options.fileSearchBackend) {
      if (cli !== "opencode" || options.fileSearchBackend !== "ripgrep") throw Error("File search selection applies only to OpenCode's native ripgrep backend");
      env.OPENCODE_DISABLE_FFF = "1";
      report.fileSearchBackend = "native-ripgrep";
      report.exclusions.push("OpenCode default file-index backend");
    } else if (cli === "opencode") report.fileSearchBackend = "native-default";
    const binary = options.binary ? resolve(options.binary) : cli === "claude-code" ? "claude" : cli;
    // Native capture helpers invoke the product's command name (e.g. OpenCode
    // export). Bind that name to the selected installed runtime, not a global
    // binary or an absent PATH entry on an isolated CI runner.
    if (options.binary) await symlink(binary, join(bin, cli === "claude-code" ? "claude" : cli));
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(sourceCli)});\n`, { mode: 0o755 });
    const run = (command: string, args: string[], timeoutMs = 15000) => runProcess(command, args, { cwd: repo, env, timeoutMs });
    const checked = async (command: string, args: string[]) => { const r = await run(command, args); if (r.code || r.timedOut) throw Error(`Synthetic setup failed: ${command} ${args[0]}`); return r.stdout; };
    report.version = (await checked(binary, ["--version"])).trim();
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const value = "TESTONLY_CANARY_" + randomUUID();
    await writeFile(join(repo, "evidence.txt"), value + "\nKnown UTF-8: café 日本語 🦉\n");
    await writeFile(join(repo, "image-TESTONLY.png"), Buffer.from(PNG, "base64"));
    await checked("git", ["add", "."]); await checked("git", ["commit", "--quiet", "-m", "TESTONLY data entry conformance"]);
    provider = await startConformanceProvider(cli);
    if (cli === "claude-code") {
      Object.assign(env, { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "FAKE_TESTONLY_LOCAL", ANTHROPIC_BASE_URL: provider.endpoint,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" });
      await writeFile(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: ["FAKE_TESTONLY_LOCAL"], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
    } else if (cli === "codex") {
      env.CODEX_HOME = home;
      await writeFile(join(home, "config.toml"), ['model = "gpt-5.4"', 'model_provider = "verification"', 'approval_policy = "never"', 'check_for_update_on_startup = false',
        '[model_providers.verification]', 'name = "TESTONLY fixture"', `base_url = ${JSON.stringify(provider.endpoint + "/v1")}`, 'wire_api = "responses"',
        'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', `[projects.${JSON.stringify(repo)}]`, 'trust_level = "trusted"'].join("\n"));
    } else {
      await writeFile(join(root, "config", "opencode", "tui.json"), JSON.stringify({ theme: "opencode" }));
      await writeFile(join(root, "config", "opencode", "opencode.json"), JSON.stringify({ enabled_providers: ["verification"], model: "verification/fixture", small_model: "verification/fixture",
        share: "disabled", permission: { "*": "deny", read: "allow" }, provider: { verification: { npm: "@ai-sdk/openai-compatible", options: { baseURL: provider.endpoint + "/v1", apiKey: "TESTONLY-fixture" },
          models: { fixture: { name: "fixture", limit: { context: 32768, output: 1024 }, modalities: { input: ["text", "image"], output: ["text"] } } } } } }));
    }
    await checked(process.execPath, [sourceCli, "install", cli]);
    const prompt = "TESTONLY_CONFORMANCE\nUnicode café 日本語 🦉\nReference evidence.txt; check missing-TESTONLY.txt, then read evidence.txt and image-TESTONLY.png.";
    const args = cli === "claude-code" ? ["--model", "claude-sonnet-4-6", "--tools", "Read", "--allowedTools", "Read", "--strict-mcp-config"]
      : cli === "codex" ? ["--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--no-alt-screen", "--image", join(repo, "image-TESTONLY.png")]
        : [];
    const readiness = cli === "codex" ? "Ask Codex to do anything" : cli === "claude-code" ? "❯|for shortcuts" : "Ask anything|Ask a question|Build";
    const exported = async () => (await checked(process.execPath, [sourceCli, "export", "--all"])).split("\n").filter(Boolean).map(line => JSON.parse(line) as EvidenceEvent).filter(e => e.producer.source === cli);
    async function terminalRound(resume: boolean) {
      const complete = join(root, resume ? "resume-complete" : "first-complete");
      const priorAnswers = (await exported()).filter(e => e.actor.type === "agent" && textOf(e).includes("TESTONLY_CONFORMANCE_DONE")).length;
      let stopped = false;
      const observer = (async () => {
        while (!stopped) {
          try {
            const events = await exported();
            const human = events.find(e => e.actor.type === "human" && textOf(e).includes(resume ? "TESTONLY_CONFORMANCE_RESUME" : "TESTONLY_CONFORMANCE"));
            if (human && events.filter(e => e.stream?.id === human.stream?.id && e.actor.type === "agent" && textOf(e).includes("TESTONLY_CONFORMANCE_DONE")).length > priorAnswers &&
                (!resume || events.filter(e => e.actor.type === "human" && textOf(e).includes("TESTONLY_CONFORMANCE")).length > 1)) { await writeFile(complete, ""); return; }
          } catch { /* first export can precede native hook */ }
          await new Promise(yes => setTimeout(yes, 200));
        }
      })();
      let nativeArgs = args;
      if (resume) nativeArgs = cli === "claude-code" ? [...args, "--continue"] : cli === "codex" ? ["resume", "--last", "--dangerously-bypass-hook-trust", "--no-alt-screen"] : ["--continue"];
      const sent = resume ? "TESTONLY_CONFORMANCE_RESUME\nUnicode déjà vu 日本語 🦉" + (cli === "codex" ? "" : " @image-TESTONLY.png") : prompt;
      try {
        const actions = resume && cli === "opencode" ? [
          // Bulk-pasting @filename leaves OpenCode 1.18.33's autocomplete
          // query empty and Enter chooses @explore. Exercise actual keyboard
          // entry: paste body, open @ menu, type filename, select, submit.
          { waitFor: readiness, send: "\x1b[200~" + "TESTONLY_CONFORMANCE_RESUME\nUnicode déjà vu 日本語 🦉" + "\x1b[201~", delayMs: 500 },
          { waitFor: "TESTONLY_CONFORMANCE_RESUME|Unicode", send: " @", delayMs: 500 },
          { waitFor: "@explore|@general", send: "image-TESTONLY.png", delayMs: 500 },
          { waitFor: "image-TESTONLY\\.png", waitForRaw: "\\x1b\\[48;5;216mimage-TESTONLY\\.png", send: "\r", delayMs: 1000 },
          { waitFor: "image-TESTONLY\\.png|Unicode", send: "\r", delayMs: 1000 },
          { waitFor: "^", waitForPath: complete, send: "/exit\r", delayMs: 1000 },
        ] : [
          { waitFor: readiness, send: sent + "\r", paste: true, delayMs: 500 },
          ...(resume && cli === "claude-code" ? [{ waitFor: "image-TESTONLY\\.png", send: "\r", delayMs: 1000 }] : []),
          { waitFor: "^", waitForPath: complete, send: "/exit\r", delayMs: 1000 },
        ];
        const terminal = await runPty(binary, nativeArgs, { cwd: repo, env, answerTerminalQueries: cli !== "opencode", timeoutMs: options.timeoutMs ?? 120000,
          transcriptPath: join(root, resume ? "resume-terminal.log" : "first-terminal.log"), actions });
        if (terminal.timedOut || terminal.code || terminal.actionsCompleted !== actions.length) throw Error(`Observed ${resume ? "resume" : "initial"} TUI incomplete: ${terminalTail(terminal.output)}`);
        return terminal;
      } finally { stopped = true; await observer; }
    }
    await terminalRound(false);
    const first = await exported(); report.events = first.length;
    const human = first.find(e => e.actor.type === "human" && textOf(e).includes("TESTONLY_CONFORMANCE"));
    const text = human ? blocks(human).filter(b => b.type === "text").map(b => b.text).join("\n") : "";
    const toolResults = first.flatMap(blocks).filter(b => b.type === "tool_result");
    const toolUses = first.flatMap(blocks).filter(b => b.type === "tool_use");
    const matchingCalls = (file: string) => new Set(toolUses.filter(b => JSON.stringify(b.input).includes(file)).map(b => b.id));
    const reads = matchingCalls("evidence.txt"), errors = matchingCalls("missing-TESTONLY.txt"), images = matchingCalls("image-TESTONLY.png");
    const attachments = attachmentEvidence(first);
    const linkedImageResult = toolResults.some(b => images.has(b.tool_use_id) && attachmentEvidence(b).references > 0 && !attachmentEvidence(b).embeddedBinary);
    report.cases.multilineUnicode = { status: text.includes("TESTONLY_CONFORMANCE\nUnicode café 日本語 🦉\nReference") ? "pass" : "fail", detail: "Bracket-paste into actual native editor; compared normalized human text, not echoed terminal" };
    report.cases.textRead = { status: toolResults.some(b => reads.has(b.tool_use_id) && JSON.stringify(b).includes(value) && JSON.stringify(b).includes("café 日本語 🦉")) ? "pass" : "fail", detail: "Actual file tool result retains known UTF-8 text" };
    report.cases.toolError = { status: provider.state.toolError && toolResults.some(b => errors.has(b.tool_use_id) && /missing-TESTONLY|No such file|does not exist|not found|code: 1/i.test(JSON.stringify(b))) ? "pass" : "fail", detail: "Actual failed native read and linked result; scripted provider observed native error response" };
    report.cases.imageReference = { status: !attachments.embeddedBinary && (cli === "codex" ? attachments.references > 0 : linkedImageResult) ? "pass" : "fail", detail: cli === "codex" ? "Installed --image input attached to initial real TUI; binary retained as reference, not base64 bytes" : "Actual native Read image output retains a reference in the linked image tool result; user editor image-paste entry is a separate unverified case" };
    report.cases.userImageEntry = { status: cli === "codex" && provider.state.inputImage ? report.cases.imageReference.status : "not-run", detail: cli === "codex" ? "Documented native --image initial attachment in TUI" : "Native editor @image reference attempted on resumed turn; tool-returned image alone is not proof" };
    report.cases.noUnrecognized = { status: first.some(e => e.kind === "unrecognized") ? "fail" : "pass", detail: "Unknown native record evidence stays explicit" };
    await terminalRound(true);
    const resumed = await exported(); report.events = resumed.length;
    report.cases.noUnrecognized = { status: resumed.some(e => e.kind === "unrecognized") ? "fail" : "pass", detail: "Unknown native records across initial and resumed turns stay explicit" };
    const second = resumed.find(e => e.actor.type === "human" && textOf(e).includes("TESTONLY_CONFORMANCE_RESUME"));
    const resumedText = second ? blocks(second).filter(b => b.type === "text").map(b => b.text).join("\n") : "";
    report.cases.resume = { status: human && second && human.stream?.id === second.stream?.id && resumedText.includes("TESTONLY_CONFORMANCE_RESUME\nUnicode déjà vu 日本語 🦉") ? "pass" : "fail", detail: "Exited and relaunched native continue/resume; complete multiline Unicode turn remains in original stream" };
    const entryRecords = resumed.filter(e => e.actor.type === "human" || e.kind === "context_injection" && JSON.stringify(e.content).includes('"filename"') && JSON.stringify(e.content).includes("image-TESTONLY.png"));
    if (cli !== "codex") report.cases.userImageEntry = { status: provider.state.inputImage && attachmentEvidence(entryRecords).references > 0 ? "pass" : "fail", detail: "Native editor @image entry and provider input observed; human/context attachment retains a reference, not bytes" };
    if (attachmentEvidence(resumed).embeddedBinary) report.cases.imageReference = { status: "fail", detail: "Embedded binary survived in initial or resumed native content/raw; retention repair required" };
    let captureArgs = ["--all"];
    if (cli === "codex") {
      const files = (await readdir(join(home, "sessions"), { recursive: true })).filter(f => f.endsWith(".jsonl") && f.includes("rollout-"));
      if (files.length !== 1) throw Error("Expected one isolated resumed Codex rollout; observed " + files.length);
      captureArgs = ["--transcript", join(home, "sessions", files[0]!)];
    }
    await checked(process.execPath, [sourceCli, "capture", cli, ...captureArgs]);
    const backfilled = await exported();
    await checked(process.execPath, [sourceCli, "capture", cli, ...captureArgs]);
    const repeated = await exported();
    const ids = (events: EvidenceEvent[]) => events.map(e => e.id).sort().join("\n");
    report.cases.backfill = { status: ids(resumed) === ids(backfilled) && ids(backfilled) === ids(repeated) ? "pass" : "fail", detail: "Both manual imports compared against automatic complete native ledger" };
    report.status = Object.values(report.cases).every(c => c.status === "pass") ? "pass" : "partial";
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error);
    if (provider?.state.requests) {
      report.status = "fail";
      report.cases.scenarioCompletion = { status: "fail", detail: "The installed TUI issued native model requests but did not complete automatic capture/lifecycle gates; this is not a login skip" };
    } else report.status = report.events ? "partial" : "blocked";
  }
  finally {
    report.requests = provider?.state.requests ?? 0;
    await provider?.close();
    if (options.retain) await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
    else await rm(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = process.argv[2] as CoreCli;
  if (!["claude-code", "codex", "opencode"].includes(cli) || process.argv.slice(3).some(a => a !== "--retain")) throw Error("Usage: conformance CLI [--retain]; only actual interactive TUI scenarios are implemented");
  const report = await verifyCoreConformance(cli, { ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), retain: process.argv.includes("--retain"),
    ...(process.env.CLEDGER_CONFORMANCE_OPENCODE_RIPGREP === "1" ? { fileSearchBackend: "ripgrep" as const } : {}) });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.status === "pass" ? 0 : (report.status === "partial" || report.status === "fail") ? 1 : 2;
}
