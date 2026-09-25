#!/usr/bin/env node
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { stdin as input } from "node:process";
import { findRepo, runRecordsCommand, type RepoInfo } from "annals";
import {
  appendEvents,
  NOTES_REF,
  parsePrePushRefs,
  readEvents,
  ScanBlockedError,
  sortEvents,
  transportPush,
  type ReadOptions,
} from "./store.js";
import { asLedger } from "./ledger.js";
import {
  parseEventLine,
  SESSION_MACHINERY_KINDS,
  type EventDraft,
  type EvidenceEvent,
} from "./schema.js";
import {
  runClaudeCodeHook,
  captureClaudeAll,
  captureClaudeTranscript,
} from "./adapters/claude-code.js";
import { runCodexHook, captureCodexTranscript } from "./adapters/codex.js";
import {
  runOpencodeHook,
  captureOpencodeAll,
  captureOpencodeExportFile,
  captureOpencodeSession,
} from "./adapters/opencode.js";
import {
  runGeminiHook,
  captureGeminiAll,
  captureGeminiTranscript,
} from "./adapters/gemini-cli.js";
import { runQwenHook, captureQwenAll, captureQwenTranscript } from "./adapters/qwen-code.js";
import { renormalize } from "./renormalize.js";
import { installAdapters } from "./install.js";
import {
  filterFindings,
  findingGuidance,
  formatFinding,
  formatGroupedReport,
  loadAllowlist,
  loadConfig,
  scanEvents,
} from "./redact.js";

const USAGE = `conversation-ledger — durable records of coding-agent conversations, in git notes

Usage:
  cledger append [--quiet]                 append JSONL events/drafts from stdin
  cledger log [--all|--rev R] [--kind K] [--source S] [--model M] [--conversation C] [--json]
              [--with-reasoning] [--with-state]
                                           --model matches producer.model exactly, e.g. gpt-5.6-sol
  cledger show <conversation-id-prefix> [--json] [--with-reasoning] [--with-state]
                                           opaque provider-encrypted \`reasoning\` events are hidden
                                           by default on log/show; --with-reasoning reveals them.
                                           So are the session-machinery kinds (session_state,
                                           activity, context_injection, file_snapshot), which a
                                           session emits far more often than turns — except the
                                           ones the source attributes to a human (a slash command,
                                           an @-command, an explicit rewind), which show by
                                           default; --with-state reveals the harness's and the
                                           agent's bookkeeping too.
                                           Both are always captured and exported —
                                           these flags only affect what is displayed
  cledger conversations [--rev R] [--with-reasoning] [--with-state]
                                           list conversations on current branch (--all for every branch),
                                           one line each: id, source, model(s), count, time span
  cledger export [--all|--rev R]          lossless JSONL dump of every field, incl. reasoning;
                                           scoped to the current branch like log, --all for the
                                           whole local ledger
  cledger records <command> [options]       shared ledger maintenance commands:
      sync [remote] [--fetch-only|--push-only] [--all] [--no-scan] [--paranoid] [--report]
      review [--tier standard|paranoid] [--context N]        HUMAN ONLY
      inspect --output FILE [--tier standard|paranoid] [--context N] [--reveal]  HUMAN ONLY
      redact EVENT_ID (--pattern REGEX|--all) [--reason TEXT]  HUMAN ONLY
      allow FINGERPRINT... [--global]                        HUMAN ONLY
      reanchor [--target REV] [--apply]
      reanchor manual OLD_REV... --onto NEW_REV                HUMAN ONLY
      transport-push [remote] [--report]                      hook entrypoint
                                           sync --no-scan can push only from a plain human session.
                                           Use cledger records --help for full command usage.
  cledger sync|review|inspect|redact|allow|re-anchor ...
                                           top-level aliases for the same records commands
  cledger transport-push [remote]         installed pre-push hook ABI (fail-open unless strict)
  cledger scan [--all|--rev R] [--paranoid] [--report]
                                           scan local events; exit 1 on findings, 0 otherwise
  cledger renormalize                      re-interpret preserved unrecognized transcript lines this
                                           cledger version can now parse into their proper kind
                                           (conversation_turn, session_state, activity, ...),
                                           superseding the raw-only placeholders (append-only, idempotent)
  cledger install <claude-code|codex|opencode|gemini-cli|qwen-code|all>
                                           hook capture into coding CLIs (global)
  cledger hook <claude-code|codex|opencode|gemini-cli|qwen-code>
                                           capture entrypoint invoked by CLI hooks (stdin: hook payload)
  cledger capture codex --transcript PATH  manual/backfill ingestion
  cledger capture <claude-code|gemini-cli|qwen-code> [--transcript PATH | --all]
                                           all three keep per-project session logs; --all backfills
                                           every session the CLI scopes to this exact directory,
                                           including ones cledger has never seen (the hook's own
                                           catch-up sweep is deliberately narrower — it only finishes
                                           sessions cledger already tracks)
  cledger capture opencode [--session ID | --all | --transcript EXPORT.json]
                                           opencode keeps sessions in SQLite, not a transcript file,
                                           so capture shells out to \`opencode export\`; --all sweeps
                                           every session opencode scopes to this project
  cledger --version | --help

Events are anchored to the HEAD commit at capture time and stored under
refs/notes/conversation-ledger, so they follow branches through merges and
sync only when you say so.`;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

