import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidatesQualified, qualifiedChanges, checkCandidates } from "../verification/hosted-review.js";

const report = (id: string, status: string, reason?: string) => ({ targets: [{ id, verification: { status, ...(reason ? { reason } : {}) } }] });
test("a failed or missing candidate cannot hold back another passing CLI", () => {
  const changes = ["codex", "copilot", "cline"].map(cli => ({ cli, package: cli, pinned: "1.0.0", latest: "1.1.0", status: "observed" as const }));
  const headless = { targets: [...report("codex", "pass").targets, ...report("copilot", "fail").targets] };
  const interactive = { targets: [...report("codex", "pass").targets, ...report("copilot", "pass").targets] };
  assert.deepEqual(qualifiedChanges("success", changes, headless, interactive).map(item => item.cli), ["codex"]);
  assert.deepEqual(qualifiedChanges("failure", changes, headless, interactive), []);
});
test("maintenance pin proposals require a passing baseline and both candidate modes", () => {
  const pass = report("codex", "pass");
  assert.equal(candidatesQualified("success", ["codex"], pass, pass), true);
  for (const baseline of ["failure", "cancelled", "skipped", "unknown"]) {
    assert.equal(candidatesQualified(baseline, ["codex"], pass, pass), false);
  }
  for (const status of ["fail", "blocked", "not-run"]) {
    assert.equal(candidatesQualified("success", ["codex"], report("codex", status), pass), false);
    assert.equal(candidatesQualified("success", ["codex"], pass, report("codex", status)), false);
  }
  assert.equal(candidatesQualified("success", ["codex"], pass), false);
  assert.equal(candidatesQualified("success", ["codex", "codex"], pass, pass), false);
  assert.equal(candidatesQualified("success", [], pass, pass), false);
  assert.equal(candidatesQualified("success", ["codex"], { targets: [...pass.targets, ...pass.targets] }, pass), false);
});
test("Cline and Droid candidates must pass their resumed interactive checks", () => {
  for (const id of ["cline", "droid"]) {
    const pass = report(id, "pass");
    assert.equal(candidatesQualified("success", [id], pass, pass), true);
    for (const status of ["not-run", "blocked", "fail"])
      assert.equal(candidatesQualified("success", [id], pass, report(id, status, "Login required")), false);
  }
});

test("installation and headless driver failures preserve independent candidates and interactive checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cledger-candidate-isolation-"));
  try {
    const calls: string[] = [];
    const changes = ["broken-install", "broken-headless", "codex"].map(cli => ({ cli, package: cli, pinned: "1.0.0", latest: "1.1.0", status: "observed" as const }));
    const result = await checkCandidates(directory, changes, {
      provision: async (_root, selected, versions) => {
        assert.equal(versions[selected[0]!], "1.1.0");
        if (selected[0] === "broken-install") throw Error("TESTONLY install failure");
      },
      run: async (_root, cli, mode) => {
        calls.push(`${cli}:${mode}`);
        if (cli === "broken-headless" && mode === "headless") throw Error("TESTONLY driver failure");
        return report(cli, "pass");
      },
    });
    assert.deepEqual(calls, ["broken-headless:headless", "broken-headless:interactive", "codex:headless", "codex:interactive"]);
    assert.deepEqual(result.candidateErrors.map(item => item.cli), ["broken-install"]);
    assert.deepEqual(qualifiedChanges("success", changes, result.headless, result.interactive).map(item => item.cli), ["codex"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
