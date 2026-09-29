import { hasUnrecognizedEvidence } from "./drift.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runPty, terminalTail } from "./pty.js";
import { isolatedEnvironment, runProcess } from "./process.js";
import { startGuard } from "./guard.js";
import { startScriptedProvider } from "./scripted.js";
import type { Report, Options } from "./opencode.js";
import type { EvidenceEvent } from "../schema.js";

export type CopilotReport = Omit<Report, "cli"> & { cli: "copilot" };

export function copilotEvidenceGates(
  events: EvidenceEvent[],
  marker: string,
  secret: string,
): Record<string, boolean> {
  const blocks = (e: EvidenceEvent) =>
    (e.content as { blocks?: Record<string, unknown>[] })?.blocks ?? [];
  const source = events.filter((e) => e.producer.source === "copilot");
  const human = source.find(
    (e) =>
      e.actor.type === "human" &&
      blocks(e).some(
        (b) => b.type === "text" && String(b.text).includes(marker),
      ),
  );
  const session = human?.stream?.id;
  const own = session ? source.filter((e) => e.stream?.id === session) : [];
  const calls = new Set(
    own
      .flatMap((e) => blocks(e))
      .filter(
        (b) =>
          b.type === "tool_use" &&
          b.name === "view" &&
          typeof b.id === "string" &&
          JSON.stringify(b.input).includes("evidence.txt"),
      )
      .map((b) => b.id),
  );
  return {
    hookPrompt: !!human,
    hookToolUse: calls.size > 0,
    hookToolResult: own.some(
      (e) =>
        e.actor.type === "system" &&
        blocks(e).some(
          (b) =>
            b.type === "tool_result" &&
            calls.has(b.tool_use_id) &&
            b.is_error !== true &&
            JSON.stringify(b.content).includes(secret),
        ),
    ),
    hookAnswer: own.some(
      (e) =>
        e.actor.type === "agent" &&
        blocks(e).some(
          (b) => b.type === "text" && String(b.text).includes(secret),
        ),
    ),
  };
}

