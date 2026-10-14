import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCursorToolHook, captureCursorTranscript, runCursor, cursorTranscriptResultLinks } from "../adapters/cursor.js";
import { installCursor } from "../install.js";
import { readEvents } from "../store.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

test("Cursor anonymous transcript linkage follows unique inputs rather than Read order", () => {
  const calls = ["second.txt", "first.txt"].map((path, i) => ({ id: `transcript-${i}`, name: "Read", native_id_missing: true, input: { path } }));
  const starts = ["first.txt", "second.txt"].map((path, i) => ({ callId: `native-${i}`, tool: "read", input: { path } }));
  assert.deepEqual([...cursorTranscriptResultLinks(calls, starts)], [["native-0", "transcript-1"], ["native-1", "transcript-0"]]);
});

test("Cursor identical repeated reads and missing inputs remain ambiguous", () => {
  const calls = [0, 1].map(i => ({ id: `transcript-${i}`, name: "Read", native_id_missing: true, input: { path: "same.txt" } }));
  const starts = [0, 1].map(i => ({ callId: `native-${i}`, tool: "read", input: { path: "same.txt" } }));
  assert.equal(cursorTranscriptResultLinks(calls, starts).size, 0);
  assert.equal(cursorTranscriptResultLinks(calls.slice(0, 1), [{ callId: "native-0", tool: "read" }]).size, 0);
  assert.equal(cursorTranscriptResultLinks(calls.slice(0, 1), starts).size, 0);
});

test("Cursor supplied transcript IDs are never replaced and input key ordering is harmless", () => {
  const calls = [{ id: "native-transcript", name: "Read", input: { path: "same.txt", limit: 10 } }];
  const starts = [{ callId: "native-0", tool: "read", input: { limit: 10, path: "same.txt" } }];
  assert.equal(cursorTranscriptResultLinks(calls, starts).size, 0);
  assert.equal(cursorTranscriptResultLinks([{ ...calls[0], native_id_missing: true }], starts).get("native-0"), "native-transcript");
});

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
    for (const event of ["preToolUse", "beforeReadFile", "postToolUse", "postToolUseFailure"])
      assert.ok(settings.hooks[event].some((entry: any) => entry.command.includes("hook cursor")));
    await installCursor();
    assert.equal(await readFile(path, "utf8"), first);
  } finally {
    if (prior === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

function nativeHook(repo: string, name: string, id?: string, file = "evidence.txt", extra: Record<string, unknown> = {}) {
  return { hook_event_name: name, session_id: "TESTONLY-native", generation_id: "TESTONLY-turn",
    workspace_roots: [repo], tool_name: "Read", tool_input: { file_path: join(repo, file) },
    ...(id ? { tool_use_id: id } : {}), ...extra };
}

test("Cursor confirmed native reads retain exact text and IDs with stable transcript provenance", async () => {
  const repo = await makeTempRepo("cledger-cursor-native-test-");
  try {
    await makeCommit(repo);
    const values = ["TESTONLY first content\n", "TESTONLY second content\n"];
    for (let i = 0; i < values.length; i++) {
      const id = `TESTONLY-call-${i}\nsource-${i}`, text = values[i]!;
      await captureCursorToolHook(nativeHook(repo.root, "preToolUse", id), repo.root);
      await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, "evidence.txt", { file_path: join(repo.root, "evidence.txt"), content: text }), repo.root);
      assert.ok(!JSON.stringify(await readEvents(repo)).includes(text.trim()));
      const { readdir, stat } = await import("node:fs/promises");
      const directory = join(repo.commonDir, "cledger-cursor-pending"), names = await readdir(directory);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, names[0]!))).mode & 0o777, 0o600);
      const post = nativeHook(repo.root, "postToolUse", id, "evidence.txt", { tool_output: JSON.stringify({ file_path: join(repo.root, "evidence.txt"), content_length: text.length }) });
      await captureCursorToolHook(post, repo.root);
      const count = (await readEvents(repo)).length;
      await captureCursorToolHook(post, repo.root);
      assert.equal((await readEvents(repo)).length, count);
    }
    const transcript = join(repo.root, "TESTONLY.jsonl");
    await writeFile(transcript, [
      { role: "user", message: { content: [{ type: "text", text: "Read evidence.txt twice" }] } },
      ...values.map(() => ({ role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: join(repo.root, "evidence.txt") } }] } })),
      { type: "turn_ended", status: "success" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await captureCursorTranscript(transcript, repo.root, "TESTONLY-native");
    const events = await readEvents(repo), blocks = events.filter(e => e.raw?.format.startsWith("cursor-agent-native-hooks/1")).flatMap(e => (e.content as any).blocks ?? []);
    const calls = blocks.filter((b: any) => b.type === "tool_use"), results = blocks.filter((b: any) => b.type === "tool_result");
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);
    for (let i = 0; i < values.length; i++) {
      const id = `TESTONLY-call-${i}\nsource-${i}`;
      assert.ok(calls.some((c: any) => c.id === id));
      assert.ok(results.some((r: any) => r.tool_use_id === id && JSON.stringify(r.content).includes(values[i]!.trim())));
    }
    const transcriptCalls = events.filter(e => e.raw?.format === "cursor-agent-transcript-jsonl/1").flatMap(e => (e.content as any).blocks ?? []).filter((b: any) => b.type === "tool_use");
    assert.equal(transcriptCalls.length, 2);
    assert.ok(transcriptCalls.every((b: any) => b.native_id_missing === true && b.id.startsWith("transcript-")));
    assert.equal((await captureCursorTranscript(transcript, repo.root, "TESTONLY-native")).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Cursor empty binary hook text cannot invent file identity; empty known text is retained", async () => {
  const repo = await makeTempRepo("cledger-cursor-empty-body-");
  try {
    await makeCommit(repo);
    for (const path of ["image-TESTONLY.png", "empty-TESTONLY.txt"]) {
      const id = "TESTONLY-" + path;
      await captureCursorToolHook(nativeHook(repo.root, "preToolUse", id, path), repo.root);
      await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, path, { file_path: join(repo.root, path), content: "" }), repo.root);
      await captureCursorToolHook(nativeHook(repo.root, "postToolUse", id, path, { tool_output: JSON.stringify({ file_path: join(repo.root, path), content_length: 0 }) }), repo.root);
    }
    const events = await readEvents(repo), results = events.flatMap(event => (event.content as any).blocks ?? []).filter((block: any) => block.type === "tool_result");
    const image = results.find((block: any) => block.tool_use_id === "TESTONLY-image-TESTONLY.png").content.file;
    assert.equal(image.availability, "native_binary_body_unavailable");
    assert.equal(image.sha256, undefined); assert.equal(image.size, undefined);
    const raw = events.find(event => (event.content as any).activity_type === "beforeReadFile" && (event.content as any).file_path.endsWith(".png"))!.raw!.data as any;
    assert.equal(raw.content.availability, "native_binary_body_unavailable");
    assert.equal(raw.content.sha256, undefined); assert.equal(raw.content.size, undefined);
    const text = results.find((block: any) => block.tool_use_id === "TESTONLY-empty-TESTONLY.txt").content.file.file_data;
    assert.equal(text.type, "attachment_text"); assert.equal(text.text, ""); assert.equal(text.size, 0);
  } finally { await cleanupRepo(repo); }
});

