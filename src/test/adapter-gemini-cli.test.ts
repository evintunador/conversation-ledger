import { test } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureGeminiSession,
  captureGeminiTranscript,
  renormalizeUnrecognized,
  replaySession,
} from "../adapters/gemini-cli.js";
import { readEvents } from "../store.js";
import { gitUserIdentity } from "../git.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const SESSION_ID = "63ca4425-bedf-43dc-8d39-a82310277fe9";
const PROJECT_HASH = "9463563eb1c1c7ad0cc6d79090b75317a78bf53f4a8a7c99ba2055361e2de23a";

function header(): unknown {
  return {
    sessionId: SESSION_ID,
    projectHash: PROJECT_HASH,
    startTime: "2026-08-04T03:54:19.786Z",
    lastUpdated: "2026-08-04T03:54:19.786Z",
    kind: "main",
  };
}

function log(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

async function capture(text: string, root: string) {
  return captureGeminiSession(text, root, SESSION_ID, "0.53.1");
}

test("gemini-cli replay: records are applied in the CLI's own precedence order", () => {
  const session = replaySession(
    log(
      header(),
      { id: "m1", timestamp: "2026-08-04T03:54:19.787Z", type: "user", content: [{ text: "one" }] },
      { $set: { lastUpdated: "2026-08-04T03:54:20.000Z" } },
      // a bare message record replaces the earlier value for the same id
      { id: "m1", timestamp: "2026-08-04T03:54:19.787Z", type: "user", content: [{ text: "one!" }] },
      { id: "m2", timestamp: "2026-08-04T03:54:21.000Z", type: "gemini", content: "two" },
    ),
  );
  assert.equal(session.metadata.sessionId, SESSION_ID);
  assert.equal(session.metadata.lastUpdated, "2026-08-04T03:54:20.000Z");
  assert.deepEqual(
    session.messages.map((m) => [m.seq, m.message.id, m.message.content]),
    [
      [1, "m1", [{ text: "one!" }]],
      [3, "m2", "two"],
    ],
    "an id keeps its first-sighting seq but takes its last-written value",
  );
  assert.deepEqual(
    session.mutations.map((m) => [m.seq, m.kind]),
    [
      [0, "metadata"],
      [2, "metadata"],
    ],
    "messages and mutations share one number space, so neither can collide",
  );
  assert.equal(session.rewound.size, 0);
});

test("gemini-cli replay: a message dropped by a snapshot is still captured", () => {
  // Verified behaviour of a real Gemini CLI session: after a failed API call it
  // rewrites the document with a `$set.messages` snapshot that omits the prompt
  // the user had just typed. Faithful replay would lose it.
  const snapshot = {
    $set: {
      messages: [
        {
          id: "ctx",
          timestamp: "2026-08-04T03:54:19.787Z",
          type: "user",
          content: "<session_context>\nsetup",
        },
      ],
    },
  };
  const session = replaySession(
    log(
      header(),
      snapshot,
      { id: "hi", timestamp: "2026-08-04T03:54:19.961Z", type: "user", content: [{ text: "hi" }] },
      snapshot,
    ),
  );
  assert.deepEqual(session.messages.map((m) => m.message.id), ["ctx", "hi"]);
  assert.deepEqual([...session.rewound], ["hi"], "the CLI dropped it; the ledger records that it did");
});

test("gemini-cli replay: $rewindTo drops from the live view but never from the record", () => {
  const session = replaySession(
    log(
      header(),
      { id: "a", timestamp: "2026-08-04T03:54:19.000Z", type: "user", content: "a" },
      { id: "b", timestamp: "2026-08-04T03:54:20.000Z", type: "gemini", content: "b" },
      { id: "c", timestamp: "2026-08-04T03:54:21.000Z", type: "user", content: "c" },
      { $rewindTo: "b" },
      { id: "d", timestamp: "2026-08-04T03:54:22.000Z", type: "user", content: "d" },
    ),
  );
  assert.deepEqual(
    session.messages.map((m) => m.message.id),
    ["a", "b", "c", "d"],
    "seq comes from first sighting, so the rewind cannot renumber what follows",
  );
  const seqs = session.messages.map((m) => m.seq);
  assert.deepEqual([...seqs].sort((x, y) => x - y), seqs, "still ordered");
  assert.deepEqual([...session.rewound].sort(), ["b", "c"]);
  assert.deepEqual(
    session.mutations.filter((m) => m.kind === "rewind").map((m) => m.fields["removed_messages"]),
    [["b", "c"]],
  );
});

test("gemini-cli replay: an unresolvable rewind target clears the live document", () => {
  const session = replaySession(
    log(
      header(),
      { id: "a", timestamp: "2026-08-04T03:54:19.000Z", type: "user", content: "a" },
      { $rewindTo: "nope" },
    ),
  );
  assert.equal(session.messages.length, 1, "still recorded");
  assert.deepEqual([...session.rewound], ["a"]);
  assert.equal(session.mutations.at(-1)!.fields["resolved"], false);
});

test("gemini-cli capture: turns, notices, metadata and rewinds all become events", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo);
    const text = log(
      header(),
      // Gemini's own startup preamble, injected as a user message
      { id: "ctx", timestamp: "2026-08-04T03:54:19.787Z", type: "user", content: "<session_context>\nsetup" },
      // what the human actually typed
      { id: "ask", timestamp: "2026-08-04T03:54:20.000Z", type: "user", content: [{ text: "read calc.py" }] },
      // a UI notice the user read
      { id: "note", timestamp: "2026-08-04T03:54:20.500Z", type: "info", content: "Switched model" },
      // a model turn carrying reasoning, a tool call and its result
      {
        id: "turn",
        timestamp: "2026-08-04T03:54:21.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        content: [{ text: "Reading it now." }],
        thoughts: [{ subject: "Plan", description: "Open the file first." }],
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            args: { absolute_path: "/tmp/calc.py" },
            status: "success",
            result: { output: "def add(a,b): return a+b\n" },
          },
        ],
      },
      { $rewindTo: "turn" },
    );
    const result = await capture(text, repo.root);
    assert.deepEqual(result.unrecognized, {}, "nothing here is drift");

    const events = await readEvents(repo);
    const byKind = new Map<string, number>();
    for (const e of events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    assert.equal(byKind.get("conversation_turn"), 4, "preamble, prompt, notice, model turn");
    assert.equal(byKind.get("session_state"), 1, "the header's own metadata");
    assert.equal(byKind.get("activity"), 1, "the rewind");

    const turns = events.filter((e) => e.kind === "conversation_turn");
    assert.ok(events.every((e) => e.producer.source === "gemini-cli"));
    assert.ok(events.every((e) => e.producer.source_version === "0.53.1"));

    // The harness-authored preamble is not attributed to the human.
    const preamble = turns.find((e) => String((e.content as { blocks: { text: string }[] }).blocks[0]!.text).startsWith("<session_context>"))!;
    assert.equal(preamble.actor.type, "system");
    const ask = turns.find((e) => (e.content as { blocks: { text: string }[] }).blocks[0]!.text === "read calc.py")!;
    assert.equal(ask.actor.type, "human");
    assert.equal(ask.actor.id, "test@example.com");

    // A notice becomes a turn spoken by the system, labelled with its type.
    const notice = turns.find((e) => (e.content as Record<string, unknown>)["notice_type"] === "info")!;
    assert.equal(notice.actor.type, "system");
    assert.deepEqual((notice.content as { blocks: unknown[] }).blocks, [
      { type: "text", text: "Switched model" },
    ]);

    const model = turns.find((e) => e.actor.type === "agent")!;
    assert.equal(model.actor.id, "gemini-2.5-pro");
    assert.equal(model.producer.provider, undefined, "the file never states a provider");
    assert.deepEqual((model.content as { blocks: unknown[] }).blocks, [
      { type: "thinking", text: "Open the file first.", subject: "Plan" },
      { type: "text", text: "Reading it now." },
      { type: "tool_use", id: "call_1", name: "read_file", input: { absolute_path: "/tmp/calc.py" } },
      {
        type: "tool_result",
        tool_use_id: "call_1",
        name: "read_file",
        content: { output: "def add(a,b): return a+b\n" },
      },
    ]);

    // The rewind is recorded in its own right, naming what it withdrew.
    const rewind = events.find((e) => e.kind === "activity")!;
    const rewindContent = rewind.content as Record<string, unknown>;
    assert.equal(rewindContent["activity_type"], "rewind");
    assert.deepEqual(rewindContent["removed_messages"], ["turn"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("gemini-cli capture: calls already in content are not expanded twice", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo);
    // Gemini CLI's own history assembly ignores the sibling `toolCalls` field
    // when the content parts already carry the calls; so does this adapter, or
    // each call would land as two identical tool_use blocks.
    const text = log(
      header(),
      {
        id: "turn",
        timestamp: "2026-08-04T03:54:21.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        content: [{ functionCall: { id: "call_1", name: "read_file", args: { p: 1 } } }],
        toolCalls: [{ id: "call_1", name: "read_file", args: { p: 1 }, status: "success", result: "ok" }],
      },
    );
    await capture(text, repo.root);
    const turn = (await readEvents(repo)).find((e) => e.kind === "conversation_turn")!;
    assert.deepEqual(
      (turn.content as { blocks: { type: string }[] }).blocks.map((b) => b.type),
      ["tool_use", "tool_result"],
      "one call block from content, one result block appended",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("gemini-cli capture: an in-flight tool call holds the cursor until it settles", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo);
    const pending = log(
      header(),
      { id: "ask", timestamp: "2026-08-04T03:54:20.000Z", type: "user", content: [{ text: "go" }] },
      {
        id: "turn",
        timestamp: "2026-08-04T03:54:21.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        toolCalls: [{ id: "call_1", name: "run_shell_command", args: { cmd: "sleep" } }],
      },
    );
    const first = await capture(pending, repo.root);
    const firstTurns = (await readEvents(repo)).filter((e) => e.kind === "conversation_turn");
    assert.equal(firstTurns.length, 1, "only the user turn — the unfinished model turn is withheld");
    assert.ok(first.appended >= 1);

    // The same message, re-appended by Gemini once the tool returned.
    const settled =
      pending +
      log({
        id: "turn",
        timestamp: "2026-08-04T03:54:21.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        toolCalls: [
          { id: "call_1", name: "run_shell_command", args: { cmd: "sleep" }, status: "success", result: "done" },
        ],
      });
    await capture(settled, repo.root);
    const turns = (await readEvents(repo)).filter((e) => e.kind === "conversation_turn");
    assert.equal(turns.length, 2, "the withheld turn is captured exactly once, in its final form");
    const model = turns.find((e) => e.actor.type === "agent")!;
    assert.deepEqual(
      (model.content as { blocks: { type: string }[] }).blocks.map((b) => b.type),
      ["tool_use", "tool_result"],
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("gemini-cli capture: an unknown message type is preserved raw-only and renormalizes", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo);
    const text = log(
      header(),
      { id: "x", timestamp: "2026-08-04T03:54:20.000Z", type: "artifact", content: [{ text: "?" }] },
    );
    const result = await capture(text, repo.root);
    assert.deepEqual(result.unrecognized, { artifact: 1 });

    const preserved = (await readEvents(repo)).find((e) => e.kind === "unrecognized")!;
    assert.deepEqual(preserved.content, { unrecognized_type: "artifact" });
    assert.equal(preserved.raw!.format, "gemini-cli-chatlog/1");

    const identity = await gitUserIdentity(repo);
    assert.equal(renormalizeUnrecognized(preserved, identity), null, "still uninterpretable");

    const upgraded = {
      ...preserved,
      raw: { ...preserved.raw!, data: { ...(preserved.raw!.data as object), type: "user" } },
    };
    const draft = renormalizeUnrecognized(upgraded, identity)!;
    assert.equal(draft.kind, "conversation_turn");
    assert.equal(draft.conversation!.seq, preserved.conversation!.seq);
    assert.equal(draft.producer.source_version, "0.53.1", "provenance survives renormalization");
  } finally {
    await cleanupRepo(repo);
  }
});

test("gemini-cli capture: rescanning dedups and a later turn resumes from the cursor", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo);
    const first = log(
      header(),
      { id: "a", timestamp: "2026-08-04T03:54:19.000Z", type: "user", content: "a" },
      { id: "b", timestamp: "2026-08-04T03:54:20.000Z", type: "gemini", model: "m", content: "b" },
    );
    const initial = await capture(first, repo.root);
    assert.equal(initial.appended, 3, "header state + two turns");
    assert.equal((await capture(first, repo.root)).appended, 0, "cursor makes a re-capture a no-op");

    await rm(join(repo.commonDir, "conversation-ledger", "cursors"), {
      recursive: true,
      force: true,
    });
    const forced = await capture(first, repo.root);
    assert.equal(forced.appended, 0);
    assert.equal(forced.deduped, 3);

    const grown =
      first + log({ id: "c", timestamp: "2026-08-04T03:54:21.000Z", type: "user", content: "c" });
    assert.equal((await capture(grown, repo.root)).appended, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("gemini-cli capture: a subagent session is captured and points at its parent", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-gemini-"));
  try {
    await makeCommit(repo);
    // Gemini files a sub-session under `<chats>/<parent session id>/`.
    const parentPath = join(dir, "session-2026-08-04T03-54-63ca4425.jsonl");
    await writeFile(
      parentPath,
      log(header(), {
        id: "p1",
        timestamp: "2026-08-04T03:54:20.000Z",
        type: "user",
        content: "delegate this",
      }),
    );
    await mkdir(join(dir, SESSION_ID), { recursive: true });
    await writeFile(
      join(dir, SESSION_ID, "session-child.jsonl"),
      log(
        { sessionId: "child-1", projectHash: PROJECT_HASH, startTime: "2026-08-04T03:55:00.000Z" },
        { id: "c1", timestamp: "2026-08-04T03:55:01.000Z", type: "user", content: "sub task" },
      ),
    );

    await captureGeminiTranscript(parentPath, repo.root);
    const events = await readEvents(repo);
    const child = events.filter((e) => e.conversation!.id === "gemini-cli:child-1");
    assert.ok(child.length > 0, "the subagent session was found and captured");
    assert.ok(
      child.every((e) => e.conversation!.parent === `gemini-cli:${SESSION_ID}`),
      "every subagent event points back at the session that spawned it",
    );
    assert.ok(
      events.some((e) => e.conversation!.id === `gemini-cli:${SESSION_ID}` && !e.conversation!.parent),
      "the parent session keeps its own conversation, unparented",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});
