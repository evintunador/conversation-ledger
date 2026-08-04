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
  `producer.tool/version`) is excluded, as is agent provenance
  (`producer.model/provider/source_version`, for the reason given under
  "Agent provenance"), so re-scanning the same source
  material always yields the same id: capture is idempotent by construction,
  and the id doubles as the content hash that makes mutation detectable.
- `schema` version (`conversation-ledger/v1`);
- `kind`: `conversation_turn`, `decision`, `document`, `annotation`,
  `redaction`, `supersession`, `re_anchor`, `unrecognized`, `reasoning`, or
  one of the four session-machinery kinds `session_state` / `activity` /
  `context_injection` / `file_snapshot` — an open string; unknown kinds are
  stored verbatim so downstream tools can extend without a schema release;
- `occurred_at` (from the source) and `recorded_at` (at append) timestamps;
- `actor` (human/agent/system + identity) and `producer` (capture tool,
  source system, native session id, and the agent that served the turn —
  `model`, `provider`, `source_version`; see "Agent provenance" below)
  provenance; adapters stamp human turns
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

### Agent provenance

`producer.source` says which capture path recorded an event; it does not say
what *produced* it. Three optional `producer` fields close that gap (0.12.0+):
`model` (verbatim as the source names it, e.g. `gpt-5.6-sol`,
`claude-opus-5`), `provider` (the inference provider, e.g. `openai`), and
`source_version` (the coding CLI's own version — distinct from `version`,
which is cledger's). `cledger log --model M` filters on the first, and
`cledger conversations` lists the models each conversation used.

Only what the source states is recorded. Nothing is inferred: `provider` is
left unset for claude-code because the transcript never names one and the
same CLI can be pointed at the first-party API, Bedrock, or Vertex; a model
is never carried onto a turn the source did not label, so claude-code user
turns have no `model` (the model that will answer a prompt is not knowable
from the prompt's own line, and the session's model can change mid-run).
Claude Code's `"<synthetic>"` model placeholder passes through verbatim
rather than being normalized away — "no model produced this" is itself a
fact worth keeping.

The two adapters state these facts in structurally different places, and the
codex shape drives the implementation. Claude Code stamps every transcript
line with the CLI version and labels assistant lines with a model, so its
adapter reads each line in isolation. Codex instead states them out of band:
`session_meta` (once) carries `cli_version` and `model_provider`,
`turn_context` carries `model` and is re-emitted whenever the user switches
model or effort mid-session. Two consequences fall out. First, a
cursor-resumed capture starts mid-file and would never re-read those lines,
so the codex adapter re-scans the prefix before the cursor to rebuild the
context in force (cheap: the file is already in memory, and a substring
guard skips parsing all but a handful of lines). Second, `turn_context` is
written *after* the turn's opening messages in real rollouts, so a
strictly-forward rule would leave the first user message of every session
unlabelled; fields still unset after the prefix scan are therefore seeded
from the earliest line stating them anywhere ahead. That is not a guess —
the first stated context is by construction the first turn's, and the only
items preceding it belong to that same turn. Seeding fills gaps only, so a
genuine mid-session model switch still applies forward and never
retroactively.

These fields are deliberately **excluded from the event identity subset**,
even though they are source-determined and stable per line. They were added
after events had already been captured without them, so folding them into
the id would give the very same transcript line a different id before and
after the upgrade, and a rescan would duplicate every pre-upgrade turn
rather than dedup it. Identity answers "which piece of source material is
this"; the model that served it is provenance about that material, not a
second copy of it.

Population is forward-only, and there is no backfill command. Editing
`producer` on stored events would not change their ids (it is outside the
identity subset), but it would change their serialized note lines — and
under `cat_sort_uniq` the rewritten line and the original would both survive
any merge with a peer that still holds the old one, leaving two copies of
one event. Old claude-code events lose nothing permanent (the CLI version
and model are still in their `raw.data`, since the whole line is preserved);
old codex events do lose it, because the facts lived on `session_meta` /
`turn_context` lines that were never stored. Re-capturing an old codex
session does not fix that either — the events dedup by id, so the existing
unlabelled copies stand.

Scanning is unaffected: `cledger scan` and capture-tier redaction walk
`content` and `raw.data` only, so model ids and version strings are not
pattern-matched. They are provider-published identifiers, not user content.

Reasoning policy: record model reasoning when the provider exposes it
(Claude Code's thinking text is kept, minus opaque signatures). When the
provider instead withholds it behind ciphertext (Codex's `reasoning`
response_items carry `encrypted_content`), the ledger still never
interprets or attempts to reconstruct it, but does preserve the ciphertext
losslessly, opaquely: a `reasoning`-kind event (0.10.0+) whose `content` is
only an opacity marker and whose `raw.data` is the full source line, so a
consumer that can decrypt it (only the originating provider, by replaying
the blob back through its own API) may do so later. `reasoning` events are
hidden from `cledger log`/`show`/`conversations` by default
(`--with-reasoning` reveals them) but included in `cledger export` like
everything else, and ride the ledger's normal sync — no special carve-out.
A `reasoning` item's `summary` field, when the provider populates it (real,
already-decrypted plaintext, distinct from `encrypted_content`), is split
out into an ordinary visible `conversation_turn` at the same `conversation.seq`
rather than swept into the opaque event, so it is captured and redacted
exactly like any other visible content. Capture-tier redaction and
`cledger scan` both carry a narrow, field-specific exemption
(`encrypted_content` only, gated on `kind === "reasoning"`) so pattern
matching never mangles the ciphertext — every other field, including
`summary`, is scanned normally. The same non-reconstruction rule applies to
other otherwise-visible content: Codex `agent_message` items (inter-agent
messages) convert with their visible text blocks kept and their
`encrypted_content` blocks dropped from both `content` and `raw` (not yet
preserved opaquely the way standalone `reasoning` items are — a deferred
follow-up), leaving a bare type marker so the omission is visible.

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

### Push scope

Three layers each need a granularity, and until 0.14.0 one of them disagreed:
storage is per-commit (one note per anchor), reads are per-branch (reachability
from a rev), and push was per-*ref* — meaning per-repo, since a ref carries the
whole database. Pushing any branch therefore shipped every branch's
conversations, including branches abandoned and never merged.

Push is now scoped to exactly the anchors a read at that rev resolves to, so
what you can see from a branch is what pushing that branch shares. Nothing
about storage changed. No branch→commit mapping is persisted: reachability is
recomputed from the DAG at push time, for the same reason reads never stored
it — branch membership is derived, and a stored copy would need maintaining
through every merge, rebase, rename and delete.

Two implementation details carry the correctness:

- **The scope resolves `re_anchor` mappings**, by reusing the same
  `resolveAnchors` reads use rather than a bare `git rev-list`. A squash merge
  discards the source branch's commits, leaving its conversations on anchors
  unreachable from the target; only the mapping events — anchored to the
  surviving commit — tie them back. A rev-list-only scope would push the
  mappings and strand the events they reference, losing precisely what
  re-anchoring exists to recover.
- **A scoped push adds to the remote rather than replacing it.** A notes ref
  is a snapshot of the whole database, not an append log: whatever tree you
  push becomes the remote's entire notes database. Filtering the local ref
  down to one branch and pushing it still fast-forwards, and silently deletes
  every other branch's notes from the remote's current view — present in the
  ref's history, absent from `git notes show` and from any fresh clone. So the
  push seeds a temp ref from the remote's tip, unions the scope's notes into
  it (line-level sort+unique, matching `cat_sort_uniq`), and pushes that.

The pre-push scan gate inspects only the events in scope, so a finding on a
branch that is not being pushed no longer blocks unrelated work.

The scope comes from the refs git is actually pushing, read from the pre-push
hook's stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line);
the local sha is used directly, since it is what git is pushing and needs no
resolution. Ref deletions carry an all-zero local sha and are skipped, several
refs union, and anything unusable — an old installed hook, a manual
invocation — falls back to `HEAD` rather than widening to the whole ledger.
`cledger transport-push` only reads stdin when it is not a TTY, so running it
by hand cannot block waiting on input.

Consuming that stdin has a cost: a pre-push script's stdin can be read only
once, so anything chained *after* cledger's block finds it exhausted. This is
nearly always harmless, because the block is appended to the end of an
existing hook — an existing script runs, and drains stdin, first. When it
does, cledger's read comes back empty and the scope falls back to `HEAD`,
which is the pre-0.15.0 behavior rather than a failure. Restoring stdin for
content hand-edited in after the block would mean spilling it to a temp file
and `exec`-ing it back onto fd 0, which is more machinery in every user's
hook than that case earns.

Because the hook script itself had to change, `installHook` no longer treats
"file contains the marker" as "nothing to do": it replaces a stale cledger
block with the current one, touching only the marked region so surrounding
user content is preserved. Without that, a behavior change inside the hook
would only ever reach freshly-initialized repos.

Events captured before the first commit exists (unborn `HEAD`) queue in
`.git/conversation-ledger/pending.jsonl` and flush into the first real
anchor. Everything under `.git/conversation-ledger/` (pending queue, adapter
cursors, lock) is local, rebuildable state — never the record of truth.

That directory is resolved from the repository's **common** git dir
(`RepoInfo.commonDir`), not the working tree's own (`RepoInfo.gitDir`). The
distinction only appears with linked worktrees, where git gives each working
tree a private directory at `<main>/.git/worktrees/<name>/` for genuinely
per-worktree state (HEAD, index, reflogs) while refs, objects, config, and
hooks stay shared. Nothing cledger keeps is per-worktree: an allowlist entry,
a learned secret, or a capture cursor means the same thing from every working
tree, and hooks *must* live in the common dir because that is the only place
git looks for them. Before 0.13.0 all of it hung off the per-worktree dir, so
a worktree silently behaved like a separate repo. Placement of the worktree
is irrelevant — git draws no distinction between one nested under the repo
and one at an arbitrary path. `.cledger.json` is the deliberate exception: it
is a tracked working-tree file, so it is per-worktree unless committed, which
is the right behavior for versioned repo config.

Reads collapse events sharing an id (0.13.0). Append-time dedup only consults
the note of the commit being written to, so it cannot see a copy filed under
a different anchor: any capture that re-reads transcript lines it already
ingested *after* `HEAD` moved files a second copy against the new `HEAD`, and
once both anchors are reachable the turn came back twice. Per-worktree
cursors made this routine, but a forced rescan does it too. Since the ledger
is append-only those copies are permanent, so the fix is on the read side —
earliest `recorded_at` wins, canonical serialization breaks ties, so every
clone independently picks the same copy. Ids are equal only when every
identity field is equal, so an ordinary duplicate differs solely in
provenance the id already excludes (`recorded_at`, `context`, `raw`).

One collision is not an ordinary duplicate and is resolved *before* either of
those keys: a redacted event and its pre-redaction original. Those share an
id deliberately (`redactEvent` pins it, so a later rescan of the untouched
source material dedups against the rewrite instead of resurrecting the
secret), which makes them the only way one id can carry two different
`content` values. They also share `recorded_at`, because the rewrite spreads
the original — so both ordering keys tied and the decision fell to the
canonical-JSON byte compare, which resolves on the first differing character:
the secret's own first byte against the `[` (0x5B) that opens a
`[REDACTED:…]` placeholder. Every secret beginning with a digit or an
uppercase letter sorts below `[` and won, so reads surfaced the plaintext,
printed alongside the `redaction` event asserting its removal. Redaction
depth is therefore consulted first — among copies sharing an id, the one
carrying more `redactions` records is the more scrubbed and wins outright.
This is unambiguous rather than heuristic: capture-time redaction runs
*before* ids are computed, so differently-scrubbed captures get different ids
and never collide here, leaving `redactEvent` as the sole producer of
same-id/different-content pairs, and it always appends at least one record.

### Squash merges and history rewrites: re-anchoring

A squash merge (or any rewrite) discards the source branch's commits, so
their conversations remain in the ledger (notes are enumerable regardless of
reachability; `cledger log --all` sees them) but would drop out of the target
branch's reachability view. Re-anchoring (0.8.0) repairs this with the same
append-plus-companion-event shape redaction uses — the union merge would
resurrect any note line a "move" deleted, and the original anchor is honest
provenance, so notes are never moved:

- A `re_anchor` event asserts `{superseded: [SHAs], successor: SHA, method,
  branch?}`. It is anchored to the successor commit, so it rides the
  surviving branch's DAG and is discoverable exactly when the successor is
  in view. Its identity is deterministic — sorted SHAs, `system` actor, the
  successor's committer timestamp as `occurred_at` — so independent
  detection on two machines dedups to a single event.
- Read-time reachability resolves mappings to a fixpoint: an anchor counts
  as reachable when the rev reaches it or a mapping whose successor is
  reachable names it, transitively (a squash commit itself later squashed
  still resolves). A mapping whose successor is not in view changes nothing.
- Detection runs lazily inside every read, right after `absorbIncoming`,
  gated on a cursor over the remote default branch's tip (origin/HEAD, else
  the current branch's upstream) so the pass only runs when the target
  moved, and it never throws. For each local branch no longer reachable
  from the target: tree equality catches a squash of an unmoved target;
  `git patch-id --stable` over zero-context diffs (cumulative for squashes,
  per-commit for rebase/bot rewrites) catches the rest. Only exact matches
  auto-apply; a fingerprint matching two target commits is reported as
  ambiguous, never guessed — misattribution is worse than orphaning.
  Branches with no noted commits are skipped (mappings rescue
  conversations; they do not catalog merges). `{"reanchor": {"auto":
  false}}` opts out.
- `cledger re-anchor` is the explicit path: dry-run by default, `--apply`,
  and `--onto` for what matching cannot assert (maintainer-edited squashes,
  deleted branches, ambiguity) — those mappings carry the asserting user as
  actor, and accept full 40-hex superseded SHAs verbatim since the commit
  objects may already be GC'd while their notes live on. Since 0.9.0 the
  inexact cases come with evidence-ranked suggestions (forge merge-commit
  assertion, message corroboration, per-file overlap — see Open questions)
  feeding that confirm flow.

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
  a human — they never rewrite anything.

  **Reports carry coordinates, never content** (0.16.0). Findings print
  event id, rule, JSON path + offset, and fingerprint; no excerpt. Masking
  only the matched span was not enough: the *context* around a match is what
  tripped the rule in the first place — a `keyword-assignment` excerpt
  necessarily reprints the keyword that anchored it — so a report captured
  into a later conversation re-seeded a finding on the report itself, and
  each scan compounded the last. Observed while dogfooding turnbridge: one
  discussion of GitHub Actions code multiplied into repeat findings that
  `cledger allow` could not durably clear, because every new report minted a
  new event to flag. An event id and a JSON path match no secret rule, so
  they stay safe to reprint indefinitely.

  Readable output moved to `cledger inspect <event-id>`, which renders wide
  surrounding context (default 400 chars each side, `--context N`), masks the
  match unless `--reveal`, writes to a mode-0600 file outside the repo rather
  than stdout, and **refuses to run inside a coding-agent session** (detected
  via the harnesses' own env markers; `--force` overrides). That last guard is
  the load-bearing one: an agent asked to investigate a blocked sync will
  otherwise do the helpful, wrong thing and read the secret straight into the
  record being protected. Reports therefore address humans and agents
  separately, and tell the agent to stop rather than merely warning it.
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
  matching) but under `.git/` and written `0600`, exactly as local-and-unshared
  as the transcripts the values came from — consistent with the transport
  boundary. Off by default: the store is never read or created unless the flag
  is set. Note the interaction with the id-preservation rule below: once a
  value is remembered, re-capturing a source line containing it yields
  *scrubbed* content and therefore a different id, so it no longer dedups
  against the redacted original — a second scrubbed copy, not a resurrected
  secret. Id churn is the accepted cost, identical to C.

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
then severs the local notes ref's commit chain so the prior blob is
unreachable from the ref (when `knownSecrets` is on, a `--pattern` redaction
also feeds the F store; see above).

**Redaction is a pre-push operation, and the command enforces it.** It
refuses, before mutating anything, when the target event is already on
`origin` — or when `origin` cannot be reached to rule that out, since a
security decision resting on a failed network call must fail closed. The
reasoning is structural rather than a matter of effort: a notes ref carries
its own commit chain, so every prior note body travels to every clone and is
recoverable with a plain `git log -p refs/notes/conversation-ledger`; and
`cat_sort_uniq` unions *lines*, so a rewritten line never displaces the
original anywhere that still holds it. Worst of all, `pushScopedNotes` seeds
from the remote's tip and unions the local scope into it, so redact-then-push
actively *re-uploads* the pre-redaction line alongside the rewrite, leaving
both on the remote permanently. The command previously warned about this and
proceeded regardless, reporting partial success while making the situation
strictly worse. Gating is per *event* (the remote's ledger ref is queried for
the ids it actually holds), so routine pushing does not disable redaction for
anything captured afterwards. Post-push purge — notes-ref history rewrite,
force-push, coordinated collaborator re-fetch — is deliberately separate,
deferred, destructive tooling; until it exists, rotating the credential is
the honest remedy for anything that has left the machine.

Severing the chain is not an object purge, and the output no longer implies
otherwise. `update-ref` leaves reflog entries pointing at the discarded
commits, so the pre-redaction blob survives in the local object store until
`git reflog expire` plus a pruning `gc`. That residue is local-only — git
transfers neither reflogs nor unreachable objects — so it never reaches a
remote and sits squarely inside the "trust boundary is transport" model. The
command reports what it did, what remains, and the command that clears it,
rather than running a repo-wide destructive `gc` on the user's behalf.

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

Drift detection and raw preservation: adapters are tolerant parsers. Each
routes a parsed line to one of three places: a conversational kind, one of the
session-machinery kinds (`session_state`, `activity`, `context_injection`,
`file_snapshot` — see "Session machinery" below), or, when no mapping exists,
*unrecognized*. The old fourth place, a known-skipped list of line types that
were parsed and thrown away, is gone except for codex's two `event_msg`
payload types that genuinely duplicate a `response_item`; keeping a skip list
meant a type had to be *both* known and worthless, and almost nothing was. Each such line is both counted
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
`reasoning` events ride the same path too, with one narrow exception: the
`encrypted_content` field itself is exempt from pattern-matching (see the
reasoning-policy paragraph above) so redaction can never corrupt the
ciphertext this kind exists to preserve. Codex's `reasoning` response_items
are a third case distinct from both convertible and unrecognized lines:
recognized but deliberately opaque, captured as their own `reasoning`-kind
event (see the reasoning-policy paragraph above) rather than falling into
either bucket, and never counted toward the drift warning.

Session machinery: the four kinds beyond the conversational ones cover what a
source records *around* the turns, and exist because discarding it was the
largest remaining source of loss at capture. `session_state` is a declaration
that holds until restated (mode, permission mode, sandbox and approval policy,
model settings, title, worktree relocation); `activity` is a point-in-time
occurrence that is not a turn (hooks, turn durations, token counts, task
lifecycle, queue operations, compaction, step boundaries); `context_injection`
is material the harness put into the model's context that nobody typed; and
`file_snapshot` is intermediate file state between commits. All four use the
same content shape — a `*_type` discriminator naming the source's own type
verbatim, the source's own field names beside it, and `blocks` in the ordinary
`[{type:"text",text}]` form whenever a record carries prose, so text extraction
needs no per-kind special case. They are hidden by `log`/`show`/`conversations`
unless `--with-state` or an explicit `--kind` asks for them, because sources
restate this material far more often than anyone speaks; capture, export and
sync are unaffected.

Two structural consequences. First, `ConversationRef.parent` makes a
sub-conversation expressible: a Claude Code sidechain or an opencode subagent
session becomes its own conversation pointing back at the session that spawned
it, rather than being dropped (opencode child sessions are discoverable only
via the parent's `task` tool part metadata, which is why capture walks them).
It is inside the identity subset like the rest of `ConversationRef`. Second,
`EvidenceEvent.resolved` holds what the ledger read at capture time from
pointers the source only names — currently the sha256 and size of a Claude Code
file-history backup. It is deliberately *outside* the identity subset: the
backing cache is machine-local and prunable, so the same line resolves
differently elsewhere, and folding it into the id would duplicate every
snapshot on a rescan after a prune. It holds derived facts only (digests,
sizes), never file bodies, because the redaction stack walks `content` and
`raw.data` and not this field.

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
nothing is re-exposed and the recomputed id is stable. `reasoning` payloads
never reach this path at all — they are captured directly as their own
`reasoning`-kind event, never as `unrecognized`, and `convertLine` refuses
them regardless — so re-normalization never reconstructs provider-withheld
content into a visible `conversation_turn`. What does not exist yet: running this automatically
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
- Re-anchoring shipped as default behavior in 0.8.0, and its suggestion
  tier in 0.9.0 (see "Squash merges and history rewrites"): unmatched
  branches get evidence-ranked candidates — the forge's own merge-commit
  record for the branch's PR (GitHub driver over the user's `gh` session in
  `src/forge/`, degrading to offline evidence without it), `(#N)` subject
  and squash-message corroboration, per-file patch-id overlap — printed
  with the conversation-carrying commits named and a ready-to-run `--onto`
  command; confirm-only, and forge lookups never run in the auto read path.
  Remaining: the accepted cursor gap, where conversations captured onto an
  already-dead branch only auto-map on the next target move (`cledger
  re-anchor` covers it manually).
- Whether to preserve non-git-controlled harness artifacts that die with a
  worktree (agent memory directories, session state) as `document` events.
- Per-turn agent provenance (`producer.model`/`provider`/`source_version`)
  shipped in 0.12.0; see "Agent provenance". The follow-up — the rest of what
  codex's `session_meta`/`turn_context` lines carry (sandbox/approval policy,
  reasoning effort, workspace roots) — is answered by `session_state`: those
  lines are now recorded whole, in addition to being read for `producer`.
