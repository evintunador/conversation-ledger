import { test } from "node:test";
import assert from "node:assert";
import { captureOpencodeExport, type OpencodeExport } from "../adapters/opencode.js";
import { readEvents } from "../store.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const SESSION_ID = "ses_test000000000000000000000";
const SESSION_CREATED = 1785583070532; // 2026-08-01T...Z, epoch ms as opencode stores it

/**
 * A session shaped like a real `opencode export`: a user message, then an
 * assistant message mixing reasoning, text, a settled tool call, the
 * bookkeeping parts that must be skipped, and one part type this adapter
 * version does not know (which must be preserved raw-only, not dropped).
 */
function sessionExport(): OpencodeExport {
  return {
    info: {
      id: SESSION_ID,
      directory: "/tmp/whatever",
      title: "Test session",
      version: "1.18.5",
      time: { created: SESSION_CREATED, updated: SESSION_CREATED + 9000 },
    },
    messages: [
      {
        info: {
          id: "msg_user",
          sessionID: SESSION_ID,
          role: "user",
          agent: "build",
          model: { providerID: "ds4", modelID: "deepseek-v4-flash" },
          time: { created: SESSION_CREATED + 1 },
        },
        // seq 0
        parts: [{ id: "prt_0", type: "text", text: "Read note.txt please" }],
      },
      {
        info: {
          id: "msg_asst",
          sessionID: SESSION_ID,
          role: "assistant",
          agent: "build",
          modelID: "deepseek-v4-flash",
          providerID: "ds4",
          time: { created: SESSION_CREATED + 2, completed: SESSION_CREATED + 9000 },
        },
        parts: [
          // seq 1 — a step boundary: recorded as `activity`, carrying the git
          // snapshot hash nothing else in the export exposes
          { id: "prt_1", type: "step-start", snapshot: "0d9b515140cdc80d" },
          // seq 2 — plaintext reasoning becomes a visible thinking block
          {
            id: "prt_2",
            type: "reasoning",
            text: "They want the file read.",
            time: { start: SESSION_CREATED + 3 },
          },
          // seq 3 — settled tool call: one event carrying call + result
          {
            id: "prt_3",
            type: "tool",
            tool: "read",
            callID: "call_abc",
            state: {
              status: "completed",
              input: { filePath: "/tmp/note.txt" },
              output: "hello",
              time: { start: SESSION_CREATED + 4 },
            },
          },
          // seq 4 — still running: must not be captured, and must hold the cursor
          {
            id: "prt_4",
            type: "tool",
            tool: "bash",
            callID: "call_running",
            state: { status: "running", input: { command: "sleep 1" } },
          },
          // seq 5 — visible assistant text
          { id: "prt_5", type: "text", text: "It says hello.", time: { start: SESSION_CREATED + 5 } },
          // seq 6 — empty text produces no event
          { id: "prt_6", type: "text", text: "   " },
          // seq 7 — unknown to this adapter version: preserved raw-only
          { id: "prt_7", type: "some-future-part", text: "from a newer opencode" },
          // seq 8 — the step's token accounting: `activity`, not a turn
          { id: "prt_8", type: "step-finish", reason: "stop", tokens: { input: 10, output: 2 } },
        ],
      },
    ],
  };
}

