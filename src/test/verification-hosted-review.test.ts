import test from "node:test";
import assert from "node:assert/strict";
import { candidatesQualified } from "../verification/hosted-review.js";

const report = (id: string, status: string, reason?: string) => ({ targets: [{ id, verification: { status, ...(reason ? { reason } : {}) } }] });
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
