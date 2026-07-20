import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft } from "../schema.js";
import {
  countUnrecognized,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";

const RAW_FORMAT = "codex-rollout-jsonl/2";

/** Codex CLI hooks-engine payload (subset we read). */
interface CodexHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  turn_id?: string;
}

/** One line of a `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` file. */
interface CodexRolloutLine {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

const CONVERTIBLE_RESPONSE_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "agent_message",
]);

/**
 * Line types we deliberately do not capture: session/turn bookkeeping and
 * the event_msg UI stream (whose conversation content duplicates
 * response_item lines). Anything else is unrecognized — likely new upstream
 * content — and counted for the drift warning; same for response_item
 * payload types outside CONVERTIBLE_RESPONSE_TYPES (except reasoning,
 * which is encrypted/opaque and skipped by policy).
 */
const KNOWN_SKIPPED_LINE_TYPES = new Set([
  "session_meta",
  "turn_context",
  "compacted",
  "event_msg",
  "world_state",
  "inter_agent_communication_metadata",
]);

const KNOWN_SKIPPED_RESPONSE_TYPES = new Set(["reasoning"]);

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function cursorPath(repo: RepoInfo, sessionId: string): string {
  return join(repo.gitDir, "conversation-ledger", "cursors", `${sanitizeId(sessionId)}.json`);
}

async function readCursor(repo: RepoInfo, sessionId: string): Promise<number> {
  try {
    const raw = await readFile(cursorPath(repo, sessionId), "utf8");
    const data = JSON.parse(raw) as { lines?: number };
    return typeof data.lines === "number" ? data.lines : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(repo: RepoInfo, sessionId: string, lines: number): Promise<void> {
  const path = cursorPath(repo, sessionId);
  await mkdir(join(repo.gitDir, "conversation-ledger", "cursors"), { recursive: true });
  await writeFile(path, JSON.stringify({ lines }) + "\n");
}

/** Extract the trailing uuid from `rollout-<ts>-<uuid>.jsonl`, else the bare filename. */
function sessionIdFromFilename(transcriptPath: string): string {
  const name = basename(transcriptPath, ".jsonl");
  const match = name.match(/rollout-.*-([0-9a-fA-F-]{36})$/);
  return match?.[1] ?? name;
}

/** `rollout-YYYY-MM-DDThh-mm-ss-*.jsonl` timestamp, else file mtime, else now. */
async function sessionBaseTime(transcriptPath: string): Promise<string> {
  const match = basename(transcriptPath).match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  if (match?.[1]) {
    const iso = `${match[1].slice(0, 10)}T${match[1].slice(11).replace(/-/g, ":")}Z`;
    if (!Number.isNaN(Date.parse(iso))) return new Date(iso).toISOString();
  }
  try {
    return (await stat(transcriptPath)).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function convertMessageBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b["type"] === "input_text" || b["type"] === "output_text") {
        return { type: "text", text: b["text"] };
      }
    }
    return block;
  });
}

function isEncryptedBlock(block: unknown): boolean {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as Record<string, unknown>)["type"] === "encrypted_content"
  );
}

/**
 * Inter-agent messages mix visible input_text blocks with encrypted_content
 * blocks — the same provider-withheld material as reasoning payloads, which
 * policy says is skipped, not stored, never reconstructed. Visible blocks
 * convert normally; encrypted blocks are dropped, leaving a bare
 * {type: "encrypted_content"} marker in `raw` so the omission is visible.
 * The transform is a pure function of the source line, so ids stay stable
 * across rescans.
 */
function sanitizeAgentMessageRaw(line: CodexRolloutLine): CodexRolloutLine {
  const content = line.payload?.["content"];
  if (!Array.isArray(content) || !content.some(isEncryptedBlock)) return line;
  return {
    ...line,
    payload: {
      ...line.payload,
      content: content.map((b) => (isEncryptedBlock(b) ? { type: "encrypted_content" } : b)),
    },
  };
}

/** Raw-only preservation event for an unrecognized codex line (see drift.ts). */
function preserve(
  typeKey: string,
  line: CodexRolloutLine,
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
): EventDraft {
  return unrecognizedDraft({
    typeKey,
    line,
    occurredAt,
    source: "codex",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: `codex:${sessionId}`,
  });
}

