# CLI integration checkpoint

Updated 2026-10-03. Work is active at the user's explicit request. This file is a
checkpoint, not a completion claim. Changes remain uncommitted in this checkout.

## Scope and constraints

Twenty-product roster in `src/verification/roster.ts`: ten big players and ten
independents, settled by the user. Target macOS/Linux and headless/interactive.
Prefer native hooks/plugins; launch-scoped watchers are acceptable. Keep known
text attachments and references for binary bodies, not their embedded bytes.
Future Context Graph may resolve surviving locators; no recovery promise for
unretained embedded-only data. Paid ceiling $5/CLI initial and $5/CLI/month,
target much lower. Current scripted-provider tests spend $0 on inference.
Maintenance every fourteen elapsed days, review first, auto-merge later.

The user restored local DeepSeek. The gateway at http://127.0.0.1:9001/v1
advertises `deepseek-v4-flash`; use bounded local guards, serial inference, and
stop on capacity refusal or an unavailable gateway without bypassing its backend.
It went offline during Copilot's first DeepSeek attempt, then returned at the
user's request. Droid, OpenCode, Pi, Copilot, Qwen, Crush, OpenHands and Open
Interpreter have passing real DeepSeek TUI evidence. Nineteen of the selected
twenty CLIs now have installed macOS live-model TUI canary passes. Cursor's
native tool hooks capture confirmed known-text Read bodies; ambiguous matches
remain references. Its real two-read TUI proof and stable-backfill regressions
are recorded separately. Kimi folder trust was accepted through the real TUI;
its repaired-guard attempt stopped on upstream HTTP 503 after one request.
Independent installed Kimi input and resume tests pass. A separate Linux actual
TUI using free local Qwen3:8b now passes prompt, linked Read/result, answer and
normal exit in two requests (36 automatic events). Thus all twenty selected
products have a live TUI canary on at least one OS; full certification remains
unclaimed. No retry followed the macOS refusal.
Ollama `ledger-test` (sub-1B Qwen) at http://127.0.0.1:11434 remains the earlier
test route. Scripted-provider evidence and real-model evidence remain distinct.

## Current implementation

Twenty adapters are wired, including new Pi, Vibe legacy,
Copilot, Kimi, Goose, Droid, Aider, Continue, Kilo, Cline, OpenHands, Crush, and
current Rust Open Interpreter, Cursor and Kiro. The free scripted campaign still
has eighteen drivers; Cursor/Kiro have separate real-provider macOS evidence in
LIVE_VERIFICATION.md. Vibe unified backend and historical
Python Open Interpreter are not covered by these adapters.

Aider/Continue/Crush use explicit launch wrappers. Aider instruments structured
Python IO/model/file operations, never parses Markdown speaker guesses. Continue
watches its native session snapshots, which lack row timestamps and durable IDs;
first-observed order and snapshot source order are explicit. Crush reads six
native SQLite tables read-only, needs sqlite3, and requires explicit native
-D/--data-dir for custom configured data directories. Shared capture subprocesses
are bounded to 30 seconds, including descendant process groups; native exit
status and signals are preserved. Native files remain available for backfill.

Attachment retention applies before hashing/storage to normalized content and
raw. Known UTF-8 text <=1 MiB is retained; binary/oversized/invalid data gets
references with digest, byte count, MIME, reason and native locators. Ciphertext
reasoning is separate; its normalized identity must include a digest since
Annals excludes raw from event identity. No purge of previously stored bytes.

Multi-event renormalization supports visible/sealed siblings. Unknown native
records/parts must remain explicit unrecognized evidence and fail native drift
gates; preserving them only as an ordinary turn is insufficient. Recent repairs
cover Gemini malformed WAL records, snapshot members, settled replacements and
missing timestamps; shared GenAI part validation; Continue encrypted metadata;
Aider automatic decisions/model attribution; Cline unknown-part replay.

## Current evidence and remaining environment requirements

The latest full hosted macOS/Linux campaign passed eighteen headless and seventeen
interactive CLI scenarios on each platform, with zero failed checks and one
explicit Droid login blocker per interactive campaign. Older reports remain in
docs/verification-evidence/hosted-*.json. Droid's public BYOK headless path was
also reverified without enterprise startup overrides. Both Cline and Droid
interactive checks are now enabled. Cline's isolated direct-provider TUI passed
without browser onboarding. Droid's existing normal login reaches its BYOK TUI;
empty CI profiles instead report a visible `blocked: login-required` warning.
Free interactive CI tolerates that auth prerequisite but requires 17 real
scripted-provider passes; blocked evidence never counts as coverage or qualifies
a candidate update. Dedicated CI test auth remains opt-in via
CLEDGER_VERIFY_DROID_FACTORY_API_KEY. Never ask for keys in chat.

