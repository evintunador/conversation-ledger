import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignExitCode, coverageSummary, INTERACTIVE_DRIVERS, INTERVAL_MS, isDue, latestRelease, releaseChanges } from "../verification/campaign.js";
import { TARGET_CLIS } from "../verification/roster.js";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledCampaign, runCampaign } from "../verification/campaign.js";
import type { Report } from "../verification/opencode.js";

test("campaign has a fixed balanced roster and never promotes smoke evidence to full certification", () => {
  assert.equal(TARGET_CLIS.length, 20);
  assert.equal(new Set(TARGET_CLIS.map(c => c.id)).size, 20);
  assert.equal(TARGET_CLIS.filter(c => c.group === "big-player").length, 10);
  const coverage = coverageSummary([{ status: "pass", cli: "opencode" } as Report]);
  assert.equal(coverage.nativeSmokePassed, 1);
  assert.equal(coverage.fullyCertifiedPercent, 0);
});

test("missing login can warn without concealing failures or counting as coverage", () => {
  assert.ok(INTERACTIVE_DRIVERS.has("cline"));
  assert.ok(INTERACTIVE_DRIVERS.has("droid"));
  const blocked = { cli: "droid", status: "blocked", reasonCode: "login-required" };
  const report = { targets: [{ verification: blocked }] };
  assert.equal(campaignExitCode(report), 2);
  assert.equal(campaignExitCode(report, { allowLoginRequired: true }), 0);
  assert.equal(coverageSummary([blocked]).nativeSmokePassed, 0);
  assert.equal(coverageSummary([blocked]).nativeSmokeBlocked, 1);
  assert.equal(campaignExitCode({ targets: [{ verification: { ...blocked, reasonCode: "cli-unavailable" } }] },
    { allowLoginRequired: true }), 2);
  assert.equal(campaignExitCode({ targets: [...report.targets, { verification: { status: "fail" } }] },
    { allowLoginRequired: true }), 1);
  assert.equal(campaignExitCode({ maintenance: { campaign: report } }, { allowLoginRequired: true }), 1,
    "optional baseline auth never qualifies an unverified update candidate");
});

test("unavailable release checks retain last observation and new tags require review", () => {
  assert.deepEqual(releaseChanges({ a: "v1", b: "v2" }, {
    a: { status: "unavailable" }, b: { status: "observed", tag: "v3" }, c: { status: "observed", tag: "v1" },
  }), { tags: { a: "v1", b: "v3", c: "v1" }, changed: [{ cli: "b", previous: "v2", current: "v3" }] });
});

test("scheduled verification uses elapsed fourteen days, not twice monthly calendar dates", () => {
  const time = Date.parse("2026-01-30T12:00:00Z");
  assert.equal(isDue(undefined, time), true);
  assert.equal(isDue(new Date(time).toISOString(), time + INTERVAL_MS - 1), false);
  assert.equal(isDue(new Date(time).toISOString(), time + INTERVAL_MS), true);
  assert.equal(isDue("2027-01-01T00:00:00Z", time), false);
});

test("release checks distinguish stable evidence, missing feeds and unavailable upstreams", async () => {
  const mock = (status: number, value: unknown) => (async () => new Response(JSON.stringify(value), { status })) as typeof fetch;
  assert.equal((await latestRelease(undefined)).status, "not-configured");
  assert.deepEqual(await latestRelease("example/cli", mock(200, {
    tag_name: "v1.2.3", html_url: "https://github.com/example/cli/releases/tag/v1.2.3", draft: false, prerelease: false,
  })), { status: "observed", tag: "v1.2.3", url: "https://github.com/example/cli/releases/tag/v1.2.3" });
  assert.equal((await latestRelease("example/cli", mock(403, {}))).status, "unavailable");
  assert.equal((await latestRelease("example/cli", mock(200, { tag_name: "v2", html_url: "link", prerelease: true }))).status, "unavailable");
});

test("campaign exit status includes maintenance failures but not successful review proposals", () => {
  const targets = [{ verification: { status: "pass" } }];
  const proposal = { reviewRequired: true, observations: [{ status: "observed" }], changes: [{ cli: "fixture" }] };
  assert.equal(campaignExitCode({ targets, maintenance: proposal }), 0);
  assert.equal(campaignExitCode({ targets, maintenance: { ...proposal, campaign: { targets } } }), 0);
  assert.equal(campaignExitCode({ targets, maintenance: { reviewRequired: true, status: "failed" } }), 1);
  assert.equal(campaignExitCode({ targets, maintenance: { observations: [{ status: "unavailable" }] } }), 1);
  for (const status of ["fail", "blocked"]) assert.equal(campaignExitCode({ targets,
    maintenance: { ...proposal, campaign: { targets: [{ verification: { status } }] } } }), 1);
  assert.equal(campaignExitCode({ status: "blocked" }), 2);
  assert.equal(campaignExitCode({ status: "not-due" }), 0);
});


test("invalid scheduled CLI selection does not consume its cadence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cledger-schedule-invalid-"));
  const state = join(directory, "new-state");
  try {
    await assert.rejects(scheduledCampaign(state, false, undefined, ["TESTONLY-typo"]), /Unknown CLI IDs/);
    await assert.rejects(access(state), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
