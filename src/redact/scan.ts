/**
 * Sync-time secret scan (layer E, see docs/WIP_TECHNICAL_DESIGN.md "Privacy
 * and integrity"). Unlike capture-tier redaction (apply.ts), this scanner
 * never rewrites anything — it only reports findings so a human can decide
 * whether to `cledger redact` the event, `cledger allow` the fingerprint as
 * a known false positive, or push anyway with `--no-scan`. Rules may
 * therefore be noisier than the capture tier.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../canonical.js";
import type { RepoInfo } from "../git.js";
import type { EvidenceEvent } from "../schema.js";
import { walkStrings } from "./apply.js";
import { rulesForTier, shannonEntropy } from "./rules.js";

export interface Finding {
  eventId: string;
  conversation?: string;
  occurred_at: string;
  rule: string;
  fingerprint: string;
  excerpt: string;
}

const PLACEHOLDER_RE = /\[REDACTED:[^\]]+\]/g;

/** True if [start, end) overlaps an existing `[REDACTED:...]` placeholder span in `text`. */
function overlapsPlaceholder(text: string, start: number, end: number): boolean {
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const pStart = m.index ?? 0;
    const pEnd = pStart + m[0].length;
    if (start < pEnd && end > pStart) return true;
  }
  return false;
}

/**
 * Marker that stands in for the matched secret in a finding excerpt. Prints
 * zero characters of the secret itself — not even leading/trailing ones —
 * so the excerpt can be safely re-captured (e.g. when the scan report itself
 * lands in a later conversation) without re-seeding the very finding it
 * describes. See the redaction-feedback-loop discussion in the README roadmap.
 */
const MATCH_MARKER = "<redacted>";

/**
 * ~20 chars of surrounding context on each side, with the matched span
 * replaced by MATCH_MARKER. The context gives a human enough of a "what was
 * this" cue to act; the secret's own characters are never printed.
 */
function buildExcerpt(text: string, start: number, end: number): string {
  const pre = text.slice(Math.max(0, start - 20), start);
  const post = text.slice(end, end + 20);
  return `${pre}${MATCH_MARKER}${post}`.replace(/\s+/g, " ").trim();
}

const PURE_HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Scan already-finalized events for potential secrets. Read-only: never
 * mutates content, only reports. `tier` selects the ruleset — "standard"
 * re-runs the full capture ruleset plus scan-only keyword/URL/bearer rules
 * (catching events captured under an older capture ruleset); "paranoid"
 * additionally enables the entropy-gated high-entropy-token rule.
 */
export function scanEvents(events: EvidenceEvent[], tier: "standard" | "paranoid"): Finding[] {
  const rules = rulesForTier(tier);
  const findings: Finding[] = [];

  for (const event of events) {
    const visit = (value: string, _path: string): string => {
      for (const rule of rules) {
        for (const m of value.matchAll(rule.pattern)) {
          const matchText = m[0];
          const start = m.index ?? 0;
          const end = start + matchText.length;
          if (overlapsPlaceholder(value, start, end)) continue;
          if (rule.entropyGated) {
            // Belt-and-suspenders: rulesForTier already excludes this rule
            // below "paranoid", but the gate is cheap to state explicitly.
            if (tier !== "paranoid") continue;
            if (PURE_HEX_RE.test(matchText)) continue; // git SHAs, content digests
            if (matchText.includes("[REDACTED:")) continue;
            if (shannonEntropy(matchText) < 4.0) continue;
          }
          findings.push({
            eventId: event.id,
            ...(event.conversation ? { conversation: event.conversation.id } : {}),
            occurred_at: event.occurred_at,
            rule: rule.id,
            fingerprint: sha256Hex(matchText).slice(0, 12),
            excerpt: buildExcerpt(value, start, end),
          });
        }
      }
      return value;
    };
    walkStrings(event.content, "content", visit);
    if (event.raw) walkStrings(event.raw.data, "raw/data", visit);
  }

  return findings;
}

/** One human-readable line per finding — never includes the secret itself. */
export function formatFinding(f: Finding): string {
  return `${f.eventId.slice(0, 16)}  ${f.conversation ?? "-"}  ${f.occurred_at}  ${f.rule}  ${f.excerpt}  [${f.fingerprint}]`;
}

/** Findings whose fingerprint has been allowlisted (known false positive) are suppressed. */
export function filterFindings(findings: Finding[], allowlist: Set<string>): Finding[] {
  return findings.filter((f) => !allowlist.has(f.fingerprint));
}

interface AllowlistFile {
  fingerprints: string[];
}

function allowlistPath(repo: RepoInfo): string {
  return join(repo.gitDir, "conversation-ledger", "allowlist.json");
}

/** Local, rebuildable-if-lost state — same tier as pending.jsonl/cursors, never the record of truth. */
export async function loadAllowlist(repo: RepoInfo): Promise<Set<string>> {
  try {
    const raw = await readFile(allowlistPath(repo), "utf8");
    const parsed = JSON.parse(raw) as AllowlistFile;
    return new Set(Array.isArray(parsed.fingerprints) ? parsed.fingerprints : []);
  } catch {
    // Missing or malformed allowlist: treat as empty rather than failing the scan/sync.
    return new Set();
  }
}

export async function addToAllowlist(repo: RepoInfo, fingerprints: string[]): Promise<void> {
  const existing = await loadAllowlist(repo);
  for (const fp of fingerprints) existing.add(fp);
  await mkdir(join(repo.gitDir, "conversation-ledger"), { recursive: true });
  await writeFile(
    allowlistPath(repo),
    JSON.stringify({ fingerprints: [...existing].sort() }, null, 2) + "\n",
  );
}
