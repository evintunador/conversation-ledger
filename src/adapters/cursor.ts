/** Cursor CLI's native project/user hooks expose a session transcript path.
 * Observed with installed agent 2026.10.01-e373342: JSONL rows contain
 * role/message/content blocks and turn_ended. Read results are omitted from
 * the transcript, so this adapter does not invent them. */
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";
import { findRepo, gitUserIdentity } from "annals";
import { appendEvents, readEvents } from "../store.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, unrecognizedDraft, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, activityDraft, type RecordContext } from "./records.js";
import type { EventDraft } from "../schema.js";

const FORMAT = "cursor-agent-transcript-jsonl/1";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const result = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });

/** The terminal renders a structured query wrapper; retain it raw, but make
 * the human-authored text directly searchable in normalized blocks. */
function humanText(value: string): string {
  const match = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(value);
  return match ? match[1]!.trimEnd() : value;
}

function parts(value: unknown, seq: number, drift: Record<string, number>, human: boolean): unknown[] {
  if (!Array.isArray(value)) {
    countUnrecognized(drift, "message/content-not-array");
    return [{ type: "unrecognized", data: value ?? null }];
  }
  return value.map((part, index) => {
    if (!object(part)) { countUnrecognized(drift, "content/non-object"); return { type: "unrecognized", data: part }; }
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: human ? humanText(part.text) : part.text };
    if (part.type === "tool_use") return { type: "tool_use", name: part.name,
      id: str(part.id) ?? `transcript-${seq}-${index}`, input: part.input ?? {} };
    if (part.type === "tool_result") return { type: "tool_result", tool_use_id: part.tool_use_id,
      content: part.content, is_error: part.is_error };
    if (["image", "audio", "video", "document", "file", "thinking", "redacted_thinking"].includes(String(part.type))) return part;
    // All other content, including image/file references, is kept for drift
    // analysis. appendEvents applies the shared binary-attachment policy.
    countUnrecognized(drift, `content/${String(part.type ?? "(untyped)")}`);
    return part;
  });
}

export async function captureCursorTranscript(path: string, cwd: string, sessionId?: string, model?: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const out = result();
  const source = await readFile(path, "utf8").catch(() => "");
  if (!source) return out;
  const info = await stat(path);
  const date = info.birthtimeMs > 0 ? info.birthtime.toISOString() : "1970-01-01T00:00:00.000Z";
  const id = sessionId ?? /([^/]+)\.jsonl$/.exec(path)?.[1] ?? "unknown";
  const identity = await gitUserIdentity(repo);
  const rows = source.split("\n");
  const complete = rows.length - 1;
  const drafts: EventDraft[] = [];
  for (let seq = 0; seq < complete; seq++) {
    if (!rows[seq]!.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(rows[seq]!); } catch { row = rows[seq]!; }
    const ctx: RecordContext = { occurredAt: date, source: "cursor", sessionId: id,
      seq, version: packageVersion(), rawFormat: FORMAT, conversationId: `cursor:${id}`, identity,
      ...(model ? { agent: { model } } : {}) };
    if (object(row) && ["user", "assistant", "system"].includes(str(row.role) ?? "") && object(row.message)) {
      const role = str(row.role)!;
      drafts.push(recordDraft(ctx, "conversation_turn", role === "user" ? "human" : role === "assistant" ? "agent" : "system",
        { blocks: parts(row.message.content, seq, out.unrecognized, role === "user") }, row));
    } else if (object(row) && row.type === "turn_ended") {
      drafts.push(activityDraft(ctx, "turn_ended", { status: row.status }, row));
    } else {
      const key = object(row) ? String(row.type ?? row.role ?? "(untyped)") : "malformed-json";
      countUnrecognized(out.unrecognized, key);
      drafts.push(unrecognizedDraft({ typeKey: key, line: row, occurredAt: date,
        source: "cursor", sessionId: id, seq, version: packageVersion(), rawFormat: FORMAT,
        conversationId: `cursor:${id}` }));
    }
  }
  if (drafts.length) {
    const added = await appendEvents(repo, drafts);
    out.appended = added.appended.length;
    out.deduped = added.deduped;
  }
  warnUnrecognized("cursor", out.unrecognized);
  return out;
}

/** Native hooks run from the workspace root for project settings and from
 * ~/.cursor for global settings; use the payload's explicit workspace root. */
