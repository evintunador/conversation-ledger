import { piEvidenceGates } from "../verification/pi.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitUserIdentity } from "annals";
import { capturePiAll, capturePiTranscript, renormalizeUnrecognized, renormalizeUnrecognizedMany, runPiHook } from "../adapters/pi.js";
import { readEvents } from "../store.js";
import { eventId } from "../schema.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const timestamp = "2026-09-28T12:00:00.000Z";
const header = { type: "session", version: 3, id: "pi-test-session", timestamp, cwd: "/source/project" };
const entry = (id: string, type: string, fields: Record<string, unknown> = {}, parentId: string | null = null) =>
  ({ type, id, parentId, timestamp, ...fields });
const message = (id: string, role: string, fields: Record<string, unknown>, parentId: string | null = null) =>
  entry(id, "message", { message: { role, timestamp: Date.parse(timestamp), ...fields } }, parentId);
const content = (event: { content: unknown }) => event.content as Record<string, any>;

async function fixture(lines: unknown[]) {
  const repo = await makeTempRepo("cledger-pi-repo-");
  await makeCommit(repo);
  const dir = await mkdtemp(join(tmpdir(), "cledger-pi-fixture-"));
  const path = join(dir, "session.jsonl");
  const write = async (values: unknown[]) => writeFile(path, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
  await write(lines);
  return { repo, dir, path, write, async cleanup() {
    await rm(dir, { recursive: true, force: true });
    await cleanupRepo(repo);
  } };
}

test("pi captures every persisted entry type and preserves the complete tree and context edits", async () => {
  // Inventory from Pi session-manager.ts CURRENT_SESSION_VERSION=3, checked
  // 2026-09-28. These are authored fixtures, not private home transcripts.
  const lines = [header,
    entry("model", "model_change", { provider: "anthropic", modelId: "test-model" }),
    entry("thinking", "thinking_level_change", { thinkingLevel: "high" }, "model"),
    message("user", "user", { content: "Read the project" }, "thinking"),
    entry("usage", "usage", { kind: "cache_warm", model: "test-model", provider: "anthropic", usage: { totalTokens: 9 }, note: "warm" }, "user"),
    entry("compact", "compaction", { summary: "Earlier context", firstKeptEntryId: "user", tokensBefore: 120,
      systemMessage: { role: "system", content: "Retained prompt", toolsAdded: [{ name: "read" }] },
      usage: { input: 20 }, details: { readFiles: ["a.ts"] }, fromHook: false }, "usage"),
    entry("branch", "branch_summary", { summary: "Abandoned alternative", fromId: "compact", usage: { input: 10 } }, "user"),
    entry("state", "custom", { customType: "pi.virtual-model-state", data: { state: { index: 2 } } }, "branch"),
    entry("injection", "custom_message", { customType: "extension-context", content: "Invisible instructions", display: false, details: { origin: "extension" } }, "state"),
    entry("edit", "context_edit", { targetId: "user", replacement: { content: "Replacement" } }, "injection"),
    entry("label", "label", { targetId: "user", label: "bookmark" }, "edit"),
    entry("name", "session_info", { name: "Example session" }, "label"),
    entry("remove", "context_edit", { targetId: "user", replacement: null }, "name"),
    entry("clear-label", "label", { targetId: "user" }, "remove"),
  ];
  const f = await fixture(lines);
  try {
    const result = await capturePiTranscript(f.path, f.repo.root);
    assert.equal(result.appended, lines.length);
    assert.deepEqual(result.unrecognized, {});
    const events = await readEvents(f.repo);
    const byId = new Map(events.map((event) => [content(event).id, event]));
    assert.deepEqual(events.map((event) => event.kind), ["session_state", "session_state", "session_state", "conversation_turn",
      "activity", "context_injection", "context_injection", "session_state", "context_injection", "activity", "activity", "session_state", "activity", "activity"]);
    for (const [index, event] of events.entries()) {
      assert.deepEqual(event.raw!.data, lines[index]);
      assert.equal(event.stream!.seq, index);
      assert.equal(event.stream!.id, "pi:pi-test-session");
      assert.equal(event.producer.source_version, undefined, "session format 3 is not Pi's CLI version");
    }
    assert.equal(content(byId.get("branch")!).parentId, "user");
    assert.equal(content(byId.get("branch")!).fromId, "compact");
    assert.equal(content(byId.get("compact")!).firstKeptEntryId, "user");
    assert.deepEqual(content(byId.get("compact")!).systemMessage.toolsAdded, [{ name: "read" }]);
    assert.equal(content(byId.get("injection")!).display, false);
    assert.equal(byId.get("injection")!.actor.type, "system");
    assert.equal(content(byId.get("remove")!).replacement, null);
    assert.equal(content(byId.get("clear-label")!).label, undefined);
    assert.equal(byId.get("user")!.actor.id, "test@example.com");
    assert.equal(content(byId.get("user")!).blocks[0].text, "Read the project", "context edits must not rewrite raw history");
  } finally { await f.cleanup(); }
});

test("pi normalizes visible blocks and keeps native replay, usage, error and attachment data", async () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const lines = [header,
    message("system", "system", { content: "Base instructions", sections: { rules: "Rules", removed: null }, toolsAdded: [{ name: "read", parameters: {} }], toolsRemoved: [{ name: "old" }] }),
    message("user", "user", { content: [{ type: "text", text: "Pasted text\n@file.ts\nλ" }, image] }, "system"),
    message("assistant", "assistant", { content: [
      { type: "thinking", thinking: "Read first", thinkingSignature: "provider-replay" },
      { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-replay" },
      { type: "text", text: "Checking", textSignature: "native-text-id" },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.ts" }, thoughtSignature: "tool-replay", namespace: "dynamic" },
    ], api: "anthropic-messages", provider: "anthropic", model: "model-a", responseModel: "model-a-dated", responseId: "response-1", thinkingLevel: "high",
      usage: { input: 42, output: 13, cacheRead: 21, cost: { total: 0.001 } }, stopReason: "toolUse", diagnostics: [{ type: "diagnostic" }] }, "user"),
    message("tool", "toolResult", { toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "file missing" }, image], isError: true, details: { exitCode: 1 }, usage: { totalTokens: 2 } }, "assistant"),
    message("error", "assistant", { content: [], model: "model-a", provider: "anthropic", stopReason: "error", errorMessage: "provider unavailable", rawStopReason: "failure" }, "tool"),
  ];
  const f = await fixture(lines);
  try {
    assert.deepEqual((await capturePiTranscript(f.path, f.repo.root)).unrecognized, {});
    const events = (await readEvents(f.repo)).filter((event) => event.kind !== "reasoning");
    assert.equal(events[1]!.kind, "context_injection");
    assert.equal(events[1]!.actor.type, "system");
    assert.deepEqual(content(events[1]!).sections, { rules: "Rules", removed: null });
    const capturedImage = content(events[2]!).blocks[1];
    assert.equal(capturedImage.mimeType, "image/png");
    assert.equal(capturedImage.data.type, "attachment_reference");
    assert.equal(capturedImage.data.size, 5);
    assert.equal(capturedImage.data.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const assistant = events[3]!;
    assert.equal(assistant.actor.type, "agent");
    assert.equal(assistant.actor.id, "model-a");
    assert.equal(assistant.producer.provider, "anthropic");
    assert.deepEqual(content(assistant).blocks, [
      { type: "thinking", text: "Read first" },
      { type: "thinking", text: "", redacted: true },
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "tool-1", name: "read", input: { path: "file.ts" }, namespace: "dynamic" },
    ]);
    const rawAssistant = assistant.raw!.data as any;
    assert.equal(rawAssistant.message.content[0].thinkingSignature, "provider-replay", "non-redacted signatures stay in native raw");
    assert.equal(rawAssistant.message.content[1].thinkingSignature.type, "reasoning_reference");
    const sealed = (await readEvents(f.repo)).find((event) => event.kind === "reasoning")!;
    assert.equal((sealed.raw!.data as any).signatures[0].encrypted_content, "opaque-replay");
    assert.equal(content(assistant).usage.cost.total, 0.001);
    assert.equal(events[4]!.actor.type, "system");
    assert.equal(content(events[4]!).blocks[0].tool_use_id, "tool-1");
    assert.equal(content(events[4]!).blocks[0].is_error, true);
    assert.deepEqual(content(events[4]!).blocks[0].content[1], capturedImage);
    assert.deepEqual(content(events[4]!).details, { exitCode: 1 });
    assert.equal(content(events[5]!).errorMessage, "provider unavailable");
    assert.deepEqual(content(events[5]!).blocks, [], "failed empty assistant turns are not discarded");
  } finally { await f.cleanup(); }
});