/** Zero-inference native headless check; the fixture supplies a real view tool call. */
export async function verifyScriptedCopilot(
  options: Pick<Options, "binary" | "timeoutMs" | "pollMs"> & {
    interactive?: boolean;
  } = {},
): Promise<CopilotReport> {
  const start = Date.now();
  const report: CopilotReport = {
    schema: "cledger-verification/1",
    cli: "copilot",
    status: "not-run",
    certification: "native-smoke",
    inference: "scripted",
    platform: `${process.platform}/${process.arch}`,
    gates: {},
    durationMs: 0,
    coverage: [
      "native headless hook capture",
      "human text",
      "read tool call/result",
      "assistant text",
      "backfill idempotency",
    ],
    exclusions: [
      "individual agentStop versus sessionEnd timing",
      "interactive TUI",
      "ACP/daemon",
      "attachments",
      "subagents",
      "compaction/rewind",
      "real model/provider behavior",
      "full record coverage",
    ],
  };
  report.mode = options.interactive ? "interactive" : "headless";
  if (!["darwin", "linux"].includes(process.platform)) {
    report.reason = "Unsupported platform";
    return report;
  }
  const root = await mkdtemp(join(tmpdir(), "cledger-copilot-native-"));
  const lock = join(tmpdir(), "cledger-native-inference.lock");
  let locked = false;
  let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
  try {
    try {
      await mkdir(lock);
      locked = true;
    } catch {
      report.status = "blocked";
      report.reason = "Another native verification holds the inference lock";
      return report;
    }
    const repo = join(root, "repo"),
      bin = join(root, "bin"),
      cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    await Promise.all(
      [repo, bin, join(root, "tmp"), join(root, ".copilot")].map((p) =>
        mkdir(p, { recursive: true }),
      ),
    );
    const env = isolatedEnvironment(
      root,
      `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    );
    env.COPILOT_HOME = join(root, ".copilot");
    await writeFile(
      join(bin, "cledger"),
      `#!${process.execPath}\nimport(${JSON.stringify(cli)});\n`,
      { mode: 0o755 },
    );
    if (options.binary)
      await symlink(resolve(options.binary), join(bin, "copilot"));
    const checked = async (
      command: string,
      args: string[],
      timeoutMs = 20_000,
    ) => {
      const result = await runProcess(command, args, {
        cwd: repo,
        env,
        timeoutMs,
        ...(guard ? { signal: guard.signal } : {}),
      });
      if (result.code !== 0 || result.timedOut)
        throw new Error(
          `${command} ${args[0]} failed (${result.timedOut ? "deadline" : `exit ${result.code}`})`,
        );
      return result.stdout;
    };
    try {
      report.version = (await checked("copilot", ["--version"])).trim();
    } catch {
      report.status = "blocked";
      report.reason = "Copilot executable unavailable or version probe failed";
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
    provider = await startScriptedProvider({
      toolName: "view",
      toolArguments: { path: join(repo, "evidence.txt") },
    });
    guard = await startGuard(provider.endpoint);
    env.COPILOT_PROVIDER_API_KEY = "TESTONLY-local-verification";
    env.COPILOT_PROVIDER_BASE_URL = guard.endpoint;
    env.COPILOT_PROVIDER_TYPE = "openai";
    env.COPILOT_PROVIDER_WIRE_API = "completions";
    env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = "1024";
    env.COPILOT_MODEL = "fixture";
    await checked(process.execPath, [cli, "install", "copilot"]);
    const settings = JSON.parse(
      await readFile(join(root, ".copilot", "hooks", "cledger.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    report.gates.installedHooks =
      !!settings.hooks?.agentStop && !!settings.hooks?.sessionEnd;
    if (options.interactive) {
      delete env.CI;
      delete env.NO_COLOR;
      env.TERM = "xterm-256color";
      report.coverage = [
        "interactive PTY terminal input",
        "native hook capture",
        "read tool call/result",
        "assistant text",
        "backfill idempotency",
      ];
      report.exclusions = report.exclusions?.filter(
        (x) => x !== "interactive TUI",
      );
      const terminal = await runPty(
        "copilot",
        [
          "--allow-tool",
          "view",
          "--disable-builtin-mcps",
          "--no-auto-update",
          "--no-custom-instructions",
          "--no-ask-user",
          "--no-remote-export",
        ],
        {
          cwd: repo,
          env,
          timeoutMs: options.timeoutMs ?? 60000,
          actions: [
            { waitFor: "remember this folder", send: "\r" },
            {
              waitFor: "Type|Ask|> |❯",
              send: `${marker}. Read evidence.txt using view and reply with its exact contents.\r`,
            },
            { waitFor: secret, send: "/quit\r" },
          ],
        },
      );
      report.gates.interactiveTerminal =
        terminal.actionsCompleted === 3 &&
        !terminal.timedOut &&
        terminal.code === 0;
      if (!report.gates.interactiveTerminal)
        throw new Error(
          `Interactive terminal incomplete: actions=${terminal.actionsCompleted}, code=${terminal.code}, timeout=${terminal.timedOut}; tail=${terminalTail(terminal.output)}`,
        );
    } else
      await checked(
        "copilot",
        [
          "-p",
          `${marker}. Read evidence.txt using view and reply with its exact contents.`,
          "--output-format",
          "json",
          "--stream",
          "on",
          "--allow-tool",
          "view",
          "--disable-builtin-mcps",
          "--no-auto-update",
          "--no-custom-instructions",
          "--no-ask-user",
          "--no-remote-export",
        ],
        options.timeoutMs ?? 60_000,
      );
    const read = async (): Promise<EvidenceEvent[]> =>
      (await checked(process.execPath, [cli, "export", "--all"]))
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s) as EvidenceEvent);
    let events: EvidenceEvent[] = [];
    const deadline = Date.now() + (options.pollMs ?? 10_000);
    do {
      events = await read();
      report.gates.noUnrecognizedRecords = !hasUnrecognizedEvidence(
        events,
        "copilot",
      );
      const tails = join(repo, ".git", "cledger-copilot-tail");
      const files = await readdir(tails).catch(() => []);
      report.gates.tailComplete =
        files.some((f) => f.endsWith(".json")) &&
        !files.some((f) => f.endsWith(".lock"));
      for (const file of files.filter((f) => f.endsWith(".json")))
        report.gates.tailComplete &&=
          JSON.parse(await readFile(join(tails, file), "utf8")).status ===
          "complete";
      report.gates.terminalRecord = events.some(
        (e) => (e.raw?.data as { type?: string })?.type === "session.shutdown",
      );
      Object.assign(report.gates, copilotEvidenceGates(events, marker, secret));
      if (Object.values(report.gates).every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);
    if (!Object.values(report.gates).every(Boolean))
      throw new Error(
        "Native hook evidence incomplete; no manual capture attempted",
      );
    await checked(process.execPath, [cli, "capture", "copilot", "--all"]);
    const first = await read();
    await checked(process.execPath, [cli, "capture", "copilot", "--all"]);
    const second = await read();
    const ids = (items: EvidenceEvent[]) =>
      items
        .map((e) => e.id)
        .sort()
        .join("\n");
    report.gates.backfillIdempotent =
      ids(events) === ids(first) && ids(first) === ids(second);
    if (!report.gates.backfillIdempotent)
      report.reason = `Manual backfill added native record types: ${[...new Set(first.filter((e) => !events.some((h) => h.id === e.id)).map((e) => (e.raw?.data as { type?: string })?.type ?? e.kind))].join(", ")}`;
    report.gates.hookEvidenceRetained = events.every((e) =>
      second.some((s) => s.id === e.id),
    );
    report.gates.scriptedRequests =
      provider.state.requests > 0 && provider.state.requests <= 4;
    report.gates.agentHeader = provider.state.headersValid;
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
    await provider?.close();
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
  const report = await verifyScriptedCopilot({
    ...(process.env.CLEDGER_VERIFY_BINARY
      ? { binary: process.env.CLEDGER_VERIFY_BINARY }
      : {}),
    interactive: process.env.CLEDGER_VERIFY_INTERACTIVE === "1",
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode =
    report.status === "fail" ? 1 : report.status === "blocked" ? 2 : 0;
}
