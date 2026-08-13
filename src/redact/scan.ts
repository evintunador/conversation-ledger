/**
 * Sync-time secret scan (layer E, see docs/WIP_TECHNICAL_DESIGN.md "Privacy
 * and integrity"). Unlike capture-tier redaction (apply.ts), this scanner
 * never rewrites anything — it only reports findings so a human can decide
 * whether to `cledger redact` the event, `cledger allow` the fingerprint as
 * a known false positive, or push anyway with `--no-scan`. Rules may
 * therefore be noisier than the capture tier.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "../canonical.js";
import type { RepoInfo } from "../git.js";
import type { EvidenceEvent } from "../schema.js";
import { isExemptFromRedaction, walkStrings } from "./apply.js";
import type { CledgerConfig } from "./config.js";
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
 * Uppercase markers that identify a matched span as a deliberate fake —
 * test fixtures, documentation examples, placeholder values. Applied to
 * scan-only heuristic rules (keyword-assignment, url-credentials,
 * bearer-token, high-entropy), never to capture-tier rules: those match
 * real token formats, and a real credential is never intentionally minted
 * with FAKE in it, whereas a fixture value trivially can be.
 *
 * Case-sensitive on purpose: "example.com" in a URL or "faker" in a package
 * name must not exempt a match; writing PASSWORD=FAKEhunter2aa is an
 * explicit authoring choice. This is the front half of the fixture
 * convention (see README "Writing secret-shaped fixtures"): fixtures that
 * carry a marker never become findings, so they never need allowlisting —
 * at creation time or ever.
 */
export const FIXTURE_MARKER_RE = /FAKE|EXAMPLE|PLACEHOLDER|DUMMY|NOTREAL|TESTONLY/;

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
          if (rule.tier !== "capture" && FIXTURE_MARKER_RE.test(matchText)) continue;
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

export interface FingerprintGroup {
  fingerprint: string;
  rule: string;
  findings: Finding[];
  /** Distinct event ids carrying this fingerprint, in first-seen order. */
  eventIds: string[];
}

/**
 * One matched span, one decision. The same text recurs across an event's
 * `content` and `raw` mirrors, across a tool call and its result, and across
 * every edit of the same file — this repo's own dogfood backlog was 153
 * finding sites that collapse to 11 distinct fingerprints. A human review is
 * a judgment per *span*, so every report and the review flow work in
 * fingerprint groups; the per-site list stays available underneath for
 * anything that needs coordinates.
 */
export function groupFindings(findings: Finding[]): FingerprintGroup[] {
  const groups = new Map<string, FingerprintGroup>();
  for (const f of findings) {
    let group = groups.get(f.fingerprint);
    if (!group) {
      group = { fingerprint: f.fingerprint, rule: f.rule, findings: [], eventIds: [] };
      groups.set(f.fingerprint, group);
    }
    group.findings.push(f);
    if (!group.eventIds.includes(f.eventId)) group.eventIds.push(f.eventId);
  }
  return [...groups.values()];
}

/**
 * The human-facing report: fingerprint-grouped, coordinates only (the same
 * no-content rule as formatFinding, and for the same reason). One block per
 * distinct span, so the size of the report tracks the number of decisions
 * rather than the number of places the span happens to appear.
 */
export function formatGroupedReport(findings: Finding[]): string {
  const groups = groupFindings(findings);
  const lines: string[] = [];
  for (const g of groups) {
    const first = g.findings[0]!;
    const sites = g.findings.length;
    lines.push(
      `  [${g.fingerprint}]  ${g.rule} — ${sites} site(s) in ${g.eventIds.length} event(s)`,
    );
    lines.push(`      first: ${first.eventId.slice(0, 16)}  ${first.occurred_at}  ${first.path}@${first.start}`);
    const shownIds = g.eventIds.slice(0, 3).map((id) => id.slice(0, 16));
    const more = g.eventIds.length > 3 ? `  (+${g.eventIds.length - 3} more)` : "";
    lines.push(`      events: ${shownIds.join(", ")}${more}`);
  }
  return lines.join("\n");
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
  // Best-effort by construction: it recognizes the env markers the supported
  // harnesses are known to export (Claude Code, Codex, opencode, Gemini CLI,
  // Qwen Code), and a harness that exports none will not be caught. Skew
  // toward matching too much — a false positive costs a refusal message with
  // a --force escape, a false negative reads a secret into the transcript.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE|CODEX_|OPENCODE|GEMINI_CLI|QWEN_CODE|QWEN_CLI)/.test(key)) {
      return key;
    }
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
    "  If you are a HUMAN: review these in a plain terminal, outside any agent:",
    "      cledger review",
    "  It steps through each distinct span with context, the match highlighted,",
    "  and one key to allow or redact. (Or write a report file for one event:",
    `      cledger inspect ${first} )`,
    "",
    "  If you are an AGENT: stop here and hand this to the human. Do not run",
    "  cledger review, inspect, export, or otherwise read the flagged content —",
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

/**
 * The user-wide tier, next to the global config. A false positive is usually
 * a property of the *text* (a fixture, a doc example), not of the repo it was
 * captured in — the same span flagged here today gets flagged in the next
 * repo that reads the same file or quotes the same doc. Observed while
 * dogfooding: 2 of turnbridge's 4 outstanding fingerprints were already
 * human-approved in conversation-ledger's per-repo allowlist, waiting to be
 * re-reviewed from scratch.
 */
function globalAllowlistPath(): string {
  return join(homedir(), ".config", "cledger", "allowlist.json");
}

async function readAllowlistFile(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as AllowlistFile;
    return Array.isArray(parsed.fingerprints) ? parsed.fingerprints : [];
  } catch {
    // Missing or malformed allowlist: treat as empty rather than failing the scan/sync.
    return [];
  }
}

/**
 * Union of every allowlist tier: the repo-local file under `.git/`, the
 * user-global file under `~/.config/cledger/`, and — when the caller passes
 * config — `scan.allowFingerprints` from `.cledger.json`/global config, the
 * only tier that travels with a clone. All rebuildable-if-lost state, never
 * the record of truth; a fingerprint in any tier suppresses the finding.
 */
export async function loadAllowlist(repo: RepoInfo, config?: CledgerConfig): Promise<Set<string>> {
  const [local, global] = await Promise.all([
    readAllowlistFile(allowlistPath(repo)),
    readAllowlistFile(globalAllowlistPath()),
  ]);
  return new Set([...local, ...global, ...(config?.scan?.allowFingerprints ?? [])]);
}

export async function addToAllowlist(
  repo: RepoInfo,
  fingerprints: string[],
  scope: "local" | "global" = "local",
): Promise<void> {
  const path = scope === "global" ? globalAllowlistPath() : allowlistPath(repo);
  const existing = new Set(await readAllowlistFile(path));
  for (const fp of fingerprints) existing.add(fp);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ fingerprints: [...existing].sort() }, null, 2) + "\n");
}
