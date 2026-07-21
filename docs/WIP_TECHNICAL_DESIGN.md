# Technical design

**Status:** implemented in v0.1; format may still evolve until v1.

## Scope

Conversation Ledger defines a canonical append-only event format plus a local,
git-backed storage protocol. It preserves exact visible content while staying
out of the working tree. Transport is on by default and rides normal git use:
a pre-push hook pushes the ledger ref alongside `git push` (scan-gated), and
a fetch refspec stages the remote's ref for lazy merge at read time (see
"Transport"); `cledger sync` remains the explicit path and the fallback when
hooks are declined.

## Canonical objects

An `EvidenceEvent` is immutable and has:

- `id`: `ev1-` + sha256 of the event's *identity subset* — the durable,
  source-determined fields (`kind`, `occurred_at`, `actor.type/id`,
  `producer.source/session_id`, `conversation`, `media_type`, `content`,
  `links`). Volatile provenance (`recorded_at`, `context`, `raw`,
  `producer.tool/version`) is excluded, so re-scanning the same source
  material always yields the same id: capture is idempotent by construction,
  and the id doubles as the content hash that makes mutation detectable.
- `schema` version (`conversation-ledger/v1`);
- `kind`: `conversation_turn`, `decision`, `document`, `annotation`,
  `redaction`, or `supersession` — an open string; unknown kinds are stored
  verbatim so downstream tools can extend without a schema release;
- `occurred_at` (from the source) and `recorded_at` (at append) timestamps;
- `actor` (human/agent/system + identity) and `producer` (capture tool,
  source system, native session id) provenance; adapters stamp human turns
  with the identity a commit made right now would be authored under,
  resolved by git itself (`git -c user.useConfigOnly=true var
  GIT_AUTHOR_IDENT`) in git's own precedence: `GIT_AUTHOR_EMAIL` env, then
  `user.email` config (includeIf and all), then `EMAIL` env — never a
  hostname/OS-username guess, which churns (DHCP renames) and would churn
  event ids. Explicit config is the fallback when strict resolution
  refuses over one missing field (email set, no name anywhere). When git
  would have to guess the email too, turns stay unattributed;
  `cledger install` warns. Because `actor.id` is part of the event identity subset, sessions
  captured before this stamping existed will produce new event ids if fully
  re-scanned — the per-session cursor normally prevents that, but a forced
  rescan can duplicate pre-identity turns;
- `content`, stored inline, with an optional `media_type`
  (default `application/json`);
- `context`: repository identity, branch, `HEAD` SHA, cwd, and a
  dirty-worktree fingerprint (sha256 of `git status --porcelain`);
- `conversation`: namespaced id (`claude-code:<session>`) plus a stable
  `seq` (source line index) providing conversation ordering — the manifest is
  currently implicit in these fields rather than a separate object;
- optional `links` (`redacts`, `supersedes`, `annotates`, ...).

Conversation turns preserve visible roles, text, tool calls, and tool results
as supplied by their capture adapter. The source-native payload is retained
under `raw` as an opaque, versioned attachment for lossless export.

Reasoning policy: record model reasoning when the provider exposes it
(Claude Code's thinking text is kept, minus opaque signatures); never chase
it when the provider withholds it (Codex's encrypted `reasoning` payloads
are skipped, not stored, and never reconstructed). The same rule applies
inside otherwise-visible content: Codex `agent_message` items (inter-agent
messages) convert with their visible text blocks kept and their
`encrypted_content` blocks dropped from both `content` and `raw`, leaving a
bare type marker so the omission is visible.

## Storage

One git note per **anchor commit** under `refs/notes/conversation-ledger`.
The note body is JSONL: one canonical-JSON (sorted-keys) event per line,
lexicographically sorted, unique.

Why this shape:

1. **Branch-tied by construction.** Events anchor to `HEAD` at capture time,
   so conversations ride the commit DAG: merging a branch makes its commits —
   and therefore their conversations — reachable from the target branch with
   no sync machinery. `cledger log` scopes to the current branch via
   `git rev-list` reachability.
2. **GC-safe, nothing outside git.** All content lives inline in the note
   blob, reachable from the ref. No orphan data branches, no pointers to
   stores outside the repository.
3. **Conflict-free concurrency.** Deterministic serialization + sorted unique
   lines mean git's `cat_sort_uniq` notes merge strategy (configured per-ref
   at first append) unions concurrent appends cleanly — the same mechanism
   git-bug and git-appraise rely on.
