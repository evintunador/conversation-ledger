/** Cursor CLI's native project/user hooks expose a session transcript path.
 * Observed with installed agent 2026.10.01-e373342: JSONL rows contain
 * role/message/content blocks and turn_ended. Read bodies are omitted from
 * transcripts and postToolUse metadata. beforeReadFile supplies the body;
 * only uniquely matched successful postToolUse confirms durable retention. */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo, gitUserIdentity } from "annals";
import { appendEvents, readEvents } from "../store.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, unrecognizedDraft, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, activityDraft, type RecordContext } from "./records.js";
import type { EventDraft } from "../schema.js";
import { applyAttachmentPolicy } from "../attachments.js";

const FORMAT = "cursor-agent-transcript-jsonl/1";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const result = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const hookFormat = "cursor-agent-native-hooks/1";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fields = (value: unknown): Record<string, unknown> => object(value) ? value : {};

async function preserveCursorHookAnomaly(cwd: string, payload: Record<string, unknown>, typeKey: string): Promise<void> {
  const repo = await findRepo(cwd);
  warnUnrecognized("cursor", { [typeKey]: 1 });
  if (!repo) return;
  const session = typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id : undefined;
  const safe = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "user_email"));
  if (payload.hook_event_name === "beforeReadFile" && payload.content !== undefined) {
    const bytes = typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content);
    safe.content = { type: "attachment_reference", ...(str(payload.file_path) ? { path: payload.file_path } : {}),
      sha256: digest(bytes), size: Buffer.byteLength(bytes), availability: "unrecognized_unapproved_body_not_retained" };
  }
  if (typeof safe.tool_output === "string") {
    try { safe.tool_output = { encoding: "json", value: JSON.parse(safe.tool_output) }; } catch { /* native text */ }
  }
  await appendEvents(repo, [{ kind: "unrecognized", occurred_at: "1970-01-01T00:00:00.000Z", actor: { type: "system" },
    producer: { tool: "cledger", source: "cursor", version: packageVersion(), ...(session ? { session_id: session } : {}) },
    ...(session ? { stream: { id: `cursor:${session}`, seq: 0 } } : {}),
    content: { unrecognized_type: typeKey, raw_record_sha256: digest(JSON.stringify(safe)),
      missing_provenance: ["occurred_at", !session && "session_id", !(typeof payload.generation_id === "string" && payload.generation_id.trim()) && "generation_id"].filter(Boolean) },
    raw: { format: hookFormat, data: safe } }]);
}

async function expireCursorCandidates(directory: string): Promise<boolean> {
  let pending = false;
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json(?:\.\d+\.tmp)?$/.test(name)) continue;
    const path = join(directory, name);
    const candidate = await readFile(path, "utf8").then(s => JSON.parse(s)).catch(() => undefined);
    const freshPartial = !candidate && name.endsWith(".tmp") &&
      Date.now() - (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs < 60_000;
    if (freshPartial) pending = true;
    else if (!candidate || !Number.isFinite(candidate.expires_at) || candidate.expires_at <= Date.now()) await rm(path, { force: true });
    else pending = true;
  }
  return pending;
}