test("Cursor later generations never change IDs of previously captured same-file transcript rows", async () => {
  const repo = await makeTempRepo("cledger-cursor-stable-generations-");
  try {
    await makeCommit(repo);
    const path = join(repo.root, "TESTONLY-generations.jsonl"), session = "TESTONLY-native";
    const turn = (text: string) => [
      { role: "user", message: { content: [{ type: "text", text }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: join(repo.root, "evidence.txt") } }] } },
    ];
    await writeFile(path, turn("TESTONLY first turn").map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.equal((await captureCursorTranscript(path, repo.root, session)).appended, 2);
    const firstIds = (await readEvents(repo)).filter(e => e.raw?.format === "cursor-agent-transcript-jsonl/1").map(e => e.id);
    for (let i = 1; i <= 2; i++) {
      const extra = { generation_id: `TESTONLY-generation-${i}` }, text = `TESTONLY version ${i}\n`, id = `call-${i}`;
      await captureCursorToolHook(nativeHook(repo.root, "preToolUse", id, "evidence.txt", extra), repo.root);
      await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, "evidence.txt", { ...extra, file_path: join(repo.root, "evidence.txt"), content: text }), repo.root);
      await captureCursorToolHook(nativeHook(repo.root, "postToolUse", id, "evidence.txt", { ...extra, tool_output: JSON.stringify({ file_path: join(repo.root, "evidence.txt"), content_length: text.length }) }), repo.root);
      if (i === 2) await appendFile(path, turn("TESTONLY second turn").map(row => JSON.stringify(row)).join("\n") + "\n");
      assert.equal((await captureCursorTranscript(path, repo.root, session)).appended, i === 1 ? 0 : 2);
      const rows = (await readEvents(repo)).filter(e => e.raw?.format === "cursor-agent-transcript-jsonl/1");
      assert.equal(rows.length, i * 2);
      assert.ok(firstIds.every(id => rows.some(e => e.id === id)));
    }
    assert.equal((await captureCursorTranscript(path, repo.root, session)).appended, 0);
    assert.equal((await captureCursorTranscript(path, repo.root, session)).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Cursor malformed native hook provenance is visible without preserving unapproved bytes", async () => {
  const repo = await makeTempRepo("cledger-cursor-hook-drift-");
  try {
    await makeCommit(repo);
    const secret = "TESTONLY unknown unapproved read body";
    const missingGeneration = nativeHook(repo.root, "beforeReadFile", undefined, "evidence.txt", { file_path: join(repo.root, "evidence.txt"), content: secret });
    delete (missingGeneration as Record<string, unknown>).generation_id;
    await captureCursorToolHook(missingGeneration, repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "preToolUse"), repo.root);
    const missingSession = { ...missingGeneration };
    delete (missingSession as Record<string, unknown>).session_id;
    await captureCursorToolHook(missingSession, repo.root);
    const malformedPost = nativeHook(repo.root, "postToolUse", "invalid", "evidence.txt", { tool_output: JSON.stringify({ content_length: "not-a-number" }) });
    await captureCursorToolHook(malformedPost, repo.root);
    const rows = await readEvents(repo);
    assert.equal(rows.length, 4);
    assert.ok(rows.every(e => e.kind === "unrecognized"));
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.ok(rows.some(e => !e.stream && !e.producer.session_id));
    assert.ok(rows.some(e => (e.content as any).missing_provenance.includes("generation_id")));
  } finally { await cleanupRepo(repo); }
});

