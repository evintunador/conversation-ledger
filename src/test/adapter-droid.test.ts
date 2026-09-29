import { droidEvidenceGates } from "../verification/droid.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitUserIdentity } from "annals";
import { captureDroidAll, captureDroidTranscript, droidProjectKey, renormalizeUnrecognizedMany, runDroidHook } from "../adapters/droid.js";
import { eventId } from "../schema.js";
import { readEvents } from "../store.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";
const at = "2026-09-29T03:00:00.000Z";
const header = { type: "session_start", id: "droid-fixture", title: "Fixture", owner: "unknown", version: 2 };
const msg = (id: string, role: string, content: unknown, fields: Record<string, unknown> = {}, parentId?: string) =>
  ({ type: "message", id, timestamp: at, ...(parentId ? { parentId } : {}), message: { role, content, ...fields } });
const c = (e: { content: unknown }) => e.content as Record<string, any>;
async function fixture(rows: unknown[], headerFields: Record<string, unknown> = {}) {
  const repo = await makeTempRepo("cledger-droid-test-"); await makeCommit(repo);
  const home = await mkdtemp(join(tmpdir(), "cledger-droid-fixture-")), sessions = join(home, ".factory", "sessions");
  const directory = join(sessions, await droidProjectKey(repo.root)); await mkdir(directory, { recursive: true });
  const path = join(directory, "droid-fixture.jsonl"), h = { ...header, cwd: repo.root, ...headerFields };
  const write = async (r: unknown[]) => writeFile(path, [h, ...r].map(v => JSON.stringify(v)).join("\n") + "\n");
  await write(rows);
  return { repo, home, sessions, directory, path, write, header: h, async cleanup() { await rm(home, { recursive: true, force: true }); await cleanupRepo(repo); } };
}
test("droid complete native top-level record inventory and mutable settings preserve state, lineage and usage", async () => {
  const rows = [
    msg("user", "user", [{ type: "text", text: "question" }], {}, "context"),
    msg("answer", "assistant", [{ type: "text", text: "answer" }], { modelId: "model-native", apiProvider: "provider-native", routerId: "auto", reasoningEffort: "high", openaiMessageId: "native-response" }, "user"),
    { type: "todo_state", id: "todo", timestamp: at, todos: [{ id: "1", content: "test", status: "pending" }], messageIndex: 2 },
    { type: "compaction_state", id: "compact", timestamp: at, summaryText: "summary", summaryTokens: 12, summaryKind: "provider_switch_serialization", anchorMessage: { id: "answer", index: 1 }, removedCount: 2, systemInfo: { cwd: "/workspace" }, loadedDeferredToolNames: ["tool"] },
    { type: "agent_turn_outcome", turnId: "user", reason: "completed", resultKind: "structured", result: { done: true }, schemaFingerprint: "abc" },
  ];
  const f = await fixture(rows, { parent: "fork-parent", forkedAtMessageId: "boundary" });
  try {
    const settings = { model: "new-model", providerLock: "generic-chat-completion-api", tokenUsage: { inputTokens: 4 }, childInclusiveTokenUsageBySessionId: { child: { inputTokens: 2 } }, systemPrompt: "custom", tags: [{ name: "mission:test" }], archivedAt: at };
    await writeFile(join(f.directory, "droid-fixture.settings.json"), JSON.stringify(settings));
    const result = await captureDroidTranscript(f.path, f.repo.root); assert.equal(result.appended, 7); assert.deepEqual(result.unrecognized, {});
    const events = await readEvents(f.repo);
    assert.equal(events.find(e => c(e).id === "answer")?.producer.model, "model-native");
    assert.equal(events.find(e => c(e).id === "answer")?.actor.type, "agent");
    assert.equal(events.find(e => c(e).id === "answer")?.stream?.parent, "droid:fork-parent");
    assert.equal(events.find(e => c(e).id === "compact")?.kind, "context_injection");
    assert.equal(c(events.find(e => c(e).id === "compact")!).blocks[0].text, "summary");
    assert.deepEqual(events.find(e => c(e).state_type === "session_settings")?.raw?.data, settings);
    assert.equal((await captureDroidTranscript(f.path, f.repo.root)).appended, 0);
    settings.model = "updated"; await writeFile(join(f.directory, "droid-fixture.settings.json"), JSON.stringify(settings));
    assert.equal((await captureDroidTranscript(f.path, f.repo.root)).appended, 1);
  } finally { await f.cleanup(); }
});
test("droid serialized user roles distinguish humans, tool results, system context, notices, hooks and delegated prompts", async () => {
  const f = await fixture([
    msg("context-user", "user", [{ type: "text", text: "system reminder" }], { visibility: "llm_only" }),
    msg("notice", "user", "notice", { visibility: "user_only" }),
    msg("prompt", "user", "human"),
    msg("tool", "user", [{ type: "tool_result", tool_use_id: "call", content: "result", is_error: false }]),
    msg("hook", "user", [], { hookEventName: "Stop", hookStatus: "completed", hookResults: [{ exitCode: 0, stdout: "", stderr: "" }], hookParentId: "answer", hookOrder: 1 }),
    msg("auto", "user", "automated", { userMessageSource: "automation" }),
  ]);
  try {
    await captureDroidTranscript(f.path, f.repo.root); const events = await readEvents(f.repo);
    assert.equal(events.filter(e => e.actor.type === "human").length, 1);
    assert.equal(events.find(e => c(e).id === "hook")?.kind, "activity");
    assert.equal(events.find(e => c(e).id === "tool")?.actor.type, "system");
    assert.equal(c(events.find(e => c(e).id === "tool")!).blocks[0].content[0].text, "result");
    await writeFile(f.path, [JSON.stringify({ ...f.header, callingSessionId: "parent-agent", callingToolUseId: "Task-id" }), JSON.stringify(msg("delegation", "user", "do task"))].join("\n") + "\n");
    await captureDroidTranscript(f.path, f.repo.root);
    const delegated = (await readEvents(f.repo)).find(e => c(e).id === "delegation")!;
    assert.equal(delegated.kind, "context_injection"); assert.equal(delegated.stream?.parent, "droid:parent-agent");
  } finally { await f.cleanup(); }
});
test("droid seven native blocks preserve replay fields and replace binary bodies with references", async () => {
  const f = await fixture([msg("all", "assistant", [
    { type: "text", text: "answer" }, { type: "thinking", thinking: "reasoning", signature: "ordinary-signature", signatureProvider: "google", durationMs: 4 },
    { type: "redacted_thinking", data: "provider-encrypted" },
    { type: "tool_use", id: "tool1", name: "Read", input: { file_path: "file" }, thought_signature: "native-signature", namespace: "native", script_execution: { run_id: "run", outer_tool_use_id: "outer" } },
    { type: "tool_result", tool_use_id: "tool1", content: [{ type: "text", text: "output" }] },
    { type: "image", source: { type: "base64", data: "AQID", media_type: "image/png" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "", parsed_data: "extracted", name: "paper.pdf", path: "/native/paper.pdf" } },
    { type: "document", source: { type: "text", media_type: "text/plain", data: "plain attachment", name: "note.txt" } },
  ])]);
  try {
    assert.deepEqual((await captureDroidTranscript(f.path, f.repo.root)).unrecognized, {});
    const e = (await readEvents(f.repo)).find(e => e.kind === "conversation_turn")!, b = c(e).blocks;
    assert.equal(b[1].text, "reasoning"); assert.equal(b[3].script_execution.run_id, "run");
    assert.equal(b[5].source.data.type, "attachment_reference"); assert.equal(b[5].source.data.media_type, "image/png");
    assert.equal(b[6].source.parsed_data, "extracted");
    assert.ok(JSON.stringify(e).includes("plain attachment"));
    assert.ok(!JSON.stringify(e).includes("AQID"));
  } finally { await f.cleanup(); }
});
test("droid encrypted siblings survive redaction exactly and replay reproduces both identities", async () => {
  const secret = "DROID_TESTONLY_SECRET";
  const native = msg("sealed", "assistant", [{ type: "thinking", thinking: secret, signature: secret }, { type: "redacted_thinking", data: `cipher-${secret}` }], { openaiEncryptedContent: `openai-${secret}`, openaiReasoningSummary: secret, openaiReasoningId: "r1" });
  const f = await fixture([native]);
  try {
    await writeFile(join(f.repo.root, ".cledger.json"), JSON.stringify({ redact: { patterns: [{ id: "fixture", pattern: secret }] } }));
    await captureDroidTranscript(f.path, f.repo.root); const events = await readEvents(f.repo), sealed = events.find(e => e.kind === "reasoning")!;
    assert.deepEqual((sealed.raw!.data as any).signatures.map((s: any) => s.encrypted_content), [`openai-${secret}`, `cipher-${secret}`]);
    assert.ok(!JSON.stringify(events.filter(e => e.kind !== "reasoning")).includes(secret));
    assert.equal((await captureDroidTranscript(f.path, f.repo.root)).appended, 0);
    // Replay without secret redaction is compared separately; append applies policy.
    const source = events.find(e => e.kind === "conversation_turn")!;
    const replay = renormalizeUnrecognizedMany({ ...source, raw: { format: "droid-session-jsonl/1", data: native } }, await gitUserIdentity(f.repo));
    assert.equal(replay?.length, 2); assert.equal(eventId(replay![1]!), sealed.id);
  } finally { await f.cleanup(); }
});
test("droid drift, torn writes and same-size native rewrites remain lossless and idempotent", async () => {
  const f = await fixture([msg("future-role", "future", "payload"), { type: "new-native-record", data: "payload" }, msg("blocks", "assistant", [{ type: "future", data: "kept" }, 7])]);
  try {
    await appendFile(f.path, 'broken\n{"type":');
    const first = await captureDroidTranscript(f.path, f.repo.root); assert.equal(Object.keys(first.unrecognized).length, 5);
    await appendFile(f.path, '"todo_state","id":"late","todos":[]}\n'); assert.equal((await captureDroidTranscript(f.path, f.repo.root)).appended, 1);
    await f.write([msg("same", "user", "before")]); await captureDroidTranscript(f.path, f.repo.root);
    await f.write([msg("same", "user", "change")]); assert.equal((await captureDroidTranscript(f.path, f.repo.root)).appended, 1);
    assert.equal((await captureDroidTranscript(f.path, f.repo.root)).appended, 0);
  } finally { await f.cleanup(); }
});
test("droid backfill handles exact project, legacy and btw storage without symlinks or foreign cwd", async () => {
  const f = await fixture([msg("human", "user", "prompt")]);
  try {
    const scoped = (id: string) => JSON.stringify({ ...f.header, id }) + "\n";
    await writeFile(join(f.sessions, "legacy.jsonl"), scoped("legacy"));
    await mkdir(join(f.sessions, "btw")); await writeFile(join(f.sessions, "btw", "side.jsonl"), scoped("side"));
    await writeFile(join(f.directory, "foreign.jsonl"), JSON.stringify({ ...f.header, cwd: "/other/project" }) + "\n");
    await symlink(f.path, join(f.directory, "linked.jsonl"));
    assert.equal((await captureDroidAll(f.repo.root, 0, f.sessions)).appended, 0);
    assert.equal((await captureDroidAll(f.repo.root, undefined, f.sessions)).appended, 4);
    assert.equal((await captureDroidAll(f.repo.root, undefined, f.sessions)).appended, 0);
    await assert.rejects(captureDroidAll(f.repo.root, -1, f.sessions));
    await runDroidHook("not json");
  } finally { await f.cleanup(); }
});

