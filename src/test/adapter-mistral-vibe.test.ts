import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureMistralVibeAll, captureMistralVibeTranscript, runMistralVibeHook, renormalizeUnrecognized, renormalizeUnrecognizedMany } from "../adapters/mistral-vibe.js";
import { readEvents } from "../store.js";
import { eventId } from "../schema.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const START = "2026-09-28T12:00:00.000Z";
async function session(dir: string, cwd: string, messages: unknown[], metadata: Record<string, unknown> = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ session_id: "vibe-parent", start_time: START,
    environment: { working_directory: cwd }, ...metadata }));
  const path = join(dir, "messages.jsonl");
  await writeFile(path, messages.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("Vibe native messages and metadata preserve roles, context, tool fields and references", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-vibe-"));
  try {
    await makeCommit(repo, "initial");
    const messages = [
      { message_id: "u1", role: "user", content: "Read this", input_text: "@note.txt", resources: [{ uri: "file:///tmp/note.txt" }],
        user_display_content: { text: "Read this" }, images: [{ source: { kind: "file", path: "/tmp/image.png" }, alias: "image", mime_type: "image/png" }] },
      { message_id: "a1", role: "assistant", content: null, reasoning_content: "Inspect it", reasoning_message_id: "r1",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"note.txt"}' }, presentation: { title: "Read" } }] },
      { role: "tool", tool_call_id: "call_1", name: "read", content: "note contents", tool_result: { output: { text: "note contents" }, cancelled: false, duration: 0.01 } },
      { message_id: "injected", role: "user", content: "Hook context", injected: true },
      { message_id: "compact", role: "user", content: "Conversation summary", context_boundary: "compaction" },
      { message_id: "shell", role: "user", content: "shell output", manual_shell: { command: "pwd", stdout: "/tmp", exit_code: 0, cwd: "/tmp", created_at: 1 } },
      { message_id: "system", role: "system", content: "Imported system message" },
      { message_id: "answer", role: "assistant", content: "Done" },
    ];
    const path = await session(dir, repo.root, messages, { system_prompt: { role: "system", content: "System instructions" },
      config: { active_model: "current-only", providers: [{ api_key_env_var: "MISTRAL_API_KEY", extra_headers: { Authorization: "FAKE_TESTONLY_AUTH" } }],
        mcp_servers: [{ env: { CUSTOM_CREDENTIAL: "FAKE_TESTONLY_VALUE" } }] },
      agent_profile: { name: "default", overrides: { providers: [{ api_key: "FAKE_TESTONLY_PROFILE" }] } },
      stats: { steps: 2 }, git_branch: "main" });
    const result = await captureMistralVibeTranscript(path, repo.root);
    assert.equal(result.appended, 9);
    assert.deepEqual(result.unrecognized, {});
    const events = (await readEvents(repo)).sort((a, b) => a.stream!.seq - b.stream!.seq);
    assert.equal(events[0]!.kind, "session_state");
    assert.match(JSON.stringify(events[0]!.content), /System instructions/);
    assert.doesNotMatch(JSON.stringify(events), /FAKE_TESTONLY_AUTH|FAKE_TESTONLY_VALUE|FAKE_TESTONLY_PROFILE/);
    assert.match(JSON.stringify(events[0]!.content), /configuration_credentials/);
    assert.equal(events[1]!.actor.type, "human");
    assert.equal(events[1]!.actor.id, "test@example.com");
    assert.equal(events[3]!.actor.type, "system");
    assert.equal(events[4]!.kind, "context_injection");
    assert.equal(events[4]!.actor.type, "system");
    assert.equal(events[5]!.kind, "activity");
    assert.equal(events[7]!.actor.type, "system");
    for (const event of events) {
      assert.equal(event.producer.model, undefined, "mutable config cannot label historical messages");
      assert.equal(event.producer.source_version, undefined, "native metadata does not record Vibe version");
    }
    for (let i = 0; i < messages.length; i++) assert.deepEqual(events[i + 1]!.raw!.data, messages[i]);
    const blocks = (events[2]!.content as { blocks: Record<string, unknown>[] }).blocks;
    assert.deepEqual(blocks[0], { type: "thinking", text: "Inspect it" });
    assert.equal(blocks[1]!.type, "tool_use");
    const renorm = renormalizeUnrecognized({ ...events[1]!, kind: "unrecognized" }, { name: "Test User", email: "test@example.com" });
    assert.ok(renorm);
    assert.equal(eventId(renorm), events[1]!.id);
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Vibe mutable snapshots retain native ordering across deletion, same-length edits and torn appends", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-vibe-rewrite-"));
  try {
    await makeCommit(repo, "initial");
    const first = { role: "user", message_id: "u1", content: "First" };
    const removed = { role: "assistant", message_id: "a1", content: "Old answer" };
    const survivor = { role: "user", message_id: "u2", content: "Second" };
    const path = await session(dir, repo.root, [first, removed, survivor]);
    await captureMistralVibeTranscript(path, repo.root);
    const before = (await readEvents(repo)).find((e) => (e.raw?.data as { message_id?: string })?.message_id === "u2")!;
    await writeFile(path, [first, survivor].map((line) => JSON.stringify(line)).join("\n") + "\n");
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0);
    assert.ok((await readEvents(repo)).some((e) => e.id === before.id));
    const cursorDir = join(repo.commonDir, "conversation-ledger", "cursors");
    const cursor = (await readdir(cursorDir)).find((name) => name.startsWith("mistral-vibe-") && name.endsWith(".json"))!;
    await rm(join(cursorDir, cursor));
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0, "missing cursor recovers survivor positions after rewind");
    await writeFile(join(cursorDir, cursor), "broken cursor");
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0, "corrupt cursor recovers durable positions");
    await writeFile(path, [first, { ...survivor, content: "Edited second" }].map((line) => JSON.stringify(line)).join("\n") + '\n{"role":"assistant"');
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 1, "same-length edited snapshot is captured");
    await appendFile(path, ',"message_id":"a2","content":"New answer"}\n');
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 1);
    const events = await readEvents(repo);
    assert.equal(events.filter((e) => (e.raw?.data as { message_id?: string })?.message_id === "u2").length, 2, "both revisions survive");
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Vibe concurrent hooks serialize cursor assignment and deduplicate", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-vibe-race-"));
  try {
    await makeCommit(repo, "initial");
    const path = await session(dir, repo.root, [{ role: "user", message_id: "u1", content: "Prompt" }]);
    const results = await Promise.all([captureMistralVibeTranscript(path, repo.root), captureMistralVibeTranscript(path, repo.root)]);
    assert.equal(results.reduce((count, result) => count + result.appended, 0), 2);
    assert.equal((await readEvents(repo)).length, 2);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Vibe scopes backfill, follows verified children, blocks escaped links and records parent relationships", async () => {
  const repo = await makeTempRepo();
  const root = await mkdtemp(join(tmpdir(), "cledger-vibe-tree-"));
  const outside = await mkdtemp(join(tmpdir(), "cledger-vibe-other-"));
  try {
    await makeCommit(repo, "initial");
    const dir = join(root, "parent");
    const messages = [{ role: "user", message_id: "u1", content: "Parent" }];
    const path = await session(dir, repo.root, messages, { child_sessions: [
      { session_id: "child", relative_path: "children/child" }, { session_id: "outside", relative_path: "escape" },
      { session_id: "outside", relative_path: "../foreign" },
    ] });
    const childPath = await session(join(dir, "children", "child"), repo.root, [{ role: "user", message_id: "u-child", content: "Delegated prompt" }],
      { session_id: "child", parent_session_id: "vibe-parent" });
    await session(outside, repo.root, [{ role: "user", content: "Must not capture" }], { session_id: "outside", parent_session_id: "vibe-parent" });
    await symlink(outside, join(dir, "escape"));
    await session(join(root, "foreign"), outside, messages, { session_id: "foreign" });
    assert.equal((await captureMistralVibeTranscript(childPath, repo.root)).appended, 2, "a direct child hook resolves native delegation before parent capture");
    const result = await captureMistralVibeAll(repo.root, root);
    assert.equal(result.appended, 2);
    const events = await readEvents(repo);
    assert.ok(events.every((e) => !["outside", "foreign"].includes(e.producer.session_id ?? "")));
    const child = events.find((e) => e.producer.session_id === "child" && e.kind === "conversation_turn")!;
    assert.equal(child.stream!.parent, "mistral-vibe:vibe-parent");
    assert.deepEqual(child.actor, { type: "system" });
    await runMistralVibeHook(JSON.stringify({ hook_event_name: "post_agent", cwd: repo.root, transcript_path: path }));
    assert.equal((await readEvents(repo)).length, 4);
    await runMistralVibeHook("invalid json");
  } finally { await cleanupRepo(repo); await cleanupDir(root); await cleanupDir(outside); }
});

