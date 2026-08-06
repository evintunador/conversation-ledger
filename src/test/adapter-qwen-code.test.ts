import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureQwenTranscript, renormalizeUnrecognized } from "../adapters/qwen-code.js";
import { readEvents } from "../store.js";
import { gitUserIdentity } from "../git.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const SESSION_ID = "93335a04-fdc7-4462-b333-16b7f64290b9";
const QWEN_VERSION = "0.21.5";

/**
 * Lines shaped like a real Qwen Code 0.21.5 transcript: the envelope fields,
 * the GenAI `parts` content, the top-level `model` on assistant lines, and the
 * `system` records that carry everything which is not a turn. Field values are
 * taken from sessions captured against a live Qwen Code.
 */
function transcriptLines(): unknown[] {
  const base = {
    sessionId: SESSION_ID,
    cwd: "/tmp/project",
    gitBranch: "main",
    version: QWEN_VERSION,
  };
  return [
    // 0 — the human's prompt
    {
      ...base,
      uuid: "u-0",
      parentUuid: null,
      timestamp: "2026-08-04T03:48:56.645Z",
      type: "user",
      provenance: "real_user",
      message: { role: "user", parts: [{ text: "Read calc.py and say what it does." }] },
    },
    // 1 — telemetry: an `activity`, not a dropped line
    {
      ...base,
      uuid: "s-1",
      timestamp: "2026-08-04T03:48:56.660Z",
      type: "system",
      provenance: "system",
      subtype: "ui_telemetry",
      systemPayload: { uiEvent: { "event.name": "qwen-code.api_response", output_token_count: 77 } },
    },
    // 2 — model turn: a thought part plus a function call
    {
      ...base,
      uuid: "a-2",
      timestamp: "2026-08-04T03:52:17.530Z",
      type: "assistant",
      provenance: "assistant_output",
      model: "deepseek-v4-flash",
      message: {
        role: "model",
        parts: [
          { text: "Let me read the file.", thought: true },
          { functionCall: { id: "call_1", name: "read_file", args: { file_path: "/tmp/calc.py" } } },
        ],
      },
    },
    // 3 — the tool's answer, framed by the API as a user-role message
    {
      ...base,
      uuid: "t-3",
      timestamp: "2026-08-04T03:52:17.558Z",
      type: "tool_result",
      provenance: "tool_result",
      message: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "read_file",
              response: { output: "def add(a,b): return a+b\n" },
            },
          },
        ],
      },
      toolCallResult: { callId: "call_1", status: "success" },
    },
    // 4 — intermediate file state, with the content hash in the record itself
    {
      ...base,
      uuid: "s-4",
      timestamp: "2026-08-04T03:52:17.900Z",
      type: "system",
      subtype: "attribution_snapshot",
      systemPayload: {
        snapshot: {
          type: "attribution-snapshot",
          version: 1,
          surface: "cli",
          promptCount: 1,
          fileStates: {
            "/tmp/project/calc.py": { aiContribution: 31, aiCreated: false, contentHash: "abc123" },
          },
        },
      },
    },
    // 5 — a declaration about the session
    {
      ...base,
      uuid: "s-5",
      timestamp: "2026-08-04T03:52:18.000Z",
      type: "system",
      subtype: "custom_title",
      systemPayload: { customTitle: "Explain calc.py", titleSource: "auto" },
    },
    // 6 — a top-level type outside Qwen's own record set: preserved raw-only
    {
      ...base,
      uuid: "x-6",
      timestamp: "2026-08-04T03:52:18.500Z",
      type: "artifact",
      payload: { note: "something a future Qwen Code writes" },
    },
    // 7 — the final answer
    {
      ...base,
      uuid: "a-7",
      timestamp: "2026-08-04T03:52:19.949Z",
      type: "assistant",
      provenance: "assistant_output",
      model: "deepseek-v4-flash",
      message: { role: "model", parts: [{ text: "It defines add(a, b)." }] },
    },
  ];
}

async function writeTranscript(
  lines: unknown[],
  sessionId = SESSION_ID,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cledger-qwen-"));
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, path };
}

