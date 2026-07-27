/**
 * Local state must be shared by every working tree of a repo.
 *
 * `git rev-parse --absolute-git-dir` answers with the *per-worktree* git
 * directory (`<main>/.git/worktrees/<name>/`), which is correct for HEAD and
 * the index and wrong for everything cledger keeps: the allowlist, the
 * known-secrets store, capture cursors, and the pre-push hook. Hanging them
 * off it made a linked worktree behave like a different repo — findings
 * reappeared, learned secrets stopped being scrubbed, transcripts re-scanned
 * from the top, and the installed hook was one git would never run.
 *
 * Every test here covers a *linked worktree at an arbitrary path outside the
 * repo*, which is the harder of the two placements to get right and the one
 * least likely to be exercised by accident. Git makes no distinction between
 * a worktree nested under the repo and one somewhere else — `resolveCommonDir`
 * is verified against both in the first test — so covering the external case
 * covers `.claude/worktrees/` too.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, git, type RepoInfo } from "../git.js";
import { appendEvents, readEvents } from "../store.js";
import { captureClaudeTranscript } from "../adapters/claude-code.js";
import { addToAllowlist, filterFindings, loadAllowlist, scanEvents } from "../redact/scan.js";
import { addKnownSecrets } from "../redact/known-secrets.js";
import { finalizeEvent } from "../schema.js";
import {
  cleanupDir,
  cleanupRepo,
  draft,
  makeBareRepo,
  makeCommit,
  makeTempRepo,
} from "./helpers.js";

/** Add a linked worktree on a new branch and resolve it as a repo. */
async function addWorktree(repo: RepoInfo, path: string, branch: string): Promise<RepoInfo> {
  await git(["worktree", "add", "-q", "-b", branch, path], { cwd: repo.root });
  const wt = await findRepo(path);
  if (!wt) throw new Error("failed to resolve the linked worktree");
  return wt;
}

/** A path outside the repo entirely — the arbitrary-location case. */
async function externalPath(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return join(dir, "wt");
}

async function writeTranscript(dir: string, sessionId: string, turns: number): Promise<string> {
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        sessionId,
        version: "2.1.220",
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        message: { role: "user", content: `turn ${i}` },
      }),
    );
  }
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("findRepo: commonDir is the shared git dir from a worktree, nested or external", async () => {
  const repo = await makeTempRepo("cledger-wt-common-");
  const outside = await externalPath("cledger-wt-outside-");
  try {
    await makeCommit(repo, "init");
    const nested = await addWorktree(repo, join(repo.root, "nested-wt"), "nested");
    const external = await addWorktree(repo, outside, "external");

    // The main checkout: the two dirs coincide, and commonDir is absolute
    // even though `git rev-parse --git-common-dir` answers a bare ".git" here.
    assert.strictEqual(repo.commonDir, repo.gitDir);
    assert.ok(repo.commonDir.startsWith("/"), "commonDir must always be absolute");

    for (const wt of [nested, external]) {
      assert.notStrictEqual(
        wt.gitDir,
        wt.commonDir,
        "a linked worktree has its own git dir, distinct from the shared one",
      );
      assert.ok(wt.gitDir.includes(join(".git", "worktrees")));
      assert.strictEqual(
        wt.commonDir,
        repo.commonDir,
        "every working tree must resolve to the same shared git dir",
      );
    }
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(join(outside, ".."));
  }
});

test("allowlist written in the main checkout applies inside a worktree", async () => {
  const repo = await makeTempRepo("cledger-wt-allow-");
  const outside = await externalPath("cledger-wt-allow-out-");
  try {
    await makeCommit(repo, "init");
    const secretish = draft({ content: { text: 'db_password = "hunter2hunter2hunter2"' } });
    await appendEvents(repo, [secretish]);

    const events = await readEvents(repo);
    const findings = scanEvents(events, "standard");
    assert.ok(findings.length > 0, "the fixture must trip a scan rule to be worth allowlisting");
    await addToAllowlist(repo, [findings[0]!.fingerprint]);
    assert.strictEqual(filterFindings(findings, await loadAllowlist(repo)).length, 0);

    // Same repo, different working tree: the dismissal must still hold.
    const wt = await addWorktree(repo, outside, "feat");
    assert.strictEqual(
      filterFindings(scanEvents(await readEvents(wt, {}), "standard"), await loadAllowlist(wt)).length,
      0,
      "a finding dismissed once must stay dismissed in every working tree",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(join(outside, ".."));
  }
});

test("known secrets learned in the main checkout are still scrubbed when capturing from a worktree", async () => {
  // This one failed *open* before the fix: capture from a worktree could not
  // see the store, so a value the user had explicitly taught cledger to
  // redact was written to the ledger in the clear, with nothing reporting it.
  const repo = await makeTempRepo("cledger-wt-known-");
  const outside = await externalPath("cledger-wt-known-out-");
  const transcripts = await mkdtemp(join(tmpdir(), "cledger-wt-known-tr-"));
  try {
    await makeCommit(repo, "init");
    // `.cledger.json` is repo config in the working tree, so it must be
    // committed to exist in the worktree's checkout at all — unlike the
    // `.git`-side state this suite is about, being per-working-tree is
    // correct for a tracked file.
    await writeFile(
      join(repo.root, ".cledger.json"),
      JSON.stringify({ redact: { knownSecrets: true } }),
    );
    await git(["add", ".cledger.json"], { cwd: repo.root });
    await git(["commit", "-q", "-m", "enable knownSecrets"], { cwd: repo.root });
    const secret = "swordfish-not-a-real-credential-42";
    const storePath = join(repo.commonDir, "conversation-ledger", "known-secrets.json");
    await addKnownSecrets(repo, [secret]);
    assert.ok(existsSync(storePath), "the store lives under the shared git dir");

    const wt = await addWorktree(repo, outside, "feat");
    const path = join(transcripts, "wt-known.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        type: "user",
        sessionId: "wt-known",
        version: "2.1.220",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: `the value is ${secret} please keep it safe` },
      }) + "\n",
    );
    await captureClaudeTranscript(path, wt.root);

    const serialized = JSON.stringify(await readEvents(wt, {}));
    assert.ok(
      !serialized.includes(secret),
      "a learned secret must be scrubbed at capture time from any working tree",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(join(outside, ".."));
    await cleanupDir(transcripts);
  }
});

