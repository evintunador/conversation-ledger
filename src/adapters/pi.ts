import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity } from "annals";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, mergeCaptureResult, warnUnrecognized, type CaptureResult } from "./drift.js";
import {
  activityDraft, contextInjectionDraft, recordDraft, sessionStateDraft, textBlocks,
  type RecordContext,
} from "./records.js";

// Pi's persisted session format, not its --mode json streaming protocol.
// Upstream contracts (checked 2026-09-28): packages/coding-agent/src/core/
// session-manager.ts, messages.ts and packages/ai/src/types.ts in earendil-works/pi.
const RAW_FORMAT = "pi-session-jsonl/1";
const EPOCH = "1970-01-01T00:00:00.000Z";
type Obj = Record<string, unknown>;
function object(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function time(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

/** Native ids and tree edges remain queryable without opening raw.data. */
function entryFields(entry: Obj): Obj {
  const { type: _type, message: _message, ...fields } = entry;
  return fields;
}

function unknownDraft(raw: unknown, key: string, ctx: RecordContext): EventDraft {
  return recordDraft(ctx, "unrecognized", "system", {
    unrecognized_type: key,
    ...(object(raw) ? { native_id: raw.id, parentId: raw.parentId } : {}),
    // Raw is excluded from ledger identity. Different new/invalid data at
    // the same source position must not silently deduplicate.
    raw_sha256: digest(raw),
  }, raw);
}

/** Unknown nested content survives intact and trips the same drift counter. */
function blocks(value: unknown, unknown: Record<string, number>): unknown[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) {
    countUnrecognized(unknown, "message/content");
    return [{ type: "unrecognized", data: value ?? null }];
  }
  return value.map((value) => {
    if (!object(value)) {
      countUnrecognized(unknown, "message/block/(non-object)");
      return { type: "unrecognized", data: value };
    }
    const { type, ...fields } = value;
    switch (type) {
      case "text": {
        if (typeof fields.text !== "string") countUnrecognized(unknown, "message/block/text/malformed");
        const { textSignature: _signature, ...visible } = fields;
        return { ...visible, type: "text" };
      }
      case "image":
        if (typeof fields.mimeType !== "string" || !(typeof fields.data === "string" || object(fields.data) && ["attachment_text","attachment_reference"].includes(String(fields.data.type)))) countUnrecognized(unknown, "message/block/image/malformed");
        return { ...fields, type: "image" };
      case "thinking": {
        if (typeof fields.thinking !== "string") countUnrecognized(unknown, "message/block/thinking/malformed");
        const { thinking, thinkingSignature: _signature, ...visible } = fields;
        return { ...visible, type: "thinking", text: thinking };
      }
      case "toolCall": {
        if (typeof fields.id !== "string" || typeof fields.name !== "string" || !object(fields.arguments)) countUnrecognized(unknown, "message/block/toolCall/malformed");
        const { arguments: input, thoughtSignature: _signature, ...visible } = fields;
        return { ...visible, type: "tool_use", input };
      }
      default:
        countUnrecognized(unknown, `message/block/${typeof type === "string" ? type : "(untyped)"}`);
        return value;
    }
  });
}

interface SealedSignature { path: (string | number)[]; native_field: "thinkingSignature"; encrypted_content: string }

function sealedSignatures(entry: Obj): SealedSignature[] {
  if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.flatMap((block, index) =>
    object(block) && block.type === "thinking" && block.redacted === true && typeof block.thinkingSignature === "string"
      ? [{ path: ["message", "content", index, "thinkingSignature"], native_field: "thinkingSignature" as const, encrypted_content: block.thinkingSignature }]
      : []);
}

/**
 * Pi explicitly marks provider-encrypted reasoning with redacted:true.
 * Move only that signature to a sealed sibling so normal secret redaction
 * cannot corrupt it. Other signatures still follow normal redaction rules.
 * The native path marker makes reconstructing the original entry lossless.
 */
function visibleRaw(entry: Obj): Obj {
  const signatures = sealedSignatures(entry);
  if (!signatures.length) return entry;
  const message = entry.message as Obj;
  const indices = new Set(signatures.map((signature) => signature.path[2]));
  return { ...entry, message: { ...message, content: (message.content as unknown[]).map((block, index) =>
    indices.has(index) ? { ...(block as Obj), thinkingSignature: { type: "reasoning_reference", native_entry_id: entry.id, content_index: index } } : block) } };
}

function sealedDraft(entry: Obj, ctx: RecordContext): EventDraft | null {
  const signatures = sealedSignatures(entry);
  if (!signatures.length) return null;
  return recordDraft({ ...ctx, rawFormat: "pi-reasoning-signatures/1" }, "reasoning", "agent", {
    opaque: true, native_entry_id: entry.id, parentId: entry.parentId,
    sealed_parts: signatures.map(item => ({ path: item.path, sha256: digest(item.encrypted_content) })),
  }, { native_format: RAW_FORMAT, native_entry_id: entry.id, signatures });
}

/**
 * Every persisted entry type is mapped, including context edits and hidden
 * extension state. Model API roles do not determine authorship: system,
 * tool results and extension-injected user context are never human turns.
 */
function convert(entry: Obj, ctx: RecordContext, unknown: Record<string, number>): EventDraft | null {
  const fields = entryFields(entry);
  switch (entry.type) {
    case "session":
    case "model_change":
    case "thinking_level_change":
    case "session_info":
    case "custom":
      return sessionStateDraft(ctx, entry.type, fields, entry);
    case "label":
      // Extensions can set labels too, so do not invent a human actor.
    case "usage":
      return activityDraft(ctx, entry.type, fields, entry);
    case "compaction":
    case "branch_summary": {
      const { summary, ...rest } = fields;
      return contextInjectionDraft(ctx, entry.type, { ...rest, ...textBlocks(summary) }, entry);
    }
    case "context_edit":
      return activityDraft(ctx, "context_edit", fields, entry);
    case "custom_message": {
      const { content, ...rest } = fields;
      return contextInjectionDraft(ctx, "custom_message", { ...rest, blocks: blocks(content, unknown) }, entry);
    }
    case "message": break;
    default: return null;
  }
  if (!object(entry.message)) return null;
  const message = entry.message;
  const { content, role, ...detail } = message;
  const metadata = { ...fields, ...detail, role };
  if (role === "user" || role === "assistant") {
    const draft = recordDraft(ctx, "conversation_turn", role === "user" ? "human" : "agent",
      { ...metadata, blocks: blocks(content, unknown) }, visibleRaw(entry));
    if (role === "assistant" && typeof message.model === "string" && draft.actor) {
      draft.actor.id = message.model;
    }
    return draft;
  }
  if (role === "toolResult") {
    return recordDraft(ctx, "conversation_turn", "system", {
      ...metadata, role: "tool_result",
      blocks: [{ type: "tool_result", tool_use_id: message.toolCallId, name: message.toolName,
        is_error: message.isError, content: blocks(content, unknown),
        ...(message.details !== undefined ? { details: message.details } : {}) }],
    }, entry);
  }
  if (role === "system" || role === "custom") {
    return contextInjectionDraft(ctx, `message/${role}`, {
      ...metadata, blocks: blocks(content, unknown),
    }, entry);
  }
  if (role === "bashExecution") {
    // !/!! is the human's shell command, not an assistant tool call. Keep
    // output, exit status, cancellation, truncation and context exclusion.
    return activityDraft(ctx, "message/bashExecution", { ...metadata, ...textBlocks(message.output) }, entry, "human");
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return contextInjectionDraft(ctx, `message/${role}`, { ...metadata, ...textBlocks(message.summary) }, entry);
  }
  return null;
}

function typeKey(entry: unknown): string {
  if (!object(entry)) return "(non-object)";
  if (entry.type === "message") {
    return `message/${object(entry.message) && typeof entry.message.role === "string" ? entry.message.role : "(malformed)"}`;
  }
  return typeof entry.type === "string" ? entry.type : "(untyped)";
}

/**
 * Read one explicitly provided transcript; never search the user's home.
 * Rescan the tree rather than trusting an append cursor: Pi may migrate,
 * import, or rewrite a file. Ledger identities make repeated reads safe.
 * seq is physical source order; native id/parentId preserve branching.
 */
export async function capturePiTranscript(transcriptPath: string, cwd: string, expectedCwd?: string): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { appended: 0, deduped: 0, unrecognized: {} }; // Pi delays its first flush.
    }
    throw error;
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const parsed: { value: unknown; seq: number; malformed?: true }[] = [];
  for (const [seq, line] of lines.entries()) {
    if (!line.trim()) continue;
    try { parsed.push({ value: JSON.parse(line), seq }); }
    catch {
      // A torn final write is retried in full next time. Complete malformed
      // records are preserved rather than quietly dropping a data entry.
      if (!raw.endsWith("\n") && seq === lines.length - 1) break;
      parsed.push({ value: line, seq, malformed: true });
    }
  }
  if (parsed.length === 0) return { appended: 0, deduped: 0, unrecognized: {} };
  const header = parsed[0]!.value;
  if (!object(header) || header.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new Error("Pi transcript must begin with a session header containing its native id");
  }
  if (expectedCwd !== undefined && (typeof header.cwd !== "string" || !isAbsolute(header.cwd) || resolve(header.cwd) !== expectedCwd)) {
    return { appended: 0, deduped: 0, unrecognized: {} };
  }
  const baseTime = time(header.timestamp) ?? EPOCH;
  const identity = await gitUserIdentity(repo);
  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  const version = packageVersion();
  const drafts: EventDraft[] = [];
  const contexts = new Map<string, ProducerAgentContext>();
  let legacyContext: ProducerAgentContext = {};
  for (const { value, seq, malformed } of parsed) {
    const entry = object(value) ? value : undefined;
    // An abandoned branch's model must never leak into a new branch. Old
    // v1 sessions have no tree ids; only those use sequential inheritance.
    const agent = entry && "parentId" in entry
      ? { ...(typeof entry.parentId === "string" ? contexts.get(entry.parentId) : {}) }
      : { ...legacyContext };
    if (entry?.type === "model_change") {
      if (typeof entry.modelId === "string") agent.model = entry.modelId;
      if (typeof entry.provider === "string") agent.provider = entry.provider;
    }
    if (entry && object(entry.message) && entry.message.role === "assistant") {
      if (typeof entry.message.model === "string") agent.model = entry.message.model;
      if (typeof entry.message.provider === "string") agent.provider = entry.message.provider;
    }
    if (entry && typeof entry.id === "string") contexts.set(entry.id, agent);
    legacyContext = agent;
    const ctx: RecordContext = {
      occurredAt: time(entry?.timestamp) ?? (entry && object(entry.message) ? time(entry.message.timestamp) : undefined) ?? baseTime,
      source: "pi", sessionId: header.id, seq, version, rawFormat: RAW_FORMAT,
      conversationId: `pi:${header.id}`, identity, agent,
    };
    // parentSession is a native file path, not a session id. Retain it on
    // the header without reading arbitrary parent paths or guessing ids.
    const nested: Record<string,number> = {};
    const draft = entry ? convert(entry, ctx, nested) : null;
    for (const [key,count] of Object.entries(nested)) result.unrecognized[key] = (result.unrecognized[key] ?? 0) + count;
    if (draft) {
      drafts.push(draft);
      if (Object.keys(nested).length && entry) {
        const preserved = unknownDraft(visibleRaw(entry), "nested/message", ctx);
        preserved.content = { ...preserved.content as object, unrecognized_types: nested };
        drafts.push(preserved);
      }
      const sealed = entry ? sealedDraft(entry, ctx) : null;
      if (sealed) drafts.push(sealed);
    }
    else {
      const key = malformed ? "(malformed-json)" : typeKey(value);
      countUnrecognized(result.unrecognized, key);
      drafts.push(unknownDraft(value, key, ctx));
    }
  }
  const appended = await appendEvents(repo, drafts);
  result.appended = appended.appended.length;
  result.deduped = appended.deduped;
  warnUnrecognized("pi", result.unrecognized);
  return result;
}

