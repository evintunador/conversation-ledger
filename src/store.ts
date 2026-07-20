import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  currentBranch,
  git,
  gitUserIdentity,
  headSha,
  repoIdentity,
  revList,
  statusPorcelain,
  type RepoInfo,
} from "./git.js";
import {
  finalizeEvent,
  parseEventLine,
  serializeEvent,
  type Actor,
  type EventDraft,
  type EvidenceEvent,
  type RepoContext,
} from "./schema.js";
import { redactDraft, type RedactionRecord } from "./redact/apply.js";
import { captureRules, collectEnvValues, loadConfig } from "./redact/config.js";
import { RULESET_VERSION, type RedactionRule } from "./redact/rules.js";
import { filterFindings, formatFinding, loadAllowlist, scanEvents } from "./redact/scan.js";

export const NOTES_NAME = "conversation-ledger";
export const NOTES_REF = `refs/notes/${NOTES_NAME}`;

/**
 * Storage model: one git note per anchor commit under refs/notes/
 * conversation-ledger. The note body is JSONL — one canonical-JSON event
 * per line, lexicographically sorted, unique. Everything lives in the note
 * blob itself (no out-of-tree pointers), so records are reachable from the
 * ref, GC-safe, travel with `git push`/`fetch` of that one ref, and merge
 * conflict-free with the cat_sort_uniq notes strategy.
 *
 * Events are anchored to HEAD at capture time, so conversations ride the
 * commit DAG: merge a branch and its conversations become reachable from
 * the target branch with no extra machinery.
 */

function stateDir(repo: RepoInfo): string {
  return join(repo.gitDir, "conversation-ledger");
}

function pendingPath(repo: RepoInfo): string {
  return join(stateDir(repo), "pending.jsonl");
}

/** Local, rebuildable cache/state only — never the record of truth. */
async function ensureStateDir(repo: RepoInfo): Promise<void> {
  await mkdir(stateDir(repo), { recursive: true });
}

