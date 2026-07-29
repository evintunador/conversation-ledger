/**
 * Branch-scoped push (0.14.0).
 *
 * Storage is per-commit and reads are per-branch, but a push is per-*ref* and
 * a notes ref carries the entire notes database — so pushing any branch used
 * to ship every branch's conversations. Push is now scoped to the anchors a
 * read at that rev resolves to, which makes distribution agree with
 * visibility.
 *
 * Two properties are easy to get wrong and are pinned here. First, a scoped
 * push must *add* to the remote rather than replace it: the naive
 * implementation (push a tree holding only this branch's notes) silently
 * deletes everyone else's, because the tree you push becomes the remote's
 * whole database. Second, the scope has to resolve re_anchor mappings, or a
 * squash merge drops exactly the conversations re-anchoring exists to save.
 */

import { test } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { git, type RepoInfo } from "../git.js";
import {
  appendEvents,
  listAnchors,
  parsePrePushRefs,
  readNoteEvents,
  sync,
  NOTES_REF,
} from "../store.js";
import { reAnchorDraft } from "../reanchor.js";
import { cleanupDir, cleanupRepo, draft, makeBareRepo, makeCommit, makeTempRepo } from "./helpers.js";

/** Every event id the remote's ledger ref currently holds. */
async function remoteEventIds(repo: RepoInfo, remote: string): Promise<Set<string>> {
  const tmp = "scoped-push-assert";
  const tmpRef = `refs/notes/${tmp}`;
  await git(["update-ref", "-d", tmpRef], { cwd: repo.root, allowFailure: true });
  await git(["fetch", remote, `+${NOTES_REF}:${tmpRef}`], { cwd: repo.root, allowFailure: true });
  const ids = new Set<string>();
  const exists = (await git(["rev-parse", "--verify", "--quiet", tmpRef], {
    cwd: repo.root,
    allowFailure: true,
  })).trim();
  if (exists) {
    for (const anchor of await listAnchors(repo, tmp)) {
      for (const e of await readNoteEvents(repo, anchor, tmp)) ids.add(e.id);
    }
  }
  await git(["update-ref", "-d", tmpRef], { cwd: repo.root, allowFailure: true });
  return ids;
}

/** Append one event on the current branch and return its id. */
async function record(repo: RepoInfo, text: string): Promise<string> {
  const result = await appendEvents(repo, [draft({ content: { text } })]);
  const id = result.appended[0]?.id;
  if (!id) throw new Error(`event "${text}" did not append`);
  return id;
}

