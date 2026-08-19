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
cledger install all    # hook capture into every supported coding CLI
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
--all` or `--session <id>`; `gemini-cli` and `qwen-code` also accept `--all`,
which backfills every session that CLI scopes to the current directory).

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
cledger log --with-state        # also the harness's own state, activity, injections, snapshots
cledger conversations           # sessions touching this branch, with the models they used
cledger show claude-code:3f9a   # replay one conversation in order (matches subagents too)
cledger export > ledger.jsonl   # every field incl. source-native payloads, this branch
cledger export --all            # ...and every branch this machine captured
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

## What gets recorded

The goal is the whole record, not the readable half of it. A coding session
produces far more than turns, and most of the rest used to be discarded at
capture as "bookkeeping". It is not bookkeeping to a consumer asking whether an
old turn still applies, or what a file looked like between two commits, or what
a subagent actually did.

Every event carries a `kind`:

| Kind | What it is | Examples |
|---|---|---|
| `conversation_turn` | What someone said — human, agent, tool result, or the harness printing into the conversation | user prompts, assistant messages, tool calls and results, `<local-command-stdout>` |
| `reasoning` | Provider-encrypted thinking, preserved opaquely and never interpreted | Codex `reasoning` items |
| `session_state` | A declaration that holds until restated | mode, permission mode, sandbox and approval policy, model settings, session title, worktree relocation, Codex `turn_context` / `session_meta` / `world_state` |
| `activity` | A point-in-time occurrence that is not a turn | hook runs, turn durations, token counts, task lifecycle, queue operations, context compaction, aborts, opencode step boundaries |
| `context_injection` | Material that entered the model's context as something other than a turn — usually the harness's doing, sometimes named by the human | Claude Code `attachment` lines — task reminders, skill listings, diagnostics, pasted files; Qwen `at_command` (`@file`), which carries a human actor |
| `file_snapshot` | Intermediate file state: the versions a file passed through between commits | Claude Code `file-history-snapshot` / `file-history-delta` |
| `unrecognized` | A line type no adapter knows yet — preserved raw, warned about, upgradeable by `cledger renormalize` | anything upstream adds |

The last four are *session machinery*: `log`, `show` and `conversations` hide
them unless you pass `--with-state` or name the kind with `--kind`, because a
session restates its mode and its tracked-file set far more often than anyone
speaks. The exception is **whose action a record was** — a machinery event
attributed to a human (a slash command, an `@`-command, an explicit rewind)
shows by default, because what makes the rest noise is that the harness or the
agent generated it, not the kind it landed in. They are always captured,
always exported, always synced — the flag only changes what is displayed.

### Sub-conversations

A subagent's turns are its own conversation, not part of its parent's turn
sequence. They get their own `conversation.id` and point back via
`conversation.parent`, so `cledger show <subagent-id>` reads one subagent in
isolation while `cledger show <session-id>` still matches the parent and every
child under it. Claude Code sidechains and opencode subagent sessions were both
dropped entirely before this existed — for an agent-heavy session that was most
of the work.

Finding them is half the problem, and it is per-source. Claude Code writes a
subagent to `<session>/subagents/agent-<id>.jsonl`, a sibling file the hook
payload never mentions, so capture walks the directory. opencode records a
child's session id in the parent's `task` tool part, and `opencode session
list` returns top-level sessions only, so capture walks that instead. Both
recurse depth-first, cycle-guarded.

### File snapshots and `resolved`

Sources describe intermediate file versions with *pointers* into a local cache
(`~/.claude/file-history/<session>/<hash>@vN`), never with content. Capture
records the pointer in `content` and, in a separate top-level `resolved` field,
the sha256 and size it read from that file at capture time.

`resolved` is deliberately outside event identity. The cache is the source's to
prune, so the same transcript line resolves differently on another machine or
after a cleanup; folding that into the id would duplicate every snapshot on the
next rescan instead of deduping it. The digest is stored rather than the bytes
so the record stays verifiable without growing the ledger by whole file bodies —
a consumer that still has the bytes can prove they are the ones the event means.

## Adapters

Supported today (built-in, per-turn, triggered by the CLI's own hook or
plugin mechanism):

Every captured event records the agent that served it — `producer.model`,
`producer.provider`, `producer.source_version` — but only where the source
states it; see the Roadmap entry below for what each adapter does and does
not know.

| Source | Trigger | Transcript store | Notes |
|---|---|---|---|
| Claude Code CLI | `Stop`/`SessionEnd` hooks | `~/.claude/projects/*/*.jsonl` | Also covers the VS Code extension and JetBrains plugin (both share `~/.claude/settings.json` hooks and transcripts), and desktop-app local/SSH/WSL sessions. Cloud "Remote" sessions and the Cowork tab run server-side — not captured. Every line type is now recorded: `system` lines that printed text become turns spoken by the system, `attachment` becomes `context_injection`, `mode`/`permission-mode`/`worktree-state`/`pr-link` and friends become `session_state`, `queue-operation` and the rest become `activity`, and `file-history-*` becomes `file_snapshot` with backup digests resolved at capture time. Sidechain (subagent) turns are captured as sub-conversations instead of dropped — including the `<session>/subagents/agent-*.jsonl` sibling files newer Claude Code writes, which the hook payload never names. The hook also sweeps other transcripts in the same project that cledger already has a cursor for and whose file grew past it, which is how a session's final lines get captured at all: the last hook reads to EOF, and Claude Code writes the closing bookkeeping (including the session's most complete file-history snapshot) afterwards. A transcript with no cursor is left alone — it was never cledger's to capture, and adopting it would backfill old conversations against today's HEAD. |
| Codex CLI | `[[hooks.Stop]]` hooks engine | `~/.codex/sessions/**/rollout-*.jsonl` | Same config + session store is shared by the Codex desktop app and IDE extension, so their local sessions should capture too — but OpenAI has open bugs on the desktop app's config loading, and third-party reports say hooks may not fire from IDE sessions. Treat non-CLI surfaces as best-effort; `cledger capture codex` backfills any rollout file regardless of which surface wrote it. Cloud tasks run server-side — not captured. Provider-encrypted `reasoning` items are preserved opaquely as `reasoning`-kind events (hidden from `log`/`show` by default, see Roadmap); inter-agent messages (`agent_message`) are captured as two events at the same `seq`: the visible turn, and a sealed `reasoning`-kind sibling carrying the embedded `encrypted_content` blocks, so an inter-agent session can still be replayed back through the provider that encrypted it. `turn_context` and `session_meta` are now recorded as `session_state` as well as read for `producer` metadata, so the sandbox policy, approval policy and reasoning effort a turn ran under are part of the record. Of the `event_msg` UI stream, only `agent_message`/`user_message` are dropped — they genuinely duplicate a `response_item`; token counts, task lifecycle, sub-agent activity, patch application and aborts have no twin and are recorded as `activity`. |
| opencode | `session.idle` plugin event | SQLite at `~/.local/share/opencode/opencode.db` | The only adapter without an append-only transcript file. Rather than read opencode's database — whose schema is mid-migration, and which also stores API tokens — capture shells out to `opencode export --pure <id>` and converts its JSON. One event per *part*, not per message: opencode's store is mutable, and a part is the finest unit that stops changing, so a message that gains parts after an early idle appends rather than duplicating. Unlike Codex, `reasoning` parts are plaintext, so they become ordinary visible `thinking` blocks. Unsettled (`running`) tool calls are skipped and hold the cursor back until they finish. Subagent sessions are captured as their own conversation: opencode records a child's session id in the parent's `task` tool part, which is the only way to find them at all (`opencode session list` returns top-level sessions only), so capture walks them depth-first. Requires `opencode` on `PATH`; `cledger capture opencode --all` backfills every session opencode scopes to the current project, and `--transcript` reads a saved export. |
| Gemini CLI | `AfterAgent`/`SessionEnd` hooks | `~/.gemini/tmp/<project>/chats/session-*.jsonl` | The session file is append-only but is *not* a transcript: it is a write-ahead log of mutations to one conversation document — `$rewindTo` removals, `$set` metadata patches, whole-document `$set.messages` snapshots, and message upserts keyed by a durable id. Capture replays it with Gemini's own record precedence but deliberately does **not** honour the removals: verified on a live session, Gemini rewrote the document after a failed API call and silently dropped the prompt the user had just typed, so a faithful replay records no trace of it having been asked. The ledger keeps the union of every message the file ever held, each at its last-written value, and records each withdrawal as an `activity` naming the ids it took out — `rewind` for an explicit `$rewindTo`, `snapshot_drop` for a `$set.messages` snapshot that quietly omits what the document used to hold — so a withdrawn turn is legible as withdrawn rather than merely present. Both paths matter: the snapshot is the one the live incident above actually took. Verified against live Gemini CLI 0.54.0 sessions — including one where Gemini **deleted its own session file** after a `/rewind`, leaving the ledger's copy of that conversation the only surviving record of it. `$set` patches become `session_state` (with the message list left out of `raw`, since Gemini rewrites the *whole* conversation into every snapshot and each message is already captured as its own event), `info`/`error`/`warning` notices become turns spoken by the system (Gemini discards them; "quota exceeded" is often the only explanation for why a turn looks abandoned). Because nothing is ever removed, `seq` is assigned at first sighting and never reused, so a rewind cannot renumber later turns — the positional churn the opencode adapter accepts does not arise here. A model turn whose tool calls have not settled is withheld and holds the cursor back. Sub-sessions filed under `<chats>/<parent session id>/` are captured as sub-conversations. Gemini's harness-authored `<session_context>`/`<hook_context>` preambles are recorded but attributed to `system`, not to you. |
| Qwen Code | `Stop`/`SessionEnd` hooks | `~/.qwen/projects/<escaped-cwd>/chats/<session-id>.jsonl` | A fork of Gemini CLI that did *not* inherit its conversation store: plain append-only JSONL with a claude-code-shaped envelope, so capture is per line with a line-index `seq`, a torn-tail-safe cursor, and the same catch-up sweep claude-code runs. Content is a Google GenAI `Part` list (shared with the Gemini CLI adapter): a `thought` part becomes a visible `thinking` block, `functionCall`/`functionResponse` become `tool_use`/`tool_result`. Everything that is not a turn arrives as a `system` line discriminated by `subtype`, and each maps to a kind: `attribution_snapshot` becomes `file_snapshot` (with per-file content hashes already in the record, so nothing needs resolving against a local cache), `custom_title`/`session_source`/`parent_session`/`goal_state` become `session_state`, `at_command` and the agent-launch prompts become `context_injection`, and everything else — including a subtype a future Qwen adds — becomes `activity` rather than being dropped or guessed at. A `parent_session` record makes a subagent chat a sub-conversation of the session that spawned it — though on Qwen Code 0.21.5 that is **not** how delegation was observed to work: a subagent runs in-process behind an `agent` tool call, writes no chat file of its own and no `parent_session` record, so the ledger stores the delegation as an ordinary `tool_use`/`tool_result` pair in the parent. Nothing about it is lost — the prompt handed to the subagent, its status, terminate reason and a per-tool execution summary all ride in `toolCallResult.resultDisplay` and are preserved in `raw` — but the subagent's own turn-by-turn conversation is never written by Qwen at all, so no adapter can recover it. Assistant lines state the serving model; `provider` is left unset because Qwen records only an *auth mode* (`openai`, `qwen-oauth`), not the inference provider the schema asks for. |

TODO adapters, roughly in order of how ledger-friendly their storage/hook
story looks (all have local session stores; most grew Claude-Code-style hook
systems):

- **Kimi CLI** — `~/.kimi-code/sessions/**/agents/<agent>/wire.jsonl`, an append-only
  wire log with a `protocol_version` header, one directory per agent (so subagents are
  separated at the filesystem level); Claude-Code-inspired lifecycle hooks.
- **Google Antigravity** — where Google now sends individual users whose Gemini CLI
  `oauth-personal` sign-in is refused (see the Gemini CLI note below). Unexamined:
  whether it keeps a local session store worth capturing is unknown, and this list
  does not guess. If it does, it is a *sibling* of the Gemini CLI adapter rather than
  a replacement — that CLI is still published, still writes the same format, and is
  still supported here.
- **GitHub Copilot CLI** — `~/.copilot/session-state/`; documented hooks dirs.
- **Factory droid** — `~/.factory/` sessions; `hooks.json`.
- **Cursor (`cursor-agent` CLI)** — `~/.cursor/chats`; hooks exist, but IDE-side chats live in editor-internal storage.
- **aider** — plain `.aider.chat.history.md`; no hook mechanism found, would need file watching.
- **Goose / Amp** — SQLite store / cloud-synced threads; hook stories unclear or absent.

## Security & redaction

Visible tool output can contain secrets: API keys in error messages, credentials in logs, etc. The trust boundary is transport — native transcripts are plaintext locally, so redaction protects the *shared* record, not the local disk. Once content reaches a note, removal is expensive, so prevention runs first at capture, with the last checkpoint at sync.

### What cledger does and does not protect

The one enforced guarantee: **an event that a scan rule or a human flagged does not leave this machine over the ledger ref.** The pre-push gate is the enforcement point — everything earlier (capture-time masking) is best-effort harm reduction, and everything the gate never sees is out of scope. Concretely out of scope:

- **Your local disk.** The agent CLIs' own transcripts hold the same content in plaintext (`~/.claude/projects/**`, `~/.codex/sessions/**`, …) whether or not cledger exists. Ledger notes are no more and no less exposed locally than the transcripts they came from.
- **Secrets an agent reads because you let it.** An agent that can `cat ~/.aws/credentials` will put the result in its transcript, and no pattern list catches every secret shape. Set file permissions so agents (which run as you) have nothing to find: keep real credentials in a password manager or OS keychain, not in world- or user-readable dotfiles inside repos you run agents in.
- **Secrets you paste into a conversation.** Capture-tier rules catch well-known token formats; a pasted connection string or a bespoke internal token may sail through to the note. Treat an agent conversation like a group chat: if you would not paste it there, do not paste it here.
- **Other exits.** `cledger export`, `log`, `show`, and the raw notes ref all print stored content freely on the machine that holds it — they are reads of local plaintext, not shares. The gate sits on the one path that publishes: pushing the ledger ref.

If a real secret does reach the remote, redaction cannot recall it (see `cledger redact` below for why) — **rotate the credential**. That is the honest failure mode of every system in this category.

### Writing secret-shaped fixtures

Repos that test or document secret handling (this one included) constantly mint fake credentials, and every fake that looks real enough becomes a scan finding a human has to wave through. Two conventions keep fixtures out of the review queue *at authoring time* instead:

- **Put an uppercase marker in the fake value**: `password=FAKEhunter2aa`, `api_key: "EXAMPLE-abcdef12345678"`. Scan-tier heuristics skip spans containing `FAKE`, `EXAMPLE`, `PLACEHOLDER`, `DUMMY`, `NOTREAL`, or `TESTONLY` (uppercase only — `example.com` in a URL does not count, writing the marker must be an authoring choice). This is the convention to teach your coding agents; this repo's `CLAUDE.md` does.
- **For format-valid tokens** (a syntactically real `ghp_…` that must exercise a capture rule), markers are ignored by design — store the token split into parts and reassemble at runtime, as `src/test/fixtures/secret-corpus.json` does with `secret_parts`. A whole format-valid token should never exist as literal bytes in a file, a conversation, or a commit.

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

**Sync-time scan** (default on, tiered): Before any push, scans only new events with medium/high-precision rules (capture ruleset re-run, keyword assignments like `password=`, URL credentials). Findings abort the ledger push with a report and remediation instructions; the report prints **coordinates only** — event id, rule, JSON path + offset, fingerprint — and never a character of the flagged text or its surroundings, because the context around a match is itself what tripped the rule, so a printed excerpt re-seeds a finding on the report. The report is **grouped by fingerprint**: the same span recurring across an event's `content` and `raw` mirrors, or across every edit of one file, is one decision, and the report's size tracks decisions rather than match sites (this repo's own dogfood backlog was 153 sites that collapse to 11 spans). Readable content lives behind `cledger review` (interactive, one screen per span) and `cledger inspect <event-id>` (writes a `0600` file outside the repo); both refuse to run inside a coding-agent session. In the pre-push hook, a finding holds back only the ledger and lets your code push proceed unless `{"transport": {"strict": true}}`.
- Threat addressed: secrets from older capture rules or new tool formats slipping through.
- Cost of disabling: `{"scan": {"tier": "off"}}` — secrets in tool output push silently.
- Remediation paths: `cledger review` (walk every outstanding span, one keystroke each), `cledger redact <event-id>` (real secrets), `cledger allow <fingerprint>` (false positives), `cledger sync --no-scan` (bypass once). `--paranoid` tier adds entropy-based detection (noisier but broader).
- Scan-tier heuristics skip a match whose span carries an uppercase fixture marker (`FAKE`, `EXAMPLE`, `PLACEHOLDER`, `DUMMY`, `NOTREAL`, `TESTONLY`) — see "Writing secret-shaped fixtures" below. Capture-tier rules never honor the marker: they match real token formats, and a real leaked token could contain those bytes by chance.

**Allowlist tiers**: a false positive is usually a property of the *text* (a fixture, a doc example), not of the repo it was captured in — the same span gets re-flagged in the next repo that quotes the same doc. `cledger allow <fp>` records it for this repo (`.git/conversation-ledger/allowlist.json`); `cledger allow <fp> --global` records it for every repo on this machine (`~/.config/cledger/allowlist.json`); and a repo can commit shared entries in `.cledger.json` as `{"scan": {"allowFingerprints": ["..."]}}` so clones and teammates inherit them. All three union at scan time. Fingerprints are truncated `sha256` of a span a human judged *not* to be a secret, so committing them discloses nothing.

### Commands

`cledger review [--paranoid] [--context N]`: The intended remediation path. Steps through every outstanding finding interactively — one screen per distinct span, the match highlighted inside real surrounding context, `a` to allow in this repo, `g` to allow globally, `r` to redact it everywhere it appears (the span is escaped into a literal pattern for you — you never retype a secret), `s` to skip. HUMANS ONLY: refuses inside a coding-agent session and without a TTY on both ends, for the same reason inspect does — flagged content that lands in a transcript re-seeds the finding.

`cledger redact <event-id> (--pattern REGEX | --all) [--reason TEXT]`: Rewrites a stored event to a placeholder + audit metadata, appends a `redaction` event, and severs the local notes-ref commit chain so the prior note is unreachable from the ref.

**Pre-push only, and enforced.** The command refuses once the target event is on `origin`, because rewriting shared content does not remove it: a notes ref carries its own commit chain, so every prior note body is in any clone's history (`git log -p refs/notes/conversation-ledger`), and `cat_sort_uniq` unions *lines*, so the original returns on the next merge — a scoped push would in fact re-upload it alongside the rewrite. It also refuses when `origin` cannot be reached, rather than assuming nothing was shared. Gating is per *event*, so pushing regularly does not disable redaction for anything captured afterwards. For a secret that has already left the machine, rotate the credential; purging shared ledger history is separate destructive tooling that does not exist yet.

Severing the chain is not an object purge: the old blobs stay in the local reflog and object store until git's own expiry + `gc`. That residue is local-only (git transfers neither reflogs nor unreachable objects), and the command says so rather than claiming the value is gone. To drop them immediately: `git reflog expire --expire=now --all && git gc --prune=now` (repo-wide).

`cledger scan [--paranoid]`: Standalone check with exit 1 on findings — CI-friendly.

### Maximum safety recipe

Keep all defaults (capture and sync scan on), add repo-specific patterns in `.cledger.json` for domain-specific secrets, enable env masking only if `.env` holds secrets (not config), run `cledger scan` in CI, and treat `--no-scan` as a deliberate exception you document.

## Roadmap

- **Auto-triage of findings whose span is committed repo content — considered
  and deferred, with data** (2026-08-12). The idea: if a flagged span exists
  verbatim in a blob already on the remote, the ledger leaks nothing the repo
  has not published, so the finding could downgrade itself. Tested against
  the only backlog available — this repo's 11 outstanding fingerprints plus
  turnbridge's 4 — it would have cleared **zero of 15**: the split-parts
  corpus convention means assembled fixture bytes never reach a committed
  file, and the other spans lived in shell commands and intermediate edit
  states that were rewritten before committing. The mechanism is sound but
  its hit rate on real backlogs is unproven, and it adds a scan-time
  dependency on remote-reachability computation. Revisit if a backlog ever
  shows committed-content spans; `cledger review` clearing 15 spans in a
  minute weakens the case for more machinery.
- **`cledger review` shows a context window, not the conversation** — the
  0.21.0 reviewer renders the flagged string with ±600 chars (scrollable,
  the whole string is available). A richer version would page through the
  *conversation* around the event — prior and following turns, like reading
  the transcript — which needs event-sequence pagination keyed on
  `conversation.seq` and a real layout pass. Deferred until the per-span
  flow proves insufficient; most verdicts so far need only the surrounding
  string.
- **The `>/dev/null 2>&1` on the Gemini and Qwen hooks was pointless, and cost
  visibility** *(shipped, 0.22.0)* — it was added after `qwen -p "..."` failed
  to capture, on the theory that the redirect "routes the command through a
  shell so the work outlives the teardown". That theory is wrong: both CLIs
  *always* invoke a hook as `bash -c "<command>"`, and `bash -c` `exec`s a
  single simple command rather than forking, so nothing was ever detached. The
  actual cause of hooks dying was the timeout unit below. All the redirect ever
  did was hide the capture's own output, so a format-drift warning had nowhere
  to print and `cledger capture <source> --all` was the only way to watch one.
  New installs no longer write it, and `cledger install` **strips it from an
  existing hook in place** — the same contract the timeout repair established:
  a setting cledger itself got wrong should be fixable by re-running install,
  not by hand-editing JSON. Only cledger's own hook is touched, and only when
  the command ends in that exact string, so any other redirect a user wrote
  survives. *Still unverified:* the original headless `qwen -p` case has not
  been re-run, because that needs a live Qwen session; the reasoning above
  says it was never the redirect that saved it, but nobody has watched it
  since.
- **`cledger log` hid human-driven records by default** *(shipped, 0.22.0)* —
  the session-machinery kinds (`session_state`, `activity`,
  `context_injection`, `file_snapshot`) were hidden unless you passed
  `--with-state`. That default earns its keep against telemetry: one real Qwen
  session emitted 57 `ui_telemetry` records against 45 events of actual
  content, and an unfiltered default would bury the conversation. But it did
  not distinguish *whose* action a record was, so a slash command the human
  typed was hidden by the same rule as a token-count ping.
  The display default is now keyed on the **actor**: a machinery event whose
  actor is `human` shows, the harness's and the agent's bookkeeping stays
  behind `--with-state`, and the flag's meaning is unchanged (show everything).
  Capture is untouched and `cledger export` is still lossless — this only ever
  changed what is displayed.
  *The premise needed repair before the fix meant anything.* "`activity`
  already carries a real actor" was half true: `activityDraft` was the only one
  of the four builders that even took an actor, and exactly one call site in
  the whole codebase passed `human` (Qwen's `slash_command`). Shipping only the
  display change would have surfaced that one record and nothing else. Two
  attributions were corrected alongside it, both where the source *states* who
  acted: Gemini's `$rewindTo` is the person saying "take that back" (its
  sibling `snapshot_drop` — Gemini quietly rewriting its own document — stays
  `system`, and that difference is the entire reason the ledger records them as
  two things), and Qwen's `at_command` is a person naming a file, which was
  landing in `context_injection` with the identical `system` actor as
  `agent_bootstrap`, the harness's own preamble that nobody typed.
  `contextInjectionDraft` grew an actor parameter for that, matching
  `activityDraft`.
  *Deliberately not corrected: claude-code's `queue-operation`.* It looked like
  the same fix — a queued message is something a human typed mid-turn — but the
  source does not say so. Measured across 40 local transcripts: `enqueue`
  splits 126 harness-generated to 43 human-typed, and `remove` 70 to 16. The
  only available discriminator is a content-shape heuristic (harness ones
  arrive wrapped in a `task-notification` envelope), which is a convention that
  can change, and getting it wrong files machine-authored text under a named
  person's git identity — the failure this whole entry is about, in the
  direction that actually does damage. Attribution follows what the source
  states; where it must be guessed from content, it stays `system`. Revisit if
  claude-code ever labels the queue entry's origin.
  *Forward-only, like every attribution change here.* `actor.type` and
  `actor.id` are part of event identity, so a re-capture of an
  already-captured session mints new ids for the re-attributed records rather
  than deduping. That is id churn in one adapter's machinery records, not lost
  content, and there is no backfill — rewriting stored events would put two
  copies of each through `cat_sort_uniq` on the next merge with any peer.
- **Gemini CLI's version is not in its session file** — claude-code and
  qwen-code stamp the CLI version onto every line, so `producer.source_version`
  comes for free. Gemini stamps none, and neither the hook payload nor the
  session header carries one, so gemini-cli events have no `source_version`
  unless a caller passes it. Reading it off the installed binary would be
  wrong for a backfill of an old session, and guessing is worse than omitting.
  Fixing it properly means asking Gemini to record it, or accepting a
  capture-time "the binary on PATH said 0.53.1" annotation that is explicitly
  about the capture rather than the session.
- **`timeout` means different units in Claude Code than in the CLIs that copied
  its hook format** — Claude Code reads a command hook's `timeout` as seconds;
  Gemini CLI and Qwen Code pass the same field straight to `setTimeout`, so
  theirs is milliseconds (`Hook timed out after ${timeout}ms`,
  `DEFAULT_HOOK_TIMEOUT = 6e4`). `cledger install` wrote Claude's `120` into all
  three, so on Gemini and Qwen every hook was SIGTERMed after 120 *milliseconds*
  — less than a cold capture takes. The symptom was a CLI reporting
  `Hook(s) [...] failed` on nearly every turn while its events sometimes still
  landed, because whether the append finished before the signal was a race.
  Fixed by writing each CLI's own unit, and `install` now repairs an existing
  hook's timeout in place rather than seeing "already installed" and doing
  nothing. If another CLI adopts this config shape, check its unit before
  assuming.
- **Signing in to Gemini CLI now needs a key** — Google refuses
  `oauth-personal` sign-in for individuals on this client (*"no longer
  supported for Gemini Code Assist for individuals… migrate to the Antigravity
  suite"*), and that refusal is server-side, not a client change. The shipped
  CLI still supports `gemini-api-key`, `vertex-ai` and `cloud-shell`, and
  honours `GOOGLE_GEMINI_BASE_URL`. Note it has no OpenAI-compatible mode,
  unlike Qwen Code (`OPENAI_BASE_URL`), so a local endpoint has to speak the
  Gemini API. The transcript format is stable across the change — Gemini CLI
  0.54.0's record predicates are byte-identical to 0.53.1's.
- **Most Qwen `system` subtypes are classified by name, not by observed shape**
  — live sessions have now exercised `ui_telemetry`, `attribution_snapshot`,
  `file_history_snapshot`, `at_command` and `slash_command`. The rest of the
  mapping (`custom_title` and `goal_state` → `session_state`,
  `agent_bootstrap`/`agent_launch_prompt` → `context_injection`, and the
  subtypes that fall through to `activity`) is still read off Qwen's own
  `KNOWN_RECORD_SUBTYPES` list rather than off a transcript that produced them.
  Notably `/chat save <title>` did *not* emit `custom_title` — it emitted a
  pair of `slash_command` records — so the `custom_title` path remains
  unobserved and may belong to some other gesture. Fields pass through verbatim
  either way, so the risk is a record filed under a slightly wrong kind, not
  lost or mangled content, but a subtype that turns out to be state while
  sitting in `activity` would be invisible to a consumer filtering on
  `session_state`.
- **`cledger export | head` died with an unhandled EPIPE** *(shipped, 0.22.0)*
  — `printJsonl` wrote to `process.stdout` with no `error` handler, so when the
  reader went away mid-write Node threw and printed a stack trace instead of
  exiting quietly. Not exotic: piping any ledger larger than the 64KB pipe
  buffer into `head`, or into a command that fails at startup, reproduced it —
  `cledger export | head -1` against a 23MB ledger threw every time. Small
  ledgers hid it, because the whole payload fits the buffer before the reader
  exits and no write ever fails.
  Fixed with an `EPIPE` handler that exits 0, the convention every
  `head`-friendly CLI follows; any other stdout error still reports and exits
  1. The handler is installed for the whole CLI rather than around the three
  JSON printers, since `log`'s human format and `conversations` write to the
  same stdout and broke the same way.
  *The second half was less obvious.* `write()` reports EPIPE
  **asynchronously**, so a synchronous print loop runs to completion after the
  reader is already gone — the handler fires, but only once the work is
  finished and the whole ledger has been buffered in memory. The bulk printers
  therefore honour backpressure (`await once(stdout, "drain")` when `write()`
  returns false), which is what makes the exit prompt rather than merely quiet.
  Regression-tested by spawning the real binary and closing the pipe after the
  first chunk: an in-process call has no pipe to break, and a fixture under
  64KB passes without the fix.
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
- **The opencode hook's session-id fallback is untested** — the plugin reads
  `event.properties.sessionID`, confirmed against a live `session.idle` from
  opencode 1.18.5, so the normal path is pinned to the real field. The hook
  still treats the id as optional and falls back to capturing the most
  recently updated session for the directory, so a future opencode that
  renames the field degrades instead of silently stopping. That fallback has
  never run in anger, and it would pick the wrong session if two sessions in
  one project went idle in the same instant. Worth a test that exercises it
  directly, and a warning when it triggers, so a silent rename does not look
  like normal operation.
- **`opencode export` truncates a piped stdout at 64KB** — an upstream Bun
  flush bug: the process exits without draining stdout, so any session over
  ~64KB comes back cut off, and the truncated JSON can still parse. cledger
  works around it by routing the child's stdout to a temp file rather than a
  pipe (see `runOpencode`). Worth reporting upstream; the workaround should
  stay regardless, since it costs nothing and protects older opencode
  versions.
- **Config sections replace rather than merge, and it fails open** — *fixed in
  0.21.0*: `loadConfig` now merges each top-level section key-by-key, so a
  repo `.cledger.json` that sets only `redact.patterns` no longer silently
  reverts a globally-enabled `redact.knownSecrets` to its default. The one
  deliberate exception: `scan.allowFingerprints` arrays are unioned rather
  than repo-wins, because the allowlist is accumulative — a fingerprint either
  config trusts is trusted, and replacement would make a repo-local entry
  silently drop every personal one. Kept here rather than deleted because the
  bug is a family member (see below) and its shape — a config surface where
  *mentioning* a section disabled a sibling protection — is worth remembering
  when adding config keys.

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

  *Not addressed here:* the read default — `cledger export` still defaulted to
  no reachability filter, and the fix belonged in `readEvents` rather than in
  one CLI command, since library consumers (intent-recall) never go through
  the CLI and would otherwise inherit the unscoped view. Closed in 0.23.0; see
  the entry below.
  Per-branch remote refs (`…-branches/<branch>` plus a wildcard fetch refspec)
  were considered and are *not* needed; they would only add fetch-side
  selectivity, letting a collaborator decline a branch's conversations
  entirely. Worth revisiting only if that is ever wanted.
- **Reads defaulted to unscoped** *(shipped, 0.23.0)* — `readEvents` applied
  reachability only when the caller asked, and `cledger export` never asked, so
  an automated consumer reading the ledger directly got every branch's
  conversations — including work that was abandoned and never merged — unless
  it knew to pass a rev. With push scoped since 0.14.0, this was the remaining
  half of the same mismatch.
  `ReadOptions.reachableFrom` now defaults to `HEAD`, and the fix sits in
  `readEvents` rather than in `export` precisely because the consumers that
  matter — intent-recall and anything else using the library — never go through
  the CLI at all. `cledger export` gains `--all` alongside `--rev`, matching
  `log`.
  *The opt-out is `null`, not "unset".* `undefined` means "the caller did not
  say" and resolves to `HEAD`; only an explicit `reachableFrom: null` asks for
  the whole local ledger. That distinction is the whole point — the callers
  that genuinely want everything are few and deliberate, while the ones that
  silently got everything by not asking were the bug. Four say so at their call
  site, each for the same reason: they must not depend on what is checked out.
  `cledger scan` and `cledger review` (a secret does not stop being one because
  its branch is not checked out), `cledger inspect` (an event id is a global
  handle), and `renormalize` (otherwise it strands preserved lines on every
  branch but the current one). `cledger show <id>` is the fifth: you named one
  conversation, so reachability is not the question you asked.
  *Consequence worth knowing:* after a `cledger sync --fetch`, conversations
  anchored to commits you have not fetched are invisible by default — correct,
  since you cannot reach them, but it looks like nothing arrived. `--all`
  answers "did it arrive"; the default answers "does it belong to this
  history". Two of the transport tests had been quietly conflating the two.
- **A closed reader can report `ENOTCONN`, not just `EPIPE`** *(shipped,
  0.23.0)* — a follow-up to 0.22.0's stdout guard, which matched `EPIPE` alone.
  On macOS Node does not always back stdio with a pipe, and a write to a
  socket-backed stdout whose peer has closed reports `ENOTCONN` instead. So
  `cledger log --json | head -1` still exited 1 with `write ENOTCONN` — the
  stack trace was gone, the nonzero exit was not. Surfaced only under enough
  concurrent load to change how far the teardown had progressed, which is why
  the original test suite passed. `ECONNRESET` is matched too, for the
  half-closed case. Which errno you get is an accident of what kind of file
  descriptor Node handed the process, never of what the user did; the test now
  asserts stderr is *empty* rather than free of one named errno, since an
  assertion naming one would have passed while the command was still broken.
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
  *0.21.0 delivered the shared-fix half*: the uppercase fixture marker keeps
  deliberate fakes out of the queue entirely, `allow --global` and
  `scan.allowFingerprints` in `.cledger.json` let one human decision travel
  across repos and clones. The "make the rule smarter" half (a
  discussion-vs-assignment discriminator) remains open below.
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
- **Redaction is pre-push only, and now enforced** *(shipped)* — `cledger
  redact` used to detect the already-pushed case, warn, and proceed anyway,
  reporting partial success. That was worse than useless: `pushScopedNotes`
  seeds from the remote's tip and unions the local scope into it, so
  redact-then-push *re-uploaded* the original alongside the rewrite, leaving
  both copies on the remote permanently — and since a notes ref carries its
  own commit chain, every clone could already recover the pre-redaction body
  with a plain `git log -p refs/notes/conversation-ledger`. The command now
  refuses outright, before touching anything, when the target event is on
  `origin` — or when `origin` cannot be reached to rule it out (a security
  decision made on a failed network call must fail closed; previously an
  offline `ls-remote` was indistinguishable from a virgin remote). Gating is
  per *event*, not per repo, so an earlier push does not disable redaction
  for everything captured afterwards.
  Output no longer claims `history squashed: yes`. Severing the notes chain
  is real but is not an object purge — the old blobs remain in the local
  reflog and object store until git's expiry + `gc` — so the command now
  states exactly that, plus the fact that the residue is local-only (git
  transfers neither reflogs nor unreachable objects) and the one-liner that
  clears it. Running a repo-wide destructive `gc` on the user's behalf stays
  out of scope.
- **Reads must never prefer a pre-redaction copy** *(shipped)* — `dedupById`
  collapses same-id copies by earliest `recorded_at`, then by a canonical-JSON
  byte compare. A redacted event and its original share an id *by design*
  (the rewrite pins it, so a rescan dedups instead of resurrecting the
  secret) and, because the rewrite spreads the original, share `recorded_at`
  too — so both keys tied and the byte compare decided, resolving on the
  secret's first character against the `[` (0x5B) opening `[REDACTED:…]`.
  Every secret starting with a digit or an uppercase letter sorted below it
  and won, so reads printed the plaintext next to the `redaction` event
  asserting its removal. Redaction depth is now consulted first: the copy
  carrying more redaction records wins outright. Unambiguous, because
  capture-time redaction runs before ids are computed, leaving `redactEvent`
  as the only source of same-id different-content pairs.
- **Post-push purge** — true content removal after the ledger ref has been
  shared (notes-ref history rewrite + force-push + collaborator re-fetch
  coordination). This is now the *only* path for already-shared content,
  since `cledger redact` refuses it rather than pretending. Three hard parts
  scoped so far: (a) the `cat_sort_uniq` union merge means any collaborator
  still holding the old blob silently re-introduces it on their next sync, so
  purge must pair the force-push with a loud reset-don't-merge instruction
  and detection of resurrected blobs on later fetches; (b) hosts retain
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
  disk-snoop / backup-scoop risk — and it means `cledger redact --pattern`
  currently *increases* the number of plaintext copies of a secret on local
  disk, which is a surprising thing for a redaction command to do. Owner-only
  `0600` perms shipped in 0.7.1.
  **Preferred fix: store hashes, not plaintext** (see the entry below) — it
  removes the secret rather than protecting it, and needs no key at all.
  The previously-planned alternative was encryption with an OS-keychain-held
  key (macOS Keychain / libsecret / DPAPI), which must decrypt
  *non-interactively* since
  capture runs silently on every turn.
- **Store hashes of known secrets, not the secrets** — replace
  `known-secrets.json`'s plaintext `values` with salted digests plus each
  value's byte length. Capture-time scrubbing then confirms a candidate span
  by hashing it, so the store stops being a readable aggregation of every
  secret you have ever confirmed. Strictly better than encrypting it: an
  encrypted store is reversible by design (capture must decrypt silently, so
  the key has to be reachable by anything running as you), whereas a hashed
  store does not contain the secret at all — not for an attacker, and not for
  cledger. It also deletes the whole key-management problem, which is the
  reason the encryption entry above has never been done.
  *The design question is candidate generation* — you cannot search for a
  value you cannot reconstruct, so something must propose the spans to hash.
  Two options, and they compose:
  (a) **Rule-generated candidates.** Run the broad scan-tier rules purely as
  candidate *generators* and confirm each match against the stored digests.
  Cheap — O(matches × stored) — and, importantly, the noise that disqualified
  those rules from capture-time *rewriting* is harmless here, because the
  hash comparison is exact: a false-positive candidate simply fails to match
  and nothing is rewritten. Its limit is recall, and the limit bites exactly
  where this feature earns its keep: a value the store holds *because no rule
  recognized it* still generates no candidate, so it is never checked.
  (b) **Length-indexed rolling scan.** Index the digests by length and sweep
  each string with a rolling hash (Rabin–Karp), running sha256 only on a
  window whose rolling hash hits. Linear in text size per distinct stored
  length, no dependency on any rule matching, and it subsumes (a) entirely.
  More code; the honest cost.
  *Accepted limitation either way:* a digest is brute-forceable for
  low-entropy values, so human-chosen passwords remain dictionary-attackable
  while random API tokens do not. That trade is deliberate — this tool
  operates on code repositories, where the realistic secret is a generated
  token, and a leaked credential's real remedy is rotation regardless. Salt
  per-store so the file is not rainbow-table-able, and note that storing
  lengths leaks a little and makes the file a guess-checking oracle, the same
  property any password-hash file has.
  *Migration:* hash existing plaintext entries in place on first write.
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
- **Capturing file *content*, not just its digest** — `file_snapshot` records
  the pointer a source states and the sha256 the ledger read from it at
  capture time (see "What gets recorded"). That makes the record verifiable
  and survives the cache being pruned, but a consumer who no longer has the
  bytes still cannot reconstruct the file: the digest proves a copy is the
  right one, it does not produce one. Inlining the bodies is the thorough fix
  and the expensive one — unbounded ledger growth, whole source files through
  the redaction stack — so it wants a size policy and probably an opt-in
  before it ships. Raised by context-graph, which wants sub-commit file
  history and reads `~/.claude/file-history/` directly today.
- **Codex sub-agent coverage is unconfirmed** — Claude Code and opencode
  sub-conversations are both captured, each by walking the source-specific
  trail to the child (a `subagents/` sibling directory; a `task` tool part's
  metadata). Codex's `sub_agent_activity` events are recorded as `activity`,
  but whether codex writes a separate rollout for a sub-agent, and where, has
  not been confirmed — so a codex sub-agent's internal steps may still go
  unrecorded. Worth a rollout-format check before claiming parity.
- **The tail sweep is a workaround, not a fix** — a session cannot capture its
  own final lines, because the last hook runs before they are written. The
  claude-code hook therefore sweeps other transcripts in the project whose
  file grew past their cursor, which closes the gap on the *next* session in
  that repo. Two limits follow from that. A repo whose last session is never
  followed by another still ends with an uncaptured tail. And the sweep only
  considers transcripts cledger already has a cursor for, because a missing
  cursor means "never captured", not "has a gap" — so sessions predating the
  install are deliberately never adopted, and there is no backfill command
  that would adopt them on purpose either. A `SessionEnd`-with-delay would
  close the first properly; an explicit `cledger capture claude-code --all`,
  which anchors knowingly rather than silently, would close the second.

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