test("pi encrypted signatures survive redaction byte-exactly with native paths and stable sibling identities", async () => {
  const marker = "FIXTURE_SECRET_TO_REDACT";
  const f = await fixture([header, message("sealed", "assistant", { provider: "anthropic", model: "fixture-model", content: [
    { type: "thinking", thinking: `Visible ${marker}`, thinkingSignature: `ordinary-${marker}` },
    { type: "thinking", thinking: "", redacted: true, thinkingSignature: `ciphertext-${marker}-one` },
    { type: "thinking", thinking: "", redacted: true, thinkingSignature: `ciphertext-${marker}-two` },
    { type: "text", text: "Visible answer" },
  ] })]);
  try {
    await writeFile(join(f.repo.root, ".cledger.json"), JSON.stringify({ redact: { patterns: [{ id: "fixture", pattern: marker }] } }));
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 3);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).deduped, 3);
    const events = await readEvents(f.repo);
    const turn = events.find((event) => event.kind === "conversation_turn")!;
    const sealed = events.find((event) => event.kind === "reasoning")!;
    assert.equal(turn.stream!.seq, sealed.stream!.seq);
    assert.notEqual(turn.id, sealed.id);
    assert.equal(sealed.producer.model, "fixture-model");
    assert.equal(content(sealed).opaque, true);
    assert.ok(!JSON.stringify(turn).includes(marker), "visible thought and ordinary signature remain subject to redaction");
    assert.equal(sealed.raw!.format, "pi-reasoning-signatures/1");
    const signatures = (sealed.raw!.data as any).signatures;
    assert.deepEqual(signatures, [
      { native_field: "thinkingSignature", path: ["message", "content", 1, "thinkingSignature"], encrypted_content: `ciphertext-${marker}-one` },
      { native_field: "thinkingSignature", path: ["message", "content", 2, "thinkingSignature"], encrypted_content: `ciphertext-${marker}-two` },
    ]);
    assert.equal((sealed.raw!.data as any).native_entry_id, "sealed");
    assert.ok(!JSON.stringify(sealed.content).includes(marker), "ciphertext is never a visible normalized block");
  } finally { await f.cleanup(); }
});

