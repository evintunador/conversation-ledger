/** Open Interpreter Rust 0.0.45, d9b49c8. Historical Python product excluded.
 * https://github.com/openinterpreter/openinterpreter/blob/rust-v0.0.45/codex-rs/history/src/rollout_payload.rs
 * https://github.com/openinterpreter/openinterpreter/blob/rust-v0.0.45/codex-rs/protocol/src/models.rs
 * Native ordinals and physical rollout identities survive compression/revert.
 */
import { readFile, readdir, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decompress, Decompress } from "fzstd";
import { canonicalJson, findRepo, gitUserIdentity, sha256Hex, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion } from "./common.js";
import { normalizeCodexRolloutRecord } from "./codex.js";
import { countUnrecognized, mergeCaptureResult, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, type RecordContext } from "./records.js";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const SOURCE = "open-interpreter", FORMAT = "open-interpreter-rollout-jsonl/1", EPOCH = "1970-01-01T00:00:00.000Z";
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const canonical = (p: string) => realpath(p).catch(() => resolve(p));
const home = () => process.env.INTERPRETER_HOME || join(homedir(), ".openinterpreter");
const responseTypes = new Set(["additional_tools", "message", "agent_message", "reasoning", "local_shell_call", "function_call", "tool_search_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_output", "web_search_call", "image_generation_call", "compaction", "compaction_summary", "configuration_update", "compaction_trigger", "context_compaction", "other"]);
// Exact serde EventMsg discriminants plus the two documented old-name aliases.
const eventTypes = new Set<string>(["error", "warning", "auth_recovery_started", "auth_recovery_completed", "guardian_warning", "realtime_conversation_started", "realtime_conversation_realtime", "realtime_conversation_closed", "realtime_conversation_sdp", "model_reroute", "model_verification", "turn_moderation_metadata", "safety_buffering", "context_compacted", "thread_rolled_back", "turn_started", "thread_settings_applied", "turn_complete", "token_count", "agent_message", "user_message", "agent_reasoning", "agent_reasoning_raw_content", "agent_reasoning_section_break", "session_configured", "environment_connected", "environment_disconnected", "thread_goal_updated", "thread_queue_changed", "mcp_startup_update", "mcp_startup_complete", "mcp_tool_call_begin", "mcp_tool_call_end", "web_search_begin", "web_search_end", "image_generation_begin", "image_generation_end", "exec_command_begin", "exec_command_output_delta", "terminal_interaction", "exec_command_end", "view_image_tool_call", "exec_approval_request", "request_permissions", "request_user_input", "dynamic_tool_call_request", "dynamic_tool_call_response", "elicitation_request", "apply_patch_approval_request", "guardian_assessment", "deprecation_notice", "stream_error", "patch_apply_begin", "patch_apply_updated", "patch_apply_end", "turn_diff", "realtime_conversation_list_voices_response", "plan_update", "turn_aborted", "shutdown_complete", "entered_review_mode", "exited_review_mode", "raw_response_item", "raw_response_completed", "item_started", "item_completed", "hook_started", "hook_completed", "agent_message_content_delta", "plan_delta", "reasoning_content_delta", "reasoning_raw_content_delta", "collab_agent_spawn_begin", "collab_agent_spawn_end", "collab_agent_interaction_begin", "collab_agent_interaction_end", "collab_waiting_begin", "collab_waiting_end", "collab_close_begin", "collab_close_end", "collab_resume_begin", "collab_resume_end", "sub_agent_activity", "task_started", "task_complete"]);
const lineTypes = new Set(["session_meta", "response_item", "inter_agent_communication", "inter_agent_communication_metadata", "compacted", "turn_context", "token_usage_record", "world_state", "retained_context", "security_risk_score", "event_msg", "realtime_item"]);
function encrypted(line: Obj): { visible: Obj; sealed: unknown[] } {
  const sealed: unknown[] = [];
  const seal = (value: unknown, path: string): unknown => {
    sealed.push({ path, encrypted_content: value });
    return { preserved_as: "reasoning", index: sealed.length - 1 };
  };
  const response = (value: unknown, path: string): unknown => {
    if (!object(value)) return value;
    const out = { ...value };
    if (["reasoning", "compaction", "compaction_summary", "context_compaction"].includes(String(value.type)) && typeof value.encrypted_content === "string") out.encrypted_content = seal(value.encrypted_content, `${path}/encrypted_content`);
    if (value.type === "function_call" && Array.isArray(value.encrypted_function_args) && value.encrypted_function_args.every(v => typeof v === "string")) out.encrypted_function_args = seal(value.encrypted_function_args, `${path}/encrypted_function_args`);
    if (value.type === "agent_message" && Array.isArray(value.content)) out.content = value.content.map((part,index) => object(part) && part.type === "encrypted_content" && typeof part.encrypted_content === "string"
      ? { ...part, encrypted_content: seal(part.encrypted_content, `${path}/content/${index}/encrypted_content`) } : part);
    return out;
  };
  const visible = { ...line };
  if (line.type === "response_item") visible.payload = response(line.payload, "payload");
  if (line.type === "inter_agent_communication" && object(line.payload) && typeof line.payload.encrypted_content === "string") visible.payload = { ...line.payload, encrypted_content: seal(line.payload.encrypted_content, "payload/encrypted_content") };
  if (line.type === "compacted" && object(line.payload) && Array.isArray(line.payload.replacement_history)) visible.payload = { ...line.payload, replacement_history: line.payload.replacement_history.map((item,index) => response(item,`payload/replacement_history/${index}`)) };
  if (line.type === "event_msg" && object(line.payload) && line.payload.type === "raw_response_item") visible.payload = { ...line.payload, item: response(line.payload.item,"payload/item") };
  return { visible, sealed };
}
function textBlocks(...values: unknown[]): unknown[] { return values.filter((v): v is string => typeof v === "string").map(text => ({type:"text",text})); }
function convert(line: Obj, ctx: RecordContext, delegated: boolean): EventDraft | null {
  const p=line.payload;
  if (!object(p) || !lineTypes.has(String(line.type))) return null;
  if (line.type === "event_msg") {
    if (!eventTypes.has(String(p.type))) return null;
    // Persist the UI side of duplicate messages too: it can carry fields
    // absent from the model-history item, including prompt input provenance.
    return recordDraft(ctx, p.type === "thread_settings_applied" ? "session_state" : "activity", "system", {
      ...p, activity_type:`event_msg/${p.type}`, blocks:textBlocks(p.message,p.text,p.delta) },line);
  }
  if (line.type === "response_item") {
    if (!responseTypes.has(String(p.type))) return null;
    if (p.type === "message" && (!Array.isArray(p.content) || !p.content.every(part => object(part) &&
      ["input_text","output_text","input_image","input_audio"].includes(String(part.type))))) return null;
    if (p.type === "reasoning") return recordDraft(ctx,"conversation_turn","agent",{...p,role:"reasoning",
      blocks:[...(Array.isArray(p.summary)?p.summary:[]),...(Array.isArray(p.content)?p.content:[])].map(part=>object(part)&&typeof part.text==="string"?{...part,type:"thinking"}:part)},line);
    if (["compaction","compaction_summary","context_compaction","configuration_update","compaction_trigger","additional_tools"].includes(String(p.type))) return recordDraft(ctx,"context_injection","system",{...p,injection_type:p.type},line);
    if (p.type === "agent_message") {
      if (!Array.isArray(p.content)) return null;
      return recordDraft(ctx,"conversation_turn","agent",{...p,role:"agent_message",blocks:p.content.map(part=>object(part)&&part.type==="input_text"?{...part,type:"text"}:part)},line);
    }
    if (p.type === "local_shell_call") return recordDraft(ctx,"conversation_turn","agent",{...p,blocks:[{type:"tool_use",id:p.call_id??p.id,name:"local_shell",input:p.action}]},line);
    if (p.type === "tool_search_call") return recordDraft(ctx,"conversation_turn","agent",{...p,blocks:[{type:"tool_use",id:p.call_id??p.id,name:"tool_search",input:p.arguments}]},line);
    if (p.type === "tool_search_output") return recordDraft(ctx,"conversation_turn","system",{...p,blocks:[{type:"tool_result",tool_use_id:p.call_id,content:p.tools}]},line);
    if (["web_search_call","image_generation_call","other"].includes(String(p.type))) return recordDraft(ctx,"activity","agent",{...p,activity_type:p.type},line);
    const shared=normalizeCodexRolloutRecord(line,ctx)?.[0];
    if (shared && shared.actor?.type === "human" && (delegated || object(line.metadata) && line.metadata.inherited_user_message === true)) shared.actor={type:"system"};
    return shared??null;
  }
  if (line.type === "inter_agent_communication") {
    if (typeof p.content!=="string" && !p.encrypted_content) return null;
    return recordDraft(ctx,"conversation_turn","agent",{...p,role:"inter_agent_communication",blocks:textBlocks(p.content)},line);
  }
  if (line.type === "retained_context") {
    if (p.type!=="verified_answer") return null;
    return recordDraft(ctx,"context_injection","system",{...p,injection_type:"retained_context"},line);
  }
  if (line.type === "realtime_item") {
    if (!["realtime_session_started","transcript_segment","bem_item_promoted","realtime_session_closed"].includes(String(p.type))) return null;
    if (p.type==="transcript_segment" && typeof p.text==="string" && ["user","assistant"].includes(String(p.role))) return recordDraft(ctx,"conversation_turn",p.role==="assistant"?"agent":delegated?"system":"human",{...p,blocks:textBlocks(p.text)},line);
    return recordDraft(ctx,"activity","system",{...p,activity_type:`realtime_item/${p.type}`},line);
  }
  if (line.type === "token_usage_record" || line.type === "security_risk_score") return recordDraft(ctx,"activity","system",{...p,activity_type:line.type},line);
  if (line.type === "compacted") return recordDraft(ctx,"context_injection","system",{...p,injection_type:"compacted",blocks:textBlocks(p.message)},line);
  return normalizeCodexRolloutRecord(line,ctx)?.[0]??null;
}
function normalize(raw: unknown,ctx:RecordContext,drift:Record<string,number>,delegated=false):EventDraft[] {
  const split=object(raw)?encrypted(raw):{visible:raw,sealed:[]};
  const converted=object(split.visible)?convert(split.visible,ctx,delegated):null;
  const key=object(raw)?`${raw.type??"missing-type"}${object(raw.payload)&&raw.payload.type?`/${raw.payload.type}`:""}`:"malformed-json";
  if(!converted)countUnrecognized(drift,key);
  const drafts=[converted??recordDraft(ctx,"unrecognized","system",{unrecognized_type:key,raw_sha256:sha256Hex(canonicalJson(split.visible))},split.visible)];
  for(const draft of drafts) draft.meta={open_interpreter_delegated:delegated};
  if(split.sealed.length)drafts.push(recordDraft(ctx,"reasoning","agent",{opaque:true,encrypted_sha256:sha256Hex(canonicalJson(split.sealed))},{sealed:split.sealed}));
  return drafts;
}
export function renormalizeUnrecognizedMany(event:EvidenceEvent,identity:GitUserIdentity):EventDraft[]|null {
  if(!event.raw||!event.stream)return null;
  const ctx:RecordContext={source:SOURCE,sessionId:event.producer.session_id??"",conversationId:event.stream.id,seq:event.stream.seq,occurredAt:event.occurred_at,
    version:packageVersion(),rawFormat:FORMAT,identity,agent:{...event.producer},...(event.stream.parent?{parentConversationId:event.stream.parent}:{})};
  const converted=normalize(event.raw.data,ctx,{},event.meta?.["open_interpreter_delegated"]===true);
  return converted[0]?.kind==="unrecognized"?null:converted;
}
export function renormalizeUnrecognized(event:EvidenceEvent,identity:GitUserIdentity):EventDraft|null{return renormalizeUnrecognizedMany(event,identity)?.[0]??null;}
interface Rollout {path:string;lines:unknown[];header:Obj;id:string;rolloutId:string;parent?:string;headerOnly:boolean}
/** Read only metadata while selecting a project, including compressed stores. */
async function firstLine(path:string):Promise<string>{
  const chunks:Buffer[]=[];let done=false;
  const consume=(bytes:Uint8Array)=>{if(done)return;const buffer=Buffer.from(bytes),newline=buffer.indexOf(10);chunks.push(newline<0?buffer:buffer.subarray(0,newline));done=newline>=0;};
  const decoder=path.endsWith(".zst")?new Decompress(consume):undefined;
  for await(const chunk of createReadStream(path)){if(decoder)decoder.push(chunk);else consume(chunk);if(done)break;}
  return Buffer.concat(chunks).toString("utf8");
}
async function readRollout(path:string,headerOnly=false):Promise<Rollout> {
  let raw:string;
  try { raw=headerOnly?await firstLine(path):await readFile(path).then(bytes=>Buffer.from(path.endsWith(".zst")?decompress(bytes):bytes).toString("utf8")); }
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"&&!path.endsWith(".zst"))return readRollout(path+".zst",headerOnly);throw error;}
  const lines:unknown[]=[];
  const sourceLines=raw.split("\n");
  for(const [index,line] of sourceLines.entries()){
    if(!line.trim()){lines.push(null);continue;}
    try{lines.push(JSON.parse(line));}catch{if(index===sourceLines.length-1&&!raw.endsWith("\n"))break;lines.push(line);}
  }
  const first=lines.find(object);
  if(!first||first.type!=="session_meta"||!object(first.payload)||typeof first.payload.id!=="string")throw new Error("Open Interpreter rollout requires native session_meta header");
  const header=first.payload,id=header.id as string;
  const suffix=basename(path).replace(/\.jsonl(?:\.zst)?$/,"").split("_").at(-1)!;
  const rolloutId=basename(path).includes("_")?suffix:id;
  const source=object(header.source)&&object(header.source.sub_agent)&&object(header.source.sub_agent.spawn)?header.source.sub_agent.spawn:undefined;
  const parent=typeof header.parent_thread_id==="string"?header.parent_thread_id:typeof source?.parent_thread_id==="string"?source.parent_thread_id:typeof header.forked_from_id==="string"?header.forked_from_id:undefined;
  return{path,lines,header,id,rolloutId,headerOnly,...(parent?{parent}:{})};
}
const streamId=(rollout:Rollout)=>`open-interpreter:${rollout.id}${rollout.rolloutId!==rollout.id?`:rollout:${rollout.rolloutId}`:""}`;
async function capture(rollout:Rollout,cwd:string):Promise<CaptureResult>{
  if(rollout.headerOnly)rollout=await readRollout(rollout.path);
  const repo=await findRepo(cwd);if(!repo)throw new Error("not inside a git repository");
  const identity=await gitUserIdentity(repo),result=empty(),agent:ProducerAgentContext={},drafts:EventDraft[]=[];
  const delegated=typeof rollout.header.parent_thread_id==="string"||object(rollout.header.source)&&"sub_agent"in rollout.header.source;
  for(const[index,raw]of rollout.lines.entries()){
    if(raw===null)continue;
    const line=object(raw)?raw:undefined,p=line&&object(line.payload)?line.payload:undefined;
    if(p&&(line!.type==="session_meta"||line!.type==="turn_context")){
      if(typeof p.cli_version==="string")agent.source_version=p.cli_version;
      if(typeof p.model_provider==="string")agent.provider=p.model_provider;
      if(typeof p.model==="string")agent.model=p.model;
    }
    const seq=line?.ordinal==null?index:line.ordinal;
    if(typeof seq!=="number"||!Number.isSafeInteger(seq)||seq<0)throw new Error("Open Interpreter native ordinal exceeds supported integer range");
    const ctx:RecordContext={source:SOURCE,sessionId:rollout.id,conversationId:streamId(rollout),seq,occurredAt:typeof line?.timestamp==="string"?line.timestamp:EPOCH,version:packageVersion(),rawFormat:FORMAT,identity,agent:{...agent},...(rollout.parent?{parentConversationId:`open-interpreter:${rollout.parent}`}:{})};
    drafts.push(...normalize(raw,ctx,result.unrecognized,delegated));
  }
  const appended=await appendEvents(repo,drafts);result.appended=appended.appended.length;result.deduped=appended.deduped;warnUnrecognized(SOURCE,result.unrecognized);return result;
}
async function discover(root:string):Promise<string[]>{
  const result:string[]=[];
  async function walk(directory:string):Promise<void>{
    let entries:import("node:fs").Dirent[];try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
    for(const item of entries){const path=join(directory,item.name);if(item.isDirectory())await walk(path);else if(item.isFile()&&/^rollout-.*\.jsonl(?:\.zst)?$/.test(item.name))result.push(path);}
  }
  await walk(root);
  const plain=new Set(result.filter(path=>!path.endsWith(".zst")));
  return result.filter(path=>!path.endsWith(".zst")||!plain.has(path.slice(0,-4))).sort();
}
async function captureTree(initial:Rollout,cwd:string,all:Rollout[],visited:Set<string>):Promise<CaptureResult>{
  const result=empty(),queue=[initial];
  while(queue.length){const current=queue.shift()!;if(visited.has(current.path))continue;visited.add(current.path);mergeCaptureResult(result,await capture(current,cwd));
    // Full source parent records are separate evidence; the child's history_base
    // retains the exact exclusive boundary, never presented as child-local input.
    const base=object(current.header.history_base)?current.header.history_base.thread_id:undefined;
    for(const candidate of all)if(candidate.parent===current.id||candidate.rolloutId===base)queue.push(candidate);
  }return result;
}
export async function captureOpenInterpreterTranscript(path:string,cwd:string):Promise<CaptureResult>{
  const initial=await readRollout(path);let root=dirname(path);
  while(dirname(root)!==root&&!['sessions','archived_sessions'].includes(basename(root)))root=dirname(root);
  if(dirname(root)===root)root=dirname(path);
  const roots=['sessions','archived_sessions'].includes(basename(root))?[join(dirname(root),"sessions"),join(dirname(root),"archived_sessions")]:[root];
  const paths=(await Promise.all(roots.map(discover))).flat(),all:Rollout[]=[];
  for(const candidate of paths)all.push(candidate===path?initial:await readRollout(candidate,true));
  return captureTree(initial,cwd,all,new Set());
}
export async function captureOpenInterpreterAll(cwd:string,sessionRoot?:string):Promise<CaptureResult>{
  const target=await canonical(cwd),result=empty(),all:Rollout[]=[],visited=new Set<string>();
  for(const root of sessionRoot?[sessionRoot]:[join(home(),"sessions"),join(home(),"archived_sessions")])for(const path of await discover(root))all.push(await readRollout(path,true));
  for(const rollout of all)if(typeof rollout.header.cwd==="string"&&await canonical(rollout.header.cwd)===target)mergeCaptureResult(result,await captureTree(rollout,cwd,all,visited));
  return result;
}
export async function runOpenInterpreterHook(stdinJson:string):Promise<void>{
  try{const payload:unknown=JSON.parse(stdinJson);if(!object(payload)||typeof payload.transcript_path!=="string")return;const cwd=typeof payload.cwd==="string"?payload.cwd:process.cwd();if(!(await findRepo(cwd)))return;await captureOpenInterpreterTranscript(payload.transcript_path,cwd);}
  catch(error){process.stderr.write(`cledger: open-interpreter hook error: ${error instanceof Error?error.message:String(error)}\n`);}
}