export async function runCursorHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as Record<string, unknown>;
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const cwd = roots.find((v): v is string => typeof v === "string" && !!v);
    const path = str(payload.transcript_path);
    if (cwd && path && ["sessionEnd", "stop", "afterAgentResponse"].includes(String(payload.hook_event_name))) {
      const repo = await findRepo(resolve(cwd));
      if (repo) await captureCursorTranscript(path, cwd, str(payload.session_id), str(payload.model));
    }
  } catch (error) {
    process.stderr.write(`cledger cursor hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write("{}\n");
}

/** In --print stream-json mode Cursor emits completed tool calls with result
 * bodies even though its native transcript omits them. This opt-in wrapper
 * records only those results; the native hooks remain the sole source for
 * prompts, answers and tool starts, avoiding duplicated turns. Interactive
 * Cursor does not expose this stdout protocol. */
export async function runCursor(args: string[], binary = "cursor-agent"): Promise<number> {
  if (args.some(arg => arg === "--output-format" || arg.startsWith("--output-format="))) {
    throw new Error("cledger run cursor selects --output-format stream-json; remove the explicit output format");
  }
  const child = spawn(binary, ["--print", "--output-format", "stream-json", ...args], {
    cwd: process.cwd(), stdio: ["inherit", "pipe", "inherit"],
  });
  const rows: { row: Record<string, unknown>; index: number }[] = [];
  const starts: { sessionId: string; callId: string; tool: string }[] = [];
  let pending = "", lineIndex = 0;
  const collect = (line: string) => {
    const index = lineIndex++;
    if (line.length > 8 * 1024 * 1024) {
      process.stderr.write("cledger cursor: stream-json record exceeds 8 MiB; tool result not captured\n");
      return;
    }
    try {
      const row: unknown = JSON.parse(line);
      if (object(row) && row.type === "tool_call" && object(row.tool_call)) {
        const native = Object.entries(row.tool_call).find(([key, value]) => key.endsWith("ToolCall") && object(value));
        const tool = native?.[0]?.replace(/ToolCall$/, "") ?? "unknown";
        if (row.subtype === "started" && typeof row.session_id === "string" && typeof row.call_id === "string")
          starts.push({ sessionId: row.session_id, callId: row.call_id, tool });
        if (row.subtype === "completed") rows.push({ row, index });
      }
    } catch { /* Forward native diagnostics unchanged; no invented result. */ }
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    process.stdout.write(chunk);
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      collect(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    if (pending.length > 8 * 1024 * 1024) {
      process.stderr.write("cledger cursor: stream-json record exceeds 8 MiB; tool result not captured\n");
      pending = "";
    }
  });
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  let code = 1;
  try {
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (pending.trim()) collect(pending);
    const repo = await findRepo(process.cwd());
    if (repo && rows.length) {
      const existing = await readEvents(repo);
      const links = new Map<string, string>();
      for (const sessionId of new Set(starts.map(start => start.sessionId))) {
        const calls = existing.filter(event => event.producer.source === "cursor" &&
          event.stream?.id === `cursor:${sessionId}`)
          .sort((a, b) => (a.stream?.seq ?? 0) - (b.stream?.seq ?? 0))
          .flatMap(event => (object(event.content) && Array.isArray(event.content.blocks) ? event.content.blocks : []))
          .filter(block => object(block) && block.type === "tool_use");
        const sessionStarts = starts.filter(start => start.sessionId === sessionId);
        // Cursor's transcript has tool starts in model order but no native
        // call IDs. Link only if the complete sequence matches by tool name;
        // otherwise preserve the original call ID rather than guess.
        if (calls.length === sessionStarts.length && calls.every((block, index) =>
          String((block as Record<string, unknown>).name).toLowerCase() === sessionStarts[index]!.tool.toLowerCase())) {
          for (let i = 0; i < calls.length; i++) links.set(sessionStarts[i]!.callId, String((calls[i] as Record<string, unknown>).id));
        }
      }
      const drafts: EventDraft[] = [];
      for (const { row, index } of rows) {
        const sessionId = str(row.session_id);
        const callId = str(row.call_id);
        if (!sessionId || !callId) continue;
        const call = row.tool_call as Record<string, unknown>;
        const native = Object.entries(call).find(([key, value]) => key.endsWith("ToolCall") && object(value));
        const tool = native?.[0]?.replace(/ToolCall$/, "") ?? "unknown";
        const data = native?.[1] as Record<string, unknown> | undefined;
        const millis = row.timestamp_ms;
        const occurredAt = typeof millis === "number" && Number.isFinite(millis)
          ? new Date(millis).toISOString() : "1970-01-01T00:00:00.000Z";
        const ctx: RecordContext = { occurredAt, source: "cursor", sessionId, seq: index,
          version: packageVersion(), rawFormat: "cursor-agent-stream-json/1",
          conversationId: `cursor:${sessionId}:stream`, parentConversationId: `cursor:${sessionId}` };
        drafts.push(recordDraft(ctx, "conversation_turn", "system", {
          source_call_id: callId, tool_name: tool,
          blocks: [{ type: "tool_result", tool_use_id: links.get(callId) ?? callId, content: data?.result ?? null,
            is_error: object(data?.result) && data.result.error !== undefined }],
        }, row));
      }
      if (drafts.length) await appendEvents(repo, drafts);
    }
    code = ended.signal ? 128 + (constants.signals[ended.signal] ?? 0) : ended.code ?? 1;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
  return code;
}
