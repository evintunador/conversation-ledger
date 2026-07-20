import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClaudeTranscript } from "../adapters/claude-code.js";
import { readEvents } from "../store.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const SESSION_ID = "sess-1";

/** Lines 0-3 are real content, 4 is a sidechain turn, 5 is a system event,
 * both of which convertLine must drop; 6 is a truncated trailing line that
 * must be tolerated (skipped, not thrown). */
function transcriptLines(): unknown[] {
  return [
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Hello there" },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          { type: "text", text: "Sure, let me help." },
          { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "file1\nfile2" }],
      },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          { type: "thinking", thinking: "I should check files", signature: "SIGABC123" },
          { type: "text", text: "Done." },
        ],
      },
    },
    {
      type: "assistant",
      isSidechain: true,
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "assistant", content: "sidechain content, must be dropped" },
    },
    {
      type: "system",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "system", content: "system event, must be dropped" },
    },
  ];
}

async function writeTranscript(dir: string): Promise<string> {
  const path = join(dir, `${SESSION_ID}.jsonl`);
  const lines = transcriptLines().map((l) => JSON.stringify(l));
  // Line 6: a truncated/malformed trailing line — must not crash capture.
  lines.push('{"type":"user","sessionId":"sess-1","message": {"role": "user"');
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("captureClaudeTranscript: converts a synthetic transcript end to end", async () => {
  const repo = await makeTempRepo("cledger-cc-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-transcript-"));
  try {
    await makeCommit(repo, "init");
    const transcriptPath = await writeTranscript(transcriptDir);

    await captureClaudeTranscript(transcriptPath, repo.root);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 4, "sidechain, system, and malformed lines must be dropped");

    for (const e of events) {
      assert.strictEqual(e.raw?.format, "claude-code-jsonl/1");
      assert.strictEqual(e.conversation?.id, `claude-code:${SESSION_ID}`);
      assert.strictEqual(e.producer.source, "claude-code");
      assert.strictEqual(e.producer.session_id, SESSION_ID);
    }

    // seq must equal the original line index in the transcript file.
    const bySeq = new Map(events.map((e) => [e.conversation!.seq, e]));
    assert.deepStrictEqual([...bySeq.keys()].sort((a, b) => a - b), [0, 1, 2, 3]);

    const line0 = bySeq.get(0)!;
    assert.strictEqual(line0.actor.type, "human");
    assert.strictEqual(line0.actor.id, "test@example.com");
    assert.strictEqual(line0.actor.display, "Test User");
    assert.deepStrictEqual(line0.content, {
      role: "user",
      blocks: [{ type: "text", text: "Hello there" }],
    });
    assert.strictEqual(line0.occurred_at, "2026-01-01T00:00:00.000Z");

    const line1 = bySeq.get(1)!;
    assert.strictEqual(line1.actor.type, "agent");
    assert.strictEqual(line1.actor.id, "claude-x");
    const line1Content = line1.content as { role: string; blocks: unknown[] };
    assert.deepStrictEqual(line1Content.blocks[1], {
      type: "tool_use",
      id: "call_1",
      name: "Bash",
      input: { command: "ls" },
    });

    const line2 = bySeq.get(2)!;
    const line2Content = line2.content as { role: string; blocks: unknown[] };
    assert.deepStrictEqual(line2Content.blocks[0], {
      type: "tool_result",
      tool_use_id: "call_1",
      content: "file1\nfile2",
    });

    const line3 = bySeq.get(3)!;
    const line3Content = line3.content as { role: string; blocks: unknown[] };
    const thinkingBlock = line3Content.blocks[0] as Record<string, unknown>;
    assert.strictEqual(thinkingBlock["type"], "thinking");
    assert.strictEqual(thinkingBlock["text"], "I should check files");
    assert.strictEqual(
      "signature" in thinkingBlock,
      false,
      "signature is provider-internal and must never be stored",
    );

    // --- Rerun on the unchanged transcript: cursor is past EOF, no new events. ---
    await captureClaudeTranscript(transcriptPath, repo.root);
    const eventsAfterRerun = await readEvents(repo);
    assert.strictEqual(eventsAfterRerun.length, 4, "rerun on unchanged transcript must not duplicate");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

test("captureClaudeTranscript: unrecognized line types are counted, known ones stay silent", async () => {
  const repo = await makeTempRepo("cledger-cc-drift-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-drift-"));
  try {
    await makeCommit(repo, "init");
    const path = join(transcriptDir, `${SESSION_ID}.jsonl`);
    const lines = [
      {
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hi" },
      },
      // Known bookkeeping types: skipped without complaint.
      { type: "file-history-snapshot", sessionId: SESSION_ID },
      { type: "queue-operation", sessionId: SESSION_ID },
      // A type this adapter has never heard of — the drift tripwire.
      { type: "holo-message", sessionId: SESSION_ID, timestamp: "2026-01-01T00:00:05.000Z", hologram: "new content kind" },
      { type: "holo-message", sessionId: SESSION_ID, timestamp: "2026-01-01T00:00:06.000Z", hologram: "again" },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await captureClaudeTranscript(path, repo.root);
    // 1 interpreted turn + 2 raw-only preservation events for the drift lines.
    assert.strictEqual(result.appended, 3);
    assert.deepStrictEqual(result.unrecognized, { "holo-message": 2 });

    // The unrecognized lines are preserved raw-only, not dropped.
    const preserved = (await readEvents(repo)).filter((e) => e.kind === "unrecognized");
    assert.strictEqual(preserved.length, 2);
    const first = preserved.sort((a, b) => a.conversation!.seq - b.conversation!.seq)[0]!;
    assert.strictEqual(first.actor.type, "system");
    assert.deepStrictEqual(first.content, { unrecognized_type: "holo-message" });
    assert.strictEqual(first.raw!.format, "claude-code-jsonl/1");
    assert.deepStrictEqual(first.raw!.data, {
      type: "holo-message",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:05.000Z",
      hologram: "new content kind",
    });
    assert.strictEqual(first.occurred_at, "2026-01-01T00:00:05.000Z");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

test("captureClaudeTranscript: a timestampless unrecognized line still gets a deterministic occurred_at", async () => {
  const repo = await makeTempRepo("cledger-cc-drift-ts-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-drift-ts-"));
  try {
    await makeCommit(repo, "init");
    const path = join(transcriptDir, `${SESSION_ID}.jsonl`);
    const lines = [
      {
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hi" },
      },
      // No timestamp of its own — must fall back to the transcript's first timestamp.
      { type: "holo-message", sessionId: SESSION_ID, hologram: "no timestamp here" },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    await captureClaudeTranscript(path, repo.root);
    const preserved = (await readEvents(repo)).find((e) => e.kind === "unrecognized")!;
    assert.strictEqual(preserved.occurred_at, "2026-01-01T00:00:00.000Z");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

test("captureClaudeTranscript: a later capture only ingests newly appended lines", async () => {
  const repo = await makeTempRepo("cledger-cc-growth-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-transcript-growth-"));
  try {
    await makeCommit(repo, "init");
    const transcriptPath = await writeTranscript(transcriptDir);
    await captureClaudeTranscript(transcriptPath, repo.root);
    assert.strictEqual((await readEvents(repo)).length, 4);

    await appendFile(
      transcriptPath,
      JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:10.000Z",
        message: { role: "user", content: "one more turn" },
      }) + "\n",
    );
    await captureClaudeTranscript(transcriptPath, repo.root);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 5, "only the newly appended line should be added");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});
