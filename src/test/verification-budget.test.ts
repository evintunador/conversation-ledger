import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetStore, reservationCost, type ReviewedPrice } from "../verification/budget.js";
import { boundedChat, startBudgetAuthority } from "../verification/budget-authority.js";
const price: ReviewedPrice = { provider: "TESTONLY-provider", model: "TESTONLY-model", revision: "TESTONLY-reviewed-v1", validUntil: "2099-01-01",
  maxBillableInputTokens: 1000000, maxOutputTokens: 1000000, inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  endpoint: "https://example.invalid/v1/chat/completions",
  inputAccounting: { review: "TESTONLY-tokenizer-template-reviewed-v1", modelContextTokens: 2000000,
    tokensPerUtf8ByteUpperBound: 1, fixedOverheadTokens: 100, perMessageOverheadTokens: 20, perToolOverheadTokens: 50 } };
async function fixture() { const root = await mkdtemp(join(tmpdir(), "cledger-budget-test-")); const store = new BudgetStore(join(root, "state.json")); await store.initialize(); return { root, store }; }
const authorization = () => ({ cli: "opencode", provider: price.provider, model: price.model, revision: price.revision,
  phase: "initial" as const, expires: Date.now() + 60000, maxRequests: 4, maxMicroUsd: 5000000 });