test("captures visible parts, records step boundaries, preserves unknown part types", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const result = await captureOpencodeExport(sessionExport(), repo.root);

    assert.equal(
      result.appended,
      7,
      "user text, two step boundaries, reasoning, tool, assistant text, unrecognized",
    );
    assert.deepEqual(result.unrecognized, { "some-future-part": 1 });

    const events = await readEvents(repo);
    const bySeq = new Map(events.map((e) => [e.conversation?.seq, e]));

    // Only the empty and unsettled parts produce nothing.
    for (const seq of [4, 6]) {
      assert.equal(bySeq.has(seq), false, `seq ${seq} should not be captured`);
    }

    // Step boundaries are `activity`, keeping their source fields verbatim.
    assert.equal(bySeq.get(1)!.kind, "activity");
    assert.deepEqual(bySeq.get(1)!.content, {
      activity_type: "step-start",
      id: "prt_1",
      snapshot: "0d9b515140cdc80d",
    });
    assert.equal(bySeq.get(8)!.kind, "activity");
    assert.deepEqual(bySeq.get(8)!.content, {
      activity_type: "step-finish",
      id: "prt_8",
      reason: "stop",
      tokens: { input: 10, output: 2 },
    });

    const user = bySeq.get(0)!;
    assert.equal(user.kind, "conversation_turn");
    assert.equal(user.actor.type, "human");
    assert.equal(user.actor.id, "test@example.com");
    assert.equal(user.producer.source, "opencode");
    assert.equal(user.conversation?.id, `opencode:${SESSION_ID}`);
    // opencode states the model even on user messages, unlike claude-code.
    assert.equal(user.producer.model, "deepseek-v4-flash");
    assert.equal(user.producer.provider, "ds4");
    assert.equal(user.producer.source_version, "1.18.5");
    assert.deepEqual((user.content as { blocks: unknown[] }).blocks, [
      { type: "text", text: "Read note.txt please" },
    ]);
    assert.equal((user.content as { agent?: string }).agent, "build");

    // Reasoning is plaintext in opencode, so it is a normal visible turn —
    // never the opaque `reasoning` kind codex needs.
    const reasoning = bySeq.get(2)!;
    assert.equal(reasoning.kind, "conversation_turn");
    assert.equal(reasoning.actor.type, "agent");
    assert.deepEqual((reasoning.content as { blocks: unknown[] }).blocks, [
      { type: "thinking", text: "They want the file read." },
    ]);

    // A tool part carries call and result together in one event.
    const tool = bySeq.get(3)!;
    assert.equal(tool.actor.type, "agent");
    const toolBlocks = (tool.content as { blocks: Record<string, unknown>[] }).blocks;
    assert.equal(toolBlocks.length, 2);
    assert.deepEqual(toolBlocks[0], {
      type: "tool_use",
      name: "read",
      input: { filePath: "/tmp/note.txt" },
      id: "call_abc",
    });
    assert.deepEqual(toolBlocks[1], {
      type: "tool_result",
      tool_use_id: "call_abc",
      content: "hello",
    });

    const unknown = bySeq.get(7)!;
    assert.equal(unknown.kind, "unrecognized");
    assert.deepEqual(unknown.content, { unrecognized_type: "some-future-part" });
    // raw pairs the part with its message info so the event stands alone.
    const raw = unknown.raw?.data as { info?: { role?: string }; part?: { id?: string } };
    assert.equal(raw.part?.id, "prt_7");
    assert.equal(raw.info?.role, "assistant");
  } finally {
    await cleanupRepo(repo);
  }
});

test("occurred_at falls back from part to message to session time", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    await captureOpencodeExport(sessionExport(), repo.root);
    const events = await readEvents(repo);
    const bySeq = new Map(events.map((e) => [e.conversation?.seq, e]));
    // seq 0's part has no time of its own, so it takes the message's.
    assert.equal(bySeq.get(0)!.occurred_at, new Date(SESSION_CREATED + 1).toISOString());
    // seq 2's part states its own start time.
    assert.equal(bySeq.get(2)!.occurred_at, new Date(SESSION_CREATED + 3).toISOString());
  } finally {
    await cleanupRepo(repo);
  }
});

