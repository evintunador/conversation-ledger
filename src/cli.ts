#!/usr/bin/env node
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { stdin as input } from "node:process";
import { findRepo, type RepoInfo } from "./git.js";
import {
  appendEvents,
  manualReAnchor,
  NOTES_REF,
  readEvents,
  redactEvent,
  RedactAfterShareError,
  runReAnchor,
  ScanBlockedError,
  sortEvents,
  sync,
  parsePrePushRefs,
  transportPush,
  type ReadOptions,
} from "./store.js";
import {
  parseEventLine,
  SESSION_MACHINERY_KINDS,
  type EventDraft,
  type EvidenceEvent,
} from "./schema.js";
import { runClaudeCodeHook, captureClaudeTranscript } from "./adapters/claude-code.js";
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
import { forgeForRepo } from "./forge/forge.js";
import { suggestMappings } from "./reanchor-suggest.js";
import { loadConfig } from "./redact/config.js";
import {
  addToAllowlist,
  filterFindings,
  findingGuidance,
  formatFinding,
  formatGroupedReport,
  inAgentSession,
  loadAllowlist,
  renderFinding,
  scanEvents,
} from "./redact/scan.js";
import { runReview } from "./review.js";

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
  cledger export [--rev R]                lossless JSONL dump (default: everything, incl. reasoning)
  cledger sync [--remote R] [--push|--fetch] [--no-scan] [--paranoid] [--all|--rev R]
                                           fetch/merge/push of the ledger ref;
                                           push is gated by a secret scan unless --no-scan.
                                           Push carries only conversations reachable from the
                                           current branch; --all pushes the whole ledger,
                                           --rev scopes to another branch/commit
  cledger transport-push [remote]         pre-push hook entrypoint (installed automatically):
                                           pushes the ledger ref alongside git push, scoped to the
                                           refs being pushed (read from git's pre-push stdin;
                                           falls back to HEAD); scan findings hold back only the
                                           ledger unless transport.strict
  cledger scan [--all|--rev R] [--paranoid]   scan local events for potential secrets (CI-friendly:
                                           exits 1 if any finding, 0 otherwise); default scope is
                                           every local event, --rev restricts by reachability
  cledger review [--paranoid] [--context N]   step through every outstanding finding interactively:
                                           one screen per distinct span, match highlighted in
                                           context, one key to allow (here or globally), redact
                                           everywhere, or skip. HUMANS ONLY, plain terminal —
                                           refuses inside an agent session and without a TTY.
  cledger inspect <event-id-prefix> [--context N] [--reveal] [--stdout] [--force]
                                           show a finding with real surrounding context (default 400
                                           chars each side). Writes to a file outside the repo and
                                           refuses to run inside a coding-agent session — reports
                                           never print content, because reprinting it re-seeds the
                                           finding. HUMANS ONLY, in a plain terminal.
  cledger allow <fingerprint...> [--global]   mark scan finding fingerprint(s) as known false
                                           positives, for this repo or (--global) every repo on
                                           this machine; repos can also commit shared entries in
                                           .cledger.json {"scan":{"allowFingerprints":[...]}}
  cledger redact <event-id-prefix> (--pattern REGEX | --all) [--reason TEXT]
                                           rewrite a not-yet-pushed event to remove a secret, keeping
                                           its id stable, and sever the local notes history chain.
                                           PRE-PUSH ONLY: refuses once the event is on origin, where
                                           rewriting cannot remove it (rotate the credential instead)
  cledger re-anchor [--apply] [--target R] [--no-forge]
                                           detect branches squash-merged/rewritten onto the remote
                                           default branch and map their conversations to the
                                           surviving commits (dry-run by default; exact matches
                                           also auto-apply on read unless reanchor.auto is false).
                                           Inexact cases get evidence-ranked suggestions — forge PR
                                           metadata via your own gh session, commit-message
                                           corroboration, per-file content match — never auto-applied
  cledger re-anchor <old-rev...> --onto REV   assert one mapping manually (edited squashes,
                                           deleted branches, ambiguous matches)
  cledger renormalize                      re-interpret preserved unrecognized transcript lines this
                                           cledger version can now parse into their proper kind
                                           (conversation_turn, session_state, activity, ...),
                                           superseding the raw-only placeholders (append-only, idempotent)
  cledger install <claude-code|codex|opencode|gemini-cli|qwen-code|all>
                                           hook capture into coding CLIs (global)
  cledger hook <claude-code|codex|opencode|gemini-cli|qwen-code>
                                           capture entrypoint invoked by CLI hooks (stdin: hook payload)
  cledger capture <claude-code|codex> --transcript PATH   manual/backfill ingestion
  cledger capture <gemini-cli|qwen-code> [--transcript PATH | --all]
                                           both keep per-project session logs; --all backfills every
                                           session the CLI scopes to this directory, including ones
                                           cledger has never seen (the hook's own catch-up sweep is
                                           deliberately narrower — it only finishes sessions cledger
                                           already tracks)
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
  if (!flags["all"]) opts.reachableFrom = typeof flags["rev"] === "string" ? flags["rev"] : "HEAD";
  if (typeof flags["kind"] === "string") opts.kind = flags["kind"];
  if (typeof flags["source"] === "string") opts.source = flags["source"];
  if (typeof flags["model"] === "string") opts.model = flags["model"];
  if (typeof flags["conversation"] === "string") opts.conversation = flags["conversation"];
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
 * Exit quietly when the reader closes the pipe.
 *
 * `cledger export | head -1` is ordinary usage, and without this handler it
 * printed a stack trace instead of output: `process.stdout` had no `error`
 * listener, so the EPIPE Node raises once the reader is gone surfaced as an
 * unhandled `error` event. Small ledgers hide it, because the whole payload
 * fits the 64KB pipe buffer before `head` exits and the write never fails;
 * anything larger throws every time.
 *
 * A reader that stopped reading is not a failure of ours, so EPIPE exits 0 —
 * the convention every `head`-friendly CLI follows. Any other stdout error is
 * real and still reported, but as a message rather than a stack trace.
 */
