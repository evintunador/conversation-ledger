import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity, type RepoInfo } from "../git.js";
import { appendEvents } from "../store.js";
import type { Actor, EventDraft, EvidenceEvent, ProducerAgentContext } from "../schema.js";
import {
  countUnrecognized,
  reasoningDraft,
  unrecognizedDraft,
  warnUnrecognized,
  type CaptureResult,
} from "./drift.js";
import {
  activityDraft,
  liftText,
  sessionStateDraft,
  type RecordContext,
} from "./records.js";

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
 * Line types recorded as `session_state` — what the session declares about
 * the environment a turn ran in.
 *
 * `turn_context` is the valuable one and was the most expensive omission:
 * it states the sandbox policy, the approval policy, the reasoning effort,
 * the workspace roots and the model for every turn. A consumer asking "was
 * this agent allowed to write files when it said that" had no way to answer
 * before. `session_meta` states the originator and history mode; `world_state`
 * states the environment and instruction set codex assembled.
 */
const SESSION_STATE_LINE_TYPES = new Set(["session_meta", "turn_context", "world_state"]);

/**
 * Line types recorded as `activity`.
 *
 * `compacted` carries the replacement history codex swapped in for the real
 * conversation. It overlaps with the messages it replaces, and it is kept
 * anyway: it is the only record of *what the model could still see* after a
 * compaction, which is not recoverable from the turns it summarizes.
 */
const ACTIVITY_LINE_TYPES = new Set(["compacted", "inter_agent_communication_metadata"]);

/**
 * `event_msg` payload types that genuinely duplicate a `response_item` — the
 * same message, written twice, once for the UI stream and once for the model
 * transcript. These are the only lines this adapter still drops outright, and
 * the reason it can: the content is not lost, it is captured from the
 * response_item that carries it.
 *
 * Every other `event_msg` payload — token counts, task lifecycle, sub-agent
 * activity, patch application, aborts, rollbacks — has no response_item twin
 * and is recorded as `activity`.
 */
const DUPLICATE_EVENT_MSG_TYPES = new Set(["agent_message", "user_message"]);

/** `event_msg` payloads that declare settings rather than report an event. */
const STATE_EVENT_MSG_TYPES = new Set(["thread_settings_applied"]);

/**
 * Line types that state agent facts (model, provider, CLI version) about the
 * response_items that follow them. They are read for `producer` metadata on
 * every line that follows, *and* recorded as `session_state` events in their
 * own right — the rolling context answers "which model served this turn",
 * while the event answers "what did the session declare, and when".
 */
const CONTEXT_LINE_TYPES = new Set(["session_meta", "turn_context"]);

/**
 * Rolling agent context while scanning a rollout file. Unlike claude-code,
 * codex does not stamp each response_item with the model that produced it:
 * `session_meta` (once, at the top) states the CLI version and provider, and
 * `turn_context` (once per turn, and re-emitted when the user switches model
 * or effort mid-session) states the model. So the facts for a given line are
 * whatever the most recent such line established — pure function of the file
 * prefix, hence identical on every rescan.
 */
type CodexAgentState = ProducerAgentContext;

/**
 * Fold one line's agent facts into the rolling state. Fields are only ever
 * overwritten by a later line that restates them, so a `turn_context` that
 * omits `model` leaves the previous model standing (which is what codex
 * means by omitting it).
 */
function applyContextLine(state: CodexAgentState, line: CodexRolloutLine): void {
  const payload = line.payload;
  // Callers reach this via a cheap substring pre-filter, which a conversation
  // that merely talks *about* these line types also passes — so the type
  // check here is load-bearing, not a formality.
  if (!payload || typeof line.type !== "string" || !CONTEXT_LINE_TYPES.has(line.type)) return;
  if (line.type === "session_meta") {
    const cliVersion = payload["cli_version"];
    if (typeof cliVersion === "string" && cliVersion) state.source_version = cliVersion;
    const provider = payload["model_provider"];
    if (typeof provider === "string" && provider) state.provider = provider;
  }
  // `model` is read from either line type: turn_context is where it normally
  // lives, but session_meta has carried it in some codex versions.
  const model = payload["model"];
  if (typeof model === "string" && model) state.model = model;
}

/** Parse a line only if it could plausibly be a context line. */
function parseIfContextLine(text: string): CodexRolloutLine | null {
  if (!text.includes('"session_meta"') && !text.includes('"turn_context"')) return null;
  try {
    return JSON.parse(text) as CodexRolloutLine;
  } catch {
    return null;
  }
}

