import type { Actor, EventDraft, EvidenceEvent } from "./schema.js";

/**
 * Re-anchoring: a `re_anchor` event asserts that commits rewritten away by a
 * squash merge or history rewrite (`superseded`) live on in a `successor`
 * commit. The ledger never moves note lines — the union merge would resurrect
 * anything a removal dropped, and the original anchor is honest provenance —
 * so the mapping is itself an ordinary append-only event, anchored to the
 * successor commit so it rides the surviving branch's DAG. Read-time
 * reachability treats a superseded anchor as reachable whenever its successor
 * is (see resolveAnchors in store.ts).
 */
export interface ReAnchorMapping {
  /** Full SHAs of the commits the rewrite discarded. */
  superseded: string[];
  /** Full SHA of the commit that carries their changes now. */
  successor: string;
  /** How the mapping was established: "tree" | "patch-id" | "manual". */
  method: string;
  /** Branch the superseded commits lived on, when known — human context. */
  branch?: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Parse a `re_anchor` event's content, or null when the event is some other
 * kind or malformed. Resolution must never trust event content: kinds are an
 * open namespace and any tool can append, so a bad mapping is ignored rather
 * than corrupting the reachability view.
 */
export function parseReAnchor(event: EvidenceEvent): ReAnchorMapping | null {
  if (event.kind !== "re_anchor") return null;
  const c = event.content as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const successor = c["successor"];
  const superseded = c["superseded"];
  if (typeof successor !== "string" || !FULL_SHA.test(successor)) return null;
  if (
    !Array.isArray(superseded) ||
    superseded.length === 0 ||
    !superseded.every((s): s is string => typeof s === "string" && FULL_SHA.test(s))
  ) {
    return null;
  }
  const mapping: ReAnchorMapping = {
    superseded,
    successor,
    method: typeof c["method"] === "string" ? c["method"] : "unknown",
  };
  if (typeof c["branch"] === "string") mapping.branch = c["branch"];
  return mapping;
}

export interface ReAnchorDraftOptions {
  superseded: string[];
  successor: string;
  method: "tree" | "patch-id" | "manual";
  /**
   * The successor commit's committer timestamp (ISO 8601). Deliberately NOT
   * "now": occurred_at is part of event identity, and the mapping must hash
   * identically no matter which machine detects the squash or when — that is
   * what lets two machines' independent detections dedup to one event.
   */
  occurredAt: string;
  branch?: string;
  /**
   * Defaults to `{type: "system"}` — mechanical detection has no human
   * author, and a machine-specific actor.id would break cross-machine dedup.
   * Manual mappings pass the confirming user instead: two humans asserting
   * the same mapping yield two events, which is honest provenance.
   */
  actor?: Actor;
}

/** Build the append-ready draft for a mapping. Caller anchors it to the successor. */
export function reAnchorDraft(opts: ReAnchorDraftOptions): EventDraft {
  const content: Record<string, unknown> = {
    // Sorted so the same mapping serializes to the same canonical bytes
    // regardless of discovery order.
    superseded: [...opts.superseded].sort(),
    successor: opts.successor,
    method: opts.method,
  };
  if (opts.branch) content.branch = opts.branch;
  return {
    kind: "re_anchor",
    occurred_at: opts.occurredAt,
    actor: opts.actor ?? { type: "system" },
    producer: { tool: "cledger" },
    content,
  };
}