test("push carries only the current branch's conversations", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-scoped-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "main-1");
    const onMain = await record(repo, "belongs to main");

    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await makeCommit(repo, "feat-1");
    const onFeat = await record(repo, "belongs to feat");

    await git(["checkout", "-q", "-b", "other", "main"], { cwd: repo.root });
    await makeCommit(repo, "other-1");
    const onOther = await record(repo, "belongs to other");

    // Push from feat: main is in feat's history so it rides along, but the
    // sibling branch `other` must not.
    await git(["checkout", "-q", "feat"], { cwd: repo.root });
    const result = await sync(repo, "origin", "push");
    assert.strictEqual(result.pushed, true);
    assert.notStrictEqual(result.scopedAnchors, null, "push must report a scope");

    const shared = await remoteEventIds(repo, "origin");
    assert.ok(shared.has(onFeat), "the pushed branch's own conversation must be shared");
    assert.ok(shared.has(onMain), "shared history rides along — those commits are being pushed too");
    assert.ok(
      !shared.has(onOther),
      "a sibling branch's conversation must never leave the machine on this push",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("a scoped push adds to the remote instead of replacing it", async () => {
  // The destructive-gotcha guard: a notes ref's tip tree IS the whole
  // database, so pushing a subset tree would drop everything not in it.
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-scoped-add-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const root = await makeCommit(repo, "root");
    await makeCommit(repo, "main-1");
    const onMain = await record(repo, "pushed first, from main");
    await sync(repo, "origin", "push");
    assert.ok((await remoteEventIds(repo, "origin")).has(onMain));

    // Branch from the *root*, so main's anchor is genuinely outside feat's
    // scope. (Branching from main instead would leave main's anchor in
    // scope and the test would pass even for a tree-replacing push.)
    await git(["checkout", "-q", "-b", "feat", root], { cwd: repo.root });
    await makeCommit(repo, "feat-1");
    const onFeat = await record(repo, "pushed second, from feat");
    await sync(repo, "origin", "push");

    const shared = await remoteEventIds(repo, "origin");
    assert.ok(shared.has(onFeat), "the second push must share its own events");
    assert.ok(
      shared.has(onMain),
      "the second push must not delete what the first one shared — pushing a bare subset tree would",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("scope resolves re_anchor mappings, so a squash merge does not drop its conversations", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-scoped-squash-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "main-1");

    // A feature branch with a conversation, then squashed onto main — the
    // squash commit is a *different* commit, so the original anchor becomes
    // unreachable from main.
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const featCommit = await makeCommit(repo, "feat-1");
    const onFeat = await record(repo, "the work that got squashed");

    await git(["checkout", "-q", "main"], { cwd: repo.root });
    const squashed = await makeCommit(repo, "squashed feat (#1)");

    // Without a mapping, feat's conversation is out of main's view entirely.
    await sync(repo, "origin", "push");
    assert.ok(
      !(await remoteEventIds(repo, "origin")).has(onFeat),
      "before re-anchoring, the orphaned conversation is genuinely not part of main",
    );

    // Re-anchoring maps it onto the surviving commit. The mapping event is
    // anchored to the successor, which IS reachable from main.
    await appendEvents(
      repo,
      [
        reAnchorDraft({
          superseded: [featCommit],
          successor: squashed,
          method: "manual",
          occurredAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      { anchor: squashed },
    );

    await sync(repo, "origin", "push");
    assert.ok(
      (await remoteEventIds(repo, "origin")).has(onFeat),
      "a rev-list-only scope would ship the mapping but leave behind the event it points at",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("scope: null pushes the whole ledger", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-scoped-all-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "main-1");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await makeCommit(repo, "feat-1");
    const onFeat = await record(repo, "on feat only");
    await git(["checkout", "-q", "main"], { cwd: repo.root });

    const scoped = await sync(repo, "origin", "push");
    assert.strictEqual(scoped.scopedAnchors !== null, true);
    assert.ok(!(await remoteEventIds(repo, "origin")).has(onFeat), "scoped push excludes feat");

    const all = await sync(repo, "origin", "push", { scope: null });
    assert.strictEqual(all.scopedAnchors, null, "an unscoped push reports no scope");
    assert.ok(
      (await remoteEventIds(repo, "origin")).has(onFeat),
      "--all must still ship everything, including branches not checked out",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("the scan gate only inspects what this push would carry", async () => {
  // Previously a finding anywhere in the ledger blocked every push, so a
  // credential-shaped string in an unrelated branch's conversation held back
  // shipping unrelated work.
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-scoped-scan-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "main-1");
    const onMain = await record(repo, "nothing alarming here");

    await git(["checkout", "-q", "-b", "spicy"], { cwd: repo.root });
    await makeCommit(repo, "spicy-1");
    await record(repo, 'db_password = "hunter2hunter2hunter2"');

    // From main, the flagged event is out of scope: push proceeds.
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    const result = await sync(repo, "origin", "push");
    assert.strictEqual(result.pushed, true, "an out-of-scope finding must not block this push");
    assert.ok((await remoteEventIds(repo, "origin")).has(onMain));

    // From the branch that actually holds it, the gate still fires.
    await git(["checkout", "-q", "spicy"], { cwd: repo.root });
    await assert.rejects(
      sync(repo, "origin", "push"),
      /potential secret/,
      "the gate must still block the branch that carries the finding",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("parsePrePushRefs: takes local shas, skips deletions and noise", () => {
  const zero = "0".repeat(40);
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const stdin = [
    `refs/heads/feat ${a} refs/heads/feat ${zero}`,
    `refs/heads/gone ${zero} refs/heads/gone ${b}`, // deletion: nothing to scope to
    "",
    "garbage",
  ].join("\n");
  assert.deepStrictEqual(parsePrePushRefs(stdin), [a]);
});

test("pre-push hook end to end: pushing a branch you are not on shares that branch", async () => {
  // The behavior the HEAD-only scope got wrong: `git push origin feat` from
  // main used to share nothing of feat.
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-hook-scope-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const root = await makeCommit(repo, "root");
    await appendEvents(repo, [draft({ content: { text: "installs the hook" } })]);

    await git(["checkout", "-q", "-b", "feat", root], { cwd: repo.root });
    await makeCommit(repo, "feat-1");
    const onFeat = await record(repo, "belongs to feat");

    await git(["checkout", "-q", "-b", "other", root], { cwd: repo.root });
    await makeCommit(repo, "other-1");
    const onOther = await record(repo, "belongs to other");

    // Checked out on `other`, but pushing `feat`.
    await git(["push", "origin", "feat"], { cwd: repo.root });

    const shared = await remoteEventIds(repo, "origin");
    assert.ok(shared.has(onFeat), "the pushed branch's conversations must be shared");
    assert.ok(
      !shared.has(onOther),
      "the checked-out branch is not the pushed one and must not ride along",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("an already-installed hook block is upgraded in place, preserving the rest of the file", async () => {
  const repo = await makeTempRepo("cledger-hook-upgrade-");
  try {
    await makeCommit(repo, "init");
    const hookPath = join(repo.commonDir, "hooks", "pre-push");
    // A stale install: cledger's markers around the old </dev/null body,
    // wrapped in a user's own hook content that must survive untouched.
    const stale = [
      "#!/bin/sh",
      "echo 'user hook before'",
      "# >>> conversation-ledger pre-push (added by cledger) >>>",
      "cledger transport-push \"$1\" </dev/null || exit $?",
      "# <<< conversation-ledger pre-push <<<",
      "echo 'user hook after'",
      "",
    ].join("\n");
    await mkdir(join(repo.commonDir, "hooks"), { recursive: true });
    await writeFile(hookPath, stale);

    await appendEvents(repo, [draft({ content: { text: "triggers transport setup" } })]);

    const after = await readFile(hookPath, "utf8");
    assert.ok(after.includes("echo 'user hook before'"), "content before the block must survive");
    assert.ok(after.includes("echo 'user hook after'"), "content after the block must survive");
    assert.ok(!after.includes("</dev/null"), "the stale block body must be replaced");
    assert.ok(after.includes("_cledger_refs"), "the current block reads the pushed refs");
  } finally {
    await cleanupRepo(repo);
  }
});
