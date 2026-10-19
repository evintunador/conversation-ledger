import test from "node:test";
import assert from "node:assert/strict";
import { observeReleases, publishUpdateIssues, newerStableVersion, unseenUpdates, updateIssue, updateMarker, type ReleaseUpdate } from "../verification/release-watch.js";
import { PINNED_NPM_RUNTIMES } from "../verification/runtimes.js";

const pin = PINNED_NPM_RUNTIMES.find(item => item.cli === "codex")!;
const update: ReleaseUpdate = { cli: "codex", source: "npm", package: pin.package, pinned: pin.version, latest: "99.0.0",
  url: "https://www.npmjs.com/package/%40openai%2Fcodex/v/99.0.0" };
const runUrl = "https://github.com/EXAMPLE/EXAMPLE/actions/runs/1";
const bot = { login: "github-actions[bot]" };
const issue = (body: string, number = 1, state = "open") => ({ number, body, state, user: bot });

test("only strictly newer stable versions qualify, with numeric rather than lexical ordering", () => {
  assert.equal(newerStableVersion("1.10.0", "1.9.9"), true);
  for (const version of ["1.9.9", "1.8.0", "1.10.0-beta.1", "v1.10.0", "01.10.0", "bad\nversion"])
    assert.equal(newerStableVersion(version, "1.9.9"), false);
  assert.equal(newerStableVersion("99999999999999999999.0.0", "1.0.0"), true);
});

test("deduplication survives pin changes and closed issues, but permits a new upstream version", () => {
  const body = updateIssue(update, runUrl).body;
  assert.deepEqual(unseenUpdates([update, { ...update, pinned: "0.9.0" }], [body]), []);
  assert.equal(unseenUpdates([{ ...update, latest: "100.0.0" }], [body]).length, 1);
  assert.match(body, /"schema": "cledger-cli-update\/1"/);
});

test("forged package identities, source URLs, downgrades and stale pins fail before any API writes", async () => {
  for (const bad of [
    { ...update, cli: "droid" }, { ...update, source: "other" },
    { ...update, package: "EXAMPLE-untrusted" }, { ...update, url: "https://EXAMPLE.invalid/" },
    { ...update, latest: "bad\nversion" }, { ...update, pinned: "1.0.0" }, { ...update, latest: "0.0.1" },
  ]) {
    let called = false;
    const request = (async () => { called = true; return Response.json([]); }) as typeof fetch;
    await assert.rejects(publishUpdateIssues([update, bad as ReleaseUpdate], "EXAMPLE/EXAMPLE", "TESTONLY", runUrl, request), /Invalid release/);
    assert.equal(called, false);
  }
});

test("polling uses metadata only, preserves partial results, and selects the newest Rust CLI release", async () => {
  const urls: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    if (url.includes("registry.npmjs.org")) {
      const name = decodeURIComponent(url.split("/").at(-2)!);
      const recipe = PINNED_NPM_RUNTIMES.find(item => item.package === name)!;
      return Response.json({ version: recipe.cli === "codex" ? "99.0.0" : recipe.version });
    }
    if (url.includes("aider-chat")) return new Response("unavailable", { status: 503 });
    if (url.includes("pypi.org")) return Response.json({ info: { version: url.includes("mistral-vibe") ? "2.25.8" : "1.16.0" } });
    if (url.includes("openinterpreter")) return Response.json([
      { tag_name: "v9.0.0" }, { tag_name: "rust-v99.0.0", prerelease: true },
      { tag_name: "rust-v0.0.45" }, { tag_name: "rust-v0.0.46" },
    ]);
    return Response.json([{ tag_name: url.includes("goose") ? "v1.52.0" : "v0.97.1" }]);
  }) as typeof fetch;
  const result = await observeReleases(request);
  assert.deepEqual(result.updates.map(item => [item.cli, item.latest]), [["codex", "99.0.0"], ["open-interpreter", "0.0.46"]]);
  assert.deepEqual(result.unavailable.map(item => item.cli), ["aider"]);
  assert.deepEqual(result.unconfigured.map(item => item.cli), ["cursor"]);
  assert.ok(urls.every(url => /registry\.npmjs\.org|pypi\.org|api\.github\.com/.test(url)));
  assert.ok(urls.every(url => !/droid|kiro/.test(url)));
});

