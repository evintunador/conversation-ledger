import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCodexTranscript } from "../adapters/codex.js";
import { readEvents } from "../store.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const SESSION_ID = "codex-sess-1";
// Filename carries a base timestamp + a uuid the sessionIdFromFilename regex
// can extract; the session_meta line (index 0) then overrides the id, which
// is the more common real-world case and worth exercising too.
const FILENAME = "rollout-2026-01-01T00-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl";

/** Index 0 is session_meta (not a response_item, dropped); 1-4 are real
 * content; 5 is a reasoning item (must always be dropped, opaque by design);
 * 6 is a truncated trailing line that must be tolerated. */
function rolloutLines(): unknown[] {
  return [
    { type: "session_meta", payload: { session_id: SESSION_ID } },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please run tests" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Sure, running now." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:03.000Z",
      payload: { type: "function_call", name: "shell", arguments: { command: "pytest" }, call_id: "call_9" },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:04.000Z",
      payload: { type: "function_call_output", call_id: "call_9", output: "5 passed" },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:05.000Z",
      payload: { type: "reasoning", encrypted_content: "opaque-blob-must-never-be-stored" },
    },
  ];
}

async function writeRollout(dir: string): Promise<string> {
  const path = join(dir, FILENAME);
  const lines = rolloutLines().map((l) => JSON.stringify(l));
  lines.push('{"type":"response_item","payload":{"type":"message"');
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("captureCodexTranscript: converts a synthetic rollout end to end", async () => {
  const repo = await makeTempRepo("cledger-codex-");
  const rolloutDir = await mkdtemp(join(tmpdir(), "cledger-codex-transcript-"));
  try {
    await makeCommit(repo, "init");
    const rolloutPath = await writeRollout(rolloutDir);

    await captureCodexTranscript(rolloutPath, repo.root);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 4, "session_meta, reasoning, and malformed lines must be dropped");

    for (const e of events) {
      assert.strictEqual(e.raw?.format, "codex-rollout-jsonl/2");
      assert.strictEqual(e.conversation?.id, `codex:${SESSION_ID}`);
      assert.strictEqual(e.producer.source, "codex");
      assert.strictEqual(
        e.producer.session_id,
        SESSION_ID,
        "session_meta's session_id must override the filename-derived id",
      );
    }

    // seq must equal the original line index (session_meta occupies index 0).
    const bySeq = new Map(events.map((e) => [e.conversation!.seq, e]));
    assert.deepStrictEqual([...bySeq.keys()].sort((a, b) => a - b), [1, 2, 3, 4]);

    const userMsg = bySeq.get(1)!;
    assert.strictEqual(userMsg.actor.type, "human");
    assert.strictEqual(userMsg.actor.id, "test@example.com");
    assert.strictEqual(userMsg.actor.display, "Test User");
    assert.deepStrictEqual(userMsg.content, {
      role: "user",
      blocks: [{ type: "text", text: "Please run tests" }],
    });
    assert.strictEqual(userMsg.occurred_at, "2026-01-01T00:00:01.000Z");

    const assistantMsg = bySeq.get(2)!;
    assert.strictEqual(assistantMsg.actor.type, "agent");
    assert.deepStrictEqual(assistantMsg.content, {
      role: "assistant",
      blocks: [{ type: "text", text: "Sure, running now." }],
    });

    const functionCall = bySeq.get(3)!;
    assert.strictEqual(functionCall.actor.type, "agent");
    assert.deepStrictEqual(functionCall.content, {
      role: "assistant",
      blocks: [{ type: "tool_use", name: "shell", input: { command: "pytest" }, id: "call_9" }],
    });

    const functionCallOutput = bySeq.get(4)!;
    assert.strictEqual(functionCallOutput.actor.type, "system");
    assert.deepStrictEqual(functionCallOutput.content, {
      role: "tool_result",
      blocks: [{ type: "tool_result", tool_use_id: "call_9", content: "5 passed" }],
    });

    // --- Rerun on the unchanged rollout: cursor is past EOF, no new events. ---
    await captureCodexTranscript(rolloutPath, repo.root);
    const eventsAfterRerun = await readEvents(repo);
    assert.strictEqual(eventsAfterRerun.length, 4, "rerun on unchanged rollout must not duplicate");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(rolloutDir);
  }
});

test("captureCodexTranscript: reasoning items are never stored, even when reprocessed", async () => {
  const repo = await makeTempRepo("cledger-codex-reasoning-");
  const rolloutDir = await mkdtemp(join(tmpdir(), "cledger-codex-transcript-reasoning-"));
  try {
    await makeCommit(repo, "init");
    const rolloutPath = await writeRollout(rolloutDir);
    await captureCodexTranscript(rolloutPath, repo.root);
    const events = await readEvents(repo);
    for (const e of events) {
      assert.notStrictEqual((e.raw?.data as { payload?: { type?: string } })?.payload?.type, "reasoning");
    }
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(rolloutDir);
  }
});