test("pi captures special message roles without inventing human authorship for injected context", async () => {
  const f = await fixture([header,
    message("bash", "bashExecution", { command: "pwd", output: "/work", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/output", excludeFromContext: true }),
    message("custom", "custom", { customType: "plugin", content: [{ type: "text", text: "injected" }], display: true, details: { plugin: 1 } }),
    message("branch", "branchSummary", { summary: "Branch summary", fromId: "old" }),
    message("compact", "compactionSummary", { summary: "Compaction summary", tokensBefore: 100 }),
  ]);
  try {
    assert.deepEqual((await capturePiTranscript(f.path, f.repo.root)).unrecognized, {});
    const events = await readEvents(f.repo);
    assert.equal(events[1]!.actor.type, "human");
    assert.equal(events[1]!.actor.id, "test@example.com");
    assert.equal(content(events[1]!).excludeFromContext, true);
    assert.equal(content(events[1]!).fullOutputPath, "/tmp/output");
    assert.equal(content(events[1]!).command, "pwd");
    assert.equal(content(events[1]!).exitCode, 0);
    assert.ok(events.slice(2).every((event) => event.kind === "context_injection" && event.actor.type === "system"));
  } finally { await f.cleanup(); }
});

test("pi model provenance follows native parent edges through branch switches, including roots", async () => {
  const f = await fixture([header,
    entry("a", "model_change", { provider: "provider-a", modelId: "model-a" }),
    message("u", "user", { content: "root prompt" }, "a"),
    entry("b", "model_change", { provider: "provider-b", modelId: "model-b" }, "u"),
    message("b-answer", "assistant", { content: "alternative b" }, "b"),
    message("a-answer", "assistant", { content: "alternative a" }, "u"),
    message("new-root", "assistant", { content: "independent root" }),
  ]);
  try {
    await capturePiTranscript(f.path, f.repo.root);
    const events = await readEvents(f.repo);
    assert.equal(events[4]!.producer.model, "model-b");
    assert.equal(events[5]!.producer.model, "model-a");
    assert.equal(events[5]!.producer.provider, "provider-a");
    assert.equal(events[6]!.producer.model, undefined);
  } finally { await f.cleanup(); }
});

test("pi drift preserves unknown roles, types, blocks, primitives and completed malformed JSON", async () => {
  const unknownBlock = { type: "audio", data: "audio-payload" };
  const f = await fixture([header,
    message("audio", "user", { content: [unknownBlock, 42] }),
    message("future-role", "future-role", { content: "Do not misattribute me" }),
    entry("future", "future-entry", { payload: { keep: true } }),
    entry("malformed-message", "message", { message: null }),
    null, [1, 2],
  ]);
  try {
    await appendFile(f.path, '{"broken":\n');
    const result = await capturePiTranscript(f.path, f.repo.root);
    assert.equal(result.appended, 9);
    assert.deepEqual(result.unrecognized, { "message/block/audio": 1, "message/block/(non-object)": 1,
      "message/future-role": 1, "future-entry": 1, "message/(malformed)": 1, "(non-object)": 2, "(malformed-json)": 1 });
    const events = await readEvents(f.repo);
    assert.equal(content(events[1]!).blocks[0].type, "audio");
    assert.equal(content(events[1]!).blocks[0].data.type, "attachment_reference");
    assert.equal(content(events[1]!).blocks[0].data.reason, "invalid_encoding");
    assert.ok(!JSON.stringify(events[1]).includes("audio-payload"), "binary omission also applies to unknown blocks");
    assert.equal(events[3]!.actor.type, "system");
    assert.equal(events[3]!.kind, "unrecognized");
    assert.equal(content(events[3]!).native_id, "future-role");
    assert.equal(events[8]!.raw!.data, '{"broken":');
    assert.ok(events.slice(2).every((event) => typeof content(event).raw_sha256 === "string"));
  } finally { await f.cleanup(); }
});

test("pi rescans idempotently, retries torn tails and notices same-length source edits", async () => {
  const first = message("a", "user", { content: "first" });
  const second = message("b", "user", { content: "second" }, "a");
  const f = await fixture([header, first]);
  try {
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 2);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).deduped, 2);
    await appendFile(f.path, JSON.stringify(second).slice(0, 30));
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 0);
    await f.write([header, first, second]);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 1);
    await copyFile(f.path, join(f.dir, "renamed.jsonl"));
    assert.equal((await capturePiTranscript(join(f.dir, "renamed.jsonl"), f.repo.root)).appended, 0);
    await f.write([header, message("a", "user", { content: "edited" }), second]);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 1);
    await f.write([header, first]);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 0, "truncation doesn't duplicate retained entries");
    const events = await readEvents(f.repo);
    assert.equal(events.length, 4);
    assert.equal(new Set(events.map((event) => event.id)).size, 4);
  } finally { await f.cleanup(); }
});

