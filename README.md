# Conversation Ledger

Durable, attributable records of visible coding-agent conversations, stored in
your repository as git notes.

`cledger` (also installed as `conversation-ledger`) is a small standalone
utility in the unix tradition: it appends immutable JSONL evidence events to
`refs/notes/conversation-ledger`, anchored to the commit you were on when the
conversation happened. Records ride the commit DAG — merge a branch and its
conversations come along — never touch your working tree or `git status`, and
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
cledger install all    # hook capture into Claude Code + Codex CLI
```

`cledger install` adds `Stop`/`SessionEnd` hooks to `~/.claude/settings.json`
and a `Stop` hook (plus `features.hooks = true`) to `~/.codex/config.toml`,
backing both up first. From then on, every completed turn in any git
repository is captured automatically, in the same universal format. Capture is
idempotent — events are content-derived, so re-scanning a transcript never
duplicates.

Two one-time activation notes: Claude Code reads hooks at session start, so
capture begins with your next session; Codex requires you to trust new hooks
interactively — open `codex`, run `/hooks`, and approve the `cledger hook
codex` command once. Missed turns are never lost either way: `cledger capture
<source> --transcript PATH` backfills any native transcript, idempotently.

## Use

```sh
cledger log                     # events on the current branch (via commit reachability)
cledger log --all --json        # every event, as JSONL for jq & friends
cledger conversations           # sessions touching this branch
cledger show claude-code:3f9a   # replay one conversation in order
cledger export > ledger.jsonl   # lossless dump, incl. source-native payloads
cledger sync                    # explicit fetch/merge/push of the ledger ref
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

## Adapters

Supported today (built-in, hook-based, per-turn):

| Source | Trigger | Transcript store | Notes |
|---|---|---|---|
| Claude Code CLI | `Stop`/`SessionEnd` hooks | `~/.claude/projects/*/*.jsonl` | Also covers the VS Code extension and JetBrains plugin (both share `~/.claude/settings.json` hooks and transcripts), and desktop-app local/SSH/WSL sessions. Cloud "Remote" sessions and the Cowork tab run server-side — not captured. |
| Codex CLI | `[[hooks.Stop]]` hooks engine | `~/.codex/sessions/**/rollout-*.jsonl` | Same config + session store is shared by the Codex desktop app and IDE extension, so their local sessions should capture too — but OpenAI has open bugs on the desktop app's config loading, and third-party reports say hooks may not fire from IDE sessions. Treat non-CLI surfaces as best-effort; `cledger capture codex` backfills any rollout file regardless of which surface wrote it. Cloud tasks run server-side — not captured. Inter-agent messages (`agent_message`) are captured with their visible text; their encrypted blocks are never stored, same policy as reasoning. |

TODO adapters, roughly in order of how ledger-friendly their storage/hook
story looks (all have local session stores; most grew Claude-Code-style hook
systems):

- **Gemini CLI** — JSON chats under `~/.gemini/tmp/<hash>/chats/`; documented hooks.
- **Kimi CLI** — `~/.kimi-code/` sessions; Claude-Code-inspired lifecycle hooks.
- **GitHub Copilot CLI** — `~/.copilot/session-state/`; documented hooks dirs.
- **Factory droid** — `~/.factory/` sessions; `hooks.json`.
- **Qwen Code** — `~/.qwen/projects/*/chats/`; hooks system.
- **opencode** — SQLite under `~/.local/share/opencode/`; plugin-API events rather than shell hooks.
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

**Sync-time scan** (default on, tiered): Before any push, scans only new events with medium/high-precision rules (capture ruleset re-run, keyword assignments like `password=`, URL credentials). Findings abort the ledger push with a report and remediation instructions; in the pre-push hook, a finding holds back only the ledger and lets your code push proceed unless `{"transport": {"strict": true}}`.
- Threat addressed: secrets from older capture rules or new tool formats slipping through.
- Cost of disabling: `{"scan": {"tier": "off"}}` — secrets in tool output push silently.
- Remediation paths: `cledger redact <event-id>` (real secrets), `cledger allow <fingerprint>` (false positives), `cledger sync --no-scan` (bypass once). `--paranoid` tier adds entropy-based detection (noisier but broader).

### Commands

`cledger redact <event-id> (--pattern REGEX | --all) [--reason TEXT]`: Rewrites stored event to placeholder + audit metadata, appends a `redaction` event, and squashes local notes history so prior content is unrecoverable (pre-push only; post-push purge tooling is planned, not yet built).

`cledger scan [--paranoid]`: Standalone check with exit 1 on findings — CI-friendly.

### Maximum safety recipe

Keep all defaults (capture and sync scan on), add repo-specific patterns in `.cledger.json` for domain-specific secrets, enable env masking only if `.env` holds secrets (not config), run `cledger scan` in CI, and treat `--no-scan` as a deliberate exception you document.

## Roadmap

- **Path-based capture exclusion** — the path half of the redaction config
  ("never record reads of `secrets/**`"); requires correlating `tool_use`
  file paths with their `tool_result` events.
- **Post-push purge** — true content removal after the ledger ref has been
  shared (force-push + collaborator re-fetch coordination); the local
  pre-push squash shipped with `cledger redact`.
- **`re-anchor`** — reattach events orphaned by squash merges or history
  rewrites. The desired end state is that this happens by default: a squash
  commit should end up carrying the conversations of the branch it squashed.
  Hard part: squashes often happen off-machine (GitHub "Squash and merge"),
  so detection needs patch-id/branch-tip matching after fetch, not a local
  hook.
- **Harness-artifact capture** — decide whether the ledger should also
  preserve valuable non-git-controlled agent artifacts that normally die
  with a worktree or live outside the repo (e.g. Claude Code auto-memory
  directories, session state). They fit the `document` kind; the question is
  scope and capture triggers.
- **Format-drift: raw preservation** — adapters now count and warn about
  transcript line types they don't recognize (the detection half shipped in
  0.4.0), but those lines are still not stored. Possibly preserve them
  raw-only so a later adapter version can re-normalize them.
- **Purge tooling** — true content removal behind a `redaction` event.
- **Sub-turn citation anchors** for downstream consumers like intent-recall.

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
