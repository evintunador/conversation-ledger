import { kimiEvidenceGates } from "../verification/kimi.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, lstat, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureKimiAll, captureKimiTranscript, kimiWorkDirKey, runKimiHook, renormalizeUnrecognizedMany, KIMI_TAIL_DIRECTORY } from "../adapters/kimi.js";
import { gitUserIdentity } from "annals";
import { eventId } from "../schema.js";
import { readEvents } from "../store.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";
const at = 1790596800000;
const header = { type: "metadata", protocol_version: "1.5", created_at: at };
const line = (type: string, fields: Record<string, unknown> = {}) => ({ type, time: at, agentId: "main", ...fields });
const loop = (type: string, fields: Record<string, unknown> = {}) => line("context.append_loop_event", { event: { type, ...fields } });
const message = (role: string, content: unknown[], fields: Record<string, unknown> = {}) => line("context.append_message", { message: { role, content, toolCalls: [], ...fields } });
const c = (e: { content: unknown }) => e.content as Record<string, any>;
async function fixture(records: unknown[]) {
  const repo = await makeTempRepo("cledger-kimi-test-"); await makeCommit(repo);
  const home = await mkdtemp(join(tmpdir(), "cledger-kimi-native-"));
  const directory = join(home, "sessions", kimiWorkDirKey(repo.root), "session-fixture");
  await mkdir(join(directory, "agents", "main"), { recursive: true });
  const metadata = { version: 2, id: "session-fixture", cwd: repo.root, createdAt: at, updatedAt: at, agents: { main: { type: "main" }, child: { type: "sub", parentAgentId: "main" } }, forkedFrom: "original-session" };
  await writeFile(join(directory, "state.json"), JSON.stringify(metadata));
  const wire = join(directory, "agents", "main", "wire.jsonl");
  await writeFile(wire, [header, ...records].map(v => JSON.stringify(v)).join("\n") + "\n");
  return { repo, home, directory, wire, metadata, async cleanup() { await rm(home, { recursive: true, force: true }); await cleanupRepo(repo); } };
}
test("kimi captures messages, streamed steps, tools, injections and metadata without actor confusion", async () => {
  const rows = [
    line("profile.bind", { systemPrompt: "system", modelAlias: "alias", environmentDisclosure: { cwd: "/test" } }),
    line("llm.request", { model: "native-model", provider: "native-provider", systemPrompt: "prompt", messageCount: 1 }),
    line("turn.prompt", { input: [{ type: "text", text: "hello" }], origin: "user", promptId: "prompt" }),
    message("user", [{ type: "text", text: "hello" }], { id: "user-id", origin: "user" }),
    message("user", [{ type: "text", text: "hook context" }], { origin: "hook_result" }),
    message("system", [{ type: "text", text: "system" }]),
    loop("step.begin", { uuid: "step1" }),
    loop("content.part", { stepUuid: "step1", uuid: "part1", part: { type: "think", think: "reason" } }),
    loop("tool.call", { stepUuid: "step1", toolCallId: "call1", name: "ReadFile", args: { path: "a" }, extras: { provider: 1 } }),
    loop("tool.result", { toolCallId: "call1", parentUuid: "part1", result: { output: [{ type: "text", text: "result" }], isError: false, durationMs: 10 } }),
    loop("step.end", { uuid: "step1", messageId: "provider-id", usage: { inputTokens: 2 } }),
    message("assistant", [{ type: "text", text: "answer" }], { toolCalls: [{ type: "function", id: "call2", name: "Bash", arguments: '{"command":"pwd"}' }], providerMessageId: "p2" }),
    message("tool", [{ type: "text", text: "out" }], { toolCallId: "call2" }),
    line("context.apply_compaction", { summary: { role: "user", content: [{ type: "text", text: "summary" }] }, count: 8 }),
  ];
  const f = await fixture(rows);
  try {
    const r = await captureKimiTranscript(f.directory, f.repo.root); assert.deepEqual(r.unrecognized, {}); assert.equal(r.appended, rows.length + 2);
    const events = await readEvents(f.repo);
    assert.equal(events.filter(e => e.kind === "conversation_turn" && e.actor?.type === "human").length, 1);
    assert.equal(events.find(e => c(e).origin === "hook_result")?.kind, "context_injection");
    const tool = events.find(e => c(e).event_type === "tool.call")!;
    assert.equal(c(tool).blocks[0].id, "call1"); assert.equal(tool.producer.model, "native-model");
    assert.equal(events.find(e => c(e).event_type === "tool.result")?.actor?.type, "system");
    assert.equal(c(events.find(e => c(e).injection_type === "context.apply_compaction")!).blocks[0].text, "summary");
    assert.equal((await captureKimiTranscript(f.directory, f.repo.root)).appended, 0);
  } finally { await f.cleanup(); }
});
test("kimi native durable inventory preserves every state and operational payload", async () => {
  const types = `config.update context.clear context.undo cron.add cron.cursor cron.delete forked full_compaction.begin full_compaction.cancel full_compaction.complete goal.clear goal.create goal.update interaction.request interaction.resolved interruptionReminder.recorded llm.tools_snapshot mcp.tools_discovered permission.record_approval_result permission.set_mode plan_mode.cancel plan_mode.enter plan_mode.exit plan.revision plugin.session_start prompt.aborted prompt.completed runtime.set_binding subagent.cancelled subagent.completed subagent.failed subagent.spawned subagent.started swarm_mode.enter swarm_mode.exit task.started task.terminated task.waitDelivered token_counting.measured token_counting.rebased token_counting.truncated token_counting.turn_recorded tools.register_user_tool tools.reset_active_tools tools.set_active_tools tools.unregister_user_tool tools.update_store tower_mode.enter tower_mode.exit turn.cancel turn.ended turn.step.interrupted turn.step.retrying usage.record`.split(" ");
  const rows = types.map(type => line(type, { payload: { retained: type }, id: type }));
  const f = await fixture(rows);
  try { const r = await captureKimiTranscript(f.directory, f.repo.root); assert.deepEqual(r.unrecognized, {}); const events = await readEvents(f.repo); for (const row of rows) assert.deepEqual(events.find(e => c(e).id === row.type)?.raw?.data, row); }
  finally { await f.cleanup(); }
});
test("kimi separates explicitly encrypted thinking while preserving native paths and redacting plaintext", async () => {
  const secret = "KIMI_FIXTURE_SECRET";
  const f = await fixture([loop("content.part", { part: { type: "think", think: secret, encrypted: `cipher-${secret}`, hidden: true, reasoningKey: "native" } })]);
  try {
    await writeFile(join(f.repo.root, ".cledger.json"), JSON.stringify({ redact: { patterns: [{ id: "fixture", pattern: secret }] } }));
    await captureKimiTranscript(f.directory, f.repo.root);
    const events = await readEvents(f.repo), sealed = events.find(e => e.kind === "reasoning")!;
    assert.equal((sealed.raw!.data as any).signatures[0].encrypted_content, `cipher-${secret}`);
    assert.deepEqual((sealed.raw!.data as any).signatures[0].path, ["event", "part", "encrypted"]);
    assert.ok(!JSON.stringify(events.filter(e => e.kind !== "reasoning")).includes(secret));
    assert.equal((await captureKimiTranscript(f.directory, f.repo.root)).appended, 0);
  } finally { await f.cleanup(); }
});
test("kimi preserves unknown nested data, malformed complete lines and retries torn writes", async () => {
  const f = await fixture([line("future.event", { data: "retained" }), loop("future.loop", { payload: 1 }), message("assistant", [{ type: "future_content", data: 2 }])]);
  try {
    await appendFile(f.wire, 'broken\n{"type":');
    const first = await captureKimiTranscript(f.directory, f.repo.root); assert.equal(Object.keys(first.unrecognized).length, 4);
    await appendFile(f.wire, '"usage.record","time":1790596800000,"usage":{"input":1}}\n');
    assert.equal((await captureKimiTranscript(f.directory, f.repo.root)).appended, 1);
  } finally { await f.cleanup(); }
});
test("kimi child streams and branch switches retain lineage without leaking abandoned model", async () => {
  const f = await fixture([line("llm.request", { model: "original", provider: "a" }), line("llm.request", { model: "abandoned", provider: "b" }), line("agent.switched", { branch: "b1", base: { branch: "main", line: 2 } }), loop("content.part", { part: { type: "text", text: "branch reply" } })]);
  try {
    await mkdir(join(f.directory, "agents", "child"));
    await writeFile(join(f.directory, "agents", "child", "wire.jsonl"), [header, message("assistant", [{ type: "text", text: "child" }])].map(v => JSON.stringify(v)).join("\n") + "\n");
    await captureKimiTranscript(f.directory, f.repo.root);
    const events = await readEvents(f.repo), child = events.find(e => c(e).native_agent_id === "child" && e.kind === "conversation_turn")!;
    assert.equal(child.stream?.parent, "kimi:session-fixture:main");
    const branch = events.find(e => c(e).native_branch === "b1")!; assert.equal(branch.producer.model, "original"); assert.equal(branch.producer.provider, "a");
  } finally { await f.cleanup(); }
});
test("kimi backfill is exact cwd scoped, bounded, symlink safe, hook path traversal rejected", async () => {
  const f = await fixture([message("user", [{ type: "text", text: "scoped" }])]);
  try {
    const wrong = join(f.home, "sessions", kimiWorkDirKey(f.repo.root), "wrong"); await mkdir(wrong); await writeFile(join(wrong, "state.json"), JSON.stringify({ ...f.metadata, cwd: "/another/project" }));
    await symlink(f.directory, join(f.home, "sessions", kimiWorkDirKey(f.repo.root), "linked"));
    assert.equal((await captureKimiAll(f.repo.root, 0, f.home)).appended, 0);
    assert.equal((await captureKimiAll(f.repo.root, undefined, f.home)).appended, 3);
    assert.equal((await captureKimiAll(f.repo.root, undefined, f.home)).appended, 0);
    await assert.rejects(captureKimiAll(f.repo.root, -1, f.home));
    await runKimiHook(JSON.stringify({ cwd: f.repo.root, session_id: "../../private" }));
  } finally { await f.cleanup(); }
});
test("kimi refuses archived Python and unsupported successor protocol rather than inventing semantics", async () => {
  const f = await fixture([]);
  try { await writeFile(f.wire, JSON.stringify({ type: "metadata", protocol_version: "1.10", created_at: at }) + "\n"); await assert.rejects(captureKimiTranscript(f.directory, f.repo.root), /Unsupported/); }
  finally { await f.cleanup(); }
});
test("kimi all native multimedia part kinds preserve references without retaining binary bytes", async () => {
  const nativeParts = [
    { type: "image_url", imageUrl: { url: "data:image/png;base64,AQID", name: "image.png" } },
    { type: "audio_url", audioUrl: { url: "data:audio/wav;base64,BAUG", id: "audio-id" } },
    { type: "video_url", videoUrl: { url: "https://example.invalid/video.mp4", id: "video-id", name: "video.mp4" } },
  ];
  const f = await fixture([
    message("user", nativeParts),
    line("turn.steer", { input: [{ type: "text", text: "steer" }], origin: "user", messageId: "steer-id" }),
    line("prompt.steered", { content: [{ type: "text", text: "merged" }], promptIds: ["p1", "p2"] }),
  ]);
  try {
    const r = await captureKimiTranscript(f.directory, f.repo.root); assert.deepEqual(r.unrecognized, {});
    const event = (await readEvents(f.repo)).find(e => e.kind === "conversation_turn")!;
    assert.equal(c(event).blocks[0].imageUrl.url.type, "attachment_reference");
    assert.equal(c(event).blocks[0].imageUrl.url.media_type, "image/png");
    assert.equal(c(event).blocks[1].audioUrl.url.media_type, "audio/wav");
    assert.deepEqual(c(event).blocks[2], nativeParts[2]);
    assert.ok(!JSON.stringify(event).includes("AQID"));
    assert.ok(!JSON.stringify(event).includes("BAUG"));
  } finally { await f.cleanup(); }
});

