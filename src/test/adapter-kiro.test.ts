import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureKiroAll, captureKiroTranscript, captureKiroV3All } from "../adapters/kiro.js";
import { readEvents } from "../store.js";
import { installKiro } from "../install.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const id = "c9788a6b-32a6-4d23-a4b2-1bc0a9704f51";
const content = (e: { content: unknown }) => e.content as Record<string, any>;
test("kiro native v2 prompt, thinking, tool use/result and answer remain linked without binary bytes", async () => {
  const repo = await makeTempRepo("cledger-kiro-test-"); await makeCommit(repo);
  const root = await mkdtemp(join(tmpdir(), "cledger-kiro-sessions-"));
  try {
    const meta = { session_id: id, cwd: repo.root, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:02Z", title: "TESTONLY fixture", session_state: { private_repeat: "MUST_NOT_BE_COPIED" } };
    await writeFile(join(root, `${id}.json`), JSON.stringify(meta));
    const records = [
      { version: "v1", kind: "Prompt", data: { message_id: "u1", content: [{ kind: "text", data: "TESTONLY read evidence.txt" }], meta: { timestamp: 1790812800 } } },
      { version: "v1", kind: "AssistantMessage", data: { message_id: "a1", content: [
        { kind: "thinking", data: { text: "", redactedContent: [46, 75, 84, 82] } },
        { kind: "text", data: "" },
        { kind: "toolUse", data: { toolUseId: "tool1", name: "read", input: { operations: [{ path: "evidence.txt", mode: "Line" }] } } },
      ] } },
      { version: "v1", kind: "ToolResults", data: { message_id: "t1", content: [{ kind: "toolResult", data: { toolUseId: "tool1", status: "success", content: [{ kind: "text", data: "TESTONLY amber comet ledger" }] } }] } },
      { version: "v1", kind: "AssistantMessage", data: { message_id: "a2", content: [{ kind: "text", data: "TESTONLY amber comet ledger" }] } },
    ];
    const path = join(root, `${id}.jsonl`);
    await writeFile(path, records.map(r => JSON.stringify(r)).join("\n") + "\n");
    const result = await captureKiroTranscript(path, repo.root);
    assert.equal(result.appended, 5); assert.deepEqual(result.unrecognized, {});
    const events = (await readEvents(repo)).filter(e => e.producer.source === "kiro");
    assert.equal(events.find(e => e.actor.type === "human")?.kind, "conversation_turn");
    assert.equal(content(events.find(e => content(e).message_id === "a1")!).blocks[2].id, "tool1");
    assert.equal(content(events.find(e => content(e).message_id === "t1")!).blocks[0].tool_use_id, "tool1");
    assert.equal(content(events.find(e => content(e).message_id === "a2")!).blocks[0].text, "TESTONLY amber comet ledger");
    assert.ok(!JSON.stringify(events).includes("MUST_NOT_BE_COPIED"));
    assert.ok(!JSON.stringify(events).includes("[46,75,84,82]"));
    assert.equal((await captureKiroTranscript(path, repo.root)).appended, 0);
    assert.equal((await captureKiroAll(repo.root, undefined, root)).appended, 0);
  } finally { await rm(root, { recursive: true, force: true }); await cleanupRepo(repo); }
});

test("kiro installer writes native V3 hooks while preserving unrelated entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "cledger-kiro-install-"));
  const prior = process.env.KIRO_HOME;
  process.env.KIRO_HOME = home;
  try {
    await mkdir(join(home, "hooks"), { recursive: true });
    const path = join(home, "hooks", "cledger.json");
    await writeFile(path, JSON.stringify({ version: "v1", hooks: [{ name: "other", trigger: "Stop", action: { type: "command", command: "echo TESTONLY" } }] }));
    await installKiro();
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(config.hooks.map((h: { trigger: string }) => h.trigger), ["Stop", "Stop", "SessionEnd"]);
    assert.equal(config.hooks[0].name, "other");
    assert.match(config.hooks[1].action.command, /hook kiro/);
    assert.match(await installKiro(), /already installed/);
  } finally {
    if (prior === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = prior;
    await rm(home, { recursive: true, force: true });
  }
});

test("kiro all-capture scopes to the exact repo and preserves future record types", async () => {
  const repo = await makeTempRepo("cledger-kiro-scope-"); await makeCommit(repo);
  const root = await mkdtemp(join(tmpdir(), "cledger-kiro-scope-files-"));
  try {
    const foreign = "7a9f3420-ff41-4714-8244-692cd34916bf";
    await writeFile(join(root, `${foreign}.json`), JSON.stringify({ session_id: foreign, cwd: "/another/project" }));
    await writeFile(join(root, `${foreign}.jsonl`), JSON.stringify({ version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "MUST_NOT_BE_READ" }] } }) + "\n");
    await writeFile(join(root, `${id}.json`), JSON.stringify({ session_id: id, cwd: repo.root, created_at: "2026-10-01T00:00:00Z" }));
    await writeFile(join(root, `${id}.jsonl`), JSON.stringify({ version: "v1", kind: "FutureState", data: { flag: "TESTONLY" } }) + "\n");
    assert.equal((await captureKiroAll(repo.root, undefined, root)).appended, 2);
    const events = await readEvents(repo);
    assert.ok(events.some(e => e.kind === "unrecognized" && content(e).unrecognized_type === "FutureState"));
    assert.ok(!JSON.stringify(events).includes("MUST_NOT_BE_READ"));
    await assert.rejects(captureKiroAll(repo.root, -1, root));
  } finally { await rm(root, { recursive: true, force: true }); await cleanupRepo(repo); }
});

