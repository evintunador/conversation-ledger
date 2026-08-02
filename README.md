# Conversation Ledger

Durable, attributable records of visible coding-agent conversations, stored in
your repository as git notes.

`cledger` (also installed as `conversation-ledger`) is a small standalone
utility in the unix tradition: it appends immutable JSONL evidence events to
`refs/notes/conversation-ledger`, anchored to the commit you were on when the
conversation happened. Records ride the commit DAG — merge a branch and its
conversations come along, and squash-merged branches are re-anchored onto the
squash commit — never touch your working tree or `git status`, and
ride your normal `git push`/`git fetch` via an auto-installed, scan-gated
pre-push hook and fetch refspec (or explicitly, via `cledger sync`).

Conversation Ledger is the neutral foundation of a small ecosystem:

- `conversation-ledger` stores normalized, provenance-preserving conversation evidence.
- `turnbridge` records and transfers visible conversations between coding CLIs.
- `intent-recall` later retrieves evidence to help agents reason about original and superseded intent.

The ledger itself never summarizes, ranks, or interprets. It stores what was
visibly said, by whom, against which commit — nothing more.

## Install

```sh
git clone https://github.com/evintunador/conversation-ledger
cd conversation-ledger && npm install && npm link   # npm publish coming later
cledger install all    # hook capture into Claude Code + Codex CLI + opencode
```

`cledger install` adds `Stop`/`SessionEnd` hooks to `~/.claude/settings.json`,
a `Stop` hook (plus `features.hooks = true`) to `~/.codex/config.toml`, and a
`session.idle` plugin at `~/.config/opencode/plugin/cledger.js`, backing each
up first. From then on, every completed turn in any git
repository is captured automatically, in the same universal format. Capture is
idempotent — events are content-derived, so re-scanning a transcript never
duplicates.

Two one-time activation notes: Claude Code reads hooks at session start, so
capture begins with your next session; Codex requires you to trust new hooks
interactively — open `codex`, run `/hooks`, and approve the `cledger hook
codex` command once. Missed turns are never lost either way: `cledger capture
<source> --transcript PATH` backfills any native transcript, idempotently
(for opencode, which has no transcript file, use `cledger capture opencode
--all` or `--session <id>`).

The hooks above are installed once, globally, and fire in every git
repository you work in. To turn cledger off for one specific repo, add
`{"enabled": false}` to that repo's `.cledger.json`: hook capture, manual
`cledger append`, and backfill all become no-ops, before any ledger read or
write happens. Existing history is untouched and still readable via
`cledger log`/`show`/`export` — this only stops new events from being
written. Outside any git repository, hooks are already a silent no-op, so
there's nothing to record and nothing to disable.

## Use

```sh
cledger log                     # events on the current branch (via commit reachability)
cledger log --all --json        # every event, as JSONL for jq & friends
cledger log --model gpt-5.6-sol # only turns a given model served
cledger conversations           # sessions touching this branch, with the models they used
cledger show claude-code:3f9a   # replay one conversation in order
cledger export > ledger.jsonl   # lossless dump, incl. source-native payloads
cledger sync                    # explicit fetch/merge/push of the ledger ref
cledger re-anchor               # what did the remote squash away? (--apply to map it)
echo '{"kind":"decision",...}' | cledger append   # any tool can write events
```

## Sharing (transport)

The ledger travels with normal git use, no extra commands:

- **Push**: the first capture in a repo installs a `pre-push` hook (chaining
  safely onto any existing shell hook; backing off with a warning when
  `core.hooksPath`/husky owns the hooks). On `git push` it pushes the ledger
  ref alongside, gated by the secret scan. A finding holds back **only the
  ledger** — your code push proceeds — unless you opt into
  `{"transport": {"strict": true}}`, which aborts the whole push.
- **Push is branch-scoped** (0.14.0): only conversations reachable from the
  refs you're pushing are shared, so an abandoned or unmerged branch's
  conversations stay on your machine. Squash-merged work still rides along —
  the scope follows `re_anchor` mappings the same way reads do.
  `cledger sync --all` pushes the whole ledger; `--rev R` scopes elsewhere.
- **Fetch**: the same first capture adds a fetch refspec on `origin`, so
  `git fetch`/`git pull` stages teammates' events; any read command
  (`cledger log`, `show`, ...) folds them in via the conflict-free
  `cat_sort_uniq` union. The local ref is never force-overwritten.
- **Opting out**: `{"transport": {"hook": false, "fetchRefspec": false}}` in
  `.cledger.json` or `~/.config/cledger/config.json`, or just delete the
  marked block from `.git/hooks/pre-push`. `cledger sync` always works
  explicitly either way.

If git has no author identity configured (`user.email` unset), human turns
are recorded unattributed; `cledger install` warns about this. cledger uses
the same identity a commit would be authored under (config or environment)
and never guesses a hostname-based one.

## Squash merges & history rewrites (re-anchoring)

Events anchor to commits, and forges rewrite commits: a GitHub "Squash and
merge" (or "Rebase and merge", or a bot amending your push) replaces your
branch's commits with new SHAs, which would orphan their conversations from
the default branch's view. cledger repairs this automatically:

