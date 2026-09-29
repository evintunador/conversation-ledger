import { runPty, terminalTail } from "./pty.js";
import { hasUnrecognizedEvidence } from "./drift.js";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startGuard } from "./guard.js";
import type { Report, Options } from "./opencode.js";
import type { EvidenceEvent } from "../schema.js";
export type AiderReport = Omit<Report, "cli"> & { cli: "aider" };
export function aiderEvidenceGates(
  events: EvidenceEvent[],
  marker: string,
  secret: string,
): Record<string, boolean> {
  const source = events.filter((e) => e.producer.source === "aider");
  const content = (e: EvidenceEvent) => e.content as Record<string, unknown>;
  const human = source.find(
    (e) =>
      e.actor.type === "human" &&
      JSON.stringify(content(e).blocks).includes(marker),
  );
  const own = human
    ? source.filter((e) => e.stream?.id === human.stream?.id)
    : [];
  const readIds = new Set(
    own
      .filter(
        (e) =>
          content(e).event_type === "file.operation" &&
          content(e).method === "read_text" &&
          String(content(e).path).endsWith("evidence.txt"),
      )
      .map((e) => content(e).call_id),
  );
  return {
    prompt: !!human,
    readResult: own.some(
      (e) =>
        content(e).event_type === "file.result" &&
        readIds.has(content(e).call_id) &&
        JSON.stringify(content(e).attachment).includes(secret),
    ),
    modelContext: own.some(
      (e) =>
        e.kind === "context_injection" &&
        JSON.stringify(content(e).messages).includes(secret),
    ),
    answer: own.some(
      (e) =>
        e.actor.type === "agent" &&
        JSON.stringify(content(e).blocks).includes(secret),
    ),
    fileWrite: own.some(
      (e) =>
        content(e).event_type === "file.result" &&
        content(e).method === "write_text" &&
        content(e).dry_run === false &&
        JSON.stringify(content(e).attachment).includes("verified"),
    ),
    terminal: own.some(
      (e) =>
        content(e).event_type === "session.end" &&
        content(e).recorder_failed === false,
    ),
  };
}
export async function verifyScriptedAider(
  options: Pick<Options, "binary" | "timeoutMs" | "interactive"> = {},
): Promise<AiderReport> {
  const start = Date.now(),
    report: AiderReport = {
      schema: "cledger-verification/1",
      cli: "aider",
      status: "not-run",
      certification: "native-smoke",
      inference: "scripted",
      platform: `${process.platform}/${process.arch}`,
      gates: {},
      coverage: [
        "explicit launch recorder",
        "headless whole edit",
        "native human/assistant IO",
        "linked file read",
        "model context",
        "file write",
        "terminal capture",
        "backfill idempotency",
      ],
      exclusions: [
        "unwrapped sessions",
        "Markdown history import",
        "streaming",
        "interactive decisions",
        "summarization",
        "subagents",
        "real provider behavior",
      ],
      durationMs: 0,
    };
  report.mode = options.interactive ? "interactive" : "headless";
  if (options.interactive) report.coverage = report.coverage.map(x => x === "headless whole edit" ? "interactive PTY whole edit" : x);
  if (!["darwin", "linux"].includes(process.platform)) {
    report.reason = "Unsupported platform";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-aider-native-")),
    lock = join(tmpdir(), "cledger-native-inference.lock");
  let locked = false;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  let requests = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2_000_000) throw Error("body limit");
      }
      const data = JSON.parse(body);
      requests++;
      const secret = JSON.stringify(data.messages).match(
        /file-value-[a-f0-9-]+/,
      )?.[0];
      if (!secret || requests > 2) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "TESTONLY-completion",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `evidence.txt\n\`\`\`text\n${secret}\nverified\n\`\`\`\n`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
  try {
    try {
      await mkdir(lock);
      locked = true;
    } catch {
      report.status = "blocked";
      report.reason = "Another native verification holds lock";
      return report;
    }
    const repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(root, "tmp"));
    const env = isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin");
    env.LITELLM_LOCAL_MODEL_COST_MAP = "True";
    env.AIDER_ANALYTICS = "false";
    const checked = async (
      command: string,
      args: string[],
      timeoutMs = 20_000,
    ) => {
      const r = await runProcess(command, args, {
        cwd: repo,
        env,
        timeoutMs,
        ...(guard ? { signal: guard.signal } : {}),
      });
      if (r.code !== 0 || r.timedOut)
        throw Error(
          `${command} ${args[0]} failed (${r.timedOut ? "deadline" : r.code})`,
        );
      return r.stdout;
    };
    const python = options.binary ?? "python3";
    try {
      report.version = (
        await checked(python, [
          "-c",
          'from importlib.metadata import version; print(version("aider-chat"))',
        ])
      ).trim();
    } catch {
      report.status = "blocked";
      report.reason = "Selected Python cannot import Aider";
      return report;
    }
    await checked("git", ["init", "--quiet"]);
    await writeFile(
      join(repo, ".cledger.json"),
      JSON.stringify({ transport: { hook: false, fetchRefspec: false } }),
    );
    const marker = `cledger-probe-${randomUUID()}`,
      secret = `file-value-${randomUUID()}`;
    await writeFile(join(repo, "evidence.txt"), secret + "\n");
    await checked("git", ["add", "."]);
    await checked("git", ["commit", "--quiet", "-m", "isolated verification"]);
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No local server address");
    guard = await startGuard(`http://127.0.0.1:${address.port}/v1`, 2);
    env.OPENAI_API_BASE = guard.endpoint;
    env.OPENAI_API_KEY = "TESTONLY-local-provider";
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const nativeArgs = [
        cli,
        "run",
        "aider",
        "--python",
        python,
        "--",
        "--model",
        "openai/fixture",
        "--weak-model",
        "openai/fixture",
        "--edit-format",
        "whole",
        "--no-stream",
        "--yes",
        "--no-pretty",
        "--no-fancy-input",
        "--no-check-update",
        "--no-show-release-notes",
        "--no-show-model-warnings",
        "--no-analytics",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-gitignore",
        "--no-detect-urls",
        "--no-auto-lint",
        "--no-auto-test",
        "--map-tokens",
        "0",
        ...(!options.interactive ? ["--message", `${marker}. Preserve the first line of evidence.txt and add a second line verified.`] : []),
        "evidence.txt",
      ];
    if (options.interactive) {
      delete env.CI; delete env.NO_COLOR; env.TERM = "xterm-256color";
      const terminal = await runPty(process.execPath, nativeArgs, {
        cwd: repo, env, timeoutMs: options.timeoutMs ?? 90_000,
        actions: [
          { waitFor: "> ", send: `${marker}. Preserve the first line of evidence.txt and add a second line verified.\r` },
          { waitFor: "Applied edit to evidence.txt", send: "/exit\r" },
        ],
      });
      report.gates.interactiveTerminal = terminal.actionsCompleted === 2 && !terminal.timedOut && terminal.code === 0;
      if (!report.gates.interactiveTerminal) throw Error(`Interactive terminal incomplete: actions=${terminal.actionsCompleted}, code=${terminal.code}, timeout=${terminal.timedOut}; tail=${terminalTail(terminal.output)}`);
    } else await checked(process.execPath, nativeArgs, options.timeoutMs ?? 90_000);
    const read = async () =>
      (await checked(process.execPath, [cli, "export", "--all"]))
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s) as EvidenceEvent);
    const baseline = await read();
    report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(baseline, "aider");
    Object.assign(report.gates, aiderEvidenceGates(baseline, marker, secret));
    report.gates.fileChanged = (
      await readFile(join(repo, "evidence.txt"), "utf8")
    ).includes(secret + "\nverified");
    if (!Object.values(report.gates).every(Boolean))
      throw Error("Recorder evidence incomplete before explicit backfill");
    const backfill = join(root, "backfill.mjs");
    await writeFile(
      backfill,
      `import {captureAiderAll} from ${JSON.stringify(new URL("../adapters/aider.js", import.meta.url).href)};await captureAiderAll(process.cwd());`,
    );
    await checked(process.execPath, [backfill]);
    const first = await read();
    await checked(process.execPath, [backfill]);
    const second = await read();
    const ids = (events: EvidenceEvent[]) =>
      events
        .map((e) => e.id)
        .sort()
        .join("\n");
    report.gates.backfillIdempotent =
      ids(baseline) === ids(first) && ids(first) === ids(second);
    report.gates.requests = requests === 1;
    report.status = Object.values(report.gates).every(Boolean)
      ? "pass"
      : "fail";
  } catch (error) {
    report.status = "fail";
    report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    if (guard) {
      report.requests = guard.state.forwarded;
      if (guard.state.blocked) {
        report.status = "blocked";
        report.reason = guard.state.blocked;
      }
      await guard.close();
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
    if (locked) await rm(lock, { recursive: true, force: true });
    report.durationMs = Date.now() - start;
  }
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = await verifyScriptedAider(
    { ...(process.env.CLEDGER_VERIFY_BINARY ? { binary: process.env.CLEDGER_VERIFY_BINARY } : {}), interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1" },
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode =
    report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
