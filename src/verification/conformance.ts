/** Installed core TUI data-entry/lifecycle scenarios. No model inference. */
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent } from "../schema.js";
import { findRepo } from "annals";
import { readEvents } from "../store.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { runPty, terminalTail } from "./pty.js";
import { startConformanceProvider, type ConformanceCli } from "./conformance-provider.js";
import { ADDITIONAL_CONFORMANCE_DRIVERS, WRAPPED_CONFORMANCE_DRIVERS, prepareAdditionalNative, additionalNativeArgs } from "./conformance-native.js";
export const CONFORMANCE_CASES = ["multilineUnicode", "textRead", "toolError", "imageReference", "userImageEntry", "noUnrecognized", "resume", "backfill"] as const;
export const CONFORMANCE_DRIVERS: readonly ConformanceCli[] = ["claude-code", "codex", "opencode", "gemini-cli", "qwen-code", "pi", "kilo", "copilot", "kimi", "open-interpreter", ...ADDITIONAL_CONFORMANCE_DRIVERS];
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
    // Copilot persists native asset locators rather than embedded image bytes.
    if (typeof record.assetId === "string" && /^sha256:[a-f0-9]{64}$/.test(record.assetId) && typeof record.byteLength === "number") references++;
    // Kimi stores opaque native media locators. Preserve the available locator;
    // do not invent a digest or byte count that its persisted API omits.
    if (typeof record.url === "string" && /^kimi-file:\/\/f_[a-f0-9-]+$/i.test(record.url)) references++;
    // Vibe persists the copied attachment's native file locator, not its bytes.
    if (typeof record.mime_type === "string" && record.mime_type.startsWith("image/") &&
        record.source && typeof record.source === "object" && (record.source as Record<string, unknown>).kind === "file" &&
        typeof (record.source as Record<string, unknown>).path === "string") references++;
    if (record.type === "base64" && typeof record.data === "string") embeddedBinary = true;
    if (typeof record.base64 === "string" && typeof record.type === "string" && /^(?:image|application)\//.test(record.type)) embeddedBinary = true;
    if (typeof record.data === "string" && typeof record.mimeType === "string" && /^(?:image|application)\//.test(record.mimeType)) embeddedBinary = true;
    Object.values(record).forEach(walk);
  }
  walk(value); return { references, embeddedBinary };
}
export interface ConformanceReport {
  schema: "cledger-conformance/1"; cli: ConformanceCli; version?: string; platform: string;
  inference: "scripted"; mode: "interactive" | "headless"; status: "pass" | "partial" | "fail" | "blocked";
  cases: Record<string, { status: "pass" | "fail" | "not-run" | "limitation"; detail: string }>;
  requests: number; events: number; fullyCertified: false; exclusions: string[]; reason?: string; fileSearchBackend?: string;
  started?: string; completed?: string; inputMethod?: string; automaticEventsBeforeBackfill?: number;
  nativeTools?: string[];
  backfillObservation?: { automatic: number; first: number; second: number; firstAdded: unknown[]; secondAdded: unknown[] };
}
export async function verifyCoreConformance(cli: ConformanceCli, options: { binary?: string; retain?: boolean; timeoutMs?: number; fileSearchBackend?: "ripgrep"; mode?: "headless" | "interactive" } = {}): Promise<ConformanceReport> {
  if (!CONFORMANCE_DRIVERS.includes(cli)) throw Error(`No installed conformance driver for ${cli}`);
  const mode = options.mode ?? "interactive";
  const report: ConformanceReport = { schema: "cledger-conformance/1", cli, platform: process.platform + "/" + process.arch,
    mode, inference: "scripted", status: "blocked", cases: Object.fromEntries(CONFORMANCE_CASES.map(name => [name, { status: "not-run" as const, detail: "Installed scenario has not reached this gate" }])), requests: 0, events: 0, fullyCertified: false,
    started: new Date().toISOString(), inputMethod: mode === "interactive" ? "native editor bracketed paste" : "native prompt argument",
    exclusions: ["live provider/model behavior", mode === "interactive" ? "headless mode" : "interactive mode", "clipboard/drag-and-drop image entry", "text-file editor attachment (native UTF-8 tool read is covered)",
      "PDF/archive/oversized or invalid text input", "compaction/fork/subagent lifecycle", "complete record-type coverage", "other operating systems"] };
  const root = await realpath(await mkdtemp(join(tmpdir(), "cledger-conformance-" + cli + "-")));
  let provider: Awaited<ReturnType<typeof startConformanceProvider>> | undefined;
  const sourceCli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const repo = join(root, "repo"), bin = join(root, "bin"), home = join(root, cli === "claude-code" ? ".claude" : cli === "open-interpreter" ? ".openinterpreter" : ".codex");
  try {
    for (const dir of [repo, bin, home, join(root, "tmp"), join(root, ".gemini"), join(root, ".qwen"), join(root, ".pi", "agent"), join(root, ".copilot"), join(root, ".kimi"), join(root, "config", "opencode"), join(root, "config", "kilo")]) await mkdir(dir, { recursive: true });
    const env = isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
    if (options.fileSearchBackend) {
      if (cli !== "opencode" || options.fileSearchBackend !== "ripgrep") throw Error("File search selection applies only to OpenCode's native ripgrep backend");
      env.OPENCODE_DISABLE_FFF = "1";
      report.fileSearchBackend = "native-ripgrep";
      report.exclusions.push("OpenCode default file-index backend");
    } else if (cli === "opencode") report.fileSearchBackend = "native-default";
    const nativeName = cli === "claude-code" ? "claude" : cli === "gemini-cli" ? "gemini" : cli === "qwen-code" ? "qwen" : cli === "open-interpreter" ? "interpreter" : cli === "continue" ? "cn" : cli === "mistral-vibe" ? "vibe" : cli;
    const binary = options.binary ? resolve(options.binary) : nativeName;
    // Native capture helpers invoke the product's command name (e.g. OpenCode
    // export). Bind that name to the selected installed runtime, not a global
    // binary or an absent PATH entry on an isolated CI runner.
    if (options.binary) await symlink(binary, join(bin, nativeName));
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
    if (cli === "kimi" && mode === "interactive") {
      // Isolate OS file-clipboard lookup. The installed TUI still parses the
      // PNG and submits native media; this does not certify the real clipboard.
      const image = join(repo, "image-TESTONLY.png");
      const script = `#!${process.execPath}\nconst args = process.argv.slice(2); process.stdout.write(args.includes("--list-types") || args.includes("TARGETS") ? "text/uri-list\\n" : ${JSON.stringify(image)} + "\\n");\n`;
      for (const name of ["osascript", "wl-paste", "xclip"]) await writeFile(join(bin, name), script, { mode: 0o755 });
      if (process.platform === "linux") { env.WAYLAND_DISPLAY = "TESTONLY-clipboard-fixture"; env.XDG_SESSION_TYPE = "wayland"; }
      report.inputMethod = "native editor bracketed paste; resumed Ctrl-V with isolated OS file-clipboard lookup fixture";
      report.exclusions.push("real OS clipboard integration (lookup fixture only)");
    }
    if (cli === "continue" && mode === "interactive") {
      const script = `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nconst args = process.argv.slice(2).join(" "); const bytes = Buffer.from(${JSON.stringify(PNG)}, "base64");\nif (args.includes("clipboard info")) process.stdout.write("«class PNGf»\\n");\nelse if (process.argv[1].endsWith("xclip")) process.stdout.write(bytes);\nelse { const path = args.match(/open for access "([^"]+)"/); if (!path || !path[1].startsWith(${JSON.stringify(join(root, "tmp"))} + "/continue-clipboard-")) process.exit(1); writeFileSync(path[1], bytes); }\n`;
      for (const name of ["osascript", "xclip"]) await writeFile(join(bin, name), script, { mode: 0o755 });
      report.exclusions.push("real OS clipboard integration (lookup fixture only)");
    }
    provider = await startConformanceProvider(cli, repo);
    if (cli === "claude-code") {
      Object.assign(env, { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "FAKE_TESTONLY_LOCAL", ANTHROPIC_BASE_URL: provider.endpoint,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" });
      await writeFile(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: ["FAKE_TESTONLY_LOCAL"], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
    } else if (["codex", "open-interpreter"].includes(cli)) {
      env[cli === "codex" ? "CODEX_HOME" : "INTERPRETER_HOME"] = home;
      await writeFile(join(home, "config.toml"), [cli === "open-interpreter" ? 'model = "ledger-test"' : 'model = "gpt-5.4"', 'model_provider = "verification"', 'approval_policy = "never"', 'check_for_update_on_startup = false',
        '[model_providers.verification]', 'name = "TESTONLY fixture"', `base_url = ${JSON.stringify(provider.endpoint + "/v1")}`, 'wire_api = "responses"',
        'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', `[projects.${JSON.stringify(repo)}]`, 'trust_level = "trusted"'].join("\n"));
    } else if (cli === "gemini-cli") {
      Object.assign(env, { GEMINI_API_KEY: "TESTONLY-local-verification", GOOGLE_GEMINI_BASE_URL: provider.endpoint, GEMINI_CLI_HOME: root, GEMINI_CLI_TRUST_WORKSPACE: "true" });
      await writeFile(join(root, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } }, general: { enableAutoUpdate: false, enableAutoUpdateNotification: false }, telemetry: { enabled: false }, model: { name: "gemini-2.5-flash" } }));
    } else if (cli === "qwen-code") {
      Object.assign(env, { QWEN_RUNTIME_DIR: join(root, ".qwen"), OPENAI_API_KEY: "TESTONLY-local-verification", OPENAI_BASE_URL: provider.endpoint + "/v1", OPENAI_MODEL: "fixture" });
      await writeFile(join(root, ".qwen", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "openai" } }, model: { name: "fixture" },
        modelProviders: { openai: [{ id: "fixture", baseUrl: provider.endpoint + "/v1", envKey: "OPENAI_API_KEY", capabilities: { vision: true }, generationConfig: { modalities: { image: true } } }] }, telemetry: { enabled: false } }));
    } else if (cli === "copilot") {
      Object.assign(env, { COPILOT_PROVIDER_API_KEY: "TESTONLY-local-verification", COPILOT_PROVIDER_BASE_URL: provider.endpoint + "/v1", COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions", COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "1024", COPILOT_MODEL: "fixture" });
      await writeFile(join(root, ".copilot", "config.json"), JSON.stringify({ trustedFolders: [repo] }));
    } else if (cli === "kimi") {
      Object.assign(env, { KIMI_CODE_HOME: join(root, ".kimi"), KIMI_DISABLE_TELEMETRY: "1", KIMI_DISABLE_CRON: "1", KIMI_CODE_BUILTIN_PRODUCT_SKILLS: "0", KIMI_LOOP_MAX_STEPS_PER_TURN: "5", KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "1" });
      await writeFile(join(root, ".kimi", "config.toml"), `default_model = "fixture"
telemetry = false
[providers.verification]
type = "openai"
base_url = ${JSON.stringify(provider.endpoint + "/v1")}
api_key = "TESTONLY-local-verification"
[models.fixture]
provider = "verification"
model = "fixture"
max_context_size = 32768
capabilities = ["tool_use", "image_in"]
[loop_control]
max_steps_per_turn = 5
max_attempts_per_step = 1
`);
    } else if (cli === "pi") {
      const agentDir = join(root, ".pi", "agent");
      env.PI_CODING_AGENT_DIR = agentDir;
      env.PI_OFFLINE = "1";
      await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { verification: { baseUrl: provider.endpoint + "/v1", api: "openai-completions", apiKey: "TESTONLY-local-verification",
        models: [{ id: "fixture", name: "Scripted verification", contextWindow: 32768, maxTokens: 1024, input: ["text", "image"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "verification", defaultModel: "fixture", retry: { enabled: false }, quietStartup: true }));
    } else if (ADDITIONAL_CONFORMANCE_DRIVERS.includes(cli as typeof ADDITIONAL_CONFORMANCE_DRIVERS[number])) {
      await prepareAdditionalNative(cli, { root, repo, endpoint: provider.endpoint, env, binary, checked });
    } else {
      await writeFile(join(root, "config", cli, "tui.json"), JSON.stringify({ theme: "opencode" }));
      await writeFile(join(root, "config", cli, cli + ".json"), JSON.stringify({ enabled_providers: ["verification"], model: "verification/fixture", small_model: "verification/fixture",
        share: "disabled", permission: { "*": "deny", read: "allow" }, provider: { verification: { npm: "@ai-sdk/openai-compatible", options: { baseURL: provider.endpoint + "/v1", apiKey: "TESTONLY-fixture" },
          models: { fixture: { name: "fixture", limit: { context: 32768, output: 1024 }, modalities: { input: ["text", "image"], output: ["text"] } } } } } }));
    }
    if (!WRAPPED_CONFORMANCE_DRIVERS.has(cli)) await checked(process.execPath, [sourceCli, "install", cli]);
    const prompt = "TESTONLY_CONFORMANCE\nUnicode café 日本語 🦉\nReference evidence.txt; check missing-TESTONLY.txt, then read evidence.txt and image-TESTONLY.png.";
    if (cli === "continue" && mode === "interactive") report.inputMethod = "native editor raw multiline paste; resumed Ctrl-V with isolated OS image-clipboard lookup fixture";
    const args = cli === "claude-code" ? ["--model", "claude-sonnet-4-6", "--tools", "Read", "--allowedTools", "Read", "--strict-mcp-config"]
      : ["codex", "open-interpreter"].includes(cli) ? ["--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--no-alt-screen", "--image", join(repo, "image-TESTONLY.png")]
        : cli === "copilot" ? ["--allow-tool", "view", "--disable-builtin-mcps", "--no-auto-update", "--no-custom-instructions", "--no-ask-user", "--no-remote-export"]
        : cli === "kimi" ? ["--model", "fixture", "--auto"]
        : cli === "pi" ? ["--offline", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--tools", "read", "--thinking", "off", "--provider", "verification", "--model", "fixture", "@" + join(repo, "image-TESTONLY.png")]
        : [];
    const readiness = cli === "open-interpreter" ? "ledger-test default" : cli === "codex" ? "Ask Codex to do anything|Ask.*Interpreter|›" : cli === "claude-code" ? "❯|for shortcuts" : cli === "kilo" ? "Code[\\s\\S]*fixture|tab agents" : cli === "pi" ? "fixture|context" : cli === "kimi" ? "No session yet[\\s\\S]*context:|context:" : cli === "copilot" ? "← open sidebar|/ commands" : cli === "continue" ? "Ask anything" : cli === "cline" ? "What can I do for you|What would you like|Type.*message|Enter.*prompt|Ask anything" : cli === "goose" ? "Enter to send" : cli === "openhands" ? "Loaded:.*skills,.*hooks" : cli === "mistral-vibe" ? "Enter.*message|What would|❯|> " : cli === "crush" ? "Ready[!.?]|Ready for instructions" : ["gemini-cli", "qwen-code"].includes(cli) ? "Type your message|Type a message|> " : "Ask anything|Ask a question|Build";
    const exported = async () => {
      const ledger = await findRepo(repo);
      return ledger ? (await readEvents(ledger, { reachableFrom: null })).filter(e => e.producer.source === cli) : [];
    };
    let resumeLimitation: string | undefined;
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
      if (resume) nativeArgs = cli === "claude-code" ? [...args, "--continue"] : ["codex", "open-interpreter"].includes(cli) ? ["resume", "--last", "--dangerously-bypass-hook-trust", "--no-alt-screen"] : cli === "gemini-cli" ? ["--resume", "latest"] : [...args, "--continue"];
      const sent = resume ? "TESTONLY_CONFORMANCE_RESUME\nUnicode déjà vu 日本語 🦉" + (["codex", "open-interpreter", "pi"].includes(cli) ? "" : " @image-TESTONLY.png") : prompt + (cli === "cline" && mode === "headless" ? " @image-TESTONLY.png" : "");
      const additional = ADDITIONAL_CONFORMANCE_DRIVERS.includes(cli as typeof ADDITIONAL_CONFORMANCE_DRIVERS[number]);
      const session = (await exported()).find(e => e.actor.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes("TESTONLY_CONFORMANCE")))?.producer.session_id;
      const invocation = (native: string[]) => WRAPPED_CONFORMANCE_DRIVERS.has(cli)
        ? { command: process.execPath, args: [sourceCli, "run", cli, "--binary", binary, "--", ...native] }
        : { command: binary, args: native };
      try {
        if (mode === "headless") {
          const headlessArgs = additional ? additionalNativeArgs(cli, { root, repo, mode, resume, prompt: sent, ...(session ? { session } : {}) }) : ["codex", "open-interpreter"].includes(cli) ? ["exec", ...(resume ? ["resume", "--last"] : ["--sandbox", "read-only", "--image", join(repo, "image-TESTONLY.png")]), "--dangerously-bypass-hook-trust", sent]
            : ["opencode", "kilo"].includes(cli) ? ["run", ...(resume ? ["--continue"] : []), "--file", join(repo, "image-TESTONLY.png"), "--", sent]
            : cli === "claude-code" || cli === "pi" ? [...nativeArgs, "--print", sent]
            : [...nativeArgs.filter(a => cli !== "kimi" || a !== "--auto"), ...(cli === "copilot" ? ["--attachment", join(repo, "image-TESTONLY.png")] : []), "--prompt", sent, "--output-format", cli === "copilot" ? "json" : "stream-json"];
          const command = invocation(headlessArgs);
          const result = await run(command.command, command.args, options.timeoutMs ?? 120000);
          await writeFile(join(root, resume ? "resume-headless.log" : "first-headless.log"), result.stdout + result.stderr, { mode: 0o600 });
          if (resume && cli === "cline" && result.code === 1 && !result.timedOut && (result.stdout + result.stderr).includes("JSON output mode requires a prompt argument or piped stdin")) {
            resumeLimitation = "Cline 3.0.65 --id forces interactive mode and clears the supplied prompt before JSON-mode validation. The installed --id/--json invocation rejects continuation; piped input also rejects it. TUI resume is a separate gate. No resumed record was fabricated.";
            return;
          }
          if (resume && cli === "droid" && result.code === 1) {
            const log = await readFile(join(root, ".factory", "logs", "droid-log-single.log"), "utf8").catch(() => "");
            if (log.includes("Missing authorization token in HTTP headers") && log.includes("Failed to fetch session")) throw Error("LOGIN_REQUIRED: Droid 0.229.0 exec --session-id fetches the session through Factory's authenticated API even with cloudSessionSync=false and a local BYOK session. Isolated Factory authentication is required; no user credential was borrowed.");
          }
          if (result.code !== 0 || result.timedOut) throw Error(`Observed ${resume ? "resume" : "initial"} headless invocation incomplete (${result.code}, timeout=${result.timedOut}): ${terminalTail(result.stdout + result.stderr)}`);
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const events = await exported();
            const h = events.find(e => e.actor.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes(resume ? "TESTONLY_CONFORMANCE_RESUME" : "TESTONLY_CONFORMANCE")));
            if (h && events.filter(e => e.stream?.id === h.stream?.id && e.actor.type === "agent" && textOf(e).includes("TESTONLY_CONFORMANCE_DONE")).length > priorAnswers) return;
            await new Promise(done => setTimeout(done, 200));
          }
          throw Error("Automatic headless prompt/answer capture incomplete before backfill");
        }
        if (cli === "open-interpreter" && !resume) nativeArgs = [...nativeArgs, prompt];
        const actions = cli === "crush" && resume ? [
          { waitFor: readiness, send: "\x1b[200~" + join(repo, "image-TESTONLY.png") + "\x1b[201~", delayMs: 500 },
          { waitFor: "image-TESTONLY\\.png", send: "\x1b[200~TESTONLY_CONFORMANCE_RESUME\nUnicode déjà vu 日本語 🦉\x1b[201~", delayMs: 500 },
          { waitFor: "Unicode", send: "\r", delayMs: 1000 },
          { waitFor: "^", waitForPath: complete, send: "/exit\r", delayMs: 500 },
        ] : cli === "open-interpreter" && !resume ? [
          { waitFor: "^", waitForPath: complete, send: "/exit\r", delayMs: 1000 },
        ] : cli === "continue" ? [
          ...(resume ? [{ waitFor: "Press Ctrl\\+V to paste image", send: "\x16", delayMs: 1000 }] : []),
          { waitFor: resume ? "Image #1" : readiness, send: sent, delayMs: 500 },
          { waitFor: "Unicode", send: "\r", delayMs: 1000 },
          { waitFor: "^", waitForPath: complete, send: "/exit", delayMs: 1000 },
          { waitFor: "/exit", send: "\r", delayMs: 500 },
        ] : resume && ["opencode", "kilo"].includes(cli) ? [
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
          ...(resume && ["gemini-cli", "copilot"].includes(cli) ? [{ waitFor: "Resuming.*session", send: "" }] : []),
          ...(!resume && cli === "kimi" ? [{ waitFor: "Trust this folder", send: "\r" }] : []),
          ...(!resume && cli === "cline" ? [{ waitFor: "any other key to close", send: "\x1b", delayMs: 500 }] : []),
          ...(!resume && cli === "crush" ? [{ waitFor: "Would you like to initialize", send: "n", delayMs: 500 }] : []),
          ...(cli === "kimi" && resume ? [
            { waitFor: readiness, send: "\x16", delayMs: 1000 },
            { waitFor: "image #|image:", send: sent + "\r", paste: true, delayMs: 500 },
          ] : ["gemini-cli", "openhands"].includes(cli) ? [
            { waitFor: readiness, send: "\x1b[200~" + sent + "\x1b[201~", delayMs: 500 },
            { waitFor: "Unicode", send: cli === "openhands" ? "\x0a" : "\r", delayMs: 1000 },
            ...(resume && cli === "gemini-cli" ? [{ waitFor: "image-TESTONLY\\.png", send: "\r", delayMs: 1000 }] : []),
          ] : [{ waitFor: readiness, send: sent + "\r", paste: true, delayMs: 500 }]),
          ...(resume && ["claude-code", "copilot", "cline", "mistral-vibe"].includes(cli) ? [{ waitFor: "image-TESTONLY\\.png", send: "\r", delayMs: 1000 }] : []),
          ...(resume && cli === "cline" ? [{ waitFor: "image-TESTONLY\\.png", send: "\r", delayMs: 1000 }] : []),
          ...(["gemini-cli", "qwen-code", "copilot", "kimi"].includes(cli) ? [
            { waitFor: "^", waitForPath: complete, send: cli === "kimi" ? "/exit" : "/quit", delayMs: 1000 },
            { waitFor: cli === "gemini-cli" ? "Exit the cli" : cli === "kimi" ? "/exit" : "/quit", send: "\r", delayMs: 1000 },
          ] : [{ waitFor: "^", waitForPath: complete, send: cli === "pi" ? "/quit\r" : cli === "openhands" ? "\x11" : "/exit\r", delayMs: 1000 }]),
        ];
        if (cli === "crush") {
          actions.splice(actions.length - 1, 1,
            { waitFor: "^", waitForPath: complete, send: "\x03", delayMs: 500 },
            { waitFor: "Are you sure you want to quit", send: "y", delayMs: 500 });
        }
        if (additional) nativeArgs = additionalNativeArgs(cli, { root, repo, mode, resume, prompt: sent, ...(session ? { session } : {}) });
        if (cli === "open-interpreter" && mode === "interactive") report.inputMethod = "native TUI initial prompt/--image arguments; resumed editor bracketed paste";
        const command = invocation(nativeArgs);
        const terminal = await runPty(command.command, command.args, { cwd: repo, env, answerTerminalQueries: !["opencode", "crush"].includes(cli), timeoutMs: options.timeoutMs ?? 120000,
          transcriptPath: join(root, resume ? "resume-terminal.log" : "first-terminal.log"), actions });
        if (terminal.timedOut || terminal.code || terminal.actionsCompleted !== actions.length) throw Error(`Observed ${resume ? "resume" : "initial"} TUI incomplete: ${terminalTail(terminal.output)}`);
        return terminal;
      } finally { stopped = true; await observer; }
    }
    await terminalRound(false);
    const first = await exported(); report.events = first.length;
    if (options.retain) await writeFile(join(root, "first-automatic.jsonl"), first.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    const human = first.find(e => e.actor.type === "human" && textOf(e).includes("TESTONLY_CONFORMANCE"));
    const text = human ? blocks(human).filter(b => b.type === "text").map(b => b.text).join("\n") : "";
    const toolResults = first.flatMap(blocks).filter(b => b.type === "tool_result");
    const toolUses = first.flatMap(blocks).filter(b => b.type === "tool_use");
    const matchingCalls = (file: string) => new Set(toolUses.filter(b => JSON.stringify(b.input).includes(file)).map(b => b.id));
    const reads = matchingCalls("evidence.txt"), errors = matchingCalls("missing-TESTONLY.txt"), images = matchingCalls("image-TESTONLY.png");
    const attachments = attachmentEvidence(first);
    const linkedImageResult = toolResults.some(b => images.has(b.tool_use_id) && attachmentEvidence(b).references > 0 && !attachmentEvidence(b).embeddedBinary);
    report.cases.multilineUnicode = { status: text.includes("TESTONLY_CONFORMANCE\nUnicode café 日本語 🦉\nReference") ? "pass" : "fail", detail: `${report.inputMethod}; compared normalized human text, not echoed terminal` };
    report.cases.textRead = { status: toolResults.some(b => reads.has(b.tool_use_id) && JSON.stringify(b).includes(value) && JSON.stringify(b).includes("café 日本語 🦉")) ? "pass" : "fail", detail: "Actual file tool result retains known UTF-8 text" };
    report.cases.toolError = { status: provider.state.toolError && toolResults.some(b => errors.has(b.tool_use_id) && /missing-TESTONLY|No such file|does not exist|not found|code: 1/i.test(JSON.stringify(b))) ? "pass" : "fail", detail: "Actual failed native read and linked result; scripted provider observed native error response" };
    report.cases.imageReference = { status: !attachments.embeddedBinary && (["codex", "open-interpreter"].includes(cli) ? attachments.references > 0 : linkedImageResult) ? "pass" : "fail", detail: ["codex", "open-interpreter"].includes(cli) ? "Native --image initial attachment retained as a reference, without embedded binary bytes" : "Actual native image tool result retains a reference in its linked result" };
    if (cli === "continue" && !attachments.embeddedBinary && toolResults.some(b => images.has(b.tool_use_id)) && !linkedImageResult) report.cases.imageReference = {
      status: "limitation", detail: "Continue 1.5.47 Read returns fs.readFileSync(path, 'utf-8') text even for this PNG; its actual linked result exposes no image carrier or original byte body. The lossy upstream text is preserved without inventing binary evidence. Native TUI user image retention is proved separately." };
    if (cli === "mistral-vibe" && !attachments.embeddedBinary && toolResults.some(b => images.has(b.tool_use_id)) && !linkedImageResult) report.cases.imageReference = {
      status: "limitation", detail: "Vibe 2.25.8 legacy read_file decodes this PNG into numbered text via read_lines_safe_async, with replacement characters. The linked native result omits the original binary carrier; its lossy text is preserved without inventing original bytes, size or digest. User image entry is checked separately." };
    report.cases.userImageEntry = { status: ["codex", "open-interpreter", "pi"].includes(cli) && provider.state.inputImage ? report.cases.imageReference.status : "not-run", detail: ["codex", "open-interpreter"].includes(cli) ? "Documented native --image initial attachment" : cli === "pi" ? "Documented native @image initial argument; provider image input and retained reference checked" : "Native @image reference attempted on resumed turn; tool-returned image alone is not proof" };
    report.cases.noUnrecognized = { status: hasUnrecognizedEvidence(first, cli) ? "fail" : "pass", detail: "Unknown native record evidence stays explicit, including nested markers" };
    await terminalRound(true);
    // Detached native followers can persist terminal lifecycle records after
    // the binary exits. Wait for their owned status files before backfill.
    const tailDeadline = Date.now() + 30000;
    while (Date.now() < tailDeadline) {
      const dirs = (await readdir(join(repo, ".git"))).filter(name => name.startsWith("cledger-") && name.endsWith("-tail"));
      let pending = false;
      for (const dir of dirs) {
        const names = await readdir(join(repo, ".git", dir));
        pending ||= names.some(name => name.endsWith(".lock"));
        for (const name of names.filter(name => name.endsWith(".json"))) {
          const status = JSON.parse(await readFile(join(repo, ".git", dir, name), "utf8"));
          if (status.status === "failed") throw Error("Native tail follower failed");
          pending ||= status.status !== "complete";
        }
      }
      if (!pending) break;
      await new Promise(done => setTimeout(done, 200));
      if (Date.now() >= tailDeadline) throw Error("Native tail follower did not complete");
    }
    const resumed = await exported(); report.events = resumed.length;
    if (options.retain) await writeFile(join(root, "resumed-automatic.jsonl"), resumed.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    report.automaticEventsBeforeBackfill = resumed.length;
    report.cases.noUnrecognized = { status: hasUnrecognizedEvidence(resumed, cli) ? "fail" : "pass", detail: "Unknown native records across initial and resumed turns stay explicit, including nested markers" };
    const second = resumed.find(e => e.actor.type === "human" && blocks(e).some(b => b.type === "text" && String(b.text).includes("TESTONLY_CONFORMANCE_RESUME")));
    const resumedText = second ? blocks(second).filter(b => b.type === "text").map(b => b.text).join("\n") : "";
    report.cases.resume = { status: human && second && human.stream?.id === second.stream?.id && resumedText.includes("TESTONLY_CONFORMANCE_RESUME\nUnicode déjà vu 日本語 🦉") &&
      resumed.filter(e => e.stream?.id === human.stream?.id && e.actor.type === "agent" && textOf(e).includes("TESTONLY_CONFORMANCE_DONE")).length >
      first.filter(e => e.stream?.id === human.stream?.id && e.actor.type === "agent" && textOf(e).includes("TESTONLY_CONFORMANCE_DONE")).length ? "pass" : "fail", detail: "Exited and relaunched native continue/resume; complete multiline Unicode turn remains in original stream" };
    if (resumeLimitation) report.cases.resume = { status: "limitation", detail: resumeLimitation };
    const entryRecords = resumed.filter(e => e.actor.type === "human" || e.kind === "context_injection" && JSON.stringify(e.content).includes('"filename"') && JSON.stringify(e.content).includes("image-TESTONLY.png"));
    if (!["codex", "open-interpreter", "pi"].includes(cli)) report.cases.userImageEntry = { status: provider.state.inputImage && attachmentEvidence(entryRecords).references > 0 ? "pass" : "fail", detail: `Native input method: ${report.inputMethod}; provider image input and persisted human/context reference required, without embedded binary bytes` };
    if (cli === "kimi" && mode === "headless" && !provider.state.inputImage && resumedText.includes("@image-TESTONLY.png")) {
      report.cases.userImageEntry = { status: "limitation", detail: "Kimi 2.1.1 --prompt accepts text only: its installed help exposes no attachment flag, and @image remained literal in the native human record/provider request. TUI clipboard media and ACP media are separate interfaces, not headless prompt evidence. Native ReadMediaFile is checked separately." };
    }
    if (cli === "cline" && mode === "headless" && !provider.state.inputImage && text.includes("@image-TESTONLY.png")) report.cases.userImageEntry = {
      status: "limitation", detail: "Cline 3.0.65 headless --json accepts a text prompt and exposes no image attachment flag. Native @image remained literal in the persisted human prompt and provider input; a tool-returned image does not prove user attachment entry." };
    if (cli === "continue" && mode === "headless" && !provider.state.inputImage && resumedText.includes("@image-TESTONLY.png")) report.cases.userImageEntry = {
      status: "limitation", detail: "Continue 1.5.47 --print accepts text and exposes no attachment flag. Native @image remained literal in the resumed human prompt and provider request. Its TUI Ctrl-V media path is a separate verified interface." };
    if (cli === "goose" && !provider.state.inputImage && resumedText.includes("@image-TESTONLY.png")) report.cases.userImageEntry = {
      status: "limitation", detail: "Goose 1.52.0 CLI run --text and session InputResult::Message accept strings, with no native image attachment input. The installed @image remained literal in the human record and provider request. Its real developer read_image tool result retains image references separately; a tool image is not user entry." };
    if (cli === "mistral-vibe" && mode === "headless" && !provider.state.inputImage && resumedText.includes("@image-TESTONLY.png")) report.cases.userImageEntry = {
      status: "limitation", detail: "Vibe 2.25.8 legacy programmatic --prompt submits a string without the TUI's image-token expansion. Installed @image remained literal in the human prompt/provider request despite supports_images=true. TUI @image entry retains its native copied-file locator and is checked separately." };
    if (cli === "crush" && mode === "headless" && !provider.state.inputImage && resumedText.includes("@image-TESTONLY.png")) report.cases.userImageEntry = {
      status: "limitation", detail: "Crush 0.97.1 run accepts prompt text and has no image attachment flag. Installed @image remained literal in the native human prompt/provider input. Its TUI parses a separately pasted file path as an attachment; that interface is checked separately." };
    if (cli === "openhands" && !provider.state.inputImage && resumedText.includes("@image-TESTONLY.png")) report.cases.userImageEntry = {
      status: "limitation", detail: "OpenHands CLI 1.16.0 headless --task and native TUI conversation_runner submit TextContent(text=user_input). Installed @image remained text in both the native human record and provider request. ACP supports ImageContent through another interface; ACP evidence cannot certify native CLI/TUI image entry." };
    if (attachmentEvidence(resumed).embeddedBinary) report.cases.imageReference = { status: "fail", detail: "Embedded binary survived in initial or resumed native content/raw; retention repair required" };
    let captureArgs = ["--all"];
    if (["codex", "open-interpreter"].includes(cli)) {
      const files = (await readdir(join(home, "sessions"), { recursive: true })).filter(f => f.endsWith(".jsonl") && f.includes("rollout-"));
      if (files.length !== 1) throw Error("Expected one isolated resumed Codex rollout; observed " + files.length);
      captureArgs = ["--transcript", join(home, "sessions", files[0]!)];
    }
    await checked(process.execPath, [sourceCli, "capture", cli, ...captureArgs]);
    const backfilled = await exported();
    await checked(process.execPath, [sourceCli, "capture", cli, ...captureArgs]);
    const repeated = await exported();
    const ids = (events: EvidenceEvent[]) => events.map(e => e.id).sort().join("\n");
    const added = (before: EvidenceEvent[], after: EvidenceEvent[]) => {
      const known = new Set(before.map(e => e.id));
      return after.filter(e => !known.has(e.id)).map(e => ({ id: e.id, kind: e.kind, actor: e.actor.type,
        source: e.producer.source, nativeRecord: e.raw, content: e.content }));
    };
    report.backfillObservation = { automatic: resumed.length, first: backfilled.length, second: repeated.length,
      firstAdded: added(resumed, backfilled), secondAdded: added(backfilled, repeated) };
    report.cases.backfill = { status: ids(resumed) === ids(backfilled) && ids(backfilled) === ids(repeated) ? "pass" : "fail", detail: "Both manual imports compared against automatic complete native ledger" };
    report.status = Object.values(report.cases).every(c => c.status === "pass" || c.status === "limitation") ? "pass" : "partial";
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error);
    if (report.reason.startsWith("LOGIN_REQUIRED:")) {
      report.status = "blocked";
    } else if (provider?.state.requests) {
      report.status = "fail";
      report.cases.scenarioCompletion = { status: "fail", detail: "The installed interface issued native model requests but did not complete automatic capture/lifecycle gates; this is not a login skip" };
    } else report.status = report.version ? "fail" : "blocked";
  }
  finally {
    report.completed = new Date().toISOString();
    report.requests = provider?.state.requests ?? 0;
    report.nativeTools = provider?.state.nativeTools ?? [];
    await provider?.close();
    if (options.retain) await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
    else await rm(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = process.argv[2] as ConformanceCli;
  const args = process.argv.slice(3);
  const modeIndex = args.indexOf("--mode");
  const mode = modeIndex < 0 ? "interactive" : args[modeIndex + 1];
  if (!CONFORMANCE_DRIVERS.includes(cli) || !["headless", "interactive"].includes(mode ?? "") || args.some((a, i) => a !== "--retain" && a !== "--mode" && i !== modeIndex + 1)) throw Error("Usage: conformance CLI [--retain] [--mode headless|interactive]");
  const report = await verifyCoreConformance(cli, { ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), retain: process.argv.includes("--retain"),
    mode: mode as "headless" | "interactive",
    ...(process.env.CLEDGER_CONFORMANCE_OPENCODE_RIPGREP === "1" ? { fileSearchBackend: "ripgrep" as const } : {}) });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.status === "pass" ? 0 : (report.status === "partial" || report.status === "fail") ? 1 : 2;
}
