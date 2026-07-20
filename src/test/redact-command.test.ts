import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "../git.js";
import {
  appendEvents,
  listAnchors,
  NOTES_REF,
  readEvents,
  readNoteEvents,
  readPending,
  redactEvent,
  sync,
} from "../store.js";
import {
  cleanupDir,
  cleanupRepo,
  draft,
  makeBareRepo,
  makeCommit,
  makeTempRepo,
} from "./helpers.js";

test("redactEvent: --pattern rewrites content+raw, preserves the id, appends a redacts companion, and squashes local history", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const secret = "hunter2xK9aa"; // format the capture-tier ruleset does not recognize
    const originalDraft = draft({
      content: { text: `db_password: ${secret}` },
      raw: { format: "test/1", data: { blob: `db_password: ${secret}` } },
    });
    const appendResult = await appendEvents(repo, [originalDraft]);
    assert.strictEqual(appendResult.appended.length, 1);
    const original = appendResult.appended[0]!;
    assert.ok(
      JSON.stringify(original).includes(secret),
      "sanity: this secret shape must survive capture-tier redaction unredacted",
    );

    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret, reason: "test-reason" });

    // Id preservation is the crux of the whole mechanism: rewriting the
    // content must not change the event's id (see the CRITICAL comment in
    // store.ts) or a later rescan would resurrect the secret under the old
    // id.
    assert.strictEqual(result.event.id, original.id);
    assert.ok(!JSON.stringify(result.event.content).includes(secret));
    assert.ok(!JSON.stringify(result.event.raw ?? {}).includes(secret));
    assert.ok(result.event.redactions?.some((r) => r.rule === "manual"));

    // Companion event.
    assert.strictEqual(result.redactionEvent.kind, "redaction");
    assert.deepStrictEqual(result.redactionEvent.links, [{ rel: "redacts", target: original.id }]);
    const companionContent = result.redactionEvent.content as {
      target: string;
      mode: string;
      reason?: string;
    };
    assert.strictEqual(companionContent.target, original.id);
    assert.strictEqual(companionContent.mode, "pattern");
    assert.strictEqual(companionContent.reason, "test-reason");

    // The stored note itself reflects the rewrite, not just the returned object.
    const [anchor] = await listAnchors(repo);
    assert.ok(anchor);
    const stored = await readNoteEvents(repo, anchor);
    const storedTarget = stored.find((e) => e.id === original.id);
    assert.ok(storedTarget);
    assert.ok(!JSON.stringify(storedTarget).includes(secret));

    // No remote configured: local notes history is squashed to one commit.
    assert.strictEqual(result.squashed, true);
    const log = await git(["log", "--oneline", NOTES_REF], { cwd: repo.root });
    assert.strictEqual(log.trim().split("\n").filter(Boolean).length, 1);

    // THE dedup test: re-appending the exact original, unredacted draft
    // must not resurrect the secret under a new event. Because the
    // rewritten event kept the original id, recomputing the id for the
    // same source draft collides with the id already on record (which now
    // holds redacted content), so it dedups instead of creating a second,
    // unredacted copy.
    const rescan = await appendEvents(repo, [originalDraft]);
    assert.strictEqual(rescan.appended.length, 0, "the secret must not be able to sneak back in via rescan");
    assert.strictEqual(rescan.deduped, 1);

    const eventsAfterRescan = await readEvents(repo);
    const copiesOfTarget = eventsAfterRescan.filter((e) => e.id === original.id);
    assert.strictEqual(copiesOfTarget.length, 1, "must still be exactly one copy of the event under this id");
    assert.ok(!JSON.stringify(copiesOfTarget[0]).includes(secret));
  } finally {
    await cleanupRepo(repo);
  }
});

test("redactEvent: --all replaces content with a placeholder and drops raw entirely", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const secret = "hunter2xK9aa";
    const appendResult = await appendEvents(repo, [
      draft({
        content: { text: `db_password: ${secret}` },
        raw: { format: "test/1", data: { blob: `db_password: ${secret}` } },
      }),
    ]);
    const original = appendResult.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { all: true });

    assert.strictEqual(result.event.id, original.id);
    assert.strictEqual(typeof result.event.content, "string");
    assert.match(result.event.content as string, /^\[REDACTED:manual:[0-9a-f]{12}\]$/);
    assert.strictEqual(result.event.raw, undefined);
    assert.strictEqual(result.squashed, true);
  } finally {
    await cleanupRepo(repo);
  }
});

test("redactEvent: pending-queue redaction works before the first commit exists, no squash needed", async () => {
  const repo = await makeTempRepo();
  try {
    const secret = "hunter2xK9aa";
    const appendResult = await appendEvents(repo, [draft({ content: { text: `db_password: ${secret}` } })]);
    assert.strictEqual(appendResult.anchor, null, "HEAD must still be unborn");
    const original = appendResult.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret });

    assert.strictEqual(result.event.id, original.id);
    assert.strictEqual(result.squashed, false, "nothing was ever anchored, so there is no history to squash");
    assert.ok(!JSON.stringify(result.event.content).includes(secret));

    const pending = await readPending(repo);
    const target = pending.find((e) => e.id === original.id);
    assert.ok(target, "rewritten target must still be in the pending queue");
    assert.ok(!JSON.stringify(target).includes(secret));

    const companion = pending.find((e) =>
      e.links?.some((l) => l.rel === "redacts" && l.target === original.id),
    );
    assert.ok(companion, "companion redaction event must also be queued (HEAD is still unborn)");
  } finally {
    await cleanupRepo(repo);
  }
});

test("redactEvent: when origin already has the notes ref, squash is skipped and a warning is printed", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const secret = "hunter2xK9aa";
    const appendResult = await appendEvents(repo, [draft({ content: { text: `db_password: ${secret}` } })]);
    const original = appendResult.appended[0]!;

    // Seed the remote with the pre-redaction content. This secret shape
    // trips the standard-tier keyword-assignment scan rule, so bypass the
    // gate here — that's the exact precondition this test needs, not what
    // it's testing.
    const pushResult = await sync(repo, "origin", "push", { skipScan: true });
    assert.strictEqual(pushResult.pushed, true);

    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let result;
    try {
      result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.strictEqual(result.squashed, false);
    assert.ok(
      stderrChunks.some((c) => c.includes("skipping the local squash")),
      "expected a warning that already-shared history was not squashed",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("redactEvent: throws when no event matches the id prefix", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await assert.rejects(() => redactEvent(repo, "ev1-doesnotexist", { all: true }), /no event matches/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("redactEvent: requires exactly one of --pattern or --all", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await assert.rejects(() => redactEvent(repo, "ev1-x", {}), /exactly one of/);
    await assert.rejects(
      () => redactEvent(repo, "ev1-x", { pattern: "x", all: true }),
      /exactly one of/,
    );
  } finally {
    await cleanupRepo(repo);
  }
});
