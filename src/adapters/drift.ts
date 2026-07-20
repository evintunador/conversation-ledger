/**
 * Format-drift detection shared by adapters. Adapters are tolerant parsers
 * that skip line types they don't recognize; that handles additive upstream
 * changes gracefully, but a genuinely new message type would otherwise be
 * dropped in silence (raw included). Counting the unrecognized types and
 * warning is the drift tripwire — captured events are unaffected.
 */

export interface CaptureResult {
  appended: number;
  deduped: number;
  /** Skipped-line tallies keyed by unrecognized type, e.g. {"response_item/agent_message": 3}. */
  unrecognized: Record<string, number>;
}

export function countUnrecognized(unrecognized: Record<string, number>, key: string): void {
  unrecognized[key] = (unrecognized[key] ?? 0) + 1;
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
    `cledger: ${source} skipped ${total} transcript line(s) of unrecognized type (${detail}) — ` +
      `the ${source} format may have added content this cledger version does not capture; ` +
      `update conversation-ledger or report it\n`,
  );
}