test("Cursor expired private read candidates are removed and late success retains only a reference", async () => {
  const repo = await makeTempRepo("cledger-cursor-expiry-test-");
  try {
    await makeCommit(repo);
    const secret = "TESTONLY expired unapproved bytes";
    await captureCursorToolHook(nativeHook(repo.root, "preToolUse", "late"), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, "evidence.txt", {
      file_path: join(repo.root, "evidence.txt"), content: secret,
    }), repo.root, { ttlMs: 100 });
    const { readdir } = await import("node:fs/promises");
    const directory = join(repo.commonDir, "cledger-cursor-pending"), deadline = Date.now() + 5000;
    while ((await readdir(directory)).length && Date.now() < deadline)
      await new Promise(done => setTimeout(done, 100));
    assert.deepEqual(await readdir(directory), []);
    await captureCursorToolHook(nativeHook(repo.root, "postToolUse", "late", "evidence.txt", {
      tool_output: JSON.stringify({ file_path: join(repo.root, "evidence.txt"), content_length: secret.length }),
    }), repo.root);
    const serialized = JSON.stringify(await readEvents(repo));
    assert.ok(!serialized.includes(secret));
    assert.ok(serialized.includes("body_not_captured"));
  } finally { await cleanupRepo(repo); }
});

test("Cursor native JSON result carriers apply binary retention to normalized and raw data", async () => {
  const repo = await makeTempRepo("cledger-cursor-json-policy-test-");
  try {
    await makeCommit(repo);
    const extra = { tool_name: "MCP:TESTONLY_asset", tool_input: {} };
    await captureCursorToolHook(nativeHook(repo.root, "preToolUse", "asset", "evidence.txt", extra), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "postToolUse", "asset", "evidence.txt", { ...extra,
      tool_output: JSON.stringify({ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }),
    }), repo.root);
    const result = (await readEvents(repo)).find(e => (e.content as any).hook_event_name === "postToolUse")!;
    assert.ok(!JSON.stringify(result).includes("AQID"));
    assert.ok(JSON.stringify(result.content).includes("attachment_reference"));
    assert.ok(JSON.stringify(result.raw).includes("attachment_reference"));
  } finally { await cleanupRepo(repo); }
});