- Whether an explicit `Conversation` manifest object earns its keep once
  multiple producers exist.
- Reads deliberately do *not* walk the notes ref's history; only the tip tree
  is authoritative. Unioning across history was proposed and set aside because
  it defeats redaction: the notes ref's ancestry retains every superseded note
  body, so a history-walking read would surface exactly the pre-redaction
  content. It would also break `git notes show` interop (standard tooling
  reads the tip tree) and make reads O(notes history). Two related weaknesses
  that were open here have since been closed: `dedupById` no longer prefers
  the un-redacted copy (redaction depth now outranks both `recorded_at` and
  the byte tie-break), and `cledger redact` now refuses already-pushed events
  outright instead of skipping the squash and proceeding. What remains by
  design is the local reflog/object residue after a pre-push redaction, which
  never leaves the machine.
- Per-branch *storage* (a notes ref per branch) has been considered and set
  aside, but the question it was reaching for is open. Branch membership is a
  derived property of the commit DAG, not an intrinsic property of a commit:
  one commit is on many branches at once, and merges, rebases, renames,
  cherry-picks and deletions all change the answer without touching the
  commit. Anchoring to commits and computing reachability at read time keeps
  that derivation where git already maintains it; storing it per branch would
  denormalize it and require synchronizing on every one of those operations.
  Squash merge is the decisive case — it deletes the source branch outright,
  so a per-branch ref would take its conversations with it, which is exactly
  the situation re-anchoring exists to survive. The legitimate half of the
  critique is about *distribution*, not storage: see the roadmap entry on
  per-branch remote refs.