async function scheduleCursorCandidateExpiry(directory: string): Promise<void> {
  const lock = directory + ".expiry-lock";
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readFile(join(lock, "owner.json"), "utf8").then(s => JSON.parse(s)).catch(() => undefined);
    if (owner && owner.expires_at > Date.now()) {
      try { process.kill(owner.pid, 0); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return; }
    } else if (!owner && Date.now() - (await stat(lock)).mtimeMs < 5000) return;
    await rm(lock, { recursive: true, force: true });
    try { await mkdir(lock, { mode: 0o700 }); } catch { return; }
  }
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--expire-cursor-candidates", directory, lock],
      { detached: true, stdio: "ignore" });
    await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    const temporary = join(lock, `owner-${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify({ pid: child.pid, expires_at: Date.now() + 75_000 }), { mode: 0o600 });
    await rename(temporary, join(lock, "owner.json"));
    child.unref();
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
}

/** One test-owned/native-hook-owned process, bounded to 70 seconds. */
export async function runCursorCandidateExpiry(directory: string, lock: string): Promise<void> {
  const deadline = Date.now() + 70_000;
  try {
    while (Date.now() < deadline && await expireCursorCandidates(directory))
      await new Promise(done => setTimeout(done, 250));
  } finally {
    const owner = await readFile(join(lock, "owner.json"), "utf8").then(s => JSON.parse(s)).catch(() => undefined);
    if (owner?.pid === process.pid) {
      await rm(lock, { recursive: true, force: true });
      // Reads staged near this worker's deadline get a fresh bounded owner.
      if (await expireCursorCandidates(directory)) await scheduleCursorCandidateExpiry(directory);
    }
  }
}

/** Capture native IDs and confirmation, staging read bytes outside the ledger
 * until an unambiguous successful Read confirms they were delivered. */
export async function captureCursorToolHook(payload: Record<string, unknown>, cwd: string,
  timing: { ttlMs?: number } = {}): Promise<void> {
  const repo = await findRepo(cwd), session = str(payload.session_id), generation = str(payload.generation_id);
  if (!repo || !session?.trim() || !generation?.trim()) {
    await preserveCursorHookAnomaly(cwd, payload, "hook/missing-session-generation-or-repository");
    return;
  }
  const event = str(payload.hook_event_name), callId = str(payload.tool_use_id);
  const tool = str(payload.tool_name), input = fields(payload.tool_input), nonempty = (value: unknown) => typeof value === "string" && !!value.trim();
  let valid = false;
  if (event === "beforeReadFile") valid = nonempty(payload.file_path) && typeof payload.content === "string";
  else if (["preToolUse", "postToolUse", "postToolUseFailure"].includes(event ?? "")) {
    valid = nonempty(callId) && nonempty(tool) && object(payload.tool_input) && (tool !== "Read" || nonempty(input.file_path));
    if (event === "postToolUse") {
      valid &&= typeof payload.tool_output === "string";
      if (valid && tool === "Read") {
        try {
          const output = JSON.parse(String(payload.tool_output));
          valid = object(output) && nonempty(output.file_path) && typeof output.content_length === "number" &&
            Number.isSafeInteger(output.content_length) && output.content_length >= 0 &&
            resolve(cwd, String(output.file_path)) === resolve(cwd, String(input.file_path));
        } catch { valid = false; }
      }
    }
    if (event === "postToolUseFailure") valid &&= typeof payload.error_message === "string" && nonempty(payload.failure_type);
  }
  if (!valid) { await preserveCursorHookAnomaly(cwd, payload, `hook/${event ?? "(missing-event)"}/invalid-shape`); return; }
  const directory = join(repo.commonDir, "cledger-cursor-pending");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await expireCursorCandidates(directory);
  const events = await readEvents(repo, { reachableFrom: null });
  const own = events.filter(e => e.producer.source === "cursor" && e.stream?.id === `cursor:${session}` && e.raw?.format.startsWith(hookFormat));
  const ctx: RecordContext = { occurredAt: "1970-01-01T00:00:00.000Z", source: "cursor", sessionId: session,
    seq: 0, version: packageVersion(), rawFormat: hookFormat, conversationId: `cursor:${session}`,
    ...(typeof payload.model === "string" ? { agent: { model: payload.model } } : {}) };
  // Account identity is not tool evidence. Keep the observed tool protocol.
  const raw = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "user_email"));
  const toolInput = fields(payload.tool_input), file = str(toolInput.file_path);
  const stagePath = (id: string) => join(directory, digest(`${session}\0${generation}\0${id}`) + ".json");
  if (event === "preToolUse" && callId && str(payload.tool_name)) {
    await appendEvents(repo, [recordDraft(ctx, "conversation_turn", "agent", {
      hook_event_name: event, generation_id: generation, native_timestamp_missing: true,
      blocks: [{ type: "tool_use", id: callId, name: payload.tool_name, input: toolInput }],
    }, raw)]);
  } else if (event === "beforeReadFile" && str(payload.file_path) && typeof payload.content === "string") {
    const path = resolve(cwd, String(payload.file_path));
    const completed = new Set(own.filter(e => ["postToolUse", "postToolUseFailure"].includes(String(fields(e.raw?.data).hook_event_name)))
      .map(e => fields(e.raw?.data).tool_use_id));
    const active = own.filter(e => {
      const p = fields(e.raw?.data), input = fields(p.tool_input);
      return p.hook_event_name === "preToolUse" && p.generation_id === generation && p.tool_name === "Read" &&
        typeof input.file_path === "string" && resolve(cwd, input.file_path) === path && !completed.has(p.tool_use_id);
    });
    const metadata = { session, generation, file_path: path, content_length: payload.content.length, sha256: digest(payload.content), native_timestamp_missing: true };
    const unique = active.length === 1 ? str(fields(active[0]!.raw?.data).tool_use_id) : undefined;
    if (unique) {
      const body = { type: "input_file", filename: path, file_data: Buffer.from(payload.content).toString("base64") };
      const policy = applyAttachmentPolicy(recordDraft(ctx, "activity", "system", { body }, { body }));
      const previous = await readFile(stagePath(unique), "utf8").then(s => JSON.parse(s)).catch(() => undefined);
      const ttl = Number.isFinite(timing.ttlMs) ? Math.min(60_000, Math.max(1, timing.ttlMs!)) : 60_000;
      const candidate = previous && (previous.ambiguous || previous.sha256 !== metadata.sha256)
        ? { ...metadata, ambiguous: true, expires_at: Date.now() + ttl }
        : { ...metadata, tool_use_id: unique, body: fields(policy.content).body, expires_at: Date.now() + ttl };
      const temporary = stagePath(unique) + `.${process.pid}.tmp`, reservation = stagePath(unique) + ".0.tmp";
      // Establish the bounded owner before any bytes are written. The
      // metadata-only reservation keeps it alive through the atomic rename.
      await writeFile(reservation, JSON.stringify({ expires_at: candidate.expires_at }), { mode: 0o600 });
      try {
        await scheduleCursorCandidateExpiry(directory);
        await writeFile(temporary, JSON.stringify(candidate), { mode: 0o600 });
        await rename(temporary, stagePath(unique));
      } catch (error) {
        await rm(stagePath(unique), { force: true });
        throw error;
      } finally {
        await rm(temporary, { force: true });
        await rm(reservation, { force: true });
      }
    }
    // Neither normalized nor raw durable evidence includes unapproved bytes.
    await appendEvents(repo, [activityDraft(ctx, event, {
      ...metadata, ...(unique ? { tool_use_id: unique } : {}),
      body_capture: unique ? "staged_pending_success" : "ambiguous_or_missing_call",
    }, { ...raw, content: { type: "attachment_reference", path, sha256: metadata.sha256,
      size: Buffer.byteLength(payload.content), availability: "pending_permission_not_retained" } })]);
  } else if (["postToolUse", "postToolUseFailure"].includes(event ?? "") && callId) {
    if (own.some(e => fields(e.raw?.data).hook_event_name === event && fields(e.raw?.data).tool_use_id === callId &&
      fields(e.raw?.data).generation_id === generation)) {
      await rm(stagePath(callId), { force: true });
      return;
    }
    let output: unknown = payload.tool_output ?? payload.error_message ?? null;
    let parsedOutput = false;
    if (typeof output === "string") { try { output = JSON.parse(output); parsedOutput = true; } catch { /* native text */ } }
    // Parse the JSON string carrier before applying retention: otherwise an
    // embedded binary attachment could survive unchanged inside raw JSON text.
    const retainedRaw = parsedOutput ? { ...raw, tool_output: { encoding: "json", value: output } } : raw;
    const candidate = await readFile(stagePath(callId), "utf8").then(s => JSON.parse(s)).catch(() => undefined);
    let body: unknown;
    if (event === "postToolUse" && payload.tool_name === "Read" && file && candidate && !candidate.ambiguous && candidate.expires_at > Date.now() &&
      candidate.session === session && candidate.generation === generation && candidate.tool_use_id === callId &&
      candidate.file_path === resolve(cwd, file) && fields(output).content_length === candidate.content_length)
      body = candidate.body;
    const reference = event === "postToolUse" && payload.tool_name === "Read" && file ? {
      type: "attachment_reference", path: resolve(cwd, file), availability: "body_not_captured",
      reason: "missing_expired_or_ambiguous_native_candidate",
    } : undefined;
    await appendEvents(repo, [recordDraft(ctx, "conversation_turn", "system", {
      hook_event_name: event, generation_id: generation, native_timestamp_missing: true,
      blocks: [{ type: "tool_result", tool_use_id: callId, is_error: event === "postToolUseFailure",
        content: body === undefined ? (reference ? { native_output: output, file: reference } : output) : { native_output: output, file: body } }],
    }, body === undefined ? retainedRaw : { ...retainedRaw, confirmed_read: { file_path: file, file: body } })]);
    await rm(stagePath(callId), { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--expire-cursor-candidates") {
  const directory = process.argv[3], lock = process.argv[4];
  if (!directory || lock !== directory + ".expiry-lock") throw new Error("invalid Cursor candidate expiry arguments");
  const hardDeadline = setTimeout(() => process.exit(1), 72_000);
  try { await runCursorCandidateExpiry(directory, lock); } finally { clearTimeout(hardDeadline); }
}

async function clearCursorPending(cwd: string, session: string): Promise<void> {
  const repo = await findRepo(cwd);
  if (!repo) return;
  const directory = join(repo.commonDir, "cledger-cursor-pending");
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const item = await readFile(path, "utf8").then(s => JSON.parse(s)).catch(() => undefined);
    if (item?.session === session) await rm(path, { force: true });
  }
}

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
    if (part.type === "tool_use") {
      return { type: "tool_use", name: part.name,
        id: str(part.id) ?? `transcript-${seq}-${index}`, input: part.input ?? {},
        ...(str(part.id) ? {} : { native_id_missing: true }) };
    }
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
      const blocks = parts(row.message.content, seq, out.unrecognized, role === "user");
      drafts.push(recordDraft(ctx, "conversation_turn", role === "user" ? "human" : role === "assistant" ? "agent" : "system",
        { blocks }, row));
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

/** The native Read stream's success.data is protobuf bytes encoded as base64.
 * Scope this conversion to that carrier, preserving unrelated tool prose. */
export function prepareCursorStreamRow(row: Record<string, unknown>): Record<string, unknown> {
  const call = fields(row.tool_call), read = fields(call.readToolCall), result = fields(read.result), success = fields(result.success);
  if (typeof success.data !== "string") return row;
  const carrier = { type: "input_file", filename: fields(read.args).path, file_data: success.data };
  return { ...row, tool_call: { ...call, readToolCall: { ...read, result: { ...result,
    success: { ...success, data: carrier } } } } };
}

/** Native hooks run from the workspace root for project settings and from
 * ~/.cursor for global settings; use the payload's explicit workspace root. */
export async function runCursorHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as Record<string, unknown>;
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const cwd = roots.find((v): v is string => typeof v === "string" && !!v);
    const path = str(payload.transcript_path);
    if (!cwd && ["preToolUse", "beforeReadFile", "postToolUse", "postToolUseFailure"].includes(String(payload.hook_event_name)))
      warnUnrecognized("cursor", { "hook/missing-workspace-root": 1 });
    if (cwd && ["preToolUse", "beforeReadFile", "postToolUse", "postToolUseFailure"].includes(String(payload.hook_event_name)))
      await captureCursorToolHook(payload, cwd);
    if (cwd && path && ["sessionEnd", "stop", "afterAgentResponse"].includes(String(payload.hook_event_name))) {
      const repo = await findRepo(resolve(cwd));
      if (repo) await captureCursorTranscript(path, cwd, str(payload.session_id), str(payload.model));
    }
    if (cwd && payload.hook_event_name === "sessionEnd" && str(payload.session_id))
      await clearCursorPending(cwd, String(payload.session_id));
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
        // Hook records carry actual call IDs, have no native sequence number,
        // and can be returned in ledger storage order. Never remap their IDs.
        const calls = existing.filter(event => event.producer.source === "cursor" && event.raw?.format.split("+", 1)[0] === FORMAT &&
          event.stream?.id === `cursor:${sessionId}`)
          .sort((a, b) => (a.stream?.seq ?? 0) - (b.stream?.seq ?? 0))
          .flatMap(event => (object(event.content) && Array.isArray(event.content.blocks) ? event.content.blocks : []))
          .filter(block => object(block) && block.type === "tool_use" && block.native_id_missing === true);
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
      for (const { row: nativeRow, index } of rows) {
        const row = prepareCursorStreamRow(nativeRow);
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