interface Flags {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function requireRepo(): Promise<RepoInfo> {
  const repo = await findRepo(process.cwd());
  if (!repo) {
    process.stderr.write("cledger: not inside a git repository\n");
    process.exit(2);
  }
  return repo;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function readOptionsFrom(flags: Flags): ReadOptions {
  const opts: ReadOptions = {};
  // `null` is the opt-out now that `undefined` means HEAD; leaving it unset
  // under --all would ask for exactly the scope the flag exists to escape.
  opts.reachableFrom = flags["all"]
    ? null
    : typeof flags["rev"] === "string"
      ? flags["rev"]
      : "HEAD";
  if (typeof flags["kind"] === "string") opts.kind = flags["kind"];
  if (typeof flags["source"] === "string") opts.source = flags["source"];
  if (typeof flags["model"] === "string") opts.model = flags["model"];
  if (typeof flags["conversation"] === "string") opts.stream = flags["conversation"];
  return opts;
}

/**
 * The one-line preview `log` shows per event. Record kinds lead with the
 * source's own type name (`mode`, `event_msg/token_count`) because that is
 * what distinguishes one from the next — falling straight through to
 * `JSON.stringify` would show every `session_state` line as the same wall of
 * envelope fields.
 */
function snippet(event: EvidenceEvent): string {
  const c = event.content as Record<string, unknown> | string | null;
  let text = "";
  if (typeof c === "string") text = c;
  else if (c && typeof c === "object") {
    const label = c["state_type"] ?? c["activity_type"] ?? c["injection_type"] ?? c["operation"];
    const body = c["text"] ?? c["summary"] ?? c["title"];
    if (typeof label === "string") {
      text = `${label}  ${typeof body === "string" ? body : JSON.stringify(c)}`;
    } else {
      text = String(body ?? JSON.stringify(c));
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 100 ? text.slice(0, 97) + "..." : text;
}

/**
 * Errno codes that all mean the same thing: whoever was reading our stdout is
 * gone.
 *
 * `EPIPE` is the textbook one and the only one worth expecting on Linux. macOS
 * produces the other two as well, because Node does not always back stdio with
 * a pipe there — when it is a socket, a write after the peer has closed
 * reports `ENOTCONN` (observed: `cledger log --json | head -1` exiting 1 with
 * `write ENOTCONN` on macOS, but only under enough concurrent load to change
 * how far the teardown had progressed) and a half-closed one can report
 * `ECONNRESET`. Matching only `EPIPE` therefore fixed the stack trace but left
 * a nonzero exit on the same command, on the platform this is developed on.
 * The distinction is an accident of what kind of file descriptor Node handed
 * us, never of what the user did.
 */
const READER_GONE = new Set(["EPIPE", "ENOTCONN", "ECONNRESET"]);

/**
 * Exit quietly when the reader closes the pipe.
 *
 * `cledger export | head -1` is ordinary usage, and without this handler it
 * printed a stack trace instead of output: `process.stdout` had no `error`
 * listener, so the error Node raises once the reader is gone surfaced as an
 * unhandled `error` event. Small ledgers hide it, because the whole payload
 * fits the 64KB pipe buffer before `head` exits and the write never fails;
 * anything larger throws every time.
 *
 * A reader that stopped reading is not a failure of ours, so it exits 0 — the
 * convention every `head`-friendly CLI follows. Any other stdout error is real
 * and still reported, but as a message rather than a stack trace.
 */
function guardStdout(): void {
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code && READER_GONE.has(err.code)) process.exit(0);
    process.stderr.write(`cledger: stdout: ${err.message}\n`);
    process.exit(1);
  });
}

/**
 * Write one line, pausing whenever the consumer falls behind.
 *
 * Two reasons this is not a bare `process.stdout.write`. Ignoring
 * backpressure buffers an entire ledger in memory before a slow reader sees
 * any of it. And `write()` reports EPIPE *asynchronously*, so a synchronous
 * loop runs to completion after the reader has already gone — awaiting
 * `drain` is what gives the handler above a chance to fire, making the exit
 * prompt rather than merely quiet.
 *
 * Waiting cannot hang on a closed stream: a destroyed stdout emits `error`,
 * and `guardStdout`'s listener is registered first and exits the process.
 */
async function writeOut(text: string): Promise<void> {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}

/**
 * Position of each event within its own conversation, for display.
 *
 * `conversation.seq` is an ordering key, not a counter — adapters are free to
 * derive it from whatever the source makes stable, and the opencode adapter
 * now takes it from the part id, which is a 48-bit timestamp. Printing that
 * raw turned every opencode row into `opencode:9f2a#67580218395`. What a
 * reader wants there is "where in the conversation is this", so `log` ranks
 * the events it has and prints the rank.
 *
 * Ranked over the events the read returned, before the display filter narrows
 * them — so hiding the harness's bookkeeping does not renumber the turns
 * around it. A filter applied at read time (`--kind`, `--source`,
 * `--conversation`) does narrow what there is to rank, which makes the number
 * a position within the view you asked for rather than an absolute index into
 * the conversation. That is the honest reading of it either way: the ledger
 * only ever holds what it captured.
 */
function ordinals(events: EvidenceEvent[]): Map<string, number> {
  const byConversation = new Map<string, EvidenceEvent[]>();
  for (const e of events) {
    if (!e.stream) continue;
    const bucket = byConversation.get(e.stream.id);
    if (bucket) bucket.push(e);
    else byConversation.set(e.stream.id, [e]);
  }
  const rank = new Map<string, number>();
  for (const bucket of byConversation.values()) {
    bucket.sort((a, b) => a.stream!.seq - b.stream!.seq);
    // Ties share a rank: a reasoning blob and the turn it belongs to are
    // deliberately written at the same seq, and numbering one of them second
    // would invent an ordering the adapter went out of its way not to assert.
    let position = 0;
    let previousSeq: number | null = null;
    for (const e of bucket) {
      if (previousSeq === null || e.stream!.seq !== previousSeq) position++;
      previousSeq = e.stream!.seq;
      rank.set(e.id, position);
    }
  }
  return rank;
}

async function printHuman(events: EvidenceEvent[], rank?: Map<string, number>): Promise<void> {
  for (const e of events) {
    const position = rank?.get(e.id) ?? e.stream?.seq;
    const conv = e.stream ? `${e.stream.id.slice(0, 28)}#${position}` : "-";
    const role =
      (e.content as Record<string, unknown> | null | undefined) &&
      typeof e.content === "object"
        ? String((e.content as Record<string, unknown>)["role"] ?? e.actor.type)
        : e.actor.type;
    await writeOut(`${e.occurred_at}  ${e.kind}  ${role.padEnd(9)}  ${conv}  ${snippet(e)}\n`);
  }
}

/**
 * What `log`/`show`/`conversations` leave out unless asked.
 *
 * Two groups are hidden by default, for two different reasons. `reasoning`
 * events are opaque ciphertext, never meant for a human-facing transcript.
 * The session-machinery kinds (see SESSION_MACHINERY_KINDS) are meaningful,
 * but a session declares its mode, its tracked files and its token counts far
 * more often than anyone speaks — showing them by default would bury the
 * conversation in its own bookkeeping.
 *
 * **The machinery half is filtered by actor, not by kind.** Hiding the whole
 * kind was drawing the line in the wrong place: it earns its keep against
 * telemetry — one real Qwen session emitted 57 `ui_telemetry` records against
 * 45 events of actual content — but a slash command the human typed is not
 * telemetry, and was being hidden by the same rule as a token-count ping. What
 * makes a record noise is *whose* action it was, so a machinery event with a
 * human actor shows by default and the harness's and the agent's bookkeeping
 * stays behind `--with-state`. Nothing about capture changes: every record is
 * still stored and `cledger export` is still lossless.
 *
 * `--with-reasoning` / `--with-state` opt in, as does asking for the kind
 * explicitly via `--kind` (hiding it there would just return nothing).
 * `export`'s job is a lossless dump, so it never filters and needs no
 * equivalent flag; neither does capture, which records all of it regardless.
 */
function displayFilter(flags: Flags, opts: ReadOptions): (event: EvidenceEvent) => boolean {
  const reasoning = flags["with-reasoning"] === true || opts.kind === "reasoning";
  const state =
    flags["with-state"] === true || (typeof opts.kind === "string" && SESSION_MACHINERY_KINDS.has(opts.kind));
  return (event) => {
    if (!reasoning && event.kind === "reasoning") return false;
    if (!state && SESSION_MACHINERY_KINDS.has(event.kind) && event.actor.type !== "human")
      return false;
    return true;
  };
}

async function printJsonl(events: EvidenceEvent[], includeRaw: boolean): Promise<void> {
  for (const e of events) {
    const out = includeRaw ? e : { ...e, raw: undefined };
    await writeOut(JSON.stringify(out) + "\n");
  }
}

async function cmdAppend(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const body = await readStdin();
  const drafts: EventDraft[] = body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EventDraft);
  if (drafts.length === 0) return;
  const result = await appendEvents(repo, drafts);
  if (!flags["quiet"]) {
    for (const e of result.appended) process.stdout.write(e.id + "\n");
    process.stderr.write(
      `appended ${result.appended.length}, deduped ${result.deduped}` +
        (result.anchor ? ` (anchor ${result.anchor.slice(0, 12)})` : " (pending: no commits yet)") +
        "\n",
    );
  }
}