- After a fetch shows the remote default branch moved, any read compares
  your local branches against it. A branch whose changes match a new commit
  exactly — same tree, or same `git patch-id` fingerprint (squashes as one
  cumulative diff, rebases commit-by-commit) — gets a `re_anchor` mapping
  event, anchored to the surviving commit. `cledger log` then shows the
  branch's conversations as part of the squash commit's history. Notes are
  never moved or rewritten; the mapping is an ordinary append-only event,
  and the original anchor stays in the record as provenance.
- Only exact matches auto-apply. If a maintainer edited during the merge or
  the change matches two commits, nothing is guessed: `cledger re-anchor`
  (dry-run by default, `--apply` to act) presents evidence-ranked
  candidates instead — GitHub's own record of the branch's PR and its
  squash commit (queried through your existing `gh` session; cledger never
  touches credentials), `(#N)` subject and squash-message corroboration,
  and per-file content matches — each with its evidence spelled out, the
  conversation-carrying commits named, and a ready-to-run
  `cledger re-anchor <old-rev...> --onto REV` command that records the
  mapping with you as the actor. Old SHAs are accepted even after the
  commits themselves are garbage-collected. Forge lookups run only in this
  explicit command (never the auto read path) and degrade to offline
  evidence without `gh`; `--no-forge` or `{"reanchor": {"forge": false}}`
  turns them off.
- Opt out with `{"reanchor": {"auto": false}}`; the explicit command keeps
  working either way.

## Adapters

Supported today (built-in, per-turn, triggered by the CLI's own hook or
plugin mechanism):

Every captured event records the agent that served it — `producer.model`,
`producer.provider`, `producer.source_version` — but only where the source
states it; see the Roadmap entry below for what each adapter does and does
not know.

| Source | Trigger | Transcript store | Notes |
|---|---|---|---|
| Claude Code CLI | `Stop`/`SessionEnd` hooks | `~/.claude/projects/*/*.jsonl` | Also covers the VS Code extension and JetBrains plugin (both share `~/.claude/settings.json` hooks and transcripts), and desktop-app local/SSH/WSL sessions. Cloud "Remote" sessions and the Cowork tab run server-side — not captured. |
| Codex CLI | `[[hooks.Stop]]` hooks engine | `~/.codex/sessions/**/rollout-*.jsonl` | Same config + session store is shared by the Codex desktop app and IDE extension, so their local sessions should capture too — but OpenAI has open bugs on the desktop app's config loading, and third-party reports say hooks may not fire from IDE sessions. Treat non-CLI surfaces as best-effort; `cledger capture codex` backfills any rollout file regardless of which surface wrote it. Cloud tasks run server-side — not captured. Provider-encrypted `reasoning` items are preserved opaquely as `reasoning`-kind events (hidden from `log`/`show` by default, see Roadmap); inter-agent messages (`agent_message`) are captured with their visible text but their embedded encrypted blocks are still dropped outright. |
| opencode | `session.idle` plugin event | SQLite at `~/.local/share/opencode/opencode.db` | The only adapter without an append-only transcript file. Rather than read opencode's database — whose schema is mid-migration, and which also stores API tokens — capture shells out to `opencode export --pure <id>` and converts its JSON. One event per *part*, not per message: opencode's store is mutable, and a part is the finest unit that stops changing, so a message that gains parts after an early idle appends rather than duplicating. Unlike Codex, `reasoning` parts are plaintext, so they become ordinary visible `thinking` blocks. Unsettled (`running`) tool calls are skipped and hold the cursor back until they finish. Subagent sessions are skipped (see Roadmap). Requires `opencode` on `PATH`; `cledger capture opencode --all` backfills every session opencode scopes to the current project, and `--transcript` reads a saved export. |

TODO adapters, roughly in order of how ledger-friendly their storage/hook
story looks (all have local session stores; most grew Claude-Code-style hook
systems):

- **Gemini CLI** — JSON chats under `~/.gemini/tmp/<hash>/chats/`; documented hooks.
- **Kimi CLI** — `~/.kimi-code/` sessions; Claude-Code-inspired lifecycle hooks.
- **GitHub Copilot CLI** — `~/.copilot/session-state/`; documented hooks dirs.
- **Factory droid** — `~/.factory/` sessions; `hooks.json`.
- **Qwen Code** — `~/.qwen/projects/*/chats/`; hooks system.
- **Cursor (`cursor-agent` CLI)** — `~/.cursor/chats`; hooks exist, but IDE-side chats live in editor-internal storage.
- **aider** — plain `.aider.chat.history.md`; no hook mechanism found, would need file watching.
- **Goose / Amp** — SQLite store / cloud-synced threads; hook stories unclear or absent.

## Security & redaction

Visible tool output can contain secrets: API keys in error messages, credentials in logs, etc. The trust boundary is transport — native transcripts are plaintext locally, so redaction protects the *shared* record, not the local disk. Once content reaches a note, removal is expensive, so prevention runs first at capture, with the last checkpoint at sync.

