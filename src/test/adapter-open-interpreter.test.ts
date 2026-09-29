import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOpenInterpreterTranscript, captureOpenInterpreterAll, renormalizeUnrecognizedMany, runOpenInterpreterHook } from "../adapters/open-interpreter.js";
import { readEvents } from "../store.js";
import { eventId } from "../schema.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";
const ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",CHILD="bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",STAMP="2026-09-29T00:00:00Z";
const line=(type:string,payload:unknown,ordinal:number)=>({type,payload,ordinal,timestamp:STAMP});
async function fixture(root:string,cwd:string,records:unknown[],id=ID,extra:Record<string,unknown>={},suffix=""):Promise<string>{
  await mkdir(root,{recursive:true});const path=join(root,`rollout-2026-09-29T00-00-00-${id}${suffix}.jsonl`);
  await writeFile(path,[line("session_meta",{id,session_id:ID,cwd,cli_version:"0.0.45",model_provider:"fixture",...extra},0),...records].map(value=>JSON.stringify(value)).join("\n")+"\n");return path;
}
test("Open Interpreter Stop worker captures records appended after the hook returns",async()=>{
 const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-oi-tail-"));try{
  await makeCommit(repo,"initial");
  const path=await fixture(root,repo.root,[line("response_item",{type:"message",role:"user",content:[{type:"input_text",text:"TESTONLY-initial"}]},1)]);
  await runOpenInterpreterHook(JSON.stringify({hook_event_name:"Stop",transcript_path:path,cwd:repo.root}));
  await appendFile(path,JSON.stringify(line("event_msg",{type:"turn_aborted",message:"TESTONLY-late-record"},2))+"\n");
  const directory=join(repo.root,".git","cledger-open-interpreter-tail"),deadline=Date.now()+12_000;
  let complete=false;
  while(Date.now()<deadline){
   const names=await readdir(directory),statuses=names.filter(name=>name.endsWith(".json"));
   if(statuses.length&&!names.some(name=>name.endsWith(".lock"))){
    complete=(await Promise.all(statuses.map(async name=>JSON.parse(await readFile(join(directory,name),"utf8")) as {status:string}))).every(status=>status.status==="complete");
    break;
   }
   await new Promise(done=>setTimeout(done,100));
  }
  assert.ok(complete,"bounded worker must finish successfully");
  assert.ok((await readEvents(repo)).some(event=>JSON.stringify(event.content).includes("TESTONLY-late-record")),"late native record must arrive before manual backfill");
 }finally{await cleanupRepo(repo);await cleanupDir(root);}
});
test("Open Interpreter all native response variants plus twelve rollout kinds preserve structured fields",async()=>{
 const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-oi-types-"));try{
  await makeCommit(repo,"initial");
  const responses=[
   {type:"additional_tools",role:"developer",tools:[]},{type:"message",role:"user",content:[{type:"input_text",text:"hello"},{type:"input_image",image_url:"data:image/png;base64,iVBORw0KGgo="},{type:"input_audio",audio_url:"data:audio/wav;base64,UklGRg=="}]},
   {type:"agent_message",author:"worker",recipient:"main",content:[{type:"input_text",text:"report"},{type:"encrypted_content",encrypted_content:"sealed-agent"}]},
   {type:"reasoning",summary:[{type:"summary_text",text:"summary"}],content:[{type:"reasoning_text",text:"visible reasoning"}],encrypted_content:"sealed-reasoning"},
   {type:"local_shell_call",id:"local",action:{type:"exec",command:["cat","file"]}},
   {type:"function_call",name:"read",call_id:"call",arguments:'{"path":"file"}',encrypted_function_args:["sealed-args"]},
   {type:"tool_search_call",call_id:"search",execution:"client",arguments:{query:"tool"}},
   {type:"function_call_output",call_id:"call",output:[{type:"input_text",text:"result"}]},
   {type:"custom_tool_call",name:"apply_patch",call_id:"custom",input:"patch"},{type:"custom_tool_call_output",call_id:"custom",output:"done"},
   {type:"tool_search_output",call_id:"search",execution:"client",status:"completed",tools:[]},
   {type:"web_search_call",id:"web",status:"completed",action:{type:"search",query:"docs"}},
   {type:"image_generation_call",id:"image",status:"completed",result:"iVBORw0KGgo="},
   {type:"compaction",encrypted_content:"sealed-compaction"},{type:"compaction_summary",encrypted_content:"sealed-alias"},
   {type:"configuration_update",reasoning:{effort:"medium"}},{type:"compaction_trigger"},{type:"context_compaction",encrypted_content:"sealed-context"},{type:"other"},
  ];
  const records=[line("turn_context",{model:"actual-model"},1),...responses.map((p,i)=>line("response_item",p,i+2)),
   line("inter_agent_communication",{author:"worker",recipient:"main",content:"report",encrypted_content:"sealed-communication"},30),
   line("inter_agent_communication_metadata",{trigger_turn:true},31),line("compacted",{message:"summary",replacement_history:[{type:"reasoning",summary:[],encrypted_content:"sealed-history"}]},32),
   line("token_usage_record",{token_usage:{total_tokens:12}},33),line("world_state",{cwd:repo.root},34),line("retained_context",{type:"verified_answer",call_id:"ask",questions:[{question:"Pick",answer:"yes"}]},35),
   line("security_risk_score",{score:"low"},36),line("event_msg",{type:"hook_completed",run:{id:"hook"}},37),line("realtime_item",{id:"voice",realtime_session_id:"voice-session",type:"transcript_segment",role:"assistant",text:"spoken answer"},38)];
  const path=await fixture(root,repo.root,records),result=await captureOpenInterpreterTranscript(path,repo.root);assert.deepEqual(result.unrecognized,{});
  const events=await readEvents(repo);assert.equal(events.filter(e=>e.kind==="reasoning").length,8);
  assert.doesNotMatch(JSON.stringify(events),/iVBORw0KGgo=|UklGRg==/);
  assert.ok(events.every(e=>e.producer.source==="open-interpreter"&&e.producer.source_version==="0.0.45"));
  assert.ok(events.filter(e=>e.kind!=="reasoning").every(e=>!JSON.stringify(e).includes("sealed-")));
  assert.equal(events.find(e=>(e.content as {role?:string}).role==="user")!.actor.type,"human");
  assert.ok(events.some(e=>JSON.stringify(e.content).includes("visible reasoning")));
  assert.equal((await captureOpenInterpreterTranscript(path,repo.root)).appended,0);
 }finally{await cleanupRepo(repo);await cleanupDir(root);}
});
test("Open Interpreter exact EventMsg union and subtype drift never silently disappear",async()=>{
 const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-oi-events-"));try{
  await makeCommit(repo,"initial");
  const kinds:string[]=["error", "warning", "auth_recovery_started", "auth_recovery_completed", "guardian_warning", "realtime_conversation_started", "realtime_conversation_realtime", "realtime_conversation_closed", "realtime_conversation_sdp", "model_reroute", "model_verification", "turn_moderation_metadata", "safety_buffering", "context_compacted", "thread_rolled_back", "turn_started", "thread_settings_applied", "turn_complete", "token_count", "agent_message", "user_message", "agent_reasoning", "agent_reasoning_raw_content", "agent_reasoning_section_break", "session_configured", "environment_connected", "environment_disconnected", "thread_goal_updated", "thread_queue_changed", "mcp_startup_update", "mcp_startup_complete", "mcp_tool_call_begin", "mcp_tool_call_end", "web_search_begin", "web_search_end", "image_generation_begin", "image_generation_end", "exec_command_begin", "exec_command_output_delta", "terminal_interaction", "exec_command_end", "view_image_tool_call", "exec_approval_request", "request_permissions", "request_user_input", "dynamic_tool_call_request", "dynamic_tool_call_response", "elicitation_request", "apply_patch_approval_request", "guardian_assessment", "deprecation_notice", "stream_error", "patch_apply_begin", "patch_apply_updated", "patch_apply_end", "turn_diff", "realtime_conversation_list_voices_response", "plan_update", "turn_aborted", "shutdown_complete", "entered_review_mode", "exited_review_mode", "raw_response_item", "raw_response_completed", "item_started", "item_completed", "hook_started", "hook_completed", "agent_message_content_delta", "plan_delta", "reasoning_content_delta", "reasoning_raw_content_delta", "collab_agent_spawn_begin", "collab_agent_spawn_end", "collab_agent_interaction_begin", "collab_agent_interaction_end", "collab_waiting_begin", "collab_waiting_end", "collab_close_begin", "collab_close_end", "collab_resume_begin", "collab_resume_end", "sub_agent_activity", "task_started", "task_complete"];
  const path=await fixture(root,repo.root,[...kinds.map((type,i)=>line("event_msg",{type,message:`native ${type}`},i+1)),line("event_msg",{type:"future_event",text:"kept"},1000),line("response_item",{type:"message",role:"user",content:[{type:"new_block",text:"kept"}]},1001),line("future_line",{body:"kept"},1002)]);
  const result=await captureOpenInterpreterTranscript(path,repo.root);assert.equal(result.appended,kinds.length+4);assert.equal(Object.values(result.unrecognized).reduce((a,b)=>a+b,0),3);
  assert.equal((await readEvents(repo)).filter(e=>e.kind==="unrecognized").length,3);
 }finally{await cleanupRepo(repo);await cleanupDir(root);}
});
test("Open Interpreter native ordinals, revert streams, subagent attribution and scoped history references remain stable",async()=>{
 const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-oi-lineage-"));try{
  await makeCommit(repo,"initial");
  const prompt=line("response_item",{type:"message",role:"user",content:[{type:"input_text",text:"task"}]},10);
  const path=await fixture(root,repo.root,[prompt]);
  const childPath=await fixture(root,"/child-workspace",[{...prompt,ordinal:20,metadata:{inherited_user_message:true}}],CHILD,{parent_thread_id:ID,history_base:{thread_id:ID,end_ordinal_exclusive:11,end_byte_offset:123}});
  await fixture(root,repo.root,[{...prompt,ordinal:30}],ID,{},"_cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee");
  await fixture(root,"/unrelated",[line("future_line",{private:"unrelated"},1)],"dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee");
  const result=await captureOpenInterpreterAll(repo.root,root);assert.deepEqual(result.unrecognized,{});
  const events=await readEvents(repo),child=events.find(e=>e.producer.session_id===CHILD&&e.kind==="conversation_turn")!;
  assert.equal(child.actor.type,"system");assert.equal(child.stream!.parent,`open-interpreter:${ID}`);assert.equal(child.stream!.seq,20);
  assert.ok(events.some(e=>e.stream!.id.includes(":rollout:")));assert.doesNotMatch(JSON.stringify(events),/unrelated/);
  await appendFile(path,'{"type":"response_item"');assert.equal((await captureOpenInterpreterAll(repo.root,root)).appended,0);
  await appendFile(path,',"timestamp":"2026-09-29T00:00:00Z","ordinal":11,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}\n');
  assert.equal((await captureOpenInterpreterAll(repo.root,root)).appended,1);
  const prior=(await readEvents(repo)).map(e=>e.id).sort();await writeFile(childPath,[line("session_meta",{id:CHILD,session_id:ID,cwd:"/child-workspace",cli_version:"0.0.45",model_provider:"fixture",parent_thread_id:ID,history_base:{thread_id:ID,end_ordinal_exclusive:11,end_byte_offset:123}},0)].map(value=>JSON.stringify(value)).join("\n")+"\n");
  assert.equal((await captureOpenInterpreterAll(repo.root,root)).appended,0);assert.deepEqual((await readEvents(repo)).map(e=>e.id).sort(),prior);
 }finally{await cleanupRepo(repo);await cleanupDir(root);}
});
test("Open Interpreter encrypted siblings survive re-normalization with the original identities",async()=>{
 const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-oi-renorm-"));try{
  await makeCommit(repo,"initial");const native=line("response_item",{type:"agent_message",author:"worker",recipient:"main",content:[{type:"input_text",text:"visible"},{type:"encrypted_content",encrypted_content:"sealed"}]},1);
  const path=await fixture(root,repo.root,[native]);await captureOpenInterpreterTranscript(path,repo.root);const events=(await readEvents(repo)).filter(e=>e.stream!.seq===1),visible=events.find(e=>e.kind!=="reasoning")!;
  const converted=renormalizeUnrecognizedMany({...visible,raw:{format:visible.raw!.format,data:native}},{name:"Test User",email:"test@example.com"});assert.deepEqual(converted!.map(eventId).sort(),events.map(e=>e.id).sort());
 }finally{await cleanupRepo(repo);await cleanupDir(root);}
});

