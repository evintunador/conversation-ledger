import { crushEvidenceGates } from "../verification/crush.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { captureCrushSnapshot, captureCrushAll, readCrushDatabase, renormalizeUnrecognizedMany, type CrushSnapshot } from "../adapters/crush.js";
import { readEvents } from "../store.js";
import { eventId } from "../schema.js";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";
const exec = promisify(execFile), time = 1785583070;
const session = { id: "session", parent_session_id: null, title: "Native", created_at: time, updated_at: time, prompt_tokens: 5, completion_tokens: 3, cost: 0, todos: '[{"content":"Inspect","status":"completed","active_form":"Inspecting"}]', summary_message_id: "summary" };
const row = (id: string, role: string, parts: unknown[]) => ({ id, session_id: "session", role, parts: JSON.stringify(parts), created_at: time, updated_at: time, model: "native-model", provider: "custom" });
const part = (type: string, data: unknown) => ({ type, data });
const snapshot = (messages: unknown[]): CrushSnapshot => ({ tables: { sessions: [session], messages, files: [], read_files: [], mcp_disabled_servers: [], mcp_enabled_servers: [] } });
test("Crush complete eight native part variants and session/file/read/MCP records retain provenance", async () => {
    const repo = await makeTempRepo();
    try {
        await makeCommit(repo, "initial");
        const parts = [part("text", { text: "Hello" }), part("reasoning", { thinking: "Consider", signature: "signature", thought_signature: "thought", tool_id: "tool" }),
            part("image_url", { url: "https://example.invalid/image.png", detail: "high" }), part("binary", { Path: "/native/image.png", MIMEType: "image/png", Data: "AAEC" }),
            part("tool_call", { id: "call", name: "view", input: '{"file_path":"file.ts"}', provider_executed: false, finished: true }), part("tool_result", { tool_call_id: "call", name: "view", content: "file contents", data: "", mime_type: "", metadata: '{"lines":3}', is_error: false }),
            part("finish", { reason: "end_turn", time, message: "done" }), part("shell_command", { command: "ls", output: "file.ts", exit_code: 0 })];
        const data = snapshot([row("message", "assistant", parts)]);
        data.tables.files = [{ id: "file-version", session_id: "session", path: "file.ts", content: "const x=1;", version: 2, created_at: time }];
        data.tables.read_files = [{ session_id: "session", path: "file.ts", read_at: time }];
        data.tables.mcp_disabled_servers = [{ name: "docs" }];
        const result = await captureCrushSnapshot(data, repo.root);
        assert.deepEqual(result.unrecognized, {});
        assert.equal(result.appended, 12);
        const events = await readEvents(repo), native = events.filter(e => (e.content as any).native_part_index !== undefined).sort((a, b) => (a.content as any).native_part_index - (b.content as any).native_part_index);
        assert.deepEqual(native.map(e => e.kind), ["conversation_turn", "conversation_turn", "conversation_turn", "conversation_turn", "conversation_turn", "conversation_turn", "activity", "activity"]);
        assert.equal(native[5]!.actor.type, "system");
        assert.equal((native[3]!.content as any).blocks[0].source.data.type, "attachment_reference");
        assert.ok(events.some(e => e.kind === "file_snapshot" && (e.content as any).content === "const x=1;"));
        assert.deepEqual((events.find(e => (e.content as any).state_type === "sessions")!.content as any).todos, JSON.parse(session.todos));
        for (const e of native) {
            const upgraded = renormalizeUnrecognizedMany({ ...e, kind: "unrecognized" }, { name: "Test User", email: "test@example.com" });
            assert.ok(upgraded?.length);
            assert.equal(eventId(upgraded![0]!), e.id);
        }
        assert.equal((await captureCrushSnapshot(data, repo.root)).appended, 0);
    }
    finally {
        await cleanupRepo(repo);
    }
});
test("Crush native roles, hidden continuations, summaries and child prompts are distinguished", async () => {
    const repo = await makeTempRepo();
    try {
        await makeCommit(repo, "initial");
        const data = snapshot([
            row("human", "user", [part("text", { text: "Human" })]), row("hidden", "user", [part("text", { text: "continue", hidden: true })]),
            { ...row("summary", "assistant", [part("text", { text: "Summary" })]), is_summary_message: 1 }, row("system", "system", [part("text", { text: "Instructions" })]),
            { ...row("child-msg", "user", [part("text", { text: "Delegation" })]), session_id: "child" }
        ]);
        data.tables.sessions!.push({ ...session, id: "child", parent_session_id: "session" });
        await captureCrushSnapshot(data, repo.root);
        const events = (await readEvents(repo)).filter(e => (e.content as any).native_message_id);
        assert.equal(events.filter(e => e.actor.type === "human").length, 1);
        assert.equal(events.filter(e => e.kind === "context_injection").length, 4);
        assert.ok(events.find(e => e.stream?.id === "crush:child")?.stream?.parent === "crush:session");
    }
    finally {
        await cleanupRepo(repo);
    }
});
test("Crush wrapped Responses ciphertext stays byte-exact in sealed sibling and plaintext is redacted", async () => {
    const repo = await makeTempRepo();
    try {
        await makeCommit(repo, "initial");
        const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890", cipher = `sealed ${secret}`;
        const data = snapshot([row("reason", "assistant", [part("reasoning", { thinking: secret, signature: secret, responses_data: { type: "openai.responses.reasoning_metadata", data: { item_id: "reasoning", encrypted_content: cipher, summary: [] } } })])]);
        await captureCrushSnapshot(data, repo.root);
        const events = await readEvents(repo), sealed = events.find(e => e.kind === "reasoning")!;
        assert.ok(sealed);
        assert.equal((sealed.raw!.data as any).signatures[0].encrypted_content, cipher);
        assert.deepEqual((sealed.raw!.data as any).signatures[0].path, ["parts", 0, "data", "responses_data", "data", "encrypted_content"]);
        const visible = events.find(e => e.kind === "conversation_turn")!;
        assert.ok(!JSON.stringify(visible).includes(secret));
        assert.equal((await captureCrushSnapshot(data, repo.root)).appended, 0);
        const changed = structuredClone(data);
        const m = changed.tables.messages![0] as any;
        const p = JSON.parse(m.parts);
        p[0].data.responses_data.data.encrypted_content += "revision";
        m.parts = JSON.stringify(p);
        assert.equal((await captureCrushSnapshot(changed, repo.root)).appended, 1, "cipher revision gets distinct sealed identity");
    }
    finally {
        await cleanupRepo(repo);
    }
});
test("Crush drift preserves unknown/malformed types and mutable native messages dedup settled records", async () => {
    const repo = await makeTempRepo();
    try {
        await makeCommit(repo, "initial");
        const data = snapshot([row("m", "assistant", [part("future", { native: 1 }), part("text", { text: 123 }), part("text", { text: "stable" })])]);
        data.schema = { future_table: ["id", "possibly_secret"] };
        const first = await captureCrushSnapshot(data, repo.root);
        assert.deepEqual(first.unrecognized, { "part/future": 1, "part/text": 1, "schema/future_table": 1 });
        assert.equal((await captureCrushSnapshot(data, repo.root)).appended, 0);
        const m = data.tables.messages![0] as any, p = JSON.parse(m.parts);
        p[2].data.text = "updated";
        m.parts = JSON.stringify(p);
        const next = await captureCrushSnapshot(data, repo.root);
        assert.equal(next.appended, 3, "unknown raw changes also preserve each whole native message revision");
    }
    finally {
        await cleanupRepo(repo);
    }
});
test("Crush read-only SQLite fixture preserves all columns and bounds default discovery to repo", async () => {
    const repo = await makeTempRepo();
    try {
        await makeCommit(repo, "initial");
        await mkdir(join(repo.root, ".crush"));
        const db = join(repo.root, ".crush", "crush.db");
        await exec("sqlite3", [db, `PRAGMA journal_mode=WAL;CREATE TABLE sessions(id TEXT,created_at INTEGER,updated_at INTEGER,title TEXT);CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,parts TEXT,created_at INTEGER);CREATE TABLE files(id TEXT,session_id TEXT,path TEXT,content TEXT,version INTEGER);CREATE TABLE future_secrets(id TEXT,secret TEXT);INSERT INTO sessions VALUES('s',${time},${time},'title');INSERT INTO messages VALUES('m','s','user','[{"type":"text","data":{"text":"prompt"}}]',${time});INSERT INTO future_secrets VALUES('secret','MUST-NOT-READ');`]);
        const read = await readCrushDatabase(db);
        assert.equal(read.tables.messages!.length, 1);
        assert.equal(read.tables.future_secrets, undefined);
        assert.deepEqual(read.schema!.future_secrets, ["id", "secret"]);
        const result = await captureCrushAll(repo.root);
        assert.equal(result.appended, 3);
        assert.equal(JSON.stringify(await readEvents(repo)).includes("MUST-NOT-READ"), false);
        assert.equal((await captureCrushAll(repo.root)).appended, 0);
    }
    finally {
        await cleanupRepo(repo);
    }
});