### Redaction layers

**Capture-time redaction** (default on): Replaces prefixed tokens (`ghp_…`, `sk-ant-…`, `AKIA…`, `xox…-`, `AIza…`, `glpat-…`, `npm_…`, `sk_live_…`), PEM private keys, JWTs with `[REDACTED:<rule-id>:<fingerprint>]`. Conservative, near-zero false-positive ruleset applied before event ids are computed.
- Threat addressed: API tokens and private keys in tool output land in shared history.
- Cost of disabling: `.cledger.json` `{"redact": {"capture": false}}` — every secret lands verbatim.

**Custom patterns**: Extend capture rules via `{"redact": {"patterns": [{"id": "my-rule", "pattern": "..."}]}}` in `~/.config/cledger/config.json` (global) or `<repo>/.cledger.json` (repo wins).
- Threat addressed: domain-specific secrets unmatched by standard rules.
- Cost: manual configuration required.

**Env-value masking** (opt-in, default off): Scrub exact values of environment variables and `.env` entries via `{"redact": {"env": true}}`.
- Threat addressed: unstructured secrets in local config.
- Cost of enabling: `.env` plain-config values get masked too; machine-dependent (rescans produce duplicate events with different ids).

**Known-secret learning** (opt-in, default off): Remember the exact values a `cledger redact <event-id> --pattern` scrubbed, then exact-match them out of every future capture (under a `known-secret` rule id). Enable with `{"redact": {"knownSecrets": true}}`. Confirmed values are stored locally under `.git/conversation-ledger/known-secrets.json`, written owner-only (`0600`) — never tracked or pushed by git, the same tier as the allowlist. Only `--pattern` feeds it; values under 8 chars are never remembered.
- Threat addressed: the capture/scan feedback loop — a value the broad sync scan catches but the conservative capture tier misses gets re-ingested raw every time you revisit it while fixing it. Once redacted, capture learns it and it can never be re-captured raw again.
- Cost of enabling: confirmed secret plaintext lives in a new (local, unshared) file; like env masking, capture becomes machine-dependent for those values. Concretely, re-capturing a source line whose value is now remembered yields *scrubbed* content and therefore a different event id, so it no longer dedups against the pre-existing event — you get a second, also-scrubbed copy rather than a resurrected secret. Id churn, not leakage.

**Sync-time scan** (default on, tiered): Before any push, scans only new events with medium/high-precision rules (capture ruleset re-run, keyword assignments like `password=`, URL credentials). Findings abort the ledger push with a report and remediation instructions; the report shows ~20 chars of surrounding context with the matched value **fully masked** (`<redacted>`, zero secret characters) so the report itself can't re-seed the next scan. In the pre-push hook, a finding holds back only the ledger and lets your code push proceed unless `{"transport": {"strict": true}}`.
- Threat addressed: secrets from older capture rules or new tool formats slipping through.
- Cost of disabling: `{"scan": {"tier": "off"}}` — secrets in tool output push silently.
- Remediation paths: `cledger redact <event-id>` (real secrets), `cledger allow <fingerprint>` (false positives), `cledger sync --no-scan` (bypass once). `--paranoid` tier adds entropy-based detection (noisier but broader).

### Commands

`cledger redact <event-id> (--pattern REGEX | --all) [--reason TEXT]`: Rewrites stored event to placeholder + audit metadata, appends a `redaction` event, and squashes local notes history so prior content is unrecoverable (pre-push only; post-push purge tooling is planned, not yet built).

`cledger scan [--paranoid]`: Standalone check with exit 1 on findings — CI-friendly.

### Maximum safety recipe

Keep all defaults (capture and sync scan on), add repo-specific patterns in `.cledger.json` for domain-specific secrets, enable env masking only if `.env` holds secrets (not config), run `cledger scan` in CI, and treat `--no-scan` as a deliberate exception you document.

## Roadmap

- **Subagent sessions are dropped by every adapter** — each adapter skips the
  conversations its coding CLI spawns for subagents: claude-code ignores
  `isSidechain` lines, opencode skips sessions with a `parentID`, and codex's
  inter-agent traffic is only partly captured. What survives is whatever the
  parent's tool-call event recorded as the subagent's *final output*; the
  reasoning and tool calls that produced it are lost. That is often the more
  interesting half — a subagent that read twenty files to answer one question
  leaves no trace of which twenty. The blocker is not per-adapter plumbing but
  a schema question that has to be answered once for all of them: a subagent
  conversation needs an expressible relation to the parent turn that spawned
  it (a `links` rel like `spawned_by`, or a `conversation.parent` field), and
  a decision about whether `cledger log` shows those turns inline, nested, or
  only on request. Ledger volume roughly multiplies with subagent-heavy
  workflows, so the display default matters as much as the capture. Do the
  schema and display design first, then turn all three adapters on together.
