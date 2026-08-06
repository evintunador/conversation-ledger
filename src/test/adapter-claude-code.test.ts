import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClaudeTranscript, runClaudeCodeHook } from "../adapters/claude-code.js";
import { readEvents } from "../store.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const SESSION_ID = "sess-1";

/** Lines 0-3 are the main conversation, 4 is a sidechain turn (its own
 * sub-conversation), 5 is a system line with no visible text (an `activity`
 * record); 6 is a truncated trailing line that must be tolerated (skipped,
 * not thrown). */
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
      agentId: "agent-7",
      attributionAgent: "Explore",
      message: { role: "assistant", content: "sidechain content, kept as its own conversation" },
    },
    {
      type: "system",
      sessionId: SESSION_ID,
      timestamp: "2026-01-01T00:00:05.000Z",
      subtype: "turn_duration",
      durationMs: 1234,
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
    assert.strictEqual(events.length, 6, "only the malformed line may be dropped");

    for (const e of events) {
      assert.strictEqual(e.raw?.format, "claude-code-jsonl/1");
      assert.strictEqual(e.producer.source, "claude-code");
      assert.strictEqual(e.producer.session_id, SESSION_ID);
    }

    // seq must equal the original line index in the transcript file.
    const bySeq = new Map(events.map((e) => [e.conversation!.seq, e]));
    assert.deepStrictEqual([...bySeq.keys()].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    for (const seq of [0, 1, 2, 3]) {
      assert.strictEqual(bySeq.get(seq)!.conversation?.id, `claude-code:${SESSION_ID}`);
    }

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

    // Line 4: a sidechain turn — its own conversation, pointing at the parent,
    // attributed to the subagent type rather than to the person.
    const sidechain = bySeq.get(4)!;
    assert.strictEqual(sidechain.kind, "conversation_turn");
    assert.strictEqual(sidechain.conversation?.id, `claude-code:${SESSION_ID}#agent:agent-7`);
    assert.strictEqual(sidechain.conversation?.parent, `claude-code:${SESSION_ID}`);
    assert.strictEqual((sidechain.content as Record<string, unknown>)["agent"], "Explore");

    // Line 5: a system line with no visible text — recorded, but as machinery.
    const system = bySeq.get(5)!;
    assert.strictEqual(system.kind, "activity");
    assert.deepStrictEqual(system.content, {
      activity_type: "system/turn_duration",
      subtype: "turn_duration",
      durationMs: 1234,
    });

    // --- Rerun on the unchanged transcript: cursor is past EOF, no new events. ---
    await captureClaudeTranscript(transcriptPath, repo.root);
    const eventsAfterRerun = await readEvents(repo);
    assert.strictEqual(eventsAfterRerun.length, 6, "rerun on unchanged transcript must not duplicate");
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
      // Known non-turn types: recorded with structure, and silently — the
      // drift warning must stay a signal that the *format* moved.
      { type: "file-history-snapshot", sessionId: SESSION_ID },
      { type: "queue-operation", sessionId: SESSION_ID, operation: "enqueue" },
      // A type this adapter has never heard of — the drift tripwire.
      { type: "holo-message", sessionId: SESSION_ID, timestamp: "2026-01-01T00:00:05.000Z", hologram: "new content kind" },
      { type: "holo-message", sessionId: SESSION_ID, timestamp: "2026-01-01T00:00:06.000Z", hologram: "again" },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await captureClaudeTranscript(path, repo.root);
    // 1 turn + 1 file_snapshot + 1 activity + 2 raw-only preservation events.
    assert.strictEqual(result.appended, 5);
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
    assert.strictEqual((await readEvents(repo)).length, 6);

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
    assert.strictEqual(events.length, 7, "only the newly appended line should be added");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

/**
 * The line types that used to sit in KNOWN_SKIPPED_LINE_TYPES. Each now has a
 * kind, and the assertions below pin which one — the mapping is the contract
 * downstream consumers read, so a silent reclassification should break a test.
 */
test("captureClaudeTranscript: formerly-skipped line types map to their record kinds", async () => {
  const repo = await makeTempRepo("cledger-cc-records-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-records-"));
  try {
    await makeCommit(repo, "init");
    const path = join(transcriptDir, `${SESSION_ID}.jsonl`);
    const lines = [
      { type: "mode", mode: "normal", sessionId: SESSION_ID },
      { type: "permission-mode", permissionMode: "auto", sessionId: SESSION_ID },
      { type: "ai-title", aiTitle: "Fix the parser", sessionId: SESSION_ID },
      {
        type: "worktree-state",
        sessionId: SESSION_ID,
        worktreeSession: { worktreeBranch: "wt-1", originalBranch: "main" },
      },
      {
        type: "attachment",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:01.000Z",
        attachment: { type: "diagnostics", files: ["a.ts"] },
      },
      {
        type: "system",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:02.000Z",
        subtype: "local_command",
        content: "<local-command-stdout>ok</local-command-stdout>",
      },
      {
        type: "queue-operation",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:03.000Z",
        operation: "enqueue",
        content: "run the tests next",
      },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await captureClaudeTranscript(path, repo.root);
    assert.deepStrictEqual(result.unrecognized, {}, "known types must not trip the drift warning");

    const events = await readEvents(repo);
    const bySeq = new Map(events.map((e) => [e.conversation!.seq, e]));
    assert.strictEqual(events.length, 7, "every line is recorded");

    assert.deepStrictEqual(bySeq.get(0)!.content, { state_type: "mode", mode: "normal" });
    assert.strictEqual(bySeq.get(0)!.kind, "session_state");
    assert.strictEqual(bySeq.get(2)!.kind, "session_state");
    assert.deepStrictEqual(bySeq.get(3)!.content, {
      state_type: "worktree-state",
      worktreeSession: { worktreeBranch: "wt-1", originalBranch: "main" },
    });

    const attachment = bySeq.get(4)!;
    assert.strictEqual(attachment.kind, "context_injection");
    assert.deepStrictEqual(attachment.content, {
      injection_type: "attachment/diagnostics",
      attachment: { type: "diagnostics", files: ["a.ts"] },
    });

    // A `system` line with visible text is a turn the system spoke, not
    // machinery: the user read it.
    const localCommand = bySeq.get(5)!;
    assert.strictEqual(localCommand.kind, "conversation_turn");
    assert.strictEqual(localCommand.actor.type, "system");
    assert.deepStrictEqual(localCommand.content, {
      role: "system",
      subtype: "local_command",
      blocks: [{ type: "text", text: "<local-command-stdout>ok</local-command-stdout>" }],
    });

    // The queued prompt is lifted into blocks rather than stored twice.
    const queued = bySeq.get(6)!;
    assert.strictEqual(queued.kind, "activity");
    assert.deepStrictEqual(queued.content, {
      activity_type: "queue-operation",
      operation: "enqueue",
      blocks: [{ type: "text", text: "run the tests next" }],
    });
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

/**
 * File history is the one record whose conversion reads the disk: the
 * transcript names a backup file, and capture resolves it to a digest so the
 * record stays verifiable after the cache is pruned. The digest must land in
 * `resolved`, never in `content`, or a rescan after a prune would mint a
 * second event for the same line.
 */
test("captureClaudeTranscript: file-history lines resolve backup digests into `resolved`", async () => {
  const repo = await makeTempRepo("cledger-cc-filehistory-");
  // The adapter finds the backup cache by walking up to a `projects`
  // directory, so the fixture has to reproduce that layout.
  const configDir = await mkdtemp(join(tmpdir(), "cledger-cc-config-"));
  const transcriptDir = join(configDir, "projects", "escaped-cwd");
  const historyDir = join(configDir, "file-history", SESSION_ID);
  try {
    await makeCommit(repo, "init");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "abc123@v2"), "the file as it was\n");

    const path = join(transcriptDir, `${SESSION_ID}.jsonl`);
    const lines = [
      {
        type: "file-history-snapshot",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        messageId: "msg-1",
        snapshot: {
          messageId: "msg-1",
          trackedFileBackups: {
            "src/a.ts": {
              backupFileName: "abc123@v2",
              version: 2,
              backupTime: "2026-01-01T00:00:00.000Z",
              realParentDir: "/work/src",
            },
            // Tracked but never copied: recorded as a pointer to nothing.
            "src/b.ts": { backupFileName: null, version: 1 },
          },
        },
        isSnapshotUpdate: false,
      },
      {
        type: "file-history-delta",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:01.000Z",
        messageId: "msg-2",
        snapshotMessageId: "msg-1",
        trackingPath: "/work/src/a.ts",
        // Points at a backup this machine does not have — must degrade to no
        // digest rather than failing the capture.
        backup: { backupFileName: "gone@v9", version: 9 },
      },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    await captureClaudeTranscript(path, repo.root);
    const events = await readEvents(repo);
    const bySeq = new Map(events.map((e) => [e.conversation!.seq, e]));

    const snapshot = bySeq.get(0)!;
    assert.strictEqual(snapshot.kind, "file_snapshot");
    assert.deepStrictEqual(snapshot.content, {
      operation: "snapshot",
      message_id: "msg-1",
      is_update: false,
      files: [
        {
          path: "src/a.ts",
          dir: "/work/src",
          version: 2,
          backup_time: "2026-01-01T00:00:00.000Z",
          backup_file: "abc123@v2",
        },
        { path: "src/b.ts", version: 1, backup_file: null },
      ],
    });
    assert.deepStrictEqual(snapshot.resolved, {
      files: [
        {
          backup_file: "abc123@v2",
          sha256: createHash("sha256").update("the file as it was\n").digest("hex"),
          bytes: 19,
        },
      ],
    });

    const delta = bySeq.get(1)!;
    assert.strictEqual(delta.kind, "file_snapshot");
    assert.strictEqual((delta.content as { operation: string }).operation, "delta");
    assert.strictEqual(delta.resolved, undefined, "an unreadable backup resolves to nothing");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(configDir);
  }
});

/**
 * Subagent transcripts are siblings of the session file, named by nothing the
 * hook receives. Found live: a session whose subagent conversation was
 * invisible even though the adapter converts its lines perfectly, because
 * capture was only ever pointed at the main transcript.
 */
test("captureClaudeTranscript: subagent transcripts beside a session are captured too", async () => {
  const repo = await makeTempRepo("cledger-cc-subagent-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-subagent-"));
  try {
    await makeCommit(repo, "init");
    const main = join(transcriptDir, `${SESSION_ID}.jsonl`);
    await writeFile(
      main,
      JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "go" },
      }) + "\n",
    );

    // <dir>/<session>/subagents/agent-<id>.jsonl — the layout Claude Code uses.
    const subDir = join(transcriptDir, SESSION_ID, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "agent-abc.jsonl"),
      [
        {
          type: "user",
          isSidechain: true,
          agentId: "abc",
          sessionId: SESSION_ID,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "subagent prompt" },
        },
        {
          type: "assistant",
          isSidechain: true,
          agentId: "abc",
          attributionAgent: "Explore",
          sessionId: SESSION_ID,
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "assistant", model: "claude-x", content: "subagent answer" },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );

    const result = await captureClaudeTranscript(main, repo.root);
    assert.strictEqual(result.appended, 3, "one parent turn plus the subagent's two");

    const events = await readEvents(repo);
    const sub = events.filter((e) => e.conversation?.id.includes("#agent:abc"));
    assert.strictEqual(sub.length, 2, "the subagent's turns are captured");
    for (const e of sub) {
      assert.strictEqual(e.conversation?.parent, `claude-code:${SESSION_ID}`);
    }
    // A sidechain user line is the harness prompting the subagent, not the
    // person typing — it must not be attributed to the git identity.
    const prompt = sub.find((e) => (e.content as { role?: string }).role === "user")!;
    assert.strictEqual(prompt.actor.type, "system");
    assert.strictEqual(prompt.actor.id, undefined);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

/**
 * A session cannot capture its own last lines: the hook reads to EOF, and
 * Claude Code then writes the closing bookkeeping — including the session's
 * most complete `file-history-snapshot`. Observed live as a cursor resting at
 * line 40 of a 50-line transcript. The next session in the project sweeps it up.
 */
test("runClaudeCodeHook: a later session sweeps up the tail an earlier one could not reach", async () => {
  const repo = await makeTempRepo("cledger-cc-sweep-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-sweep-"));
  try {
    await makeCommit(repo, "init");
    const earlier = join(transcriptDir, "sess-earlier.jsonl");
    await writeFile(
      earlier,
      JSON.stringify({
        type: "user",
        sessionId: "sess-earlier",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "first" },
      }) + "\n",
    );
    await captureClaudeTranscript(earlier, repo.root);
    assert.strictEqual((await readEvents(repo)).length, 1);

    // The tail Claude Code writes after the last hook has already run.
    await appendFile(
      earlier,
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-earlier",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", model: "claude-x", content: "stranded tail" },
      }) + "\n",
    );

    // A different session's hook fires. It must notice the grown transcript.
    const later = join(transcriptDir, "sess-later.jsonl");
    await writeFile(
      later,
      JSON.stringify({
        type: "user",
        sessionId: "sess-later",
        timestamp: "2026-01-02T00:00:00.000Z",
        message: { role: "user", content: "a new session" },
      }) + "\n",
    );
    await runClaudeCodeHook(JSON.stringify({ transcript_path: later, cwd: repo.root }));

    const events = await readEvents(repo);
    const tail = events.find(
      (e) => e.conversation?.id === "claude-code:sess-earlier" && e.conversation.seq === 1,
    );
    assert.ok(tail, "the earlier session's stranded tail was swept up");
    assert.strictEqual(events.length, 3, "the tail and the new session's turn, nothing duplicated");

    // A second hook run must not re-read anything: the sweep is size-gated.
    await runClaudeCodeHook(JSON.stringify({ transcript_path: later, cwd: repo.root }));
    assert.strictEqual((await readEvents(repo)).length, 3, "re-running the sweep is a no-op");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

