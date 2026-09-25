import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "annals";
import { filterFindings, loadAllowlist, loadConfig, scanEvents } from "../redact.js";
import { appendEvents, readEvents } from "../store.js";
import {
  cleanupDir,
  cleanupRepo,
  draft,
  makeBareRepo,
  makeCommit,
  makeTempRepo,
} from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

async function seedFinding(repo: Awaited<ReturnType<typeof makeTempRepo>>) {
  // Assemble the value so this test source is not itself a secret-shaped
  // fixture when this repository's conversations are captured and scanned.
  const secret = ["qZ8mK2", "pL7vN4wR"].join("");
  await appendEvents(repo, [draft({ content: { text: `password=${secret}` } })]);
  const config = await loadConfig(repo);
  const [finding] = filterFindings(
    scanEvents(await readEvents(repo), "standard"),
    await loadAllowlist(repo, config),
  );
  assert.ok(finding, "fixture must produce a finding");
  return { secret, finding };
}

function assertNoCoordinates(output: string, finding: { fingerprint: string; eventId: string }) {
  assert.ok(!output.includes(finding.fingerprint), "default output leaked a fingerprint");
  assert.ok(!output.includes(finding.eventId.slice(0, 16)), "default output leaked an event id");
}

function assertNoSecretFragments(output: string, secret: string) {
  for (let i = 0; i + 6 <= secret.length; i++) {
    assert.ok(!output.includes(secret.slice(i, i + 6)), "report leaked matched content");
  }
}

test("scan suppresses finding coordinates by default and --report opts into a contentless report", async () => {
  const repo = await makeTempRepo("cledger-scan-report-");
  try {
    await makeCommit(repo);
    const { secret, finding } = await seedFinding(repo);

    const concise = spawnSync(process.execPath, [CLI, "scan"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(concise.status, 1, "findings must retain the CI-friendly nonzero exit");
    assert.strictEqual(concise.stdout, "", "default scan must not print machine-readable sites");
    assert.match(concise.stderr, /1 distinct potential secret/);
    assert.match(concise.stderr, /same scan[\s\S]*adding --report/);
    assert.match(concise.stderr, /If you are an AGENT: stop here/);
    assertNoCoordinates(concise.stderr, finding);
    assertNoSecretFragments(concise.stderr, secret);

    const detailed = spawnSync(process.execPath, [CLI, "scan", "--report"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(detailed.status, 1, "--report must not weaken the scan result");
    assert.ok(detailed.stdout.includes(finding.fingerprint));
    assert.ok(detailed.stdout.includes(finding.eventId.slice(0, 16)));
    assert.ok(detailed.stdout.includes(`${finding.path}@${finding.start}`));
    assertNoSecretFragments(detailed.stdout + detailed.stderr, secret);
  } finally {
    await cleanupRepo(repo);
  }
});

test("sync passes --report through to Annals while remaining concise by default", async () => {
  const remote = await makeBareRepo("cledger-scan-report-remote-");
  const repo = await makeTempRepo("cledger-sync-report-");
  try {
    await makeCommit(repo);
    await git(["remote", "add", "backup", remote], { cwd: repo.root });
    const { secret, finding } = await seedFinding(repo);

    const originalFlags = ["backup", "--push-only", "--paranoid", "--all"];
    const concise = spawnSync(process.execPath, [CLI, "records", "sync", ...originalFlags], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(concise.status, 1, "a blocked sync must remain nonzero");
    assert.strictEqual(concise.stdout, "");
    assert.match(concise.stderr, /Finding details were suppressed/);
    assert.match(concise.stderr, /preserving the original remote and scope/);
    assert.ok(!concise.stderr.includes("sync origin"), "guidance must not substitute the default remote");
    assert.ok(
      !concise.stderr.includes("sync backup --report"),
      "guidance must not synthesize a command that drops --push-only/--paranoid/--all",
    );
    assertNoCoordinates(concise.stderr, finding);
    assertNoSecretFragments(concise.stderr, secret);

    const detailed = spawnSync(process.execPath, [CLI, "records", "sync", ...originalFlags, "--report"], {
      cwd: repo.root,
      encoding: "utf8",
      env: process.env,
    });
    assert.strictEqual(detailed.status, 1, "--report must not bypass the sync gate");
    assert.ok(detailed.stderr.includes(`[${finding.fingerprint}]`));
    assert.ok(detailed.stderr.includes(finding.eventId.slice(0, 16)));
    assert.ok(detailed.stderr.includes(`${finding.path}@${finding.start}`));
    assertNoSecretFragments(detailed.stdout + detailed.stderr, secret);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});
