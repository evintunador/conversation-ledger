#!/usr/bin/env node
/**
 * Additive ev1 -> ev2 migration for cledger's git-notes history.
 *
 * Dry-run by default. `--execute` atomically:
 *   1. creates refs/notes/conversation-ledger-ev1 at the exact source ref;
 *   2. creates refs/notes/conversation-ledger-migration at the verified ev2 candidate;
 *   3. advances refs/notes/conversation-ledger to that same candidate.
 *
 * Event bodies are never printed. The local 0600 manifest contains the
 * structural report and complete old-id -> new-id mapping; the immutable ev1
 * archive retains every original byte, including provenance variants that
 * intentionally converge under annals' narrower ev2 identity.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, eventId, SCHEMA_VERSION } from "annals";
import { fromAnnals, toAnnals } from "../dist/schema.js";

const LIVE_REF = "refs/notes/conversation-ledger";
const ARCHIVE_REF = "refs/notes/conversation-ledger-ev1";
const CANDIDATE_REF = "refs/notes/conversation-ledger-migration";

function git(repo, args, input) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function maybeGit(repo, args) {
  try {
    return git(repo, args).trim();
  } catch {
    return "";
  }
}

function refSha(repo, ref) {
  return maybeGit(repo, ["rev-parse", "--verify", "--quiet", ref]);
}

function commonDir(repo) {
  const value = git(repo, ["rev-parse", "--git-common-dir"]).trim();
  return resolve(repo, value);
}

function readRef(repo, ref) {
  const rows = git(repo, ["notes", `--ref=${ref}`, "list"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const anchors = [];
  const occurrences = [];
  for (const row of rows) {
    const [note, anchor] = row.split(/\s+/);
    if (!note || !anchor) throw new Error(`malformed notes-list row in ${ref}`);
    const body = git(repo, ["cat-file", "blob", note]);
    const events = [];
    for (const line of body.split("\n").filter(Boolean)) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON event under anchor ${anchor}`);
      }
      if (typeof raw.id !== "string") throw new Error(`event without string id under ${anchor}`);
      events.push({ raw, line });
      occurrences.push({ anchor, raw, line });
    }
    anchors.push({ anchor, events });
  }
  return { anchors, occurrences };
}

function annalsWire(raw) {
  if (raw.schema === SCHEMA_VERSION && String(raw.id).startsWith("ev2-")) {
    return structuredClone(raw);
  }
  const cledger = fromAnnals(raw);
  // fromAnnals deliberately tolerates old top-level actor/producer fields,
  // but its normal read compatibility does not rename the old envelope key:
  // the one-time migration does.
  if (raw.conversation && !cledger.stream) cledger.stream = raw.conversation;
  delete cledger.conversation;
  return toAnnals(cledger);
}

function identityDraft(event) {
  const draft = structuredClone(event);
  delete draft.id;
  delete draft.schema;
  delete draft.recorded_at;
  return draft;
}

function migrate(source) {
  const byOldId = new Map();
  for (const occurrence of source.occurrences) {
    const list = byOldId.get(occurrence.raw.id) ?? [];
    list.push(occurrence);
    byOldId.set(occurrence.raw.id, list);
  }

  // One representative determines identity for each old id. Existing ev2
  // records win, then canonical bytes make the choice deterministic.
  const representative = new Map();
  for (const [id, list] of byOldId) {
    list.sort((a, b) => {
      const ae2 = a.raw.schema === SCHEMA_VERSION && String(a.raw.id).startsWith("ev2-");
      const be2 = b.raw.schema === SCHEMA_VERSION && String(b.raw.id).startsWith("ev2-");
      if (ae2 !== be2) return ae2 ? -1 : 1;
      return a.line.localeCompare(b.line);
    });
    representative.set(id, list[0].raw);
  }

  const state = new Map();
  const migratedByOldId = new Map();
  const unresolvedEventLinks = [];
  function resolveEvent(oldId) {
    const cached = migratedByOldId.get(oldId);
    if (cached) return cached;
    if (state.get(oldId) === "visiting") {
      throw new Error(`event-link cycle involving ${oldId.slice(0, 16)}`);
    }
    const raw = representative.get(oldId);
    if (!raw) throw new Error(`internal error: no representative for ${oldId.slice(0, 16)}`);
    state.set(oldId, "visiting");
    const wire = annalsWire(raw);
    let linksChanged = false;
    if (Array.isArray(wire.links)) {
      wire.links = wire.links.map((link) => {
        if (byOldId.has(link.target)) {
          const target = resolveEvent(link.target).id;
          if (target !== link.target) linksChanged = true;
          return { ...link, target };
        }
        if (String(link.target).startsWith("ev1-")) {
          unresolvedEventLinks.push({ source: oldId, rel: link.rel, target: link.target });
        }
        return link;
      });
    }
    const computed = eventId(identityDraft(wire));
    const wasEv2 = wire.schema === SCHEMA_VERSION && String(wire.id).startsWith("ev2-");
    // Early ev2 records were written while the envelope's final
    // producer-blind identity rules were still settling. Normalize those as
    // well; the mapping therefore covers old ev2 ids in addition to ev1.
    wire.id = computed;
    wire.schema = SCHEMA_VERSION;
    state.set(oldId, "done");
    migratedByOldId.set(oldId, wire);
    return wire;
  }
  for (const id of representative.keys()) resolveEvent(id);
  if (unresolvedEventLinks.length > 0) {
    throw new Error(`${unresolvedEventLinks.length} link target(s) reference missing ev1 events`);
  }

  // Distinct old ids can intentionally converge under ev2 identity because
  // actor/source/session are provenance now. Prefer an already-ev2 record,
  // then canonical bytes; the archive retains every discarded variant.
  const candidatesByNewId = new Map();
  for (const [oldId, event] of migratedByOldId) {
    const list = candidatesByNewId.get(event.id) ?? [];
    list.push({ oldId, event, wasEv2: oldId.startsWith("ev2-") });
    candidatesByNewId.set(event.id, list);
  }
  const chosenByNewId = new Map();
  for (const [newId, list] of candidatesByNewId) {
    list.sort((a, b) => {
      if (a.wasEv2 !== b.wasEv2) return a.wasEv2 ? -1 : 1;
      return canonicalJson(a.event).localeCompare(canonicalJson(b.event));
    });
    chosenByNewId.set(newId, list[0].event);
  }

  const bodies = new Map();
  for (const anchor of source.anchors) {
    const ids = new Set(anchor.events.map(({ raw }) => migratedByOldId.get(raw.id).id));
    const lines = [...ids].map((id) => canonicalJson(chosenByNewId.get(id))).sort();
    bodies.set(anchor.anchor, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  }

  const mapping = Object.fromEntries(
    [...migratedByOldId.entries()].map(([oldId, event]) => [oldId, event.id]).sort(([a], [b]) => a.localeCompare(b)),
  );
  const ev1 = [...representative.keys()].filter((id) => id.startsWith("ev1-")).length;
  const ev2 = representative.size - ev1;
  const collisionGroups = [...candidatesByNewId.values()].filter((list) => list.length > 1);
  return {
    bodies,
    mapping,
    stats: {
      anchors: source.anchors.length,
      inputLines: source.occurrences.length,
      uniqueInputIds: representative.size,
      ev1Ids: ev1,
      existingEv2Ids: ev2,
      outputUniqueIds: chosenByNewId.size,
      collisionGroups: collisionGroups.length,
      collapsedOldIds: collisionGroups.reduce((sum, list) => sum + list.length - 1, 0),
    },
  };
}

function writeNotesCommit(repo, bodies, sourceSha) {
  const dir = mkdtempSync(join(tmpdir(), "cledger-migrate-index-"));
  const index = join(dir, "index");
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "cledger migration",
    GIT_AUTHOR_EMAIL: "cledger-migration@local.invalid",
    GIT_COMMITTER_NAME: "cledger migration",
    GIT_COMMITTER_EMAIL: "cledger-migration@local.invalid",
  };
  const run = (args, input) => execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", input, env, maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    for (const [anchor, body] of bodies) {
      const blob = run(["hash-object", "-w", "--stdin"], body).trim();
      const path = `${anchor.slice(0, 2)}/${anchor.slice(2)}`;
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = run(["write-tree"]).trim();
    return run(["commit-tree", tree, "-m", `cledger: migrate ev1 history from ${sourceSha}`]).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verifyCandidate(repo, commit, expected) {
  const rows = git(repo, ["ls-tree", "-r", "--format=%(objectname) %(path)", commit])
    .trim().split("\n").filter(Boolean);
  let events = 0;
  for (const row of rows) {
    const [blob] = row.split(" ", 1);
    const body = git(repo, ["cat-file", "blob", blob]);
    const seen = new Set();
    for (const line of body.split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.schema !== SCHEMA_VERSION || !String(event.id).startsWith("ev2-")) {
        throw new Error("candidate contains a non-ev2 event");
      }
      if (seen.has(event.id)) throw new Error("candidate note contains duplicate event ids");
      seen.add(event.id);
      if (eventId(identityDraft(event)) !== event.id) {
        throw new Error(`candidate id validation failed: ${String(event.id).slice(0, 16)}`);
      }
      events++;
    }
  }
  if (rows.length !== expected.bodies.size) throw new Error("candidate anchor count changed");
  return { anchors: rows.length, eventLines: events };
}

function report(repo, sourceSha, result, mode, verification) {
  const s = result.stats;
  console.log(`${mode}: ${repo}`);
  console.log(`  source: ${sourceSha.slice(0, 12)}; anchors: ${s.anchors}; lines: ${s.inputLines}`);
  console.log(`  ids: ${s.ev1Ids} ev1 + ${s.existingEv2Ids} ev2 -> ${s.outputUniqueIds} ev2`);
  console.log(`  convergence: ${s.collisionGroups} group(s), ${s.collapsedOldIds} old id(s) collapsed`);
  if (verification) console.log(`  verified candidate: ${verification.anchors} anchors, ${verification.eventLines} lines`);
}

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const repoArg = args.indexOf("--repo");
const repo = resolve(repoArg >= 0 ? args[repoArg + 1] : process.cwd());
const liveSha = refSha(repo, LIVE_REF);
if (!liveSha) throw new Error(`${repo}: no ${LIVE_REF}`);
const archiveSha = refSha(repo, ARCHIVE_REF);
if (archiveSha) {
  const live = readRef(repo, LIVE_REF);
  const liveEv1 = live.occurrences.filter(({ raw }) => String(raw.id).startsWith("ev1-")).length;
  if (liveEv1 === 0) {
    console.log(`already migrated: ${repo} (archive ${archiveSha.slice(0, 12)}, live ${liveSha.slice(0, 12)})`);
    process.exit(0);
  }
  throw new Error(`${repo}: archive exists but live ref still contains ${liveEv1} ev1 event(s)`);
}

const source = readRef(repo, LIVE_REF);
const result = migrate(source);
report(repo, liveSha, result, execute ? "EXECUTE" : "DRY-RUN");
if (!execute) process.exit(0);

const candidateSha = writeNotesCommit(repo, result.bodies, liveSha);
const verification = verifyCandidate(repo, candidateSha, result);
report(repo, liveSha, result, "VERIFIED", verification);

const tx = [
  "start",
  `create ${ARCHIVE_REF} ${liveSha}`,
  `create ${CANDIDATE_REF} ${candidateSha}`,
  `update ${LIVE_REF} ${candidateSha} ${liveSha}`,
  "prepare",
  "commit",
  "",
].join("\n");
git(repo, ["update-ref", "--stdin"], tx);

const manifestPath = join(commonDir(repo), "conversation-ledger", "migrations", "ev1-to-ev2.json");
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify({
  version: 1,
  migrated_at: new Date().toISOString(),
  source_ref: LIVE_REF,
  source_sha: liveSha,
  archive_ref: ARCHIVE_REF,
  archive_sha: liveSha,
  candidate_ref: CANDIDATE_REF,
  candidate_sha: candidateSha,
  live_ref: LIVE_REF,
  live_sha: candidateSha,
  stats: result.stats,
  mapping: result.mapping,
}, null, 2)}\n`, { mode: 0o600 });
console.log(`  promoted atomically; manifest: ${manifestPath}`);
