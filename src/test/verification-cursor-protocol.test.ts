import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorField, cursorFields, cursorConnectPayload } from "../verification/cursor-protocol.js";
import { gzipSync } from "node:zlib";

test("Cursor Connect accepts native gzip TUI frames and leaves headless frames intact", () => {
  const bytes = cursorField(1, "TESTONLY café 日本語 🦉");
  assert.deepEqual(cursorConnectPayload(0, bytes), bytes);
  assert.deepEqual(cursorConnectPayload(1, gzipSync(bytes), "gzip"), bytes);
});

test("Cursor Connect rejects unsupported compression, corrupt gzip and oversized inflation", () => {
  assert.throws(() => cursorConnectPayload(1, Buffer.from("not gzip"), "gzip"));
  assert.throws(() => cursorConnectPayload(1, gzipSync(Buffer.from("TESTONLY")), "br"));
  assert.throws(() => cursorConnectPayload(2, Buffer.from("{}")));
  assert.throws(() => cursorConnectPayload(0, Buffer.alloc(2_000_001)));
  assert.throws(() => cursorConnectPayload(1, gzipSync(Buffer.alloc(2_000_001)), "gzip"));
});

test("pinned Cursor protobuf fields preserve repeated bytes and native integers", () => {
  const fields = cursorFields(Buffer.concat([cursorField(1, "first"), cursorField(1, "日本語"), cursorField(57, 16384), cursorField(7, Buffer.from([0, 255]))]));
  assert.deepEqual(fields.get(1), [Buffer.from("first"), Buffer.from("日本語")]);
  assert.deepEqual(fields.get(57), [16384n]);
  assert.deepEqual(fields.get(7), [Buffer.from([0, 255])]);
});

test("Cursor protobuf rejects invalid tags, truncated payloads and unsafe input sizes", () => {
  for (const bytes of [Buffer.from([0]), Buffer.from([10, 4, 1]), Buffer.from([128]), Buffer.from([15]), Buffer.alloc(2_000_001)])
    assert.throws(() => cursorFields(bytes));
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => cursorField(1, value));
  assert.throws(() => cursorField(0, "invalid"));
});
