# Conversation Ledger

Durable, attributable records of visible coding-agent conversations, stored in
your repository as git notes.

`cledger` (also installed as `conversation-ledger`) is a small standalone
utility in the unix tradition: it appends immutable JSONL evidence events to
`refs/notes/conversation-ledger`, anchored to the commit you were on when the
conversation happened. Records ride the commit DAG — merge a branch and its
conversations come along — never touch your working tree or `git status`, and
only leave your machine when you explicitly `cledger sync`.

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
cledger sync                    # explicit opt-in fetch/merge/push of the ledger ref
echo '{"kind":"decision",...}' | cledger append   # any tool can write events
```

## Adapters

Supported today (built-in, hook-based, per-turn):

| Source | Trigger | Transcript store | Notes |
|---|---|---|---|
| Claude Code CLI | `Stop`/`SessionEnd` hooks | `~/.claude/projects/*/*.jsonl` | Also covers the VS Code extension and JetBrains plugin (both share `~/.claude/settings.json` hooks and transcripts), and desktop-app local/SSH/WSL sessions. Cloud "Remote" sessions and the Cowork tab run server-side — not captured. |
| Codex CLI | `[[hooks.Stop]]` hooks engine | `~/.codex/sessions/**/rollout-*.jsonl` | Same config + session store is shared by the Codex desktop app and IDE extension, so their local sessions should capture too — but OpenAI has open bugs on the desktop app's config loading, and third-party reports say hooks may not fire from IDE sessions. Treat non-CLI surfaces as best-effort; `cledger capture codex` backfills any rollout file regardless of which surface wrote it. Cloud tasks run server-side — not captured. |

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

## Roadmap

- **Secret redaction at capture** — detect/scrub API keys and credentials in
  tool output before events are written; the highest-priority open item.
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
- **Format-drift resilience** — adapters currently skip transcript line
  types they don't recognize, so a harness update that introduces new
  message types would silently leave that content uncaptured (see
  "Versioning" in the design doc). At minimum: count and warn about
  skipped-but-substantive lines; possibly preserve them raw-only.
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