test("kimi file versions are snapshots, durable configuration is state, and malformed known structures warn", async () => {
  const backup = { key: "backups/file-v2", version: 2, contentHash: "abc", size: 8, mtimeMs: at };
  const f = await fixture([
    line("file_history.checkpoint", { entries: { "src/a.ts": backup }, turnId: 1, phase: "end" }),
    line("file_history.tracked", { path: "new.ts", entry: { key: null, version: 1 }, turnId: 2 }),
    line("permission.set_mode", { mode: "manual" }), line("goal.create", { objective: "finish", goalId: "goal" }),
    line("turn.ended", { reason: "completed", turnId: 1 }),
    line("file_history.tracked", { path: "bad.ts" }),
    line("context.append_message", { message: null }),
    loop("tool.result", { result: null }),
  ]);
  try {
    const r = await captureKimiTranscript(f.directory, f.repo.root); assert.equal(Object.keys(r.unrecognized).length, 3);
    const events = await readEvents(f.repo), snapshots = events.filter(e => e.kind === "file_snapshot");
    assert.equal(snapshots.length, 2); assert.equal(c(snapshots[0]!).files[0].backup_file, backup.key);
    assert.equal(c(snapshots[1]!).files[0].availability, "not_backed_up");
    assert.ok(events.some(e => e.kind === "session_state" && c(e).state_type === "permission.set_mode"));
    assert.ok(events.some(e => e.kind === "session_state" && c(e).state_type === "goal.create"));
    assert.ok(events.some(e => e.kind === "activity" && c(e).activity_type === "turn.ended"));
  } finally { await f.cleanup(); }
});