/**
 * The sweep closes gaps in sessions cledger was already capturing. It must not
 * treat "no cursor" as "a gap": a transcript cledger never captured predates
 * the install or was never wanted, and adopting it would silently backfill
 * every conversation ever held in the repo — anchoring each to whatever HEAD
 * is checked out now rather than to the commit it was actually about.
 */
test("runClaudeCodeHook: the sweep leaves never-captured transcripts alone", async () => {
  const repo = await makeTempRepo("cledger-cc-nosweep-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-nosweep-"));
  try {
    await makeCommit(repo, "init");
    // A session from before cledger existed here: real content, no cursor.
    await writeFile(
      join(transcriptDir, "sess-ancient.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "sess-ancient",
        timestamp: "2020-01-01T00:00:00.000Z",
        message: { role: "user", content: "long before cledger" },
      }) + "\n",
    );

    const current = join(transcriptDir, "sess-current.jsonl");
    await writeFile(
      current,
      JSON.stringify({
        type: "user",
        sessionId: "sess-current",
        timestamp: "2026-01-02T00:00:00.000Z",
        message: { role: "user", content: "today" },
      }) + "\n",
    );
    await runClaudeCodeHook(JSON.stringify({ transcript_path: current, cwd: repo.root }));

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 1, "only the session whose hook fired was captured");
    assert.strictEqual(events[0]!.conversation?.id, "claude-code:sess-current");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

