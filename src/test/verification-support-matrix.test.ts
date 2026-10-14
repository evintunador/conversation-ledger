import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSupportMatrix, CANARY_GATES } from "../verification/support-matrix.js";
import { CONFORMANCE_CASES } from "../verification/conformance.js";
const native = (overrides = {}) => ({ schema: "cledger-conformance/1", cli: "gemini-cli", version: "0.61.0", platform: "darwin/arm64", mode: "interactive", inference: "scripted", status: "pass", events: 30, requests: 6,
  cases: Object.fromEntries(CONFORMANCE_CASES.map(name => [name, { status: "pass", detail: "Observed installed scenario" }])), ...overrides });
const cell = (docs: unknown[]) => buildSupportMatrix(docs.map((data, i) => ({ data, path: `TESTONLY-${i}.json` }))).rows.find(r => r.cli === "gemini-cli")!.cells;
test("headless, wrong-version and smoke evidence cannot close an installed TUI case", () => {
  const cells = cell([native({ mode: "headless" }), native({ version: "0.60.0" }), native({ schema: "cledger-verification/1" })]);
  assert.equal(cells['darwin/headless']!.cases.resume!.status, "pass");
  assert.equal(cells['darwin/interactive']!.cases.resume!.status, "not-run");
  assert.equal(cells['linux/headless']!.cases.resume!.status, "not-run");
});
test("a later failed scenario supersedes a historical pass and cannot certify its asserted cases", () => {
  const cells = cell([native({ completed: "2026-10-05T01:00:00Z", status: "fail" }), native({ completed: "2026-10-04T01:00:00Z" })]);
  assert.equal(cells['darwin/interactive']!.cases.resume!.status, "fail");
  assert.equal(cell([native({ events: 0 })])['darwin/interactive']!.cases.resume!.status, "not-run");
  const emptyFailure = cell([native({ completed: "2026-10-04T01:00:00Z" }),
    native({ completed: "2026-10-05T01:00:00Z", status: "fail", events: 0, requests: 0 })])['darwin/interactive']!;
  assert.equal(emptyFailure.scenario!.status, "fail");
  assert.ok(Object.values(emptyFailure.cases).every(result => result.status === "not-run"));
});
test("a live label cannot replace explicit automatic capture/resume/two-backfill canary gates", () => {
  const report = { schema: "cledger-canary/1", cli: "gemini-cli", version: "0.61.0", platform: "darwin/arm64", mode: "interactive", inference: "usual-provider", provider: "TESTONLY", model: "TESTONLY", requests: 4, status: "pass", gates: { answer: true } };
  assert.equal(cell([report])['darwin/interactive']!.usualProvider.status, "fail");
  assert.equal(cell([{ ...report, gates: Object.fromEntries(CANARY_GATES.map(g => [g, true])) }])['darwin/interactive']!.usualProvider.status, "pass");
  assert.equal(cell([{ ...report, requests: 0, gates: Object.fromEntries(CANARY_GATES.map(g => [g, true])) }])['darwin/interactive']!.usualProvider.status, "fail");
  assert.equal(cell([{ ...report, schema: "cledger-live-verification/1" }])['darwin/interactive']!.usualProvider.status, "not-run");
});
test("matrix retains the complete roster and never closes with absent evidence", () => {
  const matrix = buildSupportMatrix([]);
  assert.equal(matrix.rows.length, 20);
  assert.equal(matrix.complete, false);
  assert.equal(Object.keys(matrix.rows[0]!.cells).length, 4);
});
