import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLiteral, wrapRuns, type Run } from "../review.js";

const RESET = "\x1b[0m";

test("escapeLiteral: the escaped span matches exactly itself and nothing regex-y", () => {
  const nasty = "p@$$w0rd.*+?^${}()|[]\\end";
  const re = new RegExp(escapeLiteral(nasty));
  assert.ok(re.test(nasty), "must match the literal text");
  assert.ok(!re.test("p@$$w0rdXend"), "wildcards must not survive escaping");
  // Round-trip: a match of the escaped pattern is the original text.
  const m = nasty.match(new RegExp(escapeLiteral(nasty)));
  assert.strictEqual(m?.[0], nasty);
});

test("wrapRuns: wraps at printable width, ANSI sequences cost zero columns", () => {
  const style = "\x1b[41;97;1m";
  const runs: Run[] = [
    { text: "aaaa", style: "" },
    { text: "bbbb", style },
    { text: "cccc", style: "" },
  ];
  const lines = wrapRuns(runs, 6);
  // 12 printable chars at width 6 = exactly 2 lines.
  assert.strictEqual(lines.length, 2);
  const printable = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.deepStrictEqual(printable, ["aaaabb", "bbcccc"]);
  // The styled run re-opens its style after the break and closes before
  // unstyled text resumes, so highlighting survives wrapping.
  assert.ok(lines[0]!.includes(style + "bb"));
  assert.ok(lines[1]!.startsWith(style + "bb"));
  assert.ok(lines[1]!.includes(RESET + "cccc"));
});

test("wrapRuns: embedded newlines break lines, carriage returns vanish", () => {
  const lines = wrapRuns([{ text: "ab\r\ncd\nef", style: "" }], 80);
  assert.deepStrictEqual(lines, ["ab", "cd", "ef"]);
});

test("wrapRuns: empty input still yields one renderable line", () => {
  assert.deepStrictEqual(wrapRuns([], 80), [""]);
  assert.deepStrictEqual(wrapRuns([{ text: "", style: "" }], 80), [""]);
});
