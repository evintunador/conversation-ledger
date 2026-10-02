/** Opt-in real-provider verification of the installed Kiro CLI V2 TUI. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo } from "annals";
import { readEvents } from "../store.js";
import { runPty, terminalTail } from "./pty.js";
import { runProcess } from "./process.js";

export interface KiroLiveReport {
  schema: "cledger-verification/1";
  cli: "kiro";
  status: "pass" | "fail" | "blocked";
  inference: "live-account";
  mode: "interactive";
  platform: string;
  version?: string;
  gates: Record<string, boolean>;
  reason?: string;
  reasonCode?: "login-required" | "cli-unavailable" | "unsupported-platform";
  durationMs: number;
}

export async function verifyLiveKiro(options: { binary?: string; timeoutMs?: number } = {}): Promise<KiroLiveReport> {
  const started = Date.now();
  const report: KiroLiveReport = { schema: "cledger-verification/1", cli: "kiro", status: "blocked", inference: "live-account",
    mode: "interactive", platform: `${process.platform}/${process.arch}`, gates: {}, durationMs: 0 };
  if (!["darwin", "linux"].includes(process.platform)) { report.reasonCode = "unsupported-platform"; report.reason = "Kiro TUI verification supports macOS and Linux"; return report; }
  const root = await mkdtemp(join(tmpdir(), "cledger-kiro-live-"));
  try {
    const repoPath = join(root, "repo"); await mkdir(repoPath);
    const bin = options.binary ? resolve(options.binary) : "kiro-cli", cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const env = { ...process.env, GIT_AUTHOR_NAME: "TESTONLY", GIT_AUTHOR_EMAIL: "testonly@example.invalid",
      GIT_COMMITTER_NAME: "TESTONLY", GIT_COMMITTER_EMAIL: "testonly@example.invalid", TERM: "xterm-256color" };
    const checked = async (command: string, args: string[]) => {
      const r = await runProcess(command, args, { cwd: repoPath, env, timeoutMs: 15_000 });
      if (r.code !== 0 || r.timedOut) throw new Error(`${command} ${args[0]} failed: ${r.stderr.slice(-300)}`);
      return r.stdout;
    };
    try { report.version = (await checked(bin, ["--version"])).trim(); }
    catch { report.reasonCode = "cli-unavailable"; report.reason = "Installed Kiro CLI unavailable; pass --binary with its path"; return report; }
    await checked("git", ["init", "--quiet"]);
    await writeFile(join(repoPath, ".cledger.json"), JSON.stringify({ transport: { hook: false, fetchRefspec: false } }));
    const marker = `TESTONLY-${randomUUID()}`, secret = `TESTONLY-${randomUUID()}`;
    await writeFile(join(repoPath, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]); await checked("git", ["commit", "--quiet", "-m", "TESTONLY Kiro verification"]);
    const prompt = `${marker}. Read evidence.txt using your file tool and reply with exactly its contents. Do not modify any files.`;
    const terminal = await runPty(process.execPath, [cli, "run", "kiro", "--binary", bin, "--", "chat", "--trust-tools=fs_read"], {
      cwd: repoPath, env, timeoutMs: options.timeoutMs ?? 60_000,
      actions: [
        { waitFor: "ask a question or describe a task", send: prompt + "\r", delayMs: 300 },
        { waitFor: secret, send: "/quit\r", delayMs: 500 },
      ],
    });
    const repo = await findRepo(repoPath), events = repo ? await readEvents(repo) : [];
    const own = events.filter(e => e.producer.source === "kiro");
    const blocks = (e: typeof own[number]) => (e.content as { blocks?: unknown[] })?.blocks ?? [];
    const matching = own.find(e => e.actor.type === "human" && JSON.stringify(blocks(e)).includes(marker));
    if (!matching && /(?:you are not logged in|please (?:log ?in|sign in)|run [`'"]?kiro-cli login)/i.test(terminalTail(terminal.output))) {
      report.status = "blocked";
      report.reasonCode = "login-required";
      report.reason = "Log into the installed Kiro CLI, then rerun live verification; no conversation was verified";
      return report;
    }
    const same = matching ? own.filter(e => e.stream?.id === matching.stream?.id) : [];
    const use = same.flatMap(blocks).find((b): b is { type: string; id?: string; name?: string } =>
      !!b && typeof b === "object" && (b as { type?: string }).type === "tool_use");
    report.gates = {
      installedVersion: !!report.version,
      interactiveExit: terminal.code === 0 && !terminal.timedOut && terminal.actionsCompleted === 2,
      capturedPrompt: !!matching,
      capturedRead: !!use && use.name === "read",
      capturedResult: !!use && same.some(e => e.actor.type === "system" && JSON.stringify(blocks(e)).includes(use.id ?? "") && JSON.stringify(blocks(e)).includes(secret)),
      capturedAnswer: same.some(e => e.actor.type === "agent" && JSON.stringify(blocks(e)).includes(secret)),
      noUnknownRecords: !same.some(e => e.kind === "unrecognized"),
    };
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "fail";
    if (report.status === "fail") report.reason = "The live TUI did not satisfy every native ledger evidence gate";
    return report;
  } catch (error) {
    report.status = "fail"; report.reason = error instanceof Error ? error.message : String(error); return report;
  } finally { report.durationMs = Date.now() - started; await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf("--binary");
  const report = await verifyLiveKiro({ ...(i >= 0 && process.argv[i + 1] ? { binary: process.argv[i + 1] } : {}) });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.status === "blocked") process.stderr.write(`WARNING: kiro verification blocked (${report.reasonCode ?? "prerequisite-unavailable"}): ${report.reason}\n`);
  process.exitCode = report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
