import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rulesForTier, RULESET_VERSION } from "../redact/rules.js";
import { redactText } from "../redact/apply.js";

// Load fixture from source tree (not dist) so it's available at test time
const fixtureUrl = new URL(
  "../../src/test/fixtures/secret-corpus.json",
  import.meta.url,
);
const fixtureJson = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf-8"));

interface Positive {
  rule: string;
  secret: string;
  context: string;
}

interface CorpusFixture {
  positives: Positive[];
  negatives: string[];
}

/**
 * Fixture entries store each fake secret as `secret_parts` (split mid-token)
 * with a `{SECRET}` placeholder in the context, so no literal token bytes
 * exist in the repository — otherwise secret scanners (GitHub push
 * protection, gitleaks over the source tree) flag the corpus itself.
 * Reassemble here, at test runtime only.
 */
interface StoredPositive {
  rule: string;
  secret_parts: string[];
  context: string;
}

const stored = fixtureJson as { positives: StoredPositive[]; negatives: string[] };
const corpus: CorpusFixture = {
  positives: stored.positives.map((p) => {
    const secret = p.secret_parts.join("");
    return { rule: p.rule, secret, context: p.context.split("{SECRET}").join(secret) };
  }),
  negatives: stored.negatives,
};

// Validate fixture structure
assert.ok(Array.isArray(corpus.positives), "fixture.positives must be an array");
assert.ok(Array.isArray(corpus.negatives), "fixture.negatives must be an array");

test("secret-corpus: fixture loads correctly", () => {
  assert.strictEqual(corpus.positives.length, 27, "expected 27 positive test cases");
  assert.strictEqual(corpus.negatives.length, 9, "expected 9 negative test cases");
});

test("secret-corpus: all positives are redacted", () => {
  const rules = rulesForTier("capture");
  const failures: string[] = [];

  for (const positive of corpus.positives) {
    const { text, matches } = redactText(positive.context, rules);

    // Secret must not appear verbatim in redacted output
    if (text.includes(positive.secret)) {
      failures.push(
        `${positive.rule}: secret still present in redacted text`,
      );
    }

    // Redacted output must contain redaction marker
    if (!text.includes("[REDACTED:")) {
      failures.push(
        `${positive.rule}: redacted text missing [REDACTED: marker`,
      );
    }

    // Must have at least one match with expected rule ID
    const ruleMatches = matches.filter((m) => m.rule === positive.rule);
    if (ruleMatches.length === 0) {
      failures.push(
        `${positive.rule}: no matches found for rule in ${positive.context.substring(0, 50)}...`,
      );
    }
  }

  assert.strictEqual(failures.length, 0, failures.join("\n"));
});

test("secret-corpus: all negatives pass through unchanged", () => {
  const rules = rulesForTier("capture");
  const failures: string[] = [];

  for (const negative of corpus.negatives) {
    const { text, matches } = redactText(negative, rules);

    // Output must be identical to input
    if (text !== negative) {
      failures.push(
        `negative changed: input=${negative.substring(0, 50)}..., output=${text.substring(0, 50)}...`,
      );
    }

    // Must have zero matches
    if (matches.length > 0) {
      failures.push(
        `negative matched unexpectedly: "${negative.substring(0, 50)}..." matched ${matches.length} rules`,
      );
    }
  }

  assert.strictEqual(failures.length, 0, failures.join("\n"));
});

test("secret-corpus: redaction is deterministic", () => {
  const rules = rulesForTier("capture");
  const allContexts = corpus.positives.map((p) => p.context).join("\n---\n");

  const first = redactText(allContexts, rules);
  const second = redactText(allContexts, rules);

  assert.deepStrictEqual(first, second, "redaction must be deterministic");
  assert.strictEqual(
    first.text,
    second.text,
    "redacted text must be identical across runs",
  );
  assert.deepStrictEqual(
    first.matches,
    second.matches,
    "matches must be identical across runs",
  );
});

test("secret-corpus: gitleaks oracle (if available)", async (t) => {
  // Check if gitleaks is available
  const versionCheck = spawnSync("gitleaks", ["version"], {
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (versionCheck.status !== 0) {
    t.skip();
    return;
  }

  // Create temp directory for redacted files
  const tempDir = mkdtempSync(join(tmpdir(), "secret-corpus-gitleaks-"));

  try {
    const rules = rulesForTier("capture");

    // Write each positive's redacted context to a temp file
    for (let i = 0; i < corpus.positives.length; i++) {
      const positive = corpus.positives[i];
      if (!positive) continue;
      const { text } = redactText(positive.context, rules);
      const filePath = join(tempDir, `positive-${i}.txt`);
      writeFileSync(filePath, text, "utf-8");
    }

    // Run gitleaks on the temp directory
    const gitleaksRun = spawnSync("gitleaks", ["detect", "--no-git", "--source", tempDir, "--exit-code", "1"], {
      stdio: "pipe",
      encoding: "utf-8",
    });

    // Exit code 0 means no leaks found, which is what we want
    assert.strictEqual(
      gitleaksRun.status,
      0,
      `gitleaks found leaks in redacted output: ${gitleaksRun.stdout}`,
    );
  } finally {
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  }
});