4. **Clean working tree.** Notes never appear in `git status`; sharing is
   the fetch → `git notes merge -s cat_sort_uniq` → push of that single
   ref, run by the default-on transport hooks or explicitly via `cledger
   sync` (the E scan gates the push either way — see "Transport").

Events captured before the first commit exists (unborn `HEAD`) queue in
`.git/conversation-ledger/pending.jsonl` and flush into the first real
anchor. Everything under `.git/conversation-ledger/` (pending queue, adapter
cursors, lock) is local, rebuildable state — never the record of truth.

### Known limitation: squash merges

A squash merge discards the source branch's commits, so their conversations
remain in the ledger (notes are enumerable regardless of reachability;
`cledger log --all` sees them) but drop out of the target branch's
reachability view. A future `re-anchor` operation is the intended fix.

## Transport

Default-on, wired by the first capture in a repo (`ensureTransport`, run on
every append as cheap re-checks so a remote added later still gets covered;
never throws — it runs inside capture):

- **Push half.** A `pre-push` hook calls `cledger transport-push <remote>`,
  which pushes the ledger ref gated by the layer-E scan. Policy: a finding
  holds back *only the ledger* — secrets never leave the machine, but a
  false positive never blocks shipping code; `{"transport": {"strict":
  true}}` escalates to aborting the entire push. Any other failure warns
  and lets the push proceed. Installation is chain-safe: append to an
  existing shell hook, back off with a one-time warning when
  `core.hooksPath` or a non-shell hook owns the file. The hook script
  embeds the installing cledger's absolute node+cli.js path (PATH fallback
  in the script), treats "cledger gone" as success, and a
  `CLEDGER_INTERNAL` env guard (set by `sync` around its own push) stops
  the ledger push from re-triggering the hook.
- **Fetch half.** A `+refs/notes/conversation-ledger:refs/notes/
  cledger-incoming` refspec on `origin` makes plain `git fetch`/`git pull`
  stage the remote's ref; `absorbIncoming` folds the staging ref into the
  local ref lazily at read time (every `readEvents`) via the same
  `cat_sort_uniq` union — absorption can only add events, and the local
  ref is never force-overwritten. `cledger sync`'s fetch phase uses the
  identical staging path.
- **Opt-out.** `{"transport": {"hook": false, "fetchRefspec": false}}`
  (config), or delete the marked hook block. `cledger sync` stays available
  regardless.

## Capture adapters

`cledger install` registers per-turn hooks globally: Claude Code
(`Stop`/`SessionEnd` in `~/.claude/settings.json`) and Codex CLI
(`[[hooks.Stop]]` in `~/.codex/config.toml`). Hooks receive
`session_id`/`transcript_path`/`cwd` on stdin, no-op silently outside git
repositories, never fail the user's session, and re-scan tolerantly —
idempotent ids make duplicate capture harmless. Per-session cursors under
`.git/conversation-ledger/cursors/` are a pure optimization.

## Privacy and integrity

Visible tool output can contain secrets. The trust boundary is transport:
native transcripts already sit in plaintext on the capturing machine, so
redaction protects the *shared* record, not the local disk. But once a
secret reaches a note, removal is expensive (the notes ref's own history
retains prior blobs), so prevention layers run at capture and the last
checkpoint runs at sync. Content hashes (event ids) make accidental
mutation detectable.

### Redaction layers

Defense in depth, ordered by where they run and what they may do:

- **A. Capture-time pattern redaction (default on).** A deliberately
  conservative, versioned ruleset of unambiguous secret formats — prefixed
  API tokens (`ghp_…`, `sk-ant-…`, `AKIA…`, `xox…-`, `AIza…`, `glpat-…`,
  `npm_…`, `sk_live_…`), PEM private-key blocks, JWTs — applied to every
  draft inside `appendEvents`, before ids are computed. Matches in both
  `content` and `raw.data` are replaced with a deterministic placeholder
  (see below). No entropy heuristics here: a false positive silently
  rewrites the record, which violates the preservation commitment, so
  capture-tier rules must be near-zero-false-positive by construction.
