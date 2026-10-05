import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorField, cursorFields } from "../verification/cursor-protocol.js";

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
