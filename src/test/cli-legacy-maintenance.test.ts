import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, type RepoInfo } from "annals";
import { appendEvents } from "../store.js";
import { cleanupDir, cleanupRepo, draft, makeBareRepo, makeCommit, makeTempRepo } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: "",
    env: { ...process.env, CODEX_SANDBOX: "1" },
  });
}

async function commitFile(repo: RepoInfo, name: string, content: string, message: string) {
  await writeFile(join(repo.root, name), content);
  await git(["add", name], { cwd: repo.root });
  await git(["commit", "-q", "-m", message], { cwd: repo.root });
  return (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();
}

test("legacy sync keeps --remote, --push, and --rev transport scope", async () => {
  const remote = await makeBareRepo("cledger-legacy-remote-");
  const repo = await makeTempRepo("cledger-legacy-sync-");
  try {
    const main = await makeCommit(repo);
    await appendEvents(repo, [draft({ content: { text: "main turn" } })]);
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    const feature = await makeCommit(repo, "feature");
    await appendEvents(repo, [draft({ content: { text: "feature turn" } })]);
    await git(["remote", "add", "backup", remote], { cwd: repo.root });

    const pushed = run(repo.root, ["sync", "--remote", "backup", "--push", "--rev", "main"]);
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stderr, /sync backup:/);
    const notes = await git(["notes", "--ref=refs/notes/conversation-ledger", "list"], { cwd: remote });
    assert.match(notes, new RegExp(main));
    assert.doesNotMatch(notes, new RegExp(feature));
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("legacy re-anchor restores evidence-ranked suggestions for edited squashes", async () => {
  const repo = await makeTempRepo("cledger-legacy-reanchor-");
  try {
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(["checkout", "-q", "-b", "feat"], { cwd: repo.root });
    await commitFile(repo, "f1.txt", "one\n", "feat: add f1");
    await appendEvents(repo, [draft({ content: { text: "orphaned turn" } })]);
    await commitFile(repo, "f2.txt", "two\n", "feat: add f2");
    await git(["checkout", "-q", "main"], { cwd: repo.root });
    await commitFile(repo, "unrelated.txt", "drift\n", "unrelated");
    await writeFile(join(repo.root, "f1.txt"), "one\n");
    await writeFile(join(repo.root, "f2.txt"), "two, edited during merge\n");
    await git(["add", "f1.txt", "f2.txt"], { cwd: repo.root });
    await git(["commit", "-q", "-m", "feat: the feature (#7)\n\n* feat: add f1\n* feat: add f2"], {
      cwd: repo.root,
    });
    const squash = (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();

    const result = run(repo.root, ["re-anchor", "--target", "main", "--no-forge"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /branch feat: looks rewritten/);
    assert.match(result.stderr, new RegExp(`candidate ${squash.slice(0, 12)}`));
    assert.match(result.stderr, /confirm with: cledger re-anchor/);
    assert.match(result.stderr, /carry conversations \(keep these\)/);
  } finally {
    await cleanupRepo(repo);
  }
});
