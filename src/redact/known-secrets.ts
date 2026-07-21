/**
 * Opt-in local store of confirmed secret *values* (layer C sibling, see
 * docs/WIP_TECHNICAL_DESIGN.md "Privacy and integrity"). When
 * `{"redact": {"knownSecrets": true}}` is set, a `cledger redact --pattern`
 * remembers the exact strings it scrubbed here, and capture-time redaction
 * then exact-matches them out of every future event — so a value the broad
 * sync scan caught (but the conservative capture tier missed) can never be
 * re-captured raw. That closes the capture side of the redaction feedback
 * loop; the sync-report side is closed by the masked excerpt in scan.ts.
 *
 * This file necessarily holds plaintext secrets. It lives under `.git/`,
 * which git never tracks or pushes (structurally, not via .gitignore), so it
 * is exactly as local-and-unshared as the native transcripts the values came
 * from — consistent with the "trust boundary is transport" threat model. It
 * is local, rebuildable-if-lost state, the same tier as the allowlist and
 * pending queue — never the record of truth. Off by default: when the flag
 * is not set, this store is never read or created.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoInfo } from "../git.js";

/**
 * Owner read/write only. This file holds confirmed secret plaintext, so it
 * must not be group/world-readable even on a shared machine. `mode` on
 * writeFile only applies when the file is *created*, so an explicit chmod
 * follows to also repair permissions on a store created before this existed.
 */
const STORE_MODE = 0o600;

/**
 * Values shorter than this are never remembered: an exact-string scrub of a
 * short/common value (a weak password like "pass", a 4-char token) would
 * over-match innocent occurrences in unrelated events. Mirrors the same floor
 * collectEnvValues() applies to env masking.
 */
const MIN_VALUE_LENGTH = 8;

interface KnownSecretsFile {
  values: string[];
}

function knownSecretsPath(repo: RepoInfo): string {
  return join(repo.gitDir, "conversation-ledger", "known-secrets.json");
}

/** Load remembered secret values. Missing/malformed store -> empty (never fails capture). */
export async function loadKnownSecrets(repo: RepoInfo): Promise<string[]> {
  try {
    const raw = await readFile(knownSecretsPath(repo), "utf8");
    const parsed = JSON.parse(raw) as KnownSecretsFile;
    return Array.isArray(parsed.values) ? parsed.values.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Remember confirmed secret values (additive, deduplicated, sorted). Values
 * below MIN_VALUE_LENGTH are dropped. A no-op that never creates the file
 * when nothing survives filtering.
 */
export async function addKnownSecrets(repo: RepoInfo, values: string[]): Promise<void> {
  const existing = new Set(await loadKnownSecrets(repo));
  let added = false;
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_VALUE_LENGTH) continue;
    if (!existing.has(value)) {
      existing.add(value);
      added = true;
    }
  }
  if (!added) return;
  await mkdir(join(repo.gitDir, "conversation-ledger"), { recursive: true });
  const path = knownSecretsPath(repo);
  await writeFile(path, JSON.stringify({ values: [...existing].sort() }, null, 2) + "\n", {
    mode: STORE_MODE,
  });
  // Repair perms on a pre-existing store (writeFile's mode only applies on
  // create). Never fail capture over a chmod that the filesystem refuses.
  try {
    await chmod(path, STORE_MODE);
  } catch {
    /* best effort */
  }
}
