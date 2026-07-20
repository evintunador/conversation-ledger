import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, readEvents } from "../store.js";
import { unrecognizedDraft } from "../adapters/drift.js";
import { captureClaudeTranscript } from "../adapters/claude-code.js";
import { captureCodexTranscript } from "../adapters/codex.js";
import { renormalize } from "../renormalize.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const CC_SESSION = "renorm-cc-1";

/**
 * Simulate a *blind* adapter that did not recognize a line the *current*
 * adapter can convert: emit a raw-only `unrecognized` event for it, shaped
 * exactly as the preservation path would (same source/session/seq/format,
 * occurred_at handling), then persist it via appendEvents.
 */
async function preserveClaudeLine(repoRoot: string, line: Record<string, unknown>, seq: number) {
  const draft = unrecognizedDraft({
    typeKey: String(line["type"]),
    line,
    occurredAt: String(line["timestamp"]),
    source: "claude-code",
    sessionId: CC_SESSION,
    seq,
    version: "0.0.0-blind",
    rawFormat: "claude-code-jsonl/1",
    conversationId: `claude-code:${CC_SESSION}`,
  });
  return draft;
}

test("renormalize: a preserved line becomes the exact turn a live capture would produce (claude-code)", async () => {
  const repo = await makeTempRepo("cledger-renorm-cc-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-renorm-cc-tx-"));
  try {
    await makeCommit(repo, "init");

    // A perfectly ordinary user line — but pretend an older adapter had no
    // mapping for it and preserved it raw-only.
    const line = {
      type: "user",
      sessionId: CC_SESSION,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Hello there" },
    };
    await appendEvents(repo, [await preserveClaudeLine(repo.root, line, 0)]);

    const before = await readEvents(repo);
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0]!.kind, "unrecognized");
    const unrecognizedId = before[0]!.id;

    // --- Re-normalize ---
    const r = await renormalize(repo);
    assert.deepStrictEqual(
      { scanned: r.scanned, interpreted: r.interpreted, turnsAppended: r.turnsAppended, supersessionsAppended: r.supersessionsAppended, skipped: r.skipped },
      { scanned: 1, interpreted: 1, turnsAppended: 1, supersessionsAppended: 1, skipped: 0 },
    );

    const afterRenorm = await readEvents(repo);
    const turn = afterRenorm.find((e) => e.kind === "conversation_turn")!;
    const supersession = afterRenorm.find((e) => e.kind === "supersession")!;
    assert.ok(turn, "a conversation_turn was produced");
    assert.strictEqual(turn.actor.type, "human");
    assert.strictEqual(turn.actor.id, "test@example.com");
    assert.deepStrictEqual(turn.content, {
      role: "user",
      blocks: [{ type: "text", text: "Hello there" }],
    });
    // The unrecognized event is preserved, not deleted (append-only).
    assert.ok(afterRenorm.some((e) => e.id === unrecognizedId && e.kind === "unrecognized"));
    // The supersession links the two.
    assert.deepStrictEqual(supersession.links, [{ rel: "supersedes", target: unrecognizedId }]);
    assert.strictEqual((supersession.content as Record<string, unknown>)["by"], turn.id);

    // --- Id fidelity: a live capture of the *same* line dedups, not duplicates. ---
    const transcriptPath = join(transcriptDir, `${CC_SESSION}.jsonl`);
    await writeFile(transcriptPath, JSON.stringify(line) + "\n");
    await captureClaudeTranscript(transcriptPath, repo.root);

    const turns = (await readEvents(repo)).filter((e) => e.kind === "conversation_turn");
    assert.strictEqual(turns.length, 1, "the live capture must dedup against the re-normalized turn");
    assert.strictEqual(turns[0]!.id, turn.id);

    // --- Idempotency: a second renormalize is a no-op. ---
    const r2 = await renormalize(repo);
    assert.deepStrictEqual(
      { scanned: r2.scanned, turnsAppended: r2.turnsAppended, supersessionsAppended: r2.supersessionsAppended },
      { scanned: 0, turnsAppended: 0, supersessionsAppended: 0 },
      "already-superseded events are skipped on re-run",
    );
    const finalTurns = (await readEvents(repo)).filter((e) => e.kind === "conversation_turn");
    assert.strictEqual(finalTurns.length, 1);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