async function cmdLog(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const opts = readOptionsFrom(flags);
  const all = await readEvents(repo, opts);
  const events = all.filter(displayFilter(flags, opts));
  // Ranked over `all`, not `events`: the display filter hides bookkeeping, and
  // hiding it must not renumber the turns around it. `--json` is untouched —
  // it prints the stored `seq`, because a machine reading the ledger wants the
  // real ordering key, not a per-view position.
  if (flags["json"]) await printJsonl(events, false);
  else await printHuman(events, ordinals(all));
}

async function cmdShow(positional: string[], flags: Flags): Promise<void> {
  const prefix = positional[0];
  if (!prefix) {
    process.stderr.write("usage: cledger show <conversation-id-prefix>\n");
    process.exit(2);
  }
  const repo = await requireRepo();
  // Deliberately the whole local ledger: you named one conversation, so
  // reachability is not the question you asked, and scoping would answer "no
  // such conversation" for one captured on a branch you are not standing on.
  let events = await readEvents(repo, { stream: prefix, reachableFrom: null });
  events = events.filter(displayFilter(flags, {}));
  if (events.length === 0) {
    process.stderr.write(`no events for conversation ${prefix}\n`);
    process.exit(1);
  }
  if (flags["json"]) {
    await printJsonl(events, true);
    return;
  }
  for (const e of sortEvents(events)) {
    const c = e.content as Record<string, unknown>;
    const role = typeof c === "object" && c ? String(c["role"] ?? e.actor.type) : e.actor.type;
    const text =
      typeof c === "object" && c && typeof c["text"] === "string"
        ? (c["text"] as string)
        : JSON.stringify(e.content, null, 2);
    await writeOut(`\n[${e.occurred_at}] ${role} (${e.kind}, ${e.id.slice(0, 16)})\n`);
    await writeOut(text.trimEnd() + "\n");
  }
}

