import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "../git.js";
import { shannonEntropy } from "../redact/rules.js";
import {
  addToAllowlist,
  filterFindings,
  formatFinding,
  loadAllowlist,
  scanEvents,
} from "../redact/scan.js";
import { appendEvents, NOTES_NAME, readEvents, sync } from "../store.js";
import {
  cleanupDir,
  cleanupRepo,
  draft,
  event,
  makeBareRepo,
  makeCommit,
  makeTempRepo,
} from "./helpers.js";

test("scanEvents: standard tier finds a keyword-anchored secret in both content and raw.data; excerpt never contains the full secret", () => {
  const secret = "supersecret123456";
  const e = event({
    content: { text: `config: password=${secret} end` },
    raw: { format: "test/1", data: { blob: `db password=${secret}` } },
  });

  const findings = scanEvents([e], "standard");
  assert.ok(findings.length >= 2, "expected findings in both content and raw.data");
  for (const f of findings) {
    assert.strictEqual(f.rule, "keyword-assignment");
    assert.strictEqual(f.eventId, e.id);
    assert.match(f.fingerprint, /^[0-9a-f]{12}$/);
    assert.ok(!f.excerpt.includes(secret), "excerpt must never contain the full secret");
    assert.ok(
      formatFinding(f).includes("<redacted>"),
      "excerpt should mask the match with the marker, not omit it entirely",
    );
    // The masked report must leak *zero* characters of the secret — not even
    // the leading/trailing ones an elided-middle form would print. Every
    // 6-char window of the secret must be absent from the rendered finding.
    const rendered = formatFinding(f);
    for (let i = 0; i + 6 <= secret.length; i++) {
      assert.ok(
        !rendered.includes(secret.slice(i, i + 6)),
        `rendered finding leaked a substring of the secret: ${secret.slice(i, i + 6)}`,
      );
    }
  }
});

test("scanEvents: keyword-assignment ignores source code that merely talks about secrets", () => {
  // The false-positive class that dogfooding surfaced: type annotations and
  // template interpolation in cledger's own redaction source. None of these
  // carry an actual credential.
  const codeShapes = [
    "function maskMatch(secret: string): string { return x; }",
    "const msg = `leaked a substring of the secret: ${secret.slice(i, i + 6)}`;",
    "interface Opts { password: string; api_key: string }",
    "log(`credentials: ${JSON.stringify(creds)}`)",
    "type Cfg = { access_token: string | undefined };",
  ];
  for (const text of codeShapes) {
    const findings = scanEvents([event({ content: { text } })], "standard").filter(
      (f) => f.rule === "keyword-assignment",
    );
    assert.strictEqual(findings.length, 0, `must not flag source code: ${text}`);
  }
});

test("scanEvents: keyword-assignment still catches real credential assignments", () => {
  const realShapes = [
    "password=supersecret123456",
    'db_password: "hunter2hunter2hunter2"',
    "export password = 'aVeryLongPassphrase1'",
    "api_key:sk_test_abcdefghijklmnop",
    "access_token=ya29.A0ARrdaM-longtokenvalue",
  ];
  for (const text of realShapes) {
    const findings = scanEvents([event({ content: { text } })], "standard").filter(
      (f) => f.rule === "keyword-assignment",
    );
    assert.ok(findings.length > 0, `must still flag a real assignment: ${text}`);
  }
});

test("scanEvents + filterFindings: an allowlisted fingerprint is suppressed", () => {
  const secret = "supersecret123456";
  const e = event({ content: { text: `password=${secret}` } });
  const findings = scanEvents([e], "standard");
  assert.ok(findings.length > 0);

  const allowlist = new Set(findings.map((f) => f.fingerprint));
  assert.strictEqual(filterFindings(findings, allowlist).length, 0);

  // A disjoint allowlist must not suppress anything.
  assert.strictEqual(filterFindings(findings, new Set(["deadbeefcafe"])).length, findings.length);
});

test("scanEvents: paranoid tier finds a high-entropy token that standard tier does not", () => {
  const token = "aB3xQ9mK2pL7vN4wR8tY1zC6dF0sH5jG"; // 32 chars, mixed case + digits
  assert.ok(shannonEntropy(token) >= 4.0, "fixture token must actually clear the entropy bar");

  const e = event({ content: { text: `random blob: ${token} trailing text` } });

  const standardFindings = scanEvents([e], "standard").filter((f) => f.rule === "high-entropy");
  assert.strictEqual(standardFindings.length, 0, "high-entropy rule must not run at standard tier");

  const paranoidFindings = scanEvents([e], "paranoid").filter((f) => f.rule === "high-entropy");
  assert.strictEqual(paranoidFindings.length, 1);
  assert.ok(!paranoidFindings[0]?.excerpt.includes(token));
});

