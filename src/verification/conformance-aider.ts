/** Installed Aider proof uses its explicit recorder, not invented tool blocks. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo } from "annals";
import { readEvents } from "../store.js";
import type { EvidenceEvent } from "../schema.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { attachmentEvidence, CONFORMANCE_CASES, type ConformanceReport } from "./conformance.js";

export async function verifyAiderConformance(options: { binary?: string; mode: "headless" | "interactive"; retain?: boolean; timeoutMs?: number }): Promise<ConformanceReport> {
  const report: ConformanceReport = { schema: "cledger-conformance/1", cli: "aider", platform: `${process.platform}/${process.arch}`,
    mode: options.mode, inference: "scripted", status: "blocked", fullyCertified: false, requests: 0, events: 0,
    started: new Date().toISOString(), inputMethod: options.mode === "interactive" ? "native brace-delimited multiline terminal input; image filename argument" : "native --message argument; image filename argument",
    exclusions: ["unwrapped sessions", "real provider behavior", "additional attachment/lifecycle cases", "other operating systems"],
    cases: Object.fromEntries(CONFORMANCE_CASES.map(name => [name, { status: "not-run", detail: "Installed scenario pending" }])) };
  const root = await mkdtemp(join(tmpdir(), "cledger-conformance-aider-")), repo = join(root, "repo");
  const marker = "TESTONLY_CONFORMANCE", value = "TESTONLY_CANARY_" + randomUUID();
  let resumed = false, imageInput = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions" || ++report.requests > 4) throw Error("Unexpected fixture request");
      let body = "";
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2_000_000) throw Error("Fixture limit"); }
      const data = JSON.parse(body), context = JSON.stringify(data.messages);
      imageInput ||= data.messages.some((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "image_url"));
      if (!context.includes(value)) throw Error("Native file read missing");
      resumed ||= context.includes("TESTONLY_CONFORMANCE_RESUME") && context.includes("TESTONLY_CONFORMANCE_DONE");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "TESTONLY_completion", object: "chat.completion", model: "fixture", created: 1,
        choices: [{ index: 0, message: { role: "assistant", content: "TESTONLY_CONFORMANCE_DONE " + value }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } catch { res.writeHead(400); res.end(); }
  });
  try {
    await mkdir(repo); await mkdir(join(root, "tmp"));
    const env = isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin");
    env.LITELLM_LOCAL_MODEL_COST_MAP = "True"; env.AIDER_ANALYTICS = "false";
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url)), python = options.binary ?? "python3";
    const checked = async (command: string, args: string[]) => {
      const result = await runProcess(command, args, { cwd: repo, env, timeoutMs: options.timeoutMs ?? 90000 });
      if (result.code || result.timedOut) throw Error(`Installed operation failed: ${args[0]} (${result.code}); ${result.stderr.slice(-1500)}`);
      return result.stdout;
    };
    report.version = (await checked(python, ["-c", 'from importlib.metadata import version; print(version("aider-chat"))'])).trim();
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repo, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    await writeFile(join(repo, "evidence.txt"), value + "\ncafé 日本語 🦉\n");
    await writeFile(join(repo, "invalid-TESTONLY.txt"), Buffer.from([255, 254, 255]));
    await writeFile(join(repo, "image-TESTONLY.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n5sAAAAASUVORK5CYII=", "base64"));
    await writeFile(join(root, "models.json"), JSON.stringify({ "openai/fixture": { max_input_tokens: 16000, max_output_tokens: 4096, input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: "openai", mode: "chat", supports_vision: true } }));
    await checked("git", ["add", "."]); await checked("git", ["commit", "--quiet", "-m", "synthetic conformance"]);
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture address");
    env.OPENAI_API_BASE = `http://127.0.0.1:${address.port}/v1`; env.OPENAI_API_KEY = "TESTONLY-loopback";
    const read = async () => { const info = await findRepo(repo); if (!info) throw Error("Synthetic repo missing"); return readEvents(info, { reachableFrom: null }); };
    const round = async (resume: boolean) => {
      const prompt = `${marker}${resume ? "_RESUME" : ""}\nUnicode ${resume ? "déjà vu" : "café"} 日本語 🦉\nReference evidence.txt and answer its first line.`;
      const args = [cli, "run", "aider", "--python", python, "--", "--model", "openai/fixture", "--weak-model", "openai/fixture", "--model-metadata-file", join(root, "models.json"),
        "--edit-format", "whole", "--no-stream", "--yes", "--no-pretty", "--no-fancy-input", "--no-check-update", "--no-show-release-notes", "--no-show-model-warnings", "--no-analytics", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--no-detect-urls", "--no-auto-lint", "--no-auto-test", "--map-tokens", "0",
        ...(resume ? ["--restore-chat-history"] : []), ...(options.mode === "headless" ? ["--message", prompt] : []), "--read", "invalid-TESTONLY.txt", "evidence.txt", "image-TESTONLY.png"];
      if (options.mode === "headless") await checked(process.execPath, args);
      else {
        delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
        const terminal = await runPty(process.execPath, args, { cwd: repo, env, timeoutMs: options.timeoutMs ?? 90000,
          actions: [{ waitFor: "> ", send: "{\n" + prompt + "\n}\n" }, { waitFor: "TESTONLY_CONFORMANCE_DONE", send: "/exit\n" }] });
        if (terminal.code || terminal.timedOut || terminal.actionsCompleted !== 2) throw Error("Native Aider input/exit incomplete: " + terminalTail(terminal.output));
      }
    };
    await round(false); const first = await read();
    const content = (e: EvidenceEvent) => e.content as Record<string, any>;
    const human = first.find(e => e.actor.type === "human" && JSON.stringify(e.content).includes(marker));
    const operations = first.filter(e => content(e).event_type === "file.operation");
    const linked = (path: string) => first.filter(e => content(e).event_type === "file.result" && operations.some(o => content(o).call_id === content(e).call_id && String(content(o).path).endsWith(path)));
    report.cases.multilineUnicode = { status: human && JSON.stringify(human.content).includes("TESTONLY_CONFORMANCE\\nUnicode café 日本語 🦉\\nReference") ? "pass" : "fail", detail: report.inputMethod! };
    report.cases.textRead = { status: linked("evidence.txt").some(e => JSON.stringify(e.content).includes(value) && JSON.stringify(e.content).includes("café 日本語 🦉")) ? "pass" : "fail", detail: "Actual native read_text operation/result call_id retains UTF-8 text" };
    report.cases.toolError = { status: linked("invalid-TESTONLY.txt").some(e => content(e).returned_none === true) && first.some(e => content(e).event_type === "io.tool_error" && JSON.stringify(e.content).includes("invalid-TESTONLY.txt")) ? "pass" : "fail", detail: "Actual invalid UTF-8 read returns None with a linked file operation/result and native error diagnostic" };
    const image = attachmentEvidence(linked("image-TESTONLY.png"));
    report.cases.imageReference = { status: image.references > 0 && !image.embeddedBinary ? "pass" : "fail", detail: "Native image read body retained as a reference in its linked file result" };
    const contextImage = attachmentEvidence(first.filter(e => e.kind === "context_injection"));
    report.cases.userImageEntry = { status: imageInput && contextImage.references > 0 && !contextImage.embeddedBinary ? "pass" : "fail", detail: "Native filename argument adds image to user model context; explicit recorder retains reference" };
    await round(true); const automatic = await read(); report.events = automatic.length; report.automaticEventsBeforeBackfill = automatic.length;
    report.cases.resume = { status: resumed ? "limitation" : "fail", detail: "Native --restore-chat-history reloads prior prompt/answer, verified in the resumed model request. Aider has no native stable session ID; separate explicit launches produce separate recorder streams rather than fabricated continuity." };
    if (attachmentEvidence(automatic).embeddedBinary) report.cases.imageReference = { status: "fail", detail: "Embedded binary remains in native content/raw evidence" };
    report.cases.noUnrecognized = { status: hasUnrecognizedEvidence(automatic, "aider") ? "fail" : "pass", detail: "Initial and restored native records contain no unknown evidence" };
    await checked(process.execPath, [cli, "capture", "aider", "--all"]); const backfilled = await read();
    await checked(process.execPath, [cli, "capture", "aider", "--all"]); const repeated = await read();
    const ids = (events: EvidenceEvent[]) => events.map(e => e.id).sort().join("\n");
    report.cases.backfill = { status: ids(automatic) === ids(backfilled) && ids(backfilled) === ids(repeated) ? "pass" : "fail", detail: "Two manual backfills compared against automatic recorder capture after both normal exits" };
    if (options.retain) await writeFile(join(root, "automatic.jsonl"), automatic.map(e => JSON.stringify(e)).join("\n") + "\n");
    report.status = Object.values(report.cases).every(c => ["pass", "limitation"].includes(c.status)) ? "pass" : "partial";
  } catch (error) { report.reason = error instanceof Error ? error.message : String(error); report.status = report.requests ? "fail" : "blocked"; }
  finally {
    report.completed = new Date().toISOString(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (options.retain) await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2)); else await rm(root, { recursive: true, force: true });
  }
  return report;
}
