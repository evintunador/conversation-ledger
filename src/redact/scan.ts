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
import { isExemptFromRedaction, walkStrings } from "./apply.js";
import { rulesForTier, shannonEntropy } from "./rules.js";

export interface Finding {
  eventId: string;
  conversation?: string;
  occurred_at: string;
  rule: string;
  fingerprint: string;
  /** JSON path of the string the match sits in, e.g. `content/blocks/0/text`. */
  path: string;
  /** Match span within that string, so `cledger inspect` can find it again. */
  start: number;
  end: number;
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

/** Stands in for the matched secret wherever a match is rendered. */
const MATCH_MARKER = "<redacted>";

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
    const visit = (value: string, path: string): string => {
      if (isExemptFromRedaction(event.kind, path)) return value;
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
            path,
            start,
            end,
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

/**
 * One line per finding: coordinates only, never a character of the flagged
 * text or its surroundings.
 *
 * This used to print ~20 characters of context with the match masked, on the
 * theory that masking the match was enough to make the report safe to
 * re-capture. It was not. The *context* around a match is itself what tripped
 * the rule — a `keyword-assignment` hit prints the keyword that anchored it —
 * so a report landing in a later conversation re-seeds a finding on the report
 * itself, and every scan compounds the previous one. Observed in the wild:
 * one discussion of GitHub Actions code multiplied into repeat findings that
 * `cledger allow` could not durably clear, because each new report minted a
 * new event. Coordinates cannot do that: an event id and a JSON path match no
 * secret rule. Content lives behind `cledger inspect`, which writes to a file.
 */
export function formatFinding(f: Finding): string {
  const where = `${f.path}@${f.start}`;
  return `${f.eventId.slice(0, 16)}  ${f.conversation ?? "-"}  ${f.occurred_at}  ${f.rule}  ${where}  [${f.fingerprint}]`;
}

/** Every string in an event, keyed by the same JSON paths scanEvents uses. */
export function collectStrings(event: EvidenceEvent): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (value: string, path: string): string => {
    out.set(path, value);
    return value;
  };
  walkStrings(event.content, "content", visit);
  if (event.raw) walkStrings(event.raw.data, "raw/data", visit);
  return out;
}

export interface RenderOptions {
  /** Characters of surrounding text on each side. */
  context: number;
  /** Include the matched text verbatim instead of masking it. */
  reveal: boolean;
}

/**
 * A finding with enough surrounding text for a human to actually judge it.
 *
 * The whole point of the separate command: `formatFinding` is deliberately
 * unreadable, so this is where readability lives. Callers are expected to send
 * this to a file rather than a terminal — see `cledger inspect`.
 */
export function renderFinding(event: EvidenceEvent, f: Finding, opts: RenderOptions): string {
  const value = collectStrings(event).get(f.path);
  if (value === undefined) {
    return `${f.path}: string no longer present in event ${f.eventId.slice(0, 16)} (event rewritten since the scan?)\n`;
  }
  const lo = Math.max(0, f.start - opts.context);
  const hi = Math.min(value.length, f.end + opts.context);
  const match = opts.reveal ? value.slice(f.start, f.end) : MATCH_MARKER;
  const body = `${value.slice(lo, f.start)}${match}${value.slice(f.end, hi)}`;
  return [
    `rule:        ${f.rule}`,
    `fingerprint: ${f.fingerprint}`,
    `event:       ${f.eventId}`,
    `conversation:${f.conversation ?? " -"}`,
    `occurred_at: ${f.occurred_at}`,
    `location:    ${f.path}, chars ${f.start}-${f.end} of ${value.length}`,
    `match:       ${f.end - f.start} chars, ${opts.reveal ? "SHOWN BELOW" : "masked (pass --reveal to show)"}`,
    "",
    `${lo > 0 ? `…[${lo} chars before]…\n` : ""}${body}${hi < value.length ? `\n…[${value.length - hi} chars after]…` : ""}`,
    "",
  ].join("\n");
}

/**
 * Whether we appear to be running inside a coding-agent session, i.e. whether
 * anything printed here will be swept into a transcript and captured as a new
 * event. Both supported harnesses export their own marker variables.
 *
 * Used to *refuse* to reveal flagged content rather than merely to warn: an
 * agent asked to investigate a blocked sync will otherwise do the helpful,
 * wrong thing and read the secret into the very record being protected.
 */
export function inAgentSession(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE|CODEX_)/.test(key)) return key;
  }
  return null;
}

/**
 * Shared guidance for every place a finding is reported. Addresses humans and
 * agents separately and explicitly, because the correct action differs: a
 * human should go look, an agent should stop and say so.
 */
export function findingGuidance(eventIds: string[]): string {
  // Prefix, not the full 68-char id: `inspect` takes a prefix, and the short
  // form is what the finding lines above already show.
  const first = (eventIds[0] ?? "<event-id>").slice(0, 16);
  return [
    "  No excerpt is printed. The text around a match is what tripped the rule,",
    "  so reprinting it into a session that gets captured creates a new event",
    "  that trips the same rule — findings then multiply on every scan.",
    "",
    "  If you are a HUMAN: inspect it in a plain terminal, outside any agent:",
    `      cledger inspect ${first}`,
    "  That writes the full surrounding context to a file outside the repo and",
    "  prints only the path. Add --reveal to include the matched text itself.",
    "",
    "  If you are an AGENT: stop here and hand this to the human. Do not run",
    "  cledger inspect, cledger export, or otherwise read the flagged content —",
    "  it would be captured into this conversation and re-seed the finding.",
  ].join("\n");
}

/** Findings whose fingerprint has been allowlisted (known false positive) are suppressed. */
export function filterFindings(findings: Finding[], allowlist: Set<string>): Finding[] {
  return findings.filter((f) => !allowlist.has(f.fingerprint));
}

interface AllowlistFile {
  fingerprints: string[];
}

function allowlistPath(repo: RepoInfo): string {
  return join(repo.commonDir, "conversation-ledger", "allowlist.json");
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
  await mkdir(join(repo.commonDir, "conversation-ledger"), { recursive: true });
  await writeFile(
    allowlistPath(repo),
    JSON.stringify({ fingerprints: [...existing].sort() }, null, 2) + "\n",
  );
}
