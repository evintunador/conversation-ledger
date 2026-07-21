import { git, type RepoInfo } from "./git.js";
import type { Actor, EventDraft, EvidenceEvent } from "./schema.js";

/**
 * Re-anchoring: a `re_anchor` event asserts that commits rewritten away by a
 * squash merge or history rewrite (`superseded`) live on in a `successor`
 * commit. The ledger never moves note lines — the union merge would resurrect
 * anything a removal dropped, and the original anchor is honest provenance —
 * so the mapping is itself an ordinary append-only event, anchored to the
 * successor commit so it rides the surviving branch's DAG. Read-time
 * reachability treats a superseded anchor as reachable whenever its successor
 * is (see resolveAnchors in store.ts).
 */
export interface ReAnchorMapping {
  /** Full SHAs of the commits the rewrite discarded. */
  superseded: string[];
  /** Full SHA of the commit that carries their changes now. */
  successor: string;
  /** How the mapping was established: "tree" | "patch-id" | "manual". */
  method: string;
  /** Branch the superseded commits lived on, when known — human context. */
  branch?: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Parse a `re_anchor` event's content, or null when the event is some other
 * kind or malformed. Resolution must never trust event content: kinds are an
 * open namespace and any tool can append, so a bad mapping is ignored rather
 * than corrupting the reachability view.
 */
export function parseReAnchor(event: EvidenceEvent): ReAnchorMapping | null {
  if (event.kind !== "re_anchor") return null;
  const c = event.content as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const successor = c["successor"];
  const superseded = c["superseded"];
  if (typeof successor !== "string" || !FULL_SHA.test(successor)) return null;
  if (
    !Array.isArray(superseded) ||
    superseded.length === 0 ||
    !superseded.every((s): s is string => typeof s === "string" && FULL_SHA.test(s))
  ) {
    return null;
  }
  const mapping: ReAnchorMapping = {
    superseded,
    successor,
    method: typeof c["method"] === "string" ? c["method"] : "unknown",
  };
  if (typeof c["branch"] === "string") mapping.branch = c["branch"];
  return mapping;
}

export interface ReAnchorDraftOptions {
  superseded: string[];
  successor: string;
  method: "tree" | "patch-id" | "manual";
  /**
   * The successor commit's committer timestamp (ISO 8601). Deliberately NOT
   * "now": occurred_at is part of event identity, and the mapping must hash
   * identically no matter which machine detects the squash or when — that is
   * what lets two machines' independent detections dedup to one event.
   */
  occurredAt: string;
  branch?: string;
  /**
   * Defaults to `{type: "system"}` — mechanical detection has no human
   * author, and a machine-specific actor.id would break cross-machine dedup.
   * Manual mappings pass the confirming user instead: two humans asserting
   * the same mapping yield two events, which is honest provenance.
   */
  actor?: Actor;
}

/**
 * Fingerprint of a change itself, independent of SHAs, parents, and
 * timestamps: `git patch-id --stable` over the diff. Zero context lines
 * (-U0) so unrelated drift near the change — the target branch advancing —
 * does not perturb the fingerprint. Null when the diff is empty (an empty
 * change fingerprints nothing and would match every other empty change).
 */
async function patchIdOf(repo: RepoInfo, base: string, tip: string): Promise<string | null> {
  const diff = await git(["diff", "-U0", base, tip], { cwd: repo.root, allowFailure: true });
  if (!diff.trim()) return null;
  const out = await git(["patch-id", "--stable"], { cwd: repo.root, input: diff, allowFailure: true });
  const id = out.trim().split(/\s+/)[0];
  return id || null;
}

async function treeOf(repo: RepoInfo, rev: string): Promise<string | null> {
  const out = await git(["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], {
    cwd: repo.root,
    allowFailure: true,
  });
  return out.trim() || null;
}

/** Committer timestamp (strict ISO) — the deterministic occurred_at for mappings. */
export async function commitDateIso(repo: RepoInfo, rev: string): Promise<string> {
  return (await git(["show", "-s", "--format=%cI", rev], { cwd: repo.root })).trim();
}

/**
 * The ref rewrites land on: the remote default branch's tracking ref
 * (refs/remotes/origin/HEAD, set at clone time), falling back to the
 * current branch's upstream. Null means detection has nothing to compare
 * against and is a no-op.
 */
export async function defaultRewriteTarget(repo: RepoInfo): Promise<string | null> {
  const originHead = (await git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (originHead) return originHead;
  const upstream = (await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: repo.root, allowFailure: true },
  )).trim();
  return upstream || null;
}

export interface DetectedRewrite {
  mapping: ReAnchorDraftOptions;
  /** How many superseded commits carry conversation notes — why this mapping matters. */
  notedAnchors: number;
}

export interface DetectRewritesResult {
  detected: DetectedRewrite[];
  /**
   * Branches whose changes matched more than one target commit, so no
   * single successor can be mechanically asserted. Surfaced, never guessed.
   */
  ambiguous: string[];
}

/**
 * Find local branches whose commits were rewritten onto `target` off-machine
 * — a forge "Squash and merge" (one commit carrying the branch's cumulative
 * change) or "Rebase and merge" / bot rewrite (per-commit equivalents) — and
 * propose exact mappings. Detection is purely mechanical: a mapping is
 * proposed only when patch-ids (or trees) match exactly; anything fuzzier is
 * a human call and belongs to `cledger re-anchor`'s confirm flow. Branches
 * with no noted commits are skipped outright: mappings exist to rescue
 * conversations, not to catalog every merge.
 *
 * `anchors` is the set of commits carrying notes; `alreadySuperseded` the
 * commits existing mappings already cover (both from the caller, which can
 * read the ledger — this module cannot without an import cycle).
 */
