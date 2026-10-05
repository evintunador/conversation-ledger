/** Cline CLI 3.x SDK session artifacts (not legacy VS Code task history). */
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
const FORMAT = "cline-session-artifacts/1";
const empty = (): CaptureResult => ({
  appended: 0,
  deduped: 0,
  unrecognized: {},
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => (object(v) ? v : {});
const canonical = (p: string) => realpath(p).catch(() => resolve(p));
export function clineSessionsDirectory(): string {
  return (
    process.env.CLINE_SESSION_DATA_DIR ||
    join(
      process.env.CLINE_DATA_DIR ||
        join(process.env.CLINE_DIR || join(homedir(), ".cline"), "data"),
      "sessions",
    )
  );
}
const syntheticKinds = new Set([
  "auto_compaction",
  "compaction",
  "compaction_summary",
  "compaction_budget_emergency",
  "completion_reminder",
  "loop_detection_notice",
  "manual_compaction",
  "mistake_stop_notice",
  "recovery_notice",
]);
const partTypes = new Set([
  "text",
  "file",
  "image",
  "media",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
]);

function validPart(part: Record<string, unknown>): boolean {
  switch (part.type) {
    case "text":
      return typeof part.text === "string";
    case "file":
      return typeof part.content === "string" && typeof part.path === "string";
    case "image":
      return (
        (typeof part.data === "string" ||
          (object(part.data) &&
            ["attachment_reference", "attachment_text"].includes(
              String(part.data.type),
            ))) &&
        typeof part.mediaType === "string"
      );
    case "media":
      return (
        object(part.media) &&
        typeof part.media.id === "string" &&
        typeof part.media.mediaType === "string" &&
        object(part.media.source)
      );
    case "tool_use":
      return (
        typeof part.id === "string" &&
        typeof part.name === "string" &&
        object(part.input)
      );
    case "tool_result":
      return (
        typeof part.tool_use_id === "string" &&
        typeof part.name === "string" &&
        (typeof part.content === "string" || Array.isArray(part.content))
      );
    case "thinking":
      return typeof part.thinking === "string";
    case "redacted_thinking":
      return (
        typeof part.data === "string" ||
        (object(part.data) &&
          part.data.opaque === true &&
          part.data.preserved_in === "reasoning sibling")
      );
    default:
      return false;
  }
}

function sealed(value: unknown): {
  value: unknown;
  opaque: { path: string; encrypted_content: string }[];
} {
  const opaque: { path: string; encrypted_content: string }[] = [];
  function walk(v: unknown, path: string): unknown {
    if (Array.isArray(v)) return v.map((p, i) => walk(p, `${path}/${i}`));
    if (!object(v)) return v;
    if (v.type === "redacted_thinking" && typeof v.data === "string") {
      opaque.push({ path: path + "/data", encrypted_content: v.data });
      return {
        ...v,
        data: { opaque: true, preserved_in: "reasoning sibling" },
      };
    }
    return Object.fromEntries(
      Object.entries(v).map(([k, p]) => [k, walk(p, `${path}/${k}`)]),
    );
  }
  return { value: walk(value, ""), opaque };
}

function convert(
  message: Record<string, unknown>,
  ctx: RecordContext,
  origin: Record<string, unknown>,
  drift: Record<string, number>,
  restoredSourceId?: string,
): EventDraft[] {
  const sourceId =
    restoredSourceId ??
    (typeof message.id === "string"
      ? message.id
      : sha256Hex(JSON.stringify(message)));
  const raw = {
    artifact: "message",
    origin,
    message: structuredClone(message),
  };
  const invalid =
    !["user", "assistant"].includes(String(message.role)) ||
    !(typeof message.content === "string" || Array.isArray(message.content));
  if (invalid) {
    countUnrecognized(drift, "message/invalid");
    const draft = unrecognizedDraft({
      ...ctx,
      typeKey: "message/invalid",
      line: raw,
    });
    draft.content = { ...obj(draft.content), source_message_id: sourceId };
    return [draft];
  }
  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content as unknown[]);
  const blocks: unknown[] = [],
    opaque: { block: number; encrypted_content: string }[] = [],
    unknown: { index: number; value: unknown }[] = [];
  parts.forEach((part, index) => {
    if (
      !object(part) ||
      !partTypes.has(String(part.type)) ||
      !validPart(part)
    ) {
      unknown.push({ index, value: part });
      countUnrecognized(drift, `content/${obj(part).type ?? "invalid"}`);
      blocks.push(part);
      return;
    }
    if (part.type === "redacted_thinking" && typeof part.data === "string") {
      opaque.push({ block: index, encrypted_content: part.data });
      const marker = {
        ...part,
        data: { opaque: true, preserved_in: "reasoning sibling" },
      };
      blocks.push(marker);
      if (Array.isArray(raw.message.content))
        raw.message.content[index] = marker;
    } else blocks.push(part);
  });
  const metadata = obj(message.metadata),
    toolOnly =
      parts.length > 0 && parts.every((p) => obj(p).type === "tool_result");
  const injected =
    syntheticKinds.has(String(metadata.kind)) ||
    ["system", "status", "error"].includes(String(metadata.displayRole)) ||
    (typeof origin.mode === "string" && origin.mode !== "user") ||
    !!origin.parentThreadId;
  const actor =
    message.role === "assistant"
      ? metadata.displayOnly
        ? "system"
        : "agent"
      : toolOnly || injected
        ? "system"
        : "human";
  const kind =
    actor === "system" && injected ? "context_injection" : "conversation_turn";
  const draft = recordDraft(
    ctx,
    kind,
    actor,
    { ...message, content: undefined, source_message_id: sourceId, blocks },
    raw,
  );
  const result = [draft];
  if (
    message.role === "user" &&
    !toolOnly &&
    blocks.some((p) => obj(p).type === "tool_result")
  ) {
    draft.content = {
      ...obj(draft.content),
      blocks: blocks.filter((p) => obj(p).type !== "tool_result"),
    };
    result.push(
      recordDraft(
        ctx,
        "conversation_turn",
        "system",
        {
          source_message_id: sourceId,
          role: "tool_result",
          blocks: blocks.filter((p) => obj(p).type === "tool_result"),
        },
        raw,
      ),
    );
  }
  if (opaque.length)
    result.push(
      recordDraft(
        ctx,
        "reasoning",
        "agent",
        { opaque: true, source_message_id: sourceId },
        {
          artifact: "message.reasoning",
          source_message_id: sourceId,
          opaque_fields: opaque,
        },
      ),
    );
  for (const part of unknown) {
    const d = unrecognizedDraft({
      ...ctx,
      typeKey: `content/${obj(part.value).type ?? "invalid"}`,
      line: {
        artifact: "message.part",
        origin,
        message: raw.message,
        block_index: part.index,
      },
    });
    d.content = {
      ...obj(d.content),
      source_message_id: sourceId,
      block_index: part.index,
    };
    result.push(d);
  }
  return result;
}

/** Accept a root manifest, messages file, or native session directory. */
export async function captureClineTranscript(
  path: string,
  cwd: string,
): Promise<CaptureResult> {
  if (
    ["api_conversation_history.json", "ui_messages.json"].includes(
      basename(path),
    )
  )
    throw new Error(
      "Legacy Cline task history is unsupported; this adapter captures Cline CLI3 SDK session artifacts",
    );
  const total = empty(),
    repo = await findRepo(cwd);
  if (!repo) return total;
  const directory = path.endsWith(".json") ? dirname(path) : path;
  const files = await readdir(directory).catch(() => []);
  const manifests: Record<string, unknown>[] = [];
  for (const file of files.filter(
    (f) =>
      f.endsWith(".json") &&
      !f.endsWith(".messages.json") &&
      !f.endsWith(".compaction.json"),
  )) {
    try {
      const m = JSON.parse(await readFile(join(directory, file), "utf8"));
      if (
        object(m) &&
        m.version === 1 &&
        typeof m.session_id === "string" &&
        typeof m.cwd === "string"
      )
        manifests.push(m);
    } catch {
      /* incomplete native rewrite */
    }
  }
  const scope = await canonical(cwd),
    manifest =
      manifests.find((m) => m.session_id === basename(directory)) ??
      manifests[0];
  if (!manifest || (await canonical(String(manifest.cwd))) !== scope)
    return total;
  const session = String(manifest.session_id),
    identity = await gitUserIdentity(repo),
    drafts: EventDraft[] = [];
  const date =
    typeof manifest.started_at === "string" &&
    Number.isFinite(Date.parse(manifest.started_at))
      ? manifest.started_at
      : "1970-01-01T00:00:00Z";
  const context = (
    id: string,
    seq: number,
    time = date,
    agent: Record<string, string> = {},
    parent?: string,
  ): RecordContext => ({
    occurredAt: time,
    source: "cline",
    sessionId: id,
    seq,
    version: packageVersion(),
    rawFormat: FORMAT,
    conversationId: `cline:${id}`,
    ...(parent ? { parentConversationId: `cline:${parent}` } : {}),
    identity,
    agent,
  });
  for (const m of manifests) {
    if ((await canonical(String(m.cwd))) !== scope) continue;
    const id = String(m.session_id);
    drafts.push(
      recordDraft(
        context(
          id,
          0,
          typeof m.started_at === "string" &&
            Number.isFinite(Date.parse(m.started_at))
            ? m.started_at
            : date,
        ),
        "state_declaration",
        "system",
        { state_type: "session.manifest", ...m },
        { artifact: "manifest", data: m },
      ),
    );
  }
  for (const file of files.filter(
    (f) => f.endsWith(".messages.json") || f.endsWith(".compaction.json"),
  )) {
    let payload: unknown;
    const bytes = await readFile(join(directory, file), "utf8").catch(() => "");
    if (!bytes) continue;
    try {
      payload = JSON.parse(bytes);
    } catch {
      countUnrecognized(total.unrecognized, "artifact/malformed-json");
      const ctx = context(session, 0);
      const d = unrecognizedDraft({
        ...ctx,
        typeKey: "artifact/malformed-json",
        line: bytes,
      });
      d.content = {
        ...obj(d.content),
        artifact: file,
        source_sha256: sha256Hex(bytes),
      };
      drafts.push(d);
      continue;
    }
    const value = obj(payload),
      isCompaction = file.endsWith(".compaction.json");
    const id = typeof value.sessionId === "string" ? value.sessionId : session;
    // Child message artifacts live in the root directory, while their own
    // manifest may live in a sibling session directory. Honor its actual cwd.
    if (id !== session && /^[-\w.]+$/.test(id)) {
      const childPath = join(dirname(directory), id, id + ".json");
      try {
        const child = JSON.parse(await readFile(childPath, "utf8"));
        if (
          object(child) &&
          child.session_id === id &&
          typeof child.cwd === "string"
        ) {
          if ((await canonical(child.cwd)) !== scope) continue;
          const childDate =
            typeof child.started_at === "string" &&
            Number.isFinite(Date.parse(child.started_at))
              ? child.started_at
              : date;
          drafts.push(
            recordDraft(
              context(id, 0, childDate),
              "state_declaration",
              "system",
              { state_type: "session.manifest", ...child },
              { artifact: "manifest", data: child },
            ),
          );
        }
      } catch {
        /* Older child artifacts have only the root manifest. */
      }
    }
    const origin = obj(value.origin),
      parent =
        typeof origin.parentThreadId === "string"
          ? origin.parentThreadId
          : undefined;
    const sourceVersion =
      typeof origin.version === "string"
        ? { source_version: origin.version }
        : {};
    const ctx = context(id, 0, date, sourceVersion, parent);
    if (value.version !== 1 || !Array.isArray(value.messages)) {
      countUnrecognized(total.unrecognized, "artifact/invalid");
      const d = unrecognizedDraft({
        ...ctx,
        typeKey: "artifact/invalid",
        line: payload,
      });
      d.content = {
        ...obj(d.content),
        artifact: file,
        source_sha256: sha256Hex(JSON.stringify(payload)),
      };
      drafts.push(d);
      continue;
    }
    if (isCompaction) {
      const safe = sealed(value);
      drafts.push(
        recordDraft(
          ctx,
          "context_injection",
          "system",
          { injection_type: "compaction", ...obj(safe.value) },
          { artifact: "compaction", data: safe.value },
        ),
      );
      if (safe.opaque.length)
        drafts.push(
          recordDraft(
            ctx,
            "reasoning",
            "agent",
            { opaque: true },
            { artifact: "compaction.reasoning", opaque_fields: safe.opaque },
          ),
        );
      continue;
    }
    // Keep file metadata separate from turns; updated_at is a writer timestamp, not a message timestamp.
    const { messages, updated_at, ...header } = value;
    drafts.push(
      recordDraft(
        ctx,
        "state_declaration",
        "system",
        { state_type: "messages.header", ...header },
        { artifact: "messages.header", data: header },
      ),
    );
    if (typeof value.system_prompt === "string")
      drafts.push(
        recordDraft(
          ctx,
          "context_injection",
          "system",
          {
            injection_type: "system_prompt",
            blocks: [{ type: "text", text: value.system_prompt }],
          },
          { artifact: "system_prompt", text: value.system_prompt },
        ),
      );
    const occurrences = new Map<string, number>();
    for (let index = 0; index < (messages as unknown[]).length; index++) {
      const message = (messages as unknown[])[index],
        m = obj(message),
        model = obj(m.modelInfo);
      const digest = sha256Hex(JSON.stringify(message)),
        occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      const time =
        typeof m.ts === "number" &&
        Number.isSafeInteger(m.ts) &&
        m.ts >= 0 &&
        m.ts <= 8.64e15
          ? new Date(m.ts).toISOString()
          : date;
      const seq =
        typeof m.ts === "number" &&
        Number.isSafeInteger(m.ts) &&
        m.ts >= 0 &&
        m.ts <= 8.64e15
          ? m.ts
          : occurrence;
      const msgCtx = context(
        id,
        seq,
        time,
        {
          ...sourceVersion,
          ...(typeof model.id === "string" ? { model: model.id } : {}),
          ...(typeof model.provider === "string"
            ? { provider: model.provider }
            : {}),
        },
        parent,
      );
      if (!object(message)) {
        countUnrecognized(total.unrecognized, "message/non-object");
        const d = unrecognizedDraft({
          ...msgCtx,
          typeKey: "message/non-object",
          line: message,
        });
        d.content = { ...obj(d.content), source_sha256: digest, occurrence };
        drafts.push(d);
        continue;
      }
      drafts.push(...convert(m, msgCtx, origin, total.unrecognized));
    }
  }
  if (drafts.length) {
    const result = await appendEvents(repo, drafts);
    total.appended = result.appended.length;
    total.deduped = result.deduped;
  }
  return total;
}
export async function captureClineAll(
  cwd: string,
  limit?: number,
): Promise<CaptureResult> {
  const total = empty(),
    root = clineSessionsDirectory(),
    entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let matched = 0;
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(
        await readFile(join(path, entry.name + ".json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (
      typeof manifest.cwd !== "string" ||
      (await canonical(manifest.cwd)) !== (await canonical(cwd))
    )
      continue;
    if (limit !== undefined && matched++ >= limit) break;
    mergeCaptureResult(total, await captureClineTranscript(path, cwd));
  }
  return total;
}
export async function runClineHook(input: string): Promise<void> {
  try {
    const payload = JSON.parse(input),
      id = obj(payload.sessionContext).rootSessionId ?? payload.taskId;
    const cwd =
      Array.isArray(payload.workspaceRoots) &&
      typeof payload.workspaceRoots[0] === "string"
        ? payload.workspaceRoots[0]
        : undefined;
    if (!cwd || typeof id !== "string" || !/^[-\w.]+$/.test(id)) return;
    const directory = join(clineSessionsDirectory(), id);
    await captureClineTranscript(directory, cwd);
    if (
      ["session_shutdown", "agent_end", "agent_error", "agent_abort"].includes(
        payload.hookName,
      )
    ) {
      const { scheduleClineTail } = await import("./cline-tail.js");
      await scheduleClineTail(directory, cwd);
    }
  } catch {
    process.stderr.write("cledger: Cline hook capture failed\n");
  }
}
export function renormalizeUnrecognizedMany(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft[] | null {
  const raw = obj(event.raw?.data);
  if (
    event.raw?.format.split("+")[0] !== FORMAT ||
    !["message", "message.part"].includes(String(raw.artifact)) ||
    !object(raw.message)
  )
    return null;
  const drafts = convert(
    raw.message,
    {
      occurredAt: event.occurred_at,
      source: "cline",
      sessionId: event.producer.session_id!,
      seq: event.stream?.seq ?? 0,
      version: packageVersion(),
      rawFormat: FORMAT,
      conversationId: event.stream?.id ?? `cline:${event.producer.session_id}`,
      identity,
      ...(event.stream?.parent
        ? { parentConversationId: event.stream.parent }
        : {}),
      agent: {
        ...(event.producer.model ? { model: event.producer.model } : {}),
        ...(event.producer.provider
          ? { provider: event.producer.provider }
          : {}),
        ...(event.producer.source_version
          ? { source_version: event.producer.source_version }
          : {}),
      },
    },
    obj(raw.origin),
    {},
    typeof obj(event.content).source_message_id === "string"
      ? (obj(event.content).source_message_id as string)
      : undefined,
  );
  return drafts.some((d) => d.kind === "unrecognized") ? null : drafts;
}
export function renormalizeUnrecognized(
  event: EvidenceEvent,
  identity: GitUserIdentity,
): EventDraft | null {
  return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null;
}