async function cmdConversations(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const opts = readOptionsFrom(flags);
  let events = await readEvents(repo, opts);
  events = events.filter(displayFilter(flags, opts));
  const byConv = new Map<
    string,
    { count: number; first: string; last: string; source: string; models: Set<string> }
  >();
  for (const e of events) {
    const id = e.stream?.id ?? "(none)";
    const entry = byConv.get(id) ?? {
      count: 0,
      first: e.occurred_at,
      last: e.occurred_at,
      source: e.producer.source ?? e.producer.tool,
      models: new Set<string>(),
    };
    entry.count++;
    // A conversation can legitimately list several models — codex restates
    // `turn_context` when the user switches mid-session, and a claude-code
    // session mixes real model ids with `<synthetic>` harness messages.
    if (e.producer.model) entry.models.add(e.producer.model);
    if (e.occurred_at < entry.first) entry.first = e.occurred_at;
    if (e.occurred_at > entry.last) entry.last = e.occurred_at;
    byConv.set(id, entry);
  }
  for (const [id, s] of [...byConv.entries()].sort((a, b) => a[1].last.localeCompare(b[1].last))) {
    const models = s.models.size > 0 ? [...s.models].sort().join(",") : "-";
    await writeOut(`${id}  ${s.source}  ${models}  ${s.count} events  ${s.first} .. ${s.last}\n`);
  }
}