- **opencode capture is positional over a mutable store** — the other two
  adapters read append-only transcript files, so `conversation.seq` (the
  source line index) is stable forever and event ids never churn. opencode
  keeps sessions in SQLite, where `session revert`, `message.removed` and
  `part.removed` can delete parts out of the middle of a session. Deleting a
  part shifts the positions of everything after it, and since `seq` is part of
  event identity, the shifted parts re-capture under new ids — duplicates in
  the ledger rather than lost or corrupted content, and only for sessions you
  actually revert. Capturing per *part* rather than per message already keeps
  the blast radius to the parts after the deletion. A real fix would derive
  `seq` from opencode's own part ids instead of a running index, which needs
  those ids to be reliably orderable; worth confirming before committing to
  it. Related: opencode's `session delete` removes a conversation from
  opencode entirely while the ledger keeps it, which is a feature, not a bug.
- **The opencode plugin's `session.idle` payload is read defensively** — the
  installed plugin pulls the session id out of several plausible keys
  (`sessionID`, `sessionId`, `session.id`, `info.id`) because opencode's
  plugin `Event` union is not published in the installed SDK typings and a
  live capture of the event could not be completed during development. When
  none match, the hook falls back to capturing the most recently updated
  session for the directory, which is correct in every realistic case but
  would pick the wrong session if two opencode sessions in one project went
  idle at the same instant. Pin this to the real field once the event shape is
  confirmed against a running opencode, and drop the fallback to a warning.
- **`opencode export` truncates a piped stdout at 64KB** — an upstream Bun
  flush bug: the process exits without draining stdout, so any session over
  ~64KB comes back cut off, and the truncated JSON can still parse. cledger
  works around it by routing the child's stdout to a temp file rather than a
  pipe (see `runOpencode`). Worth reporting upstream; the workaround should
  stay regardless, since it costs nothing and protects older opencode
  versions.
- **Config sections replace rather than merge, and it fails open** — `loadConfig`
  merges `~/.config/cledger/config.json` and `<repo>/.cledger.json` per
  *top-level section*, not per key (`const redact = override.redact ??
  base.redact`). So a repo that commits a `.cledger.json` with *any* `redact`
  key — a `patterns` list, say — silently replaces the user's entire `redact`
  section, and a globally-enabled `redact.knownSecrets: true` reverts to its
  default of `false`. Capture-time scrubbing of learned secret values then
  stops in that repo, with nothing printed and nothing in the ledger to show
  it happened. Same shape as the pre-0.13.0 worktree bug: silent, fails open,
  visible only if you go looking. Fix is a deep merge within each section, or
  at minimum a warning when a repo config overrides a section the user config
  had already set. Worth doing together with a general sweep for this class.

  **Self-referential failures are now this project's characteristic bug
  family**, and are worth a standing check rather than four independent
  fixes. cledger records the work of building cledger, so its own state,
  output, and documentation feed back into its behavior. Known members: the
  capture/scan redaction loop (a finding report re-seeding the finding it
  describes — closed in 0.6.1/0.7.0); the pre-0.13.0 worktree state split
  (0.13.0); this config section-replace; and the allowlist entry below, whose
  *write-up* of a false positive reproduces the false positive in every repo
  whose conversations quote it. Three of the four fail silently, and two fail
  open. A useful tripwire when adding anything that reads cledger's own
  state or prints cledger's own findings: ask what happens when that output
  is itself captured.
- **Don't print findings by default; print a pointer to them** — the cleanest
  structural break in the self-referential loop above. Today `cledger scan`
  and the sync gate print every finding inline, which is exactly the text that
  gets captured into the next conversation and re-seeds the finding. Masking
  the matched span (0.6.1) removed the secret characters but not the
  *surrounding* credential-shaped context, which is what
  `keyword-assignment` trips on — so the loop is narrowed, not closed.
  Proposed: report only the count and how to inspect, with the audience split
  made explicit in the text — a human is told which command reveals the
  findings; an agent is told not to run it, because reading the findings into
  its context is what reproduces them, and to surface the count to its human
  instead. Naming the failure mode in the output is the point: an agent that
  understands *why* will comply, where a bare "don't look" invites a
  workaround. Pairs naturally with the inspection command in the design doc's
  open questions, which already has to write unmasked output to a file rather
  than stdout for the same reason. *Tension to resolve first:* CI reads those
  printed findings, and `cledger scan`'s nonzero exit plus inline report is
  the documented CI integration — so the default likely has to be
  terminal-aware, or CI has to opt in explicitly (`--report`), rather than
  simply going quiet for everyone.
