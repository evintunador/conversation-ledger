/**
 * Reads are scoped to the current branch by default.
 *
 * Storage has always been per-commit and push has been branch-scoped since
 * 0.14.0, but `readEvents` applied reachability only when the caller asked and
 * `cledger export` never asked — so an automated consumer reading the ledger
 * got every branch's conversations, including work that was abandoned and
 * never merged. The default belongs here rather than in one CLI command,
 * because the consumers that matter (intent-recall and anything else using the
 * library) never go through the CLI at all.
 *
 * `reachableFrom: null` is the opt-out, and the maintenance and safety passes
 * that genuinely need every local event say so at their call site.
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendEvents, readEvents } from "../store.js";
import { git } from "../git.js";
import { cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";
import type { RepoInfo } from "../git.js";
import type { EvidenceEvent } from "../schema.js";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/**
 * `main` carries one conversation; `side` branches off and carries another,
 * then `main` is checked back out. `side`'s anchor is unreachable from `main`
 * — the shape of an abandoned branch, which is exactly what an unscoped read
 * was quietly handing to every consumer.
 */
async function twoBranches(): Promise<RepoInfo> {
  const repo = await makeTempRepo("cledger-scope-");
  await makeCommit(repo, "on main");
  await appendEvents(repo, [
    draft({ content: { role: "human", text: "main-turn" }, conversation: { id: "conv-main", seq: 0 } }),
  ]);
  await git(["checkout", "-q", "-b", "side"], { cwd: repo.root });
  await makeCommit(repo, "on side");
  await appendEvents(repo, [
    draft({ content: { role: "human", text: "side-turn" }, conversation: { id: "conv-side", seq: 0 } }),
  ]);
  await git(["checkout", "-q", "main"], { cwd: repo.root });
  return repo;
}

const texts = (events: EvidenceEvent[]): string[] =>
  events.map((e) => String((e.content as Record<string, unknown>)["text"])).sort();

test("readEvents: the default scope is HEAD, not the whole ledger", async () => {
  const repo = await twoBranches();
  try {
    assert.deepEqual(
      texts(await readEvents(repo)),
      ["main-turn"],
      "standing on main, a branch that was never merged is not part of this history",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("readEvents: reachableFrom null is the opt-out, and an explicit rev still works", async () => {
  const repo = await twoBranches();
  try {
    assert.deepEqual(texts(await readEvents(repo, { reachableFrom: null })), [
      "main-turn",
      "side-turn",
    ]);
    // `side` descends from `main`, so scoping there reaches both.
    assert.deepEqual(texts(await readEvents(repo, { reachableFrom: "side" })), [
      "main-turn",
      "side-turn",
    ]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("readEvents: other filters do not silently widen the scope", async () => {
  // Passing an options object at all used to mean "no reachability filter"
  // unless it happened to carry `reachableFrom`; a caller narrowing by kind
  // would have widened by branch without asking.
  const repo = await twoBranches();
  try {
    assert.deepEqual(texts(await readEvents(repo, { kind: "conversation_turn" })), ["main-turn"]);
  } finally {
    await cleanupRepo(repo);
  }
});

async function cli(repo: RepoInfo, args: string[]): Promise<string[]> {
  const { stdout } = await execFileP(process.execPath, [CLI, ...args], {
    cwd: repo.root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvidenceEvent)
    .map((e) => String((e.content as Record<string, unknown>)["text"]))
    .sort();
}

test("export: scoped like log by default, --all restores the whole local ledger", async () => {
  const repo = await twoBranches();
  try {
    assert.deepEqual(await cli(repo, ["export"]), ["main-turn"]);
    assert.deepEqual(await cli(repo, ["export", "--all"]), ["main-turn", "side-turn"]);
    assert.deepEqual(await cli(repo, ["export", "--rev", "side"]), ["main-turn", "side-turn"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("show: naming one conversation finds it on any branch", async () => {
  // The deliberate exception. You did not ask a reachability question, and
  // scoping would answer "no such conversation" for one captured on a branch
  // you are not standing on.
  const repo = await twoBranches();
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, "show", "conv-side"], {
      cwd: repo.root,
    });
    assert.match(stdout, /side-turn/);
  } finally {
    await cleanupRepo(repo);
  }
});