/**
 * `export` is lossless about each event — every field, `raw` and `reasoning`
 * included — but that is a statement about *what* it prints, not about *how
 * much*. It now scopes to the current branch like `log` does, because a dump
 * that silently carries conversations from branches that were abandoned and
 * never merged is not a neutral default for the consumers reading it. `--all`
 * restores the whole local ledger.
 */
async function cmdExport(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const opts: ReadOptions = {
    reachableFrom: flags["all"] ? null : typeof flags["rev"] === "string" ? flags["rev"] : "HEAD",
  };
  const events = await readEvents(repo, opts);
  await printJsonl(events, true);
}

async function cmdScan(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const tier: "standard" | "paranoid" = flags["paranoid"] ? "paranoid" : "standard";
  // Every local event unless --rev narrows it: a standalone scan is a safety
  // pass, and a secret on a branch you are not standing on is still a secret
  // you want told about. (The *push* gate scopes to what the push carries —
  // that is a different question, asked in transportPush.)
  const opts: ReadOptions = {
    reachableFrom: typeof flags["rev"] === "string" ? flags["rev"] : null,
  };
  const events = await readEvents(repo, opts);
  const config = await loadConfig(repo);
  const findings = filterFindings(scanEvents(events, tier), await loadAllowlist(repo, config));
  if (findings.length === 0) {
    process.stderr.write("cledger scan: no findings\n");
    return;
  }
  const eventIds = [...new Set(findings.map((f) => f.eventId))];
  const spans = new Set(findings.map((f) => f.fingerprint)).size;
  process.stderr.write(
    `cledger scan: ${spans} distinct potential secret(s) ` +
      `(${findings.length} match site(s) across ${eventIds.length} event(s))\n`,
  );
  if (flags["report"] === true) {
    // The report is deliberately opt-in. It contains coordinates and
    // fingerprints only, never the match or its surrounding text.
    for (const f of findings) process.stdout.write(formatFinding(f) + "\n");
    process.stderr.write(`\n${formatGroupedReport(findings)}\n`);
    process.stderr.write(`\n${findingGuidance(eventIds)}\n`);
  } else {
    process.stderr.write(
      "\n  Finding details were suppressed.\n\n" +
        "  If you are a HUMAN: rerun this same scan in a plain terminal, outside\n" +
        "  any agent, adding --report.\n" +
        "  The report contains coordinates and fingerprints, never matched text\n" +
        "  or surrounding context.\n\n" +
        "  If you are an AGENT: stop here and hand this to the human. Do not add\n" +
        "  --report or run cledger review, inspect, export, or otherwise read the\n" +
        "  flagged content — it would be captured into this conversation.\n",
    );
  }
  process.exit(1);
}

async function cmdRenormalize(): Promise<void> {
  const repo = await requireRepo();
  const result = await renormalize(repo);
  process.stderr.write(
    `cledger renormalize: scanned ${result.scanned}, interpreted ${result.interpreted} ` +
      `(+${result.turnsAppended} turn(s), +${result.supersessionsAppended} supersession(s)), ` +
      `skipped ${result.skipped} still-unrecognized\n`,
  );
}