test("droid sealed reasoning revisions with the same native message id get distinct identities", async () => {
  const native=msg("sealed-revision","assistant",[{type:"text",text:"visible"}],{openaiEncryptedContent:"cipher-one"});
  const f=await fixture([native]);
  try {
    await captureDroidTranscript(f.path,f.repo.root);
    (native.message as any).openaiEncryptedContent="cipher-two";
    await f.write([native]);
    assert.equal((await captureDroidTranscript(f.path,f.repo.root)).appended,1);
    assert.equal((await readEvents(f.repo)).filter(e=>e.kind==="reasoning").length,2);
    assert.equal((await captureDroidTranscript(f.path,f.repo.root)).appended,0);
  } finally { await f.cleanup(); }
});

test("droid nested content drift persists as a sibling and fails native certification",async()=>{
 const f=await fixture([msg("future","assistant",[{type:"future_native",payload:"keep"}])]);
 try{await captureDroidTranscript(f.path,f.repo.root);const events=await readEvents(f.repo),unknown=events.find(e=>e.kind==="unrecognized")!;
 assert.ok(unknown);assert.equal(droidEvidenceGates(events,"marker","secret").noUnrecognizedRecords,false);
 assert.equal(renormalizeUnrecognizedMany(unknown,await gitUserIdentity(f.repo)),null);
 assert.equal((await captureDroidTranscript(f.path,f.repo.root)).appended,0);
 }finally{await f.cleanup();}
});