test("pi native ids distinguish identical same-timestamp entries; raw-only changes do too", async () => {
  const f = await fixture([header, message("u1", "user", { content: "same" }), message("u2", "user", { content: "same" })]);
  try {
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 3);
    await f.write([header, entry("x", "future", { data: "first" })]);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 1);
    await f.write([header, entry("x", "future", { data: "second" })]);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 1, "raw-only records cannot collide after edits");
  } finally { await f.cleanup(); }
});

test("pi retains legacy sequential sessions, deterministic missing times and parent session path", async () => {
  const f = await fixture([
    { type: "session", id: "legacy", parentSession: "/must-not-read/private-session.jsonl" },
    { type: "model_change", provider: "legacy-provider", modelId: "legacy-model" },
    { type: "message", message: { role: "assistant", content: "legacy answer" } },
  ]);
  try {
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).appended, 3);
    assert.equal((await capturePiTranscript(f.path, f.repo.root)).deduped, 3);
    const events = await readEvents(f.repo);
    assert.equal(events[2]!.producer.model, "legacy-model");
    assert.ok(events.every((event) => event.occurred_at === "1970-01-01T00:00:00.000Z"));
    assert.equal(content(events[0]!).parentSession, "/must-not-read/private-session.jsonl");
    assert.ok(events.every((event) => event.stream!.parent === undefined));
  } finally { await f.cleanup(); }
});

