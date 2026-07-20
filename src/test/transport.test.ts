import { test } from "node:test";
import assert from "node:assert";
import { readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, type RepoInfo } from "../git.js";
import { absorbIncoming, ensureTransport, INCOMING_REF, NOTES_REF } from "../transport.js";
import { appendEvents, readEvents, ScanBlockedError, sync, transportPush } from "../store.js";
import { cleanupDir, cleanupRepo, draft, makeBareRepo, makeCommit, makeTempRepo } from "./helpers.js";

function hookPath(repo: RepoInfo): string {
  return join(repo.gitDir, "hooks", "pre-push");
}

async function remoteHasNotesRef(repo: RepoInfo): Promise<boolean> {
  const out = await git(["ls-remote", "origin", NOTES_REF], { cwd: repo.root, allowFailure: true });
  return out.trim().length > 0;
}

test("ensureTransport: installs the pre-push hook and origin fetch refspec, idempotently", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-transport-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });

    const first = await ensureTransport(repo, {});
    assert.deepStrictEqual(first, { hook: "installed", refspec: "added" });

    const script = await readFile(hookPath(repo), "utf8");
    assert.ok(script.includes("conversation-ledger pre-push"));
    assert.ok(script.includes("transport-push"));
    const mode = (await stat(hookPath(repo))).mode;
    assert.ok(mode & 0o111, "hook must be executable");

    const fetchSpecs = await git(["config", "--get-all", "remote.origin.fetch"], { cwd: repo.root });
    assert.ok(fetchSpecs.includes(`+${NOTES_REF}:${INCOMING_REF}`));

    const second = await ensureTransport(repo, {});
    assert.deepStrictEqual(second, { hook: "present", refspec: "present" });
    assert.strictEqual(await readFile(hookPath(repo), "utf8"), script, "re-run must not duplicate the block");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("ensureTransport: chains onto an existing shell hook without clobbering it", async () => {
  const repo = await makeTempRepo("cledger-transport-chain-");
  try {
    const original = "#!/bin/sh\necho existing-hook-ran\n";
    await writeFile(hookPath(repo), original);

    const setup = await ensureTransport(repo, {});
    assert.strictEqual(setup?.hook, "appended");
    assert.strictEqual(setup?.refspec, "no-remote");

    const script = await readFile(hookPath(repo), "utf8");
    assert.ok(script.startsWith(original), "existing hook content must be preserved, first");
    assert.ok(script.includes("conversation-ledger pre-push"));
  } finally {
    await cleanupRepo(repo);
  }
});

test("ensureTransport: backs off from a non-shell hook and from core.hooksPath", async () => {
  const foreign = await makeTempRepo("cledger-transport-foreign-");
  const managed = await makeTempRepo("cledger-transport-hookspath-");
  try {
    const original = "#!/usr/bin/env python3\nprint('not shell')\n";
    await writeFile(hookPath(foreign), original);
    const foreignSetup = await ensureTransport(foreign, {});
    assert.strictEqual(foreignSetup?.hook, "skipped-foreign");
    assert.strictEqual(await readFile(hookPath(foreign), "utf8"), original, "must not touch a non-shell hook");

    await git(["config", "core.hooksPath", ".husky"], { cwd: managed.root });
    const managedSetup = await ensureTransport(managed, {});
    assert.strictEqual(managedSetup?.hook, "skipped-hookspath");
    assert.strictEqual(existsSync(hookPath(managed)), false);
  } finally {
    await cleanupRepo(foreign);
    await cleanupRepo(managed);
  }
});

test("ensureTransport: config can disable both halves", async () => {
  const repo = await makeTempRepo("cledger-transport-off-");
  try {
    const setup = await ensureTransport(repo, { transport: { hook: false, fetchRefspec: false } });
    assert.deepStrictEqual(setup, { hook: "skipped-config", refspec: "skipped-config" });
    assert.strictEqual(existsSync(hookPath(repo)), false);
  } finally {
    await cleanupRepo(repo);
  }
});

