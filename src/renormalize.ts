/**
 * Format-drift re-normalization: the supersession half of the drift story
 * (the preservation half — emitting raw-only `unrecognized` events — lives in
 * adapters/drift.ts). When a newer cledger version has learned to interpret a
 * transcript line type it once preserved raw-only, `renormalize` turns each
 * such stored line into the proper `conversation_turn` and appends a
 * `supersession` event linking the two, so consumers stop seeing the raw
 * placeholder and see the interpreted turn instead.
 *
 * Invariants:
 *  - Append-only. The `unrecognized` event is never deleted; it is superseded
 *    via a `supersession` event carrying `links:[{rel:"supersedes",target}]`.
 *  - Idempotent. A second run is a no-op: already-superseded events are
 *    skipped, and every id we produce is deterministic, so `appendEvents`
 *    dedups anything that slips through.
 *  - Id fidelity. The turn is reconstructed by re-feeding the stored `raw.data`
 *    through the owning adapter's *same* convert path (see each adapter's
 *    `renormalizeUnrecognized`), so it gets the exact id a live capture of the
 *    same line would — a future live capture then dedups against it rather
 *    than duplicating.
 *  - Redaction safety. The stored `raw.data` was already redacted at
 *    preservation time; the reconstructed turn also rides the normal
 *    `appendEvents` redaction path, which is idempotent on already-placeholdered
 *    text — nothing is re-exposed.
 *
 * Manual-only for now: this is an explicit `cledger renormalize` step, not
 * auto-triggered on capture. Auto-detecting "the adapter changed" and running
 * this after a version bump is a deferred follow-up (see the roadmap).
 */
import type { RepoInfo } from "./git.js";
import { gitUserIdentity } from "./git.js";
import { appendEvents, readEvents } from "./store.js";
import { eventId, type EventDraft, type EventLink, type EvidenceEvent } from "./schema.js";
import { renormalizeUnrecognized as renormalizeClaude } from "./adapters/claude-code.js";
import { renormalizeUnrecognized as renormalizeCodex } from "./adapters/codex.js";

/** Route a preserved event to the adapter that owns its `producer.source`. */
type Renormalizer = (event: EvidenceEvent, identity: Awaited<ReturnType<typeof gitUserIdentity>>) => EventDraft | null;

function renormalizerFor(source: string | undefined): Renormalizer | null {
  if (source === "claude-code") return renormalizeClaude;
  if (source === "codex") return renormalizeCodex;
  return null;
}

export interface RenormalizeResult {
  /** Preserved `unrecognized` events examined (excludes ones already superseded). */
  scanned: number;
  /** Events an adapter could now interpret (a turn + supersession pair was produced). */
  interpreted: number;
  /** Fresh `conversation_turn` events written (an interpreted turn that already
   *  existed from a prior live capture dedups and is not counted here). */
  turnsAppended: number;
  /** Fresh `supersession` events written. */
  supersessionsAppended: number;
  /** Preserved events still uninterpretable — no owning adapter, or its
   *  convert path returned null; these stay preserved raw-only. */
  skipped: number;
}

export async function renormalize(repo: RepoInfo): Promise<RenormalizeResult> {
  const identity = await gitUserIdentity(repo);
  const all = await readEvents(repo);

  // Targets of any existing supersession — already re-normalized, skip them so
  // a re-run does no work rather than relying on dedup alone.
  const supersededTargets = new Set<string>();
  for (const e of all) {
    if (e.kind !== "supersession") continue;
    for (const link of e.links ?? []) {
      if (link.rel === "supersedes") supersededTargets.add(link.target);
    }
  }
  // Every id already in the ledger, across all anchors — `appendEvents` only
  // dedups within the target anchor, so this guards the cross-anchor case
  // where a live capture already wrote the same turn under a different commit.
  const existingIds = new Set(all.map((e) => e.id));

  const result: RenormalizeResult = {
    scanned: 0,
    interpreted: 0,
    turnsAppended: 0,
    supersessionsAppended: 0,
    skipped: 0,
  };
  const drafts: EventDraft[] = [];

  for (const event of all) {
    if (event.kind !== "unrecognized") continue;
    if (supersededTargets.has(event.id)) continue;
    result.scanned++;

    const renormalizer = renormalizerFor(event.producer.source);
    if (!renormalizer) {
      result.skipped++;
      continue;
    }
    const turnDraft = renormalizer(event, identity);
    if (!turnDraft) {
      result.skipped++;
      continue;
    }
    result.interpreted++;

    // The turn's id, computed the same way a fresh capture would (the stored
    // raw.data is already redacted, so the appendEvents redaction pass is a
    // no-op and does not shift this id).
    const turnId = eventId(turnDraft);
    if (!existingIds.has(turnId)) {
      drafts.push(turnDraft);
      existingIds.add(turnId);
    }

    const link: EventLink = { rel: "supersedes", target: event.id };
    const supersessionDraft: EventDraft = {
      kind: "supersession",
      // Same instant the content "happened" — keeps this event's id
      // deterministic (occurred_at is part of the identity subset), so a
      // re-run dedups instead of minting a second supersession.
      occurred_at: turnDraft.occurred_at,
      actor: { type: "system" },
      producer: {
        tool: "cledger",
        ...(turnDraft.producer.version ? { version: turnDraft.producer.version } : {}),
        ...(event.producer.source ? { source: event.producer.source } : {}),
        ...(event.producer.session_id ? { session_id: event.producer.session_id } : {}),
      },
      content: {
        superseded: event.id,
        by: turnId,
        reason: "renormalized",
        ...(event.raw?.format ? { raw_format: event.raw.format } : {}),
      },
      links: [link],
    };
    if (event.conversation) supersessionDraft.conversation = event.conversation;
    drafts.push(supersessionDraft);
  }

  if (drafts.length > 0) {
    const appended = await appendEvents(repo, drafts);
    for (const e of appended.appended) {
      if (e.kind === "conversation_turn") result.turnsAppended++;
      else if (e.kind === "supersession") result.supersessionsAppended++;
    }
  }
  return result;
}