/**
 * The agent context in force at `cursor`, i.e. the state the forward scan
 * should start from.
 *
 * Two separate problems are solved here, both of which otherwise leave real
 * events unlabelled:
 *
 * 1. *Resumed captures.* Incremental captures start mid-file, so a plain
 *    forward scan would never see `session_meta` (line 0) and would miss every
 *    `turn_context` from earlier turns — every event after the first batch
 *    would lose its model. So the prefix is re-read. It costs only JSON
 *    parsing of the few lines that could possibly be context lines: the whole
 *    file is already read and split by the caller, and the substring guard
 *    skips parsing for the overwhelming majority of them.
 *
 * 2. *Context lines that trail the items they describe.* Codex does not emit
 *    `turn_context` before the turn's opening messages — in real rollouts it
 *    lands a few lines in, after the first user message has already been
 *    written. A strictly-forward rule would therefore leave the opening
 *    message of every session with no model at all. Fields still unset after
 *    the prefix scan are seeded from the *earliest* line that states them
 *    anywhere ahead, which is not a guess: the first stated context is by
 *    construction the first turn's, and the only items preceding it belong to
 *    that same first turn. Later restatements never reach backwards — the
 *    seed fills gaps only, and the forward scan overwrites it in file order.
 */
function initialAgentContext(lines: string[], cursor: number): CodexAgentState {
  const state: CodexAgentState = {};
  for (let i = 0; i < cursor && i < lines.length; i++) {
    const line = parseIfContextLine(lines[i]!);
    if (line) applyContextLine(state, line);
  }
  for (let i = cursor; i < lines.length; i++) {
    if (state.source_version && state.provider && state.model) break;
    const line = parseIfContextLine(lines[i]!);
    if (!line) continue;
    const stated: CodexAgentState = {};
    applyContextLine(stated, line);
    // First statement wins: `stated` is a fresh object per line, so an
    // already-filled field is never clobbered by a later restatement.
    if (!state.source_version && stated.source_version) state.source_version = stated.source_version;
    if (!state.provider && stated.provider) state.provider = stated.provider;
    if (!state.model && stated.model) state.model = stated.model;
  }
  return state;
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
  return join(repo.commonDir, "conversation-ledger", "cursors", `${sanitizeId(sessionId)}.json`);
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
  await mkdir(join(repo.commonDir, "conversation-ledger", "cursors"), { recursive: true });
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
 * blocks — the same provider-withheld material as reasoning payloads.
 *
 * The two halves are split across two events at the same `seq`: the visible
 * turn this function shapes `raw` for, and a sibling `reasoning`-kind event
 * carrying the ciphertext (see `encryptedAgentMessage`). So the turn keeps
 * only a bare `{type: "encrypted_content"}` marker where a sealed block was,
 * which is what makes the split visible rather than silent — but the blob
 * itself is preserved, not dropped, exactly as a standalone `reasoning` item
 * is. The transform is a pure function of the source line, so ids stay stable
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

/**
 * The sealed half of an inter-agent message: the same line with `content`
 * reduced to its `encrypted_content` blocks, or null when there are none.
 *
 * This is what a sibling `reasoning` event stores, so the ciphertext survives
 * capture instead of being discarded. Preserving it matters for the same
 * reason a standalone `reasoning` item's does: only the originating provider
 * can decrypt it, and a consumer replaying a conversation back through that
 * provider needs the blob to reconstruct what the agent was actually working
 * from. Dropping it made inter-agent codex sessions the one place that replay
 * could not be reconstructed.
 *
 * The redaction stack exempts `.../encrypted_content` on `reasoning`-kind
 * events, so pattern-matching can never corrupt a blob it cannot read.
 */
function encryptedAgentMessage(line: CodexRolloutLine): CodexRolloutLine | null {
  const content = line.payload?.["content"];
  if (!Array.isArray(content)) return null;
  const sealed = content.filter(isEncryptedBlock);
  if (sealed.length === 0) return null;
  return { ...line, payload: { ...line.payload, content: sealed } };
}

/**
 * A `reasoning` response_item's `summary` field carries visible,
 * provider-decrypted plaintext (typically `{type: "summary_text", text}`
 * blocks per OpenAI's Responses API) when reasoning-summary mode is
 * enabled — real content, not ciphertext, unlike `encrypted_content` on the
 * same item. Returns null when there's nothing visible (summary absent or
 * empty, the common case), so the caller knows to skip the visible-turn
 * draft entirely and store only the opaque `reasoning` event.
 */
function reasoningSummaryText(summary: unknown): string | null {
  if (!Array.isArray(summary) || summary.length === 0) return null;
  const parts = summary
    .map((block) =>
      block && typeof block === "object" ? (block as Record<string, unknown>)["text"] : undefined,
    )
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * A payload's fields without its own `type` discriminator, which the record's
 * `activity_type`/`state_type` already names — keeping both would put the
 * same string in two places in one object.
 */
function payloadFields(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  const { type: _type, ...rest } = payload;
  return rest;
}

/**
 * The `RecordContext` a non-turn codex line converts under. Built identically
 * by the capture loop and the re-normalization hook so both produce the same
 * event identity for the same line.
 */
function recordContext(
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
  agent: CodexAgentState,
): RecordContext {
  return {
    occurredAt,
    source: "codex",
    sessionId,
    seq,
    version,
    rawFormat: RAW_FORMAT,
    conversationId: `codex:${sessionId}`,
    agent: { ...agent },
  };
}

/**
 * Convert a codex line that is not a `response_item` into the record it
 * deserves. Returns null for a type this adapter does not know (the caller
 * routes it to the drift path) and for the `event_msg` payloads that
 * duplicate a response_item (the caller drops those, deliberately).
 */
function convertRecordLine(line: CodexRolloutLine, ctx: RecordContext): EventDraft | null {
  const type = line.type;
  if (typeof type !== "string") return null;
  const fields = payloadFields(line.payload);

  if (SESSION_STATE_LINE_TYPES.has(type)) return sessionStateDraft(ctx, type, fields, line);
  if (ACTIVITY_LINE_TYPES.has(type)) return activityDraft(ctx, type, fields, line);

  if (type === "event_msg") {
    const payloadType = line.payload?.["type"];
    const pt = typeof payloadType === "string" ? payloadType : "(untyped)";
    if (DUPLICATE_EVENT_MSG_TYPES.has(pt)) return null;
    if (STATE_EVENT_MSG_TYPES.has(pt)) {
      return sessionStateDraft(ctx, `event_msg/${pt}`, fields, line);
    }
    // The model drove the task and sub-agent events; the harness drove the
    // rest (token accounting, patch application, rollbacks).
    const actorType = pt.startsWith("task_") || pt.startsWith("sub_agent") ? "agent" : "system";
    return activityDraft(ctx, `event_msg/${pt}`, liftText(fields, "message"), line, actorType);
  }

  return null;
}

/** Raw-only preservation event for an unrecognized codex line (see drift.ts). */
function preserve(
  typeKey: string,
  line: CodexRolloutLine,
  occurredAt: string,
  seq: number,
  sessionId: string,
  version: string,
  agent: CodexAgentState,
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
    agent: { ...agent },
  });
}