export async function ensureMergeConfig(repo: RepoInfo): Promise<void> {
  const key = `notes.${NOTES_NAME}.mergeStrategy`;
  const current = (await git(["config", "--get", key], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (current !== "cat_sort_uniq") {
    await git(["config", key, "cat_sort_uniq"], { cwd: repo.root });
  }
}

export async function captureContext(repo: RepoInfo): Promise<RepoContext> {
  const [identity, branch, head, status] = await Promise.all([
    repoIdentity(repo),
    currentBranch(repo),
    headSha(repo),
    statusPorcelain(repo),
  ]);
  const context: RepoContext = { repo: identity, cwd: repo.root };
  if (branch) context.branch = branch;
  if (head) context.head = head;
  if (status.trim()) context.dirty_fingerprint = sha256Hex(status);
  return context;
}

async function readNoteLines(repo: RepoInfo, anchor: string, refName = NOTES_NAME): Promise<string[]> {
  const body = await git(["notes", "--ref", refName, "show", anchor], {
    cwd: repo.root,
    allowFailure: true,
  });
  return body.split("\n").filter((l) => l.trim().length > 0);
}

/** `refName` defaults to the main ledger ref; the scan gate also reads a temp fetched ref. */
export async function readNoteEvents(
  repo: RepoInfo,
  anchor: string,
  refName = NOTES_NAME,
): Promise<EvidenceEvent[]> {
  return (await readNoteLines(repo, anchor, refName)).map(parseEventLine);
}

/** All (anchor commit, note) pairs in the ledger ref (or `refName`, for reading a temp fetched ref). */
export async function listAnchors(repo: RepoInfo, refName = NOTES_NAME): Promise<string[]> {
  const out = await git(["notes", "--ref", refName, "list"], {
    cwd: repo.root,
    allowFailure: true,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1])
    .filter((sha): sha is string => Boolean(sha));
}

async function withLock<T>(repo: RepoInfo, fn: () => Promise<T>): Promise<T> {
  await ensureStateDir(repo);
  const lockDir = join(stateDir(repo), "lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) {
        // A crashed writer can leave the lock behind; steal it after the
        // wait budget rather than wedging capture hooks forever.
        await rm(lockDir, { recursive: true, force: true });
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export interface AppendResult {
  appended: EvidenceEvent[];
  deduped: number;
  /** null when events went to the pending queue (unborn HEAD). */
  anchor: string | null;
}

export async function appendEvents(
  repo: RepoInfo,
  drafts: EventDraft[],
  opts: { context?: RepoContext } = {},
): Promise<AppendResult> {
  const context = opts.context ?? (await captureContext(repo));
  const config = await loadConfig(repo.root);
  const rules = captureRules(config);
  const extraValues =
    rules.length > 0 && config.redact?.env === true
      ? await collectEnvValues(repo.root)
      : undefined;
  const events = drafts.map((draft) => {
    const withContext = { ...draft, context: draft.context ?? context };
    if (rules.length === 0) return finalizeEvent(withContext);
    const { draft: redacted, records } = redactDraft(withContext, {
      rules,
      ...(extraValues ? { extraValues } : {}),
    });
    return finalizeEvent(records.length > 0 ? { ...redacted, redactions: records } : redacted);
  });
  return withLock(repo, async () => {
    await ensureMergeConfig(repo);
    const anchor = await headSha(repo);
    if (!anchor) {
      return appendPending(repo, events);
    }
    const pending = await drainPending(repo);
    const existing = await readNoteLines(repo, anchor);
    const known = new Set(existing.map((l) => parseEventLine(l).id));
    const fresh = [...pending, ...events].filter((e) => {
      if (known.has(e.id)) return false;
      known.add(e.id);
      return true;
    });
    if (fresh.length === 0) {
      return { appended: [], deduped: events.length, anchor };
    }
    const lines = [...existing, ...fresh.map(serializeEvent)].sort();
    await git(["notes", "--ref", NOTES_NAME, "add", "-f", "-F", "-", anchor], {
      cwd: repo.root,
      input: lines.join("\n") + "\n",
    });
    const freshIds = new Set(fresh.map((e) => e.id));
    return {
      appended: events.filter((e) => freshIds.has(e.id)),
      deduped: events.length - events.filter((e) => freshIds.has(e.id)).length,
      anchor,
    };
  });
}

async function appendPending(repo: RepoInfo, events: EvidenceEvent[]): Promise<AppendResult> {
  await ensureStateDir(repo);
  const path = pendingPath(repo);
  const existing = existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter(Boolean)
    : [];
  const known = new Set(existing.map((l) => parseEventLine(l).id));
  const fresh = events.filter((e) => !known.has(e.id));
  await writeFile(path, [...existing, ...fresh.map(serializeEvent)].join("\n") + "\n");
  return { appended: fresh, deduped: events.length - fresh.length, anchor: null };
}

/** Events held while HEAD was unborn; caller writes them into a real note. */
async function drainPending(repo: RepoInfo): Promise<EvidenceEvent[]> {
  const path = pendingPath(repo);
  if (!existsSync(path)) return [];
  const events = (await readFile(path, "utf8")).split("\n").filter(Boolean).map(parseEventLine);
  await rm(path, { force: true });
  return events;
}

export async function readPending(repo: RepoInfo): Promise<EvidenceEvent[]> {
  const path = pendingPath(repo);
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(parseEventLine);
}

export interface ReadOptions {
  /** Restrict to events anchored to commits reachable from this rev. */
  reachableFrom?: string;
  kind?: string;
  source?: string;
  conversation?: string;
}

export async function readEvents(repo: RepoInfo, opts: ReadOptions = {}): Promise<EvidenceEvent[]> {
  let anchors = await listAnchors(repo);
  if (opts.reachableFrom) {
    const reachable = await revList(repo, opts.reachableFrom);
    anchors = anchors.filter((a) => reachable.has(a));
  }
  const events: EvidenceEvent[] = [];
  for (const anchor of anchors) {
    events.push(...(await readNoteEvents(repo, anchor)));
  }
  events.push(...(await readPending(repo)));
  const filtered = events.filter(
    (e) =>
      (!opts.kind || e.kind === opts.kind) &&
      (!opts.source || e.producer.source === opts.source) &&
      (!opts.conversation || e.conversation?.id === opts.conversation ||
        e.conversation?.id.startsWith(opts.conversation)),
  );
  return sortEvents(filtered);
}

/** Stable order: conversation, then seq, then time, then id. */
export function sortEvents(events: EvidenceEvent[]): EvidenceEvent[] {
  return [...events].sort((a, b) => {
    const conv = (a.conversation?.id ?? "").localeCompare(b.conversation?.id ?? "");
    if (conv !== 0) return conv;
    const seq = (a.conversation?.seq ?? 0) - (b.conversation?.seq ?? 0);
    if (seq !== 0) return seq;
    const time = a.occurred_at.localeCompare(b.occurred_at);
    if (time !== 0) return time;
    return a.id.localeCompare(b.id);
  });
}

export interface SyncResult {
  fetched: boolean;
  pushed: boolean;
}

/**
 * Event ids the remote's notes ref already has, fetched into a throwaway
 * temp ref that is deleted before returning. Null means the remote has no
 * ledger ref at all (e.g. first push), in which case the caller should
 * treat everything local as unshared.
 */
async function remoteNoteIds(repo: RepoInfo, remote: string): Promise<Set<string> | null> {
  const remoteHasRef = (await git(["ls-remote", remote, NOTES_REF], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!remoteHasRef) return null;

  const tmpName = "conversation-ledger-scan-tmp";
  const tmpRef = `refs/notes/${tmpName}`;
  await git(["fetch", remote, `+${NOTES_REF}:${tmpRef}`], { cwd: repo.root, allowFailure: true });
  try {
    const ids = new Set<string>();
    for (const anchor of await listAnchors(repo, tmpName)) {
      for (const event of await readNoteEvents(repo, anchor, tmpName)) ids.add(event.id);
    }
    return ids;
  } finally {
    await git(["update-ref", "-d", tmpRef], { cwd: repo.root, allowFailure: true });
  }
}

/**
 * Layer E: before push, scan only the events the remote does not yet have
 * (already-pushed events are not rescanned every time). On any surviving
 * finding, print a report and throw so sync() does not proceed to push —
 * the fetch/merge phase, if it already ran, is left in place.
 */
async function runScanGate(repo: RepoInfo, remote: string, tier: "standard" | "paranoid"): Promise<void> {
  const remoteIds = await remoteNoteIds(repo, remote);

  const localEvents: EvidenceEvent[] = [];
  for (const anchor of await listAnchors(repo)) {
    localEvents.push(...(await readNoteEvents(repo, anchor)));
  }
  localEvents.push(...(await readPending(repo)));

  const candidates = remoteIds ? localEvents.filter((e) => !remoteIds.has(e.id)) : localEvents;
  if (candidates.length === 0) return;

  const findings = filterFindings(scanEvents(candidates, tier), await loadAllowlist(repo));
  if (findings.length === 0) return;

  process.stderr.write(
    `cledger sync: blocked — ${findings.length} potential secret(s) in event(s) not yet on ${remote}\n\n`,
  );
  for (const f of findings) process.stderr.write(`  ${formatFinding(f)}\n`);
  process.stderr.write(
    "\nRemediate, then re-run sync:\n" +
      "  cledger redact <event-id>     rewrite the event and remove the secret\n" +
      "  cledger allow <fingerprint>   mark a fingerprint as a known false positive\n" +
      "  cledger sync --no-scan        skip this gate for this sync only\n",
  );
  throw new Error(
    `cledger sync: push blocked — ${findings.length} potential secret(s) found (see report above)`,
  );
}

/** Explicit, opt-in sync of the single ledger ref. Never runs implicitly. */
export async function sync(
  repo: RepoInfo,
  remote = "origin",
  mode: "both" | "push" | "fetch" = "both",
  opts: { skipScan?: boolean; paranoid?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = { fetched: false, pushed: false };
  await ensureMergeConfig(repo);
  if (mode !== "push") {
    const incoming = "refs/notes/conversation-ledger-incoming";
    const fetched = await git(
      ["fetch", remote, `+${NOTES_REF}:${incoming}`],
      { cwd: repo.root, allowFailure: true },
    );
    void fetched;
    const hasIncoming = (await git(["rev-parse", "--verify", "--quiet", incoming], {
      cwd: repo.root,
      allowFailure: true,
    })).trim();
    if (hasIncoming) {
      await git(
        ["notes", "--ref", NOTES_NAME, "merge", "-s", "cat_sort_uniq", incoming],
        { cwd: repo.root },
      );
      await git(["update-ref", "-d", incoming], { cwd: repo.root, allowFailure: true });
      result.fetched = true;
    }
  }
  if (mode !== "fetch") {
    const config = await loadConfig(repo.root);
    const scanDisabled = opts.skipScan === true || config.scan?.tier === "off";
    if (!scanDisabled) {
      const tier: "standard" | "paranoid" =
        opts.paranoid === true || config.scan?.tier === "paranoid" ? "paranoid" : "standard";
      await runScanGate(repo, remote, tier);
    }
    await git(["push", remote, `${NOTES_REF}:${NOTES_REF}`], { cwd: repo.root });
    result.pushed = true;
  }
  return result;
}

interface LocatedEvent {
  event: EvidenceEvent;
  /** Anchor commit holding the note line, or null when the event is still in pending.jsonl. */
  anchor: string | null;
  /** Full line array of the containing note (or of pending.jsonl), for in-place rewrite. */
  lines: string[];
  index: number;
}

function idMatchesPrefix(id: string, prefix: string): boolean {
  if (id.startsWith(prefix)) return true;
  const hash = id.startsWith("ev1-") ? id.slice(4) : id;
  return hash.startsWith(prefix);
}

/** Find the one event matching `idPrefix` across every anchor and the pending queue. */
async function locateEvent(repo: RepoInfo, idPrefix: string): Promise<LocatedEvent> {
  const matches: LocatedEvent[] = [];

  for (const anchor of await listAnchors(repo)) {
    const lines = await readNoteLines(repo, anchor);
    lines.forEach((line, index) => {
      const event = parseEventLine(line);
      if (idMatchesPrefix(event.id, idPrefix)) matches.push({ event, anchor, lines, index });
    });
  }

  const pendingFile = pendingPath(repo);
  const pendingLines = existsSync(pendingFile)
    ? (await readFile(pendingFile, "utf8")).split("\n").filter((l) => l.trim().length > 0)
    : [];
  pendingLines.forEach((line, index) => {
    const event = parseEventLine(line);
    if (idMatchesPrefix(event.id, idPrefix)) matches.push({ event, anchor: null, lines: pendingLines, index });
  });

  if (matches.length === 0) {
    throw new Error(`cledger redact: no event matches id prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `cledger redact: id prefix "${idPrefix}" is ambiguous (${matches.length} matches: ` +
        `${matches.map((m) => m.event.id).join(", ")})`,
    );
  }
  return matches[0]!;
}

export interface RedactResult {
  /** The rewritten event, with the secret removed. */
  event: EvidenceEvent;
  /** The companion `redaction` event recording why `event`'s content no longer matches its id. */
  redactionEvent: EvidenceEvent;
  /** True when the pre-redaction notes history was squashed away locally (see below). */
  squashed: boolean;
}

/**
 * Human redaction of an *existing* event (layer E's remediation path, as
 * opposed to capture-time redaction in redact/apply.ts). Locates the event
 * by id prefix, rewrites its content in place, appends a companion
 * `redaction` event, and — when the pre-redaction content was never
 * pushed — squashes the local notes ref history so the old blob becomes
 * unreachable.
 */
export async function redactEvent(
  repo: RepoInfo,
  idPrefix: string,
  opts: { pattern?: string; all?: boolean; reason?: string },
): Promise<RedactResult> {
  const hasPattern = typeof opts.pattern === "string" && opts.pattern.length > 0;
  const hasAll = opts.all === true;
  if (hasPattern === hasAll) {
    throw new Error("cledger redact: exactly one of --pattern or --all is required");
  }

  const { located, rewritten, newRecords } = await withLock(repo, async () => {
    const located = await locateEvent(repo, idPrefix);
    const original = located.event;

    let rewrittenContent: unknown = original.content;
    let rewrittenRaw = original.raw;
    const newRecords: RedactionRecord[] = [];

    if (hasPattern) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(opts.pattern!, "g");
      } catch (err) {
        throw new Error(
          `cledger redact: invalid --pattern regex: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const rule: RedactionRule = {
        id: "manual",
        tier: "capture",
        description: "Manually specified redaction pattern",
        pattern,
      };
      const { draft: patched, records } = redactDraft(original, { rules: [rule] });
      if (records.length === 0) {
        throw new Error(`cledger redact: --pattern matched nothing in event ${original.id}`);
      }
      rewrittenContent = patched.content;
      rewrittenRaw = patched.raw;
      newRecords.push(...records);
    } else {
      const fingerprint = sha256Hex(canonicalJson(original.content)).slice(0, 12);
      rewrittenContent = `[REDACTED:manual:${fingerprint}]`;
      rewrittenRaw = undefined;
      newRecords.push({ rule: "manual", ruleset: RULESET_VERSION, fingerprint, path: "content" });
    }

    // CRITICAL: this draft carries `original.id` explicitly, and
    // finalizeEvent below (`draft.id ?? eventId(draft)`) preserves a
    // supplied id rather than recomputing it. If the id were recomputed
    // here from the rewritten (secret-free) content, it would no longer
    // match the id a fresh capture of the *original* source material would
    // produce — so a later transcript rescan (ids are a pure function of
    // source content; that's what makes capture idempotent) would
    // regenerate the original, unredacted event under its old id, dedup
    // would no longer recognize it as "already seen" against this
    // rewritten line, and the secret would silently reappear in the
    // ledger. Keeping the id stable means the rewritten line permanently
    // occupies that id slot — any rescan producing the same id dedups
    // against it instead. The companion `redaction` event appended below
    // is what records why this event's content no longer matches what its
    // id would normally imply.
    const rewrittenDraft: EventDraft = {
      ...original,
      id: original.id,
      content: rewrittenContent,
      redactions: [...(original.redactions ?? []), ...newRecords],
    };
    if (rewrittenRaw === undefined) delete rewrittenDraft.raw;
    else rewrittenDraft.raw = rewrittenRaw;

    const rewritten = finalizeEvent(rewrittenDraft);
    if (rewritten.id !== original.id) {
      // Should be unreachable given the explicit `id: original.id` above;
      // guarded because a dedup break here is exactly the failure mode the
      // comment above exists to prevent.
      throw new Error("cledger redact: internal error — rewritten event id drifted from the original");
    }

    const newLines = [...located.lines];
    newLines[located.index] = serializeEvent(rewritten);
    if (located.anchor !== null) {
      newLines.sort();
      await git(["notes", "--ref", NOTES_NAME, "add", "-f", "-F", "-", located.anchor], {
        cwd: repo.root,
        input: newLines.join("\n") + "\n",
      });
    } else {
      await ensureStateDir(repo);
      await writeFile(pendingPath(repo), newLines.join("\n") + "\n");
    }

    return { located, rewritten, newRecords };
  });

  // Companion event: goes through the normal appendEvents path (its own
  // lock cycle) rather than being written inline above, so it behaves
  // exactly like any other captured event (dedup, context, validation).
  const identity = await gitUserIdentity(repo);
  const actor: Actor = { type: "human" };
  if (identity.email) actor.id = identity.email;
  if (identity.name) actor.display = identity.name;

  const redactionContent: Record<string, unknown> = {
    target: located.event.id,
    mode: hasPattern ? "pattern" : "all",
    fingerprints: newRecords.map((r) => r.fingerprint),
  };
  if (opts.reason) redactionContent.reason = opts.reason;

  const redactionDraft: EventDraft = {
    kind: "redaction",
    occurred_at: new Date().toISOString(),
    actor,
    producer: { tool: "cledger" },
    content: redactionContent,
    links: [{ rel: "redacts", target: located.event.id }],
  };
  if (located.event.conversation) redactionDraft.conversation = located.event.conversation;

  const appendResult = await appendEvents(repo, [redactionDraft]);
  const redactionEvent = appendResult.appended[0];
  if (!redactionEvent) {
    throw new Error("cledger redact: failed to append companion redaction event");
  }

  // Local purge: only meaningful when the event was already anchored (a
  // pending-queue rewrite never touched the notes ref) and only safe when
  // nobody else has a copy of the pre-redaction history yet.
  let squashed = false;
  if (located.anchor !== null) {
    const remoteHasRef = (await git(["ls-remote", "origin", NOTES_REF], {
      cwd: repo.root,
      allowFailure: true,
    })).trim();
    if (!remoteHasRef) {
      const tree = (await git(["rev-parse", `${NOTES_REF}^{tree}`], { cwd: repo.root })).trim();
      const squashedCommit = (
        await git(["commit-tree", tree, "-m", "cledger: notes history squashed after redaction"], {
          cwd: repo.root,
        })
      ).trim();
      await git(["update-ref", NOTES_REF, squashedCommit], { cwd: repo.root });
      squashed = true;
    } else {
      process.stderr.write(
        "cledger redact: refs/notes/conversation-ledger already has a copy on origin, so the " +
          "pre-redaction content is already shared history — skipping the local squash. Purging " +
          "already-pushed history is separate, not-yet-built tooling (force-push + collaborator " +
          "re-fetch coordination).\n",
      );
    }
  }

  return { event: rewritten, redactionEvent, squashed };
}