test("pi renormalization matches live capture identity for turns and state", async () => {
  const f = await fixture([header, message("user", "user", { content: "Hello" }), entry("state", "custom", { customType: "plugin", data: { value: true } })]);
  try {
    await capturePiTranscript(f.path, f.repo.root);
    const events = await readEvents(f.repo);
    const identity = await gitUserIdentity(f.repo);
    for (const event of events) {
      const normalized = renormalizeUnrecognized({ ...event, kind: "unrecognized" }, identity);
      assert.ok(normalized);
      assert.equal(eventId(normalized), event.id);
    }
    assert.equal(renormalizeUnrecognized({ ...events[0]!, raw: { format: "pi-session-jsonl/1", data: null } }, identity), null);
  } finally { await f.cleanup(); }
});

test("pi hook is fail-open outside repositories and for malformed payloads; explicit import validates headers", async () => {
  const f = await fixture([header, message("user", "user", { content: "hook capture" })]);
  try {
    await runPiHook("not JSON");
    await runPiHook("null");
    await runPiHook(JSON.stringify({ transcript_path: f.path, cwd: f.dir }));
    assert.equal((await readEvents(f.repo)).length, 0);
    await runPiHook(JSON.stringify({ transcript_path: f.path, cwd: f.repo.root }));
    assert.equal((await readEvents(f.repo)).length, 2);
    assert.deepEqual(await capturePiTranscript(join(f.dir, "not-yet-flushed.jsonl"), f.repo.root), { appended: 0, deduped: 0, unrecognized: {} });
    await f.write([message("no-header", "user", { content: "wrong format" })]);
    await assert.rejects(capturePiTranscript(f.path, f.repo.root), /session header/);
  } finally { await f.cleanup(); }
});

