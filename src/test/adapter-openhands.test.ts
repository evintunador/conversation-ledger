import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOpenHandsSession, captureOpenHandsAll, renormalizeUnrecognizedMany } from "../adapters/openhands.js";
import { readEvents } from "../store.js";
import { eventId } from "../schema.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";
const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", timestamp = "2026-09-29T00:00:00Z";
const event = (kind: string, fields: Record<string, unknown> = {}) => ({ kind, id: `aaaaaaaa-bbbb-cccc-dddd-${kind}`, timestamp, source: "environment", ...fields });
async function fixture(root: string, cwd: string, values: unknown[], session = id): Promise<string> {
  const dir = join(root, session); await mkdir(join(dir, "events"), { recursive: true });
  await writeFile(join(dir, "base_state.json"), JSON.stringify({ id: session, workspace: { working_dir: cwd }, execution_status: "finished", agent: { llm: { api_key: "FAKE_TESTONLY_CONFIGURATION" } }, secret_registry: { secret_sources: { test: "FAKE_TESTONLY_SOURCE" } } }));
  for (const [index, value] of values.entries()) await writeFile(join(dir, "events", `event-${String(index).padStart(5,"0")}-aaaaaaaa-${String(index).padStart(8,"0")}.json`), JSON.stringify(value));
  return dir;
}
test("OpenHands normalizes every concrete SDK1.21 event type and preserves source fields", async () => {
  const repo = await makeTempRepo(), root = await mkdtemp(join(tmpdir(), "cledger-openhands-test-"));
  try {
    await makeCommit(repo, "initial");
    const values = [
      event("MessageEvent", { source:"user", llm_message:{ role:"user", content:[{type:"text",text:"hello"}] } }),
      event("ActionEvent", { source:"agent",tool_name:"file_editor",tool_call_id:"call",tool_call:{arguments:'{"command":"view"}'},action:{command:"view"},thought:[{type:"text",text:"Read it"}] }),
      event("ObservationEvent", { tool_name:"file_editor",tool_call_id:"call",observation:{kind:"FileEditorObservation",content:[{type:"text",text:"result"}]} }),
      event("UserRejectObservation", { tool_name:"terminal",tool_call_id:"reject",rejection_reason:"declined",rejection_source:"user" }),
      event("AgentErrorEvent", { source:"agent",tool_name:"terminal",tool_call_id:"bad",error:"invalid action" }),
      event("SystemPromptEvent", { source:"agent",system_prompt:{type:"text",text:"Instructions"},dynamic_context:{type:"text",text:"Context"} }),
      event("Condensation", { forgotten_event_ids:["old"],summary:"Earlier work" }), event("CondensationSummaryEvent", {summary:"Summary"}),
      event("ConversationStateUpdateEvent", {key:"execution_status",value:"finished"}),
      event("StreamingDeltaEvent", {source:"agent",content:"partial",reasoning_content:"visible thought"}),
      event("ACPToolCallEvent", {source:"agent",tool_call_id:"acp",title:"Read a file",raw_input:{path:"file"},raw_output:"read",status:"completed"}),
      event("TokenEvent", {source:"agent",prompt_token_ids:[1],response_token_ids:[2]}), event("PauseEvent",{source:"user"}),
      event("CondensationRequest"), event("HookExecutionEvent",{source:"hook",hook_event_type:"SessionEnd",hook_command:"cledger hook openhands",success:true}),
      event("LLMCompletionLogEvent",{filename:"log.json",log_data:'{"text":"log"}',model_name:"resolved-model",usage_id:"usage"}), event("ConversationErrorEvent",{code:"failure",detail:"Oops"}),
    ];
    const dir = await fixture(root, repo.root, values), result = await captureOpenHandsSession(dir, repo.root);
    assert.deepEqual(result.unrecognized, {}); assert.equal(result.appended, values.length + 1);
    const events = await readEvents(repo);
    assert.equal(events.find(e => (e.content as {kind?:string}).kind === "MessageEvent")!.actor.type,"human");
    assert.equal(events.find(e => (e.content as {kind?:string}).kind === "AgentErrorEvent")!.actor.type,"system");
    assert.doesNotMatch(JSON.stringify(events), /FAKE_TESTONLY_CONFIGURATION|FAKE_TESTONLY_SOURCE/);
    for (const raw of values) {
      const expected = raw.kind === "LLMCompletionLogEvent" ? { ...raw, log_data: { text: "log" }, cledger_log_data_encoding: "decoded-json-string" } : raw;
      assert.deepEqual(events.find(e => (e.raw?.data as { id?: string })?.id === raw.id)!.raw!.data, expected);
    }
    assert.equal((await captureOpenHandsSession(dir,repo.root)).appended,0);
    const prior = events.filter(e=>e.stream!.seq>1).map(e=>e.id).sort();
    await rm(join(dir,"events","event-00000-aaaaaaaa-00000000.json"));
    assert.equal((await captureOpenHandsSession(dir,repo.root)).appended,0);
    assert.deepEqual((await readEvents(repo)).filter(e=>e.stream!.seq>1).map(e=>e.id).sort(),prior);
  } finally { await cleanupRepo(repo); await cleanupDir(root); }
});
test("OpenHands seals only encrypted reasoning, retains drift and conservative source attribution", async () => {
  const repo = await makeTempRepo(), root = await mkdtemp(join(tmpdir(),"cledger-openhands-seal-"));
  try {
    await makeCommit(repo,"initial");
    const native = event("MessageEvent", {source:"agent",llm_message:{role:"assistant",content:[{type:"text",text:"answer"}],reasoning_content:"Visible reasoning",thinking_blocks:[{type:"thinking",thinking:"Visible signed",signature:"signature"},{type:"redacted_thinking",data:"ciphertext"}],responses_reasoning_item:{encrypted_content:"second ciphertext",summary:[{text:"Visible summary"}]}}});
    const dir = await fixture(root,repo.root,[native,event("MessageEvent",{source:"user",sender:"delegate",llm_message:{role:"user",content:[{type:"text",text:"task"}]}}),event("NewFutureEvent",{data:"preserved"}),event("MessageEvent",{source:"user",llm_message:{role:"user",content:[{type:"new_block",data:"preserved"}]}})]);
    const result = await captureOpenHandsSession(dir,repo.root); assert.equal(result.unrecognized.NewFutureEvent,1); assert.equal(result.unrecognized.MessageEvent,1);
    const events = await readEvents(repo), visible = events.find(e=>e.stream!.seq===1&&e.kind!=="reasoning")!, sealed = events.find(e=>e.kind==="reasoning")!;
    assert.doesNotMatch(JSON.stringify(visible),/ciphertext/); assert.match(JSON.stringify(sealed),/second ciphertext/);
    assert.match(JSON.stringify(visible),/Visible signed|Visible summary/);
    assert.equal(events.find(e=>e.stream!.seq===2)!.actor.type,"system");
    const upgraded=renormalizeUnrecognizedMany({...visible,raw:{format:visible.raw!.format,data:native}}, {name:"Test User",email:"test@example.com"});
    assert.deepEqual(upgraded!.map(eventId).sort(),[visible.id,sealed.id].sort());
    assert.equal((await captureOpenHandsSession(dir,repo.root)).appended,0);
  } finally { await cleanupRepo(repo); await cleanupDir(root); }
});
test("OpenHands backfill scopes native cwd, follows native subagent directories and rejects torn files",async()=>{
  const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-openhands-scope-"));
  try {
    await makeCommit(repo,"initial");
    const parent=await fixture(root,repo.root,[]);
    const child=await fixture(join(parent,"subagents"),"/different-workspace",[event("MessageEvent",{source:"user",llm_message:{role:"user",content:[{type:"text",text:"delegated"}]}})],"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await fixture(root,"/another-project",[],"cccccccccccccccccccccccccccccccc");
    const result=await captureOpenHandsAll(repo.root,root);assert.equal(result.appended,3);
    const events=await readEvents(repo),message=events.find(e=>e.kind==="conversation_turn")!;
    assert.equal(message.actor.type,"system");assert.equal(message.stream!.parent,`openhands:${id}`);
    const path=join(child,"events","event-00001-aaaaaaaa-00000001.json");await writeFile(path,'{"kind":');
    await assert.rejects(captureOpenHandsAll(repo.root,root),SyntaxError);
    await writeFile(path,JSON.stringify(event("PauseEvent",{source:"user"})));assert.equal((await captureOpenHandsAll(repo.root,root)).appended,1);
  }finally{await cleanupRepo(repo);await cleanupDir(root);}
});

test("OpenHands declared completion log JSON preserves structure, seals provider reasoning and strips binary payloads", async () => {
  const repo = await makeTempRepo(), root = await mkdtemp(join(tmpdir(), "cledger-openhands-log-"));
  try {
    await makeCommit(repo, "initial");
    const payload = {
      messages: [{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,iVBORw0KGgo="}}]}],
      input: [{type:"reasoning",encrypted_content:"opaque-request",summary:[{text:"Visible summary"}]}],
      response: {output:[{type:"reasoning",encrypted_content:"opaque-response",summary:[{text:"Visible reply summary"}]}]},
      raw_response: {choices:[{message:{role:"assistant",thinking_blocks:[{type:"redacted_thinking",data:"opaque-thinking"},{type:"thinking",thinking:"Visible thinking",signature:"signed-visible"}]}}]},
      kwargs: {api_key:"FAKE_TESTONLY_LOG_KEY"}, arbitrary: {encrypted_content:"ordinary metadata stays visible"},
    };
    const native = event("LLMCompletionLogEvent", {log_data:JSON.stringify(payload),filename:"log.json",model_name:"model",usage_id:"usage"});
    const dir=await fixture(root,repo.root,[native,event("LLMCompletionLogEvent",{id:"malformed",log_data:'{"unfinished":'})]);
    const result=await captureOpenHandsSession(dir,repo.root);assert.equal(result.unrecognized.LLMCompletionLogEvent,1);
    const events=await readEvents(repo), visible=events.find(e=>e.stream!.seq===1&&e.kind!=="reasoning")!,sealed=events.find(e=>e.kind==="reasoning")!;
    assert.match(visible.raw!.format,/decoded-log-data/);
    assert.doesNotMatch(JSON.stringify(events),/iVBORw0KGgo=|FAKE_TESTONLY_LOG_KEY/);
    assert.doesNotMatch(JSON.stringify(visible),/opaque-request|opaque-response|opaque-thinking/);
    assert.match(JSON.stringify(visible),/Visible reply summary|Visible thinking|ordinary metadata stays visible/);
    assert.match(JSON.stringify(sealed),/opaque-request/);assert.match(JSON.stringify(sealed),/opaque-response/);assert.match(JSON.stringify(sealed),/opaque-thinking/);
    assert.equal((await captureOpenHandsSession(dir,repo.root)).appended,0);
  }finally{await cleanupRepo(repo);await cleanupDir(root);}
});
