import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureContinueTranscript } from "../adapters/continue.js";
import { sha256Hex } from "annals";
import { readEvents } from "../store.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

test("Continue snapshots preserve roles, context, state, summary, media and sealed reasoning", async () => {
  const repo = await makeTempRepo("cledger-continue-"), dir = await mkdtemp(join(tmpdir(), "cledger-continue-tx-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, "session.json");
    const rows = [
      { message: { role: "user", content: [{ type: "text", text: "TESTONLY-prompt" }, { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAEC" } }] }, contextItems: [{ name: "text", content: "TESTONLY-context", uri: { type: "file", value: "file.md" } }] },
      { message: { role: "system", content: "TESTONLY-system" } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "read", function: { name: "Read", arguments: '{"filepath":"file.md"}' } }] }, toolCallStates: [{ toolCallId: "read", status: "done", output: [] }] },
      { message: { role: "tool", toolCallId: "read", content: "TESTONLY-read-result" } },
      { message: { role: "thinking", content: "visible", redactedThinking: "TESTONLY-opaque" } },
      { message: { role: "assistant", content: "answer" }, conversationSummary: "TESTONLY-summary", reasoning: { active: false, text: "TESTONLY-visible-reasoning" } },
      { message: { role: "future", content: "TESTONLY-unknown" } },
    ];
    await writeFile(path, JSON.stringify({ sessionId: "TESTONLY-session", workspaceDirectory: repo.root, history: rows }));
    const result = await captureContinueTranscript(path, repo.root);
    assert.equal(result.unrecognized["history/(unrecognized)"], 1);
    const events = await readEvents(repo);
    for (const kind of ["conversation_turn", "context_injection", "session_state", "reasoning", "compaction_summary", "unrecognized"]) assert.ok(events.some(e => e.kind === kind), kind);
    assert.ok(events.filter(e => e.actor.type === "human").every(e => (e.content as { role: string }).role === "user"));
    assert.ok(JSON.stringify(events).includes("attachment_reference"));
    assert.ok(!JSON.stringify(events).includes("data:image/png;base64"));
    assert.ok(!JSON.stringify(events.filter(e => e.kind !== "reasoning")).includes("TESTONLY-opaque"));
    assert.equal((await captureContinueTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Continue identical occurrences survive while compaction never renumbers retained events", async () => {
  const repo = await makeTempRepo("cledger-continue-order-"), dir = await mkdtemp(join(tmpdir(), "cledger-continue-order-tx-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, "session.json"), row = { message: { role: "user", content: "repeated" } };
    const write = (history: unknown[], cwd = repo.root) => writeFile(path, JSON.stringify({ sessionId: "TESTONLY-order", workspaceDirectory: cwd, history }));
    await write([row, row, { message: { role: "assistant", content: "retained" } }]);
    await Promise.all([captureContinueTranscript(path, repo.root), captureContinueTranscript(path, repo.root)]);
    const before = (await readEvents(repo)).filter(e => e.kind === "conversation_turn");
    assert.equal(before.length, 3);
    await write([{ message: { role: "assistant", content: "retained" } }]);
    await captureContinueTranscript(path, repo.root);
    assert.deepEqual((await readEvents(repo)).filter(e => e.kind === "conversation_turn").map(e => e.id).sort(), before.map(e => e.id).sort());
    await write([row], dir);
    assert.equal((await captureContinueTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});


test("Continue preserves both native encrypted metadata carriers and reports malformed final snapshots", async () => {
  const repo = await makeTempRepo("cledger-continue-encrypted-"), dir = await mkdtemp(join(tmpdir(), "cledger-continue-encrypted-tx-"));
  try {
    await makeCommit(repo, "init");
    const path = join(dir, "session.json");
    const write = (cipher: string) => writeFile(path, JSON.stringify({ sessionId: "TESTONLY-cipher", workspaceDirectory: repo.root, history: [{ message: {
      role: "thinking", content: "", reasoning_details: [{ type: "summary_text", text: "visible summary" }, { type: "encrypted_content", encrypted_content: cipher }],
      metadata: { reasoningId: "TESTONLY-reason", encrypted_content: "TESTONLY-fallback-cipher" },
    } }] }));
    await write("TESTONLY-first-cipher");
    await captureContinueTranscript(path, repo.root);
    let events = await readEvents(repo);
    assert.equal(events.filter(e => e.kind === "reasoning").length, 2);
    assert.ok(!JSON.stringify(events.filter(e => e.kind !== "reasoning")).includes("TESTONLY-first-cipher"));
    assert.ok(!JSON.stringify(events.filter(e => e.kind !== "reasoning")).includes("TESTONLY-fallback-cipher"));
    assert.ok(JSON.stringify(events).includes("visible summary"));
    assert.equal((await captureContinueTranscript(path, repo.root)).appended, 0);
    await write("TESTONLY-second-cipher");
    await captureContinueTranscript(path, repo.root);
    events = await readEvents(repo);
    for (const cipher of ["TESTONLY-first-cipher", "TESTONLY-second-cipher"]) assert.ok(events.some(e => e.kind === "reasoning" && JSON.stringify(e.raw).includes(cipher)));
    await writeFile(path, '{"sessionId":');
    await assert.rejects(captureContinueTranscript(path, repo.root), /malformed or being rewritten/);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});


test("Continue recovers an abandoned heartbeat lock and serializes concurrent recapture", async () => {
  const repo = await makeTempRepo("cledger-continue-stale-"), dir = await mkdtemp(join(tmpdir(), "cledger-continue-stale-tx-"));
  try {
    await makeCommit(repo, "init");
    const id = "TESTONLY-stale-session", path = join(dir, "session.json");
    await writeFile(path, JSON.stringify({ sessionId: id, workspaceDirectory: repo.root, history: [{ message: { role: "user", content: "TESTONLY-retained" } }] }));
    const abandoned = join(repo.commonDir, `cledger-continue-sequence-${sha256Hex(id)}.lock`);
    await mkdir(abandoned);
    const stale = new Date(Date.now() - 60_000);
    await utimes(abandoned, stale, stale);
    await Promise.all([captureContinueTranscript(path, repo.root), captureContinueTranscript(path, repo.root)]);
    const turns = (await readEvents(repo)).filter(e => e.kind === "conversation_turn");
    assert.equal(turns.length, 1);
    assert.equal((await captureContinueTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});
