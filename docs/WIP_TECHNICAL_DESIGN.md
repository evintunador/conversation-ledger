# Technical design

**Status:** implemented in v0.1; format may still evolve until v1.

## Scope

Conversation Ledger defines a canonical append-only event format plus a local,
git-backed storage protocol. It preserves exact visible content while staying
out of the working tree. Transport of the ledger ref is explicit today
(`cledger sync`); the decided direction is an optional, on-by-default git
pre-push hook plus fetch refspec so records propagate with normal git use
(see open questions).

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
  with the repo's `git config user.email`/`user.name` (`actor.id`/`.display`)
  so multi-user clients can filter by author. Because `actor.id` is part of
  the event identity subset, sessions captured before this stamping existed
  will produce new event ids if fully re-scanned — the per-session cursor
  normally prevents that, but a forced rescan can duplicate pre-identity
  turns;
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
are skipped, not stored, and never reconstructed).

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
4. **Clean working tree.** Notes never appear in `git status`; sharing is a
   `cledger sync` (fetch → `git notes merge -s cat_sort_uniq` → push) of
   that single ref — explicit-only today, with an optional on-by-default
   pre-push hook planned so it rides normal `git push` (still
   user-disableable; the E scan gates it either way).

Events captured before the first commit exists (unborn `HEAD`) queue in
`.git/conversation-ledger/pending.jsonl` and flush into the first real
anchor. Everything under `.git/conversation-ledger/` (pending queue, adapter
cursors, lock) is local, rebuildable state — never the record of truth.

### Known limitation: squash merges

A squash merge discards the source branch's commits, so their conversations
remain in the ledger (notes are enumerable regardless of reachability;
`cledger log --all` sees them) but drop out of the target branch's
reachability view. A future `re-anchor` operation is the intended fix.

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
  a human — they never rewrite anything.

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
honest history without secret retention. Post-push purge (force-push +
collaborator coordination) is deliberately separate, deferred tooling.

## Versioning against harness format changes

Three layers exist today:

1. `schema` on every event (`conversation-ledger/v1`) versions the ledger's
   own envelope.
2. `raw.format` (`claude-code-jsonl/1`, `codex-rollout-jsonl/1`) versions
   each adapter's interpretation of its native format; it must be bumped
   whenever the mapping changes, allowing later reprocessing to know which
   parser produced an event.
3. The native payload inside `raw.data` retains the harness's own version
   markers (Claude Code lines carry `version`; Codex `session_meta` carries
   `cli_version`), so captured content can always be re-normalized under a
   newer mapping without recapture.

What does not exist yet: drift detection. Adapters are tolerant parsers that
skip unrecognized line types, which handles additive upstream changes
gracefully but means a genuinely new message type is dropped entirely (raw
included — only converted lines are stored). See the format-drift roadmap
item.

## Open questions

- Transport hooks (decided, unbuilt): optional-but-default-on `pre-push`
  git hook running the sync push (with the E gate), and a staged fetch
  refspec (`+refs/notes/conversation-ledger:refs/notes/cledger-incoming`)
  merged lazily at read time — never force-overwriting the local ref.
  Amends the "sharing is explicit" commitment here and in Turnbridge's
  product intent.
- Path-based capture exclusion (the path half of layer D): requires
  correlating tool_use file paths with their tool_result events.
- Post-push purge tooling (force-push the notes ref + collaborator
  re-fetch coordination).
- Sub-turn citation anchors for downstream consumers (intent-recall).
- Re-anchoring after squash merges and history rewrites — ideally default
  behavior (squash commit inherits its branch's conversations), which
  requires detecting remote squashes (e.g. GitHub merges) via patch-id or
  branch-tip matching after fetch.
- Whether to preserve non-git-controlled harness artifacts that die with a
  worktree (agent memory directories, session state) as `document` events.
- Whether an explicit `Conversation` manifest object earns its keep once
  multiple producers exist.
