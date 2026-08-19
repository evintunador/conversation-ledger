/**
 * A reader that walks away must not produce a stack trace.
 *
 * `cledger export | head -1` is the canonical case: `head` prints its line
 * and closes the pipe, and every subsequent write in the CLI fails with
 * EPIPE. Before the stdout guard, `process.stdout` had no `error` listener,
 * so that became an unhandled `error` event — a stack trace on stderr and a
 * nonzero exit, for what is ordinary shell usage.
 *
 * These tests spawn the real built CLI rather than calling a function,
 * because the bug lives entirely in process-level stream wiring: an
 * in-process call has no pipe to break. They also deliberately write far more
 * than the 64KB pipe buffer — under that, the whole payload lands in the
 * buffer before the reader exits, no write ever fails, and the test would
 * pass without the fix.
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendEvents } from "../store.js";
import { cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";
import type { RepoInfo } from "../git.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** Comfortably past the 64KB pipe buffer, so the writer cannot outrun the reader. */
const EVENTS = 600;
const PADDING = "x".repeat(2048);

async function repoWithBigLedger(): Promise<RepoInfo> {
  const repo = await makeTempRepo("cledger-epipe-");
  await makeCommit(repo);
  await appendEvents(
    repo,
    Array.from({ length: EVENTS }, (_, i) =>
      draft({
        occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        content: { role: "human", text: `turn ${i} ${PADDING}` },
        conversation: { id: "epipe-fixture", seq: i },
      }),
    ),
  );
  return repo;
}

/**
 * Run the CLI, read one chunk, then slam the pipe shut and report what the
 * child did about it. Destroying the parent's read end is what `head` does on
 * exit, minus the dependency on a shell that supports `pipefail`.
 */
function runAndHangUp(args: string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    let hungUp = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr += d));
    child.stdout.on("data", () => {
      if (hungUp) return;
      hungUp = true;
      child.stdout.destroy();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      assert.ok(hungUp, "the child produced no stdout, so nothing exercised the broken pipe");
      resolve({ code, stderr });
    });
  });
}

for (const args of [["export"], ["log", "--json"], ["log"]]) {
  test(`cledger ${args.join(" ")} exits quietly when the reader closes the pipe`, async () => {
    const repo = await repoWithBigLedger();
    try {
      const { code, stderr } = await runAndHangUp(args, repo.root);
      assert.equal(code, 0, `expected a clean exit, got ${code} with stderr:\n${stderr}`);
      // Deliberately "nothing at all" rather than "no EPIPE". The first cut of
      // this guard matched only `EPIPE` and still exited 1 on macOS, where a
      // socket-backed stdout reports `ENOTCONN` instead; an assertion naming
      // one errno would have passed while the command was still broken.
      assert.equal(stderr, "", "a closed reader is not an error worth printing");
    } finally {
      await cleanupRepo(repo);
    }
  });
}

/**
 * The guard must stay narrow: it exists so a closed reader is silent, not so
 * every failure is. A command whose output nobody interrupts still reports
 * real errors and exits nonzero.
 */
test("the stdout guard does not swallow ordinary command failures", async () => {
  const repo = await makeTempRepo("cledger-epipe-");
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, "show", "definitely-no-such-conversation"], {
        cwd: repo.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => (stderr += d));
      child.stdout.resume();
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.notEqual(result.code, 0, "a missing conversation must still fail");
    assert.match(result.stderr, /no events for conversation/);
  } finally {
    await cleanupRepo(repo);
  }
});