test("Cursor denied and parallel ambiguous reads never durably retain unapproved bytes", async () => {
  const repo = await makeTempRepo("cledger-cursor-permission-test-");
  try {
    await makeCommit(repo);
    const denied = "TESTONLY denied bytes", ambiguous = "TESTONLY ambiguous bytes";
    await captureCursorToolHook(nativeHook(repo.root, "preToolUse", "denied"), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, "evidence.txt", { file_path: join(repo.root, "evidence.txt"), content: denied }), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "postToolUseFailure", "denied", "evidence.txt", { failure_type: "permission_denied", error_message: "TESTONLY Read denied" }), repo.root);
    for (const id of ["parallel-a", "parallel-b"]) await captureCursorToolHook(nativeHook(repo.root, "preToolUse", id), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, "evidence.txt", { file_path: join(repo.root, "evidence.txt"), content: ambiguous }), repo.root);
    for (const id of ["parallel-a", "parallel-b"]) await captureCursorToolHook(nativeHook(repo.root, "postToolUse", id, "evidence.txt", { tool_output: JSON.stringify({ file_path: join(repo.root, "evidence.txt"), content_length: ambiguous.length }) }), repo.root);
    const events = await readEvents(repo), serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(denied));
    assert.ok(!serialized.includes(ambiguous));
    const blocks = events.flatMap(e => (e.content as any).blocks ?? []);
    assert.ok(blocks.some((b: any) => b.type === "tool_result" && b.tool_use_id === "denied" && b.is_error === true));
    assert.ok(serialized.includes("ambiguous_or_missing_call"));
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(repo.commonDir, "cledger-cursor-pending")), []);
  } finally { await cleanupRepo(repo); }
});

test("Cursor successful unknown file formats remain references in normalized and raw capture", async () => {
  const repo = await makeTempRepo("cledger-cursor-binary-test-");
  try {
    await makeCommit(repo);
    const text = "TESTONLY binary canary\0bytes";
    await captureCursorToolHook(nativeHook(repo.root, "preToolUse", "binary", "artifact.bin"), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "beforeReadFile", undefined, "artifact.bin", { file_path: join(repo.root, "artifact.bin"), content: text }), repo.root);
    await captureCursorToolHook(nativeHook(repo.root, "postToolUse", "binary", "artifact.bin", { tool_output: JSON.stringify({ file_path: join(repo.root, "artifact.bin"), content_length: text.length }) }), repo.root);
    const events = await readEvents(repo), result = events.find(e => (e.content as any).hook_event_name === "postToolUse")!;
    assert.ok(JSON.stringify(result.content).includes("attachment_reference"));
    assert.ok(JSON.stringify(result.raw).includes("attachment_reference"));
    assert.ok(!JSON.stringify(events).includes("TESTONLY binary canary"));
  } finally { await cleanupRepo(repo); }
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

test("Cursor stream keeps actual hook call IDs and references native Read binary bytes in raw and normalized evidence", async () => {
  const repo = await makeTempRepo("cledger-cursor-native-stream-test-");
  const dir = await mkdtemp(join(tmpdir(), "cledger-cursor-native-stream-"));
  const prior = process.cwd();
  try {
    await makeCommit(repo);
    for (const id of ["native-text", "native-image"]) await captureCursorToolHook({ session_id: "TESTONLY-native",
      generation_id: "TESTONLY-generation", hook_event_name: "preToolUse", tool_use_id: id,
      tool_name: "Read", tool_input: { file_path: id === "native-image" ? "image.png" : "text.txt" } }, repo.root);
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]), encoded = bytes.toString("base64");
    const rows = ["native-image", "native-text"].flatMap(id => {
      const args = { path: id === "native-image" ? "image.png" : "text.txt" };
      const start = { type: "tool_call", subtype: "started", session_id: "TESTONLY-native", call_id: id,
        tool_call: { readToolCall: { args } } };
      return [start, { ...start, subtype: "completed", timestamp_ms: 1000,
        tool_call: { readToolCall: { args, result: { success: id === "native-image" ? { data: encoded } : { content: "café 日本語 🦉" } } } } }];
    });
    const binary = join(dir, "agent");
    await writeFile(binary, `#!${process.execPath}\n` + rows.map(row => `console.log(${JSON.stringify(JSON.stringify(row))});`).join("\n"), { mode: 0o755 });
    process.chdir(repo.root);
    assert.equal(await runCursor(["synthetic"], binary), 0);
    const events = await readEvents(repo);
    const stream = events.filter(e => e.raw?.format.startsWith("cursor-agent-stream-json/1"));
    assert.equal(stream.length, 2);
    for (const e of stream) assert.equal((e.content as any).blocks[0].tool_use_id, (e.content as any).source_call_id);
    const image = stream.find(e => (e.content as any).source_call_id === "native-image")!;
    const reference = (image.content as any).blocks[0].content.success.data.file_data;
    assert.equal(reference.type, "attachment_reference");
    assert.equal(reference.size, bytes.length);
    assert.equal(reference.media_type, "application/octet-stream");
    assert.ok(JSON.stringify(image.raw).includes(reference.sha256));
    assert.ok(!JSON.stringify(events).includes(encoded));
    assert.ok(JSON.stringify(stream).includes("café 日本語 🦉"));
  } finally { process.chdir(prior); await rm(dir, { recursive: true, force: true }); await cleanupRepo(repo); }
});