function guardStdout(): void {
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
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

async function printHuman(events: EvidenceEvent[]): Promise<void> {
  for (const e of events) {
    const conv = e.conversation ? `${e.conversation.id.slice(0, 28)}#${e.conversation.seq}` : "-";
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
    flags["with-state"] === true || (opts.kind !== undefined && SESSION_MACHINERY_KINDS.has(opts.kind));
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
  let events = await readEvents(repo, opts);
  events = events.filter(displayFilter(flags, opts));
  if (flags["json"]) await printJsonl(events, false);
  else await printHuman(events);
}

async function cmdShow(positional: string[], flags: Flags): Promise<void> {
  const prefix = positional[0];
  if (!prefix) {
    process.stderr.write("usage: cledger show <conversation-id-prefix>\n");
    process.exit(2);
  }
  const repo = await requireRepo();
  let events = await readEvents(repo, { conversation: prefix });
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
    const id = e.conversation?.id ?? "(none)";
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

async function cmdExport(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const opts: ReadOptions = {};
  if (typeof flags["rev"] === "string") opts.reachableFrom = flags["rev"];
  const events = await readEvents(repo, opts);
  await printJsonl(events, true);
}

async function cmdSync(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const remote = typeof flags["remote"] === "string" ? flags["remote"] : "origin";
  const mode = flags["push"] ? "push" : flags["fetch"] ? "fetch" : "both";
  // Push is scoped to the current branch by default; --all restores the
  // pre-0.14.0 whole-ledger push, --rev scopes to something else.
  const scope: string | null = flags["all"] === true
    ? null
    : typeof flags["rev"] === "string"
      ? flags["rev"]
      : "HEAD";
  const result = await sync(repo, remote, mode, {
    skipScan: flags["no-scan"] === true,
    paranoid: flags["paranoid"] === true,
    scope,
  });
  const pushed = !result.pushed
    ? "not pushed"
    : result.scopedAnchors === null
      ? "pushed (whole ledger)"
      : `pushed (${result.scopedAnchors} commit(s) in scope)`;
  process.stderr.write(
    `sync ${remote}: ${result.fetched ? "fetched+merged" : "nothing fetched"}, ${pushed}\n`,
  );
}

async function cmdTransportPush(positional: string[]): Promise<void> {
  const repo = await findRepo(process.cwd());
  if (!repo) return; // a hook must never fail the user's push
  const remote = positional[0] || "origin";
  // git's pre-push hook pipes the refs being pushed. Only read when stdin is
  // actually a pipe: a manual `cledger transport-push` from a terminal would
  // otherwise block forever waiting on a human who has nothing to type.
  let revs: string[] = [];
  if (process.stdin.isTTY !== true) {
    try {
      revs = parsePrePushRefs(await readStdin());
    } catch {
      revs = []; // unreadable stdin must never fail the user's push
    }
  }
  try {
    await transportPush(repo, remote, revs);
  } catch (err) {
    if (err instanceof ScanBlockedError) {
      // transport.strict: nonzero exit makes git abort the entire push.
      process.stderr.write("cledger: entire push blocked (transport.strict is enabled)\n");
      process.exit(1);
    }
    // Anything else is a cledger bug or environment problem; the user's
    // code push must proceed regardless.
    process.stderr.write(
      `cledger: transport-push error (push continues): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function cmdScan(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const tier: "standard" | "paranoid" = flags["paranoid"] ? "paranoid" : "standard";
  const opts: ReadOptions = {};
  if (typeof flags["rev"] === "string") opts.reachableFrom = flags["rev"];
  const events = await readEvents(repo, opts);
  const config = await loadConfig(repo.root);
  const findings = filterFindings(scanEvents(events, tier), await loadAllowlist(repo, config));
  if (findings.length === 0) {
    process.stderr.write("cledger scan: no findings\n");
    return;
  }
  // stdout keeps the one-line-per-site format — it is the machine-readable
  // surface CI greps. The human-facing summary on stderr groups by
  // fingerprint, because that is the number of decisions actually pending.
  for (const f of findings) process.stdout.write(formatFinding(f) + "\n");
  const eventIds = [...new Set(findings.map((f) => f.eventId))];
  const spans = new Set(findings.map((f) => f.fingerprint)).size;
  process.stderr.write(`\n${formatGroupedReport(findings)}\n`);
  process.stderr.write(`\n${findingGuidance(eventIds)}\n`);
  process.stderr.write(
    `\ncledger scan: ${spans} distinct span(s) — ${findings.length} site(s) across ${eventIds.length} event(s)\n`,
  );
  process.exit(1);
}

/**
 * Interactive triage in a terminal: everything `cledger inspect` shows, per
 * distinct span instead of per event, with the verdict applied on the spot.
 * Refuses inside an agent session for exactly inspect's reason — and unlike
 * inspect it deliberately has no --force: it exists for the human half of
 * the review split, and an agent that wants coordinates already has scan.
 */
async function cmdReview(flags: Flags): Promise<void> {
  const agentVar = inAgentSession();
  if (agentVar) {
    process.stderr.write(
      `cledger review: refusing to run inside a coding-agent session (saw $${agentVar}).\n\n` +
        "  Reviewing flagged content here would capture it into this conversation and\n" +
        "  re-seed the findings being reviewed. Run this in a plain terminal.\n",
    );
    process.exit(2);
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(
      "cledger review: needs an interactive terminal on stdin and stdout.\n" +
        "  Piping review output defeats its purpose — the content must not land in a\n" +
        "  file or transcript. Use `cledger scan` for machine-readable coordinates.\n",
    );
    process.exit(2);
  }
  const repo = await requireRepo();
  const tier: "standard" | "paranoid" = flags["paranoid"] ? "paranoid" : "standard";
  const context = typeof flags["context"] === "string" ? Number(flags["context"]) : 600;
  if (!Number.isFinite(context) || context < 0) {
    process.stderr.write("cledger review: --context must be a non-negative number\n");
    process.exit(2);
  }
  const summary = await runReview(repo, { tier, context });
  const total =
    summary.allowed + summary.allowedGlobally + summary.redacted + summary.skipped;
  if (total === 0 && summary.errors.length === 0) {
    process.stderr.write("cledger review: nothing to review\n");
    return;
  }
  process.stderr.write(
    `cledger review: ${summary.allowed} allowed here, ${summary.allowedGlobally} allowed globally, ` +
      `${summary.redacted} event(s) redacted, ${summary.skipped} span(s) skipped\n`,
  );
  for (const err of summary.errors) process.stderr.write(`  ${err}\n`);
  if (summary.skipped > 0 || summary.errors.length > 0) process.exit(1);
}

/**
 * Show a finding with enough surrounding text to actually judge it — the
 * counterpart to `formatFinding`'s deliberately contentless report.
 *
 * Two guards, both load-bearing rather than decorative. It refuses to run
 * inside a coding-agent session, because an agent investigating a blocked sync
 * would otherwise read the flagged text into the transcript and mint a fresh
 * event carrying it. And it writes to a file outside the repo by default
 * rather than to stdout, so the content does not pass through a terminal that
 * something else may be recording.
 */
async function cmdInspect(positional: string[], flags: Flags): Promise<void> {
  if (positional.length === 0) {
    process.stderr.write(
      "usage: cledger inspect <event-id-prefix> [--context N] [--reveal] [--stdout] [--force]\n",
    );
    process.exit(2);
  }
  const agentVar = inAgentSession();
  if (agentVar && !flags["force"]) {
    process.stderr.write(
      `cledger inspect: refusing to run inside a coding-agent session (saw $${agentVar}).\n\n` +
        "  Reading flagged content here would capture it into this conversation and\n" +
        "  re-seed the finding you are inspecting. Run this in a plain terminal.\n\n" +
        "  --force overrides, and is almost always the wrong call.\n",
    );
    process.exit(2);
  }

  const repo = await requireRepo();
  const tier: "standard" | "paranoid" = flags["paranoid"] ? "paranoid" : "standard";
  const prefix = positional[0]!;
  const context = typeof flags["context"] === "string" ? Number(flags["context"]) : 400;
  if (!Number.isFinite(context) || context < 0) {
    process.stderr.write("cledger inspect: --context must be a non-negative number\n");
    process.exit(2);
  }
  const reveal = Boolean(flags["reveal"]);

  const events = await readEvents(repo);
  const matched = events.filter((e) => e.id.startsWith(prefix));
  if (matched.length === 0) {
    process.stderr.write(`cledger inspect: no event matching id prefix ${prefix}\n`);
    process.exit(1);
  }

  // Deliberately not allowlist-filtered: inspecting is exactly how you decide
  // whether something *should* be allowlisted, and re-checking an old decision
  // is legitimate.
  const findings = scanEvents(matched, tier);
  if (findings.length === 0) {
    process.stderr.write(
      `cledger inspect: no findings in ${matched.length} matching event(s) at the ${tier} tier\n`,
    );
    return;
  }

  const byId = new Map(matched.map((e) => [e.id, e]));
  const body = [
    `cledger inspect — ${findings.length} finding(s) in ${matched.length} event(s)`,
    `context: ${context} chars each side | matched text: ${reveal ? "REVEALED" : "masked"}`,
    "",
    "This file contains raw conversation content and possibly a real secret.",
    "Delete it when you are done, and do not paste it into an agent session.",
    "",
    ...findings.map((f) => renderFinding(byId.get(f.eventId)!, f, { context, reveal })),
  ].join("\n");

  if (flags["stdout"]) {
    process.stdout.write(body);
    return;
  }
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "cledger-inspect-"));
  const out = join(dir, `${prefix.slice(0, 16)}.txt`);
  await writeFile(out, body, { mode: 0o600 });
  process.stderr.write(
    `${findings.length} finding(s) written to:\n  ${out}\n\n` +
      "Open it in an editor, then delete it. Re-run with --reveal to include the\n" +
      "matched text itself, or --context N to widen the surrounding text.\n",
  );
}

async function cmdAllow(positional: string[], flags: Flags): Promise<void> {
  if (positional.length === 0) {
    process.stderr.write("usage: cledger allow <fingerprint...> [--global]\n");
    process.exit(2);
  }
  const repo = await requireRepo();
  const scope = flags["global"] === true ? "global" : "local";
  await addToAllowlist(repo, positional, scope);
  process.stderr.write(
    `allowlisted ${positional.length} fingerprint(s) ` +
      `(${scope === "global" ? "every repo on this machine" : "this repo"})\n`,
  );
}

async function cmdRedact(positional: string[], flags: Flags): Promise<void> {
  const idPrefix = positional[0];
  if (!idPrefix) {
    process.stderr.write("usage: cledger redact <event-id-prefix> (--pattern REGEX | --all) [--reason TEXT]\n");
    process.exit(2);
  }
  const repo = await requireRepo();
  const redactOpts: { pattern?: string; all?: boolean; reason?: string } = {};
  if (typeof flags["pattern"] === "string") redactOpts.pattern = flags["pattern"];
  if (flags["all"] === true) redactOpts.all = true;
  if (typeof flags["reason"] === "string") redactOpts.reason = flags["reason"];
  let result;
  try {
    result = await redactEvent(repo, idPrefix, redactOpts);
  } catch (err) {
    // Already-shared (or unverifiable) content: the message is a full
    // explanation, so print it as-is rather than through main()'s generic
    // one-line handler.
    if (err instanceof RedactAfterShareError) {
      process.stderr.write(err.message + "\n");
      process.exit(1);
    }
    throw err;
  }
  const fingerprints = result.event.redactions?.map((r) => r.fingerprint).join(", ") || "(none)";
  process.stderr.write(
    `cledger redact: rewrote ${result.event.id.slice(0, 16)} — fingerprints: ${fingerprints}\n` +
      `companion event: ${result.redactionEvent.id.slice(0, 16)}\n`,
  );
  // Say what actually happened. This used to print "history squashed: yes",
  // which read as "the value is gone" — it is not, and asserting an outcome
  // the tool does not achieve is worse than saying nothing.
  if (result.squashed) {
    process.stderr.write(
      `notes history: chain severed — the pre-redaction note is no longer reachable from\n` +
        `  ${NOTES_REF} and was never pushed. The old objects remain in this repo's\n` +
        `  reflog and object store until git expires them (typically 30-90 days); they are\n` +
        `  local-only, as git transfers neither reflogs nor unreachable objects. To drop them\n` +
        `  now: git reflog expire --expire=now --all && git gc --prune=now  (repo-wide).\n`,
    );
  } else {
    process.stderr.write(
      `notes history: untouched — this event was still in the pending queue, so it never\n` +
        `  reached the notes ref.\n`,
    );
  }
  if (result.knownSecretsRemembered > 0) {
    process.stderr.write(
      `remembered ${result.knownSecretsRemembered} secret value(s) for capture-time redaction ` +
        `(redact.knownSecrets is on)\n`,
    );
  }
}

async function cmdReAnchor(positional: string[], flags: Flags): Promise<void> {
  const repo = await requireRepo();

  if (positional.length > 0) {
    if (typeof flags["onto"] !== "string") {
      process.stderr.write("usage: cledger re-anchor <old-rev...> --onto REV\n");
      process.exit(2);
    }
    const { event, superseded, successor } = await manualReAnchor(repo, positional, flags["onto"]);
    process.stderr.write(
      event
        ? `cledger re-anchor: mapped ${superseded.length} commit(s) onto ${successor.slice(0, 12)} ` +
            `(event ${event.id.slice(0, 16)})\n`
        : `cledger re-anchor: an identical mapping already exists — nothing appended\n`,
    );
    return;
  }

  const apply = flags["apply"] === true;
  const opts: { target?: string; apply: boolean } = { apply };
  if (typeof flags["target"] === "string") opts.target = flags["target"];
  const result = await runReAnchor(repo, opts);
  if (!result.target) {
    process.stderr.write(
      "cledger re-anchor: no target to compare against (no origin default branch or upstream); " +
        "pass one with --target\n",
    );
    process.exit(2);
  }
  if (result.detected.length === 0 && result.unmatched.length === 0) {
    process.stderr.write(`cledger re-anchor: nothing to re-anchor against ${result.target}\n`);
    return;
  }
  for (const d of result.detected) {
    process.stderr.write(
      `  branch ${d.mapping.branch}: ${d.mapping.superseded.length} commit(s) -> ` +
        `${d.mapping.successor.slice(0, 12)} (${d.mapping.method} match, ` +
        `${d.notedAnchors} with conversations)\n`,
    );
  }

  if (result.unmatched.length > 0) {
    const config = await loadConfig(repo.root);
    let forge = null;
    if (flags["no-forge"] === true || config.reanchor?.forge === false) {
      process.stderr.write("  (forge lookups disabled — offline evidence only)\n");
    } else {
      forge = await forgeForRepo(repo);
      if (!forge) {
        process.stderr.write("  (no forge driver for this origin — offline evidence only)\n");
      }
    }
    for (const unmatched of result.unmatched) {
      const reason =
        unmatched.reason === "ambiguous" ? "several commits tie" : "no exact content match";
      process.stderr.write(
        `  branch ${unmatched.branch}: looks rewritten onto ${result.target}, but ${reason} ` +
          `(${unmatched.notedAnchors} commit(s) with conversations)\n`,
      );
      const { suggestions, notes } = await suggestMappings(repo, unmatched, {
        target: result.target,
        forge,
      });
      for (const note of notes) process.stderr.write(`    note: ${note}\n`);
      if (suggestions.length === 0) {
        process.stderr.write(
          `    no candidates with evidence; if you know the commit, map it yourself:\n` +
            `      cledger re-anchor ${unmatched.superseded.join(" ")} --onto REV\n`,
        );
        continue;
      }
      for (const s of suggestions) {
        process.stderr.write(`    candidate ${s.candidate.slice(0, 12)} "${s.subject}"\n`);
        for (const line of s.evidence) process.stderr.write(`      - ${line}\n`);
      }
      // Never auto-applied: the human runs the printed command to confirm.
      // The list is every commit on the branch since it forked — only the
      // human knows whether the merge really covered all of them, so name
      // the ones that carry conversations before inviting a trim.
      process.stderr.write(
        `    carry conversations (keep these): ` +
          `${unmatched.noted.map((sha) => sha.slice(0, 12)).join(" ")}\n` +
          `    confirm with: cledger re-anchor ${unmatched.superseded.join(" ")} ` +
          `--onto ${suggestions[0]!.candidate}\n` +
          `    (newest first; trim commits that were not part of the merge)\n`,
      );
    }
  }

  process.stderr.write(
    apply
      ? `cledger re-anchor: applied ${result.applied.length} mapping(s)\n`
      : `cledger re-anchor: dry run — apply exact matches with \`cledger re-anchor --apply\`\n`,
  );
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

async function main(): Promise<void> {
  guardStdout();
  const [, , command, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);

  if (!command || command === "--help" || command === "help") {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (command === "--version") {
    process.stdout.write(version() + "\n");
    return;
  }
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
    case "sync":
      return cmdSync(flags);
    case "transport-push":
      return cmdTransportPush(positional);
    case "scan":
      return cmdScan(flags);
    case "review":
      return cmdReview(flags);
    case "inspect":
      return cmdInspect(positional, flags);
    case "allow":
      return cmdAllow(positional, flags);
    case "redact":
      return cmdRedact(positional, flags);
    case "re-anchor":
      return cmdReAnchor(positional, flags);
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
      if (source === "claude-code" && transcript) {
        await captureClaudeTranscript(transcript, process.cwd());
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
        "usage: cledger capture <claude-code|codex> --transcript PATH\n" +
          "       cledger capture <gemini-cli|qwen-code> (--transcript PATH | --all)\n" +
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