- **B. External scanners as test oracle only.** gitleaks/trufflehog-class
  rulesets are used in the test suite to prove the capture tier catches
  what it claims (secret corpus in, zero findings out) — never vendored
  into the runtime path.
- **C. Env-value masking (opt-in, default off).** Scrub exact values of
  local environment variables / `.env` entries from captured content.
  Highest recall for unstructured secrets, but `.env` is often plain
  config, and the transform depends on machine state — so it is
  nondeterministic across rescans (id churn is the documented cost of
  opting in).
- **D. User pattern rules (config).** Extra redaction regexes merged into
  the capture tier from config. Path-based exclusion ("never record reads
  of `secrets/**`") is planned; it requires correlating `tool_use` inputs
  with `tool_result` events and is not in v1.
- **E. Sync-time scan (default on, tiered).** Before push, scan only the
  events the remote does not yet have. The default profile runs
  medium/high-precision rules (capture ruleset re-run for events captured
  under older rules, keyword-anchored assignments, URL credentials); on a
  hit the push blocks with an interactive finding report — allowlist the
  false positive (persisted by fingerprint) or `cledger redact` the real
  secret while purge is still a local operation. Entropy heuristics live
  behind an opt-in paranoid tier; `--no-scan`/config disables the gate
  entirely. Scan-tier rules may be noisy precisely because they only warn
  a human — they never rewrite anything. Finding reports mask the matched
  span entirely (surrounding context + fingerprint, zero secret characters),
  so a captured report cannot re-seed the finding it describes.
- **F. Known-secret learning (opt-in, default off).** Runs at capture like
  A/C/D, but is *sourced* from the E flow: a `cledger redact --pattern`
  remembers the exact values it scrubbed in a local, git-invisible store
  (`.git/conversation-ledger/known-secrets.json`), and capture-time redaction
  exact-matches them out of every future draft under a `known-secret` rule id.
  This closes the capture side of the capture/scan feedback loop — a value E
  catches but A missed can never be re-captured raw once confirmed. Like C it
  is exact-value and therefore machine-dependent (id churn is the accepted
  cost); only `--pattern` feeds it (`--all` blanks whole content, no reusable
  value) and sub-8-char values are dropped to avoid over-matching. It stores
  plaintext by necessity (fingerprints are one-way and can't drive exact
  matching) but under `.git/`, exactly as local-and-unshared as the
  transcripts the values came from — consistent with the transport boundary.
  Off by default: the store is never read or created unless the flag is set.

### Redaction metadata

A capture-time redaction replaces the matched span with
`[REDACTED:<rule-id>:<fingerprint>]` — fingerprint is a truncated
`sha256(secret)`, letting identical secrets correlate across events without
being recoverable (brute-forceable only for low-entropy values, which the
capture tier does not target). The event also carries a `redactions` array
(rule id, ruleset version, fingerprint, location path); it sits outside the
identity subset, since the rewritten `content` already determines the id.
Determinism rule: capture-tier redaction must be a pure function of source
content + versioned ruleset, or rescans duplicate events. Ruleset upgrades
therefore change ids on forced rescan — same accepted caveat as identity
stamping; cursors prevent it in normal operation.

A human redaction of an *existing* event (the E flow) instead rewrites the
note line and appends a companion `redaction` event with `links.redacts`,
then squashes the local notes ref so the prior blob is unreachable —
honest history without secret retention (when `knownSecrets` is on, a
`--pattern` redaction also feeds the F store; see above). Post-push purge
(force-push + collaborator coordination) is deliberately separate, deferred
tooling.

## Versioning against harness format changes

Three layers exist today:

1. `schema` on every event (`conversation-ledger/v1`) versions the ledger's
   own envelope.
2. `raw.format` (`claude-code-jsonl/1`, `codex-rollout-jsonl/2`) versions
   each adapter's interpretation of its native format; it must be bumped
   whenever the mapping changes, allowing later reprocessing to know which
   parser produced an event. (codex `/2`: `agent_message` payloads convert,
   encrypted blocks omitted — `/1` dropped those lines entirely.)
3. The native payload inside `raw.data` retains the harness's own version
   markers (Claude Code lines carry `version`; Codex `session_meta` carries
   `cli_version`), so captured content can always be re-normalized under a
   newer mapping without recapture.

Drift detection and raw preservation: adapters are tolerant parsers, but
each maintains an explicit known-skipped list (bookkeeping/UI line types,
Codex's opaque `reasoning` payloads) alongside its convertible set; parsed
lines matching neither are *unrecognized*. Each such line is both counted
per type for a capture-time warning (`CaptureResult.unrecognized`) and
preserved rather than dropped: the adapter emits an `unrecognized` event
whose `content` is only a `{unrecognized_type}` label and whose `raw.data`
holds the full source line, versioned by the adapter's native `raw.format`,
so a later adapter version can re-normalize (and supersede) it. Because
`raw` is outside the identity subset, distinctness and idempotency come from
`conversation.seq` (the source line index) exactly as for interpreted turns,
and format-version bumps never churn ids. Crucially these events ride the
normal `appendEvents` path, so the capture-tier redaction stack walks their
`raw.data` — an unrecognized line is not a bypass around secret redaction.
Encrypted/opaque payloads that policy forbids storing (Codex `reasoning`)
stay on the known-skipped list and are never preserved.

Re-normalization (the supersession half): `cledger renormalize` (library
`renormalize()`, in `renormalize.ts`) turns a preserved line the current
adapter can now interpret into the `conversation_turn` it should have been.
For each `unrecognized` event it routes by `producer.source` to that adapter's
`renormalizeUnrecognized`, which re-feeds the stored `raw.data` through the
*same* `convertLine` the live capture loop uses, with the same identity-
determining inputs recovered from the preserved event: `conversation.seq`,
the session id (in `raw.data` for Claude Code, in `producer.session_id` for
Codex), and — for a Codex line with no timestamp of its own — `occurred_at` as
the `baseTime` fallback (which is exactly the `sessionBaseTime` value a live
capture would compute). The turn therefore gets the byte-identical id a live
capture of the same line would, so a later live capture dedups against it
instead of duplicating — the property the whole scheme rests on. When the
adapter still cannot interpret the line (`convertLine` returns null, e.g. a
timestampless Claude line, or a genuinely unknown type) it stays preserved.

The rewrite is append-only and idempotent: the `unrecognized` event is never
deleted but superseded by a `supersession` event carrying
`links:[{rel:"supersedes",target}]` (mirroring how `cledger redact` records a
rewrite via a companion event). Re-runs are no-ops — already-superseded events
are skipped, and every produced id (turn and supersession) is deterministic,
so anything that slips through dedups on append. The reconstructed turn's
`raw.data` is the already-redacted stored copy and rides the normal
`appendEvents` redaction path, which is idempotent on placeholdered text, so
nothing is re-exposed and the recomputed id is stable. Encrypted/opaque
`reasoning` payloads can never reach this path (they are never preserved) and
`convertLine` refuses them regardless, so re-normalization never reconstructs
provider-withheld content. What does not exist yet: running this automatically
on capture when an adapter/version bump is detected — it is a manual command
for now (see the format-drift roadmap item).

## Open questions

- Path-based capture exclusion (the path half of layer D): requires
  correlating tool_use file paths with their tool_result events.
- Post-push purge tooling (force-push the notes ref + collaborator
  re-fetch coordination).
- Transport currently wires `origin` only; fork workflows (per-remote
  staging refs, refspecs on other remotes) are unhandled — the pre-push
  hook does push to whichever remote is being pushed, but fetch staging is
  origin-scoped.
- Sub-turn citation anchors for downstream consumers (intent-recall).
- Re-anchoring after squash merges and history rewrites — ideally default
  behavior (squash commit inherits its branch's conversations), which
  requires detecting remote squashes (e.g. GitHub merges) via patch-id or
  branch-tip matching after fetch.
- Whether to preserve non-git-controlled harness artifacts that die with a
  worktree (agent memory directories, session state) as `document` events.
- Whether an explicit `Conversation` manifest object earns its keep once
  multiple producers exist.
