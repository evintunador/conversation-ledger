/** Cursor uses native Connect RPC, file reads and checkpoint persistence. */
import { randomUUID, createHash } from "node:crypto";
import { glob, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo } from "annals";
import { readEvents } from "../store.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { startCursorProtocolFixture } from "./cursor-protocol.js";
import { attachmentEvidence, CONFORMANCE_CASES, type ConformanceReport } from "./conformance.js";

export async function verifyCursorConformance(options: { binary?: string; mode: "headless" | "interactive"; retain?: boolean; timeoutMs?: number }): Promise<ConformanceReport> {
  const report: ConformanceReport = {
    schema: "cledger-conformance/1", cli: "cursor", platform: `${process.platform}/${process.arch}`,
    mode: options.mode, inference: "scripted", status: "blocked", requests: 0, events: 0, fullyCertified: false,
    started: new Date().toISOString(), inputMethod: options.mode === "headless" ? "native prompt argument through explicit stream recorder" : "native editor multiline paste; filename autocomplete selection and separate Enter submission",
    exclusions: ["real provider/model behavior", options.mode === "headless" ? "native TUI" : "headless stream recorder", "clipboard/drop entry", "additional attachment/lifecycle cases", "other operating systems"],
    cases: Object.fromEntries(CONFORMANCE_CASES.map(name => [name, { status: "not-run", detail: "Installed Cursor scenario pending" }])),
  };
  const root = await mkdtemp(join(tmpdir(), "cledger-conformance-cursor-")), repo = join(root, "repo"), bin = join(root, "bin");
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url)), binary = options.binary ?? "cursor-agent";
  let provider: Awaited<ReturnType<typeof startCursorProtocolFixture>> | undefined;
  try {
    for (const path of [repo, bin, join(root, "tmp")]) await mkdir(path);
    const env = isolatedEnvironment(root, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    env.AGENT_CLI_CREDENTIAL_STORE = "file";
    if (options.mode === "interactive") { delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color"; }
    await writeFile(join(bin, "cledger"), `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`, { mode: 0o755 });
    const checked = async (command: string, args: string[]) => {
      const result = await runProcess(command, args, { cwd: repo, env, timeoutMs: options.timeoutMs ?? 60000 });
      if (result.code || result.timedOut) throw Error(`Native Cursor operation failed: code=${result.code}, timeout=${result.timedOut}; ${result.stderr.slice(-1500)}`);
      return result.stdout;
    };
    report.version = (await checked(binary, ["--version"])).trim();
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const initial = "TESTONLY_CANARY_" + randomUUID(), fresh = "TESTONLY_RESUMED_" + randomUUID();
    await writeFile(join(repo, "evidence.txt"), initial + "\ncafé 日本語 🦉\n");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4EFBBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAF2O4Fut+99pAAAAAElFTkSuQmCC", "base64");
    await writeFile(join(repo, "image-TESTONLY.png"), png);
    await checked("git", ["add", "."]); await checked("git", ["commit", "--quiet", "-m", "TESTONLY Cursor conformance"]);
    await checked(process.execPath, [cli, "install", "cursor"]);
    provider = await startCursorProtocolFixture(repo);
    env.AGENT_CLI_UPDATE_CHECK_URL = provider.endpoint + "/TESTONLY/update";
    const read = async () => { const info = await findRepo(repo); if (!info) throw Error("Synthetic repository missing"); return readEvents(info, { reachableFrom: null }); };
    const round = async (resume: boolean) => {
      const prompt = `TESTONLY_CONFORMANCE${resume ? "_RESUME" : ""}\nUnicode ${resume ? "déjà vu" : "café"} 日本語 🦉\nReference @image-TESTONLY.png`;
      const args = ["--endpoint", provider!.endpoint,
        "--agent-endpoint", provider!.agentEndpoint, "--api-key", "TESTONLY-fixture", "--trust", "--model", "fixture",
        ...(resume ? ["--resume", provider!.state.session] : [])];
      if (options.mode === "headless") await checked(process.execPath, [cli, "run", "cursor", "--binary", binary, "--", ...args, prompt]);
      else {
        const complete = join(repo, ".git", `TESTONLY-cursor-${resume ? "resume" : "initial"}-complete`), secret = resume ? fresh : initial;
        let waiting = true, pollError: unknown;
        const polling = (async () => {
          while (waiting) {
            const events = await read();
            // Cursor flushes prompt/answer transcript capture during normal
            // exit. Before quitting require actual tool capture and native KV
            // acknowledgements; check the full automatic ledger after exit.
            if (provider!.state.turnsCompleted >= (resume ? 2 : 1) && events.some(event => {
              const blocks = (event.content as { blocks?: Record<string, unknown>[] }).blocks ?? [];
              return blocks.some(block => block.type === "tool_result" && block.is_error !== true && JSON.stringify(block.content).includes(secret));
            })) {
              await writeFile(complete, "Automatic native tool evidence and checkpoint acknowledgements are present\n"); break;
            }
            await new Promise(done => setTimeout(done, 50));
          }
        })().catch(error => { pollError = error; });
        try {
          const terminal = await runPty(binary, args, { cwd: repo, env, timeoutMs: options.timeoutMs ?? 60000,
            actions: [
              { waitFor: "Plan, search, build anything|Add a follow-up", send: prompt, paste: true, delayMs: 500 },
              { waitFor: "Unicode", send: "\r", delayMs: 1000 },
              { waitFor: "image-TESTONLY\\.png", send: "\r", delayMs: 1000 },
              { waitFor: "TESTONLY_CONFORMANCE_DONE", waitForPath: complete, quietMs: 500, send: "/exit\r", delayMs: 1000 },
            ] });
          if (terminal.code || terminal.timedOut || terminal.actionsCompleted !== 4) throw Error("Native Cursor TUI input/exit incomplete: " + terminalTail(terminal.output));
          if (options.retain) await writeFile(join(root, `terminal-${resume ? "resume" : "initial"}.log`), terminal.output);
        } finally { waiting = false; await polling; }
        if (pollError) throw pollError;
      }
    };
    await round(false); const first = await read();
    const blocks = (events: typeof first) => events.flatMap(event => ((event.content as { blocks?: Record<string, unknown>[] }).blocks ?? []));
    const uses = blocks(first).filter(block => block.type === "tool_use" && typeof block.id === "string");
    const results = blocks(first).filter(block => block.type === "tool_result");
    const linked = (path: string) => results.filter(result => uses.some(use => use.id === result.tool_use_id && JSON.stringify(use.input).includes(path)));
    report.cases.multilineUnicode = { status: first.some(event => event.actor.type === "human" && JSON.stringify(event.content).includes("TESTONLY_CONFORMANCE\\nUnicode café 日本語 🦉\\nReference")) ? "pass" : "fail", detail: "Native submitted prompt and persisted checkpoint retain Unicode and newlines" };
    report.cases.textRead = { status: linked("evidence.txt").some(result => JSON.stringify(result).includes(initial) && JSON.stringify(result).includes("café 日本語 🦉")) ? "pass" : "fail", detail: "Actual native Read result linked by supplied tool call ID retains known UTF-8 text" };
    report.cases.toolError = { status: provider.state.toolError && linked("missing-TESTONLY.txt").some(result => result.is_error === true) ? "pass" : "fail", detail: "Real native missing-file Read failure retains its linked result" };
    const hasReference = (value: unknown, match: (ref: Record<string, unknown>) => boolean): boolean => {
      if (!value || typeof value !== "object") return false;
      const ref = value as Record<string, unknown>;
      return ref.type === "attachment_reference" && match(ref) || Object.values(ref).some(child => hasReference(child, match));
    };
    const image = linked("image-TESTONLY.png"), digest = createHash("sha256").update(png).digest("hex");
    const retainedImage = hasReference(image, ref => ref.sha256 === digest && ref.size === png.length);
    const unavailableImage = hasReference(image, ref => ref.availability === "native_binary_body_unavailable" && String(ref.path).endsWith("image-TESTONLY.png") && ref.sha256 === undefined && ref.size === undefined);
    report.cases.imageReference = { status: provider.state.imageResult && !attachmentEvidence(first).embeddedBinary ? retainedImage ? "pass" : options.mode === "interactive" && unavailableImage ? "limitation" : "fail" : "fail",
      detail: retainedImage ? "Native PNG Read bytes become references with the exact size/digest in normalized and raw evidence" : "Native TUI Read returns PNG bytes, but hooks expose empty text and no binary body. Preserve the path reference without inventing a file size/digest." };
    const humans = first.filter(event => event.actor.type === "human"), input = attachmentEvidence(humans);
    report.cases.userImageEntry = { status: humans.some(event => JSON.stringify(event.content).includes("@image-TESTONLY.png")) && provider.state.selectedImages === 0 && !input.embeddedBinary && input.references === 0 ? "limitation" : "fail",
      detail: options.mode === "headless" ? "Headless @image path is literal prompt text with no native selected-image carrier" : "Native editor @filename entry with two separate Enter actions persists as literal text; the native request has zero selected images and the human record has no image carrier. Other native image-entry methods remain unverified." };
    report.inputObservation = { providerImage: provider.state.selectedImages > 0, ...input, humanEntries: provider.state.selectedFiles };
    await writeFile(join(repo, "evidence.txt"), fresh + "\nKnown resumed UTF-8: déjà vu 日本語 🦉\n");
    const session = provider.state.session; await round(true); const automatic = await read();
    report.events = automatic.length; report.automaticEventsBeforeBackfill = automatic.length;
    report.cases.resume = { status: session === provider.state.session && provider.state.resumedPointers === 2 && provider.state.textResult.includes(fresh) && automatic.some(event => JSON.stringify(event.content).includes(fresh)) ? "pass" : "fail", detail: "Native --resume reloads prior checkpoint pointers, reads a fresh value, captures automatically and exits normally" };
    report.cases.noUnrecognized = { status: hasUnrecognizedEvidence(automatic, "cursor") ? "fail" : "pass", detail: "No unknown records after both native runs" };
    if (attachmentEvidence(automatic).embeddedBinary) report.cases.imageReference.status = "fail";
    const transcripts: string[] = [];
    for await (const path of glob(join(root, ".cursor", "projects", "*", "agent-transcripts", "*", "*.jsonl"))) transcripts.push(path);
    if (!transcripts.length) throw Error("Native persisted transcripts missing");
    const ids = (events: typeof first) => events.map(event => event.id).sort().join("\n");
    const counts = [automatic.length]; let previous = ids(automatic), unchanged = true;
    for (let index = 0; index < 2; index++) {
      for (const transcript of transcripts) await checked(process.execPath, [cli, "capture", "cursor", "--transcript", transcript]);
      const after = await read(); counts.push(after.length); unchanged &&= previous === ids(after); previous = ids(after);
    }
    report.cases.backfill = { status: unchanged ? "pass" : "fail", detail: `Two native transcript backfills preserve automatic evidence IDs (${counts.join(" / ")})` };
    if (options.retain) await writeFile(join(root, "automatic.jsonl"), automatic.map(event => JSON.stringify(event)).join("\n") + "\n");
    report.status = Object.values(report.cases).every(result => ["pass", "limitation"].includes(result.status)) ? "pass" : "partial";
  } catch (error) { report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error); }
  finally {
    report.requests = provider?.state.requests ?? 0; report.completed = new Date().toISOString(); await provider?.close();
    if (options.retain) await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n"); else await rm(root, { recursive: true, force: true });
  }
  return report;
}
