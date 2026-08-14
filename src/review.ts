/**
 * `cledger review` — the interactive counterpart to the contentless scan
 * report. One screen per distinct matched span (fingerprint), the match
 * highlighted inside real surrounding context, one keystroke to allow it
 * (this repo or globally), redact it everywhere it appears, or skip.
 *
 * This exists because the file-based flow (`cledger inspect` → read the
 * .txt → hand-type `cledger allow`/`cledger redact --pattern <regex>`) made
 * every finding a multi-step chore, and the redact path made the human
 * retype the secret they had just been warned about. Here the span is
 * already known, so redaction escapes it into a literal pattern itself.
 *
 * Same trust boundary as `cledger inspect`, same guards, same reasoning:
 * flagged content addresses humans only. The command refuses inside a
 * coding-agent session (the caller checks inAgentSession before invoking)
 * and additionally requires a real TTY on both ends — piped output is how
 * content ends up in a transcript.
 */
import type { RepoInfo } from "./git.js";
import type { EvidenceEvent } from "./schema.js";
import { loadConfig } from "./redact/config.js";
import {
  addToAllowlist,
  collectStrings,
  filterFindings,
  groupFindings,
  loadAllowlist,
  scanEvents,
  type Finding,
  type FingerprintGroup,
} from "./redact/scan.js";
import { RedactAfterShareError, readEvents, redactEvent } from "./store.js";

export interface ReviewOptions {
  tier: "standard" | "paranoid";
  /** Characters of surrounding context on each side of the match. */
  context: number;
}

export interface ReviewSummary {
  allowed: number;
  allowedGlobally: number;
  redacted: number;
  skipped: number;
  errors: string[];
}

/** Escape a matched span into a regex that matches exactly that text. */
export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A styled run of text; styles are ANSI prefixes, reset is appended per line. */
export interface Run {
  text: string;
  style: string;
}

/**
 * Hard-wrap styled runs to `width` printable columns, restarting each run's
 * style after every break so highlighting survives wrapping. ANSI sequences
 * carry zero width, which is why this cannot be a plain string wrap.
 */