test("scanEvents: paranoid tier skips pure-hex candidates (git SHAs, digests) even at high entropy", () => {
  // Uniform over exactly the 16 hex symbols -> entropy is exactly the
  // maximum possible for a hex alphabet (log2(16) = 4.0), so this fixture
  // clears the >=4.0 bar on its own merits and isolates the pure-hex guard.
  const hexCandidate = "0123456789abcdef0123456789abcdef";
  assert.ok(shannonEntropy(hexCandidate) >= 4.0);

  const e = event({ content: { text: `blob sha: ${hexCandidate} end` } });
  const findings = scanEvents([e], "paranoid").filter((f) => f.rule === "high-entropy");
  assert.strictEqual(findings.length, 0);
});

test("scanEvents: paranoid tier skips candidates that fall inside an existing [REDACTED:...] placeholder", () => {
  const token = "aB3xQ9mK2pL7vN4wR8tY1zC6dF0sH5jG";
  assert.ok(shannonEntropy(token) >= 4.0);
  // Embed the high-entropy token as the rule-id segment of a placeholder so
  // it would otherwise be picked up as its own high-entropy candidate.
  const text = `already handled: [REDACTED:${token}:abc123456789]`;
  const e = event({ content: { text } });

  const findings = scanEvents([e], "paranoid").filter((f) => f.rule === "high-entropy");
  assert.strictEqual(findings.length, 0);
});

test("loadAllowlist/addToAllowlist: persists fingerprints under .git/conversation-ledger/allowlist.json", async () => {
  const repo = await makeTempRepo();
  try {
    assert.deepStrictEqual(await loadAllowlist(repo), new Set());

    await addToAllowlist(repo, ["fp1", "fp2"]);
    assert.deepStrictEqual([...(await loadAllowlist(repo))].sort(), ["fp1", "fp2"]);

    // Idempotent / additive: re-adding and adding a new one merges, no duplicates.
    await addToAllowlist(repo, ["fp2", "fp3"]);
    assert.deepStrictEqual([...(await loadAllowlist(repo))].sort(), ["fp1", "fp2", "fp3"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("sync gate: a secret blocks push, nothing reaches the remote, and the report names the fingerprint", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await appendEvents(repo, [draft({ content: { text: "password=supersecret123" } })]);

    await assert.rejects(() => sync(repo, "origin", "push"), /push blocked/);

    // Nothing was pushed: the remote must still have no notes ref at all.
    const remoteRef = (
      await git(["ls-remote", remote, "refs/notes/conversation-ledger"], { cwd: repo.root })
    ).trim();
    assert.strictEqual(remoteRef, "", "the remote must not have received the ledger ref");
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("sync gate: allowlisting the fingerprint lets the same sync succeed", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    const secret = "supersecret123";
    await appendEvents(repo, [draft({ content: { text: `password=${secret}` } })]);

    let blockedFindings: ReturnType<typeof scanEvents> = [];
    try {
      await sync(repo, "origin", "push");
      assert.fail("expected the first sync to be blocked");
    } catch {
      blockedFindings = filterFindings(
        scanEvents(await readEvents(repo), "standard"),
        await loadAllowlist(repo),
      );
    }
    assert.ok(blockedFindings.length > 0);
    await addToAllowlist(repo, blockedFindings.map((f) => f.fingerprint));

    const result = await sync(repo, "origin", "push");
    assert.strictEqual(result.pushed, true);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("sync gate: skipScan bypasses the gate entirely", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["remote", "add", "origin", remote], { cwd: repo.root });
    await appendEvents(repo, [draft({ content: { text: "password=supersecret123" } })]);

    const result = await sync(repo, "origin", "push", { skipScan: true });
    assert.strictEqual(result.pushed, true);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});

test("sync gate: events the remote already has are not rescanned on a later sync", async () => {
  const remote = await makeBareRepo();
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    await git(["remote", "add", "origin", remote], { cwd: repo.root });

    // First push: clean content, gate passes normally.
    await appendEvents(repo, [draft({ content: { text: "hello world" } })]);
    const first = await sync(repo, "origin", "push");
    assert.strictEqual(first.pushed, true);

    // Mutate the already-pushed note in place to *look* like it now
    // contains a secret (simulating an old, already-shared event that
    // would trip the gate if it were rescanned) without going through the
    // normal capture/redact path.
    const anchor = (await git(["rev-parse", "HEAD"], { cwd: repo.root })).trim();
    const body = await git(["notes", "--ref", NOTES_NAME, "show", anchor], { cwd: repo.root });
    const tampered = body.replace("hello world", "password=supersecret123");
    await git(["notes", "--ref", NOTES_NAME, "add", "-f", "-F", "-", anchor], {
      cwd: repo.root,
      input: tampered,
    });

    // Add one genuinely new, clean event alongside it.
    await appendEvents(repo, [draft({ content: { text: "clean-followup" } })]);

    // Sync must not rescan the (now-tampered) already-pushed event, so the
    // push proceeds even though local content technically contains a match.
    const second = await sync(repo, "origin", "push");
    assert.strictEqual(second.pushed, true);
  } finally {
    await cleanupRepo(repo);
    await cleanupDir(remote);
  }
});
