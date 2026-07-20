/**
 * Format-drift handling shared by adapters. Adapters are tolerant parsers:
 * a line type in neither the convertible set nor the deliberately-skipped set
 * is *unrecognized* — most likely new upstream content this cledger version
 * has no mapping for. Two things happen for such a line:
 *
 *  1. It is counted per type and surfaced in a capture-time warning (the
 *     drift tripwire — "the format changed, update cledger").
 *  2. It is preserved raw-only as an `unrecognized` event (see
 *     `unrecognizedDraft`) instead of being dropped, so a later adapter
 *     version can re-normalize the line rather than lose it forever.
 *
 * Preservation events ride the normal append path, so the capture-time
 * redaction stack walks their `raw.data` exactly as it does interpreted
 * events — an unrecognized line is not a hole in secret redaction.
 */

import type { EventDraft } from "../schema.js";

export interface CaptureResult {
  appended: number;
  deduped: number;
  /** Skipped-line tallies keyed by unrecognized type, e.g. {"response_item/agent_message": 3}. */
  unrecognized: Record<string, number>;
}

export function countUnrecognized(unrecognized: Record<string, number>, key: string): void {
  unrecognized[key] = (unrecognized[key] ?? 0) + 1;
}

/**
 * Build the raw-only preservation event for one unrecognized transcript line.
 *
 * `content` holds only the type label — the ledger did not interpret the
 * line, so it claims no roles, no actor identity (actor is `system`), no
 * structured blocks. The full source line lives under `raw.data`, versioned
 * by `rawFormat` so a future adapter knows which native shape to re-parse.
 *
 * Identity: `raw` is excluded from the event id, but that is fine here —
 * `conversation.seq` (the source line index, part of the identity subset)
 * already makes distinct lines distinct and re-scans of the same line
 * idempotent, the same guarantee interpreted turns rely on. Keeping the
 * format marker in `raw` therefore means format-version bumps never churn
 * ids, matching every other event kind.
 */
export function unrecognizedDraft(params: {
  typeKey: string;
  line: unknown;
  occurredAt: string;
  source: string;
  sessionId: string;
  seq: number;
  version: string;
  rawFormat: string;
  conversationId: string;
}): EventDraft {
  return {
    kind: "unrecognized",
    occurred_at: params.occurredAt,
    actor: { type: "system" },
    producer: {
      tool: "cledger",
      version: params.version,
      source: params.source,
      session_id: params.sessionId,
    },
    conversation: { id: params.conversationId, seq: params.seq },
    content: { unrecognized_type: params.typeKey },
    raw: { format: params.rawFormat, data: params.line },
  };
}

export function warnUnrecognized(source: string, unrecognized: Record<string, number>): void {
  const entries = Object.entries(unrecognized);
  if (entries.length === 0) return;
  const total = entries.reduce((n, [, c]) => n + c, 0);
  const detail = entries
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} x${count}`)
    .join(", ");
  process.stderr.write(
    `cledger: ${source} preserved ${total} transcript line(s) of unrecognized type (${detail}) ` +
      `raw-only — the ${source} format may have added content this cledger version cannot ` +
      `interpret; update conversation-ledger to normalize these, or report it\n`,
  );
}