test("pi backfill validates exact header cwd in shared storage and does not follow nested paths or symlinks", async () => {
  const f = await fixture([{ ...header, cwd: "/a-different-project" }, message("wrong", "user", { content: "must not import" })]);
  try {
    const ownHeader = { ...header, id: "own-session", cwd: f.repo.root };
    const own = [ownHeader, message("mine", "user", { content: "capture me" })];
    await writeFile(join(f.dir, "own.jsonl"), own.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(join(f.dir, "invalid.jsonl"), "{invalid\nPRIVATE BODY\n");
    await mkdir(join(f.dir, "nested"));
    await writeFile(join(f.dir, "nested", "nested.jsonl"), JSON.stringify({ ...ownHeader, id: "nested" }) + "\n");
    await symlink(join(f.dir, "nested", "nested.jsonl"), join(f.dir, "link.jsonl"));
    assert.equal((await capturePiAll(f.repo.root, undefined, f.dir)).appended, 2);
    const events = await readEvents(f.repo);
    assert.ok(events.every((event) => event.producer.session_id === "own-session"));
    assert.equal((await capturePiAll(f.repo.root, 0, f.dir)).deduped, 0);
    assert.equal((await capturePiAll(f.repo.root, 1, f.dir)).deduped, 2);
    await assert.rejects(capturePiAll(f.repo.root, -1, f.dir), /non-negative integer/);
    assert.equal((await capturePiAll(f.repo.root, undefined, join(f.dir, "missing"))).appended, 0);
    assert.equal((await capturePiTranscript(f.path, f.repo.root, f.repo.root)).appended, 0, "revalidate cwd after discovery to avoid replacement races");
  } finally { await f.cleanup(); }
});

test("pi backfill resolves the native encoded cwd directory using an isolated agent home", async () => {
  const f = await fixture([]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousSession = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(f.dir, "agent");
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const encoded = `--${f.repo.root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = join(f.dir, "agent", "sessions", encoded);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "native.jsonl"), JSON.stringify({ ...header, cwd: f.repo.root }) + "\n");
    assert.equal((await capturePiAll(f.repo.root)).appended, 1);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    assert.equal((await capturePiAll(f.repo.root)).deduped, 1);
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    await mkdir(join(f.repo.root, ".pi"));
    await writeFile(join(f.repo.root, ".pi", "settings.json"), JSON.stringify({ sessionDir }));
    assert.equal((await capturePiAll(f.repo.root)).deduped, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousSession === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSession;
    await f.cleanup();
  }
});

test("pi replay upgrades emit the same visible and sealed sibling identities", async () => {
  const native = message("sealed-replay", "assistant", { content: [{ type: "thinking", thinking: "visible", redacted: true, thinkingSignature: "encrypted-native" }] });
  const f = await fixture([header, native]);
  try {
    await capturePiTranscript(f.path, f.repo.root);
    const events = await readEvents(f.repo), visible = events.find(e => e.kind === "conversation_turn")!;
    const replay = renormalizeUnrecognizedMany({ ...visible, kind: "unrecognized", raw: { format: "pi-session-jsonl/1", data: native } }, await gitUserIdentity(f.repo));
    assert.equal(replay?.length, 2);
    assert.deepEqual(replay!.map(eventId).sort(), events.filter(e => e.kind !== "session_state").map(e => e.id).sort());
  } finally { await f.cleanup(); }
});

test("pi sealed reasoning revisions with the same native entry id get distinct identities", async () => {
  const native = message("sealed-revision", "assistant", { content: [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "cipher-one" }] });
  const f = await fixture([header,native]);
  try {
    await capturePiTranscript(f.path,f.repo.root);
    (native as any).message.content[0].thinkingSignature="cipher-two";
    await f.write([header,native]);
    assert.equal((await capturePiTranscript(f.path,f.repo.root)).appended,1);
    assert.equal((await readEvents(f.repo)).filter(e=>e.kind==="reasoning").length,2);
    assert.equal((await capturePiTranscript(f.path,f.repo.root)).appended,0);
  } finally { await f.cleanup(); }
});

test("pi nested content drift persists as a sibling and fails native certification",async()=>{
 const f=await fixture([header,message("future","assistant",{content:[{type:"future_native",payload:"keep"}]})]);
 try{await capturePiTranscript(f.path,f.repo.root);const events=await readEvents(f.repo),unknown=events.find(e=>e.kind==="unrecognized")!;
 assert.ok(unknown);assert.equal(piEvidenceGates(events,"marker","secret").noUnrecognizedRecords,false);
 assert.equal(renormalizeUnrecognizedMany(unknown,await gitUserIdentity(f.repo)),null);
 assert.equal((await capturePiTranscript(f.path,f.repo.root)).appended,0);
 }finally{await f.cleanup();}
});
