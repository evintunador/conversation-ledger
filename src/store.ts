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
  absorbIncoming,
  ensureMergeConfig,
  ensureTransport,
  INCOMING_REF,
  NOTES_NAME,
  NOTES_REF,
} from "./transport.js";
import {
  finalizeEvent,
  parseEventLine,
  serializeEvent,
  type Actor,
  type EventDraft,
  type EvidenceEvent,
  type RepoContext,
} from "./schema.js";
import {
  commitDateIso,
  defaultRewriteTarget,
  detectRewrites,
  parseReAnchor,
  reAnchorDraft,
  type DetectedRewrite,
  type ReAnchorMapping,
} from "./reanchor.js";
import { collectMatches, redactDraft, type ExtraValueGroup, type RedactionRecord } from "./redact/apply.js";
import { captureRules, collectEnvValues, loadConfig } from "./redact/config.js";
import { addKnownSecrets, loadKnownSecrets } from "./redact/known-secrets.js";
import { RULESET_VERSION, type RedactionRule } from "./redact/rules.js";
import { filterFindings, formatFinding, loadAllowlist, scanEvents } from "./redact/scan.js";

export { ensureMergeConfig, NOTES_NAME, NOTES_REF } from "./transport.js";

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
  opts: { context?: RepoContext; anchor?: string } = {},
): Promise<AppendResult> {
  const context = opts.context ?? (await captureContext(repo));
  const config = await loadConfig(repo.root);
  // First capture in a repo wires up transport (pre-push hook + fetch
  // refspec); later calls are cheap re-checks. Never throws.
  await ensureTransport(repo, config);
  const rules = captureRules(config);
  // Exact-value scrubbing layers, each tagged with its own rule id for the
  // audit trail. Only consulted when capture redaction is active at all
  // (rules.length > 0); known-secrets additionally requires its opt-in flag.
  const extraValues: ExtraValueGroup[] = [];
  if (rules.length > 0) {
    if (config.redact?.knownSecrets === true) {
      const known = await loadKnownSecrets(repo);
      if (known.length > 0) extraValues.push({ ruleId: "known-secret", values: known });
    }
    if (config.redact?.env === true) {
      const env = await collectEnvValues(repo.root);
      if (env.length > 0) extraValues.push({ ruleId: "env-value", values: env });
    }
  }
  const events = drafts.map((draft) => {
    const withContext = { ...draft, context: draft.context ?? context };
    if (rules.length === 0) return finalizeEvent(withContext);
    const { draft: redacted, records } = redactDraft(withContext, {
      rules,
      ...(extraValues.length > 0 ? { extraValues } : {}),
    });
    return finalizeEvent(records.length > 0 ? { ...redacted, redactions: records } : redacted);
  });
  return withLock(repo, async () => {
    await ensureMergeConfig(repo);
    // Almost everything anchors to HEAD at capture time; re-anchor mapping
    // events override this to anchor at the successor commit so the mapping
    // rides the surviving branch's DAG regardless of where it was created.
    const anchor = opts.anchor ?? (await headSha(repo));
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
  // Lazy transport: fold in anything a plain `git fetch`/`git pull` staged.
  await absorbIncoming(repo);
  // Lazy re-anchoring, same shape: if the fetch revealed that the remote
  // target branch rewrote noted commits (squash merge), map them before
  // filtering by reachability below.
  await autoReAnchor(repo);
  let anchors = await listAnchors(repo);
  const noteCache = new Map<string, EvidenceEvent[]>();
  const readNote = async (anchor: string): Promise<EvidenceEvent[]> => {
    let events = noteCache.get(anchor);
    if (!events) {
      events = await readNoteEvents(repo, anchor);
      noteCache.set(anchor, events);
    }
    return events;
  };
  if (opts.reachableFrom) {
    anchors = await resolveAnchors(repo, anchors, opts.reachableFrom, readNote);
  }
  const events: EvidenceEvent[] = [];
  for (const anchor of anchors) {
    events.push(...(await readNote(anchor)));
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

/**
 * Reachability with re-anchor resolution. Plain reachability drops any
 * conversation whose anchor commit was rewritten away (a GitHub squash merge
 * discards the branch's commits, so their notes fall out of `rev-list` even
 * though the work survives in the squash commit). A `re_anchor` event —
 * anchored to the successor commit, so it is discoverable exactly when the
 * successor is in view — repairs this: an anchor counts as reachable when the
 * rev reaches it, or when a mapping whose successor is reachable names it as
 * superseded. Superseded commits can themselves anchor further mappings
 * (a squash commit later rewritten again), so resolution loops to a fixpoint:
 * grow the reachable set, read the notes that just became visible, repeat.
 * The set only grows and each note is read once, so it terminates.
 */
async function resolveAnchors(
  repo: RepoInfo,
  anchors: string[],
  rev: string,
  readNote: (anchor: string) => Promise<EvidenceEvent[]>,
): Promise<string[]> {
  const reachable = await revList(repo, rev);
  const visited = new Set<string>();
  const mappings: ReAnchorMapping[] = [];
  for (;;) {
    const frontier = anchors.filter((a) => reachable.has(a) && !visited.has(a));
    for (const anchor of frontier) {
      visited.add(anchor);
      for (const event of await readNote(anchor)) {
        const mapping = parseReAnchor(event);
        if (mapping) mappings.push(mapping);
      }
    }
    let grew = false;
    for (const mapping of mappings) {
      // A mapping only applies once its successor is in view; one pointing
      // at an unreachable successor (e.g. asserted from another branch)
      // changes nothing here.
      if (!reachable.has(mapping.successor)) continue;
      for (const sha of mapping.superseded) {
        if (!reachable.has(sha)) {
          reachable.add(sha);
          grew = true;
        }
      }
    }
    if (frontier.length === 0 && !grew) break;
  }
  return anchors.filter((a) => reachable.has(a));
}

/** Commits carrying notes, and the commits existing mappings already supersede. */
async function reAnchorState(
  repo: RepoInfo,
): Promise<{ anchors: Set<string>; alreadySuperseded: Set<string> }> {
  const anchors = new Set(await listAnchors(repo));
  const alreadySuperseded = new Set<string>();
  for (const anchor of anchors) {
    for (const event of await readNoteEvents(repo, anchor)) {
      const mapping = parseReAnchor(event);
      if (mapping) for (const sha of mapping.superseded) alreadySuperseded.add(sha);
    }
  }
  return { anchors, alreadySuperseded };
}

export interface ReAnchorRunResult {
  /** Rev the detection compared against, or null when none could be resolved. */
  target: string | null;
  detected: DetectedRewrite[];
  ambiguous: string[];
  /** Mapping events actually appended — empty on dry runs and re-runs. */
  applied: EvidenceEvent[];
}

/**
 * One detection pass against `target` (default: the remote default branch),
 * optionally appending the proposed exact mappings, each anchored to its
 * successor commit. Re-running is a no-op: commits an existing mapping
 * covers are excluded from detection, and identical mapping events dedup by
 * id anyway. Ambiguous branches are reported, never guessed at.
 */
export async function runReAnchor(
  repo: RepoInfo,
  opts: { target?: string; apply: boolean },
): Promise<ReAnchorRunResult> {
  const target = opts.target ?? (await defaultRewriteTarget(repo));
  if (!target) return { target: null, detected: [], ambiguous: [], applied: [] };
  const { anchors, alreadySuperseded } = await reAnchorState(repo);
  if (anchors.size === 0) return { target, detected: [], ambiguous: [], applied: [] };
  const { detected, ambiguous } = await detectRewrites(repo, { target, anchors, alreadySuperseded });
  const applied: EvidenceEvent[] = [];
  if (opts.apply) {
    for (const rewrite of detected) {
      const result = await appendEvents(repo, [reAnchorDraft(rewrite.mapping)], {
        anchor: rewrite.mapping.successor,
      });
      applied.push(...result.appended);
    }
  }
  return { target, detected, ambiguous, applied };
}

/**
 * Manual mapping — the escape hatch for everything mechanical matching
 * cannot assert: a maintainer edited during the squash, the branch is long
 * gone, an ambiguous match needed a human eye. Asserted by the user, so the
 * actor is the user (two humans asserting the same mapping yield two
 * events; honest provenance, and the reads they affect are identical).
 */
export async function manualReAnchor(
  repo: RepoInfo,
  supersededRevs: string[],
  ontoRev: string,
): Promise<{ event: EvidenceEvent | null; superseded: string[]; successor: string }> {
  const resolve = async (rev: string): Promise<string> => {
    const sha = (await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
      cwd: repo.root,
      allowFailure: true,
    })).trim();
    if (!sha) throw new Error(`cledger re-anchor: cannot resolve "${rev}" to a commit`);
    return sha;
  };
  const successor = await resolve(ontoRev);
  const superseded = [];
  for (const rev of supersededRevs) {
    // A superseded commit may already be GC'd (its branch deleted long ago)
    // — the mapping is how its still-enumerable note stays meaningful — so a
    // full SHA is taken at its word; only shorthand needs a live object.
    superseded.push(/^[0-9a-f]{40}$/.test(rev) ? rev : await resolve(rev));
  }

  const identity = await gitUserIdentity(repo);
  const actor: Actor = { type: "human" };
  if (identity.email) actor.id = identity.email;
  if (identity.name) actor.display = identity.name;

  const result = await appendEvents(
    repo,
    [
      reAnchorDraft({
        superseded,
        successor,
        method: "manual",
        occurredAt: await commitDateIso(repo, successor),
        actor,
      }),
    ],
    { anchor: successor },
  );
  // null means an identical mapping already exists — dedup, not failure.
  return { event: result.appended[0] ?? null, superseded, successor };
}

/**
 * Default-on half of re-anchoring (config: {"reanchor": {"auto": false}} to
 * disable): runs inside every read, right after absorbIncoming, so a plain
 * `git fetch` + `cledger log` is enough for a squash-merged branch's
 * conversations to follow the squash commit. The detection pass costs a
 * handful of subprocesses per local branch, so it is gated on a cursor over
 * the target tip and only runs when the target actually moved. Never throws
 * — a read must never fail because detection did. The known gap the cursor
 * accepts: conversations captured onto an already-dead branch after the
 * target was seen won't auto-map until the target moves again — `cledger
 * re-anchor` covers that manually.
 */
async function autoReAnchor(repo: RepoInfo): Promise<void> {
  try {
    const config = await loadConfig(repo.root);
    if (config.reanchor?.auto === false) return;
    const target = await defaultRewriteTarget(repo);
    if (!target) return;
    const tip = (await git(["rev-parse", "--verify", "--quiet", target], {
      cwd: repo.root,
      allowFailure: true,
    })).trim();
    if (!tip) return;
    const cursorPath = join(stateDir(repo), "reanchor-cursor");
    let seen = "";
    try {
      seen = (await readFile(cursorPath, "utf8")).trim();
    } catch {
      // first run, or unreadable state — state is rebuildable
    }
    if (seen === tip) return;
    const result = await runReAnchor(repo, { target, apply: true });
    if (result.applied.length > 0) {
      const anchors = result.detected.reduce((n, d) => n + d.notedAnchors, 0);
      process.stderr.write(
        `cledger: re-anchored ${anchors} conversation anchor(s) rewritten away by ${target} ` +
          `(mappings recorded in the ledger)\n`,
      );
    }
    if (result.ambiguous.length > 0) {
      process.stderr.write(
        `cledger: branch(es) ${result.ambiguous.join(", ")} look rewritten onto ${target} but ` +
          `match more than one commit — run \`cledger re-anchor\` to resolve manually\n`,
      );
    }
    await ensureStateDir(repo);
    await writeFile(cursorPath, tip + "\n");
  } catch {
    // Reads must never fail because detection did.
  }
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

/** Thrown when the layer-E scan gate blocks a push; carries no secrets. */
export class ScanBlockedError extends Error {
  constructor(public readonly findings: number) {
    super(`cledger sync: push blocked — ${findings} potential secret(s) found (see report above)`);
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
  throw new ScanBlockedError(findings.length);
}

/**
 * Sync of the single ledger ref: explicit via `cledger sync`, or run by the
 * pre-push transport hook (see transportPush). The fetch phase stages into
 * INCOMING_REF and absorbs it — the same path a plain `git fetch` plus a
 * later read takes.
 */
export async function sync(
  repo: RepoInfo,
  remote = "origin",
  mode: "both" | "push" | "fetch" = "both",
  opts: { skipScan?: boolean; paranoid?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = { fetched: false, pushed: false };
  await ensureMergeConfig(repo);
  if (mode !== "push") {
    await git(
      ["fetch", remote, `+${NOTES_REF}:${INCOMING_REF}`],
      { cwd: repo.root, allowFailure: true },
    );
    result.fetched = await absorbIncoming(repo);
  }
  if (mode !== "fetch") {
    const config = await loadConfig(repo.root);
    const scanDisabled = opts.skipScan === true || config.scan?.tier === "off";
    if (!scanDisabled) {
      const tier: "standard" | "paranoid" =
        opts.paranoid === true || config.scan?.tier === "paranoid" ? "paranoid" : "standard";
      await runScanGate(repo, remote, tier);
    }
    // The pushed child git inherits CLEDGER_INTERNAL, telling the pre-push
    // transport hook this push *is* the ledger push — no recursion.
    const prior = process.env["CLEDGER_INTERNAL"];
    process.env["CLEDGER_INTERNAL"] = "1";
    try {
      await git(["push", remote, `${NOTES_REF}:${NOTES_REF}`], { cwd: repo.root });
    } finally {
      if (prior === undefined) delete process.env["CLEDGER_INTERNAL"];
      else process.env["CLEDGER_INTERNAL"] = prior;
    }
    result.pushed = true;
  }
  return result;
}

export interface TransportPushResult {
  pushed: boolean;
  /** True when scan findings held the ledger back (non-strict mode). */
  held: boolean;
}

/**
 * Pre-push hook entrypoint policy. Pushes the ledger ref alongside the
 * user's own push. A scan finding blocks only the ledger by default —
 * secrets never leave the machine, but a false positive never blocks
 * shipping code; {"transport": {"strict": true}} escalates to aborting the
 * whole push (rethrows ScanBlockedError; the CLI exits nonzero). Any other
 * failure (network, missing remote ref perms) warns and lets the push
 * proceed — the hook must never make `git push` flaky.
 */
export async function transportPush(repo: RepoInfo, remote: string): Promise<TransportPushResult> {
  const config = await loadConfig(repo.root);
  if (config.transport?.hook === false) return { pushed: false, held: false };
  const hasNotes = (await git(["rev-parse", "--verify", "--quiet", NOTES_REF], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (!hasNotes) return { pushed: false, held: false };

  try {
    await sync(repo, remote, "push");
    return { pushed: true, held: false };
  } catch (err) {
    if (err instanceof ScanBlockedError) {
      if (config.transport?.strict === true) throw err;
      process.stderr.write(
        "cledger: conversation records were held back from this push (potential secrets — " +
          "see report above); your code push continues. Run `cledger sync` to review and " +
          "remediate.\n",
      );
      return { pushed: false, held: true };
    }
    process.stderr.write(
      `cledger: ledger push skipped (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return { pushed: false, held: false };
  }
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
  /**
   * Count of newly-remembered secret values written to the opt-in
   * known-secrets store (0 unless `redact.knownSecrets` is on and this was a
   * `--pattern` redaction that matched at least one not-already-known value).
   */
  knownSecretsRemembered: number;
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

  // Opt-in: when on, remember the exact values a --pattern redaction scrubs so
  // capture-time redaction can keep them out of future events (see
  // redact/known-secrets.ts). The --all path blanks whole content, so there is
  // no reusable value to remember there.
  const config = await loadConfig(repo.root);
  const rememberSecrets = hasPattern && config.redact?.knownSecrets === true;

  const { located, rewritten, newRecords, secretValues } = await withLock(repo, async () => {
    const located = await locateEvent(repo, idPrefix);
    const original = located.event;

    let rewrittenContent: unknown = original.content;
    let rewrittenRaw = original.raw;
    const newRecords: RedactionRecord[] = [];
    const secretValues: string[] = [];

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
      if (rememberSecrets) {
        secretValues.push(...collectMatches(original.content, pattern));
        if (original.raw) secretValues.push(...collectMatches(original.raw.data, pattern));
      }
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

    return { located, rewritten, newRecords, secretValues };
  });

  // Persist remembered secret values outside the notes lock (the store is its
  // own file under .git/, unrelated to the notes ref). addKnownSecrets applies
  // the min-length filter and dedups, returning how many were newly stored.
  let knownSecretsRemembered = 0;
  if (rememberSecrets && secretValues.length > 0) {
    const before = (await loadKnownSecrets(repo)).length;
    await addKnownSecrets(repo, secretValues);
    knownSecretsRemembered = (await loadKnownSecrets(repo)).length - before;
  }

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

  return { event: rewritten, redactionEvent, squashed, knownSecretsRemembered };
}