test("kimi replay emits visible and encrypted siblings with live-capture identities", async () => {
  const native = loop("content.part", { part: { type: "think", think: "visible", encrypted: "native-ciphertext" } });
  const f = await fixture([native]);
  try {
    await captureKimiTranscript(f.directory, f.repo.root);
    const events = await readEvents(f.repo), visible = events.find(e => e.kind === "conversation_turn")!;
    const replay = renormalizeUnrecognizedMany({ ...visible, kind: "unrecognized", raw: { format: "kimi-code-wire-jsonl/1", data: native } }, await gitUserIdentity(f.repo));
    assert.equal(replay?.length, 2);
    assert.deepEqual(replay!.map(eventId).sort(), events.filter(e => e.kind === "conversation_turn" || e.kind === "reasoning").map(e => e.id).sort());
  } finally { await f.cleanup(); }
});
test("kimi native object origins and machine-journal mirrors preserve authorship without duplicate utterances", async () => {
  const prompt = { role: "user", content: [{ type: "text", text: "native prompt" }], toolCalls: [], origin: { kind: "user" } };
  const f = await fixture([
    line("context.append_message", { message: prompt }),
    line("context.append_message", { message: { ...prompt, origin: { kind: "injection", variant: "date_change" } } }),
    line("agent.message.appended", { message: { message: prompt, meta: { source: "input", promptId: "msg1" } }, kind: "event" }),
    line("agent.turn.started", { turnId: 0, kind: "event" }), line("agent.turn.ended", { turnId: 0, outcome: "done", kind: "event" }),
  ]);
  try {
    assert.deepEqual((await captureKimiTranscript(f.directory, f.repo.root)).unrecognized, {});
    const events = await readEvents(f.repo);
    assert.equal(events.filter(e => e.kind === "conversation_turn" && e.actor.type === "human").length, 1);
    assert.ok(events.some(e => e.kind === "context_injection" && c(e).injection_type === "injection"));
    assert.ok(events.some(e => e.kind === "activity" && c(e).activity_type === "agent.message.appended"));
  } finally { await f.cleanup(); }
});

