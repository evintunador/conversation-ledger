/**
 * Format-drift re-normalization: the supersession half of the drift story
 * (the preservation half — emitting raw-only `unrecognized` events — lives in
 * adapters/drift.ts). When a newer cledger version has learned to interpret a
 * transcript line type it once preserved raw-only, `renormalize` turns each
 * such stored line into the event it should have been — a `conversation_turn`,
 * or one of the record kinds a non-turn line maps to — and appends a
 * `supersession` event linking the two, so consumers stop seeing the raw
 * placeholder and see the interpreted event instead.
 *
 * Invariants:
 *  - Append-only. The `unrecognized` event is never deleted; it is superseded
 *    via a `supersession` event carrying `links:[{rel:"supersedes",target}]`.
 *  - Idempotent. A second run is a no-op: already-superseded events are
 *    skipped, and every id we produce is deterministic, so `appendEvents`
 *    dedups anything that slips through.
 *  - Id fidelity. The event is reconstructed by re-feeding the stored `raw.data`
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
import type { RepoInfo } from "annals";
import { gitUserIdentity } from "annals";
import { appendEvents, readEvents } from "./store.js";
import { eventId, type EventDraft, type EventLink, type EvidenceEvent } from "./schema.js";
import { renormalizeUnrecognizedMany as renormalizeClaude } from "./adapters/claude-code.js";
import { renormalizeUnrecognizedMany as renormalizeCodex } from "./adapters/codex.js";
import { renormalizeUnrecognized as renormalizeOpencode } from "./adapters/opencode.js";
import { renormalizeUnrecognized as renormalizeGemini } from "./adapters/gemini-cli.js";
import { renormalizeUnrecognized as renormalizeQwen } from "./adapters/qwen-code.js";
import { renormalizeUnrecognizedMany as renormalizePi } from "./adapters/pi.js";
import { renormalizeUnrecognizedMany as renormalizeMistralVibe } from "./adapters/mistral-vibe.js";
import { renormalizeUnrecognizedMany as renormalizeCopilot } from "./adapters/copilot.js";
import { renormalizeUnrecognizedMany as renormalizeKimi } from "./adapters/kimi.js";

import { renormalizeUnrecognizedMany as renormalizeGoose } from "./adapters/goose.js";

import { renormalizeUnrecognizedMany as renormalizeDroid } from "./adapters/droid.js";
import { renormalizeUnrecognized as renormalizeAider } from "./adapters/aider.js";

import { renormalizeUnrecognizedMany as renormalizeCline } from "./adapters/cline.js";
import { renormalizeUnrecognizedMany as renormalizeCrush } from "./adapters/crush.js";
import { renormalizeUnrecognizedMany as renormalizeContinue } from "./adapters/continue.js";

import { renormalizeUnrecognizedMany as renormalizeOpenInterpreter } from "./adapters/open-interpreter.js";
import { renormalizeUnrecognizedMany as renormalizeOpenHands } from "./adapters/openhands.js";
import { renormalizeUnrecognized as renormalizeKilo } from "./adapters/kilo.js";

/** Route a preserved event to the adapter that owns its `producer.source`. */
type Renormalizer = (event: EvidenceEvent, identity: Awaited<ReturnType<typeof gitUserIdentity>>) => EventDraft | EventDraft[] | null;

const RENORMALIZERS: Record<string, Renormalizer> = {
  "claude-code": renormalizeClaude,
  codex: renormalizeCodex,
  opencode: renormalizeOpencode,
  "gemini-cli": renormalizeGemini,
  "qwen-code": renormalizeQwen,
  pi: renormalizePi,
  "mistral-vibe": renormalizeMistralVibe,
  copilot: renormalizeCopilot,
  kimi: renormalizeKimi,
  goose: renormalizeGoose,
  droid: renormalizeDroid,
  aider: renormalizeAider,
  cline: renormalizeCline,
  continue: renormalizeContinue,
  crush: renormalizeCrush,
  openhands: renormalizeOpenHands,
  "open-interpreter": renormalizeOpenInterpreter,
  kilo: renormalizeKilo,
};

function renormalizerFor(source: string | undefined): Renormalizer | null {
  if (source === undefined) return null;
  return RENORMALIZERS[source] ?? null;
}

export interface RenormalizeResult {
  /** Preserved `unrecognized` events examined (excludes ones already superseded). */
  scanned: number;
  /** Events an adapter could now interpret (an event + supersession pair was produced). */
  interpreted: number;
  /** Fresh interpreted events written, of whatever kind the line maps to (one
   *  that already existed from a prior live capture dedups and is not counted here). */
  turnsAppended: number;
  /** Fresh `supersession` events written. */
  supersessionsAppended: number;
  /** Preserved events still uninterpretable — no owning adapter, or its
   *  convert path returned null; these stay preserved raw-only. */
  skipped: number;
}

export async function renormalize(repo: RepoInfo): Promise<RenormalizeResult> {
  const identity = await gitUserIdentity(repo);
  // Whole local ledger: re-normalizing only what the current branch reaches
  // would leave preserved lines stranded on every other branch, and silently
  // make the result depend on what happened to be checked out.
  const all = await readEvents(repo, { reachableFrom: null });

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
    const converted = renormalizer(event, identity);
    const interpreted = converted ? (Array.isArray(converted) ? converted : [converted]) : [];
    if (interpreted.length === 0) {
      result.skipped++;
      continue;
    }
    result.interpreted++;

    // The turn's id, computed the same way a fresh capture would (the stored
    // raw.data is already redacted, so the appendEvents redaction pass is a
    // no-op and does not shift this id).
    const turnDraft = interpreted[0]!;
    const turnIds = interpreted.map(eventId);
    const turnId = turnIds[0]!;
    for (const [index, draft] of interpreted.entries()) {
      const id = turnIds[index]!;
      if (!existingIds.has(id)) {
        drafts.push(draft);
        existingIds.add(id);
      }
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
        ...(turnIds.length > 1 ? { by_all: turnIds } : {}),
        reason: "renormalized",
        ...(event.raw?.format ? { raw_format: event.raw.format } : {}),
      },
      links: [link],
    };
    if (event.stream) supersessionDraft.stream = event.stream;
    drafts.push(supersessionDraft);
  }

  if (drafts.length > 0) {
    const appended = await appendEvents(repo, drafts);
    for (const e of appended.appended) {
      // Anything that is not the supersession itself is the interpreted
      // event: a turn, or one of the record kinds a non-turn line maps to.
      if (e.kind === "supersession") result.supersessionsAppended++;
      else result.turnsAppended++;
    }
  }
  return result;
}
