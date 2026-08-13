import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "../git.js";
import { shannonEntropy } from "../redact/rules.js";
import {
  addToAllowlist,
  filterFindings,
  findingGuidance,
  formatFinding,
  formatGroupedReport,
  groupFindings,
  inAgentSession,
  loadAllowlist,
  renderFinding,
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

test("scanEvents: standard tier finds a keyword-anchored secret in both content and raw.data; the report carries coordinates, never content", () => {
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
    // Findings carry coordinates, not text: the report can point at the match
    // without reproducing anything that could trip a rule when re-captured.
    assert.ok(f.path.length > 0, "finding must record where the match is");
    assert.ok(f.end > f.start, "finding must record the match span");
    // The report must leak *zero* characters of the secret — not even the
    // leading/trailing ones an elided-middle form would print. Every 6-char
    // window of the secret must be absent from the rendered finding.
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
  assert.ok(!formatFinding(paranoidFindings[0]!).includes(token));
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

test("scanEvents: paranoid tier never flags a reasoning event's encrypted_content, but still flags its summary field", () => {
  const token = "aB3xQ9mK2pL7vN4wR8tY1zC6dF0sH5jG"; // 32 chars, clears the entropy bar
  assert.ok(shannonEntropy(token) >= 4.0);

  const e = event({
    kind: "reasoning",
    content: { opaque: true },
    raw: {
      format: "codex-rollout-jsonl/2",
      data: {
        payload: {
          type: "reasoning",
          encrypted_content: `blob-${token}-blob-${token}-more`,
          summary: [{ type: "summary_text", text: `random blob: ${token} trailing text` }],
        },
      },
    },
  });

  const findings = scanEvents([e], "paranoid").filter((f) => f.rule === "high-entropy");
  assert.strictEqual(
    findings.some((f) => f.path.includes("encrypted_content")),
    false,
    "encrypted_content must never surface a finding",
  );
  assert.ok(
    findings.some((f) => f.path.includes("summary")),
    "summary must still be scanned like any other visible content",
  );
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

test("allowlist tiers: global entries apply to every repo, config entries ride the config", async () => {
  // HOME is isolated per test process (helpers.ts), so the "global" tier
  // lands in a throwaway ~/.config/cledger.
  const repoA = await makeTempRepo();
  const repoB = await makeTempRepo();
  try {
    await addToAllowlist(repoA, ["feedfacefeed"], "global");
    assert.ok((await loadAllowlist(repoA)).has("feedfacefeed"), "global entry visible in repo A");
    assert.ok(
      (await loadAllowlist(repoB)).has("feedfacefeed"),
      "the same human decision must not be re-made per repo — that is the point of the tier",
    );
    // Local entries stay local.
    await addToAllowlist(repoA, ["0123456789ab"], "local");
    assert.ok(!(await loadAllowlist(repoB)).has("0123456789ab"));

    // Config-carried fingerprints (committed in .cledger.json) join the union.
    const withConfig = await loadAllowlist(repoB, {
      scan: { allowFingerprints: ["cafebabecafe"] },
    });
    assert.ok(withConfig.has("cafebabecafe"));
    assert.ok(withConfig.has("feedfacefeed"), "config tier adds to, never replaces, the files");
  } finally {
    await cleanupRepo(repoA);
    await cleanupRepo(repoB);
  }
});

test("scanEvents: an uppercase fixture marker exempts scan-tier heuristics, never capture-tier formats", () => {
  // The fixture convention: a deliberately fake credential carries FAKE /
  // EXAMPLE / PLACEHOLDER / DUMMY / NOTREAL / TESTONLY in the matched span,
  // so it never becomes a finding and never needs allowlisting.
  const marked = [
    "password=FAKEhunter2hunter2",
    'api_key: "EXAMPLE-abcdefgh12345678"',
    "access_token=xPLACEHOLDERx1234567",
  ];
  for (const text of marked) {
    const findings = scanEvents([event({ content: { text } })], "standard");
    assert.strictEqual(findings.length, 0, `marker must exempt: ${text}`);
  }

  // Lowercase does not count: "example.com" in URL credentials is not an
  // authoring choice, it is half the internet.
  const lower = scanEvents(
    [event({ content: { text: "https://admin:realpass123@example.com/x" } })],
    "standard",
  );
  assert.ok(lower.length > 0, "lowercase 'example' must not exempt url-credentials");

  // Capture-tier rules match real token formats and stay exempt-free: a
  // format-valid GitHub token is flagged even with FAKE inside, because a
  // real leaked token could contain those bytes by chance.
  const ghpLike = `ghp_FAKE${"a1B2c3D4".repeat(4)}`; // ghp_ + 36 chars
  const captureFindings = scanEvents([event({ content: { text: `x ${ghpLike} x` } })], "standard");
  assert.ok(
    captureFindings.some((f) => f.rule === "github-token"),
    "capture-tier formats must not honor the marker",
  );
});

test("groupFindings/formatGroupedReport: one block per distinct span, coordinates only", () => {
  const secret = "supersecret123456";
  const e1 = event({ content: { text: `password=${secret}` } });
  const e2 = event({
    content: { text: `again password=${secret}` },
    raw: { format: "test/1", data: { blob: `password=${secret}` } },
  });
  const other = event({ content: { text: "api_key=differentsecret99" } });

  const findings = scanEvents([e1, e2, other], "standard");
  const groups = groupFindings(findings);
  // Same span across events and content/raw mirrors collapses to one group;
  // the different span stays its own group.
  assert.strictEqual(groups.length, 2);
  const big = groups.find((g) => g.findings.length > 1)!;
  assert.strictEqual(big.eventIds.length, 2);

  const report = formatGroupedReport(findings);
  // One decision per span: each fingerprint appears exactly once as a block header.
  for (const g of groups) {
    assert.strictEqual(
      report.split(`[${g.fingerprint}]`).length - 1,
      1,
      "each fingerprint must head exactly one block",
    );
  }
  // Same no-content rule as formatFinding.
  for (let i = 0; i + 6 <= secret.length; i++) {
    assert.ok(!report.includes(secret.slice(i, i + 6)), "grouped report must not leak content");
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

/**
 * The reporting/inspection split. Reports are contentless so they cannot
 * re-seed themselves when captured; everything readable lives behind
 * `renderFinding`, whose output is expected to reach a file, not a terminal.
 */

test("formatFinding leaks no content — not the match, not its surroundings", () => {
  // The surrounding words are the real hazard: `password=` is what the
  // keyword rule anchors on, so echoing context re-trips the same rule.
  const secret = "supersecret123456";
  const e = event({ content: { text: `deploy notes: password=${secret} rotate quarterly` } });
  const [f] = scanEvents([e], "standard");
  assert.ok(f);

  const rendered = formatFinding(f!);
  assert.ok(!rendered.includes(secret), "must not contain the secret");
  assert.ok(!rendered.includes("password="), "must not contain the anchoring keyword");
  assert.ok(!rendered.includes("rotate quarterly"), "must not contain trailing context");
  // what it *should* contain: coordinates a human can act on
  assert.ok(rendered.includes(f!.fingerprint), "fingerprint is needed for `cledger allow`");
  assert.ok(rendered.includes(f!.path), "path tells the human where to look");
});

test("renderFinding gives wide context, masking the match unless revealed", () => {
  const secret = "supersecret123456";
  const before = "A".repeat(300);
  const after = "B".repeat(300);
  const e = event({ content: { text: `${before} password=${secret} ${after}` } });
  const [f] = scanEvents([e], "standard");
  assert.ok(f);

  const masked = renderFinding(e, f!, { context: 200, reveal: false });
  assert.ok(!masked.includes(secret), "masked render must not contain the secret");
  assert.ok(masked.includes("<redacted>"), "masked render marks where the match was");
  // the point of the command: enough surroundings to actually judge it
  assert.ok(masked.includes("A".repeat(150)), "must include wide leading context");
  assert.ok(masked.includes("B".repeat(150)), "must include wide trailing context");
  assert.ok(masked.includes(f!.path), "must say where in the event this is");

  const revealed = renderFinding(e, f!, { context: 200, reveal: true });
  assert.ok(revealed.includes(secret), "--reveal must show the matched text");
});

test("renderFinding context width is honoured on both sides", () => {
  const e = event({ content: { text: `${"x".repeat(500)} password=hunter2000000 ${"y".repeat(500)}` } });
  const [f] = scanEvents([e], "standard");
  const narrow = renderFinding(e, f!, { context: 10, reveal: false });
  const wide = renderFinding(e, f!, { context: 400, reveal: false });
  assert.ok(wide.length > narrow.length, "wider context must render more text");
  assert.ok(narrow.includes("chars before"), "truncation must be disclosed, not silent");
});

test("renderFinding survives an event rewritten since the scan", () => {
  const e = event({ content: { text: "password=supersecret123456" } });
  const [f] = scanEvents([e], "standard");
  const moved = { ...f!, path: "content/gone" };
  const out = renderFinding(e, moved, { context: 100, reveal: false });
  assert.match(out, /no longer present/);
});

test("inAgentSession detects the harness markers it guards against", () => {
  assert.equal(inAgentSession({}), null);
  assert.equal(inAgentSession({ PATH: "/usr/bin" }), null);
  assert.equal(inAgentSession({ CLAUDECODE: "1" }), "CLAUDECODE");
  assert.equal(inAgentSession({ CODEX_SANDBOX: "1" }), "CODEX_SANDBOX");
});

test("findingGuidance addresses humans and agents separately", () => {
  const g = findingGuidance(["ev1-abc123"]);
  assert.match(g, /HUMAN/);
  assert.match(g, /AGENT/);
  assert.match(g, /cledger inspect ev1-abc123/, "must name the actual event to inspect");
  assert.match(g, /Do not run/, "must tell an agent to stop, not just warn");
});
