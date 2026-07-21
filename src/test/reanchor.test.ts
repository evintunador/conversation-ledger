import assert from "node:assert/strict";
import { test } from "node:test";
import { git } from "../git.js";
import { appendEvents, readEvents } from "../store.js";
import { parseReAnchor, reAnchorDraft } from "../reanchor.js";
import { finalizeEvent } from "../schema.js";
import { cleanupRepo, draft, event, makeCommit, makeTempRepo } from "./helpers.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_S = "c".repeat(40);

test("parseReAnchor accepts a well-formed mapping and rejects malformed ones", () => {
  const good = event({
    kind: "re_anchor",
    content: { superseded: [SHA_A, SHA_B], successor: SHA_S, method: "patch-id", branch: "feat" },
  });
  const mapping = parseReAnchor(good);
  assert.ok(mapping);
  assert.deepEqual(mapping.superseded, [SHA_A, SHA_B]);
  assert.equal(mapping.successor, SHA_S);
  assert.equal(mapping.method, "patch-id");
  assert.equal(mapping.branch, "feat");

  // Wrong kind: same content, but not a re_anchor event.
  assert.equal(
    parseReAnchor(event({ content: { superseded: [SHA_A], successor: SHA_S } })),
    null,
  );
  // Abbreviated SHAs are ambiguous across clones; only full SHAs count.
  assert.equal(
    parseReAnchor(event({ kind: "re_anchor", content: { superseded: ["abc123"], successor: SHA_S } })),
    null,
  );
  assert.equal(
    parseReAnchor(event({ kind: "re_anchor", content: { superseded: [SHA_A], successor: "abc123" } })),
    null,
  );
  assert.equal(parseReAnchor(event({ kind: "re_anchor", content: { successor: SHA_S } })), null);
  assert.equal(
    parseReAnchor(event({ kind: "re_anchor", content: { superseded: [], successor: SHA_S } })),
    null,
  );
  assert.equal(parseReAnchor(event({ kind: "re_anchor", content: "not an object" })), null);
});

test("reAnchorDraft is deterministic across machines: order-independent, system actor", () => {
  const occurredAt = "2026-07-01T12:00:00Z";
  const one = finalizeEvent(
    reAnchorDraft({ superseded: [SHA_B, SHA_A], successor: SHA_S, method: "patch-id", occurredAt }),
  );
  const two = finalizeEvent(
    reAnchorDraft({ superseded: [SHA_A, SHA_B], successor: SHA_S, method: "patch-id", occurredAt }),
  );
  // Same mapping discovered in a different order on another machine must
  // produce the same id, or cat_sort_uniq syncs would accumulate duplicates.
  assert.equal(one.id, two.id);
  assert.equal(one.actor.type, "system");
  assert.deepEqual((one.content as { superseded: string[] }).superseded, [SHA_A, SHA_B]);
});

test("appendEvents anchors to an explicit anchor when given, not HEAD", async () => {
  const repo = await makeTempRepo();
  try {
    const first = await makeCommit(repo, "first");
    await makeCommit(repo, "second");
    const result = await appendEvents(repo, [draft()], { anchor: first });
    assert.equal(result.anchor, first);
    const note = await git(["notes", "--ref", "conversation-ledger", "show", first], {
      cwd: repo.root,
    });
    assert.ok(note.includes('"hello"'));
  } finally {
    await cleanupRepo(repo);
  }
});

/**
 * The squash-merge scenario end to end: conversations captured on a feature
 * branch, branch squashed onto main (here simulated by an ordinary commit —
 * resolution trusts the mapping event; *establishing* it is detection's
 * job), mapping appended anchored to the squash commit.
 */
test("a re_anchor mapping makes squash-orphaned conversations reachable again", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const a = await makeCommit(repo, "feat work 1");
    await appendEvents(repo, [draft({ content: { text: "turn on A" } })]);
    const b = await makeCommit(repo, "feat work 2");
    await appendEvents(repo, [draft({ content: { text: "turn on B" }, occurred_at: "2026-01-02T00:00:00.000Z" })]);
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    const squash = await makeCommit(repo, "feat squashed (#1)");

    // Baseline: the squash orphaned both conversations from main's view.
    const before = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.equal(before.length, 0);

    await appendEvents(
      repo,
      [
        reAnchorDraft({
          superseded: [a, b],
          successor: squash,
          method: "patch-id",
          occurredAt: "2026-01-03T00:00:00.000Z",
          branch: "feat",
        }),
      ],
      { anchor: squash },
    );

    const after = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.deepEqual(
      after.map((e) => (e.content as { text: string }).text),
      ["turn on A", "turn on B"],
    );
    // The unscoped view is unchanged by mappings — it already saw everything.
    const all = await readEvents(repo, { kind: "conversation_turn" });
    assert.equal(all.length, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("resolution follows chained mappings (a squash commit itself rewritten)", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const a = await makeCommit(repo, "feat work");
    await appendEvents(repo, [draft({ content: { text: "original turn" } })]);

    // First rewrite: feat squashed to s1 on a staging branch.
    await git(["checkout", "-q", "-b", "staging", "main"], { cwd: repo.root });
    const s1 = await makeCommit(repo, "feat squashed");
    await appendEvents(
      repo,
      [reAnchorDraft({ superseded: [a], successor: s1, method: "patch-id", occurredAt: "2026-01-04T00:00:00.000Z" })],
      { anchor: s1 },
    );

    // Second rewrite: staging itself squashed onto main; s1 is now orphaned too.
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    const s2 = await makeCommit(repo, "staging squashed");
    await appendEvents(
      repo,
      [reAnchorDraft({ superseded: [s1], successor: s2, method: "patch-id", occurredAt: "2026-01-05T00:00:00.000Z" })],
      { anchor: s2 },
    );

    // main reaches s2 only; s2's mapping revives s1, whose note holds the
    // mapping that revives a — two hops.
    const events = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.deepEqual(events.map((e) => (e.content as { text: string }).text), ["original turn"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a mapping whose successor is not reachable changes nothing", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const a = await makeCommit(repo, "feat work");
    await appendEvents(repo, [draft({ content: { text: "orphaned turn" } })]);
    await git(["checkout", "-q", "-b", "other", "main"], { cwd: repo.root });
    const unreachableSuccessor = await makeCommit(repo, "on another branch");
    await git(["checkout", "-q", "main"], { cwd: repo.root });

    // Mapping is anchored to a commit main can see, but its successor lives
    // on a branch main cannot — applying it would claim conversations for a
    // view that does not contain the successor's work.
    const mainTip = (await git(["rev-parse", "main"], { cwd: repo.root })).trim();
    await appendEvents(
      repo,
      [
        reAnchorDraft({
          superseded: [a],
          successor: unreachableSuccessor,
          method: "manual",
          occurredAt: "2026-01-06T00:00:00.000Z",
        }),
      ],
      { anchor: mainTip },
    );

    const events = await readEvents(repo, { reachableFrom: "main", kind: "conversation_turn" });
    assert.equal(events.length, 0);
  } finally {
    await cleanupRepo(repo);
  }
});
