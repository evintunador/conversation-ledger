# CLI integration checkpoint

Updated 2026-09-29. Work is active at the user's explicit request. This file is a
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

The current local model is Ollama `ledger-test` (sub-1B Qwen): OpenAI base
http://127.0.0.1:11434/v1, Anthropic base http://127.0.0.1:11434, dummy key ollama.
The old DeepSeek gateway is disabled; do not use its profile, ports, or headers.
Actual Ollama/OpenCode test captured prompt and linked read/result but failed
exact answer. It is not a passing live-model smoke check. Scripted providers
run the actual CLI and real tool/hook paths without relying on model ability.

## Current implementation

Eighteen adapters and native drivers are wired, including new Pi, Vibe legacy,
Copilot, Kimi, Goose, Droid, Aider, Continue, Kilo, Cline, OpenHands, Crush, and
current Rust Open Interpreter. Cursor/Kiro remain unsupported; see roster
research for authentication blockers. Vibe unified backend and historical
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

The full hosted macOS/Linux campaign passed all eighteen headless and sixteen
non-deferred interactive CLI scenarios on each platform; reports are saved in
docs/verification-evidence/hosted-*.json. Droid's public BYOK headless path was
also reverified without enterprise startup overrides. Cline's interactive
welcome flow repeatedly opened the user's browser, so interactive testing is
deferred in all campaigns, including explicit selections. Cline supports direct
API credentials and its headless check remains enabled.
Droid's public TUI asks for Factory login; the user explicitly deferred that
interactive check. Neither deferral is a parser/capture pass.
Test auth is explicitly opt-in via CLEDGER_VERIFY_DROID_FACTORY_API_KEY; no key,
account login or subscription purchase occurred. Never ask for keys in chat.

Latest full regression suite: 328 total, 316 pass, 12 explicit opt-in skips,
zero failures (/tmp/cledger-final-regression.log). Native checks ran separately.
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
code-only checkout at /tmp/cledger-ci-review/conversation-ledger. Hosted run
36628884457 passed on both macOS and Linux: eighteen of eighteen headless
scenarios and sixteen of sixteen non-deferred interactive scenarios per system.
The saved reports are in docs/verification-evidence/hosted-*.json. These are
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

The recreated agents finished source work; root is consolidating evidence.
The aggregate process exited and no matching Cline test processes remained when
checked after the user's browser interruption report.

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
Nothing is installed or enabled. No hosted repair PR bot, paid inference,
auto-merge, automatic commit or automatic push has been enabled. Review proposals remain local.
Runtime provisioning and scheduler deployment remain necessary before an
actual automatic schedule is operational.

## Guardrails

Never inspect/export this project's private ledger or real user transcripts.
All native runs use disposable synthetic homes/repos/configuration. Read
CLAUDE.md: secret-shaped fixture values need uppercase TESTONLY/FAKE/etc.
Do not inspect a push scan finding; stop and tell the human. User CLI configs
and accounts have not been changed. Preserve all existing uncommitted work.