test("Vibe parent links without native child evidence do not invent human or subagent authorship", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-vibe-branch-"));
  try {
    await makeCommit(repo, "initial");
    const path = await session(dir, repo.root, [{ role: "user", message_id: "u1", content: "Continued prompt" }],
      { parent_session_id: "previous-session" });
    await captureMistralVibeTranscript(path, repo.root);
    const event = (await readEvents(repo)).find((e) => e.kind === "conversation_turn")!;
    assert.deepEqual(event.actor, { type: "unknown" });
    assert.equal(event.stream!.parent, "mistral-vibe:previous-session");
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Vibe unified session stores warn explicitly instead of reporting successful legacy capture", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-vibe-unified-"));
  const original = process.stderr.write;
  const warnings: string[] = [];
  try {
    await makeCommit(repo, "initial");
    await mkdir(join(dir, "unified", "session"), { recursive: true });
    await writeFile(join(dir, "unified", "session", "CURRENT"), "native pointer");
    process.stderr.write = ((chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    assert.equal((await captureMistralVibeTranscript(join(dir, "unified", "session"), repo.root)).appended, 0);
    assert.equal((await captureMistralVibeAll(repo.root, dir)).appended, 0);
    assert.equal(warnings.filter((warning) => warning.includes("unified harness store is not supported")).length, 2);
  } finally { process.stderr.write = original; await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Vibe shape drift and corruption preserve data; encrypted fields alone use sealed siblings", async () => {
  const repo = await makeTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "cledger-vibe-drift-"));
  try {
    await makeCommit(repo, "initial");
    const lines = [
      { role: "future", message_id: "x", content: "Future message" },
      { role: "assistant", message_id: "y", content: { future: "shape" } },
      { role: "assistant", message_id: "z", content: "Visible", reasoning_payloads: [
        { type: "reasoning", encrypted_content: "opaque-provider-blob" },
        { type: "thinking", thinking: "Visible reasoning", signature: "provider-signature" },
      ] },
    ];
    const path = await session(dir, repo.root, lines);
    await appendFile(path, 'not-json\n');
    const result = await captureMistralVibeTranscript(path, repo.root);
    assert.equal(result.appended, 6);
    assert.equal(Object.values(result.unrecognized).reduce((a, b) => a + b, 0), 3);
    const events = await readEvents(repo);
    const sealed = events.find((e) => e.kind === "reasoning")!;
    assert.deepEqual((sealed.raw!.data as { encrypted_content: unknown }).encrypted_content, ["opaque-provider-blob"]);
    assert.ok(events.filter((e) => e.kind !== "reasoning").every((e) => !JSON.stringify(e).includes("opaque-provider-blob")));
    const visible = events.find((e) => e.kind === "conversation_turn")!;
    assert.match(JSON.stringify(visible), /Visible reasoning/);
    const upgraded = renormalizeUnrecognizedMany({ ...visible, kind: "unrecognized", raw: { format: visible.raw!.format, data: lines[2] } },
      { name: "Test User", email: "test@example.com" });
    assert.equal(upgraded?.length, 2);
    assert.deepEqual(upgraded!.map(eventId).sort(), [visible.id, sealed.id].sort(), "raw upgrade emits identical visible and opaque sibling IDs");
    assert.equal((await captureMistralVibeTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});
