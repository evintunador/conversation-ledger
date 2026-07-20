import { sha256Hex } from "../canonical.js";
import type { EventDraft } from "../schema.js";
import { RULESET_VERSION, type RedactionRule } from "./rules.js";

export interface RedactionRecord {
  rule: string;
  ruleset: string;
  fingerprint: string;
  path: string;
}

/** Deterministic placeholder: recoverable only via fingerprint correlation. */
function placeholder(ruleId: string, fingerprint: string): string {
  return `[REDACTED:${ruleId}:${fingerprint}]`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply capture-tier rules to a single string. Entropy-gated (paranoid)
 * rules are scan-only and are skipped here — capture-time redaction must be
 * near-zero-false-positive, and entropy heuristics are not.
 */
export function redactText(
  text: string,
  rules: RedactionRule[],
): { text: string; matches: { rule: string; fingerprint: string }[] } {
  const matches: { rule: string; fingerprint: string }[] = [];
  let result = text;
  for (const rule of rules) {
    if (rule.entropyGated) continue;
    result = result.replace(rule.pattern, (matched) => {
      const fingerprint = sha256Hex(matched).slice(0, 12);
      matches.push({ rule: rule.id, fingerprint });
      return placeholder(rule.id, fingerprint);
    });
  }
  return { text: result, matches };
}

/** Scrub exact secret values (e.g. env vars), longest-first so overlapping values don't leave partial matches. */
function redactExtraValues(
  text: string,
  values: string[],
  path: string,
  records: RedactionRecord[],
): string {
  let result = text;
  for (const value of values) {
    if (!value || !result.includes(value)) continue;
    const fingerprint = sha256Hex(value).slice(0, 12);
    const re = new RegExp(escapeRegExp(value), "g");
    result = result.replace(re, () => {
      records.push({ rule: "env-value", ruleset: RULESET_VERSION, fingerprint, path });
      return placeholder("env-value", fingerprint);
    });
  }
  return result;
}

/**
 * Deep-walk `value`, invoking `visit(str, path)` for every string leaf
 * (object keys are never touched) and replacing that leaf with whatever
 * `visit` returns. Shared by redactDraft below (which rewrites matched
 * spans in content/raw.data) and the sync-time scanner in scan.ts (which
 * visits read-only, always returning the string unchanged) so both walk
 * event content identically instead of maintaining two deep-walk
 * implementations that could drift apart.
 */
export function walkStrings(
  value: unknown,
  path: string,
  visit: (value: string, path: string) => string,
): unknown {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) return value.map((v, i) => walkStrings(v, `${path}/${i}`, visit));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walkStrings(v, `${path}/${key}`, visit);
    }
    return out;
  }
  return value;
}

/**
 * Deep-walk draft.content and draft.raw.data, redacting string values only
 * (never object keys). Returns a new draft — the input is never mutated —
 * plus the list of redaction records with JSON-pointer-ish paths such as
 * "content/blocks/2/text" or "raw/data/message/content/0/text".
 */
export function redactDraft(
  draft: EventDraft,
  opts: { rules: RedactionRule[]; extraValues?: string[] },
): { draft: EventDraft; records: RedactionRecord[] } {
  const records: RedactionRecord[] = [];
  const extraValues =
    opts.extraValues && opts.extraValues.length > 0
      ? [...opts.extraValues].sort((a, b) => b.length - a.length)
      : undefined;

  function redactString(value: string, path: string): string {
    const scrubbed = extraValues ? redactExtraValues(value, extraValues, path, records) : value;
    const { text, matches } = redactText(scrubbed, opts.rules);
    for (const m of matches) {
      records.push({ rule: m.rule, ruleset: RULESET_VERSION, fingerprint: m.fingerprint, path });
    }
    return text;
  }

  const newDraft: EventDraft = { ...draft, content: walkStrings(draft.content, "content", redactString) };
  if (draft.raw) {
    newDraft.raw = { ...draft.raw, data: walkStrings(draft.raw.data, "raw/data", redactString) };
  }
  return { draft: newDraft, records };
}