export async function detectRewrites(
  repo: RepoInfo,
  opts: {
    target: string;
    anchors: Set<string>;
    alreadySuperseded: Set<string>;
  },
): Promise<DetectRewritesResult> {
  const detected: DetectedRewrite[] = [];
  const ambiguous: string[] = [];

  const branchesOut = await git(
    ["for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)"],
    { cwd: repo.root, allowFailure: true },
  );
  const branches = branchesOut
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split(" ");
      return { name: name!, sha: sha! };
    });

  // Target-side candidates are shared across branches; fingerprint lazily
  // and once. First-parent only: rewrites land as direct commits on the
  // target branch, and walking into merged-in side legs would re-match the
  // very commits we are trying to map away from.
  const candidateCache = new Map<string, { tree: string | null; patchId: string | null }>();
  const candidatesFor = async (mergeBase: string): Promise<string[]> => {
    const out = await git(
      ["rev-list", "--first-parent", `${mergeBase}..${opts.target}`],
      { cwd: repo.root, allowFailure: true },
    );
    return out.split("\n").filter(Boolean);
  };
  const fingerprint = async (sha: string): Promise<{ tree: string | null; patchId: string | null }> => {
    let fp = candidateCache.get(sha);
    if (!fp) {
      const parent = (await git(["rev-parse", "--verify", "--quiet", `${sha}^`], {
        cwd: repo.root,
        allowFailure: true,
      })).trim();
      fp = {
        tree: await treeOf(repo, sha),
        patchId: parent ? await patchIdOf(repo, parent, sha) : null,
      };
      candidateCache.set(sha, fp);
    }
    return fp;
  };

  for (const branch of branches) {
    // Still reachable from the target: nothing was rewritten away.
    if (await isAncestorOf(repo, branch.sha, opts.target)) continue;
    const mergeBase = (await git(["merge-base", branch.sha, opts.target], {
      cwd: repo.root,
      allowFailure: true,
    })).trim();
    if (!mergeBase) continue;

    const branchCommits = (await git(["rev-list", `${mergeBase}..${branch.sha}`], {
      cwd: repo.root,
      allowFailure: true,
    }))
      .split("\n")
      .filter(Boolean);
    if (branchCommits.length === 0) continue;

    const noted = branchCommits.filter((sha) => opts.anchors.has(sha));
    if (noted.length === 0) continue;
    if (noted.every((sha) => opts.alreadySuperseded.has(sha))) continue;

    const candidates = await candidatesFor(mergeBase);
    if (candidates.length === 0) continue;

    // Squash shape: one target commit carrying the branch's cumulative change.
    const branchTree = await treeOf(repo, branch.sha);
    const branchPatchId = await patchIdOf(repo, mergeBase, branch.sha);
    const squashMatches: { sha: string; method: "tree" | "patch-id" }[] = [];
    for (const candidate of candidates) {
      const fp = await fingerprint(candidate);
      if (branchTree && fp.tree === branchTree) {
        squashMatches.push({ sha: candidate, method: "tree" });
      } else if (branchPatchId && fp.patchId === branchPatchId) {
        squashMatches.push({ sha: candidate, method: "patch-id" });
      }
    }
    if (squashMatches.length > 1) {
      ambiguous.push(branch.name);
      continue;
    }
    if (squashMatches.length === 1) {
      const match = squashMatches[0]!;
      detected.push({
        mapping: {
          superseded: branchCommits,
          successor: match.sha,
          method: match.method,
          occurredAt: await commitDateIso(repo, match.sha),
          branch: branch.name,
        },
        notedAnchors: noted.length,
      });
      continue;
    }

    // Rebase shape: per-commit equivalents. Only noted commits get mappings
    // — one event per rescued anchor, none for conversation-less commits.
    for (const sha of noted) {
      if (opts.alreadySuperseded.has(sha)) continue;
      const parent = (await git(["rev-parse", "--verify", "--quiet", `${sha}^`], {
        cwd: repo.root,
        allowFailure: true,
      })).trim();
      if (!parent) continue;
      const commitPatchId = await patchIdOf(repo, parent, sha);
      if (!commitPatchId) continue;
      const equivalents: string[] = [];
      for (const candidate of candidates) {
        if ((await fingerprint(candidate)).patchId === commitPatchId) equivalents.push(candidate);
      }
      if (equivalents.length > 1) {
        if (!ambiguous.includes(branch.name)) ambiguous.push(branch.name);
        continue;
      }
      if (equivalents.length === 1) {
        detected.push({
          mapping: {
            superseded: [sha],
            successor: equivalents[0]!,
            method: "patch-id",
            occurredAt: await commitDateIso(repo, equivalents[0]!),
            branch: branch.name,
          },
          notedAnchors: 1,
        });
      }
    }
  }

  return { detected, ambiguous };
}

async function isAncestorOf(repo: RepoInfo, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo.root });
    return true;
  } catch {
    return false;
  }
}

/** Build the append-ready draft for a mapping. Caller anchors it to the successor. */
export function reAnchorDraft(opts: ReAnchorDraftOptions): EventDraft {
  const content: Record<string, unknown> = {
    // Sorted so the same mapping serializes to the same canonical bytes
    // regardless of discovery order.
    superseded: [...opts.superseded].sort(),
    successor: opts.successor,
    method: opts.method,
  };
  if (opts.branch) content.branch = opts.branch;
  return {
    kind: "re_anchor",
    occurred_at: opts.occurredAt,
    actor: opts.actor ?? { type: "system" },
    producer: { tool: "cledger" },
    content,
  };
}
