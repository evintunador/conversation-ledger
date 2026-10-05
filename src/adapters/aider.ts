/** Explicit launch-time Aider instrumentation. Markdown histories are never parsed. */
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { runWatchedCli } from "./watched-run.js";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  findRepo,
  gitUserIdentity,
  sha256Hex,
  type GitUserIdentity,
} from "annals";
import { appendEvents } from "../store.js";
import { packageVersion } from "./common.js";
import { recordDraft, type RecordContext } from "./records.js";
import {
  unrecognizedDraft,
  countUnrecognized,
  mergeCaptureResult,
  type CaptureResult,
} from "./drift.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { AIDER_RECORDER } from "./aider-recorder.js";
const FORMAT = "cledger-aider-recorder/1";
const known = new Set([
  "session.start",
  "session.end",
  "recorder.unsupported",
  "io.user_input",
  "io.ai_output",
  "io.tool_output",
  "io.tool_error",
  "io.tool_warning",
  "io.decision",
  "file.operation",
  "file.result",
  "method.error",
  "model.request",
  "model.response",
  "model.chunk",
  "model.end",
  "model.error",
]);
const empty = (): CaptureResult => ({
  appended: 0,
  deduped: 0,
  unrecognized: {},
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const canonical = (path: string) => realpath(path).catch(() => resolve(path));
function convert(row: Record<string, unknown>, ctx: RecordContext): EventDraft {
  const type = String(row.type),
    data = row.data as Record<string, unknown>;
  if (
    !known.has(type) ||
    !object(data) ||
    (type === "io.user_input" &&
      (!object(data.arguments) || typeof data.arguments.inp !== "string")) ||
    (type === "io.ai_output" &&
      (!object(data.arguments) || typeof data.arguments.content !== "string"))
  )
    return unrecognizedDraft({ ...ctx, line: row, typeKey: type });
  const args = object(data.arguments) ? data.arguments : {};
  let actor = "system",
    kind = "activity";
  let blocks: unknown[] = [];
  if (type === "io.user_input" && typeof args.inp === "string") {
    actor = data.automatic === true ? "system" : "human";
    kind = data.automatic === true ? "context_injection" : "conversation_turn";
    blocks = [{ type: "text", text: args.inp }];
  }
  if (type === "io.ai_output" && typeof args.content === "string") {
    actor = "agent";
    kind = "conversation_turn";
    blocks = [{ type: "text", text: args.content }];
  }
  if (type === "io.tool_output" && Array.isArray(args.messages))
    blocks = args.messages.map((text) => ({
      type: "text",
      text: String(text),
    }));
  if (
    ["io.tool_warning", "io.tool_error"].includes(type) &&
    typeof args.message === "string"
  )
    blocks = [{ type: "text", text: args.message }];
  if (type === "io.decision") {
    actor = data.automatic === false ? "human" : "system";
    kind = "activity";
  }
  if (type === "model.request") kind = "context_injection";
  // Requests/responses are preserved snapshots, never duplicate attributed turns.
  return recordDraft(
    ctx,
    kind,
    actor,
    { event_type: type, ...data, blocks },
    row,
  );
}
export async function captureAiderTranscript(
  path: string,
  cwd: string,
): Promise<CaptureResult> {
  const out = empty(),
    repo = await findRepo(cwd);
  if (!repo) return out;
  const raw = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const lines = raw.split("\n");
  lines.pop();
  const scope = await canonical(cwd),
    identity = await gitUserIdentity(repo),
    drafts: EventDraft[] = [];
  let header: Record<string, unknown> | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown = line;
    try {
      value = JSON.parse(line);
    } catch {
      /* preserve complete corrupt lines */
    }
    const row = object(value) ? value : undefined;
    if (row?.schema === FORMAT && row.type === "session.start") header = row;
    if (
      !header ||
      typeof header.cwd !== "string" ||
      (await canonical(header.cwd)) !== scope
    )
      continue;
    if (
      row &&
      typeof row.cwd === "string" &&
      (await canonical(row.cwd)) !== scope
    )
      continue;
    const valid =
      row?.schema === FORMAT &&
      typeof row.session === "string" &&
      Number.isSafeInteger(row.seq) &&
      typeof row.timestamp === "string" &&
      Number.isFinite(Date.parse(row.timestamp)) &&
      object(row.data);
    const ctx: RecordContext = {
      occurredAt: valid
        ? (row.timestamp as string)
        : (header.timestamp as string),
      source: "aider",
      sessionId: String(header.session),
      seq: valid ? (row.seq as number) : index,
      version: packageVersion(),
      rawFormat: FORMAT,
      conversationId: `aider:${header.session}`,
      identity,
      agent: {
        source_version: String(header.version),
        ...(valid && object(row.data) && typeof row.data.model === "string"
          ? { model: row.data.model }
          : {}),
      },
    };
    if (!valid || !known.has(String(row.type))) {
      const key = valid ? String(row.type) : "invalid-record";
      countUnrecognized(out.unrecognized, key);
      const draft = unrecognizedDraft({ ...ctx, line: value, typeKey: key });
      draft.content = {
        ...(draft.content as object),
        source_record_sha256: sha256Hex(line),
      };
      drafts.push(draft);
    } else {
      const draft = convert(row, ctx);
      if (draft.kind === "unrecognized")
        countUnrecognized(out.unrecognized, String(row.type) + "/invalid-data");
      drafts.push(draft);
    }
  }
  if (drafts.length) {
    const result = await appendEvents(repo, drafts);
    out.appended = result.appended.length;
    out.deduped = result.deduped;
  }
  return out;
}
export async function captureAiderAll(
  cwd: string,
  limit?: number,
): Promise<CaptureResult> {
  const total = empty(),
    repo = await findRepo(cwd);
  if (!repo) return total;
  const directory = join(repo.commonDir, "conversation-ledger", "aider");
  const files = (await readdir(directory).catch(() => []))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  let matched = 0;
  for (const file of files) {
    const path = join(directory, file),
      first = (await readFile(path, "utf8")).split("\n")[0];
    try {
      const row = JSON.parse(first!);
      if (
        typeof row.cwd !== "string" ||
        (await canonical(row.cwd)) !== (await canonical(cwd))
      )
        continue;
    } catch {
      continue;
    }
    if (limit !== undefined && matched++ >= limit) break;
    mergeCaptureResult(total, await captureAiderTranscript(path, cwd));
  }
  return total;
}
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  const row = event.raw?.data;
  if (
    !event.raw?.format.split("+").includes(FORMAT) ||
    !object(row) ||
    !known.has(String(row.type)) ||
    !object(row.data)
  )
    return null;
  return convert(row, {
    occurredAt: event.occurred_at,
    source: "aider",
    sessionId: event.producer.session_id!,
    seq: event.stream?.seq ?? 0,
    version: packageVersion(),
    rawFormat: FORMAT,
    conversationId: event.stream?.id ?? `aider:${row.session}`,
    identity,
    agent: {
      source_version: String(row.version),
      ...(typeof row.data.model === "string" ? { model: row.data.model } : {}),
    },
  });
}
export async function runAider(
  args: string[],
  python = "python3",
): Promise<number> {
  const cwd = process.cwd(),
    repo = await findRepo(cwd);
  if (!repo) throw new Error("Aider recorder requires a Git repository");
  const directory = join(repo.commonDir, "conversation-ledger", "aider");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const session = randomUUID(),
    path = join(directory, session + ".jsonl"),
    script = join(directory, session + ".py");
  await writeFile(script, AIDER_RECORDER, { mode: 0o600 });
  return runWatchedCli(python, [script, path, session, ...args], "aider",
    ["--transcript", path], cwd, () => rm(script, { force: true }));
}
