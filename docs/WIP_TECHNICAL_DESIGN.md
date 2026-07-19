# Technical design

**Status:** implemented in v0.1; format may still evolve until v1.

## Scope

Conversation Ledger defines a canonical append-only event format plus a local,
git-backed storage protocol. It preserves exact visible content while staying
out of the working tree and syncing only on explicit request.

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
4. **Clean working tree.** Notes never appear in `git status`; sharing is an
   explicit `cledger sync` (fetch → `git notes merge -s cat_sort_uniq` →
   push) of that single ref, never implicit.

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

Visible tool output can contain secrets. The ledger stays local until an
explicit `sync`; retention and remote-sharing policy belong to the repository
owner. Redaction appends a `redaction` event linking to its target rather
than pretending the original never existed; actually purging content is a
deliberate, separate operation (planned) since note history retains prior
blobs. Content hashes (event ids) make accidental mutation detectable.

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

- Secret-safety at capture time: automatic detection/redaction of API keys,
  tokens, and credentials in tool output before events are written (plus
  path/pattern-based exclusion rules). Tool output is the highest-risk
  content in the ledger and currently stored verbatim.
- Purge tooling for true content removal after redaction.
- Sub-turn citation anchors for downstream consumers (intent-recall).
- Re-anchoring after squash merges and history rewrites — ideally default
  behavior (squash commit inherits its branch's conversations), which
  requires detecting remote squashes (e.g. GitHub merges) via patch-id or
  branch-tip matching after fetch.
- Whether to preserve non-git-controlled harness artifacts that die with a
  worktree (agent memory directories, session state) as `document` events.
- Whether an explicit `Conversation` manifest object earns its keep once
  multiple producers exist.