- **Branch-scoped push** *(shipped, 0.14.0)* — reachability filtered *reads*
  (`cledger log`, `show`, `conversations`), but the notes ref is a single ref
  and a ref push sends all of it, so conversations from a branch that was
  abandoned and never merged still reached `origin` and landed on every
  collaborator's disk. Two scopes wearing one name, with push the odd one out:
  storage was already per-commit and reads already per-branch.

  Push now carries only the anchors a read at that rev resolves to. Storage is
  unchanged (commit-anchored, one local ref, one shared remote ref) — only
  push learns the granularity storage already had. `cledger sync` scopes to
  the current branch by default, `--rev` scopes elsewhere, `--all` restores
  the whole-ledger push. **No mapping is stored anywhere:** reachability is
  recomputed at push time from the DAG, the same reason reads never stored it.

  *Squash merges are the case that decides the implementation.* The scope
  reuses `resolveAnchors` — the same function reads use — rather than a plain
  `git rev-list`. A squash discards the source branch's commits, so its
  conversations sit on anchors unreachable from the target, and only the
  `re_anchor` mapping events (anchored to the *surviving* commit) tie them
  back. A rev-list-only scope would push those mapping events while leaving
  behind the events they point at — dropping exactly what re-anchoring exists
  to save. Covered by a test that fails against a rev-list-only scope.

  *The destructive shortcut, recorded because it is the natural first
  implementation.* A notes ref is a snapshot of the whole database, not an
  append log: its tip tree maps every annotated commit to its note, so
  whatever tree you push becomes the remote's entire notes database. Filtering
  your local ref down to one branch and pushing that still fast-forwards — and
  silently deletes every other branch's conversations from the remote's
  current view (they survive in the ref's history but vanish from `git notes
  show` and from any fresh clone). The scoped push therefore seeds a temp ref
  from the remote's tip and unions its scope *into* that, so the push strictly
  adds. Also covered by a test that fails against the filtered-tree version.

  *Side benefit:* the pre-push scan gate now inspects only what the push would
  carry, so a finding in a branch that is not being pushed no longer blocks
  shipping unrelated work.

  *Scope follows the refs actually being pushed* (0.15.0). The hook is fed
  git's pre-push stdin — one line per ref — so `git push origin feat` from
  another branch shares feat's conversations. 0.14.0 shipped with `</dev/null`
  and scoped by `HEAD`, which shared nothing in that case. Ref deletions are
  skipped (no tip to scope to), multiple refs union, and anything unusable
  falls back to `HEAD` rather than to the whole ledger. Because this changes
  the installed hook, `installHook` now replaces a stale cledger block in
  place instead of leaving any file containing the marker untouched — only the
  marked region is rewritten, so surrounding user content survives.

  *Not addressed here:* the read default. `cledger export` still defaults to
  no reachability filter, and the fix belongs in `readEvents` rather than in
  one CLI command, since library consumers (intent-recall) never go through
  the CLI and would otherwise inherit the unscoped view. Separate entry below.
  Per-branch remote refs (`…-branches/<branch>` plus a wildcard fetch refspec)
  were considered and are *not* needed; they would only add fetch-side
  selectivity, letting a collaborator decline a branch's conversations
  entirely. Worth revisiting only if that is ever wanted.
- **Reads default to unscoped** — `readEvents` applies reachability only when
  the caller asks, and `cledger export` never asks, so an automated consumer
  reading the ledger directly gets every branch's conversations unless it
  knows to pass a rev. Now that push is scoped, this is the remaining half of
  the same mismatch. The default belongs in `readEvents` (with an explicit
  opt-out) rather than in `export`, precisely because the consumers that
  matter — intent-recall and anything else using the library — never go
  through the CLI at all.
- **Audit the allowlist for generalizable false-positive patterns** — this
  repo's own dogfood allowlist (2026-07-22) picked up two `keyword-assignment`
  fingerprints from this project's own development conversation: test code
  like `const secret = fakeSecret("github-token")`, where `"github-token"` is
  a rule-id label, not a credential, but still trips "a variable named
  secret/token gets assigned something." Allowlisting is correct for now, but
  it's a per-fingerprint, per-repo escape hatch — every downstream consumer of
  cledger whose codebase talks *about* secrets (redaction tooling, security
  tests, docs) will hit the same class of false positive independently, with
  no shared fix. Periodically review what's accumulated in the allowlist: a
  recurring pattern (e.g. "the matched span is itself a rule id/label string,
  not a real-looking token") is a signal the `keyword-assignment` rule itself
  should get smarter — not something every project should have to
  allowlist for itself.
  - **The false positive is self-perpetuating through documentation**
    (observed 2026-07-27, from `intent-recall`): a design conversation that
    quoted *this very roadmap entry* — the paragraph above, containing the
    example `const secret = fakeSecret("github-token")` — was itself flagged
    with 6 `keyword-assignment` findings and held back from push. The
    write-up of a false positive reproduces the false positive, in a
    different repository, in a conversation transcript rather than in code.
    Two things this exposes that the parent entry does not: (a) the allowlist
    is per-repo, so a fingerprint retired here is re-encountered from scratch
    by every downstream repo whose conversations read or discuss these docs —
    and cledger's own documentation is now a reliable source of them; (b) the
    flagged span was prose *about* a credential-shaped example and never a
    credential, which is about as clean a signal as exists that the rule
    wants a "is this a discussion or an assignment?" discriminator rather
    than more allowlisting. Cheap partial fix worth weighing: treat a match
    whose surrounding context is natural-language prose (a markdown
    paragraph, a conversation turn) far more skeptically than one inside a
    code block or a source file.
- **Path-based capture exclusion** — the path half of the redaction config
  ("never record reads of `secrets/**`"); requires correlating `tool_use`
  file paths with their `tool_result` events.
- **`cledger redact`'s local purge leaves the value in the reflog** — the
  squash is real but incomplete, and the command overstates what it achieved.
  When the pre-redaction content was never pushed, `redactEvent` rebuilds the
  notes ref as a parentless commit so the old chain becomes unreachable, and
  reports `history squashed: yes`. Measured 2026-07-27: the pre-redaction blob
  is still recoverable straight afterwards via
  `git show $(git reflog show refs/notes/conversation-ledger | awk '{print $1}')`,
  because `update-ref` leaves reflog entries pointing at the discarded
  commits. It stays recoverable for the reflog expiry window (90 days by
  default) and only actually disappears after
  `git reflog expire --expire=now` plus a pruning `git gc`. So today's
  redaction is "no reader will surface it" rather than "it is gone", even in
  the case the tool claims full success for.
  *Fix, needs a decision before implementing:* expiring the ledger ref's
  reflog is narrow and safe, but reclaiming the objects needs a prune, and
  prune is repo-wide — it would also drop unreachable objects the user may
  have wanted (dropped stashes, abandoned commits). Options are a scoped
  `reflog expire` plus `git prune` accepted as repo-wide, or leaving the
  objects and telling the truth in the output instead. What must not stay as
  it is: reporting `history squashed: yes` when the value is still one
  `git show` away.
  *Unchanged either way:* once the ref has been pushed the squash is skipped
  entirely and rotating the credential is the only real remedy — see below.
- **Post-push purge** — true content removal after the ledger ref has been
  shared (force-push + collaborator re-fetch coordination); the local
  pre-push squash shipped with `cledger redact`. Three hard parts scoped so
  far: (a) the `cat_sort_uniq` union merge means any collaborator still
  holding the old blob silently re-introduces it on their next sync, so purge
  must pair the force-push with a loud reset-don't-merge instruction and
  detection of resurrected blobs on later fetches; (b) hosts retain
  unreachable objects for a window and may serve them via API after a
  force-push, so purge reduces exposure but rotating the leaked credential is
  the only real remedy — output must say so plainly; (c) the companion
  `redaction` event and the rewritten event's original id must survive the
  purge (remove the secret's content, never the evidence a redaction
  happened, and don't break rescan dedup).
- **`re-anchor`** *(shipped, 0.8.0)* — events orphaned by squash merges or
  history rewrites follow the surviving commit by default: append-only
  `re_anchor` mapping events (anchored to the successor, deterministic ids
  so concurrent detection dedups), read-time reachability resolving them
  transitively, fetch-side detection via tree/patch-id exact matching, and
  the `cledger re-anchor` command for dry runs and manual assertions. The
  suggestion tier shipped in 0.9.0: unmatched branches get evidence-ranked
  candidates (forge merge-commit assertion via `gh`, `(#N)`/squash-message
  corroboration, per-file patch-id overlap), confirm-only, behind the forge
  abstraction in `src/forge/` (GitHub driver first).
- **Harness-artifact capture** — decide whether the ledger should also
  preserve valuable non-git-controlled agent artifacts that normally die
  with a worktree or live outside the repo (e.g. Claude Code auto-memory
  directories, session state). They fit the `document` kind; the question is
  scope and capture triggers.
- **Format-drift: re-normalization** — unrecognized transcript line types are
  detected (0.4.0), preserved raw-only as `unrecognized` events rather than
  dropped (0.5.0), and now re-normalizable (0.6.0): `cledger renormalize`
  re-feeds each preserved line's `raw.data` through its owning adapter's
  current convert path and, for the ones this version can now interpret,
  appends the proper `conversation_turn` plus a `supersession` event linking
  it to the raw placeholder. The turn is reconstructed with the exact id a
  live capture would produce (same seq/session/timestamp handling), so a later
  live capture of the same session dedups rather than duplicating; the run is
  append-only and idempotent. *Remaining:* this is a manual command —
  auto-running it after an adapter/version bump on capture is deferred
  (detecting "the adapter changed" is its own problem).
- **Capture/scan redaction feedback loop** *(shipped, 0.6.1 + 0.7.0)* — the
  broad pre-push scan can flag a value the conservative capture tier let
  through, and because the sessions spent fixing it are themselves captured, a
  naive fix-sync-fix cycle can re-ingest the same raw value indefinitely.
  Allowlisting escapes it (fingerprint-keyed), but per-event redaction alone
  did not. Two channels are now closed: (a) the sync-report output masks the
  matched span entirely — surrounding context plus fingerprint, zero secret
  characters — so a captured report can't re-seed the finding it describes
  (0.6.1); (b) the opt-in `knownSecrets` store lets `cledger redact --pattern`
  teach capture-time redaction the exact confirmed values, so they can never
  be re-captured raw (0.7.0). *Deferred / rejected:* the fuller "capture-tier
  is a strict superset of scan-tier" framing was considered and set aside —
  promoting the deliberately-noisy scan rules to run at capture would silently
  rewrite innocent text, violating the near-zero-false-positive invariant that
  makes capture-time rewriting safe. The value-based learning above is the
  intended narrow form.
- **Encrypt the known-secrets store at rest** — the opt-in store aggregates
  confirmed secret plaintext into one predictably-named local file. This does
  not change the transport threat model (the same values already sit in
  plaintext transcripts), but the *aggregation* is a distinct accidental-read /
  disk-snoop / backup-scoop risk. Owner-only `0600` perms shipped in 0.7.1;
  the real remaining work is encryption with an OS-keychain-held key (macOS
  Keychain / libsecret / DPAPI), which must decrypt *non-interactively* since
  capture runs silently on every turn.
- **Share local state across worktrees** *(shipped, 0.13.0)* — cledger kept
  its local state under `git rev-parse --absolute-git-dir`, which in a linked
  worktree is that worktree's *private* directory
  (`<main>/.git/worktrees/<name>/`), not the repo's shared one. Git is doing
  exactly what it documents; the wrong assumption was that a repo has one git
  dir. Everything cledger stores there is repo-wide, so a worktree behaved
  like a separate repo, in four ways of descending severity: (a) the pre-push
  hook was installed where **git never runs it** — git resolves hooks against
  the common dir only — so a repo whose first capture happened in a worktree
  got a hook that looked installed and silently never fired; (b) the
  known-secrets store was invisible, failing **open**: values the user had
  taught capture-time redaction to scrub were written to the ledger in the
  clear, with nothing reporting it; (c) the allowlist was invisible, failing
  closed, so already-dismissed scan findings blocked the ledger push again
  (measured on this repo: 213 findings from a worktree vs 0 from the main
  checkout); (d) capture cursors reset, re-scanning transcripts from the top.
  Fixed by resolving a `commonDir` (`--path-format=absolute --git-common-dir`,
  with a manual-resolve fallback for git < 2.31) and hanging all local state
  and the hook path off it. Placement is irrelevant to the fix — git treats a
  worktree nested under the repo and one at an arbitrary path identically, and
  both are covered by tests. *Fallout that outlived the cause:* (d) also
  **duplicated events**, because append-time dedup only consults the note of
  the commit being written to, so a re-scan after HEAD moved filed a second
  copy under a different anchor; once both anchors were reachable, reads
  returned the turn twice (measured: 351 duplicated ids in this repo's own
  ledger). The ledger is append-only, so those copies are permanent — reads
  now collapse events by id, preferring the earliest `recorded_at` with the
  canonical serialization as a deterministic tie-break. That path is not
  worktree-specific; any forced rescan after HEAD moves can produce it.
  *Deliberately unchanged:* `.cledger.json` stays a working-tree file, so it
  is per-worktree unless committed — correct for versioned repo config, unlike
  `.git`-side state. *Not migrated:* an allowlist or known-secrets store
  written from a worktree before this fix stays orphaned in that worktree's
  private dir; re-run `cledger allow` / `cledger redact --pattern` if you hit
  it.
- **Record which model/provider/CLI version served each turn** *(shipped,
  0.12.0)* — `producer` previously said only which capture path recorded an
  event (`source`, `session_id`, cledger's own `tool`/`version`), never what
  produced it: the model, the inference provider, or the coding CLI's
  version. Codex's `session_meta`/`turn_context` lines carry exactly that and
  were dropped with no trace; Claude Code's per-line `version` and
  `message.model` survived only inside `raw.data`, unqueryable without
  parsing a source-native shape. Three optional fields close it —
  `producer.model`, `producer.provider`, `producer.source_version` — with
  `cledger log --model M` to filter and the model(s) listed per row in
  `cledger conversations`. *Only what the source states is recorded:*
  `provider` stays unset for claude-code (never named in the transcript, and
  the same CLI can point at the first-party API, Bedrock, or Vertex), a model
  is never carried onto a turn the source did not label (so claude-code user
  turns have none), and `"<synthetic>"` passes through verbatim rather than
  being normalized away. Codex needed real work beyond reading a field: its
  facts live on out-of-band lines, so a cursor-resumed capture re-scans the
  file prefix to rebuild the context in force, and because `turn_context` is
  written *after* the turn's opening messages in real rollouts, still-unset
  fields are seeded from the earliest line stating them ahead — otherwise the
  first user message of every session goes unlabelled. Seeding fills gaps
  only; a genuine mid-session model switch still applies forward, never
  retroactively. The fields are **excluded from event identity** (adding them
  to the id would make a rescan duplicate every pre-upgrade turn instead of
  deduping it), and scanning is unaffected since `scan`/capture-tier
  redaction walk only `content` and `raw.data`. *Forward-only, and
  deliberately no backfill:* rewriting `producer` on stored events would keep
  their ids but change their note lines, and under `cat_sort_uniq` the
  rewritten and original lines both survive a merge with any peer still
  holding the old one — two copies of one event. Old claude-code events lose
  nothing permanent (their whole source line is in `raw.data`); old codex
  events do, and re-capturing them does not help, since they dedup by id.
  *Out of scope:* the rest of what those codex lines carry — `base_instructions`
  (the full system prompt), sandbox/approval policy, reasoning effort — is
  still not captured. That is a separate question (whole-session
  configuration, not per-turn agent identity) with its own size and
  redaction implications; this cut answers only "what served this turn".
- **Preserve provider-encrypted reasoning as opaque state** *(shipped,
  0.10.0)* — Codex's `reasoning` response_items carry `encrypted_content`
  that only OpenAI's servers can decrypt; the client just round-trips the
  blob, and replaying it restores the model's hidden reasoning
  provider-side. Capture previously dropped these outright, which conflicted
  with the record-everything-just-in-case posture: we discarded them because
  *we* can't read them, yet the one party who can (the provider) already saw
  the plaintext. Realization (2026-07-21, turnbridge): dropping them
  permanently forecloses restoring reasoning when a Codex-origin
  conversation is fabricated back into Codex on another machine (or after a
  codex→claude→codex round trip). Empirically verified same-account and
  cross-account (turnbridge `scripts/probe-encrypted-reasoning.mjs`): a real
  blob replayed in a fabricated session is accepted across sessions, CLI
  versions, and even a different paid ChatGPT account with identical token
  accounting — the ciphertext is not keyed per-account. Shipped shape: a new
  `reasoning` kind, provider-agnostic (not Codex-specific), raw-only —
  `content` carries only an opacity marker, the blob lives solely in `raw`.
  Rides the ledger's normal default-on sync like every other kind (no special
  carve-out). `cledger export` includes it by default (lossless dump);
  `cledger log`/`show`/`conversations` hide it by default (`--with-reasoning`
  to reveal) so ciphertext doesn't clutter human-facing transcripts. A
  reasoning item's `summary` field (real, provider-decrypted plaintext when
  reasoning-summary mode is on — distinct from `encrypted_content`) is split
  out into an ordinary visible `conversation_turn` at the same seq, so it is
  never hidden as if it were opaque. Capture-tier redaction and `cledger scan`
  both exempt only the `encrypted_content` field from pattern-matching (it's
  high-entropy by construction and this feature's entire point is preserving
  it byte-exact — a coincidental rule match would silently corrupt it); every
  other field, including `summary`, is scanned exactly like any other stored
  content. Forward-only: sessions captured before 0.10.0 already had their
  reasoning dropped and it's not recovered from what's on disk. *Remaining
  open questions, mostly turnbridge's to answer at replay time:* blob TTL and
  API-platform-org auth parity. *Deliberately out of scope here:* inter-agent
  `agent_message` payloads still drop their embedded `encrypted_content`
  blocks outright (same as before) rather than preserving them via this new
  `reasoning` kind — same provider-withheld material, but embedded mid-line
  rather than a standalone response_item, so preserving it needs its own
  shape; tracked as a follow-up, not bundled into this cut. Also out of scope
  at the time: no ledger event recorded which model/provider/CLI version
  produced a given turn — a pre-existing gap in `Producer`, not specific to
  reasoning, since closed in 0.12.0 (see the entry above). That gap mattered
  most here: an encrypted blob is only replayable against the model that
  produced it, so `reasoning` events captured before 0.12.0 carry ciphertext
  with no record of where to send it.
- **Sub-turn citation anchors** for downstream consumers like intent-recall.
- **Forge (PR/MR) conversation adapter** — ingest pull-request review
  discussions as ordinary conversation events anchored to the merge/squash
  commit. The event schema already fits (a review comment is a visible turn
  with a human actor); what doesn't slot into the existing adapter shape is
  the capture surface — no local transcript file, no hook that fires on a
  remote comment, needs API auth/pagination. The forge abstraction now
  exists (`src/forge/`, built for re-anchor suggestions: PR-for-branch
  lookup, GitHub driver over the user's `gh` session); this adapter would
  extend it with comment fetching. GitLab/Gitea analogues exist for every
  piece.
- **Forge-side integration (CI / GitHub App)** — an opt-in Action/webhook
  that runs where the squash actually happens: append the re-anchor mapping
  event at merge time (no post-hoc detection needed), ingest the PR
  conversation on merge, and push the notes ref from CI. Solves the
  "squashes happen off-machine" problem at the source instead of
  reconstructing it after fetch; kept separate from core because it requires
  forge credentials and per-host setup.

## Storage model, in one paragraph

One git note per anchor commit under `refs/notes/conversation-ledger`; the
note body is one canonical-JSON event per line, sorted and unique, with all
content inline (GC-safe, no out-of-repo pointers). Concurrent branches merge
conflict-free via git's `cat_sort_uniq` notes strategy. Events record
repository, branch, HEAD, dirty-tree fingerprint, actor, timestamps, and
capture mechanism. Redaction appends a `redaction` event rather than silently
rewriting history. See [docs/WIP_TECHNICAL_DESIGN.md](docs/WIP_TECHNICAL_DESIGN.md)
for details and [docs/PRODUCT_INTENT.md](docs/PRODUCT_INTENT.md) for what this
tool deliberately refuses to become.

## License

[MIT](LICENSE)