test("capture cursors are shared, so moving between working trees does not re-ingest", async () => {
  // The duplication mechanism: append-time dedup only consults the note of
  // the commit being written to, so a re-scan after HEAD moved files a second
  // copy of the same events under a different anchor.
  const repo = await makeTempRepo("cledger-wt-cursor-");
  const outside = await externalPath("cledger-wt-cursor-out-");
  const transcripts = await mkdtemp(join(tmpdir(), "cledger-wt-cursor-tr-"));
  try {
    await makeCommit(repo, "init");
    const path = await writeTranscript(transcripts, "wt-cursor", 3);
    await captureClaudeTranscript(path, repo.root);
    assert.strictEqual((await readEvents(repo, {})).length, 3);

    // Enter a worktree (HEAD now a different commit) and capture the very
    // same, unchanged transcript.
    const wt = await addWorktree(repo, outside, "feat");
    await makeCommit(wt, "feat-1");
    const result = await captureClaudeTranscript(path, wt.root);
    assert.strictEqual(
      result.appended,
      0,
      "the shared cursor must show the transcript was already fully ingested",
    );

    const anchors = (await git(["notes", "--ref", "conversation-ledger", "list"], {
      cwd: repo.root,
    }))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.strictEqual(anchors.length, 1, "no second anchor should have been written");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(join(outside, ".."));
    await cleanupDir(transcripts);
  }
});

test("readEvents collapses the same event id filed under two anchors", async () => {
  // Guards the duplicates already written before cursors became shared: the
  // ledger is append-only, so they cannot be removed, only read through.
  const repo = await makeTempRepo("cledger-wt-dedup-");
  try {
    const first = await makeCommit(repo, "one");
    const event = finalizeEvent(draft({ content: { text: "captured twice" } }));
    await appendEvents(repo, [event], { anchor: first });
    const second = await makeCommit(repo, "two");
    // Same id, different anchor — exactly what a post-HEAD-move rescan does.
    await appendEvents(repo, [event], { anchor: second });

    const raw = (await git(["notes", "--ref", "conversation-ledger", "list"], { cwd: repo.root }))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.strictEqual(raw.length, 2, "the fixture must really have two anchors carrying it");

    const events = await readEvents(repo, {});
    assert.strictEqual(events.length, 1, "reads must return one copy per event id");
    assert.strictEqual(events[0]!.id, event.id);
  } finally {
    await cleanupRepo(repo);
  }
});

test("the pre-push hook installs where git will run it, and fires from a worktree", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-wt-hook-");
  const outside = await externalPath("cledger-wt-hook-out-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "init");
    const wt = await addWorktree(repo, outside, "feat");
    await makeCommit(wt, "feat-1");

    // First capture happens *inside the worktree* — the case that used to
    // install a hook into the worktree's private dir, where git never looks.
    await appendEvents(wt, [draft({ content: { text: "from the worktree" } })]);

    assert.ok(
      existsSync(join(repo.commonDir, "hooks", "pre-push")),
      "the hook must land in the shared hooks dir",
    );
    assert.ok(
      !existsSync(join(wt.gitDir, "hooks", "pre-push")),
      "nothing may be written to the worktree's private hooks dir — git ignores it",
    );
    const hook = await readFile(join(repo.commonDir, "hooks", "pre-push"), "utf8");
    assert.ok(hook.includes("cledger"));

    // And it actually runs: pushing the worktree's branch carries the ledger.
    await git(["push", "origin", "feat"], { cwd: wt.root });
    const ls = (await git(["ls-remote", "origin", "refs/notes/conversation-ledger"], {
      cwd: repo.root,
    })).trim();
    assert.notStrictEqual(ls, "", "the hook must have pushed the notes ref");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(join(outside, ".."));
    await cleanupDir(remote);
  }
});
