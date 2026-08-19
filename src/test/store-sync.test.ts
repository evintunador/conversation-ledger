import { test } from "node:test";
import assert from "node:assert";
import { git } from "../git.js";
import { appendEvents, readEvents, sync } from "../store.js";
import { cleanupDir, cleanupRepo, draft, makeBareRepo, makeCommit, makeTempRepo } from "./helpers.js";

test("sync: push from one repo, fetch into another, via a shared bare remote", async () => {
  const remote = await makeBareRepo();
  const a = await makeTempRepo("cledger-sync-a-");
  const b = await makeTempRepo("cledger-sync-b-");
  try {
    await makeCommit(a, "init a");
    await appendEvents(a, [draft({ content: { text: "from-a" } })]);
    await git(["remote", "add", "origin", remote], { cwd: a.root });
    const pushResult = await sync(a, "origin", "push");
    assert.strictEqual(pushResult.pushed, true);
    assert.strictEqual(pushResult.fetched, false);

    // B has entirely unrelated commit history but shares the bare remote.
    await makeCommit(b, "init b");
    await git(["remote", "add", "origin", remote], { cwd: b.root });
    const fetchResult = await sync(b, "origin", "fetch");
    assert.strictEqual(fetchResult.fetched, true);
    assert.strictEqual(fetchResult.pushed, false);

    // B's history is deliberately unrelated to A's, so A's anchor is
    // unreachable from B's HEAD. This test is about transport, so it asks for
    // the whole local ledger; the default scope correctly reports nothing,
    // which the assertion below pins rather than leaves to chance.
    const bEvents = await readEvents(b, { reachableFrom: null });
    assert.strictEqual(bEvents.length, 1);
    assert.deepStrictEqual(bEvents[0]?.content, { text: "from-a" });
    assert.deepStrictEqual(
      await readEvents(b),
      [],
      "arrived is not the same question as reachable from here",
    );
  } finally {
    await cleanupRepo(a);
    await cleanupRepo(b);
    await cleanupDir(remote);
  }
});

test("sync: concurrent divergent appends in two repos both survive a both-ways sync", async () => {
  const remote = await makeBareRepo();
  const a = await makeTempRepo("cledger-sync-a-");
  const b = await makeTempRepo("cledger-sync-b-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: a.root });
    await git(["remote", "add", "origin", remote], { cwd: b.root });

    // A appends on its own commit and seeds the remote first.
    await makeCommit(a, "init a");
    await appendEvents(a, [draft({ content: { text: "event-x" } })]);
    await sync(a, "origin", "push");

    // B independently appends on a completely different commit before ever
    // talking to the remote — a genuinely divergent, concurrent write.
    await makeCommit(b, "init b");
    await appendEvents(b, [draft({ content: { text: "event-y" } })]);

    // B syncs both ways: fetches A's note (merges via cat_sort_uniq with its
    // own), then pushes the merged result back.
    const bBoth = await sync(b, "origin", "both");
    assert.strictEqual(bBoth.fetched, true);
    assert.strictEqual(bBoth.pushed, true);

    // Both repos sit on unrelated commits, so neither reaches the other's
    // anchor; the merge is what is under test, not the read scope.
    const bEvents = await readEvents(b, { reachableFrom: null });
    assert.strictEqual(bEvents.length, 2);
    assert.deepStrictEqual(
      bEvents.map((e) => JSON.stringify(e.content)).sort(),
      [{ text: "event-x" }, { text: "event-y" }].map((c) => JSON.stringify(c)).sort(),
    );

    // A fetches again and must now see B's event too.
    const aFetch = await sync(a, "origin", "fetch");
    assert.strictEqual(aFetch.fetched, true);

    const aEvents = await readEvents(a, { reachableFrom: null });
    assert.strictEqual(aEvents.length, 2);
    const aContents = aEvents.map((e) => JSON.stringify(e.content)).sort();
    const bContents = bEvents.map((e) => JSON.stringify(e.content)).sort();
    assert.deepStrictEqual(aContents, bContents);
  } finally {
    await cleanupRepo(a);
    await cleanupRepo(b);
    await cleanupDir(remote);
  }
});
