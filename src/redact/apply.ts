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

/**
 * A set of exact secret values to scrub, tagged with the rule id they are
 * recorded under (e.g. "env-value" for opt-in env masking, "known-secret"
 * for values a prior `cledger redact` remembered). Kept distinct so the
 * redaction records — and therefore the audit trail — say which mechanism
 * scrubbed each span.
 */
export interface ExtraValueGroup {
  ruleId: string;
  values: string[];
}

/** Scrub exact secret values, longest-first so overlapping values don't leave partial matches. */
function redactExtraValues(
  text: string,
  values: string[],
  ruleId: string,
  path: string,
  records: RedactionRecord[],
): string {
  let result = text;
  for (const value of values) {
    if (!value || !result.includes(value)) continue;
    const fingerprint = sha256Hex(value).slice(0, 12);
    const re = new RegExp(escapeRegExp(value), "g");
    result = result.replace(re, () => {
      records.push({ rule: ruleId, ruleset: RULESET_VERSION, fingerprint, path });
      return placeholder(ruleId, fingerprint);
    });
  }
  return result;
}

/**
 * Collect every match of `pattern` across the string leaves of `value`
 * (read-only; keys are never inspected). Used by the redact command to learn
 * the exact plaintext it scrubbed so it can remember it in the known-secrets
 * store. `pattern` must carry the global flag.
 */
export function collectMatches(value: unknown, pattern: RegExp): string[] {
  const found: string[] = [];
  walkStrings(value, "", (s) => {
    for (const m of s.matchAll(pattern)) found.push(m[0]);
    return s;
  });
  return found;
}

/**
 * True for the one string leaf that must never be pattern-matched or
 * rewritten: a `reasoning` event's `encrypted_content` ciphertext. It is
 * high-entropy by construction (indistinguishable from what secret-scan
 * rules look for) and, unlike every other stored value, this feature's
 * entire point is preserving it byte-exact for provider replay — a
 * coincidental rule match silently splicing in a `[REDACTED:...]`
 * placeholder would permanently corrupt it with no way to detect that it
 * happened. Everything else in a `reasoning` event's `raw.data` (e.g. a
 * `summary` field, if the provider populates one) is real content and stays
 * fully subject to normal scanning — this is a single-field exemption, not
 * a kind-wide one. Matched by trailing path segment rather than the exact
 * `raw/data/payload/encrypted_content` path so it holds regardless of
 * nesting depth across adapters, since `reasoning` is a provider-agnostic
 * kind.
 */
export function isExemptFromRedaction(kind: string | undefined, path: string): boolean {
  return kind === "reasoning" && path.endsWith("/encrypted_content");
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
  opts: { rules: RedactionRule[]; extraValues?: ExtraValueGroup[] },
): { draft: EventDraft; records: RedactionRecord[] } {
  const records: RedactionRecord[] = [];
  // Sort each group's values longest-first so a longer secret is scrubbed
  // before a shorter one it contains, never leaving a partial match behind.
  const groups = (opts.extraValues ?? [])
    .map((g) => ({ ruleId: g.ruleId, values: [...g.values].sort((a, b) => b.length - a.length) }))
    .filter((g) => g.values.length > 0);

  function redactString(value: string, path: string): string {
    if (isExemptFromRedaction(draft.kind, path)) return value;
    let scrubbed = value;
    for (const g of groups) scrubbed = redactExtraValues(scrubbed, g.values, g.ruleId, path, records);
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
