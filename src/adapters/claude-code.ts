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

const CONVERTIBLE_LINE_TYPES = new Set(["user", "assistant"]);

const RAW_FORMAT = "claude-code-jsonl/1";

/**
 * Line types we deliberately do not capture: session bookkeeping, UI state,
 * and file-history machinery, not visible conversation content. A parsed
 * line whose type is in neither set is *unrecognized* — likely new upstream
 * content — and gets counted for the drift warning.
 */
const KNOWN_SKIPPED_LINE_TYPES = new Set([
  "system",
  "summary",
  "progress",
  "attachment",
  "mode",
  "permission-mode",
  "ai-title",
  "last-prompt",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
]);

/** Claude Code hooks-engine payload (subset we read). */
interface ClaudeCodeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

/** One line of a `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl` transcript. */
interface ClaudeTranscriptLine {
  type?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

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

function convertContentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(convertBlock);
}

function convertBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const b = block as Record<string, unknown>;
  if (b["type"] === "thinking") {
    // signature is a provider-internal verification token, not visible content
    return { type: "thinking", text: b["thinking"] };
  }
  // text / tool_use / tool_result / unknown block shapes pass through verbatim
  return b;
}

/**
 * A deterministic session time for preserving unrecognized lines that carry
 * no timestamp of their own: the first timestamp anywhere in the transcript
 * (stable across rescans), falling back to the file mtime. Claude lines
 * almost always carry a timestamp, so this is a rarely-hit safety net.
 */
function firstTimestamp(lines: string[]): string | null {
  for (const text of lines) {
    if (!text.trim()) continue;
    try {
      const parsed = JSON.parse(text) as ClaudeTranscriptLine;
      if (typeof parsed.timestamp === "string" && !Number.isNaN(Date.parse(parsed.timestamp))) {
        return parsed.timestamp;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** File mtime as ISO, else now — last-resort deterministic-ish base time. */
async function sessionMtime(transcriptPath: string): Promise<string> {
  try {
    return (await stat(transcriptPath)).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Raw-only preservation event for an unrecognized claude-code line (see drift.ts). */
function preserve(
  type: string,
  line: ClaudeTranscriptLine,
  occurredAt: string,
  seq: number,
  fileSessionId: string,
  version: string,
): EventDraft {
  const sessionId = line.sessionId ?? fileSessionId;
  return unrecognizedDraft({
    typeKey: type,
    line,
    occurredAt,
    source: "claude-code",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: `claude-code:${sessionId}`,
  });
}

function convertLine(
  line: ClaudeTranscriptLine,
  seq: number,
  version: string,
  identity: GitUserIdentity,
): EventDraft | null {
  if (line.type !== "user" && line.type !== "assistant") return null;
  if (line.isSidechain === true) return null;
  if (!line.message) return null;
  if (typeof line.timestamp !== "string") return null;
  const sessionId = line.sessionId ?? "";

  const actor: Actor = line.type === "user" ? { type: "human" } : { type: "agent" };
  if (line.type === "user") {
    if (identity.email) actor.id = identity.email;
    if (identity.name) actor.display = identity.name;
  }
  if (line.type === "assistant" && line.message.model) actor.id = line.message.model;

  return {
    kind: "conversation_turn",
    occurred_at: line.timestamp,
    actor,
    producer: { tool: "cledger", version, source: "claude-code", session_id: sessionId },
    conversation: { id: `claude-code:${sessionId}`, seq },
    content: { role: line.message.role, blocks: convertContentBlocks(line.message.content) },
    raw: { format: RAW_FORMAT, data: line },
  };
}

export async function runClaudeCodeHook(stdinJson: string): Promise<void> {
  try {
    const payload = JSON.parse(stdinJson) as ClaudeCodeHookPayload;
    const cwd = payload.cwd ?? process.cwd();
    if (!payload.transcript_path) return;
    const repo = await findRepo(cwd);
    if (!repo) return; // hooks must never break the user's session outside a repo
    await captureClaudeTranscript(payload.transcript_path, cwd);
  } catch (err) {
    process.stderr.write(
      `cledger: claude-code hook error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export async function captureClaudeTranscript(
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

  const sessionId = basename(transcriptPath, ".jsonl");
  let cursor = await readCursor(repo, sessionId);
  if (cursor > lines.length) cursor = 0; // transcript is shorter than expected — rescan from the start

  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
  let baseTime: string | null = null; // computed lazily, only if a timestampless unrecognized line needs it
  const drafts: EventDraft[] = [];
  for (let i = cursor; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    let parsed: ClaudeTranscriptLine;
    try {
      parsed = JSON.parse(text) as ClaudeTranscriptLine;
    } catch {
      continue; // partial line — normal at the tail of a live transcript
    }
    const type = typeof parsed.type === "string" ? parsed.type : "(untyped)";
    if (!CONVERTIBLE_LINE_TYPES.has(type)) {
      if (!KNOWN_SKIPPED_LINE_TYPES.has(type)) {
        countUnrecognized(result.unrecognized, type);
        if (baseTime === null) baseTime = firstTimestamp(lines) ?? (await sessionMtime(transcriptPath));
        const occurredAt = typeof parsed.timestamp === "string" ? parsed.timestamp : baseTime;
        drafts.push(preserve(type, parsed, occurredAt, i, sessionId, version));
      }
      continue;
    }
    const draft = convertLine(parsed, i, version, identity);
    if (draft) drafts.push(draft);
  }

  if (drafts.length > 0) {
    const appendResult = await appendEvents(repo, drafts);
    result.appended = appendResult.appended.length;
    result.deduped = appendResult.deduped;
  }
  await writeCursor(repo, sessionId, lines.length);
  process.stderr.write(
    `cledger: claude-code +${result.appended} events (${result.deduped} deduped)\n`,
  );
  warnUnrecognized("claude-code", result.unrecognized);
  return result;
}