test("kimi Stop schedules one bounded worker that captures post-return tail and exits", async () => {
  const f = await fixture([message("user", [{ type: "text", text: "prompt" }])]);
  const prior = process.env.KIMI_CODE_HOME; process.env.KIMI_CODE_HOME = f.home;
  try {
    const payload = JSON.stringify({ hook_event_name: "Stop", cwd: f.repo.root, session_id: "session-fixture" });
    await runKimiHook(payload);
    const workerDir = join(f.repo.commonDir, KIMI_TAIL_DIRECTORY);
    const locks = (await readdir(workerDir)).filter(n => n.endsWith(".lock"));
    assert.equal(locks.length, 1);
    const owner = JSON.parse(await readFile(join(workerDir, locks[0]!, "owner.json"), "utf8"));
    await Promise.all([runKimiHook(payload), captureKimiTranscript(f.directory, f.repo.root)]);
    assert.equal(JSON.parse(await readFile(join(workerDir, locks[0]!, "owner.json"), "utf8")).pid, owner.pid);
    await appendFile(f.wire, JSON.stringify(line("prompt.completed", { promptId: "late", reason: "completed" })) + "\n");
    const deadline = Date.now() + 12_000;
    let done = false;
    while (Date.now() < deadline) {
      const names = await readdir(workerDir);
      if (names.some(n => n.endsWith(".json")) && !names.some(n => n.endsWith(".lock"))) {
        try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") { done = true; break; } }
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.ok(done, "tail worker must complete and exit within deadline");
    for (const name of (await readdir(workerDir)).filter(n => n.endsWith(".json") || n.endsWith(".log"))) {
      assert.equal((await lstat(join(workerDir, name))).mode & 0o777, 0o600);
    }
    assert.ok((await readEvents(f.repo)).some(e => c(e).promptId === "late"));
    assert.equal((await captureKimiTranscript(f.directory, f.repo.root)).appended, 0);
  } finally {
    if (prior === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prior;
    await f.cleanup();
  }
});

test("kimi tail reports incomplete when native writes never settle within its bounded window", async () => {
  const f = await fixture([]), prior = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = f.home;
  let writer: ReturnType<typeof setInterval> | undefined;
  try {
    await runKimiHook(JSON.stringify({ hook_event_name: "Stop", cwd: f.repo.root, session_id: "session-fixture" }));
    let sequence = 0;
    writer = setInterval(() => { void appendFile(f.wire, JSON.stringify(line("usage.record", { sequence: sequence++ })) + "\n"); }, 100);
    const workerDir = join(f.repo.commonDir, KIMI_TAIL_DIRECTORY), deadline = Date.now() + 12_000;
    let status: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const names = await readdir(workerDir);
      const file = names.find(n => n.endsWith(".json"));
      if (file && !names.some(n => n.endsWith(".lock"))) { status = JSON.parse(await readFile(join(workerDir, file), "utf8")); break; }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.equal(status?.status, "failed");
    assert.match(String(status?.error), /continued changing/);
  } finally {
    if (writer) clearInterval(writer);
    if (prior === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prior;
    await f.cleanup();
  }
});

test("kimi rewritten encrypted wire content at the same position gets a distinct sealed identity",async()=>{
  const native=loop("content.part",{part:{type:"think",think:"visible",encrypted:"cipher-one"}}),f=await fixture([native]);
  try {
    await captureKimiTranscript(f.directory,f.repo.root);
    (native as any).event.part.encrypted="cipher-two";
    await writeFile(f.wire,[header,native].map(v=>JSON.stringify(v)).join("\n")+"\n");
    assert.equal((await captureKimiTranscript(f.directory,f.repo.root)).appended,1);
    assert.equal((await readEvents(f.repo)).filter(e=>e.kind==="reasoning").length,2);
    assert.equal((await captureKimiTranscript(f.directory,f.repo.root)).appended,0);
  } finally { await f.cleanup(); }
});

test("kimi nested content drift persists as a sibling and fails native certification",async()=>{
 const f=await fixture([message("assistant",[{type:"future_native",payload:"keep"}])]);
 try{await captureKimiTranscript(f.directory,f.repo.root);const events=await readEvents(f.repo),unknown=events.find(e=>e.kind==="unrecognized")!;
 assert.ok(unknown);assert.equal(kimiEvidenceGates(events,"marker","secret").noUnrecognizedRecords,false);
 assert.equal(renormalizeUnrecognizedMany(unknown,await gitUserIdentity(f.repo)),null);
 assert.equal((await captureKimiTranscript(f.directory,f.repo.root)).appended,0);
 }finally{await f.cleanup();}
});
