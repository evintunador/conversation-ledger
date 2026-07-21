import { git, type RepoInfo } from "./git.js";
import { patchIdOf, type UnmatchedBranch } from "./reanchor.js";
import type { ForgeDriver } from "./forge/forge.js";

/**
 * Evidence-ranked candidates for the branches exact matching could not map
 * (a maintainer edited during the squash, conflicts were resolved by hand,
 * two candidates tied). Everything here is *suggestion only*: it runs solely
 * in the explicit `cledger re-anchor` command, is presented with its
 * evidence spelled out, and is applied only when the human runs the printed
 * `--onto` command — misattribution is worse than orphaning, so nothing
 * fuzzy ever auto-applies. Evidence tiers, strongest first:
 *
 *   0  the forge itself reports the commit as the PR's merge commit
 *   1  corroborating text: candidate subject ends in "(#N)" for this
 *      branch's PR, or the branch's commit subjects appear in the
 *      candidate's message (forge squash messages list them)
 *   2  partial content match: some changed files carry byte-identical
 *      changes (per-file patch-id)
 */
export interface Suggestion {
  candidate: string;
  subject: string;
  /** Human-readable evidence lines, strongest first. */
  evidence: string[];
  /** Fraction of changed files (union) with identical per-file patch-ids. */
  fileOverlap: number | null;
  tier: 0 | 1 | 2;
}

export interface BranchSuggestions {
  unmatched: UnmatchedBranch;
  /** Best first; at most three, and only candidates with some evidence. */
  suggestions: Suggestion[];
  /** Caveats worth surfacing: caps applied, forge findings that could not be verified. */
  notes: string[];
}

/** Candidate pools beyond this are truncated (and say so — no silent caps). */
const MAX_CANDIDATES = 200;
/** Per-file fingerprinting beyond this many candidates is skipped (and says so). */
const MAX_FILE_SCORED = 20;
const MAX_SUGGESTIONS = 3;

