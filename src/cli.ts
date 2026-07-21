#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { stdin as input } from "node:process";
import { findRepo, type RepoInfo } from "./git.js";
import {
  appendEvents,
  manualReAnchor,
  readEvents,
  redactEvent,
  runReAnchor,
  ScanBlockedError,
  sortEvents,
  sync,
  transportPush,
  type ReadOptions,
} from "./store.js";
import { parseEventLine, type EventDraft, type EvidenceEvent } from "./schema.js";
import { runClaudeCodeHook, captureClaudeTranscript } from "./adapters/claude-code.js";
import { runCodexHook, captureCodexTranscript } from "./adapters/codex.js";
import { renormalize } from "./renormalize.js";
import { installAdapters } from "./install.js";
import { forgeForRepo } from "./forge/forge.js";
import { suggestMappings } from "./reanchor-suggest.js";
import { loadConfig } from "./redact/config.js";
import {
  addToAllowlist,
  filterFindings,
  formatFinding,
  loadAllowlist,
  scanEvents,
} from "./redact/scan.js";

const USAGE = `conversation-ledger — durable records of coding-agent conversations, in git notes

Usage:
  cledger append [--quiet]                 append JSONL events/drafts from stdin
  cledger log [--all|--rev R] [--kind K] [--source S] [--conversation C] [--json]
  cledger show <conversation-id-prefix> [--json]
  cledger conversations [--rev R]         list conversations on current branch (--all for every branch)
  cledger export [--rev R]                lossless JSONL dump (default: everything)
  cledger sync [--remote R] [--push|--fetch] [--no-scan] [--paranoid]
                                           fetch/merge/push of the ledger ref;
                                           push is gated by a secret scan unless --no-scan
  cledger transport-push [remote]         pre-push hook entrypoint (installed automatically):
                                           pushes the ledger ref alongside git push; scan findings
                                           hold back only the ledger unless transport.strict
  cledger scan [--all|--rev R] [--paranoid]   scan local events for potential secrets (CI-friendly:
                                           exits 1 if any finding, 0 otherwise); default scope is
                                           every local event, --rev restricts by reachability
  cledger allow <fingerprint...>          mark scan finding fingerprint(s) as known false positives
  cledger redact <event-id-prefix> (--pattern REGEX | --all) [--reason TEXT]
                                           rewrite an existing event to remove a secret, keeping its
                                           id stable, and squash local notes history if unpushed
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
                                           cledger version can now parse into conversation_turns,
                                           superseding the raw-only placeholders (append-only, idempotent)
  cledger install <claude-code|codex|all>  hook capture into coding CLIs (global)
  cledger hook <claude-code>              capture entrypoint invoked by CLI hooks (stdin: hook payload)
  cledger capture <claude-code|codex> --transcript PATH   manual/backfill ingestion
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
  if (typeof flags["conversation"] === "string") opts.conversation = flags["conversation"];
  return opts;
}

function snippet(event: EvidenceEvent): string {
  const c = event.content as Record<string, unknown> | string | null;
  let text = "";
  if (typeof c === "string") text = c;
  else if (c && typeof c === "object") {
    text = String(c["text"] ?? c["summary"] ?? c["title"] ?? JSON.stringify(c));
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 100 ? text.slice(0, 97) + "..." : text;
}

function printHuman(events: EvidenceEvent[]): void {
  for (const e of events) {
    const conv = e.conversation ? `${e.conversation.id.slice(0, 28)}#${e.conversation.seq}` : "-";
    const role =
      (e.content as Record<string, unknown> | null | undefined) &&
      typeof e.content === "object"
        ? String((e.content as Record<string, unknown>)["role"] ?? e.actor.type)
        : e.actor.type;
    process.stdout.write(
      `${e.occurred_at}  ${e.kind}  ${role.padEnd(9)}  ${conv}  ${snippet(e)}\n`,
    );
  }
}

