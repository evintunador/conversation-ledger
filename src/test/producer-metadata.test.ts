/**
 * `producer.model` / `provider` / `source_version`: the source-stated facts
 * about *what* produced a turn, as opposed to `producer.source`/`tool`, which
 * only say which capture path recorded it.
 *
 * The two adapters state these facts in structurally different places, and
 * both shapes are exercised here: claude-code stamps every transcript line
 * with the CLI version and labels assistant lines with a model, while codex
 * states them once on out-of-band `session_meta`/`turn_context` lines that
 * govern every response_item that follows. The codex shape is the one with
 * teeth — a cursor-resumed capture never re-reads those lines on the normal
 * path, so "does an incremental capture still label its events" is the test
 * that actually protects the feature.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClaudeTranscript } from "../adapters/claude-code.js";
import { captureCodexTranscript } from "../adapters/codex.js";
import { readEvents } from "../store.js";
import { eventId } from "../schema.js";
import { cleanupDir, cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";

const CC_SESSION = "prod-meta-cc";
const CODEX_SESSION = "prod-meta-codex";
const CODEX_FILENAME = "rollout-2026-01-01T00-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl";

async function writeLines(path: string, lines: unknown[]): Promise<void> {
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("claude-code: producer records the CLI version on every line and the model where stated", async () => {
  const repo = await makeTempRepo("cledger-prodmeta-cc-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-prodmeta-cc-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, `${CC_SESSION}.jsonl`);
    await writeLines(path, [
      {
        type: "user",
        sessionId: CC_SESSION,
        version: "2.1.220",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Hello" },
      },
      {
        type: "assistant",
        sessionId: CC_SESSION,
        version: "2.1.220",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", model: "claude-opus-5", content: "Hi" },
      },
      {
        type: "assistant",
        sessionId: CC_SESSION,
        version: "2.1.220",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", model: "<synthetic>", content: "harness message" },
      },
    ]);

    await captureClaudeTranscript(path, repo.root);
    const bySeq = new Map((await readEvents(repo)).map((e) => [e.conversation!.seq, e]));

    for (const e of bySeq.values()) {
      assert.strictEqual(e.producer.source_version, "2.1.220", "every line carries the CLI version");
      assert.strictEqual(
        e.producer.provider,
        undefined,
        "claude-code never states a provider — it must not be inferred from the source name",
      );
    }

    assert.strictEqual(
      bySeq.get(0)!.producer.model,
      undefined,
      "a user turn is not labelled with a model: the source does not state one, and the model " +
        "that will answer the prompt is not knowable from the prompt's own line",
    );
    assert.strictEqual(bySeq.get(1)!.producer.model, "claude-opus-5");
    assert.strictEqual(
      bySeq.get(2)!.producer.model,
      "<synthetic>",
      "the source's own placeholder passes through verbatim — 'no model produced this' is a fact worth keeping",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("codex: producer picks up model/provider/version from session_meta and turn_context", async () => {
  const repo = await makeTempRepo("cledger-prodmeta-codex-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-prodmeta-codex-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, CODEX_FILENAME);
    await writeLines(path, [
      {
        type: "session_meta",
        payload: { session_id: CODEX_SESSION, cli_version: "0.145.0", model_provider: "openai" },
      },
      { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "medium" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "reasoning", encrypted_content: "opaque-blob" },
      },
      // A mid-session model switch: codex re-emits turn_context, and only the
      // items *after* it belong to the new model.
      { type: "turn_context", payload: { model: "gpt-5.6-pro" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
    ]);

    await captureCodexTranscript(path, repo.root);
    const bySeq = new Map((await readEvents(repo)).map((e) => [e.conversation!.seq, e]));

    for (const e of bySeq.values()) {
      assert.strictEqual(e.producer.source_version, "0.145.0");
      assert.strictEqual(e.producer.provider, "openai");
    }

    assert.strictEqual(
      bySeq.get(2)!.producer.model,
      "gpt-5.6-sol",
      "codex's turn_context governs the whole turn, human message included",
    );
    const reasoning = bySeq.get(3)!;
    assert.strictEqual(reasoning.kind, "reasoning");
    assert.strictEqual(
      reasoning.producer.model,
      "gpt-5.6-sol",
      "an opaque blob is only replayable against the model that produced it, so it must be labelled",
    );
    assert.strictEqual(
      bySeq.get(5)!.producer.model,
      "gpt-5.6-pro",
      "a restated turn_context applies forward only, never retroactively",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("codex: a turn_context that trails the turn's opening message still labels it", async () => {
  // The line order real codex rollouts actually use: session_meta, then the
  // turn's first messages, and only then turn_context. A strictly-forward
  // rule would leave the opening message of every session with no model.
  const repo = await makeTempRepo("cledger-prodmeta-trailing-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-prodmeta-trailing-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, CODEX_FILENAME);
    await writeLines(path, [
      {
        type: "session_meta",
        payload: { session_id: CODEX_SESSION, cli_version: "0.145.0", model_provider: "openai" },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      { type: "world_state", payload: {} },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      },
      // A later switch must NOT reach back and relabel the earlier turn.
      { type: "turn_context", payload: { model: "gpt-5.6-pro" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:03.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      },
    ]);

    await captureCodexTranscript(path, repo.root);
    const bySeq = new Map((await readEvents(repo)).map((e) => [e.conversation!.seq, e]));
    assert.strictEqual(
      bySeq.get(1)!.producer.model,
      "gpt-5.6-sol",
      "the opening message belongs to the first turn, so the first stated context labels it",
    );
    assert.strictEqual(bySeq.get(4)!.producer.model, "gpt-5.6-sol");
    assert.strictEqual(
      bySeq.get(6)!.producer.model,
      "gpt-5.6-pro",
      "seeding fills gaps only — it must not flatten a genuine mid-session switch",
    );
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("codex: a cursor-resumed capture still labels events from context lines it scanned past", async () => {
  const repo = await makeTempRepo("cledger-prodmeta-resume-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-prodmeta-resume-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, CODEX_FILENAME);
    await writeLines(path, [
      {
        type: "session_meta",
        payload: { session_id: CODEX_SESSION, cli_version: "0.145.0", model_provider: "openai" },
      },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      },
    ]);
    await captureCodexTranscript(path, repo.root);

    // The live-session case: the hook fires again after codex appends more
    // lines. The cursor now sits past session_meta and turn_context, so the
    // forward scan alone would see no model at all for these new events.
    await appendFile(
      path,
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "second" }],
        },
      }) + "\n",
    );
    await captureCodexTranscript(path, repo.root);

    const bySeq = new Map((await readEvents(repo)).map((e) => [e.conversation!.seq, e]));
    assert.strictEqual(bySeq.size, 2, "the resumed capture appended exactly one new event");
    const resumed = bySeq.get(3)!;
    assert.strictEqual(resumed.producer.model, "gpt-5.6-sol");
    assert.strictEqual(resumed.producer.provider, "openai");
    assert.strictEqual(resumed.producer.source_version, "0.145.0");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("codex: agent context also lands on raw-only preservation events", async () => {
  const repo = await makeTempRepo("cledger-prodmeta-drift-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-prodmeta-drift-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, CODEX_FILENAME);
    await writeLines(path, [
      {
        type: "session_meta",
        payload: { session_id: CODEX_SESSION, cli_version: "0.145.0", model_provider: "openai" },
      },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "holo_call", text: "a payload type this version cannot interpret" },
      },
    ]);

    await captureCodexTranscript(path, repo.root);
    const preserved = (await readEvents(repo)).find((e) => e.kind === "unrecognized")!;
    assert.ok(preserved, "the unrecognized line is preserved raw-only");
    assert.strictEqual(
      preserved.producer.model,
      "gpt-5.6-sol",
      "renormalizing this line later must not have to re-derive which model produced it",
    );
    assert.strictEqual(preserved.producer.provider, "openai");
    assert.strictEqual(preserved.producer.source_version, "0.145.0");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});

test("producer agent fields stay out of event identity", () => {
  // The fields were added after events existed without them. Folding them
  // into the id would give the same transcript line a different id before and
  // after the upgrade, so a rescan would duplicate every pre-upgrade turn
  // instead of deduping it.
  const bare = draft({ producer: { tool: "cledger", source: "codex", session_id: "s1" } });
  const labelled = draft({
    producer: {
      tool: "cledger",
      source: "codex",
      session_id: "s1",
      model: "gpt-5.6-sol",
      provider: "openai",
      source_version: "0.145.0",
    },
  });
  assert.strictEqual(eventId(bare), eventId(labelled));
});

test("readEvents --model selects only turns the source labelled with that model", async () => {
  const repo = await makeTempRepo("cledger-prodmeta-filter-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-prodmeta-filter-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, CODEX_FILENAME);
    await writeLines(path, [
      { type: "session_meta", payload: { session_id: CODEX_SESSION, model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
      },
      { type: "turn_context", payload: { model: "gpt-5.6-pro" } },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "b" }] },
      },
    ]);
    await captureCodexTranscript(path, repo.root);

    assert.strictEqual((await readEvents(repo)).length, 2);
    const sol = await readEvents(repo, { model: "gpt-5.6-sol" });
    assert.strictEqual(sol.length, 1);
    assert.strictEqual(sol[0]!.conversation!.seq, 2);
    assert.strictEqual((await readEvents(repo, { model: "gpt-5.6-pro" })).length, 1);
    assert.strictEqual((await readEvents(repo, { model: "no-such-model" })).length, 0);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(dir);
  }
});
