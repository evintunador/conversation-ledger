import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { captureCopilotTranscript, captureCopilotAll, runCopilotHook, renormalizeUnrecognizedMany, type CopilotRecord } from "../adapters/copilot.js";
import { readEvents } from "../store.js";
import { makeTempRepo, makeCommit, cleanupRepo } from "./helpers.js";

const timestamp = "2026-09-28T12:00:00.000Z";
const row = (id: string, type: string, data: Record<string, unknown>, agentId?: string): CopilotRecord => ({
  id, type, data, timestamp, parentId: null, ...(agentId ? { agentId } : {}),
});
const jsonl = (records: CopilotRecord[]) => records.map(r => JSON.stringify(r)).join("\n") + "\n";

test("Copilot preserves source identities, native roles/tool results, opaque reasoning and uncommon records", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const path = join(repo.root, "events.jsonl");
    const records = [
      row("a", "session.start", { sessionId: "fixture", copilotVersion: "1.0.89", context: { cwd: repo.root }, selectedModel: "selected-only" }),
      row("b", "user.message", { content: "TESTONLY prompt" }),
      row("c", "assistant.message", { content: "answer", model: "native-model", reasoningText: "visible thought", encryptedContent: "TESTONLY-opaque", reasoningBlocks: { provider: "openai", blocks: [{ type: "reasoning", encrypted_content: "TESTONLY-nested-opaque", summary: [{ text: "visible summary" }] }] }, toolRequests: [{ toolCallId: "call1", name: "view", arguments: { path: "test.txt" } }] }),
      row("d", "tool.execution_complete", { toolCallId: "call1", success: false, error: { message: "TESTONLY failure" } }),
      row("e", "user.message", { content: "automatic", isAutopilotContinuation: true }),
      row("f", "session.compaction_complete", { success: true, summaryContent: "summary" }),
      row("g", "subagent.started", { parentId: "parent", toolCallId: "task1", model: "child-model" }, "child"),
      row("h", "assistant.message", { content: "child reply" }, "child"),
      row("i", "new.upstream.type", { content: "TESTONLY preserved unknown" }),
      row("j", "user.message", { content: "delegated prompt" }, "child"),
    ];
    await writeFile(path, jsonl(records));
    const captured = await captureCopilotTranscript(path, repo.root);
    assert.equal(captured.appended, 11);
    assert.deepEqual(captured.unrecognized, { "new.upstream.type": 1 });
    const events = await readEvents(repo);
    const byId = (id: string) => events.find(e => (e.content as Record<string, unknown>).source_event_id === id && e.kind !== "reasoning")!;
    assert.equal(byId("b").actor.type, "human");
    assert.equal(byId("b").producer.model, undefined, "selected session model must not be invented for a human turn");
    assert.equal(byId("c").producer.model, "native-model");
    assert.equal(byId("c").producer.source_version, "1.0.89");
    assert.equal(byId("d").actor.type, "system");
    assert.equal((byId("d").content as { blocks: { is_error: boolean }[] }).blocks[0]!.is_error, true);
    assert.equal(byId("e").actor.type, "system");
    assert.equal(byId("f").kind, "context_injection");
    assert.equal(byId("h").stream?.parent, "copilot:fixture:agent:parent");
    assert.equal(byId("j").actor.type, "system");
    assert.equal(byId("j").actor.id, undefined, "forwarded child prompt is not attributed to git author");
    assert.ok(!JSON.stringify(byId("c")).includes("TESTONLY-opaque"));
    assert.ok(!JSON.stringify(byId("c")).includes("TESTONLY-nested-opaque"));
    assert.ok(JSON.stringify(byId("c")).includes("visible summary"));
    assert.ok(JSON.stringify(events.find(e => e.kind === "reasoning")).includes("TESTONLY-opaque"));
    const renormalized = renormalizeUnrecognizedMany({ ...byId("c"), raw: { format: "copilot-session-events-jsonl/1", data: records[2] } }, { name: null, email: null });
    assert.equal(renormalized?.length, 2, "future normalization retains sealed sibling");
    const original = byId("h").id;
    // Delete an earlier event: native UUID/timestamp identity must not be renumbered.
    await writeFile(path, jsonl(records.filter(r => r.id !== "b")));
    assert.equal((await captureCopilotTranscript(path, repo.root)).appended, 0);
    assert.ok((await readEvents(repo)).some(e => e.id === original));
  } finally { await cleanupRepo(repo); }
});

