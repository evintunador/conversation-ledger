import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.js";
import {
  currentBranch,
  git,
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
  type EventDraft,
  type EvidenceEvent,
  type RepoContext,
} from "./schema.js";

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

async function readNoteLines(repo: RepoInfo, anchor: string): Promise<string[]> {
  const body = await git(["notes", "--ref", NOTES_NAME, "show", anchor], {
    cwd: repo.root,
    allowFailure: true,
  });
  return body.split("\n").filter((l) => l.trim().length > 0);
}

export async function readNoteEvents(repo: RepoInfo, anchor: string): Promise<EvidenceEvent[]> {
  return (await readNoteLines(repo, anchor)).map(parseEventLine);
}

/** All (anchor commit, note) pairs in the ledger ref. */
export async function listAnchors(repo: RepoInfo): Promise<string[]> {
  const out = await git(["notes", "--ref", NOTES_NAME, "list"], {
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
  const events = drafts.map((draft) =>
    finalizeEvent({ ...draft, context: draft.context ?? context }),
  );
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

/** Explicit, opt-in sync of the single ledger ref. Never runs implicitly. */
export async function sync(
  repo: RepoInfo,
  remote = "origin",
  mode: "both" | "push" | "fetch" = "both",
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
    await git(["push", remote, `${NOTES_REF}:${NOTES_REF}`], { cwd: repo.root });
    result.pushed = true;
  }
  return result;
}