test("qwen-code capture: every line becomes an event, in the kind it deserves", async () => {
  const repo = await makeTempRepo();
  const { dir, path } = await writeTranscript(transcriptLines());
  try {
    await makeCommit(repo);
    const result = await captureQwenTranscript(path, repo.root);

    // All eight lines are recorded: nothing is a skip list any more.
    assert.equal(result.appended, 8);
    assert.deepEqual(result.unrecognized, { artifact: 1 });

    const events = await readEvents(repo);
    const bySeq = new Map(events.map((e) => [e.conversation!.seq, e]));
    assert.ok(events.every((e) => e.producer.source === "qwen-code"));
    assert.ok(events.every((e) => e.producer.source_version === QWEN_VERSION));
    assert.deepEqual(
      [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([seq, e]) => [seq, e.kind]),
      [
        [0, "conversation_turn"],
        [1, "activity"],
        [2, "conversation_turn"],
        [3, "conversation_turn"],
        [4, "file_snapshot"],
        [5, "session_state"],
        [6, "unrecognized"],
        [7, "conversation_turn"],
      ],
    );

    // The human's prompt is attributed to the repo's git identity.
    const prompt = bySeq.get(0)!;
    assert.equal(prompt.actor.type, "human");
    assert.equal(prompt.actor.id, "test@example.com");
    assert.equal(prompt.producer.model, undefined, "a user line states no model, so none is invented");

    // A thought part becomes a visible thinking block; functionCall → tool_use.
    const modelTurn = bySeq.get(2)!;
    assert.equal(modelTurn.actor.id, "deepseek-v4-flash");
    assert.equal(
      modelTurn.producer.provider,
      undefined,
      "qwen states an auth mode, not an inference provider, so provider stays unset",
    );
    assert.deepEqual((modelTurn.content as { blocks: unknown[] }).blocks, [
      { type: "thinking", text: "Let me read the file." },
      { type: "tool_use", id: "call_1", name: "read_file", input: { file_path: "/tmp/calc.py" } },
    ]);

    // A tool result carries role "user" from the API, but is not the human.
    const toolResult = bySeq.get(3)!;
    assert.equal(toolResult.actor.type, "system");
    assert.deepEqual((toolResult.content as { blocks: unknown[] }).blocks, [
      {
        type: "tool_result",
        tool_use_id: "call_1",
        name: "read_file",
        content: { output: "def add(a,b): return a+b\n" },
      },
    ]);

    // Telemetry keeps its own fields, under a label naming the source subtype.
    const telemetry = bySeq.get(1)!;
    const telemetryContent = telemetry.content as Record<string, unknown>;
    assert.equal(telemetryContent["activity_type"], "system/ui_telemetry");
    assert.equal(telemetry.actor.type, "system");
    assert.ok(telemetryContent["systemPayload"], "the source payload is kept verbatim");

    // The attribution snapshot becomes file state, hash and all.
    const snapshot = bySeq.get(4)!.content as Record<string, unknown>;
    assert.equal(snapshot["operation"], "snapshot");
    assert.deepEqual(snapshot["files"], [
      {
        path: "/tmp/project/calc.py",
        aiContribution: 31,
        aiCreated: false,
        contentHash: "abc123",
      },
    ]);
    assert.equal(snapshot["fileStates"], undefined, "the keyed map is replaced by the list");

    // A session declaration keeps the source's own field names.
    const state = bySeq.get(5)!.content as Record<string, unknown>;
    assert.equal(state["state_type"], "custom_title");
    assert.deepEqual(state["systemPayload"], { customTitle: "Explain calc.py", titleSource: "auto" });

    // Only a genuinely unknown *top-level* type trips the drift path.
    const preserved = bySeq.get(6)!;
    assert.deepEqual(preserved.content, { unrecognized_type: "artifact" });
    assert.equal(preserved.raw!.format, "qwen-code-jsonl/1");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});

test("qwen-code capture: a subagent transcript points back at its parent", async () => {
  const repo = await makeTempRepo();
  const child = "11111111-2222-3333-4444-555555555555";
  const { dir, path } = await writeTranscript(
    [
      {
        sessionId: child,
        uuid: "s-0",
        timestamp: "2026-08-04T04:00:00.000Z",
        type: "system",
        subtype: "parent_session",
        version: QWEN_VERSION,
        systemPayload: { parentSessionId: SESSION_ID },
      },
      {
        sessionId: child,
        uuid: "u-1",
        timestamp: "2026-08-04T04:00:01.000Z",
        type: "user",
        version: QWEN_VERSION,
        message: { role: "user", parts: [{ text: "find the bug" }] },
      },
    ],
    child,
  );
  try {
    await makeCommit(repo);
    await captureQwenTranscript(path, repo.root);
    const events = await readEvents(repo);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.conversation!.id, `qwen-code:${child}`);
      assert.equal(
        event.conversation!.parent,
        `qwen-code:${SESSION_ID}`,
        "the parent link is read once from the parent_session record and applied to every event",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});

test("qwen-code capture: rescanning dedups, and an appended turn resumes from the cursor", async () => {
  const repo = await makeTempRepo();
  const lines = transcriptLines();
  const { dir, path } = await writeTranscript(lines.slice(0, 2));
  try {
    await makeCommit(repo);
    assert.equal((await captureQwenTranscript(path, repo.root)).appended, 2);
    assert.equal((await captureQwenTranscript(path, repo.root)).appended, 0, "cursor makes it a no-op");

    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const grown = await captureQwenTranscript(path, repo.root);
    assert.equal(grown.appended, 6);
    assert.equal(grown.deduped, 0);

    // With the cursor gone, identical ids dedup rather than duplicating.
    await rm(join(repo.commonDir, "conversation-ledger", "cursors"), {
      recursive: true,
      force: true,
    });
    const forced = await captureQwenTranscript(path, repo.root);
    assert.equal(forced.appended, 0);
    assert.equal(forced.deduped, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});

test("qwen-code capture: a torn trailing line is captured once it lands", async () => {
  const repo = await makeTempRepo();
  const lines = transcriptLines();
  const dir = await mkdtemp(join(tmpdir(), "cledger-qwen-"));
  const path = join(dir, `${SESSION_ID}.jsonl`);
  try {
    await makeCommit(repo);
    const complete = JSON.stringify(lines[0]);
    // No trailing newline: the writer was caught mid-line.
    await writeFile(path, complete + "\n" + JSON.stringify(lines[7]).slice(0, 40));
    assert.equal((await captureQwenTranscript(path, repo.root)).appended, 1);

    await writeFile(path, complete + "\n" + JSON.stringify(lines[7]) + "\n");
    assert.equal(
      (await captureQwenTranscript(path, repo.root)).appended,
      1,
      "the cursor stopped short of the torn line, so its finished form is not lost",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});

test("qwen-code renormalize: a preserved line becomes the event a live capture would write", async () => {
  const repo = await makeTempRepo();
  // A line whose top-level type this version does not know.
  const { dir, path } = await writeTranscript([
    { ...(transcriptLines()[7] as Record<string, unknown>), type: "future" },
  ]);
  try {
    await makeCommit(repo);
    await captureQwenTranscript(path, repo.root);
    const stored = (await readEvents(repo)).find((e) => e.kind === "unrecognized")!;
    const identity = await gitUserIdentity(repo);
    assert.equal(renormalizeUnrecognized(stored, identity), null, "still uninterpretable");

    // Once the type is one the adapter understands, the same stored payload
    // reconstructs to the turn a live capture would have written.
    const asTurn = {
      ...stored,
      raw: { ...stored.raw!, data: { ...(stored.raw!.data as object), type: "assistant" } },
    };
    const turn = renormalizeUnrecognized(asTurn, identity)!;
    assert.equal(turn.kind, "conversation_turn");
    assert.equal(turn.conversation!.seq, stored.conversation!.seq);
    assert.equal(turn.producer.model, "deepseek-v4-flash");

    // Record kinds renormalize too, not just turns.
    const asRecord = {
      ...stored,
      raw: {
        ...stored.raw!,
        data: { ...(stored.raw!.data as object), type: "system", subtype: "custom_title" },
      },
    };
    assert.equal(renormalizeUnrecognized(asRecord, identity)!.kind, "session_state");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});

test("qwen-code capture: empty-part turns produce no event", async () => {
  const repo = await makeTempRepo();
  const { dir, path } = await writeTranscript([
    {
      sessionId: SESSION_ID,
      uuid: "a-0",
      timestamp: "2026-08-04T03:52:19.949Z",
      type: "assistant",
      version: QWEN_VERSION,
      model: "deepseek-v4-flash",
      message: { role: "model", parts: [{ text: "   " }] },
    },
  ]);
  try {
    await makeCommit(repo);
    const result = await captureQwenTranscript(path, repo.root);
    assert.equal(result.appended, 0);
    assert.deepEqual(result.unrecognized, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  }
});