function convertLine(
  line: CodexRolloutLine,
  seq: number,
  sessionId: string,
  baseTime: string,
  version: string,
  identity: GitUserIdentity,
  agent: CodexAgentState,
): EventDraft | null {
  if (line.type !== "response_item") return null;
  const payload = line.payload;
  if (!payload) return null;
  const payloadType = payload["type"];
  // reasoning items never reach here — the capture loop diverts them to
  // reasoningDraft before calling convertLine.
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
    producer: { tool: "cledger", version, source: "codex", session_id: sessionId, ...agent },
    conversation: { id: `codex:${sessionId}`, seq },
    content,
    // /2: agent_message payloads convert (encrypted blocks omitted) — /1 dropped them.
    raw: {
      format: RAW_FORMAT,
      data: payloadType === "agent_message" ? sanitizeAgentMessageRaw(line) : line,
    },
  };
}

/**
 * Re-normalization hook (see renormalize.ts): given a preserved
 * `unrecognized` event this adapter's `producer.source` owns, try to turn its
 * stored `raw.data` into the `conversation_turn` a live capture would produce.
 *
 * Id fidelity is the whole point (see the claude-code twin for the general
 * argument). Two codex-specific inputs are not derivable from the line alone
 * and are recovered from the preserved event: the session id lives in
 * `producer.session_id`, and the `baseTime` fallback (used only when the line
 * carries no timestamp of its own) is the preserved event's `occurred_at` —
 * which is exactly the value the preservation path computed via
 * `sessionBaseTime`, i.e. what a live capture of the same rollout file would
 * compute too. The agent context is a third: it came from `session_meta` /
 * `turn_context` lines that are not in `raw.data` at all, so it is read back
 * off the preserved event's own `producer` — where the capture that preserved
 * the line already recorded it. `reasoning` payloads are never preserved as `unrecognized` in
 * the first place (they get their own `reasoning`-kind event instead), so
 * this path never reconstructs provider-withheld content into a visible
 * `conversation_turn`. Returns null when still uninterpretable.
 */
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  if (!event.raw || event.conversation === undefined) return null;
  const line = event.raw.data as CodexRolloutLine;
  const sessionId = event.producer.session_id ?? "";
  const agent: CodexAgentState = {};
  if (event.producer.source_version) agent.source_version = event.producer.source_version;
  if (event.producer.model) agent.model = event.producer.model;
  if (event.producer.provider) agent.provider = event.producer.provider;
  const version = packageVersion();
  const turn = convertLine(
    line,
    event.conversation.seq,
    sessionId,
    event.occurred_at,
    version,
    identity,
    agent,
  );
  if (turn) return turn;
  // Non-turn types this adapter has since learned (`world_state`,
  // `inter_agent_communication_metadata`, and any `event_msg` that reached a
  // ledger before it was captured) re-normalize into their record kind.
  return convertRecordLine(
    line,
    recordContext(event.occurred_at, event.conversation.seq, sessionId, version, agent),
  );
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
  const agent = initialAgentContext(lines, cursor);
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
    // Context lines precede the items they describe, so fold them in before
    // this iteration can emit anything.
    if (CONTEXT_LINE_TYPES.has(type)) applyContextLine(agent, parsed);
    const occurredAt = typeof parsed.timestamp === "string" ? parsed.timestamp : baseTime;
    if (type === "response_item") {
      const payloadType = parsed.payload?.["type"];
      const pt = typeof payloadType === "string" ? payloadType : "(untyped)";
      if (pt === "reasoning") {
        const summaryText = reasoningSummaryText(parsed.payload?.["summary"]);
        if (summaryText) {
          // Visible half: a normal conversation_turn, shown in log/show like
          // any other turn. Same seq as the sibling opaque event below —
          // distinct kinds keep their ids from colliding.
          drafts.push({
            kind: "conversation_turn",
            occurred_at: occurredAt,
            actor: { type: "agent" },
            producer: {
              tool: "cledger",
              version,
              source: "codex",
              session_id: sessionId,
              ...agent,
            },
            conversation: { id: `codex:${sessionId}`, seq: i },
            content: { role: "reasoning_summary", blocks: [{ type: "text", text: summaryText }] },
          });
        }
        drafts.push(
          reasoningDraft({
            line: parsed,
            occurredAt,
            source: "codex",
            sessionId,
            seq: i,
            version,
            rawFormat: RAW_FORMAT,
            conversationId: `codex:${sessionId}`,
            agent: { ...agent },
          }),
        );
        continue;
      }
      if (!CONVERTIBLE_RESPONSE_TYPES.has(pt)) {
        const typeKey = `response_item/${pt}`;
        countUnrecognized(result.unrecognized, typeKey);
        drafts.push(preserve(typeKey, parsed, occurredAt, i, sessionId, version, agent));
        continue;
      }
    } else {
      const record = convertRecordLine(parsed, recordContext(occurredAt, i, sessionId, version, agent));
      if (record) {
        drafts.push(record);
        continue;
      }
      // Either an `event_msg` payload that duplicates a response_item (drop,
      // silently — it is captured from its twin) or a type this adapter does
      // not know (preserve raw and warn).
      if (type === "event_msg") continue;
      countUnrecognized(result.unrecognized, type);
      drafts.push(preserve(type, parsed, occurredAt, i, sessionId, version, agent));
      continue;
    }
    const draft = convertLine(parsed, i, sessionId, baseTime, version, identity, agent);
    if (draft) drafts.push(draft);

    // An inter-agent message's encrypted blocks ride alongside the visible
    // turn as a sealed sibling at the same seq — the same pairing a reasoning
    // item with a populated summary uses. Distinct kinds keep the two ids from
    // colliding.
    if (draft && parsed.payload?.["type"] === "agent_message") {
      const sealed = encryptedAgentMessage(parsed);
      if (sealed) {
        drafts.push(
          reasoningDraft({
            line: sealed,
            occurredAt: typeof parsed.timestamp === "string" ? parsed.timestamp : baseTime,
            source: "codex",
            sessionId,
            seq: i,
            version,
            rawFormat: RAW_FORMAT,
            conversationId: `codex:${sessionId}`,
            agent: { ...agent },
          }),
        );
      }
    }
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
