import { createHash } from "node:crypto";

/**
 * Canonical JSON: recursively sorted object keys, no insignificant
 * whitespace. Canonical bytes are what get hashed and what get stored as
 * note lines, so that identical events always serialize identically —
 * dedup and git's cat_sort_uniq notes merge both depend on this.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
