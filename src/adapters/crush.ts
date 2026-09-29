/** Crush 0.97.1 persistence, charmbracelet/crush@89c3c4a7.
 * Native session show is intentionally not used: its export drops signatures,
 * binary references, shell commands, parent lineage, todos and file versions.
 * Read-only SQLite reads only the fixed session tables, never provider config.
 */
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { findRepo, gitUserIdentity, type GitUserIdentity } from "annals";
import { isKnownTextFilename } from "../attachments.js";
import { appendEvents } from "../store.js";
import type { EventDraft, EvidenceEvent } from "../schema.js";
import { packageVersion } from "./common.js";
import { countUnrecognized, warnUnrecognized, type CaptureResult } from "./drift.js";
import { recordDraft, type RecordContext } from "./records.js";
import { runWatchedCli } from "./watched-run.js";
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const FORMAT = "crush-sqlite/1";
const EPOCH = "1970-01-01T00:00:00.000Z";
const TABLES = ["sessions", "messages", "files", "read_files", "mcp_disabled_servers", "mcp_enabled_servers"];
const empty = (): CaptureResult => ({ appended: 0, deduped: 0, unrecognized: {} });
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v) ?? "undefined").digest("hex");
const seqFor = (v: unknown) => parseInt(digest(v).slice(0, 13), 16);
const canonical = (p: string) => realpath(p).catch(() => resolve(p));
function timestamp(v: unknown): string {
    if (typeof v !== "number" || !Number.isFinite(v))
        return EPOCH;
    const date = new Date(v * 1000);
    return Number.isNaN(date.getTime()) ? EPOCH : date.toISOString();
}
export interface CrushSnapshot {
    tables: Record<string, unknown[]>;
    schema?: Record<string, string[]>;
}
/** Apple's SQLite cannot open a closed WAL database read-only when its sidecars
 * are absent. Use upstream SQLite on macOS; never immutable=1 (ignores live WAL). */
