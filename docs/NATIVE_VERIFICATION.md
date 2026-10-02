# Native CLI verification

The ordinary test suite exercises parsers, files and Git. These commands also
launch real coding CLIs, install real capture hooks into temporary configuration
directories, and verify the resulting ledger before attempting manual backfill.
They do not use your normal sessions, configuration or credentials. These are
scripted-provider smoke checks, even when they drive a real interactive TUI.
Real-provider evidence and its separate acceptance gate are tracked in
`LIVE_VERIFICATION.md`.

## Zero-inference scenarios

```sh
npm test
npm run verify:opencode
npm run verify:qwen
npm run verify:pi
npm run verify:goose
npm run verify:claude-code
npm run verify:codex
npm run verify:gemini-cli
npm run verify:copilot
npm run verify:kimi
npm run verify:mistral-vibe
npm run verify:droid
npm run verify:aider
npm run verify:continue
npm run verify:kilo
npm run verify:cline
npm run verify:openhands
npm run verify:crush
```

Each native CLI must already be installed/on PATH. To test an isolated binary,
set `CLEDGER_VERIFY_BINARY` to its absolute path for the individual command.
Pi 0.87.1 requires Node >=22.19 even though cledger itself supports Node 20.

The scripted local provider tells the real CLI to read a freshly generated file.
The prompt does not contain the file's random value. The runner checks that the
native hook captured the human prompt, tool call/result and assistant answer in
the same session. It then requires the first manual backfill to add nothing, and a second backfill to remain unchanged. A successful parser call,
echoed prompt, or manual capture cannot repair a failed automatic-capture gate.

The HTTP fixture is a model substitute, not a fake CLI. This catches native hook
names, settings, permissions, tool schemas, transcript locations, flush order
and process-exit behavior for the exercised scenario. It does not establish
compatibility with real provider authentication, all native record types or the
interactive TUI. Reports list coverage and exclusions separately.

Verified during implementation on macOS ARM64:

| CLI | Native version | Scripted headless result |
|---|---|---|
| OpenCode | 1.18.33 | Passed automatic capture and backfill gates |
| Qwen Code | 0.24.6 | Passed automatic capture and backfill gates |
| Pi | 0.87.1 | Passed automatic capture, tool linkage, state and backfill gates |
| Gemini CLI | 0.61.0 | Passed linked tool capture and exact pre-backfill completeness |
| Claude Code | 2.1.284 | Passed automatic capture and exact pre-backfill completeness |
| Mistral Vibe | 2.25.8 | Passed legacy backend; unified backend not supported |
| Copilot | 1.0.89 | Passed exact tail capture using bounded sessionEnd worker |
| Kimi Code | 2.1.1 | Passed with bounded Stop-triggered tail worker |
| Codex | 0.159.0 | Passed Stop + SessionEnd capture, including final records |
| Goose | 1.52.0 | Passed native plugin capture and exact pre-backfill completeness |
| Droid | 0.229.0 | Passed native hooks plus bounded final-record worker |
| Aider | 0.86.2 | Passed explicit Python recorder launch, read/write evidence and final capture |
| Kilo | 7.8.1 | Passed native plugin capture and exact pre-backfill completeness |
| Continue | 1.5.47 | Passed explicit launch watcher; native hook call sites absent |
| Cline | 3.0.65 | Passed native hooks plus final-manifest worker |
| OpenHands | CLI 1.16.0 / SDK 1.21.0 | Passed native hooks and persisted records; early prompt capture is separately verified with stalled inference; SDK fails to persist its own SessionEnd event |
| Open Interpreter | Rust 0.0.45 | Passed native hooks, final tail and backfill; historical Python product excluded |
| Crush | 0.97.1 | Passed explicit wrapper and read-only SQLite snapshot capture |

These are native smoke checks, not full certification. The later hosted Linux
and interactive reports are linked below. Native verification needs subprocess and
loopback socket permissions; a restricted agent sandbox may require escalation.
Guard unit tests report skipped socket checks explicitly when bind is forbidden.

## Local model verification

The restored DeepSeek gateway is `http://127.0.0.1:9001/v1`, model
`deepseek-v4-flash`. Use guarded, bounded requests and stop on refusal; never
bypass its backend. The earlier tiny Ollama model `ledger-test` remains an
alternative at port 11434. The live matrix records which model each run used.

```sh
CLEDGER_VERIFY_ENDPOINT=http://127.0.0.1:11434/v1 \
CLEDGER_VERIFY_MODEL=ledger-test \
CLEDGER_VERIFY_API_KEY=ollama \
npm run verify:opencode:local
```

This runner accepts explicit HTTP loopback endpoints only. Its guard serializes
requests, allows at most four upstream calls, bounds sizes and deadlines, rejects
redirects and stops forwarding after the first upstream error. It never falls
back to paid providers. The API key is supplied through the environment and not
included in reports. No gateway-specific header is sent.

