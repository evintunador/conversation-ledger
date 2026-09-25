import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git } from "annals";
import { CLEDGER_NAMESPACE } from "../ledger.js";
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

test("canonical records commands remain available and legacy human commands refuse agent sessions", async () => {
  const repo = await makeTempRepo("cledger-records-cli-");
  try {
    await makeCommit(repo);
    const cases: Array<[string, string[], string[]]> = [
      ["review", [], []],
      ["inspect", ["--output", "ignored.txt"], ["example", "--force"]],
      ["redact", ["example", "--all"], ["example", "--all"]],
      ["allow", ["000000000000"], ["000000000000"]],
      ["reanchor", ["manual", "HEAD", "--onto", "HEAD"], ["HEAD", "--onto", "HEAD"]],
    ];
    for (const [canonical, recordsArgs, legacyArgs] of cases) {
      const direct = run(repo.root, ["records", canonical, ...recordsArgs]);
      const shortcut = run(repo.root, [canonical === "reanchor" ? "re-anchor" : canonical, ...legacyArgs]);
      assert.ok([1, 2].includes(direct.status ?? -1), canonical);
      assert.ok([1, 2].includes(shortcut.status ?? -1), canonical);
      assert.match(direct.stderr, /refuses inside an agent session/);
      assert.match(shortcut.stderr, /refusing to run inside a coding-agent session/);
    }
    const sync = run(repo.root, ["records", "sync", "--fetch-only", "--push-only"]);
    assert.equal(sync.status, 2);
    const help = run(repo.root, ["records", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: cledger records <command>/);
    assert.equal(run(repo.root, ["records", "bogus"]).status, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("agent sessions cannot bypass a push scan, but can fetch without scanning", async () => {
  const repo = await makeTempRepo("cledger-records-agent-");
  try {
    await makeCommit(repo);
    const blocked = run(repo.root, ["records", "sync", "--no-scan", "--push-only"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /refuses inside an agent session/);
    const fetch = run(repo.root, ["records", "sync", "--no-scan", "--fetch-only", "missing"]);
    assert.equal(fetch.status, 0);
    assert.doesNotMatch(fetch.stderr, /refuses inside an agent session/);
    const legacyBlocked = run(repo.root, ["sync", "--no-scan", "--push"]);
    assert.equal(legacyBlocked.status, 1);
    assert.match(legacyBlocked.stderr, /refusing to run inside a coding-agent session/);
    const legacyFetch = run(repo.root, ["sync", "--no-scan", "--fetch", "--remote", "missing"]);
    assert.equal(legacyFetch.status, 0);
    assert.doesNotMatch(legacyFetch.stderr, /refusing to run inside a coding-agent session/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("namespace, incoming ref, recursion guard, refspec, and installed hook stay compatible", async () => {
  const repo = await makeTempRepo("cledger-records-namespace-");
  try {
    assert.deepEqual({
      name: CLEDGER_NAMESPACE.name,
      incomingName: CLEDGER_NAMESPACE.incomingName,
      internalEnvName: CLEDGER_NAMESPACE.internalEnvName,
      stateDirName: CLEDGER_NAMESPACE.stateDirName,
      configFile: CLEDGER_NAMESPACE.configFile,
      userConfigDir: CLEDGER_NAMESPACE.userConfigDir,
      cliName: CLEDGER_NAMESPACE.cliName,
    }, {
      name: "conversation-ledger",
      incomingName: "cledger-incoming",
      internalEnvName: "CLEDGER_INTERNAL",
      stateDirName: "conversation-ledger",
      configFile: ".cledger.json",
      userConfigDir: "cledger",
      cliName: "cledger",
    });
    assert.equal(CLEDGER_NAMESPACE.hookInvocation?.node, process.execPath);
    assert.equal(CLEDGER_NAMESPACE.hookInvocation?.cli, CLI);
    await git(["remote", "add", "origin", repo.root], { cwd: repo.root });
    await makeCommit(repo);
    await appendEvents(repo, [draft()]);
    const refspec = await git(["config", "--get-all", "remote.origin.fetch"], { cwd: repo.root });
    assert.match(refspec, /refs\/notes\/conversation-ledger:refs\/notes\/cledger-incoming/);
    const hook = await readFile(join(repo.commonDir, "hooks", "pre-push"), "utf8");
    assert.match(hook, /transport-push/);
    const topLevel = run(repo.root, ["transport-push", "missing"]);
    const canonical = run(repo.root, ["records", "transport-push", "missing"]);
    assert.equal(topLevel.status, 0);
    assert.deepEqual([topLevel.status, topLevel.stdout, topLevel.stderr],
      [canonical.status, canonical.stdout, canonical.stderr]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("top-level transport-push blocks the code push only for a strict scan finding", async () => {
  const remote = await makeBareRepo("cledger-records-strict-remote-");
  const repo = await makeTempRepo("cledger-records-strict-");
  try {
    await makeCommit(repo);
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const secret = ["qZ8mK2", "pL7vN4wR"].join("");
    await appendEvents(repo, [draft({ content: { text: `password=${secret}` } })]);
    const ordinary = run(repo.root, ["transport-push", "origin"]);
    assert.equal(ordinary.status, 0);
    assert.match(ordinary.stderr, /code push continues/);
    await writeFile(join(repo.root, ".cledger.json"), JSON.stringify({ transport: { strict: true } }));
    const strict = run(repo.root, ["transport-push", "origin"]);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /entire push blocked/);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});
