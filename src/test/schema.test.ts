import { test } from "node:test";
import assert from "node:assert";
import {
  eventId,
  finalizeEvent,
  validateEvent,
  SCHEMA_VERSION,
  type EventDraft,
  type EvidenceEvent,
} from "../schema.js";
import { draft } from "./helpers.js";

test("eventId: identical drafts produce identical ids", () => {
  const d1 = draft();
  const d2 = draft();
  assert.strictEqual(eventId(d1), eventId(d2));
});

test("eventId: is stable across repeated calls on the same draft", () => {
  const d = draft();
  assert.strictEqual(eventId(d), eventId(d));
});

test("eventId: changing content changes the id", () => {
  const id1 = eventId(draft({ content: { text: "hello" } }));
  const id2 = eventId(draft({ content: { text: "goodbye" } }));
  assert.notStrictEqual(id1, id2);
});

test("eventId: changing kind changes the id", () => {
  const id1 = eventId(draft({ kind: "conversation_turn" }));
  const id2 = eventId(draft({ kind: "decision" }));
  assert.notStrictEqual(id1, id2);
});

test("eventId: changing occurred_at changes the id", () => {
  const id1 = eventId(draft({ occurred_at: "2026-01-01T00:00:00.000Z" }));
  const id2 = eventId(draft({ occurred_at: "2026-01-02T00:00:00.000Z" }));
  assert.notStrictEqual(id1, id2);
});

test("eventId: changing context does NOT change the id", () => {
  const id1 = eventId(draft({ context: { branch: "main", head: "abc123" } }));
  const id2 = eventId(draft({ context: { branch: "feature", head: "def456" } }));
  assert.strictEqual(id1, id2);
});

test("eventId: changing raw does NOT change the id", () => {
  const id1 = eventId(draft({ raw: { format: "x/1", data: { a: 1 } } }));
  const id2 = eventId(draft({ raw: { format: "y/2", data: { b: 2 } } }));
  assert.strictEqual(id1, id2);
});

test("eventId: changing recorded_at does NOT change the id", () => {
  const id1 = eventId(draft({ recorded_at: "2026-01-01T00:00:00.000Z" }));
  const id2 = eventId(draft({ recorded_at: "2099-01-01T00:00:00.000Z" }));
  assert.strictEqual(id1, id2);
});

test("eventId: changing producer.tool does NOT change the id", () => {
  const id1 = eventId(draft({ producer: { tool: "cledger" } }));
  const id2 = eventId(draft({ producer: { tool: "some-other-tool" } }));
  assert.strictEqual(id1, id2);
});

test("eventId: changing producer.version does NOT change the id", () => {
  const id1 = eventId(draft({ producer: { tool: "cledger", version: "0.1.0" } }));
  const id2 = eventId(draft({ producer: { tool: "cledger", version: "9.9.9" } }));
  assert.strictEqual(id1, id2);
});

test("eventId: ids always start with the ev1- prefix", () => {
  assert.match(eventId(draft()), /^ev1-[0-9a-f]{64}$/);
});

test("finalizeEvent: fills id, schema, and recorded_at when absent", () => {
  const finalized = finalizeEvent(draft());
  assert.match(finalized.id, /^ev1-/);
  assert.strictEqual(finalized.schema, SCHEMA_VERSION);
  assert.ok(finalized.recorded_at.length > 0);
  assert.strictEqual(finalized.id, eventId(draft()));
});

test("finalizeEvent: throws when kind is missing", () => {
  const bad = draft() as EventDraft;
  // @ts-expect-error deliberately constructing an invalid draft
  delete bad.kind;
  assert.throws(() => finalizeEvent(bad), /kind is required/);
});

test("finalizeEvent: throws when occurred_at is not a valid date", () => {
  const bad = draft({ occurred_at: "not-a-date" });
  assert.throws(() => finalizeEvent(bad), /occurred_at must be ISO 8601/);
});

test("finalizeEvent: throws when actor.type is missing", () => {
  const bad = draft() as EventDraft;
  // @ts-expect-error deliberately constructing an invalid draft
  bad.actor = {};
  assert.throws(() => finalizeEvent(bad), /actor\.type is required/);
});

test("finalizeEvent: throws when producer.tool is missing", () => {
  const bad = draft() as EventDraft;
  // @ts-expect-error deliberately constructing an invalid draft
  bad.producer = {};
  assert.throws(() => finalizeEvent(bad), /producer\.tool is required/);
});

test("finalizeEvent: throws when content is undefined", () => {
  const bad = draft() as EventDraft;
  bad.content = undefined;
  assert.throws(() => finalizeEvent(bad), /content is required/);
});

test("validateEvent: reports all problems at once for a broken event", () => {
  const broken = {
    id: "not-prefixed",
    schema: "wrong-schema",
    kind: "",
    occurred_at: "nope",
    recorded_at: "also-nope",
    actor: { type: "" },
    producer: { tool: "" },
    content: undefined,
  } as unknown as EvidenceEvent;
  const problems = validateEvent(broken);
  assert.ok(problems.length >= 7, `expected many problems, got: ${problems.join("; ")}`);
});

test("validateEvent: a finalized event has no problems", () => {
  const finalized = finalizeEvent(draft());
  assert.deepStrictEqual(validateEvent(finalized), []);
});