test("re-capturing is idempotent, and an unsettled tool call is picked up once it settles", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const first = await captureOpencodeExport(sessionExport(), repo.root);
    assert.equal(first.appended, 7);

    // Same export again: the cursor was held at the running tool part, so
    // everything after it is re-examined and must dedup rather than duplicate.
    const second = await captureOpencodeExport(sessionExport(), repo.root);
    assert.equal(second.appended, 0);
    assert.ok(second.deduped > 0, "re-scanned parts should dedup");

    // The tool call finishes; only that one new event should appear.
    const settled = sessionExport();
    const running = settled.messages![1]!.parts![3]!; // seq 4, the running tool
    running.state = { status: "completed", input: { command: "sleep 1" }, output: "done" };
    const third = await captureOpencodeExport(settled, repo.root);
    assert.equal(third.appended, 1);

    const events = await readEvents(repo);
    const seqs = events.map((e) => e.conversation?.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5, 7, 8]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("subagent sessions are captured as their own conversation, pointing at the parent", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const child = sessionExport();
    const parentId = "ses_parent00000000000000000";
    child.info!.parentID = parentId;
    const result = await captureOpencodeExport(child, repo.root);
    assert.equal(result.appended, 7, "a subagent's own steps are the point of capturing it");

    const events = await readEvents(repo);
    for (const e of events) {
      assert.equal(e.conversation?.id, `opencode:${SESSION_ID}`);
      assert.equal(e.conversation?.parent, `opencode:${parentId}`);
    }
  } finally {
    await cleanupRepo(repo);
  }
});

test("an errored tool call is captured with is_error", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const data = sessionExport();
    const tool = data.messages![1]!.parts![2]!; // seq 3, the completed tool
    tool.state = { status: "error", input: { filePath: "/nope" }, error: "ENOENT" };
    await captureOpencodeExport(data, repo.root);
    const events = await readEvents(repo);
    const failed = events.find((e) => e.conversation?.seq === 3)!;
    const blocks = (failed.content as { blocks: Record<string, unknown>[] }).blocks;
    assert.equal(blocks[1]!["is_error"], true);
    assert.equal(blocks[1]!["content"], "ENOENT");
  } finally {
    await cleanupRepo(repo);
  }
});

/**
 * Real opencode part ids, and what makes them useful here.
 *
 * opencode mints `prt_` + 12 hex + 14 random base62, where the hex is a 48-bit
 * `Date.now() * 4096 + counter`. The ids below are the genuine shape (checked
 * against a live opencode 1.18.10 store, 859 parts, zero ordering violations
 * within a session); only the random tails are invented.
 */
const P = [
  "prt_fbc184c1b000aaaaaaaaaaaaaa",
  "prt_fbc184c1b001bbbbbbbbbbbbbb",
  "prt_fbc184c1b002cccccccccccccc",
  "prt_fbc184c1b003dddddddddddddd",
];
const SEQ = P.map((id) => parseInt(id.slice(4, 16), 16));

/** A session of plain text parts, from whichever of the ids above are named. */
function textSession(ids: string[]): OpencodeExport {
  return {
    info: {
      id: SESSION_ID,
      directory: "/tmp/whatever",
      version: "1.18.10",
      time: { created: SESSION_CREATED, updated: SESSION_CREATED + 9000 },
    },
    messages: [
      {
        info: {
          id: "msg_asst",
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: SESSION_CREATED + 1 },
        },
        parts: ids.map((id, i) => ({
          id,
          type: "text",
          text: `part ${id.slice(4, 16)}`,
          time: { start: SESSION_CREATED + 10 + i },
        })),
      },
    ],
  };
}

const seqsOf = async (repo: Parameters<typeof readEvents>[0]): Promise<number[]> =>
  (await readEvents(repo, { reachableFrom: null }))
    .filter((e) => e.kind === "conversation_turn")
    .map((e) => e.conversation!.seq)
    .sort((a, b) => a - b);

test("seq comes from the part id, so it is a property of the part and not of its neighbours", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    await captureOpencodeExport(textSession(P), repo.root);
    assert.deepEqual(await seqsOf(repo), SEQ, "each part is numbered by its own id");
    assert.ok(SEQ[0]! < SEQ[1]! && SEQ[1]! < SEQ[2]!, "and the ids sort in creation order");
  } finally {
    await cleanupRepo(repo);
  }
});