export async function crushSqliteBinary(): Promise<string> {
    if (process.env.CLEDGER_SQLITE_BINARY) return process.env.CLEDGER_SQLITE_BINARY;
    if (process.platform === "darwin") {
        for (const candidate of ["/opt/homebrew/opt/sqlite/bin/sqlite3", "/usr/local/opt/sqlite/bin/sqlite3"])
            try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
    }
    return "sqlite3";
}
async function query(path: string, sql: string): Promise<unknown> {
    const binary = await crushSqliteBinary();
    return new Promise((done, reject) => {
        const child = spawn(binary, ["-readonly", "-json", "-cmd", ".timeout 2000", path, `PRAGMA query_only=ON; ${sql}`], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "", tooLarge = false;
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
        child.stdout.on("data", chunk => { out += chunk.toString(); if (out.length > 64 * 1024 * 1024) {
            tooLarge = true;
            child.kill("SIGKILL");
        } });
        child.stderr.on("data", chunk => { err = (err + chunk.toString()).slice(-2000); });
        child.once("error", error => { clearTimeout(timeout); reject(new Error(`Crush capture needs the sqlite3 executable: ${error.message}`)); });
        child.once("close", code => {
            clearTimeout(timeout);
            if (code !== 0 || tooLarge) {
                reject(new Error(`Crush read-only database query failed (${tooLarge ? "64 MiB limit" : code}): ${err}${code === 14 ? "; use upstream SQLite (brew install sqlite) or set CLEDGER_SQLITE_BINARY" : ""}`));
                return;
            }
            try {
                done(out.trim() ? JSON.parse(out) : []);
            }
            catch (error) {
                reject(error);
            }
        });
    });
}
/** No user-controlled SQL: table allowlist, quoted schema identifiers. */
export async function readCrushDatabase(path: string): Promise<CrushSnapshot> {
    if (!(await lstat(path)).isFile())
        throw new Error("Crush database must be a regular file");
    const columns = await query(path, "SELECT m.name AS table_name,p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' ORDER BY m.name,p.cid;");
    if (!Array.isArray(columns))
        throw new Error("Invalid SQLite schema response");
    const schema: Record<string, string[]> = {};
    for (const item of columns)
        if (object(item) && typeof item.table_name === "string" && typeof item.column_name === "string")
            (schema[item.table_name] ??= []).push(item.column_name);
    const required: Record<string, string[]> = { sessions: ["id", "created_at", "updated_at"], messages: ["id", "session_id", "role", "parts", "created_at"], files: ["id", "session_id", "path", "content", "version"] };
    for (const [table, names] of Object.entries(required))
        for (const column of names)
            if (!schema[table]?.includes(column))
                throw new Error(`Unsupported Crush database: ${table}.${column} missing`);
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const selects = TABLES.filter(table => schema[table]).map(table => `SELECT ${literal(table)} AS native_table,json_object(${schema[table]!.flatMap(column => [literal(column), quote(column)]).join(",")}) AS native_row FROM ${quote(table)}`);
    const rows = await query(path, `BEGIN; ${selects.join(" UNION ALL ")}; COMMIT;`);
    if (!Array.isArray(rows))
        throw new Error("Invalid Crush database rows");
    const tables: Record<string, unknown[]> = Object.fromEntries(TABLES.filter(table => schema[table]).map(table => [table, []]));
    for (const row of rows)
        if (object(row) && typeof row.native_table === "string" && typeof row.native_row === "string")
            tables[row.native_table]!.push(JSON.parse(row.native_row));
    return { tables, schema };
}
function unknown(raw: unknown, key: string, ctx: RecordContext): EventDraft {
    return recordDraft(ctx, "unrecognized", "system", { unrecognized_type: key, raw_sha256: digest(raw) }, raw);
}
function parse(value: unknown): unknown { if (typeof value !== "string")
    return value; try {
    return JSON.parse(value);
}
catch {
    return value;
} }
function convertMessage(row: Obj, ctx: RecordContext, parent?: string): EventDraft[] {
    const original = parse(row.parts);
    if (!Array.isArray(original) || !["user", "assistant", "system", "tool"].includes(String(row.role)))
        return [unknown({ table: "messages", row }, "message/invalid-shape", ctx)];
    const parts = structuredClone(original), signatures: Obj[] = [], drafts: EventDraft[] = [];
    const common = { native_message_id: row.id, role: row.role, model: row.model, provider: row.provider,
        is_summary_message: row.is_summary_message, prism_model_id: row.prism_model_id, prism_model_name: row.prism_model_name,
        prism_hypercredit_savings: row.prism_hypercredit_savings, prism_dollar_savings: row.prism_dollar_savings };
    for (const [index, part] of parts.entries()) {
        const partCtx = { ...ctx, seq: seqFor([row.id, index]) };
        const raw = () => ({ table: "messages", row: { ...row, parts }, part_index: index, ...(parent ? { parent_session_id: parent } : {}) });
        if (!object(part) || !object(part.data)) {
            drafts.push(unknown(raw(), "part/(malformed)", partCtx));
            continue;
        }
        const data = part.data, nativeType = String(part.type), fields = { ...common, native_part_index: index, native_type: nativeType };
        let kind = "conversation_turn", actor = row.role === "assistant" ? "agent" : row.role === "user" && !parent ? "human" : "system";
        let blocks: unknown[] = [], extra: Obj = {}, valid = true;
        switch (part.type) {
            case "text":
                valid = typeof data.text === "string";
                blocks = [{ type: "text", text: data.text }];
                if (data.hidden === true || row.is_summary_message === 1 || row.is_summary_message === true || row.role === "system" || parent && row.role === "user") {
                    kind = "context_injection";
                    actor = "system";
                    extra.context_type = row.is_summary_message ? "summary" : data.hidden ? "hidden_continuation" : "system_context";
                }
                break;
            case "reasoning":
                valid = typeof data.thinking === "string";
                blocks = [{ type: "thinking", text: data.thinking }];
                // Only the provider's explicit encrypted field is exempt from redaction.
                if (object(data.responses_data)) {
                    const wrapped = data.responses_data.type === "openai.responses.reasoning_metadata" && object(data.responses_data.data);
                    const metadata = wrapped ? data.responses_data.data as Obj : data.responses_data;
                    if (typeof metadata.encrypted_content === "string") {
                        signatures.push({ native_field: "responses_data.encrypted_content", provider_native: "openai.responses.reasoning_metadata",
                            path: ["parts", index, "data", "responses_data", ...(wrapped ? ["data"] : []), "encrypted_content"], encrypted_content: metadata.encrypted_content });
                        metadata.encrypted_content = { type: "reasoning_reference", index: signatures.length - 1 };
                    }
                }
                extra.reasoning_metadata = { ...data, thinking: undefined };
                break;
            case "image_url":
                valid = typeof data.url === "string" || object(data.url);
                blocks = [{ type: "image", source: data }];
                break;
            case "binary": {
                valid = typeof data.MIMEType === "string" && (typeof data.Data === "string" || object(data.Data));
                // Native Go fields are capitalized. Canonical aliases invoke attachment
                // retention on both raw and normalized data without dropping native shape.
                const source = object(data.Data) && data.Data.type === "base64" ? data.Data : { type: "base64", media_type: data.MIMEType, data: data.Data, path: data.Path };
                data.Data = source;
                blocks = [{ type: "file", source }];
                break;
            }
            case "tool_call": {
                valid = typeof data.id === "string" && typeof data.name === "string" && typeof data.input === "string";
                blocks = [{ type: "tool_use", id: data.id, name: data.name, input: parse(data.input), provider_executed: data.provider_executed }];
                if (data.finished !== true) {
                    kind = "activity";
                    extra.activity_type = "tool_pending";
                }
                break;
            }
            case "tool_result": {
                valid = typeof data.tool_call_id === "string" && typeof data.content === "string";
                blocks = [{ type: "tool_result", tool_use_id: data.tool_call_id, name: data.name, content: data.content, is_error: data.is_error,
                        ...(data.data ? { attachment: { type: "base64", media_type: data.mime_type, data: data.data } } : {}), metadata: parse(data.metadata) }];
                actor = "system";
                break;
            }
            case "finish":
                valid = typeof data.reason === "string";
                kind = "activity";
                actor = "system";
                extra = { activity_type: "finish", ...data };
                break;
            case "shell_command":
                valid = typeof data.command === "string" && typeof data.output === "string";
                kind = "activity";
                extra = { activity_type: "shell_command", ...data };
                blocks = [{ type: "text", text: data.command }, { type: "text", text: data.output }];
                break;
            default: valid = false;
        }
        if (!valid) {
            drafts.push(unknown(raw(), `part/${nativeType}`, partCtx));
            continue;
        }
        drafts.push(recordDraft(partCtx, kind, actor, { ...fields, ...extra, blocks }, raw()));
    }
    if (!parts.length)
        drafts.push(recordDraft(ctx, "session_state", "system", { state_type: "message", ...common }, { table: "messages", row }));
    if (signatures.length)
        drafts.push(recordDraft({ ...ctx, rawFormat: "crush-encrypted-reasoning/1" }, "reasoning", "agent", { opaque: true, native_message_id: row.id, sealed_parts: signatures.map(item => ({ path: item.path, sha256: digest(item.encrypted_content) })) }, { native_format: FORMAT, signatures }));
    return drafts;
}
export async function captureCrushSnapshot(snapshot: CrushSnapshot, cwd: string, limit?: number): Promise<CaptureResult> {
    const repo = await findRepo(cwd);
    if (!repo)
        throw new Error("not inside a git repository");
    const result = empty(), identity = await gitUserIdentity(repo), version = packageVersion(), drafts: EventDraft[] = [];
    const sessions = (snapshot.tables.sessions ?? []).filter(object).filter(row => typeof row.id === "string").sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0));
    const selected = limit === undefined ? sessions : sessions.slice(0, limit), wanted = new Set(selected.map(row => String(row.id)));
    // Include descendants even when limiting parent sessions.
    let added = true;
    while (added) {
        added = false;
        for (const row of sessions)
            if (wanted.has(String(row.parent_session_id)) && !wanted.has(String(row.id))) {
                wanted.add(String(row.id));
                added = true;
            }
    }
    const byId = new Map(sessions.map(row => [String(row.id), row]));
    const context = (row: Obj, table: string): RecordContext => {
        const id = String(table === "sessions" ? row.id : row.session_id ?? "workspace"), parent = byId.get(id)?.parent_session_id;
        return { occurredAt: timestamp(row.created_at ?? row.read_at), source: "crush", sessionId: id, conversationId: `crush:${id}`, seq: seqFor([table, row.id ?? row.path ?? row.name]), version, rawFormat: FORMAT, identity,
            ...(typeof parent === "string" && parent ? { parentConversationId: `crush:${parent}` } : {}),
            agent: { ...(typeof row.model === "string" && row.model ? { model: row.model } : {}), ...(typeof row.provider === "string" && row.provider ? { provider: row.provider } : {}) } };
    };
    for (const [table, rows] of Object.entries(snapshot.tables))
        for (const row of rows) {
            if (!object(row) || (table === "sessions" && typeof row.id !== "string") ||
                (["messages", "files"].includes(table) && (typeof row.id !== "string" || typeof row.session_id !== "string")) ||
                (table === "files" && (typeof row.path !== "string" || typeof row.content !== "string")) ||
                (table === "read_files" && (typeof row.session_id !== "string" || typeof row.path !== "string")) ||
                (table.startsWith("mcp_") && typeof row.name !== "string")) {
                drafts.push(unknown({ table, row }, `${table}/invalid-shape`, context({ id: "workspace" }, "sessions")));
                continue;
            }
            if (table === "sessions" ? !wanted.has(String(row.id)) : row.session_id !== undefined && !wanted.has(String(row.session_id)))
                continue;
            const ctx = context(row, table), raw = { table, row };
            if (table === "messages")
                drafts.push(...convertMessage(row, ctx, typeof byId.get(String(row.session_id))?.parent_session_id === "string" ? String(byId.get(String(row.session_id))!.parent_session_id) : undefined));
            else if (table === "files") {
                const text = String(row.content), retain = isKnownTextFilename(String(row.path)) && !text.includes("\0");
                const content = retain ? text : { type: "attachment_reference", path: row.path,
                    sha256: createHash("sha256").update(text, "utf8").digest("hex"), size: Buffer.byteLength(text, "utf8"),
                    source_encoding: "native_snapshot_utf8_string", availability: "embedded_not_retained",
                    reason: isKnownTextFilename(String(row.path)) ? "binary_content" : "unknown_file_format" };
                const retained = { ...row, content };
                drafts.push(recordDraft(ctx, "file_snapshot", "system", { snapshot_type: "native_file_version", ...retained,
                    blocks: retain ? [{ type: "text", text }] : [{ type: "file", source: content }] }, { table, row: retained }));
            }
            else if (table === "read_files")
                drafts.push(recordDraft(ctx, "activity", "system", { activity_type: "file_read", ...row }, raw));
            else if (TABLES.includes(table))
                drafts.push(recordDraft(ctx, "session_state", "system", { state_type: table, ...row, ...(table === "sessions" ? { todos: parse(row.todos) } : {}) }, raw));
            else
                drafts.push(unknown(raw, `table/${table}`, ctx));
        }
    for (const [table, columns] of Object.entries(snapshot.schema ?? {}))
        if (!TABLES.includes(table) && table !== "goose_db_version" && !table.startsWith("sqlite_")) {
            const ctx = context({ id: "workspace" }, "sessions");
            drafts.push(unknown({ table, columns, rows_read: false }, `schema/${table}`, ctx));
        }
    for (const draft of drafts)
        if (draft.kind === "unrecognized")
            countUnrecognized(result.unrecognized, String((draft.content as Obj).unrecognized_type));
    const append = await appendEvents(repo, drafts);
    result.appended = append.appended.length;
    result.deduped = append.deduped;
    warnUnrecognized("crush", result.unrecognized);
    return result;
}
export async function captureCrushDatabase(path: string, cwd: string, limit?: number): Promise<CaptureResult> {
    try {
        return await captureCrushSnapshot(await readCrushDatabase(path), cwd, limit);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return empty();
        throw error;
    }
}
/** Native sessions omit cwd. Discovery is bounded to this checkout's nearest
 * .crush directory, exactly matching the default native workspace database. */