test("Copilot preserves malformed, primitive, array and invalid known rows without inventing content", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const path = join(repo.root, "events.jsonl");
    const start = row("start", "session.start", { sessionId: "invalid", context: { cwd: repo.root } });
    const invalidTurn = row("missing", "assistant.message", { model: "fixture" });
    const invalidData = { ...row("array-data", "assistant.message", {}), data: ["TESTONLY data"] };
    await writeFile(path, jsonl([start]) + '{BROKEN TESTONLY}\n42\n["TESTONLY array"]\n{"type":42,"data":{}}\n' + JSON.stringify(invalidTurn) + "\n" + JSON.stringify(invalidData) + '\n{"torn":');
    const first = await captureCopilotTranscript(path, repo.root);
    assert.equal(first.appended, 7);
    const unknown = (await readEvents(repo)).filter(e => e.kind === "unrecognized");
    assert.equal(unknown.length, 6);
    assert.ok(unknown.some(e => e.raw?.data === "{BROKEN TESTONLY}"));
    assert.ok(unknown.some(e => e.raw?.data === 42));
    assert.ok(unknown.some(e => JSON.stringify(e.raw?.data) === '["TESTONLY array"]'));
    assert.deepEqual(unknown.find(e => (e.raw?.data as CopilotRecord)?.id === "missing")?.raw?.data, invalidTurn);
    assert.deepEqual(unknown.find(e => (e.raw?.data as CopilotRecord)?.id === "array-data")?.raw?.data, invalidData);
    assert.equal((await captureCopilotTranscript(path, repo.root)).appended, 0);
    assert.ok(unknown.every(e => !(e.content as { blocks?: unknown }).blocks));
  } finally { await cleanupRepo(repo); }
});

test("Copilot hook waits for native delayed transcript creation before reporting capture", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const path = join(repo.root, "delayed-events.jsonl");
    const records = [row("start", "session.start", { sessionId: "delayed", context: { cwd: repo.root } }), row("turn", "user.message", { content: "TESTONLY delayed" })];
    const write = new Promise<void>((resolve, reject) => setTimeout(() => { writeFile(path, jsonl(records)).then(() => resolve(), reject); }, 100));
    await Promise.all([write, runCopilotHook(JSON.stringify({ cwd: repo.root, sessionId: "delayed", transcriptPath: path, timestamp: Date.parse(timestamp) }))]);
    assert.equal((await readEvents(repo)).length, 2);
  } finally { await cleanupRepo(repo); }
});

test("Copilot exact-cwd backfill and hook catch-up exclude foreign sessions, preserve torn tails", async () => {
  const repo = await makeTempRepo(), other = await makeTempRepo();
  const originalHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = join(homedir(), "copilot-fixture");
  try {
    await makeCommit(repo, "base");
    const ownDir = join(process.env.COPILOT_HOME, "session-state", "own");
    const foreignDir = join(process.env.COPILOT_HOME, "session-state", "foreign");
    await Promise.all([ownDir, foreignDir].map(p => mkdir(p, { recursive: true })));
    const path = join(ownDir, "events.jsonl");
    const start = row("start", "session.start", { sessionId: "own", context: { cwd: repo.root } });
    const turn = row("turn", "user.message", { content: "TESTONLY own" });
    await writeFile(path, jsonl([start]) + JSON.stringify(turn).slice(0, -5));
    await writeFile(join(foreignDir, "events.jsonl"), jsonl([row("foreign", "session.start", { sessionId: "foreign", context: { cwd: other.root } }), row("foreign-turn", "user.message", { content: "TESTONLY foreign" })]));
    await captureCopilotAll(repo.root);
    assert.equal((await readEvents(repo)).length, 1);
    await writeFile(path, jsonl([start, turn]));
    await runCopilotHook(JSON.stringify({ sessionId: "own", cwd: repo.root }));
    assert.equal((await readEvents(repo)).length, 2);
    await runCopilotHook(JSON.stringify({ session_id: "own", cwd: repo.root, transcript_path: path }));
    assert.equal((await readEvents(repo)).length, 2);
    await writeFile(path, jsonl([start, turn, row("move", "session.context_changed", { cwd: other.root }), row("outside", "user.message", { content: "TESTONLY later foreign" })]));
    assert.equal((await captureCopilotTranscript(path, repo.root)).appended, 0);
  } finally {
    if (originalHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = originalHome;
    await Promise.all([cleanupRepo(repo), cleanupRepo(other)]);
  }
});