test("captureCodexTranscript: a later capture only ingests newly appended lines", async () => {
  const repo = await makeTempRepo("cledger-codex-growth-");
  const rolloutDir = await mkdtemp(join(tmpdir(), "cledger-codex-transcript-growth-"));
  try {
    await makeCommit(repo, "init");
    const rolloutPath = await writeRollout(rolloutDir);
    await captureCodexTranscript(rolloutPath, repo.root);
    assert.strictEqual((await readEvents(repo)).length, 4);

    await appendFile(
      rolloutPath,
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:10.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "one more turn" }] },
      }) + "\n",
    );
    await captureCodexTranscript(rolloutPath, repo.root);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 5, "only the newly appended line should be added");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(rolloutDir);
  }
});

test("captureCodexTranscript: unrecognized line and payload types are counted for drift", async () => {
  const repo = await makeTempRepo("cledger-codex-drift-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-codex-drift-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, FILENAME);
    const lines = [
      { type: "session_meta", payload: { session_id: SESSION_ID } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      // Known-skipped: reasoning payloads and bookkeeping line types.
      { type: "response_item", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "reasoning" } },
      { type: "turn_context", payload: {} },
      // Drift: a payload type and a line type this adapter has never seen.
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:03.000Z",
        payload: { type: "holo_call", text: "future content kind" },
      },
      { type: "brand_new_line_kind", payload: {} },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await captureCodexTranscript(path, repo.root);
    // 1 interpreted message + 2 raw-only preservation events for the drift lines.
    assert.strictEqual(result.appended, 3);
    assert.deepStrictEqual(result.unrecognized, {
      "response_item/holo_call": 1,
      brand_new_line_kind: 1,
    });

    // The unrecognized lines are preserved raw-only, not dropped.
    const events = await readEvents(repo);
    const preserved = events
      .filter((e) => e.kind === "unrecognized")
      .sort((a, b) => (a.conversation!.seq - b.conversation!.seq));
    assert.strictEqual(preserved.length, 2);

    const holo = preserved[0]!;
    assert.strictEqual(holo.actor.type, "system");
    assert.deepStrictEqual(holo.content, { unrecognized_type: "response_item/holo_call" });
    assert.strictEqual(holo.raw!.format, "codex-rollout-jsonl/2");
    // Full source line retained under raw.data for later re-normalization.
    assert.deepStrictEqual(holo.raw!.data, {
      type: "response_item",
      timestamp: "2026-01-01T00:00:03.000Z",
      payload: { type: "holo_call", text: "future content kind" },
    });
    assert.strictEqual(holo.occurred_at, "2026-01-01T00:00:03.000Z");

    const brandNew = preserved[1]!;
    assert.deepStrictEqual(brandNew.content, { unrecognized_type: "brand_new_line_kind" });
    assert.deepStrictEqual(brandNew.raw!.data, { type: "brand_new_line_kind", payload: {} });
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("captureCodexTranscript: a secret inside an unrecognized line is redacted in raw", async () => {
  const repo = await makeTempRepo("cledger-codex-drift-secret-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-codex-drift-secret-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, FILENAME);
    const secret = "ghp_" + "a".repeat(36);
    const lines = [
      { type: "session_meta", payload: { session_id: SESSION_ID } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:03.000Z",
        payload: { type: "holo_call", token: secret },
      },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    await captureCodexTranscript(path, repo.root);
    const events = await readEvents(repo);
    const preserved = events.find((e) => e.kind === "unrecognized")!;
    const serialized = JSON.stringify(preserved);
    assert.ok(!serialized.includes(secret), "secret must not survive in the preserved event");
    assert.ok(serialized.includes("[REDACTED:"), "secret must be replaced with a redaction placeholder");
    assert.ok((preserved.redactions ?? []).length > 0, "a redaction record must be attached");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("captureCodexTranscript: agent_message keeps visible text, drops encrypted blocks everywhere", async () => {
  const repo = await makeTempRepo("cledger-codex-agentmsg-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-codex-agentmsg-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, FILENAME);
    const lines = [
      { type: "session_meta", payload: { session_id: SESSION_ID } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/subagent",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/subagent" },
            { type: "encrypted_content", encrypted_content: "gAAAAAB-opaque-blob-must-never-be-stored" },
          ],
        },
      },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await captureCodexTranscript(path, repo.root);
    assert.strictEqual(result.appended, 1);
    assert.deepStrictEqual(result.unrecognized, {}, "agent_message is a recognized type now");

    const events = await readEvents(repo);
    const e = events[0]!;
    assert.strictEqual(e.actor.type, "agent");
    assert.strictEqual(e.actor.id, "/root");
    assert.deepStrictEqual(e.content, {
      role: "agent_message",
      author: "/root",
      recipient: "/root/subagent",
      blocks: [{ type: "text", text: "Message Type: NEW_TASK\nTask name: /root/subagent" }],
    });

    // The encrypted payload must be gone from the event wholesale — content
    // and raw alike — leaving only the bare type marker in raw.
    const serialized = JSON.stringify(e);
    assert.ok(!serialized.includes("opaque-blob"), "encrypted content must never be stored");
    const rawContent = ((e.raw?.data as { payload?: { content?: unknown[] } }).payload?.content) ?? [];
    assert.deepStrictEqual(rawContent[1], { type: "encrypted_content" });
    assert.strictEqual(e.raw?.format, "codex-rollout-jsonl/2");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});