Hosted baseline run 37066682656 passed on macOS and Linux at commit
3a76137. The expanded input/lifecycle checks added here require a new hosted
run; local consolidated regression testing passed 353 tests with 16 explicit
opt-in skips. Native checks run separately, including the installed stalled-prompt
regression on both systems.
Review fixes added heartbeat lock recovery for Continue (proper-lockfile),
Gemini malformed-container preservation and bounded post-hook tail capture,
scoped TOML feature configuration, orphan-process cleanup, verification signal
cleanup and failing scheduler status for unsuccessful update candidates.

Latest verified pins: Claude2.1.284, Codex0.159.0, Gemini0.61.0, Qwen0.24.6,
OpenCode1.18.33. New Claude accounting records and Codex token_usage_record
initially failed drift gates and were explicitly mapped/tested before promotion.
Other versions and per-source exclusions are in NATIVE_VERIFICATION.md and
CLI_RECORD_COVERAGE.md. Full certification remains unclaimed: broader native lifecycle/data-type proof
is separate from these read/write smoke tests.

The user chose GitHub Actions if free, otherwise a local Linux VM. This repository
is public, so standard hosted runners are eligible for free compute. Draft PR
https://github.com/evintunador/conversation-ledger/pull/26 is open from an isolated
code-only checkout at /private/tmp/cledger-ci-review. Hosted run
37066682656 passed on both macOS and Linux at commit 3a76137. The latest
reports are its GitHub Actions artifacts; older saved reports remain in
docs/verification-evidence/hosted-*.json. These are
native CLI smoke passes, not complete proof of every record type or lifecycle.
The hosted maintenance workflow can prepare a draft review PR every other Monday
after merge; the repository PR-creation setting is enabled. It checks baseline
CLIs on both systems, changed npm candidates in both modes on Linux, and observed
non-npm releases. It dispatches the full matrix on each proposal branch and
never auto-merges or uses paid inference. Candidate
packages run without repository write credentials; a separate publisher validates
exact code-only pin changes. The local 14-day scheduler remains disabled.
Source changes in this original checkout remain uncommitted. Defer subscription-
gated verification; do not repeat login/browser flows or ask the user to buy plans.

Real TUI sessions also exposed missing early OpenHands capture. Native hooks now
include session start, prompt submission and pre/post-tool events. Hosted checks
stall the installed TUI's first model request and require automatic human-prompt
capture before any response, exit or backfill. Cline/Copilot wait for assistant
completion and follower settlement before exporting evidence. Crush submits Enter
without matching terminal-repaint fragments; linked exact-result gates remain
unchanged. Optional bounded PTY traces make startup and approval failures visible.

## Maintenance

`verification/maintenance.ts` checks npm latest, writes proposal.json and a
concrete proposed runtime source, optionally provisions/verifies candidates in
isolated prefixes. Candidate runs ignore baseline binary overrides. Campaign
state enforces fourteen days and retains baseline reports on candidate failure.
Non-npm products have release observations and portable pinned runtime recipes
in native-runtimes.ts, verified separately from automatic version promotion.
Fresh locked Aider/OpenHands native checks and Crush download/hash/version probes
passed locally; all eighteen pinned runtime recipes were provisioned successfully
on both hosted operating systems in run 36588451942.
A portable scheduler generator now produces reviewed launchd/systemd artifacts
and a credential-isolated runner. Machine-specific files are in scheduler-review/
(gitignored), with intended persistent runtimes explicitly unprovisioned.
Local scheduler deployment remains disabled. The hosted maintenance workflow is
prepared in draft PR #26 and becomes operational after merge; its repository
PR-creation setting is enabled. Paid inference and auto-merge remain disabled.
A manual budgeted workflow, persistent authority and first OpenCode consumer are
implemented but disabled. Other consumer/protocol coverage remains pending;
activation requires reviewed pricing bounds, durable HTTPS hosting and protected
environment approval. No paid requests have been made.

## Guardrails

Never inspect/export this project's private ledger or real user transcripts.
All native runs use disposable synthetic repositories and test content. Scripted
runs isolate homes/configuration; some authorized live runs use existing normal
account authentication without reading or exporting credentials. Read
CLAUDE.md: secret-shaped fixture values need uppercase TESTONLY/FAKE/etc.
Do not inspect a push scan finding; stop and tell the human. User CLI configs
and accounts have not been changed. Preserve all existing uncommitted work.

## Broader installed TUI conformance

Claude Code, Codex and OpenCode passed the eight selected macOS cases: multiline
Unicode, actual read error, UTF-8 read, image references, native image entry,
resume, unknown-record detection and two idempotent backfills. Actual Claude
editor attachment entry exposed and repaired a shared binary-retention gap.
See CORE_CONFORMANCE.md for commands, evidence and the remaining cases; this
is subset verification, not full certification.