async function cmdTransportPush(remote: string | undefined): Promise<void> {
  // Keep the installed hook fail-open even if repository discovery or
  // configuration loading fails before annals reaches its transport handler.
  try {
    const repo = await findRepo(process.cwd());
    if (!repo) return;
    let refs: string[] = [];
    if (process.stdin.isTTY !== true) {
      try {
        refs = parsePrePushRefs(await readStdin());
      } catch {
        refs = [];
      }
    }
    await transportPush(repo, remote ?? "origin", refs);
  } catch (err) {
    if (err instanceof ScanBlockedError) {
      process.stderr.write("cledger: entire push blocked (transport.strict is enabled)\n");
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `cledger: transport-push error (push continues): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

const RECORD_ALIASES = new Map([
  ["sync", "sync"],
  ["review", "review"],
  ["inspect", "inspect"],
  ["redact", "redact"],
  ["allow", "allow"],
  ["re-anchor", "reanchor"],
]);

async function cmdRecords(argv: string[]): Promise<void> {
  const repo = await findRepo(process.cwd());
  if (!repo) {
    process.stderr.write("cledger: not inside a git repository\n");
    process.exitCode = 2;
    return;
  }
  process.exitCode = await runRecordsCommand({
    ledger: asLedger(repo),
    argv,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    commandName: "cledger records",
  });
}

async function main(): Promise<void> {
  guardStdout();
  const [, , command, ...rest] = process.argv;

  if (!command || command === "--help" || command === "help") {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (command === "--version") {
    process.stdout.write(version() + "\n");
    return;
  }
  if (command === "records") return cmdRecords(rest);
  if (command === "transport-push") return cmdTransportPush(rest[0]);
  const alias = RECORD_ALIASES.get(command);
  if (alias) return cmdRecords([alias, ...rest]);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "append":
      return cmdAppend(flags);
    case "log":
      return cmdLog(flags);
    case "show":
      return cmdShow(positional, flags);
    case "conversations":
      return cmdConversations(flags);
    case "export":
      return cmdExport(flags);
    case "scan":
      return cmdScan(flags);
    case "renormalize":
      return cmdRenormalize();
    case "install":
      return installAdapters(positional[0] ?? "all");
    case "hook": {
      if (positional[0] === "claude-code") {
        return runClaudeCodeHook(await readStdin());
      }
      if (positional[0] === "codex") {
        return runCodexHook(await readStdin());
      }
      if (positional[0] === "opencode") {
        return runOpencodeHook(await readStdin());
      }
      if (positional[0] === "gemini-cli") {
        return runGeminiHook(await readStdin());
      }
      if (positional[0] === "qwen-code") {
        return runQwenHook(await readStdin());
      }
      process.stderr.write(`unknown hook source: ${positional[0]}\n`);
      process.exit(2);
      return;
    }
    case "capture": {
      const source = positional[0];
      const transcript = typeof flags["transcript"] === "string" ? flags["transcript"] : undefined;
      if (source === "claude-code") {
        if (transcript) {
          await captureClaudeTranscript(transcript, process.cwd());
          return;
        }
        if (flags["all"]) {
          await captureClaudeAll(process.cwd());
          return;
        }
        process.stderr.write("usage: cledger capture claude-code (--transcript PATH | --all)\n");
        process.exit(2);
        return;
      }
      if (source === "codex" && transcript) {
        await captureCodexTranscript(transcript, process.cwd());
        return;
      }
      // gemini-cli and qwen-code both keep a per-project session log, so a
      // sweep is scoped by the CLI's own project directory for this cwd.
      if (source === "gemini-cli" || source === "qwen-code") {
        const captureOne = source === "gemini-cli" ? captureGeminiTranscript : captureQwenTranscript;
        const captureAll = source === "gemini-cli" ? captureGeminiAll : captureQwenAll;
        if (transcript) {
          await captureOne(transcript, process.cwd());
          return;
        }
        if (flags["all"]) {
          await captureAll(process.cwd());
          return;
        }
        process.stderr.write(`usage: cledger capture ${source} (--transcript PATH | --all)\n`);
        process.exit(2);
        return;
      }
      if (source === "opencode") {
        // opencode has no transcript file; --transcript takes a saved
        // `opencode export` JSON so backfill works without opencode present.
        const session = typeof flags["session"] === "string" ? flags["session"] : undefined;
        if (transcript) {
          await captureOpencodeExportFile(transcript, process.cwd());
          return;
        }
        if (session) {
          await captureOpencodeSession(session, process.cwd());
          return;
        }
        if (flags["all"]) {
          await captureOpencodeAll(process.cwd());
          return;
        }
        process.stderr.write(
          "usage: cledger capture opencode (--session ID | --all | --transcript EXPORT.json)\n",
        );
        process.exit(2);
        return;
      }
      process.stderr.write(
        "usage: cledger capture codex --transcript PATH\n" +
          "       cledger capture <claude-code|gemini-cli|qwen-code> (--transcript PATH | --all)\n" +
          "       cledger capture opencode (--session ID | --all | --transcript EXPORT.json)\n",
      );
      process.exit(2);
      return;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`cledger: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

export { parseEventLine };
