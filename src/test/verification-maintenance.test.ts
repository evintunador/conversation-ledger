import test from "node:test";
import assert from "node:assert/strict";
import { observePackages, pinProposal } from "../verification/maintenance.js";
import { PINNED_NPM_RUNTIMES } from "../verification/runtimes.js";

test("maintenance proposes exact changed pins and refuses stale source", async () => {
  const request = (async () => new Response(JSON.stringify({ version: "99.0.1" }))) as typeof fetch;
  const records = await observePackages(request);
  assert.equal(records.length, PINNED_NPM_RUNTIMES.length);
  const record = records[0]!;
  const source = `cli: "${record.cli}", package: "${record.package}", version: "${record.pinned}"`;
  assert.match(pinProposal(source, [record]), /version: "99.0.1"/);
  assert.throws(() => pinProposal("source has moved", [record]), /manual review/);
});

test("unavailable or malformed release data cannot become an upgrade", async () => {
  for (const response of [() => new Response("{}", { status: 503 }), () => new Response('{"version":"latest"}')]) {
    const records = await observePackages((async () => response()) as typeof fetch);
    assert.ok(records.every(r => r.status === "unavailable" && !r.latest));
    assert.equal(pinProposal("unchanged", records), "unchanged");
  }
});