test("kiro v3 installed-harness records tool linkage, state and image references", async () => {
  const repo = await makeTempRepo("cledger-kiro-v3-"); await makeCommit(repo);
  const root = await mkdtemp(join(tmpdir(), "cledger-kiro-v3-sessions-"));
  try {
    const directory = join(root, "0123456789abcdef", "sess_5e32ea88-85c1-451b-bee3-ee5d79cd8e4b");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ id: "sess_5e32ea88-85c1-451b-bee3-ee5d79cd8e4b", workspacePaths: [repo.root], createdAt: "2026-10-01T00:00:00Z", modelId: "auto" }));
    const records = [
      { id: "u", timestamp: "2026-10-01T00:00:01Z", payload: { type: "user", content: "TESTONLY read fixture", documents: [], images: [{ name: "photo.png", data: "data:image/png;base64,AQID" }] } },
      { id: "call", timestamp: "2026-10-01T00:00:02Z", payload: { type: "tool_call", toolCallId: "tool1", toolName: "read_file", args: { path: "evidence.txt" } } },
      { id: "result", timestamp: "2026-10-01T00:00:03Z", payload: { type: "tool_result", toolCallId: "tool1", success: true, content: "TESTONLY evidence" } },
      { id: "reason", timestamp: "2026-10-01T00:00:04Z", payload: { type: "assistant", operationType: "Reasoning", content: "...", reasoningSignature: "FAKE_TESTONLY_SIGNATURE" } },
      { id: "answer", timestamp: "2026-10-01T00:00:05Z", payload: { type: "assistant", operationType: "Say", content: "TESTONLY evidence" } },
      { id: "usage", timestamp: "2026-10-01T00:00:06Z", payload: { type: "usage_summary", status: "success" } },
    ];
    await writeFile(join(directory, "messages.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
    const first = await captureKiroV3All(repo.root, undefined, root);
    assert.equal(first.appended, 7); assert.deepEqual(first.unrecognized, {});
    const events = (await readEvents(repo)).filter(e => e.producer.source === "kiro");
    assert.equal(content(events.find(e => e.actor.type === "human")!).blocks[1].name, "photo.png");
    assert.equal(content(events.find(e => content(e).blocks?.[0]?.type === "tool_use")!).blocks[0].id, "tool1");
    assert.equal(content(events.find(e => content(e).blocks?.[0]?.type === "tool_result")!).blocks[0].tool_use_id, "tool1");
    assert.ok(events.some(e => e.kind === "reasoning")); assert.ok(events.some(e => e.kind === "activity"));
    assert.ok(!JSON.stringify(events).includes("AQID"));
    assert.ok(!JSON.stringify(events).includes("FAKE_TESTONLY_SIGNATURE"));
    assert.equal((await captureKiroV3All(repo.root, undefined, root)).appended, 0);
  } finally { await rm(root, { recursive: true, force: true }); await cleanupRepo(repo); }
});
