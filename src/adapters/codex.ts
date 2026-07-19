import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { findRepo, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft } from "../schema.js";

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
]);

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

function convertLine(
  line: CodexRolloutLine,
  seq: number,
  sessionId: string,
  baseTime: string,
  version: string,
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
    content = { role: roleStr, blocks: convertMessageBlocks(payload["content"]) };
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
    raw: { format: "codex-rollout-jsonl/1", data: line },
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

export async function captureCodexTranscript(transcriptPath: string, cwd: string): Promise<void> {
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
    const draft = convertLine(parsed, i, sessionId, baseTime, version);
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
  process.stderr.write(`cledger: codex +${appended} events (${deduped} deduped)\n`);
}