test("durable reservations survive new authorities, retain unknown charges and cannot reset monthly cap with new run IDs", async () => {
  const { root, store } = await fixture();
  try {
    const first = await store.createSession(authorization());
    assert.equal((await store.reserve(first, price)).microUsd, 2000000);
    const restarted = new BudgetStore(store.path);
    const second = await restarted.createSession(authorization());
    await restarted.reserve(second, price);
    await assert.rejects(restarted.reserve(first, price), /Budget exhausted/);
    const data = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(data.initial.opencode, 4000000);
    assert.equal(Object.values(data.months)[0] && (Object.values(data.months)[0] as Record<string, number>).opencode, 4000000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("concurrent authorities never exceed the cap; stale locks and corrupt prices fail closed", async () => {
  const { root, store } = await fixture();
  try {
    const token = await store.createSession(authorization());
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => new BudgetStore(store.path).reserve(token, price)));
    assert.ok(results.filter(r => r.status === "fulfilled").length <= 2);
    await mkdir(store.path + ".lock");
    await assert.rejects(store.reserve(token, price));
    assert.throws(() => reservationCost({ ...price, validUntil: "2000-01-01" }), /expired/);
    assert.throws(() => reservationCost({ ...price, outputMicroUsdPerMillion: NaN }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("chat proxy caps output and rejects unknown billable features instead of estimating them", () => {
  const request = { model: price.model, messages: [{ role: "user", content: "TESTONLY synthetic prompt" }], max_tokens: 2000000 };
  assert.equal(boundedChat(request, price).max_tokens, price.maxOutputTokens);
  assert.throws(() => boundedChat({ ...request, web_search_options: {} }, price));
  assert.throws(() => boundedChat({ ...request, messages: [{ role: "user", content: [{ type: "image_url" }] }] }, price));
  assert.throws(() => boundedChat({ ...request, tool_choice: { type: "web_search" } }, price));
  assert.throws(() => boundedChat({ ...request, tools: [{ type: "function", function: { name: "read" }, hosted_search: true }] }, price));
  assert.throws(() => boundedChat({ ...request, messages: [{ role: "assistant", content: null, tool_calls: [{ id: "TESTONLY-call", type: "function", function: { name: "read", arguments: "{}", billing_extension: true } }] }] }, price));
});
test("authority forwards only after durable reservation; provider failure retains full cost and scoped token cannot issue grants", async t => {
  const { root, store } = await fixture(); let forwarded = 0;
  let authority: Awaited<ReturnType<typeof startBudgetAuthority>> | undefined;
  try {
    try { authority = await startBudgetAuthority({ store, adminToken: "TESTONLY-admin-token-at-least-32-characters", routes: [{ price, apiKey: "TESTONLY-provider-secret" }],
      request: (async (_url, options) => { forwarded++; assert.equal(new Headers(options?.headers).get("authorization"), "Bearer TESTONLY-provider-secret"); assert.equal(JSON.parse(String(options?.body)).max_tokens, price.maxOutputTokens); return new Response("", { status: 500 }); }) as typeof fetch }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Loopback socket forbidden by sandbox"); return; } throw error; }
    const issued = await fetch(authority.endpoint + "/sessions", { method: "POST",
      headers: { authorization: "Bearer TESTONLY-admin-token-at-least-32-characters", "content-type": "application/json" },
      body: JSON.stringify({ cli: "opencode", provider: price.provider, model: price.model, phase: "initial", maxRequests: 4, maxMicroUsd: 5000000 }) });
    assert.equal(issued.status, 201);
    const token = (await issued.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-cledger-provider": price.provider };
    const denied = await fetch(authority.endpoint + "/sessions", { method: "POST", headers, body: "{}" }); assert.equal(denied.status, 403);
    const unsupported = await fetch(authority.endpoint + "/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: price.model, messages: [{ role: "user", content: "TESTONLY" }], web_search_options: {} }) });
    assert.equal(unsupported.status, 429); assert.equal(forwarded, 0);
    for (let i = 0; i < 3; i++) await fetch(authority.endpoint + "/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: price.model, messages: [{ role: "user", content: "TESTONLY" }] }) });
    assert.equal(forwarded, 2);
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).initial.opencode, 4000000);
  } finally { await authority?.close(); await rm(root, { recursive: true, force: true }); }
});

test("missing durable state never recreates a fresh budget", async () => {
  const { root, store } = await fixture();
  try { await rm(store.path); await assert.rejects(store.createSession(authorization()), /ENOENT/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt persisted scopes fail closed rather than bypassing lifetime or request limits", async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(store.createSession({ ...authorization(), expires: NaN }), /Invalid run/);
    const token = await store.createSession(authorization());
    const data = JSON.parse(await readFile(store.path, "utf8"));
    Object.values(data.sessions).forEach((session: unknown) => { (session as Record<string, unknown>).phase = "TESTONLY-invalid-phase"; });
    await writeFile(store.path, JSON.stringify(data));
    await assert.rejects(store.reserve(token, price), /Corrupt budget/);
    await assert.rejects(store.createSession(authorization()), /Corrupt budget/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("initial allocation never replenishes in a later month and scopes cannot change model or revision", async () => {
  const { root, store } = await fixture();
  try {
    const now = Date.UTC(2030, 0, 1), later = Date.UTC(2030, 1, 1);
    const first = await store.createSession({ ...authorization(), expires: now + 60000 }, now);
    await store.reserve(first, price, now); await store.reserve(first, price, now);
    const second = await store.createSession({ ...authorization(), expires: later + 60000 }, later);
    await assert.rejects(store.reserve(second, { ...price, model: "TESTONLY-other" }, later), /mismatched/);
    await assert.rejects(store.reserve(second, { ...price, revision: "TESTONLY-other" }, later), /mismatched/);
    await assert.rejects(store.reserve(second, price, later), /Budget exhausted/);
    const maintenance = await store.createSession({ ...authorization(), phase: "maintenance", expires: later + 60000 }, later);
    await store.reserve(maintenance, price, later);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("large input cannot exceed its reservation ceiling even when provider context is larger", async t => {
  const { root, store } = await fixture(); let forwarded = 0;
  const small: ReviewedPrice = { ...price, maxBillableInputTokens: 4096, maxOutputTokens: 1024,
    inputAccounting: { ...price.inputAccounting, modelContextTokens: 128000 } };
  let authority: Awaited<ReturnType<typeof startBudgetAuthority>> | undefined;
  try {
    assert.throws(() => boundedChat({ model: small.model, messages: [{ role: "user", content: "TESTONLY".repeat(2000) }] }, small), /input token upper bound/);
    assert.throws(() => reservationCost({ ...small, inputAccounting: undefined } as unknown as ReviewedPrice), /accounting/);
    try { authority = await startBudgetAuthority({ store, adminToken: "TESTONLY-admin-token-at-least-32-characters", routes: [{ price: small, apiKey: "TESTONLY-provider-secret" }],
      request: (async () => { forwarded++; return new Response("{}"); }) as typeof fetch }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Loopback socket forbidden by sandbox"); return; } throw error; }
    const token = await store.createSession(authorization());
    const response = await fetch(authority.endpoint + "/v1/chat/completions", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-cledger-provider": small.provider },
      body: JSON.stringify({ model: small.model, messages: [{ role: "user", content: "TESTONLY".repeat(2000) }] }) });
    assert.equal(response.status, 429); assert.equal(forwarded, 0);
    const ledger = JSON.parse(await readFile(store.path, "utf8"));
    assert.deepEqual(ledger.initial, {}); assert.deepEqual(ledger.months, {});
    assert.equal(Object.values(ledger.sessions).length, 1);
  } finally { await authority?.close(); await rm(root, { recursive: true, force: true }); }
});