test("Crush unknown native content parts cannot pass native drift certification",async()=>{
 const repo=await makeTempRepo();try{await makeCommit(repo,"initial");const data=snapshot([row("future","assistant",[part("future_native",{payload:"keep"})])]);
 await captureCrushSnapshot(data,repo.root);const events=await readEvents(repo);
 assert.equal(crushEvidenceGates(events,"marker","secret").noUnrecognizedRecords,false);
 assert.equal((await captureCrushSnapshot(data,repo.root)).appended,0);
 }finally{await cleanupRepo(repo);}
});

test("Crush file snapshots retain known text only, referencing other native UTF-8 snapshot bodies", async () => {
 const repo=await makeTempRepo(); try {
  await makeCommit(repo,"initial");const data=snapshot([]);
  data.tables.files=[{id:"text",session_id:"session",path:"file.ts",content:"const value = 1;",version:1},
   {id:"binary",session_id:"session",path:"image.png",content:"TESTONLY-native-snapshot-body",version:1},
   {id:"unknown",session_id:"session",path:"custom.unknown",content:"TESTONLY-other-body",version:1}];
  await captureCrushSnapshot(data,repo.root);const events=(await readEvents(repo)).filter(e=>e.kind==="file_snapshot");
  assert.equal(events.length,3);
  const text=events.find(e=>(e.content as any).id==="text")!;assert.equal((text.content as any).content,"const value = 1;");
  for(const e of events.filter(e=>(e.content as any).id!=="text")) {
   const reference=(e.content as any).content;assert.equal(reference.type,"attachment_reference");assert.equal(reference.source_encoding,"native_snapshot_utf8_string");
   assert.equal(typeof reference.sha256,"string");assert.ok(reference.size>0);assert.equal((e.raw!.data as any).row.content.path,reference.path);
   assert.equal(JSON.stringify(e).includes("TESTONLY-"),false);
  }
  assert.equal((await captureCrushSnapshot(data,repo.root)).appended,0);
 } finally { await cleanupRepo(repo); }
});