function printJsonl(events: EvidenceEvent[], includeRaw: boolean): void {
  for (const e of events) {
    const out = includeRaw ? e : { ...e, raw: undefined };
    process.stdout.write(JSON.stringify(out) + "\n");
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
  const events = await readEvents(repo, readOptionsFrom(flags));
  if (flags["json"]) printJsonl(events, false);
  else printHuman(events);
}

async function cmdShow(positional: string[], flags: Flags): Promise<void> {
  const prefix = positional[0];
  if (!prefix) {
    process.stderr.write("usage: cledger show <conversation-id-prefix>\n");
    process.exit(2);
  }
  const repo = await requireRepo();
  const events = await readEvents(repo, { conversation: prefix });
  if (events.length === 0) {
    process.stderr.write(`no events for conversation ${prefix}\n`);
    process.exit(1);
  }
  if (flags["json"]) {
    printJsonl(events, true);
    return;
  }
  for (const e of sortEvents(events)) {
    const c = e.content as Record<string, unknown>;
    const role = typeof c === "object" && c ? String(c["role"] ?? e.actor.type) : e.actor.type;
    const text =
      typeof c === "object" && c && typeof c["text"] === "string"
        ? (c["text"] as string)
        : JSON.stringify(e.content, null, 2);
    process.stdout.write(`\n[${e.occurred_at}] ${role} (${e.kind}, ${e.id.slice(0, 16)})\n`);
    process.stdout.write(text.trimEnd() + "\n");
  }
}

async function cmdConversations(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const events = await readEvents(repo, readOptionsFrom(flags));
  const byConv = new Map<string, { count: number; first: string; last: string; source: string }>();
  for (const e of events) {
    const id = e.conversation?.id ?? "(none)";
    const entry = byConv.get(id) ?? {
      count: 0,
      first: e.occurred_at,
      last: e.occurred_at,
      source: e.producer.source ?? e.producer.tool,
    };
    entry.count++;
    if (e.occurred_at < entry.first) entry.first = e.occurred_at;
    if (e.occurred_at > entry.last) entry.last = e.occurred_at;
    byConv.set(id, entry);
  }
  for (const [id, s] of [...byConv.entries()].sort((a, b) => a[1].last.localeCompare(b[1].last))) {
    process.stdout.write(`${id}  ${s.source}  ${s.count} events  ${s.first} .. ${s.last}\n`);
  }
}

async function cmdExport(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const opts: ReadOptions = {};
  if (typeof flags["rev"] === "string") opts.reachableFrom = flags["rev"];
  const events = await readEvents(repo, opts);
  printJsonl(events, true);
}

async function cmdSync(flags: Flags): Promise<void> {
  const repo = await requireRepo();
  const remote = typeof flags["remote"] === "string" ? flags["remote"] : "origin";
  const mode = flags["push"] ? "push" : flags["fetch"] ? "fetch" : "both";
  const result = await sync(repo, remote, mode, {
    skipScan: flags["no-scan"] === true,
    paranoid: flags["paranoid"] === true,
  });
  process.stderr.write(
    `sync ${remote}: ${result.fetched ? "fetched+merged" : "nothing fetched"}, ` +
      `${result.pushed ? "pushed" : "not pushed"}\n`,
  );
}

async function cmdTransportPush(positional: string[]): Promise<void> {
  const repo = await findRepo(process.cwd());
  if (!repo) return; // a hook must never fail the user's push
  const remote = positional[0] || "origin";
  try {
    await transportPush(repo, remote);
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
  const findings = filterFindings(scanEvents(events, tier), await loadAllowlist(repo));
  if (findings.length === 0) {
    process.stderr.write("cledger scan: no findings\n");
    return;
  }
  for (const f of findings) process.stdout.write(formatFinding(f) + "\n");
  process.stderr.write(`cledger scan: ${findings.length} finding(s)\n`);
  process.exit(1);
}

async function cmdAllow(positional: string[]): Promise<void> {
  if (positional.length === 0) {
    process.stderr.write("usage: cledger allow <fingerprint...>\n");
    process.exit(2);
  }
  const repo = await requireRepo();
  await addToAllowlist(repo, positional);
  process.stderr.write(`allowlisted ${positional.length} fingerprint(s)\n`);
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
  const result = await redactEvent(repo, idPrefix, redactOpts);
  const fingerprints = result.event.redactions?.map((r) => r.fingerprint).join(", ") || "(none)";
  process.stderr.write(
    `cledger redact: rewrote ${result.event.id.slice(0, 16)} — fingerprints: ${fingerprints}\n` +
      `companion event: ${result.redactionEvent.id.slice(0, 16)}\n` +
      `history squashed: ${result.squashed ? "yes" : "no"}\n`,
  );
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
      process.stderr.write(
        `    confirm with: cledger re-anchor ${unmatched.superseded.join(" ")} ` +
          `--onto ${suggestions[0]!.candidate}\n`,
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
    case "allow":
      return cmdAllow(positional);
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
      process.stderr.write("usage: cledger capture <claude-code|codex> --transcript PATH\n");
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