test("Open Interpreter cold zstd rollouts share identities with their uncompressed source",async()=>{
 const repo=await makeTempRepo(),root=await mkdtemp(join(tmpdir(),"cledger-oi-zstd-"));try{
  await makeCommit(repo,"initial");
  const path=join(root,`rollout-2026-09-29T00-00-00-${ID}.jsonl`);
  // Fixed native JSONL compressed with Zstandard, independent of fzstd itself.
  await writeFile(path,"{\"type\":\"session_meta\",\"timestamp\":\"2026-09-29T00:00:00Z\",\"ordinal\":0,\"payload\":{\"id\":\"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\",\"cwd\":\"/fixture\",\"cli_version\":\"0.0.45\"}}\n{\"type\":\"response_item\",\"timestamp\":\"2026-09-29T00:00:00Z\",\"ordinal\":10,\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"compressed native evidence\"}]}}\n");await captureOpenInterpreterTranscript(path,repo.root);
  const prior=(await readEvents(repo)).map(e=>e.id).sort();
  await writeFile(path+".zst",Buffer.from("KLUv/WBnAKUGAIKNKSBQaasDSAiNX/Dt/soHs5vanG5U1SExLCMpWkqKqkH0GoamQWj85c5S8cMVucod2FUfYXvLafFNloHLvIPkdV/31qnVVP3yooJSfQto30yu7kF9NDSNBwQQCIGcHK9IconMLjIBYGH58A9jjJ211jqKoihHOZmlG8lMvYWhoA+UvCiXLD4fNkgIFSSQk0CHAEGIk2FTq2+5Pqz2LXEvVa9OPmSsGwEQACoCiApoah2SBf9ZEICF4lsGLJMvVhY/ldVvmCg0z0BldWBWcPnE1kEB","base64"));await rm(path);
  assert.equal((await captureOpenInterpreterTranscript(path+".zst",repo.root)).appended,0);
  assert.deepEqual((await readEvents(repo)).map(e=>e.id).sort(),prior);
  assert.equal((await captureOpenInterpreterAll(repo.root,root)).appended,0); // native cwd /fixture is excluded, even compressed.
 }finally{await cleanupRepo(repo);await cleanupDir(root);}
});
