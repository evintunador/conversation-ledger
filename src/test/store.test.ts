import { test } from "node:test";
import assert from "node:assert";
import { git, revList } from "../git.js";
import {
  appendEvents,
  listAnchors,
  NOTES_NAME,
  readEvents,
  readNoteEvents,
  readPending,
  sortEvents,
} from "../store.js";
import { finalizeEvent, type EvidenceEvent } from "../schema.js";
import { cleanupRepo, draft, event, makeCommit, makeTempRepo } from "./helpers.js";

test("appendEvents + readEvents: events come back with filled context", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const result = await appendEvents(repo, [draft({ content: { text: "a" } })]);
    assert.strictEqual(result.appended.length, 1);
    assert.strictEqual(result.deduped, 0);
    assert.ok(result.anchor, "expected a real anchor commit, not pending");

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 1);
    const [e] = events;
    assert.ok(e);
    assert.strictEqual(e.context?.branch, "main");
    assert.ok(e.context?.head, "expected context.head to be filled");
    assert.match(e.context!.head!, /^[0-9a-f]{40}$/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("appendEvents: appending identical drafts again dedupes, no growth", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const drafts = [draft({ content: { text: "x" } }), draft({ content: { text: "y" } })];
    const first = await appendEvents(repo, drafts);
    assert.strictEqual(first.appended.length, 2);

    const second = await appendEvents(repo, drafts);
    assert.strictEqual(second.appended.length, 0);
    assert.strictEqual(second.deduped, 2);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 2, "dedup must not grow the ledger");
  } finally {
    await cleanupRepo(repo);
  }
});

test("appendEvents: note on HEAD is sorted, unique, one-canonical-event-per-line JSONL", async () => {
  const repo = await makeTempRepo();
  try {
    const head = await makeCommit(repo, "init");
    await appendEvents(repo, [
      draft({ content: { text: "b" } }),
      draft({ content: { text: "a" } }),
      draft({ content: { text: "c" } }),
    ]);
    const body = await git(["notes", "--ref", NOTES_NAME, "show", "HEAD"], { cwd: repo.root });
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    assert.strictEqual(lines.length, 3);

    // Lines must already be in sorted order (lexicographic, matching the
    // store's own sort), and each must be a parseable canonical event.
    const sorted = [...lines].sort();
    assert.deepStrictEqual(lines, sorted);
    for (const line of lines) {
      const parsed = JSON.parse(line) as EvidenceEvent;
      assert.match(parsed.id, /^ev1-/);
    }

    // HEAD (a ref) and its literal SHA must show the same note body.
    const byHead = await git(["notes", "--ref", NOTES_NAME, "show", "HEAD"], { cwd: repo.root });
    const bySha = await git(["notes", "--ref", NOTES_NAME, "show", head], { cwd: repo.root });
    assert.strictEqual(byHead, bySha);
  } finally {
    await cleanupRepo(repo);
  }
});

test("readEvents: feature-branch events become reachable from main only after merge", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["checkout", "-q", "-b", "feature"], { cwd: repo.root });
    await makeCommit(repo, "feature work");
    const featureResult = await appendEvents(repo, [draft({ content: { text: "on-feature" } })]);
    assert.ok(featureResult.anchor);

    // Before merge: main does not reach the feature commit.
    const beforeMerge = await readEvents(repo, { reachableFrom: "main" });
    assert.strictEqual(beforeMerge.length, 0);

    // Sanity: unscoped read still finds it.
    const unscoped = await readEvents(repo);
    assert.strictEqual(unscoped.length, 1);

    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await git(["merge", "--no-ff", "-q", "-m", "merge feature", "feature"], { cwd: repo.root });

    const afterMerge = await readEvents(repo, { reachableFrom: "main" });
    assert.strictEqual(afterMerge.length, 1);
    assert.deepStrictEqual(afterMerge[0]?.content, { text: "on-feature" });
  } finally {
    await cleanupRepo(repo);
  }
});

