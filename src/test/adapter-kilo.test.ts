import { kiloEvidenceGates } from "../verification/kilo.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureKiloExport, renormalizeUnrecognized, type KiloExport } from "../adapters/kilo.js";
import { readEvents } from "../store.js";
import { eventId, type EvidenceEvent } from "../schema.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const time = 1785583070532;
const info = { id: "msg_native", role: "assistant", modelID: "native-model", providerID: "native-provider", time: { created: time } };
function fixture(parts: Record<string, unknown>[]): KiloExport {
  return { info: { id: "ses_fixture", title: "Fixture", version: "7.8.1", time: { created: time } },
    messages: [{ info, parts: parts.map((part, index) => ({ id: `prt_${String(index + 1).padStart(12, "0")}fixture`, ...part })) }] };
}
const partEvents = (events: EvidenceEvent[]) => events.filter(event => (event.raw?.data as any)?.part);

test("Kilo 7.8.1 complete 12-part inventory retains fork-specific fields and replay identity", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    // Official schema: Kilo-Org/kilocode@88681cac packages/schema/src/v1/session.ts.
    const parts = [
      { type: "text", text: "" }, { type: "reasoning", text: "Reason", metadata: { signature: "ordinary-signature" } },
      { type: "tool", tool: "todowrite", callID: "call-native", state: { status: "completed", input: { todos: [] }, output: "done", metadata: { todos: [] }, attachments: [{ type: "file", mime: "text/plain", url: "file:///fixture.txt" }] } },
      { type: "step-start", snapshot: "before" },
      { type: "step-finish", reason: "stop", tokens: { input: 1 }, model: { modelID: "step-model", providerID: "step-provider" }, generationID: "generation", vercelID: "vercel", metrics: { prompt: 1, generation: 2, source: "provider" }, time: { start: time, end: time + 2, elapsed: 2 } },
      { type: "snapshot", snapshot: "native-ref" }, { type: "patch", hash: "git-ref", files: ["file.ts"] },
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=", source: { type: "resource", clientName: "docs", uri: "doc://fixture", text: { value: "reference", start: 0, end: 9 } } },
      { type: "agent", name: "explore", source: { value: "@explore", start: 0, end: 8 } },
      { type: "subtask", prompt: "Inspect", agent: "explore", description: "inspect", variant: "high", model: { modelID: "child", providerID: "provider" } },
      { type: "retry", attempt: 2, error: { name: "APIError", data: { message: "retry" } } },
      { type: "compaction", auto: true, overflow: true, tail_start_id: "msg-retained" },
    ];
    const data = fixture(parts), result = await captureKiloExport(data, repo.root);
    assert.equal(result.appended, 13); assert.deepEqual(result.unrecognized, {});
    const events = partEvents(await readEvents(repo)).sort((a, b) => a.stream!.seq - b.stream!.seq);
    assert.deepEqual(events.map(e => e.kind), ["conversation_turn", "conversation_turn", "conversation_turn", "activity", "activity", "file_snapshot", "activity", "context_injection", "context_injection", "activity", "activity", "session_state"]);
    assert.equal(events[4]!.producer.model, "step-model");
    assert.equal((events[4]!.content as any).generationID, "generation");
    assert.equal((events[9]!.content as any).variant, "high");
    for (const event of events) {
      assert.equal(event.producer.source, "kilo"); assert.equal(event.producer.source_version, "7.8.1");
      const upgraded = renormalizeUnrecognized({ ...event, kind: "unrecognized" }, { name: "Test User", email: "test@example.com" });
      assert.ok(upgraded); assert.equal(eventId(upgraded), event.id);
    }
    assert.equal((await captureKiloExport(data, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Kilo captures mutable revisions and preserves native identity across deletions", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const data = fixture([{ type: "text", text: "first" }, { type: "text", text: "second" }]);
    await captureKiloExport(data, repo.root);
    data.messages![0]!.parts!.shift();
    assert.equal((await captureKiloExport(data, repo.root)).appended, 0);
    data.messages![0]!.parts![0]!.text = "changed in place";
    assert.equal((await captureKiloExport(data, repo.root)).appended, 1);
    data.info!.title = "Updated title";
    assert.equal((await captureKiloExport(data, repo.root)).appended, 1);
    assert.equal((await captureKiloExport(data, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Kilo all four tool states preserve activity then linked completed/error results", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const data = fixture([{ type: "tool", tool: "read", callID: "call", state: { status: "pending", input: {}, raw: "{}" } }]);
    await captureKiloExport(data, repo.root);
    for (const state of [{ status: "running", input: {}, time: { start: time } }, { status: "completed", input: {}, output: "value" }, { status: "error", input: {}, error: "failed" }]) {
      data.messages![0]!.parts![0]!.state = state;
      assert.equal((await captureKiloExport(data, repo.root)).appended, 1);
    }
    const events = partEvents(await readEvents(repo));
    assert.equal(events.filter(e => e.kind === "activity").length, 2);
    assert.equal(events.filter(e => e.kind === "conversation_turn").length, 2);
    assert.ok(events.some(e => (e.content as any).blocks?.[1]?.is_error === true));
  } finally { await cleanupRepo(repo); }
});

test("Kilo scopes cwd and distinguishes actual human prompts, synthetic context, delegated child prompts", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const data = fixture([{ type: "text", text: "human" }, { type: "text", text: "context", synthetic: true }]);
    data.info!.directory = repo.root;
    data.messages![0]!.info = { role: "user", id: "msg-user", editorContext: { activeFile: "file.ts" }, time: { created: time } };
    await captureKiloExport(data, repo.root);
    assert.deepEqual(partEvents(await readEvents(repo)).sort((a,b) => a.stream!.seq-b.stream!.seq).map(e => e.actor.type), ["human", "system"]);
    data.info!.id = "child"; data.info!.parentID = "ses_fixture";
    await captureKiloExport(data, repo.root);
    const child = (await readEvents(repo)).filter(e => e.stream?.id === "kilo:child");
    assert.ok(child.every(e => e.stream!.parent === "kilo:ses_fixture"));
    assert.ok(child.every(e => e.actor.type === "system"));
    data.info!.directory = "/unrelated/private/project";
    assert.equal((await captureKiloExport(data, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Kilo malformed known parts and future records remain inspectable without invented turns", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const data = fixture([{ type: "text", text: 123 }, { type: "file", mime: "image/png" }, { type: "tool", state: { status: "new-state" } }, { type: "future", data: { native: true } }]);
    const result = await captureKiloExport(data, repo.root);
    assert.equal(Object.values(result.unrecognized).reduce((a,b)=>a+b,0), 4);
    const events = partEvents(await readEvents(repo));
    assert.ok(events.every(e => e.kind === "unrecognized"));
    assert.equal((await captureKiloExport(data, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Kilo retains empty-message error metadata and malformed envelopes alongside binary references", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "initial");
    const data = fixture([{ type: "file", mime: "image/png", url: "data:image/png;base64,AAEC" }]);
    data.messages!.push({ info: { id: "msg-error", role: "assistant", error: { name: "APIError", data: { message: "unavailable" } } }, parts: [] });
    data.messages!.push({ info: { id: "msg-malformed" }, parts: {} } as any);
    const result = await captureKiloExport(data, repo.root);
    assert.deepEqual(result.unrecognized, { "message/invalid-shape": 1 });
    const events = await readEvents(repo);
    assert.ok(events.some(e => (e.content as any).error?.name === "APIError"));
    const file = partEvents(events)[0]!;
    assert.equal((file.content as any).url.type, "attachment_reference");
    assert.equal((file.content as any).url.size, 3);
    const replay = renormalizeUnrecognized({ ...file, kind: "unrecognized" }, { name: "Test User", email: "test@example.com" });
    assert.ok(replay); assert.equal(eventId(replay), file.id);
    assert.equal((await captureKiloExport(data, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); }
});

test("Kilo unsupported tool attachment variants cannot pass native drift certification",async()=>{
 const repo=await makeTempRepo();try{await makeCommit(repo,"initial");const data=fixture([{type:"tool",tool:"read",callID:"call",state:{status:"completed",input:{},output:"out",attachments:[{type:"future_attachment",data:"keep"}]}}]);
 await captureKiloExport(data,repo.root);const events=await readEvents(repo),unknown=events.find(e=>e.kind==="unrecognized")!;
 assert.ok(unknown);assert.equal(kiloEvidenceGates(events,"marker","secret").noUnrecognizedRecords,false);
 assert.equal(renormalizeUnrecognized(unknown,{name:"Test User",email:"test@example.com"}),null);
 assert.equal((await captureKiloExport(data,repo.root)).appended,0);
 }finally{await cleanupRepo(repo);}
});
