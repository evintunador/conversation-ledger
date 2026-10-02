import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCursorTranscript, runCursor } from "../adapters/cursor.js";
import { installCursor } from "../install.js";
import { readEvents } from "../store.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

test("Cursor native transcript retains prompt, tool use, answer, binary reference and torn-tail recovery", async () => {
  const repo = await makeTempRepo("cledger-cursor-test-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-cursor-transcript-"));
  try {
    await makeCommit(repo);
    const path = join(dir, "session-TESTONLY.jsonl");
    const rows = [
      { role: "user", message: { content: [{ type: "text", text: "<timestamp>synthetic</timestamp>\n<user_query>\nRead evidence.txt\n</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Reading" }, { type: "tool_use", name: "Read", input: { path: "evidence.txt" } }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "TESTONLY answer" }, { type: "image", source: { type: "base64", data: "AQID", media_type: "image/png" } }] } },
      { type: "turn_ended", status: "success" },
    ];
    await writeFile(path, rows.slice(0, 2).map(row => JSON.stringify(row)).join("\n") + "\n" + JSON.stringify(rows[2]).slice(0, -1));
    assert.equal((await captureCursorTranscript(path, repo.root, "TESTONLY-session")).appended, 2);
    await appendFile(path, "}\n" + JSON.stringify(rows[3]) + "\n");
    assert.equal((await captureCursorTranscript(path, repo.root, "TESTONLY-session")).appended, 2);
    assert.equal((await captureCursorTranscript(path, repo.root, "TESTONLY-session")).appended, 0);
    const events = (await readEvents(repo)).sort((a, b) => a.stream!.seq - b.stream!.seq);
    assert.equal(events.length, 4);
    assert.equal(events[0]!.actor.type, "human");
    assert.equal((events[0]!.content as any).blocks[0].text, "Read evidence.txt");
    assert.equal((events[1]!.content as any).blocks[1].name, "Read");
    assert.equal((events[2]!.content as any).blocks[1].source.data.type, "attachment_reference");
    assert.ok(!JSON.stringify(events).includes("AQID"));
  } finally { await rm(dir, { recursive: true, force: true }); await cleanupRepo(repo); }
});

test("Cursor installer preserves other hooks and repairs idempotently in an isolated config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cledger-cursor-settings-"));
  const prior = process.env.CURSOR_CONFIG_DIR;
  try {
    process.env.CURSOR_CONFIG_DIR = dir;
    const path = join(dir, "hooks.json");
    await writeFile(path, JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "TESTONLY-existing-hook" }] } }));
    await installCursor();
    const first = await readFile(path, "utf8");
    const settings = JSON.parse(first);
    assert.equal(settings.hooks.preToolUse[0].command, "TESTONLY-existing-hook");
    assert.equal(settings.hooks.stop.length, 1);
    assert.equal(settings.hooks.sessionEnd.length, 1);
    await installCursor();
    assert.equal(await readFile(path, "utf8"), first);
  } finally {
    if (prior === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cursor stream wrapper links result body to the one native transcript tool use", async () => {
  const repo = await makeTempRepo("cledger-cursor-stream-test-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-cursor-stream-"));
  const prior = process.cwd();
  try {
    await makeCommit(repo);
    const transcript = join(dir, "TESTONLY-stream.jsonl");
    await writeFile(transcript, [
      { role: "user", message: { content: [{ type: "text", text: "Read evidence.txt" }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "evidence.txt" } }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "TESTONLY-content" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await captureCursorTranscript(transcript, repo.root, "TESTONLY-stream");
    const started = { type: "tool_call", subtype: "started", session_id: "TESTONLY-stream", call_id: "call-1", tool_call: { readToolCall: { args: { path: "evidence.txt" } } } };
    const completed = { ...started, subtype: "completed", timestamp_ms: 1000, tool_call: { readToolCall: { args: { path: "evidence.txt" }, result: { success: { content: "TESTONLY-content" } } } } };
    const binary = join(dir, "agent");
    await writeFile(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(started))});\nconsole.log(${JSON.stringify(JSON.stringify(completed))});\n`, { mode: 0o755 });
    process.chdir(repo.root);
    assert.equal(await runCursor(["synthetic"], binary), 0);
    const events = (await readEvents(repo)).filter(event => event.producer.source === "cursor");
    const uses = events.flatMap(event => (event.content as any).blocks ?? []).filter((block: any) => block.type === "tool_use");
    const results = events.flatMap(event => (event.content as any).blocks ?? []).filter((block: any) => block.type === "tool_result");
    assert.equal(uses.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_use_id, uses[0].id);
    assert.equal(results[0].content.success.content, "TESTONLY-content");
    assert.equal(await runCursor(["synthetic"], binary), 0);
    assert.equal((await readEvents(repo)).length, events.length);
  } finally { process.chdir(prior); await rm(dir, { recursive: true, force: true }); await cleanupRepo(repo); }
});