function convertLine(
  line: CodexRolloutLine,
  seq: number,
  sessionId: string,
  baseTime: string,
  version: string,
  identity: GitUserIdentity,
): EventDraft | null {
  if (line.type !== "response_item") return null;
  const payload = line.payload;
  if (!payload) return null;
  const payloadType = payload["type"];
  // reasoning items are encrypted/opaque by design and must never be stored
  if (payloadType === "reasoning") return null;
  if (typeof payloadType !== "string" || !CONVERTIBLE_RESPONSE_TYPES.has(payloadType)) return null;

  const occurredAt = typeof line.timestamp === "string" ? line.timestamp : baseTime;

  let actor: Actor;
  let content: { role: string; blocks: unknown[] };

  if (payloadType === "message") {
    const role = payload["role"];
    const roleStr = typeof role === "string" ? role : "user";
    actor = roleStr === "assistant" ? { type: "agent" } : { type: "human" };
    if (actor.type === "human") {
      if (identity.email) actor.id = identity.email;
      if (identity.name) actor.display = identity.name;
    }
    content = { role: roleStr, blocks: convertMessageBlocks(payload["content"]) };
  } else if (payloadType === "agent_message") {
    actor = { type: "agent" };
    if (typeof payload["author"] === "string") actor.id = payload["author"];
    const rawBlocks = payload["content"];
    const visible = Array.isArray(rawBlocks) ? rawBlocks.filter((b) => !isEncryptedBlock(b)) : [];
    content = {
      role: "agent_message",
      ...(typeof payload["author"] === "string" ? { author: payload["author"] } : {}),
      ...(typeof payload["recipient"] === "string" ? { recipient: payload["recipient"] } : {}),
      blocks: convertMessageBlocks(visible),
    } as { role: string; blocks: unknown[] };
  } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    actor = { type: "agent" };
    const block: Record<string, unknown> = { type: "tool_use" };
    if (typeof payload["name"] === "string") block["name"] = payload["name"];
    const input = payload["arguments"] ?? payload["input"];
    if (input !== undefined) block["input"] = input;
    if (typeof payload["call_id"] === "string") block["id"] = payload["call_id"];
    content = { role: "assistant", blocks: [block] };
  } else {
    // function_call_output / custom_tool_call_output
    actor = { type: "system" };
    content = {
      role: "tool_result",
      blocks: [{ type: "tool_result", tool_use_id: payload["call_id"], content: payload["output"] }],
    };
  }

  return {
    kind: "conversation_turn",
    occurred_at: occurredAt,
    actor,
    producer: { tool: "cledger", version, source: "codex", session_id: sessionId },
    conversation: { id: `codex:${sessionId}`, seq },
    content,
    // /2: agent_message payloads convert (encrypted blocks omitted) — /1 dropped them.
    raw: {
      format: RAW_FORMAT,
      data: payloadType === "agent_message" ? sanitizeAgentMessageRaw(line) : line,
    },
  };
}

export async function runCodexHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as CodexHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    if (!payload.transcript_path) return;
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    await captureCodexTranscript(payload.transcript_path, cwd);
  } catch (err) {
    process.stderr.write(
      `cledger: codex hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export async function captureCodexTranscript(
  transcriptPath: string,
  cwd: string,
): Promise<CaptureResult> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");

  const result: CaptureResult = { appended: 0, deduped: 0, unrecognized: {} };
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return result; // transcript not written yet
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let sessionId = sessionIdFromFilename(transcriptPath);
  if (lines[0]) {
    try {
      const first = JSON.parse(lines[0]) as CodexRolloutLine;
      const metaId = first.payload?.["session_id"];
      if (first.type === "session_meta" && typeof metaId === "string") sessionId = metaId;
    } catch {
      // malformed first line — filename-derived id already set
    }
  }

  let cursor = await readCursor(repo, sessionId);
  if (cursor > lines.length) cursor = 0; // transcript is shorter than expected — rescan from the start

  const baseTime = await sessionBaseTime(transcriptPath);
  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  const drafts: EventDraft[] = [];
  for (let i = cursor; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    let parsed: CodexRolloutLine;
    try {
      parsed = JSON.parse(text) as CodexRolloutLine;
    } catch {
      continue; // partial line — normal at the tail of a live transcript
    }
    const type = typeof parsed.type === "string" ? parsed.type : "(untyped)";
    const occurredAt = typeof parsed.timestamp === "string" ? parsed.timestamp : baseTime;
    if (type === "response_item") {
      const payloadType = parsed.payload?.["type"];
      const pt = typeof payloadType === "string" ? payloadType : "(untyped)";
      if (!CONVERTIBLE_RESPONSE_TYPES.has(pt) && !KNOWN_SKIPPED_RESPONSE_TYPES.has(pt)) {
        const typeKey = `response_item/${pt}`;
        countUnrecognized(result.unrecognized, typeKey);
        drafts.push(preserve(typeKey, parsed, occurredAt, i, sessionId, version));
        continue;
      }
    } else if (!KNOWN_SKIPPED_LINE_TYPES.has(type)) {
      countUnrecognized(result.unrecognized, type);
      drafts.push(preserve(type, parsed, occurredAt, i, sessionId, version));
      continue;
    }
    const draft = convertLine(parsed, i, sessionId, baseTime, version, identity);
    if (draft) drafts.push(draft);
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  await writeCursor(repo, sessionId, lines.length);
  process.stderr.write(`cledger: codex +${result.appended} events (${result.deduped} deduped)\n`);
  warnUnrecognized("codex", result.unrecognized);
  return result;
}
