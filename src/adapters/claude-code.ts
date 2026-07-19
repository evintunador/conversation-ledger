import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft } from "../schema.js";

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
    raw: { format: "claude-code-jsonl/1", data: line },
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

export async function captureClaudeTranscript(transcriptPath: string, cwd: string): Promise<void> {
  const repo = await findRepo(cwd);
  if (!repo) throw new Error("not inside a git repository");

  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return; // transcript not written yet
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sessionId = basename(transcriptPath, ".jsonl");
  let cursor = await readCursor(repo, sessionId);
  if (cursor > lines.length) cursor = 0; // transcript is shorter than expected — rescan from the start

  const version = packageVersion();
  const identity = await gitUserIdentity(repo);
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
    const draft = convertLine(parsed, i, version, identity);
    if (draft) drafts.push(draft);
  }

  let appended = 0;
  let deduped = 0;
  if (drafts.length > 0) {
    const result = await appendEvents(repo, drafts);
    appended = result.appended.length;
    deduped = result.deduped;
  }
  await writeCursor(repo, sessionId, lines.length);
  process.stderr.write(`cledger: claude-code +${appended} events (${deduped} deduped)\n`);
}
