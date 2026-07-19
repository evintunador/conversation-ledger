/**
 * Shared test utilities. Not a test file itself (no top-level `test()`
 * calls), safe to import from any *.test.ts file. All git repos it creates
 * live under a fresh mkdtemp() directory and MUST be cleaned up by the
 * caller (see cleanupRepo/cleanupDir) — tests must never touch this
 * project's own repo.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, findRepo, type RepoInfo } from "../git.js";
import { finalizeEvent, type EventDraft, type EvidenceEvent } from "../schema.js";

/** Create a fresh repo under the OS temp dir, with local git identity set. */
export async function makeTempRepo(prefix = "cledger-test-"): Promise<RepoInfo> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  await git(["config", "user.email", "test@example.com"], { cwd: dir });
  await git(["config", "user.name", "Test User"], { cwd: dir });
  await git(["config", "commit.gpgsign", "false"], { cwd: dir });
  const repo = await findRepo(dir);
  if (!repo) throw new Error("failed to initialize temp repo");
  return repo;
}

/** Create a bare repo under the OS temp dir, for use as a sync remote. */
export async function makeBareRepo(prefix = "cledger-remote-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await git(["init", "-q", "--bare", "-b", "main"], { cwd: dir });
  return dir;
}

/** Recursively remove a temp repo/dir. Safe no-op if already gone. */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function cleanupRepo(repo: RepoInfo): Promise<void> {
  await cleanupDir(repo.root);
}

/** Create a commit (empty by default) and return its SHA. */
export async function makeCommit(repo: RepoInfo, message = "commit"): Promise<string> {
  await git(["commit", "--allow-empty", "-q", "-m", message], { cwd: repo.root });
  return (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();
}

/** Build a minimal, valid EventDraft with sensible defaults, override at will. */
export function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  const base: EventDraft = {
    kind: "conversation_turn",
    occurred_at: "2026-01-01T00:00:00.000Z",
    actor: { type: "human" },
    producer: { tool: "cledger" },
    content: { text: "hello" },
  };
  return { ...base, ...overrides };
}

/** Build a fully finalized event from overrides (id/schema/recorded_at auto-filled). */
export function event(overrides: Partial<EventDraft> = {}, now?: Date): EvidenceEvent {
  return finalizeEvent(draft(overrides), now);
}