test("appendEvents: first capture in a repo wires transport automatically", async () => {
  const repo = await makeTempRepo("cledger-transport-auto-");
  try {
    await makeCommit(repo, "init");
    await appendEvents(repo, [draft()]);
    assert.ok(existsSync(hookPath(repo)), "capture must install the pre-push hook");
  } finally {
    await cleanupRepo(repo);
  }
});

test("absorbIncoming: a staged fetch is folded into the local ref at read time", async () => {
  const remote = await makeBareRepo();
  const a = await makeTempRepo("cledger-absorb-a-");
  const b = await makeTempRepo("cledger-absorb-b-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: a.root });
    await makeCommit(a, "init a");
    await appendEvents(a, [draft({ content: { text: "staged-event" } })]);
    await sync(a, "origin", "push");

    // B never runs `cledger sync` — just the plain fetch the installed
    // refspec would perform, landing the remote ref in the staging area.
    await git(["remote", "add", "origin", remote], { cwd: b.root });
    await makeCommit(b, "init b");
    await git(["fetch", "origin", `+${NOTES_REF}:${INCOMING_REF}`], { cwd: b.root });

    const events = await readEvents(b);
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0]?.content, { text: "staged-event" });

    const incoming = (await git(["rev-parse", "--verify", "--quiet", INCOMING_REF], {
      cwd: b.root,
      allowFailure: true,
    })).trim();
    assert.strictEqual(incoming, "", "staging ref must be cleared after absorption");
  } finally {
    await cleanupRepo(a);
    await cleanupRepo(b);
    await cleanupDir(remote);
  }
});

test("transportPush: pushes clean events; scan findings hold back only the ledger", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-tpush-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "init");

    await appendEvents(repo, [draft({ content: { text: "clean event" } })]);
    const clean = await transportPush(repo, "origin");
    assert.deepStrictEqual(clean, { pushed: true, held: false });
    assert.strictEqual(await remoteHasNotesRef(repo), true);
    const shaAfterClean = (await git(["ls-remote", "origin", NOTES_REF], { cwd: repo.root })).trim();

    // keyword-assignment is a scan-tier rule: captured intact, flagged at push.
    await appendEvents(repo, [
      draft({ content: { text: 'export password = "hunter2hunter2hunter2"' } }),
    ]);
    const held = await transportPush(repo, "origin");
    assert.deepStrictEqual(held, { pushed: false, held: true });
    const shaAfterHeld = (await git(["ls-remote", "origin", NOTES_REF], { cwd: repo.root })).trim();
    assert.strictEqual(shaAfterHeld, shaAfterClean, "finding must keep the remote ref untouched");

    await writeFile(join(repo.root, ".cledger.json"), JSON.stringify({ transport: { strict: true } }));
    await assert.rejects(transportPush(repo, "origin"), ScanBlockedError);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("pre-push hook end to end: a plain `git push` carries the ledger ref along", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-e2e-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "init");
    await appendEvents(repo, [draft({ content: { text: "rides along" } })]);

    await git(["push", "origin", "main"], { cwd: repo.root });
    assert.strictEqual(await remoteHasNotesRef(repo), true, "hook must push the notes ref");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("pre-push hook end to end: transport.strict aborts the whole push on a finding", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo("cledger-e2e-strict-");
  try {
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await makeCommit(repo, "init");
    await appendEvents(repo, [
      draft({ content: { text: 'db_password = "hunter2hunter2hunter2"' } }),
    ]);
    await writeFile(join(repo.root, ".cledger.json"), JSON.stringify({ transport: { strict: true } }));

    await assert.rejects(git(["push", "origin", "main"], { cwd: repo.root }));
    const heads = (await git(["ls-remote", "origin", "refs/heads/main"], { cwd: repo.root })).trim();
    assert.strictEqual(heads, "", "strict mode must abort the code push too");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});