export function wrapRuns(runs: Run[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let col = 0;
  let openStyle = "";
  const closeStyle = () => {
    if (openStyle) {
      line += RESET;
      openStyle = "";
    }
  };
  const breakLine = () => {
    const style = openStyle;
    closeStyle();
    lines.push(line);
    line = "";
    col = 0;
    if (style) {
      line = style;
      openStyle = style;
    }
  };
  for (const run of runs) {
    if (run.style !== openStyle) {
      closeStyle();
      if (run.style) {
        line += run.style;
        openStyle = run.style;
      }
    }
    for (const ch of run.text) {
      if (ch === "\n") {
        breakLine();
        continue;
      }
      if (ch === "\r") continue;
      if (col >= width) breakLine();
      line += ch;
      col += 1;
    }
  }
  closeStyle();
  if (col > 0 || lines.length === 0) lines.push(line);
  return lines;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const HIGHLIGHT = "\x1b[41;97;1m"; // white on red: the one thing on screen to judge

export interface Screen {
  write(s: string): void;
  columns: number;
  rows: number;
}

/** Everything the render needs, so it can be re-run on resize/scroll. */
export interface ViewState {
  group: FingerprintGroup;
  groupIndex: number;
  groupCount: number;
  siteIndex: number;
  event: EvidenceEvent | undefined;
  scroll: number;
  message: string;
  opts: ReviewOptions;
}

/** A dim horizontal rule with an inline label, e.g. `─── captured content ───…`. */
function ruleLine(width: number, label: string, extra = ""): string {
  const text = `─── ${label}${extra ? ` · ${extra}` : ""} `;
  return DIM + (text + "─".repeat(Math.max(0, width - text.length))).slice(0, width) + RESET;
}

/** Bold every `[key]` cap so the actions read as a menu, not a sentence. */
function emphasizeKeys(s: string): string {
  return s.replace(/\[[^\]]+\]/g, (m) => `${BOLD}${m}${RESET}`);
}

/**
 * Screen layout, top to bottom: a three-line header describing what is being
 * shown, a ruled-off gutter pane holding the captured content (the only
 * conversation text on screen), and a key menu of the possible verdicts, one
 * action per line. The rules and the gutter exist so chrome and content
 * cannot be confused — everything inside `│` is the record, everything
 * outside it is the tool.
 */
export function renderView(screen: Screen, view: ViewState): void {
  const { group, event, opts } = view;
  const f = group.findings[view.siteIndex]!;
  const width = Math.max(40, screen.columns);

  const head = [
    `${BOLD}span ${view.groupIndex + 1} of ${view.groupCount}${RESET}  [${group.fingerprint}]  ${group.rule}`,
    `${DIM}site ${view.siteIndex + 1} of ${group.findings.length} · event ${f.eventId.slice(0, 16)} · ${f.path} @${f.start}${RESET}`,
    `${DIM}${f.occurred_at} · ${f.conversation ?? "(no conversation)"}${RESET}`,
  ];

  const menuPairs: [string, string][] =
    width >= 64
      ? [
          ["[a] allow in this repo", "[n]/[p] next / prev site"],
          ["[g] allow on this machine", "[j]/[k] scroll"],
          ["[r] redact everywhere", "[q] quit"],
          ["[s] skip for now", ""],
        ]
      : [
          ["[a] allow in this repo", ""],
          ["[g] allow on this machine", ""],
          ["[r] redact everywhere", ""],
          ["[s] skip for now", ""],
          ["[n]/[p] site · [j]/[k] scroll · [q] quit", ""],
        ];
  const menu = menuPairs.map(
    ([left, right]) => "  " + emphasizeKeys(left.padEnd(28)) + (right ? emphasizeKeys(right) : ""),
  );

  // header + two rules + message line + menu; one spare row so the last
  // write never scrolls the terminal.
  const chromeRows = head.length + 2 + 1 + menu.length + 1;
  const bodyRows = Math.max(4, screen.rows - chromeRows);
  const paneWidth = width - 2; // "│ " gutter

  let bodyLines: string[];
  const value = event ? collectStrings(event).get(f.path) : undefined;
  if (value === undefined || value.slice(f.start, f.end).length === 0) {
    bodyLines = [`${DIM}(string no longer present — event rewritten since the scan)${RESET}`];
  } else {
    const lo = Math.max(0, f.start - opts.context);
    const hi = Math.min(value.length, f.end + opts.context);
    const runs: Run[] = [];
    if (lo > 0) runs.push({ text: `…[${lo} chars before]… `, style: DIM });
    runs.push({ text: value.slice(lo, f.start), style: "" });
    runs.push({ text: value.slice(f.start, f.end), style: HIGHLIGHT });
    runs.push({ text: value.slice(f.end, hi), style: "" });
    if (hi < value.length) runs.push({ text: ` …[${value.length - hi} chars after]…`, style: DIM });
    bodyLines = wrapRuns(runs, paneWidth);
  }
  const maxScroll = Math.max(0, bodyLines.length - bodyRows);
  view.scroll = Math.min(view.scroll, maxScroll);
  const visible = bodyLines.slice(view.scroll, view.scroll + bodyRows);
  while (visible.length < bodyRows) visible.push("");

  const scrollExtra =
    bodyLines.length > bodyRows
      ? `lines ${view.scroll + 1}-${Math.min(view.scroll + bodyRows, bodyLines.length)} of ${bodyLines.length}, [j]/[k] to scroll`
      : "";
  const gutter = `${DIM}│${RESET} `;

  screen.write("\x1b[2J\x1b[H"); // clear + home
  screen.write(head.join("\n") + "\n");
  screen.write(ruleLine(width, "captured content", scrollExtra) + "\n");
  screen.write(visible.map((l) => gutter + l).join("\n") + "\n");
  screen.write(ruleLine(width, "verdict for this span") + "\n");
  screen.write((view.message ? ` ${BOLD}${view.message}${RESET}` : "") + "\n");
  screen.write(menu.join("\n"));
}

async function readKeys(onKey: (key: string) => Promise<boolean>): Promise<void> {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let busy = false;
    const listener = (buf: Buffer) => {
      if (busy) return; // drop keys typed while an action is running
      const key = buf.toString("utf8");
      busy = true;
      onKey(key)
        .then((done) => {
          busy = false;
          if (done) {
            process.stdin.off("data", listener);
            resolve();
          }
        })
        .catch((err: unknown) => {
          process.stdin.off("data", listener);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    };
    process.stdin.on("data", listener);
  });
}

async function loadGroups(
  repo: RepoInfo,
  opts: ReviewOptions,
  decided: Set<string>,
): Promise<{ groups: FingerprintGroup[]; byId: Map<string, EvidenceEvent> }> {
  const config = await loadConfig(repo.root);
  const events = await readEvents(repo, {});
  const findings = filterFindings(scanEvents(events, opts.tier), await loadAllowlist(repo, config));
  const groups = groupFindings(findings).filter((g) => !decided.has(g.fingerprint));
  return { groups, byId: new Map(events.map((e) => [e.id, e])) };
}

/**
 * The interactive loop. Assumes the caller has already verified this is not
 * an agent session and both stdin and stdout are TTYs.
 */
export async function runReview(repo: RepoInfo, opts: ReviewOptions): Promise<ReviewSummary> {
  const summary: ReviewSummary = {
    allowed: 0,
    allowedGlobally: 0,
    redacted: 0,
    skipped: 0,
    errors: [],
  };
  const decided = new Set<string>();
  let { groups, byId } = await loadGroups(repo, opts, decided);
  if (groups.length === 0) return summary;

  const screen: Screen = {
    write: (s) => process.stdout.write(s),
    get columns() {
      return process.stdout.columns ?? 80;
    },
    get rows() {
      return process.stdout.rows ?? 24;
    },
  };

  let index = 0;
  let site = 0;
  let scroll = 0;
  let message = "";
  let confirmRedact = false;

  const view = (): ViewState => {
    const group = groups[index]!;
    const f = group.findings[site] ?? group.findings[0]!;
    return {
      group,
      groupIndex: index,
      groupCount: groups.length,
      siteIndex: group.findings.indexOf(f),
      event: byId.get(f.eventId),
      scroll,
      message,
      opts,
    };
  };
  const render = () => {
    const v = view();
    renderView(screen, v);
    scroll = v.scroll;
  };

  const advance = async (): Promise<boolean> => {
    decided.add(groups[index]!.fingerprint);
    groups.splice(index, 1);
    if (groups.length === 0) return true;
    if (index >= groups.length) index = groups.length - 1;
    site = 0;
    scroll = 0;
    return false;
  };

  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide cursor
  const restore = () => process.stdout.write("\x1b[?25h\x1b[?1049l");
  const onResize = () => render();
  process.stdout.on("resize", onResize);

  try {
    render();
    await readKeys(async (key) => {
      message = "";
      if (confirmRedact) {
        confirmRedact = false;
        if (key === "y" || key === "Y") {
          const group = groups[index]!;
          const f = group.findings[site]!;
          const event = byId.get(f.eventId);
          const value = event ? collectStrings(event).get(f.path) : undefined;
          const span = value?.slice(f.start, f.end);
          if (!span) {
            message = "cannot recover the span text (event rewritten?) — use cledger redact by hand";
          } else {
            const pattern = escapeLiteral(span);
            let ok = 0;
            for (const eventId of group.eventIds) {
              try {
                await redactEvent(repo, eventId, { pattern, reason: "cledger review" });
                ok += 1;
              } catch (err) {
                const why =
                  err instanceof RedactAfterShareError
                    ? `${eventId.slice(0, 16)}: already shared (rotate the credential)`
                    : `${eventId.slice(0, 16)}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
                summary.errors.push(`redact ${why}`);
              }
            }
            summary.redacted += ok;
            const done = await advance();
            if (done) return true;
            // Redaction rewrote events on disk: every other finding's offsets
            // may have shifted inside shared strings. Re-scan rather than
            // trusting stale coordinates.
            ({ groups, byId } = await loadGroups(repo, opts, decided));
            if (groups.length === 0) return true;
            if (index >= groups.length) index = groups.length - 1;
          }
        } else {
          message = "redact cancelled";
        }
        render();
        return false;
      }

      const group = groups[index]!;
      switch (key) {
        case "a": {
          await addToAllowlist(repo, [group.fingerprint], "local");
          summary.allowed += 1;
          if (await advance()) return true;
          break;
        }
        case "g": {
          await addToAllowlist(repo, [group.fingerprint], "global");
          summary.allowedGlobally += 1;
          if (await advance()) return true;
          break;
        }
        case "r": {
          confirmRedact = true;
          message = `redact this span in ${group.eventIds.length} event(s)? y/N`;
          break;
        }
        case "s": {
          summary.skipped += 1;
          if (await advance()) return true;
          break;
        }
        case "n":
        case "\x1b[C": // right arrow
          site = (site + 1) % group.findings.length;
          scroll = 0;
          break;
        case "p":
        case "\x1b[D": // left arrow
          site = (site - 1 + group.findings.length) % group.findings.length;
          scroll = 0;
          break;
        case "j":
        case "\x1b[B":
          scroll += 1;
          break;
        case "k":
        case "\x1b[A":
          scroll = Math.max(0, scroll - 1);
          break;
        case "q":
        case "\x03": // Ctrl+C in raw mode
          summary.skipped += groups.length;
          return true;
        default:
          break;
      }
      render();
      return false;
    });
  } finally {
    process.stdout.off("resize", onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    restore();
  }
  return summary;
}
