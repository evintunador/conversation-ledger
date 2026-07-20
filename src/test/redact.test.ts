import { test } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../canonical.js";
import { RULES, RULESET_VERSION, rulesForTier, shannonEntropy } from "../redact/rules.js";
import { redactDraft, redactText } from "../redact/apply.js";
import { captureRules, loadConfig } from "../redact/config.js";
import { appendEvents, readNoteEvents } from "../store.js";
import { cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Deterministic filler of `n` characters drawn from `charset`. */
function chars(charset: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += charset[i % charset.length];
  return out;
}

// One format-valid (but fake) secret per capture-tier rule id.
const FAKE_SECRETS: Record<string, string> = {
  "github-token": "ghp_" + chars(ALNUM, 40),
  "github-fine-grained": "github_pat_" + chars(ALNUM + "_", 40),
  "anthropic-api-key": "sk-ant-" + chars(ALNUM + "_-", 40),
  "openai-api-key": "sk-proj-" + chars(ALNUM + "_-", 30),
  "aws-access-key-id": "AKIA" + chars(UPPER_ALNUM, 16),
  "google-api-key": "AIza" + chars(ALNUM + "_-", 35),
  "slack-token": "xoxb-" + chars(ALNUM + "-", 12),
  "stripe-key": "sk_live_" + chars(ALNUM, 30),
  "gitlab-pat": "glpat-" + chars(ALNUM + "_-", 25),
  "npm-token": "npm_" + chars(ALNUM, 36),
  "sendgrid-key": "SG." + chars(ALNUM + "_-", 22) + "." + chars(ALNUM + "_-", 43),
  "private-key-block":
    "-----BEGIN RSA PRIVATE KEY-----\n" +
    "MIIEowIBAAKCAQEAfakefakefakefakefakefakefake\n" +
    "-----END RSA PRIVATE KEY-----",
  jwt:
    "eyJ" +
    chars(ALNUM + "_-", 15) +
    ".eyJ" +
    chars(ALNUM + "_-", 15) +
    "." +
    chars(ALNUM + "_-", 15),
};

function fakeSecret(id: string): string {
  const secret = FAKE_SECRETS[id];
  if (!secret) throw new Error(`missing fake secret fixture for rule "${id}"`);
  return secret;
}

const CAPTURE_RULES = rulesForTier("capture");

test("every capture rule redacts its format-valid fake token", () => {
  for (const rule of CAPTURE_RULES) {
    const secret = FAKE_SECRETS[rule.id];
    assert.ok(secret, `missing fake secret fixture for capture rule "${rule.id}"`);
    const text = `here is a token: ${secret} - keep it safe`;
    const { text: out, matches } = redactText(text, [rule]);
    assert.ok(
      out.includes(`[REDACTED:${rule.id}:`),
      `rule "${rule.id}" did not produce a placeholder; got: ${out}`,
    );
    assert.ok(!out.includes(secret), `rule "${rule.id}" left the secret in the output`);
    assert.strictEqual(matches.length, 1, `rule "${rule.id}" should match exactly once`);
    assert.strictEqual(matches[0]?.rule, rule.id);
    assert.strictEqual(matches[0]?.fingerprint, sha256Hex(secret).slice(0, 12));
  }
});

test("redactText is deterministic: same input yields identical output", () => {
  const secret = FAKE_SECRETS["github-token"];
  const text = `token=${secret} and again token=${secret}`;
  const first = redactText(text, CAPTURE_RULES);
  const second = redactText(text, CAPTURE_RULES);
  assert.deepStrictEqual(first, second);
});

test("redactText is idempotent: placeholders are not re-matched", () => {
  const secret = FAKE_SECRETS["anthropic-api-key"];
  const text = `key: ${secret}`;
  const once = redactText(text, CAPTURE_RULES);
  const twice = redactText(once.text, CAPTURE_RULES);
  assert.strictEqual(twice.text, once.text);
  assert.strictEqual(twice.matches.length, 0);
});

test("redactText leaves non-secrets untouched: uuid, git sha, near-miss prefix, plain sentence", () => {
  const negatives = [
    "550e8400-e29b-41d4-a716-446655440000",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e",
    "sk-anthropic-is-cool",
    "The quick brown fox jumps over the lazy dog.",
  ];
  for (const text of negatives) {
    const { text: out, matches } = redactText(text, CAPTURE_RULES);
    assert.strictEqual(out, text, `expected "${text}" to be left untouched`);
    assert.strictEqual(matches.length, 0, `expected no matches for "${text}"`);
  }
});

test("redactText skips entropy-gated (paranoid) rules entirely — scan-only", () => {
  const highEntropyLooking = "aB3xQ9mK2pL7vN4wR8tY1zC6dF0sH5jG";
  const { text, matches } = redactText(highEntropyLooking, rulesForTier("paranoid"));
  assert.strictEqual(text, highEntropyLooking);
  assert.strictEqual(matches.length, 0);
});

test("rulesForTier: capture < standard < paranoid, cumulative", () => {
  const capture = rulesForTier("capture");
  const standard = rulesForTier("standard");
  const paranoid = rulesForTier("paranoid");
  assert.ok(capture.every((r) => r.tier === "capture"));
  assert.ok(standard.length > capture.length);
  assert.ok(paranoid.length > standard.length);
  assert.deepStrictEqual(paranoid.map((r) => r.id).sort(), RULES.map((r) => r.id).sort());
  const highEntropy = paranoid.find((r) => r.id === "high-entropy");
  assert.strictEqual(highEntropy?.entropyGated, true);
});

test("shannonEntropy: low for repetitive strings, positive for varied strings", () => {
  assert.strictEqual(shannonEntropy(""), 0);
  assert.strictEqual(shannonEntropy("aaaa"), 0);
  assert.ok(shannonEntropy("ab") > 0);
  assert.ok(shannonEntropy("abcdabcd") < shannonEntropy("abcdefgh"));
});

test("redactDraft: deep-nests through content and raw.data with correct paths", () => {
  const secretA = fakeSecret("github-token");
  const secretB = fakeSecret("jwt");
  const input = draft({
    content: {
      blocks: [{ text: "clean" }, { text: "also clean" }, { text: `leaked: ${secretA}` }],
    },
    raw: {
      format: "test/1",
      data: { message: { content: [{ text: `bearer-ish jwt: ${secretB}` }] } },
    },
  });

  const { draft: out, records } = redactDraft(input, { rules: CAPTURE_RULES });

  const blocks = (out.content as { blocks: { text: string }[] }).blocks;
  assert.strictEqual(blocks[0]?.text, "clean");
  assert.strictEqual(blocks[1]?.text, "also clean");
  assert.ok(blocks[2]?.text.includes("[REDACTED:github-token:"));
  assert.ok(!blocks[2]?.text.includes(secretA));

  const rawData = out.raw?.data as { message: { content: { text: string }[] } };
  const rawText = rawData.message.content[0]?.text;
  assert.ok(rawText?.includes("[REDACTED:jwt:"));
  assert.ok(!rawText?.includes(secretB));

  const paths = records.map((r) => r.path).sort();
  assert.deepStrictEqual(paths, ["content/blocks/2/text", "raw/data/message/content/0/text"].sort());
  for (const r of records) {
    assert.strictEqual(r.ruleset, RULESET_VERSION);
  }

  // Input must not be mutated.
  const originalBlocks = (input.content as { blocks: { text: string }[] }).blocks;
  assert.ok(originalBlocks[2]?.text.includes(secretA));
});

test("redactDraft: extraValues scrub exact secrets, longest match wins on overlap", () => {
  const short = "shortsecret1";
  const long = short + "-with-suffix";
  const input = draft({
    content: { text: `a=${long} b=${short} c=unrelated` },
  });

  const { draft: out, records } = redactDraft(input, { rules: [], extraValues: [short, long] });
  const text = (out.content as { text: string }).text;

  assert.ok(!text.includes(long));
  assert.ok(!text.includes(short));
  assert.ok(text.includes("c=unrelated"));
  assert.strictEqual(records.length, 2);
  assert.ok(records.every((r) => r.rule === "env-value"));
  const fingerprints = records.map((r) => r.fingerprint).sort();
  assert.deepStrictEqual(
    fingerprints,
    [sha256Hex(short).slice(0, 12), sha256Hex(long).slice(0, 12)].sort(),
  );
  // Different exact values must yield different fingerprints.
  assert.notStrictEqual(fingerprints[0], fingerprints[1]);
});

test("loadConfig: repo config wins per-section over user config (shallow merge)", async () => {
  const home = await mkdtemp(join(tmpdir(), "cledger-home-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "cledger-repo-"));
  const originalHome = process.env.HOME;
  try {
    await mkdir(join(home, ".config", "cledger"), { recursive: true });
    await writeFile(
      join(home, ".config", "cledger", "config.json"),
      JSON.stringify({ redact: { capture: false, env: true }, scan: { tier: "standard" } }),
    );
    await writeFile(join(repoRoot, ".cledger.json"), JSON.stringify({ redact: { capture: true } }));
    process.env.HOME = home;

    const config = await loadConfig(repoRoot);
    // Repo's `redact` section wins wholesale (shallow-per-section): the
    // user's redact.env=true does not leak through even though repo's
    // redact object never mentions `env`.
    assert.deepStrictEqual(config.redact, { capture: true });
    // `scan` is untouched by repo config, so the user's section carries
    // through unchanged.
    assert.deepStrictEqual(config.scan, { tier: "standard" });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadConfig: malformed or missing config files are ignored silently", async () => {
  const home = await mkdtemp(join(tmpdir(), "cledger-home-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "cledger-repo-"));
  const originalHome = process.env.HOME;
  try {
    await writeFile(join(repoRoot, ".cledger.json"), "{not valid json");
    process.env.HOME = home; // no ~/.config/cledger at all
    const config = await loadConfig(repoRoot);
    assert.deepStrictEqual(config, {});
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("captureRules: [] when redact.capture is false", () => {
  assert.deepStrictEqual(captureRules({ redact: { capture: false } }), []);
});

test("captureRules: default is the full capture tier; user patterns compiled, invalid ones dropped silently", () => {
  const rules = captureRules({
    redact: {
      patterns: [
        { id: "custom-1", pattern: "FOO-[0-9]+" },
        { pattern: "(unterminated" }, // invalid regex — must be skipped, not thrown
      ],
    },
  });
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes("github-token"));
  assert.strictEqual(ids.filter((id) => id === "custom-1").length, 1);
  assert.strictEqual(rules.length, CAPTURE_RULES.length + 1);

  const { text } = redactText("code FOO-42 here", rules);
  assert.ok(text.includes("[REDACTED:custom-1:"));
});

test("appendEvents: a fake ghp_ token in a draft lands redacted in the note, with redactions recorded and raw scrubbed", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "init");
    const secret = fakeSecret("github-token");
    const result = await appendEvents(repo, [
      draft({
        content: { text: `here is a token: ${secret}` },
        raw: { format: "test/1", data: { message: secret } },
      }),
    ]);
    assert.strictEqual(result.appended.length, 1);
    const [appended] = result.appended;
    assert.ok(appended);

    const contentJson = JSON.stringify(appended.content);
    assert.ok(!contentJson.includes(secret));
    assert.match(contentJson, /\[REDACTED:github-token:[0-9a-f]{12}\]/);
    assert.ok(appended.redactions && appended.redactions.length > 0);
    assert.ok(appended.redactions?.some((r) => r.rule === "github-token"));

    assert.ok(result.anchor);
    const [stored] = await readNoteEvents(repo, result.anchor!);
    assert.ok(stored);
    const storedJson = JSON.stringify(stored);
    assert.ok(!storedJson.includes(secret), "the persisted note must never contain the raw secret");
    assert.match(JSON.stringify(stored?.raw), /\[REDACTED:github-token:[0-9a-f]{12}\]/);
  } finally {
    await cleanupRepo(repo);
  }
});