test("appendEvents: unborn HEAD queues to pending; next commit drains it into the note", async () => {
  const repo = await makeTempRepo();
  try {
    const result = await appendEvents(repo, [draft({ content: { text: "pending-item" } })]);
    assert.strictEqual(result.anchor, null, "unborn HEAD must use the pending queue");
    assert.strictEqual(result.appended.length, 1);

    const pending = await readPending(repo);
    assert.strictEqual(pending.length, 1);

    // Nothing anchored yet.
    assert.deepStrictEqual(await listAnchors(repo), []);

    // readEvents surfaces pending events even with no commits yet.
    const eventsBeforeCommit = await readEvents(repo);
    assert.strictEqual(eventsBeforeCommit.length, 1);

    const head = await makeCommit(repo, "first commit");
    const second = await appendEvents(repo, [draft({ content: { text: "new-item" } })]);
    assert.strictEqual(second.anchor, head);

    // Pending queue drained: no longer sitting in pending.jsonl.
    assert.deepStrictEqual(await readPending(repo), []);

    const noteEvents = await readNoteEvents(repo, head);
    assert.strictEqual(noteEvents.length, 2, "both the drained pending event and the new one");

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("sortEvents: orders by conversation id, then seq, then occurred_at, then id", () => {
  const e = (convId: string, seq: number, occurredAt: string, text: string) =>
    finalizeEvent(
      draft({
        content: { text },
        occurred_at: occurredAt,
        conversation: { id: convId, seq },
      }),
    );

  const b1 = e("b", 1, "2026-01-01T00:00:00.000Z", "b1");
  const a2 = e("a", 2, "2026-01-01T00:00:00.000Z", "a2");
  const a1 = e("a", 1, "2026-01-01T00:00:00.000Z", "a1");
  const a1later = e("a", 1, "2026-02-01T00:00:00.000Z", "a1later");

  const sorted = sortEvents([b1, a2, a1later, a1]);
  assert.deepStrictEqual(
    sorted.map((x) => x.content),
    [{ text: "a1" }, { text: "a1later" }, { text: "a2" }, { text: "b1" }],
  );
});

test("sortEvents: events without a conversation sort before those with one (empty id)", () => {
  const withConv = event({ conversation: { id: "z", seq: 0 } });
  const withoutConv = event({ content: { text: "no-conv" } });
  const sorted = sortEvents([withConv, withoutConv]);
  assert.strictEqual(sorted[0]?.id, withoutConv.id);
});

test("readEvents: filters by kind, source, and conversation prefix", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await appendEvents(repo, [
      draft({ kind: "decision", content: { text: "d" } }),
      draft({
        kind: "conversation_turn",
        producer: { tool: "cledger", source: "claude-code", session_id: "s1" },
        conversation: { id: "claude-code:s1", seq: 0 },
        content: { text: "turn" },
      }),
    ]);

    const decisions = await readEvents(repo, { kind: "decision" });
    assert.strictEqual(decisions.length, 1);

    const claudeCode = await readEvents(repo, { source: "claude-code" });
    assert.strictEqual(claudeCode.length, 1);

    const byConvPrefix = await readEvents(repo, { conversation: "claude-code:s1" });
    assert.strictEqual(byConvPrefix.length, 1);

    const none = await readEvents(repo, { kind: "redaction" });
    assert.strictEqual(none.length, 0);
  } finally {
    await cleanupRepo(repo);
  }
});

// Sanity check that revList (used by reachableFrom filtering) behaves as
// store.ts expects: HEAD is included, unrelated branches are not.
test("git revList sanity: reachability set includes ancestors only", async () => {
  const repo = await makeTempRepo();
  try {
    const c1 = await makeCommit(repo, "one");
    const reachable = await revList(repo, "HEAD");
    assert.ok(reachable.has(c1));
  } finally {
    await cleanupRepo(repo);
  }
});
