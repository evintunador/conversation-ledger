import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { git, type RepoInfo } from "../git.js";
import { appendEvents, manualReAnchor, readEvents, runReAnchor } from "../store.js";
import { parseReAnchor } from "../reanchor.js";
import { cleanupRepo, draft, makeTempRepo } from "./helpers.js";

/**
 * Detection fingerprints diffs, so unlike the resolution tests these need
 * commits with real file changes — empty commits have no patch-id.
 */
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

test("squash with target moved: tree differs, patch-id maps the branch", async () => {
  const repo = await makeTempRepo();
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat 1");
    await appendEvents(repo, [draft({ content: { text: "turn one" } })]);
    await commitFile(repo, "f2.txt", "two\n", "feat 2");
    await appendEvents(repo, [
      draft({ content: { text: "turn two" }, occurred_at: "2026-01-02T00:00:00.000Z" }),
    ]);

    // Target moves independently, then "GitHub" squashes feat onto it — same
    // content changes, one commit, different tree than feat's tip.
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "unrelated.txt", "drift\n", "unrelated work");
    await writeFile(join(repo.root, "f1.txt"), "one\n");
    await writeFile(join(repo.root, "f2.txt"), "two\n");
    await git(["add", "f1.txt", "f2.txt"], { cwd: repo.root });
    await git(["commit", "-q", "-m", "feat (#1)"], { cwd: repo.root });
    const squash = (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();

    assert.equal((await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" })).length, 0);

    const run = await runReAnchor(repo, { target: "main", apply: true });
    assert.equal(run.detected.length, 1);
    assert.equal(run.detected[0]!.mapping.successor, squash);
    assert.equal(run.detected[0]!.mapping.method, "patch-id");
    assert.equal(run.detected[0]!.mapping.branch, "feat");
    assert.equal(run.detected[0]!.notedAnchors, 2);
    assert.equal(run.applied.length, 1);

    const after = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.deepEqual(
      after.map((e) => (e.content as { text: string }).text),
      ["turn one", "turn two"],
    );

    // Re-running detects nothing: the mapping already covers these anchors.
    const again = await runReAnchor(repo, { target: "main", apply: true });
    assert.equal(again.detected.length, 0);
    assert.equal(again.applied.length, 0);
  } finally {
    await cleanupRepo(repo);
  }
});

test("squash with target unmoved matches by tree equality", async () => {
  const repo = await makeTempRepo();
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat 1");
    await appendEvents(repo, [draft({ content: { text: "turn one" } })]);

    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat (#2)");

    const run = await runReAnchor(repo, { target: "main", apply: true });
    assert.equal(run.detected.length, 1);
    assert.equal(run.detected[0]!.mapping.method, "tree");
    const after = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.equal(after.length, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("rebase-merge: per-commit patch-id pairs, mappings only for noted commits", async () => {
  const repo = await makeTempRepo();
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const a = await commitFile(repo, "f1.txt", "one\n", "feat 1");
    await appendEvents(repo, [draft({ content: { text: "noted turn" } })]);
    await commitFile(repo, "f2.txt", "two\n", "feat 2 (no conversation)");

    // "Rebase and merge": the same two changes replayed as new commits on
    // the advanced target.
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "unrelated.txt", "drift\n", "unrelated work");
    const a2 = await commitFile(repo, "f1.txt", "one\n", "feat 1 (rebased)");
    await commitFile(repo, "f2.txt", "two\n", "feat 2 (rebased)");

    const run = await runReAnchor(repo, { target: "main", apply: true });
    // Only the noted commit gets a mapping — no noise for the other.
    assert.equal(run.detected.length, 1);
    assert.deepEqual(run.detected[0]!.mapping.superseded, [a]);
    assert.equal(run.detected[0]!.mapping.successor, a2);

    const after = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.deepEqual(after.map((e) => (e.content as { text: string }).text), ["noted turn"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a change matching two target commits is ambiguous, not guessed", async () => {
  const repo = await makeTempRepo();
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await commitFile(repo, "same.txt", "same\n", "feat adds same.txt");
    await appendEvents(repo, [draft({ content: { text: "orphaned turn" } })]);

    // Target applies the identical change twice (added, reverted, re-added):
    // two candidates with the same patch-id.
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "same.txt", "same\n", "first application");
    await git(["rm", "-q", "same.txt"], { cwd: repo.root });
    await git(["commit", "-q", "-m", "revert"], { cwd: repo.root });
    await commitFile(repo, "same.txt", "same\n", "second application");

    const run = await runReAnchor(repo, { target: "main", apply: true });
    assert.equal(run.detected.length, 0);
    assert.deepEqual(run.ambiguous, ["feat"]);
    assert.equal((await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" })).length, 0);
  } finally {
    await cleanupRepo(repo);
  }
});

test("auto re-anchor: fetch-shaped state + plain read maps the squash, cursor gates re-runs", async () => {
  const repo = await makeTempRepo();
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat 1");
    await appendEvents(repo, [draft({ content: { text: "auto turn" } })]);
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat (#3)");

    // What a clone + fetch would leave behind: a remote-tracking ref for the
    // default branch and origin/HEAD pointing at it.
    await git(["update-ref", "refs/remotes/origin/main", "main"], { cwd: repo.root });
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: repo.root,
    });

    // No explicit re-anchor call: the read itself detects and applies.
    const events = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.deepEqual(events.map((e) => (e.content as { text: string }).text), ["auto turn"]);
    const mappings = (await readEvents(repo, { kind: "re_anchor" })).map(parseReAnchor);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]!.branch, "feat");

    // The cursor now holds the target tip, so the next read skips detection.
    const cursor = join(repo.gitDir, "conversation-ledger", "reanchor-cursor");
    const tip = (await git(["rev-parse", "refs/remotes/origin/main"], { cwd: repo.root })).trim();
    assert.equal((await readFile(cursor, "utf8")).trim(), tip);
  } finally {
    await cleanupRepo(repo);
  }
});

test("manual re-anchor: human actor, dedup on repeat, GC'd full SHAs accepted", async () => {
  const repo = await makeTempRepo();
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const a = await commitFile(repo, "f1.txt", "one\n", "feat 1");
    await appendEvents(repo, [draft({ content: { text: "edited-squash turn" } })]);

    // A maintainer-edited squash: content differs, so detection cannot match
    // it — the human asserts the mapping instead.
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    const squash = await commitFile(repo, "f1.txt", "one, edited during merge\n", "feat (#5)");

    const first = await manualReAnchor(repo, [a], "main");
    assert.ok(first.event);
    assert.equal(first.event.actor.type, "human");
    assert.equal(first.event.actor.id, "test@example.com");
    assert.equal(first.successor, squash);

    const events = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.deepEqual(events.map((e) => (e.content as { text: string }).text), ["edited-squash turn"]);

    // Same assertion again: identical identity, dedups instead of duplicating.
    const second = await manualReAnchor(repo, [a], "main");
    assert.equal(second.event, null);

    // A full SHA whose object no longer exists is accepted verbatim — the
    // note may outlive its GC'd anchor commit.
    const ghost = "d".repeat(40);
    const third = await manualReAnchor(repo, [ghost], "main");
    assert.ok(third.event);
    assert.deepEqual(third.superseded, [ghost]);

    // Shorthand that resolves to nothing is a hard error, not a guess.
    await assert.rejects(() => manualReAnchor(repo, ["nonexistent-branch"], "main"), /cannot resolve/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("auto re-anchor respects {\"reanchor\": {\"auto\": false}}", async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.root, ".cledger.json"), JSON.stringify({ reanchor: { auto: false } }));
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat 1");
    await appendEvents(repo, [draft({ content: { text: "kept orphaned" } })]);
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat (#4)");
    await git(["update-ref", "refs/remotes/origin/main", "main"], { cwd: repo.root });
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: repo.root,
    });

    const events = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.equal(events.length, 0);
  } finally {
    await cleanupRepo(repo);
  }
});