Ollama's Anthropic base URL is `http://127.0.0.1:11434` (without `/v1` in the
client base), with `ANTHROPIC_AUTH_TOKEN=ollama` and model `ledger-test`, per
[Ollama's documented connection settings](https://docs.ollama.com/api/anthropic-compatibility).
Responses and Chat Completions use the OpenAI-compatible `/v1` base. The tiny
model may not execute a requested tool reliably. Live model task failures must
be investigated separately from deterministic scripted-provider capture checks.

Historical evidence: before its temporary shutdown, the DeepSeek gateway passed the
OpenCode native read scenario with three requests. That is not proof for the
Ollama model. On 2026-09-29, Ollama/OpenCode captured the prompt and linked
read call/result in three requests, but the exact-answer gate failed. This live
run is not a passing smoke check; no paid fallback or retry was attempted.

## Portable campaign and schedule

```sh
npm run verify:campaign -- --output /tmp/cledger-campaign.json
# Include public GitHub stable-release observations:
npm run verify:campaign -- --upstream --output /tmp/cledger-campaign.json
```

The campaign freezes the twenty-product roster and reports unimplemented drivers
as `not-run`. It runs the implemented drivers sequentially. Set
`CLEDGER_VERIFY_<CLI_ID>_BINARY` for isolated installations, uppercasing the ID
and replacing hyphens with underscores (for example, `CLEDGER_VERIFY_PI_BINARY`
or `CLEDGER_VERIFY_GEMINI_CLI_BINARY`).
Installed adapters, passing smoke checks and full certification are different
fields. Unknown/unavailable upstream feeds do not become successful checks.
Some proprietary CLI release feeds are not configured yet.

The runner is scheduler-independent. After building this checkout, a local or
hosted scheduler can invoke the following daily:

```sh
node /absolute/path/conversation-ledger/dist/verification/campaign.js \
  --upstream --state-dir /absolute/path/cledger-verification-state
```

Persisted state enforces fourteen elapsed days between scheduled attempts, even
across month boundaries. Reports record upstream tag changes for review; failed
release fetches retain the last observed tag. An attempted campaign consumes its
scheduled slot even if blocked, avoiding automatic retry storms. Manual commands
without `--state-dir` can verify a repair immediately. Lock files prevent overlap;
after a killed runner, inspect that no run is active before removing a stale lock.

No OS scheduler, auto-upgrade, repair-PR bot or auto-merge is installed/enabled by
these commands. Those remain deployment steps after the expanded acceptance
suite is ready. Paid-provider budget enforcement also remains required before
remote inference can be enabled. Current scripted campaigns cost $0 inference.

## Attachment retention

Native cledger captures apply `text-references/1` before redaction and storage.
Known embedded UTF-8 text is decoded and retained (up to 1 MiB per embedded
attachment). Known text filenames can identify otherwise untyped input files,
but decoded bytes must still be valid UTF-8 without NUL characters. PDF, DOCX,
archives and arbitrary binary formats are not treated as plain text.

Known binary payload shapes become `attachment_reference` records inside both
normalized content and raw payloads. They retain digest, size, media type and
available native locators/metadata; embedded-only bodies explicitly state
`embedded_not_retained`. Oversized text and invalid encodings get an explicit
reason instead of silent truncation. Changed raw payloads have a
`+text-references/1` format suffix. Opaque provider reasoning is not a file and
retains its separate existing preservation contract.

The policy does not fetch remote URLs, open arbitrary mentioned paths, or decode
base64 quoted in ordinary prose. Existing source-provided text is not truncated
by the embedded-attachment limit. This is a forward capture policy, not a purge
of prior ledger entries; changed binary-bearing normalized content can have new
event IDs on deliberate recapture. No-body references cannot recover deleted
bytes on their own. Context Graph can later resolve references from available
Git objects or other evidence, but is not assumed to be an implemented resolver.


## Reproducible runtime setup

After building, `node dist/verification/runtimes.js /path/to/runtime-cache`
installs the pinned npm-distributed CLIs into separate prefixes. Optional
CLI IDs after the directory provision a subset. It uses an isolated npm HOME and
public registry, never your registry credentials or global installs. Native
package install scripts execute as part of this explicit provisioning operation.
The resulting package locks and `runtimes.json` record dependency resolution.

Use `--runtime-dir /path/to/runtime-cache` with the campaign to select these
binaries. Individual `CLEDGER_VERIFY_<CLI_ID>_BINARY` overrides take precedence.
Mistral Vibe needs a separate Python environment with `mistral-vibe==2.25.8`;
set `CLEDGER_VERIFY_MISTRAL_VIBE_BINARY` to that environment's `bin/vibe`.

The manual GitHub workflow in `.github/workflows/native-verification.yml` uses
this same runner on macOS and Linux with a pinned Annals revision. Hosted runs
provide actual per-platform evidence; the workflow alone is not proof.
It uploads reports and package locks, has no provider credentials, and does not
merge changes. Local schedulers do not require GitHub or this workflow.


## Launch-scoped capture

Aider's Markdown logs do not encode unambiguous message boundaries. Its supported
capture path is `cledger run aider [--python /path/to/python] -- <native args>`;
the selected Python environment must contain Aider. The wrapper records native
IO/model/file operations as structured events and preserves terminal IO and exit
behavior. Historical Markdown logs are not misrepresented as attributed turns.

Continue1.5.47 defines hooks without invoking them from native lifecycle code.
Use `cledger run continue [--binary /path/to/cn] -- <native args>`; its watcher runs
only for that explicit CLI process, captures same-project native snapshots and
performs a final capture on exit. Continue does not persist per-row timestamps
or durable row IDs; records explicitly state `time_basis: not_recorded`, use a
sentinel occurrence time, and keep first-observed order plus each native snapshot's
row order. Removed history remains append-only evidence. Neither wrapper turns
unwrapped sessions into automatic captures.


## Reviewing upstream package updates

`npm run verify:maintenance -- /path/to/review-output` observes current public
npm versions and writes `proposal.json` plus a concrete `runtimes.proposed.ts`
when run from a source checkout. Add `--verify-updates` to install changed versions
in separate prefixes and run their real scripted-provider drivers. Candidate runs
ignore baseline binary overrides so an old executable cannot accidentally prove
a new version works. Reports and resolved package locks stay in the review folder.

For scheduled candidate checks, add `--verify-updates` to the campaign invocation
with `--state-dir`. This uses the same fourteen-day cadence and preserves baseline
reports even when candidate provisioning fails. It does not edit the checkout,
create or merge a PR, or enable paid inference. Non-npm products still use their
source-specific release observations and manual runtime update recipes.


Crush uses `cledger run crush [--binary PATH] -- <native args>` with a read-only
`sqlite3` snapshot of the six native session tables. It needs the `sqlite3`
executable. On macOS, use upstream SQLite (`brew install sqlite`); Apple's bundled SQLite can fail to open a WAL-mode database without sidecar files.
The adapter prefers an installed Homebrew SQLite; `CLEDGER_SQLITE_BINARY` can
select another compatible binary. It never uses unsafe immutable mode on a live
database. For a custom native data directory, pass `-D/--data-dir` explicitly;
configuration that computes a different directory cannot be safely inferred.
Manual backfill accepts `cledger capture crush --database PATH` or `--all` for
default same-project discovery. Native PreToolUse alone cannot capture a final
answer, so the explicit wrapper performs bounded incremental and final captures.

Each launch-scoped capture subprocess has a 30-second deadline and its process
group is killed on timeout. Native exit status is preserved; failures warn and
retain native source files for backfill. A pending capture plus the final attempt
can add up to 60 seconds after native exit. This is bounded, not instantaneous.

The 2026-09-29 update exercise observed all eleven npm packages successfully.
Gemini 0.61.0, Qwen 0.24.6, and OpenCode 1.18.33 passed and their pins advanced.
Claude 2.1.284 and Codex 0.159.0 initially failed the strengthened unknown-record
gate. Explicit handling for their new accounting/usage records repaired the
failures; both then passed and their pins advanced. Drift gates were retained.


## Interactive terminal scenarios

Use `node dist/verification/campaign.js --mode interactive --only qwen-code,copilot,opencode,pi`
for a consistent interface. Individual verifiers that read the interactive
environment flag also support, for example,
`CLEDGER_VERIFY_INTERACTIVE=1 npm run verify:opencode`; some entrypoints do not
read that flag, so use the campaign for those CLIs.
The campaign reports an unavailable interactive driver as `not-run`, never as a
headless substitute. Interactive scheduled attempts have separate cadence state
from headless attempts. Candidate pin updates require both headless and
interactive verification against the candidate binaries before promotion.

Cline and Droid interactive checks are enabled. Cline uses an isolated external
provider configuration without browser onboarding. Droid's installed TUI requires
Factory authentication even with BYOK; an empty CI profile reports
`blocked` with `reasonCode: "login-required"` and a visible warning.
It is unverified, never a pass or an integration failure. Standalone campaign
exit codes are 0 for success, 1 for verification failure, and 2 for unmet
prerequisites. `--allow-login-required` tolerates only that specific blocker;
missing binaries, environment problems and actual failures remain nonzero.
The free interactive CI uses that option and still requires 17 actual passes.
Candidate pin updates require passing headless and interactive evidence, so a
missing login cannot qualify an untested update.

For driver debugging, pass `transcriptPath` to `runPty`, pointing to a file in
the disposable test directory. The helper writes its latest 200,000 raw terminal
characters while the CLI is running, retaining ANSI sequences and replacing old
output rather than appending indefinitely. Read that trace to inspect the actual
startup screen and repair keyboard timing or readiness matching. Trace-write
errors fail clearly and still clean up the test process group. Tracing is opt-in;
ordinary runs keep their existing final-output behavior.

OpenHands installs native session-start, prompt-submission, pre-tool, post-tool,
Stop and SessionEnd hooks. An installed-TUI regression holds the first model
request open without sending any response and requires the submitted human
prompt to appear automatically in annals while the TUI is still running.
The hosted workflow runs this check after provisioning on both operating systems;
it uses a local stalled fixture and never sends an inference request to a paid
provider. This covers the prompt-loss gap observed when a live request timed out
before the former turn-end capture path could run.

The repaired local scenarios passed for
[Qwen headless](verification-evidence/macos-repaired-qwen-code-headless-2026-09-29.json),
[Cline headless](verification-evidence/macos-repaired-cline-headless-2026-09-29.json),
[Copilot interactive](verification-evidence/macos-repaired-copilot-interactive-2026-09-29.json),
[Continue interactive](verification-evidence/macos-repaired-continue-interactive-2026-09-29.json),
[Kilo interactive](verification-evidence/macos-repaired-kilo-interactive-2026-09-29.json), and
[OpenHands interactive](verification-evidence/macos-repaired-openhands-interactive-2026-09-29.json).
These are individual macOS runs; the full hosted Linux reports are linked below.

The PTY runner uses Python3 on macOS/Linux, disposable terminal sessions, bounded
output/deadlines and process-group cleanup. Its input timing separates pasted text
from Enter; it never attaches to your real terminal. Proof and exclusions remain
source-specific (for example Pi's initial prompt arrives through argv, followed
by a real terminal session and exit). See `CLI_RECORD_COVERAGE.md` for the distinction
between native scenario proof, data-type fixtures and outstanding lifecycle work.


## Review artifacts and remaining environment requirements

The macOS headless aggregate is saved in
[`verification-evidence/macos-headless-2026-09-29.json`](verification-evidence/macos-headless-2026-09-29.json).
Droid's public BYOK entrypoint was subsequently reverified without enterprise
startup overrides; its separate
[public-headless report](verification-evidence/droid-public-headless-2026-09-29.json)
supersedes the earlier Droid startup configuration. Interactive Droid requires a
Factory account login. Its live macOS BYOK test passed with the existing normal
login and local DeepSeek; isolated CI still has no dedicated authenticated test
account. No subscription was bought. See [live evidence](LIVE_VERIFICATION.md).

The [local scheduler generator](LOCAL_VERIFICATION_SCHEDULER.md) produces launchd
and systemd artifacts without enabling them. This checkout's machine-specific
review files are in `scheduler-review/ACTIVATION.md` (gitignored). Their intended
persistent runtimes must be provisioned and checked before activation; today's
temporary proof installations are deliberately excluded. No periodic job or
auto-merge has been enabled. Maintenance produces local review proposals and
candidate evidence. A separate hosted workflow can open draft maintenance PRs
after merge and after the repository PR-creation setting is enabled; it never
merges them.

[Hosted run 36628884457](https://github.com/evintunador/conversation-ledger/actions/runs/36628884457)
passed both systems: Linux and macOS each recorded 18/18 headless and 16/16
non-deferred interactive native CLI smoke scenarios. All eighteen pinned runtimes
provisioned on both platforms. Its checked-in
[macOS headless](verification-evidence/hosted-macos-headless-2026-09-29.json),
[macOS interactive](verification-evidence/hosted-macos-interactive-2026-09-29.json),
[Linux headless](verification-evidence/hosted-linux-headless-2026-09-29.json), and
[Linux interactive](verification-evidence/hosted-linux-interactive-2026-09-29.json)
reports contain exact per-CLI gates. The run is green, but native smoke scenarios
do not certify every data type or lifecycle path; see CLI_RECORD_COVERAGE.md.


Historical 2026-09-29 regression checkpoint: 328 tests, 316 passed, 12 explicitly skipped native
opt-ins, zero failures. Separate actual CLI runs provide the native reports;
skipped opt-ins are not presented as executable proof. The private project ledger
and normal user CLI configuration were not used as test fixtures.

Latest hosted checkpoint (2026-10-02): [run 37057118602](https://github.com/evintunador/conversation-ledger/actions/runs/37057118602)
passed on both systems at commit `9842af0`: 343 tests, 330 passed, 13 explicit
opt-in skips, zero failures; the installed stalled-prompt test separately passed
with zero skips. Each OS passed 18 headless and 17 interactive native scenarios,
with one explicit Droid login blocker and zero failures. The four
`verification-evidence/hosted-*-2026-10-02.json` reports preserve exact gates.
