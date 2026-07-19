import { test } from "node:test";
import assert from "node:assert";
import { canonicalJson, sha256Hex } from "../canonical.js";

test("canonicalJson sorts object keys recursively", () => {
  const input = { b: 1, a: 2, c: { z: 1, y: { d: 1, c: 2 } } };
  assert.strictEqual(
    canonicalJson(input),
    '{"a":2,"b":1,"c":{"y":{"c":2,"d":1},"z":1}}',
  );
});

test("canonicalJson key ordering is independent of input key order", () => {
  const a = { x: 1, y: { m: 1, n: 2 }, z: 3 };
  const b = { z: 3, y: { n: 2, m: 1 }, x: 1 };
  assert.strictEqual(canonicalJson(a), canonicalJson(b));
});

test("canonicalJson preserves array element order but sorts keys within elements", () => {
  const input = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
  assert.strictEqual(canonicalJson(input), '[{"a":2,"b":1},{"c":4,"d":3}]');
});

test("canonicalJson drops undefined object properties at every depth", () => {
  const input = { a: 1, b: undefined, c: { d: undefined, e: 2 } };
  assert.strictEqual(canonicalJson(input), '{"a":1,"c":{"e":2}}');
});

test("canonicalJson drops undefined properties even when they are the only ones", () => {
  assert.strictEqual(canonicalJson({ a: undefined }), "{}");
});

test("canonicalJson leaves null values intact (distinct from undefined)", () => {
  assert.strictEqual(canonicalJson({ a: null, b: 1 }), '{"a":null,"b":1}');
});

test("canonicalJson has no insignificant whitespace", () => {
  const out = canonicalJson({ a: [1, 2, 3], b: "x" });
  assert.ok(!/\s/.test(out), `expected no whitespace in: ${out}`);
});

test("sha256Hex is stable and deterministic for identical input", () => {
  const h1 = sha256Hex("hello world");
  const h2 = sha256Hex("hello world");
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("sha256Hex differs for different input", () => {
  assert.notStrictEqual(sha256Hex("a"), sha256Hex("b"));
});

test("sha256Hex matches a known vector", () => {
  // sha256("") — the canonical empty-string test vector.
  assert.strictEqual(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("canonicalJson round trip: differently-ordered equal objects hash identically", () => {
  const a = canonicalJson({ id: 1, name: "x", nested: { p: 1, q: 2 } });
  const b = canonicalJson({ nested: { q: 2, p: 1 }, name: "x", id: 1 });
  assert.strictEqual(sha256Hex(a), sha256Hex(b));
});