test("deleting a part out of the middle does not renumber the survivors", async () => {
  // The bug this exists to fix. opencode's store is mutable: `session revert`
  // and `part.removed` delete parts from the middle, and under a positional
  // index every part after the hole shifted down — re-capturing them under new
  // ids, because `seq` is part of event identity. Duplicates in the ledger for
  // content that never changed.
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    await captureOpencodeExport(textSession(P), repo.root);
    const before = await readEvents(repo, { reachableFrom: null });
    const idsBefore = new Set(before.map((e) => e.id));

    // The user reverts: the second part is gone, the rest survive unchanged.
    const reverted = textSession([P[0]!, P[2]!, P[3]!]);
    await captureOpencodeExport(reverted, repo.root);

    const after = await readEvents(repo, { reachableFrom: null });
    assert.deepEqual(
      await seqsOf(repo),
      SEQ,
      "the withdrawn part stays in the ledger; the ledger is append-only",
    );
    assert.deepEqual(
      after.map((e) => e.id).filter((id) => !idsBefore.has(id)),
      [],
      "and the survivors re-capture under the ids they already had, rather than duplicating",
    );
    assert.equal(after.length, before.length, "so the event count does not grow");
  } finally {
    await cleanupRepo(repo);
  }
});

test("the cursor is a high-water mark over ids, not a count that a deletion can offset", async () => {
  // A count only notices parts going away when the session gets *shorter*, so
  // a deletion offset by an addition left it looking healthy while pointing at
  // the wrong place. This is exactly that shape: one part removed, one added.
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    await captureOpencodeExport(textSession([P[0]!, P[1]!, P[2]!]), repo.root);

    const swapped = await captureOpencodeExport(textSession([P[0]!, P[2]!, P[3]!]), repo.root);
    assert.equal(swapped.appended, 1, "only the genuinely new part is appended");
    assert.deepEqual(await seqsOf(repo), SEQ, "and nothing already captured was missed");
  } finally {
    await cleanupRepo(repo);
  }
});

test("an unsettled tool still holds the cursor back under id-derived seqs", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const running: OpencodeExport = {
      info: { id: SESSION_ID, directory: "/tmp/whatever", time: { created: SESSION_CREATED } },
      messages: [
        {
          info: { id: "msg_asst", sessionID: SESSION_ID, role: "assistant", time: { created: SESSION_CREATED } },
          parts: [
            { id: P[0]!, type: "text", text: "starting", time: { start: SESSION_CREATED + 1 } },
            {
              id: P[1]!,
              type: "tool",
              tool: "bash",
              callID: "call_running",
              state: { status: "running", input: { command: "sleep 1" } },
            },
          ],
        },
      ],
    };
    const first = await captureOpencodeExport(running, repo.root);
    assert.equal(first.appended, 1, "the running tool is not captured yet");

    const settled = JSON.parse(JSON.stringify(running)) as OpencodeExport;
    settled.messages![0]!.parts![1]!.state = {
      status: "completed",
      input: { command: "sleep 1" },
      output: "done",
      time: { start: SESSION_CREATED + 2 },
    };
    const second = await captureOpencodeExport(settled, repo.root);
    assert.equal(second.appended, 1, "and is picked up once it settles, exactly once");
  } finally {
    await cleanupRepo(repo);
  }
});

test("a session whose ids opencode did not mint keeps the positional numbering", async () => {
  // Ids from other tooling exist in the wild. Mixing a 48-bit timestamp with a
  // small integer inside one session would sort into nonsense, so the scheme is
  // chosen per session: unless every part parses, the whole session stays
  // positional and behaves exactly as it did before ids were used at all.
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    await captureOpencodeExport(textSession([P[0]!, "prt_handwritten", P[2]!]), repo.root);
    assert.deepEqual(await seqsOf(repo), [0, 1, 2], "one odd id demotes the whole session");
  } finally {
    await cleanupRepo(repo);
  }
});