test("publisher paginates, skips closed dispositions, and deduplicates repeated observations", async () => {
  const created: unknown[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const data = JSON.parse(String(init.body)); created.push(data);
      return Response.json(issue(data.body, 101));
    }
    const page = new URL(String(input)).searchParams.get("page");
    return Response.json(page === "1" ? Array.from({ length: 100 }, (_, i) => issue("EXAMPLE unrelated", i + 1)) : [issue(updateMarker(update), 1000, "closed")]);
  }) as typeof fetch;
  const next = { ...update, latest: "100.0.0", url: update.url.replace("99.0.0", "100.0.0") };
  assert.deepEqual(await publishUpdateIssues([update, next, next], "EXAMPLE/EXAMPLE", "TESTONLY", runUrl, request),
    { created: 1, skipped: 2, qualificationQueued: false });
  assert.equal(created.length, 1);
});

test("a failed dispatch retries the existing issue, then the receipt suppresses further dispatch", async () => {
  const issues: ReturnType<typeof issue>[] = [];
  const comments: { body: string; user: typeof bot }[] = [];
  let dispatches = 0;
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), post = init?.method === "POST";
    if (url.includes("/dispatches")) {
      dispatches++;
      assert.deepEqual(JSON.parse(String(init?.body)), { ref: "main" });
      return dispatches === 1 ? new Response("unavailable", { status: 503 }) : new Response(null, { status: 204 });
    }
    if (url.includes("/comments")) {
      if (post) { comments.push({ ...JSON.parse(String(init?.body)), user: bot }); return Response.json({}); }
      return Response.json(comments);
    }
    if (post) { const data = JSON.parse(String(init?.body)); const created = issue(data.body); issues.push(created); return Response.json(created); }
    return Response.json(issues);
  }) as typeof fetch;
  const publish = () => publishUpdateIssues([update], "EXAMPLE/EXAMPLE", "TESTONLY", runUrl, request, "main");
  await assert.rejects(publish(), /HTTP 503/);
  assert.equal(issues.length, 1);
  assert.deepEqual(await publish(), { created: 0, skipped: 1, qualificationQueued: true });
  assert.deepEqual(await publish(), { created: 0, skipped: 1, qualificationQueued: false });
  assert.equal(dispatches, 2);
  assert.equal(comments.length, 1);
});

test("closed issues do not dispatch and non-bot receipts do not suppress qualification", async () => {
  let dispatches = 0;
  const forged = updateMarker(update).replace("cledger-cli-update:", "cledger-cli-qualification:");
  for (const state of ["closed", "open"]) {
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/dispatches")) { dispatches++; return new Response(null, { status: 204 }); }
      if (init?.method === "POST") return Response.json({});
      if (url.includes("/comments")) return Response.json([{ body: forged, user: { login: "EXAMPLE-human" } }]);
      return Response.json([issue(updateMarker(update), 1, state)]);
    }) as typeof fetch;
    await publishUpdateIssues([update], "EXAMPLE/EXAMPLE", "TESTONLY", runUrl, request, "main");
    assert.equal(dispatches, state === "closed" ? 0 : 1);
  }
});

test("publisher fails visibly on API errors instead of assuming an empty issue list", async () => {
  const request = (async () => new Response("unavailable", { status: 403 })) as typeof fetch;
  await assert.rejects(publishUpdateIssues([update], "EXAMPLE/EXAMPLE", "TESTONLY", runUrl, request), /HTTP 403/);
});
