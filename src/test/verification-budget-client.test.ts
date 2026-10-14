import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLiveRun } from "../verification/budget-client.js";

test("Pi paid authorization requires campaign canary scope and authority confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-budget-client-"));
  const original = globalThis.fetch;
  let requests = 0, confirmed = false;
  globalThis.fetch = (async (url, options) => {
    requests++;
    assert.equal(String(url), "https://authority.example.invalid/sessions");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.cli, "pi"); assert.equal(body.campaign, "issue27"); assert.equal(body.maxRequests, 8);
    return new Response(JSON.stringify({ token: "TESTONLY-grant", pricingRevision: "TESTONLY-price", ...(confirmed ? { campaign: "issue27" } : {}) }));
  }) as typeof fetch;
  const options = { authority: "https://authority.example.invalid", adminToken: "TESTONLY-admin", cli: "pi",
    provider: "TESTONLY-provider", model: "TESTONLY-model", phase: "initial", maxMicroUsd: 100000,
    output: join(root, "session.json") };
  try {
    await assert.rejects(authorizeLiveRun(options), /unavailable/);
    assert.equal(requests, 0);
    await assert.rejects(authorizeLiveRun({ ...options, canary: true }), /Invalid authority grant/);
    confirmed = true;
    await authorizeLiveRun({ ...options, canary: true });
    const grant = JSON.parse(await readFile(options.output, "utf8"));
    assert.equal(grant.cli, "pi"); assert.equal(grant.campaign, "issue27"); assert.equal(grant.purpose, "canary");
    await assert.rejects(authorizeLiveRun({ ...options, cli: "cursor", canary: true }), /unavailable/);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});
