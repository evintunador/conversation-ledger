/**
 * Plumbing every adapter repeats: which cledger version is running, and how
 * far a source has been captured.
 *
 * The cursor design here is the one the claude-code adapter arrived at, made
 * available to the rest rather than copied a fifth time. Three properties
 * matter and none of them are obvious:
 *
 *  - **Absent is not zero.** `readCursor` returns null when no cursor exists,
 *    which is a different fact from a cursor resting at 0. "cledger has never
 *    captured this session" is what gates a catch-up sweep; a session
 *    legitimately sitting at line 0 must not be mistaken for one cledger was
 *    never asked to record.
 *  - **`size` bounds the sweep.** A sweep asks "did this file grow since we
 *    last read it" for every session in a project, and must answer without
 *    parsing them. A cursor written by an older cledger has no `size`; that
 *    reads as 0, so the file looks grown and is re-read once, which dedups.
 *  - **The write is atomic.** A cursor has two writers — the session's own
 *    hook, and any other session sweeping it — so it is written to a temp
 *    file and renamed. A torn read parses as "no cursor", which would send a
 *    sweep down the full-rescan path: safe, but the expensive kind of safe,
 *    and reachable by two ordinary sessions running side by side.
 *
 * `field` is the JSON key the count is stored under. It differs per adapter
 * (`lines` for the append-only transcript formats, `parts` for opencode,
 * `messages` for gemini-cli) because the unit being counted differs, and
 * because renaming it would silently reset every existing cursor on disk to
 * zero — harmless, but a needless full rescan of every session.
 *
 * Cursors live under the repo's *common* git dir (see git.ts) so every
 * worktree of a checkout shares one capture position.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoInfo } from "../git.js";

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/** Session ids are used as filenames; keep them to a portable character set. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function cursorDir(repo: RepoInfo): string {
  return join(repo.commonDir, "conversation-ledger", "cursors");
}

function cursorPath(repo: RepoInfo, sessionId: string): string {
  return join(cursorDir(repo), `${sanitizeId(sessionId)}.json`);
}

/**
 * How far a source has been captured: the count consumed, and the byte size
 * that count corresponded to. `size` is 0 for sources with no file behind
 * them (opencode reads through `opencode export`), where staleness has to be
 * decided some other way.
 */
export interface Cursor {
  count: number;
  size: number;
}

export async function readCursor(
  repo: RepoInfo,
  sessionId: string,
  field: string,
): Promise<Cursor | null> {
  try {
    const raw = await readFile(cursorPath(repo, sessionId), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const count = data[field];
    const size = data["size"];
    return {
      count: typeof count === "number" ? count : 0,
      size: typeof size === "number" ? size : 0,
    };
  } catch {
    return null;
  }
}

export async function writeCursor(
  repo: RepoInfo,
  sessionId: string,
  field: string,
  count: number,
  size = 0,
): Promise<void> {
  await mkdir(cursorDir(repo), { recursive: true });
  const path = cursorPath(repo, sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ [field]: count, size }) + "\n");
  await rename(tmp, path);
}
