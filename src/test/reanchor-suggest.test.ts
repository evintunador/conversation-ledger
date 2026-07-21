import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { git, type RepoInfo } from "../git.js";
import { appendEvents, runReAnchor } from "../store.js";
import { suggestMappings } from "../reanchor-suggest.js";
import { isGitHubOrigin } from "../forge/github.js";
import type { ForgeDriver, ForgePullRequest } from "../forge/forge.js";
import { cleanupRepo, draft, makeTempRepo } from "./helpers.js";

async function commitFile(
  repo: RepoInfo,
  name: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(repo.root, name), content);
  await git(["add", name], { cwd: repo.root });
  await git(["commit", "-q", "-m", message], { cwd: repo.root });
  return (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();
}

function fakeForge(prs: ForgePullRequest[] | null): ForgeDriver {
  return {
    name: "fakeforge",
    pullRequestsForBranch: async () => prs,
  };
}

/**
 * The canonical suggestion scenario: a two-file branch squash-merged with a
 * maintainer edit to one file, so cumulative fingerprints differ and exact
 * detection reports the branch as unmatched.
 */
async function editedSquashRepo(): Promise<{
  repo: RepoInfo;
  branchCommits: string[];
  squash: string;
}> {
  const repo = await makeTempRepo();
  await commitFile(repo, "base.txt", "base\n", "base");
  await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
  const c1 = await commitFile(repo, "f1.txt", "one\n", "feat: add f1");
  await appendEvents(repo, [draft({ content: { text: "orphaned turn" } })]);
  const c2 = await commitFile(repo, "f2.txt", "two\n", "feat: add f2");
  await git(["checkout", "-q", "main"], { cwd: repo.root });
  await commitFile(repo, "unrelated.txt", "drift\n", "unrelated");
  // GitHub-style squash message (title + "(#N)", body listing the squashed
  // subjects), with f2 edited during the merge.
  await writeFile(join(repo.root, "f1.txt"), "one\n");
  await writeFile(join(repo.root, "f2.txt"), "two, edited during merge\n");
  await git(["add", "f1.txt", "f2.txt"], { cwd: repo.root });
  await git(["commit", "-q", "-m", "feat: the feature (#7)\n\n* feat: add f1\n* feat: add f2"], {
    cwd: repo.root,
  });
  const squash = (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();
  return { repo, branchCommits: [c2, c1], squash };
}

test("edited squash surfaces as unmatched, not silently dropped", async () => {
  const { repo, branchCommits } = await editedSquashRepo();
  try {
    const run = await runReAnchor(repo, { target: "main", apply: true });
    assert.equal(run.detected.length, 0);
    assert.equal(run.unmatched.length, 1);
    assert.equal(run.unmatched[0]!.branch, "feat");
    assert.equal(run.unmatched[0]!.reason, "no-match");
    assert.deepEqual(run.unmatched[0]!.superseded, branchCommits);
    assert.equal(run.unmatched[0]!.notedAnchors, 1);
    // branchCommits is newest-first; the noted one is the older first commit.
    assert.deepEqual(run.unmatched[0]!.noted, [branchCommits[1]]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("forge merge-commit assertion ranks the squash first (tier 0)", async () => {
  const { repo, squash } = await editedSquashRepo();
  try {
    const run = await runReAnchor(repo, { target: "main", apply: false });
    const forge = fakeForge([
      {
        number: 7,
        title: "the feature",
        state: "MERGED",
        headBranch: "feat",
        mergeCommit: squash,
      },
    ]);
    const { suggestions, notes } = await suggestMappings(repo, run.unmatched[0]!, {
      target: "main",
      forge,
    });
    assert.equal(notes.length, 0);
    assert.ok(suggestions.length >= 1);
    const top = suggestions[0]!;
    assert.equal(top.candidate, squash);
    assert.equal(top.tier, 0);
    assert.ok(top.evidence.some((e) => e.includes("fakeforge PR #7") && e.includes("merge commit")));
    // The PR number also corroborates via the "(#7)" subject convention.
    assert.ok(top.evidence.some((e) => e.includes("references PR #7")));
    // f1 matched byte-identically, f2 was edited: 1 of the 2 files touched.
    assert.ok(top.evidence.some((e) => e.includes("1/2 changed file(s)")));
    assert.equal(top.fileOverlap, 0.5);
  } finally {
    await cleanupRepo(repo);
  }
});

test("offline: subject listing + per-file overlap still find the squash (tier 1)", async () => {
  const { repo, squash } = await editedSquashRepo();
  try {
    const run = await runReAnchor(repo, { target: "main", apply: false });
    const { suggestions } = await suggestMappings(repo, run.unmatched[0]!, {
      target: "main",
      forge: null,
    });
    assert.ok(suggestions.length >= 1);
    const top = suggestions[0]!;
    assert.equal(top.candidate, squash);
    assert.equal(top.tier, 1);
    assert.ok(top.evidence.some((e) => e.includes("2/2 branch commit subject(s)")));
  } finally {
    await cleanupRepo(repo);
  }
});

test("an unqueryable forge degrades to offline evidence with a note", async () => {
  const { repo, squash } = await editedSquashRepo();
  try {
    const run = await runReAnchor(repo, { target: "main", apply: false });
    const { suggestions, notes } = await suggestMappings(repo, run.unmatched[0]!, {
      target: "main",
      forge: fakeForge(null),
    });
    assert.ok(notes.some((n) => n.includes("could not be queried")));
    assert.equal(suggestions[0]!.candidate, squash);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a forge merge commit missing locally becomes a note, not a suggestion", async () => {
  const { repo, squash } = await editedSquashRepo();
  try {
    const run = await runReAnchor(repo, { target: "main", apply: false });
    const ghost = "e".repeat(40);
    const { suggestions, notes } = await suggestMappings(repo, run.unmatched[0]!, {
      target: "main",
      forge: fakeForge([
        { number: 7, title: "the feature", state: "MERGED", headBranch: "feat", mergeCommit: ghost },
      ]),
    });
    assert.ok(notes.some((n) => n.includes(ghost.slice(0, 12)) && n.includes("not in local history")));
    assert.ok(suggestions.every((s) => s.candidate !== ghost));
    // Offline evidence still points at the real squash.
    assert.equal(suggestions[0]!.candidate, squash);
  } finally {
    await cleanupRepo(repo);
  }
});

test("isGitHubOrigin recognizes ssh and https origins, rejects others", () => {
  assert.ok(isGitHubOrigin("git@github.com:user/repo.git"));
  assert.ok(isGitHubOrigin("https://github.com/user/repo.git"));
  assert.ok(!isGitHubOrigin("https://gitlab.com/user/repo.git"));
  assert.ok(!isGitHubOrigin("/local/bare/repo"));
});
