import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addKnownSecrets, loadKnownSecrets } from "../redact/known-secrets.js";
import { appendEvents, redactEvent } from "../store.js";
import { cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";

function knownSecretsPath(gitDir: string): string {
  return join(gitDir, "conversation-ledger", "known-secrets.json");
}

async function enableKnownSecrets(repoRoot: string): Promise<void> {
  await writeFile(join(repoRoot, ".cledger.json"), JSON.stringify({ redact: { knownSecrets: true } }));
}

test("loadKnownSecrets/addKnownSecrets: dedups, sorts, drops sub-8-char values, no file until something sticks", async () => {
  const repo = await makeTempRepo();
  try {
    assert.deepStrictEqual(await loadKnownSecrets(repo), []);

    // "short" (5 chars) is below the min-length floor and must be dropped;
    // an all-too-short batch must not even create the file.
    await addKnownSecrets(repo, ["short", "tiny"]);
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)), "no value stuck -> no store file");

    await addKnownSecrets(repo, ["longenoughvalue", "short", "anothergoodone"]);
    assert.deepStrictEqual(await loadKnownSecrets(repo), ["anothergoodone", "longenoughvalue"]);

    // Additive + idempotent: re-adding an existing value and a new one merges.
    await addKnownSecrets(repo, ["longenoughvalue", "thirdgoodvalue"]);
    assert.deepStrictEqual(await loadKnownSecrets(repo), [
      "anothergoodone",
      "longenoughvalue",
      "thirdgoodvalue",
    ]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --pattern (opt-in on): remembers the scrubbed value, then capture-time redaction scrubs it from a later event", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);
    const secret = "hunter2xK9aa"; // 12 chars, no prefix -> capture tier leaves it raw

    // 1. Capture an event holding the secret; capture tier does not catch it.
    const first = await appendEvents(repo, [
      draft({
        content: { text: `db_password: ${secret}` },
        raw: { format: "test/1", data: { blob: `db_password: ${secret}` } },
      }),
    ]);
    const original = first.appended[0]!;
    assert.ok(JSON.stringify(original).includes(secret), "sanity: secret survives capture tier raw");

    // 2. Human confirms it's a real secret via --pattern; it gets remembered.
    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret });
    assert.strictEqual(result.knownSecretsRemembered, 1);
    assert.deepStrictEqual(await loadKnownSecrets(repo), [secret]);

    // 3. A *new* event (distinct text so its id differs) mentioning the same
    //    value is now scrubbed automatically at capture time.
    const second = await appendEvents(repo, [
      draft({ content: { text: `reminder, the key was ${secret} last week` } }),
    ]);
    const later = second.appended[0]!;
    assert.ok(!JSON.stringify(later.content).includes(secret), "known value must be scrubbed on ingest");
    assert.ok(
      later.redactions?.some((r) => r.rule === "known-secret"),
      "the scrub must be recorded under the known-secret rule id",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --pattern (opt-in off, the default): nothing is remembered and later captures are not scrubbed", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const secret = "hunter2xK9aa";

    const first = await appendEvents(repo, [draft({ content: { text: `db_password: ${secret}` } })]);
    const original = first.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: secret });
    assert.strictEqual(result.knownSecretsRemembered, 0);
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)), "off by default -> store is never created");

    const second = await appendEvents(repo, [
      draft({ content: { text: `reminder, the key was ${secret} last week` } }),
    ]);
    assert.ok(
      JSON.stringify(second.appended[0]!.content).includes(secret),
      "with the flag off, a later capture of the same value stays raw",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --pattern (opt-in on): a sub-8-char match is scrubbed from the event but not remembered", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);
    const shortSecret = "abc123"; // 6 chars, below the remember floor

    const first = await appendEvents(repo, [draft({ content: { text: `pin=${shortSecret}` } })]);
    const original = first.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { pattern: shortSecret });
    assert.ok(!JSON.stringify(result.event.content).includes(shortSecret), "the event itself is still redacted");
    assert.strictEqual(result.knownSecretsRemembered, 0, "too-short value must not be remembered");
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)));
  } finally {
    await cleanupRepo(repo);
  }
});

test("redact --all (opt-in on): whole-content blanking remembers nothing (no reusable value)", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await enableKnownSecrets(repo.root);

    const first = await appendEvents(repo, [draft({ content: { text: "db_password: hunter2xK9aa" } })]);
    const original = first.appended[0]!;

    const result = await redactEvent(repo, original.id.slice(4, 12), { all: true });
    assert.strictEqual(result.knownSecretsRemembered, 0);
    assert.ok(!existsSync(knownSecretsPath(repo.gitDir)));
  } finally {
    await cleanupRepo(repo);
  }
});

test("known-secrets store lives under .git/, which git never tracks", async () => {
  const repo = await makeTempRepo();
  try {
    await addKnownSecrets(repo, ["longenoughvalue"]);
    const path = knownSecretsPath(repo.gitDir);
    assert.ok(existsSync(path));
    assert.ok(path.includes(`${repo.gitDir}/conversation-ledger/`), "store sits beside the allowlist under .git/");
    // Plaintext is expected here — this is the local, unshared store.
    assert.ok((await readFile(path, "utf8")).includes("longenoughvalue"));
  } finally {
    await cleanupRepo(repo);
  }
});
