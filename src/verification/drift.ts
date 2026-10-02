import type { EvidenceEvent } from "../schema.js";

/** Check normalized content too: adapters may preserve unknown nested parts inside turns. */
export function hasUnrecognizedEvidence(
  events: EvidenceEvent[],
  source: string,
): boolean {
  const unknown = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(unknown);
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (
      record.type === "unrecognized" || Object.values(record).some(unknown)
    );
  };
  return events.some(
    (event) =>
      event.producer.source === source &&
      (event.kind === "unrecognized" || unknown(event.content)),
  );
}