export async function captureCrushAll(cwd: string, limit?: number, database?: string): Promise<CaptureResult> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
        throw new Error("Crush limit must be non-negative integer");
    if (limit === 0)
        return empty();
    if (database)
        return captureCrushDatabase(database, cwd, limit);
    const repo = await findRepo(cwd);
    if (!repo)
        throw new Error("not inside a git repository");
    let current = await canonical(cwd), root = await canonical(repo.root);
    for (;;) {
        const dir = join(current, ".crush");
        try {
            if ((await lstat(dir)).isDirectory())
                return captureCrushDatabase(join(dir, "crush.db"), cwd, limit);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
        if (current === root || dirname(current) === current)
            break;
        current = dirname(current);
    }
    return empty();
}
export async function runCrushHook(input: string): Promise<void> { try {
    const p = JSON.parse(input) as Obj;
    await captureCrushAll(typeof p.cwd === "string" ? p.cwd : process.cwd(), undefined, typeof p.database_path === "string" ? p.database_path : undefined);
}
catch (error) {
    process.stderr.write(`cledger: crush hook error: ${String(error)}\n`);
} }
export async function runCrush(args: string[], binary = "crush"): Promise<number> {
    let cwd = process.cwd(), dataDir: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--")
            break;
        if (arg === "--cwd" || arg === "-c")
            cwd = resolve(args[++i] ?? cwd);
        else if (arg.startsWith("--cwd="))
            cwd = resolve(arg.slice(6));
        else if (arg.startsWith("-c") && arg.length > 2)
            cwd = resolve(arg.slice(2));
        else if (arg === "--data-dir" || arg === "-D")
            dataDir = args[++i];
        else if (arg.startsWith("--data-dir="))
            dataDir = arg.slice(11);
        else if (arg.startsWith("-D") && arg.length > 2)
            dataDir = arg.slice(2);
    }
    return runWatchedCli(binary, args, "crush", dataDir ? ["--database", join(resolve(cwd, dataDir), "crush.db")] : ["--all"], cwd);
}
export function renormalizeUnrecognizedMany(event: EvidenceEvent, identity: GitUserIdentity): EventDraft[] | null {
    const raw = event.raw?.data;
    if (!object(raw) || raw.table !== "messages" || !object(raw.row) || !event.stream)
        return null;
    const ctx: RecordContext = { occurredAt: event.occurred_at, source: "crush", sessionId: event.producer.session_id ?? "", conversationId: event.stream.id, seq: seqFor(["messages", raw.row.id]), version: packageVersion(), rawFormat: FORMAT, identity,
        ...(event.stream.parent ? { parentConversationId: event.stream.parent } : {}), agent: { ...(event.producer.model ? { model: event.producer.model } : {}), ...(event.producer.provider ? { provider: event.producer.provider } : {}) } };
    const drafts = convertMessage(raw.row, ctx, typeof raw.parent_session_id === "string" ? raw.parent_session_id : undefined);
    return drafts.filter(draft => draft.kind !== "unrecognized" && ((draft.content as Obj).native_part_index === raw.part_index || draft.kind === "reasoning"));
}
export function renormalizeUnrecognized(event: EvidenceEvent, identity: GitUserIdentity): EventDraft | null { return renormalizeUnrecognizedMany(event, identity)?.[0] ?? null; }