const CX_SESSION = "renorm-cx-session-uuid";

test("renormalize: id fidelity across a blind→renorm→seeing capture (codex)", async () => {
  const repo = await makeTempRepo("cledger-renorm-cx-");
  const transcriptDir = await mkdtemp(join(tmpdir(), "cledger-renorm-cx-tx-"));
  try {
    await makeCommit(repo, "init");

    // A response_item/message line the current codex adapter converts, but
    // preserved raw-only as if an older adapter had not recognized it. seq is
    // the line index it will occupy in the transcript captured below: line 0
    // is session_meta, so the message line is seq 1.
    const messageLine = {
      type: "response_item",
      timestamp: "2026-02-02T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "codex hello" }],
      },
    };
    const preserved = unrecognizedDraft({
      typeKey: "response_item/message",
      line: messageLine,
      occurredAt: "2026-02-02T00:00:01.000Z",
      source: "codex",
      sessionId: CX_SESSION,
      seq: 1,
      version: "0.0.0-blind",
      rawFormat: "codex-rollout-jsonl/2",
      conversationId: `codex:${CX_SESSION}`,
    });
    await appendEvents(repo, [preserved]);

    const unrecognizedId = (await readEvents(repo))[0]!.id;

    const r = await renormalize(repo);
    assert.strictEqual(r.interpreted, 1);
    assert.strictEqual(r.turnsAppended, 1);
    assert.strictEqual(r.supersessionsAppended, 1);

    const turn = (await readEvents(repo)).find((e) => e.kind === "conversation_turn")!;
    assert.strictEqual(turn.conversation?.id, `codex:${CX_SESSION}`);
    assert.strictEqual(turn.conversation?.seq, 1);
    assert.deepStrictEqual(turn.content, {
      role: "user",
      blocks: [{ type: "text", text: "codex hello" }],
    });

    // Live capture of the same rollout: session_meta line fixes the session id
    // to CX_SESSION, and the message line lands at seq 1 — same id as above.
    const transcriptPath = join(transcriptDir, "rollout-2026-02-02T00-00-00-renorm.jsonl");
    const rollout = [
      { type: "session_meta", timestamp: "2026-02-02T00:00:00.000Z", payload: { session_id: CX_SESSION } },
      messageLine,
    ];
    await writeFile(transcriptPath, rollout.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await captureCodexTranscript(transcriptPath, repo.root);

    const turns = (await readEvents(repo)).filter((e) => e.kind === "conversation_turn");
    assert.strictEqual(turns.length, 1, "live codex capture must dedup against the re-normalized turn");
    assert.strictEqual(turns[0]!.id, turn.id);

    const supersession = (await readEvents(repo)).find((e) => e.kind === "supersession")!;
    assert.deepStrictEqual(supersession.links, [{ rel: "supersedes", target: unrecognizedId }]);
    assert.strictEqual(
      (supersession.content as Record<string, unknown>)["raw_format"],
      "codex-rollout-jsonl/2",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(transcriptDir);
  }
});

test("renormalize: a still-unrecognized line stays preserved and is skipped", async () => {
  const repo = await makeTempRepo("cledger-renorm-skip-");
  try {
    await makeCommit(repo, "init");
    // A genuinely unknown claude-code type the current adapter cannot convert.
    const line = { type: "holo-message", sessionId: CC_SESSION, timestamp: "2026-01-01T00:00:00.000Z", hologram: "x" };
    await appendEvents(repo, [await preserveClaudeLine(repo.root, line, 0)]);

    const r = await renormalize(repo);
    assert.strictEqual(r.scanned, 1);
    assert.strictEqual(r.interpreted, 0);
    assert.strictEqual(r.skipped, 1);

    const events = await readEvents(repo);
    assert.strictEqual(events.length, 1, "no turn, no supersession — the line stays preserved raw-only");
    assert.strictEqual(events[0]!.kind, "unrecognized");
  } finally {
    await cleanupRepo(repo);
  }
});