export async function runPiHook(stdinJson: string): Promise<void> {
  try {
    const payload: unknown = JSON.parse(stdinJson);
    if (!object(payload) || typeof payload.transcript_path !== "string") return;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    if (!(await findRepo(cwd))) return;
    await capturePiTranscript(payload.transcript_path, cwd);
  } catch (error) {
    process.stderr.write(`cledger: pi hook error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function expandPath(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(base, path);
}

async function configuredSessionDir(cwd: string): Promise<string> {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? expandPath(process.env.PI_CODING_AGENT_DIR, cwd) : join(homedir(), ".pi", "agent");
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return expandPath(process.env.PI_CODING_AGENT_SESSION_DIR, cwd);
  // Native settings paths resolve relative to the settings file directory.
  // Read only sessionDir, not auth/model configuration or other transcripts.
  for (const base of [join(cwd, ".pi"), agentDir]) {
    try {
      const settings: unknown = JSON.parse(await readFile(join(base, "settings.json"), "utf8"));
      if (object(settings) && typeof settings.sessionDir === "string" && settings.sessionDir) {
        return expandPath(settings.sessionDir, base);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", encoded);
}

/** Read only the first native header before authorizing a backfill candidate. */
async function headerCwd(path: string): Promise<string | undefined> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    if (!first) return undefined;
    const header: unknown = JSON.parse(first);
    return object(header) && header.type === "session" && typeof header.cwd === "string" && header.cwd
      ? header.cwd : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally { await file.close(); }
}

/**
 * Backfill only sessions whose native header cwd equals the requested cwd.
 * Pi's encoded directory names can collide (/a-b versus /a/b), so directory
 * membership alone is insufficient. A custom --session-dir may mix projects.
 * Symlinks and nested directories are not traversed.
 */
export async function capturePiAll(cwd: string, limit?: number, sessionDir?: string): Promise<CaptureResult> {
  const target = resolve(cwd);
  if (!(await findRepo(target))) throw new Error("not inside a git repository");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("Pi capture limit must be a non-negative integer");
  const total: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  if (limit === 0) return total;
  const directory = sessionDir ? expandPath(sessionDir, target) : await configuredSessionDir(target);
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return total;
    throw error;
  }
  const candidates: { path: string; modified: number }[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const path = join(directory, file.name);
    try {
      const nativeCwd = await headerCwd(path);
      if (!nativeCwd || !isAbsolute(nativeCwd)) continue;
      if (resolve(nativeCwd) !== target) continue;
      candidates.push({ path, modified: (await stat(path)).mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  for (const candidate of candidates.slice(0, limit)) {
    mergeCaptureResult(total, await capturePiTranscript(candidate.path, target, target));
  }
  return total;
}

export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null {
  if (!event.raw || !event.stream || !object(event.raw.data)) return null;
  const agent: ProducerAgentContext = {};
  if (event.producer.model) agent.model = event.producer.model;
  if (event.producer.provider) agent.provider = event.producer.provider;
  const nested: Record<string,number> = {};
  const draft = convert(event.raw.data, {
    occurredAt: event.occurred_at, source: "pi", sessionId: event.producer.session_id ?? "",
    seq: event.stream.seq, version: packageVersion(), rawFormat: RAW_FORMAT,
    conversationId: event.stream.id, identity, agent,
  }, nested);
  return Object.keys(nested).length ? null : draft;
}

/** Replay upgrades must retain both visible records and sealed signatures. */
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
  const visible = renormalizeUnrecognized(event, identity);
  if (!visible || !event.raw || !object(event.raw.data) || !event.stream) return null;
  const sealed = sealedDraft(event.raw.data, {
    occurredAt: event.occurred_at, source: "pi", sessionId: event.producer.session_id ?? "",
    seq: event.stream.seq, version: packageVersion(), rawFormat: RAW_FORMAT,
    conversationId: event.stream.id, identity,
    agent: { ...(event.producer.model ? { model: event.producer.model } : {}), ...(event.producer.provider ? { provider: event.producer.provider } : {}) },
  });
  return sealed ? [visible, sealed] : [visible];
}