export async function suggestMappings(
  repo: RepoInfo,
  unmatched: UnmatchedBranch,
  opts: { target: string; forge: ForgeDriver | null },
): Promise<BranchSuggestions> {
  const notes: string[] = [];

  let candidates =
    unmatched.candidates ??
    (await git(["rev-list", "--first-parent", `${unmatched.mergeBase}..${opts.target}`], {
      cwd: repo.root,
      allowFailure: true,
    }))
      .split("\n")
      .filter(Boolean);
  if (candidates.length > MAX_CANDIDATES) {
    notes.push(
      `only the ${MAX_CANDIDATES} newest of ${candidates.length} target commits were considered`,
    );
    candidates = candidates.slice(0, MAX_CANDIDATES);
  }

  const meta = await commitMeta(repo, candidates);
  const branchSubjects = (
    await git(["log", "--format=%s", `${unmatched.mergeBase}..${unmatched.tip}`], {
      cwd: repo.root,
      allowFailure: true,
    })
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const byCandidate = new Map<string, Suggestion>();
  const suggestionFor = (sha: string): Suggestion => {
    let s = byCandidate.get(sha);
    if (!s) {
      s = { candidate: sha, subject: meta.get(sha)?.subject ?? "", evidence: [], fileOverlap: null, tier: 2 };
      byCandidate.set(sha, s);
    }
    return s;
  };
  const addEvidence = (sha: string, tier: 0 | 1 | 2, line: string): void => {
    const s = suggestionFor(sha);
    s.evidence.push(line);
    if (tier < s.tier) s.tier = tier;
  };

  // Tier 0/1: what the forge knows about this branch's PRs.
  const prNumbers: number[] = [];
  if (opts.forge) {
    const prs = await opts.forge.pullRequestsForBranch(unmatched.branch);
    if (prs === null) {
      notes.push(`${opts.forge.name} could not be queried — offline evidence only`);
    } else {
      for (const pr of prs) {
        prNumbers.push(pr.number);
        if (pr.state !== "MERGED" || !pr.mergeCommit) continue;
        const line =
          `${opts.forge.name} PR #${pr.number} "${pr.title}" (merged) reports ` +
          `${pr.mergeCommit.slice(0, 12)} as its merge commit`;
        if (meta.has(pr.mergeCommit)) {
          addEvidence(pr.mergeCommit, 0, line);
        } else if (await commitExists(repo, pr.mergeCommit)) {
          // Real commit, but not on the target's first-parent range we
          // searched — still the forge's own assertion, so still tier 0.
          candidates.push(pr.mergeCommit);
          meta.set(pr.mergeCommit, await singleCommitMeta(repo, pr.mergeCommit));
          addEvidence(pr.mergeCommit, 0, `${line} (outside ${opts.target}'s first-parent range)`);
        } else {
          notes.push(
            `${opts.forge.name} PR #${pr.number} reports merge commit ` +
              `${pr.mergeCommit.slice(0, 12)}, which is not in local history — fetch first?`,
          );
        }
      }
    }
  }

  for (const sha of candidates) {
    const m = meta.get(sha);
    if (!m) continue;
    // Forge squash subjects conventionally end in "(#N)".
    const prRef = m.subject.match(/\(#(\d+)\)\s*$/);
    if (prRef && prNumbers.includes(Number(prRef[1]))) {
      addEvidence(sha, 1, `subject references PR #${prRef[1]}, whose head branch is ${unmatched.branch}`);
    }
    if (branchSubjects.length > 0) {
      const message = `${m.subject}\n${m.body}`;
      const hits = branchSubjects.filter((s) => message.includes(s)).length;
      if (hits > 0) {
        addEvidence(
          sha,
          1,
          `${hits}/${branchSubjects.length} branch commit subject(s) appear in the commit message`,
        );
      }
    }
  }

  // Tier 2: per-file content match. Scored for every candidate that already
  // has evidence, else for every candidate sharing changed paths — capped,
  // since each file costs two diff+patch-id passes.
  const branchFiles = await changedFiles(repo, unmatched.mergeBase, unmatched.tip);
  if (branchFiles.length > 0) {
    let toScore = candidates.filter((sha) => byCandidate.has(sha));
    if (toScore.length === 0) {
      const sharing: { sha: string; shared: number }[] = [];
      for (const sha of candidates) {
        const files = await candidateChangedFiles(repo, sha);
        const shared = files.filter((f) => branchFiles.includes(f)).length;
        if (shared > 0) sharing.push({ sha, shared });
      }
      sharing.sort((a, b) => b.shared - a.shared);
      if (sharing.length > MAX_FILE_SCORED) {
        notes.push(
          `per-file comparison ran on the ${MAX_FILE_SCORED} closest of ${sharing.length} path-sharing commits`,
        );
      }
      toScore = sharing.slice(0, MAX_FILE_SCORED).map((s) => s.sha);
    }
    for (const sha of toScore) {
      const candFiles = await candidateChangedFiles(repo, sha);
      const union = new Set([...branchFiles, ...candFiles]);
      let identical = 0;
      for (const file of branchFiles) {
        if (!candFiles.includes(file)) continue;
        const branchId = await patchIdOf(repo, unmatched.mergeBase, unmatched.tip, file);
        const candId = await patchIdOf(repo, `${sha}^`, sha, file);
        if (branchId !== null && branchId === candId) identical++;
      }
      if (identical > 0) {
        const s = suggestionFor(sha);
        s.fileOverlap = identical / union.size;
        addEvidence(sha, 2, `${identical}/${union.size} changed file(s) carry byte-identical changes`);
      }
    }
  }

  const ordered = [...byCandidate.values()]
    .filter((s) => s.evidence.length > 0)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (b.fileOverlap ?? 0) - (a.fileOverlap ?? 0) ||
        candidates.indexOf(a.candidate) - candidates.indexOf(b.candidate),
    );
  return { unmatched, suggestions: ordered.slice(0, MAX_SUGGESTIONS), notes };
}

interface CommitMeta {
  subject: string;
  body: string;
}

/** Subject+body for many commits in one git call (\x1f field, \x1e record separators). */
async function commitMeta(repo: RepoInfo, shas: string[]): Promise<Map<string, CommitMeta>> {
  const map = new Map<string, CommitMeta>();
  if (shas.length === 0) return map;
  const out = await git(
    ["log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%b%x1e", ...shas],
    { cwd: repo.root, allowFailure: true },
  );
  for (const record of out.split("\x1e")) {
    const [sha, subject, body] = record.replace(/^\n/, "").split("\x1f");
    if (sha && subject !== undefined) map.set(sha, { subject, body: body ?? "" });
  }
  return map;
}

async function singleCommitMeta(repo: RepoInfo, sha: string): Promise<CommitMeta> {
  return (await commitMeta(repo, [sha])).get(sha) ?? { subject: "", body: "" };
}

async function commitExists(repo: RepoInfo, sha: string): Promise<boolean> {
  const out = await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
    cwd: repo.root,
    allowFailure: true,
  });
  return Boolean(out.trim());
}

async function changedFiles(repo: RepoInfo, base: string, tip: string): Promise<string[]> {
  return (await git(["diff", "--name-only", base, tip], { cwd: repo.root, allowFailure: true }))
    .split("\n")
    .filter(Boolean);
}

async function candidateChangedFiles(repo: RepoInfo, sha: string): Promise<string[]> {
  return (
    await git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
      cwd: repo.root,
      allowFailure: true,
    })
  )
    .split("\n")
    .filter(Boolean);
}