/**
 * The last line of a transcript still being written is half-flushed JSON. The
 * cursor must stop short of it rather than step over it, or the line is lost
 * for good — and the tail is precisely what the sweep goes looking for.
 */
test("captureClaudeTranscript: a torn final line is captured once it is complete", async () => {
  const repo = await makeTempRepo("cledger-cc-torn-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-cc-torn-"));
  try {
    await makeCommit(repo, "init");
    const path = join(transcriptDir, "sess-torn.jsonl");
    const whole =
      JSON.stringify({
        type: "user",
        sessionId: "sess-torn",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "complete" },
      }) + "\n";
    const tail = JSON.stringify({
      type: "assistant",
      sessionId: "sess-torn",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", model: "claude-x", content: "the rest of the story" },
    });

    // Caught mid-write: the second line is cut off with no trailing newline.
    await writeFile(path, whole + tail.slice(0, 40));
    await captureClaudeTranscript(path, repo.root);
    assert.strictEqual((await readEvents(repo)).length, 1, "the torn line is not captured yet");

    // The writer finishes the line.
    await writeFile(path, whole + tail + "\n");
    await captureClaudeTranscript(path, repo.root);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 2, "the completed line is picked up, not skipped");
    const finished = events.find((e) => e.conversation?.seq === 1);
    assert.ok(finished, "the once-torn line landed at its own seq");
    assert.match(JSON.stringify(finished!.content), /the rest of the story/);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});
