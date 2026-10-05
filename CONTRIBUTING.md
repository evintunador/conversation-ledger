# Contributing

Contributions should preserve visible conversation evidence across coding CLIs,
including the records around a turn, not just its final answer. Start with the
[README](README.md), [record coverage map](docs/CLI_RECORD_COVERAGE.md), and
[fixture rules](CLAUDE.md).

## Scope a change

When adding a feature, preferably implement it for **all applicable CLIs**.
Check the whole [roster](src/verification/roster.ts), including Claude Code,
Codex and OpenCode. If an integration cannot support the feature yet, open an
issue for each uncovered CLI (or a tracking issue with an explicit per-CLI
checklist), link it in the PR, and document the limitation in the coverage map.
Explain whether the upstream CLI does not expose the data, the implementation is
missing, or verification is blocked. Do not count those cases as support.

For a bug report, include the CLI/version, OS/architecture, capture method,
headless or interactive mode, reproduction steps, expected/observed records,
and a sanitized synthetic example. Never attach account credentials or private
conversation logs. For larger changes, an issue describing the behavior and
affected CLIs helps establish scope before implementation.

## Development setup

Use sibling checkouts because the local Annals dependency is `file:../annals`:

```sh
git clone https://github.com/evintunador/annals
git clone https://github.com/evintunador/conversation-ledger
cd annals
npm ci
cd ../conversation-ledger
npm ci
npm run build
```

Node 20+ runs cledger. Use Node **22.19+** for the full native campaign because
some tested CLIs require it. macOS and Linux are the current target platforms.
Native tests need Git, Python 3 for the PTY driver, process execution and loopback
sockets; SQLite-backed integrations also need `sqlite3`. The optional OpenCode
native ripgrep conformance backend additionally needs `rg`. Full provisioning needs
network access and `uv` for the pinned Python environments. See the
[hosted workflow](.github/workflows/native-verification.yml) for the exact setup
and Annals revision used by CI.

Create a branch and keep changes focused. Follow the existing TypeScript style;
`npm run build` is the type check. Avoid adding a shared abstraction before more
than one adapter actually needs it. Annals owns storage, event identity,
redaction and Git transport; CLI-specific normalization belongs here.

## Test levels

These levels answer different questions. Fixture tests do not replace installing
the CLI, and a headless pass does not replace driving its normal TUI. Record the
levels actually run and their exclusions in your PR.

| Level | What it checks | Model cost |
| --- | --- | --- |
| 1. Fixture and repository tests | Parsing, normalization, retention, Git behavior, malformed/unknown input and regressions | None |
| 2. Installed headless smoke | Real binary, configuration, native hooks/watchers, tool execution and persisted evidence | None with scripted provider |
| 3. Installed interactive smoke | Real TUI startup, typed input, approvals, terminal behavior and automatic capture | None with scripted provider |
| 4. Live provider verification | Installed CLI using an actual model/account, in separately recorded headless and TUI modes | Local inference or explicitly approved usage |
| 5. Record and lifecycle verification | Broader supported input/output types, resume/forks, failures and platform-specific behavior | Depends on scenario |

The [installed core conformance guide](docs/CORE_CONFORMANCE.md) gives executable
level-5 commands for Claude Code, Codex and OpenCode, including actual image
entry and resume. The [budgeted live guide](docs/BUDGETED_LIVE_VERIFICATION.md)
explains the disabled-by-default paid tier, exact approvals and durable budgets.
Its first automated consumer is OpenCode; unsupported consumers must remain
explicit gaps.

### 1. Fixture and repository tests

```sh
npm test
# Faster iteration on a focused change, after rebuilding:
npm run build
node --test dist/test/verification-kimi.test.js
```

Add tests for meaningful behavior and failure cases. Extend the owning adapter's
tests for newly observed native records, rather than inventing a shape from
documentation alone. Native opt-in tests are explicitly skipped in the ordinary
suite when their binary environment variable is absent; a skip is not executable
evidence. Existing fixtures and temporary Git repos must remain synthetic.

### Provision installed runtimes for levels 2 and 3

Use pinned isolated installations instead of changing global packages:

```sh
node dist/verification/runtimes.js /tmp/cledger-npm-runtimes
# A subset is allowed, for example:
node dist/verification/runtimes.js /tmp/cledger-npm-subset opencode kimi
node dist/verification/native-runtimes.js /tmp/cledger-native-runtimes
```

The first command installs npm-distributed CLIs. The native provisioner installs
the pinned Python/native products and writes `native-runtimes.env`; use its
reported absolute paths as `CLEDGER_VERIFY_<CLI_ID>_BINARY` overrides. Do not
blindly source arbitrary downloaded files. Mistral Vibe is provisioned separately:

```sh
uv venv --python 3.12 /tmp/cledger-vibe
uv pip install --python /tmp/cledger-vibe/bin/python mistral-vibe==2.25.8
export CLEDGER_VERIFY_MISTRAL_VIBE_BINARY=/tmp/cledger-vibe/bin/vibe
```

Names use uppercase roster IDs with hyphens replaced by underscores, such as
`CLEDGER_VERIFY_OPENHANDS_BINARY`. Native packages execute install scripts during
provisioning. Versions, platform asset digests and Python locks live in
[runtimes.ts](src/verification/runtimes.ts),
[native-runtimes.ts](src/verification/native-runtimes.ts),
[native-assets.ts](src/verification/native-assets.ts), and
[verification/requirements](verification/requirements).

### 2. Installed headless smoke

```sh
node dist/verification/campaign.js \
  --runtime-dir /tmp/cledger-npm-runtimes \
  --only opencode,kimi \
  --output /tmp/cledger-headless.json

# Individual verifier, using a binary already on PATH:
npm run verify:kimi
# Or select an isolated binary for that individual command:
CLEDGER_VERIFY_BINARY=/absolute/path/to/kimi npm run verify:kimi
```

The campaign is headless by default. Omit `--only` to attempt the full roster;
provide the native binary overrides and Vibe environment above for a full run.
The [native guide](docs/NATIVE_VERIFICATION.md#zero-inference-scenarios) lists
individual scripts; `npm run verify:open-interpreter` covers the current Rust CLI.
Campaign IDs and npm script names sometimes differ: the roster ID `qwen-code`
uses `npm run verify:qwen`.

The installed CLI talks to a scripted loopback provider and reads a randomly
generated file whose value is absent from the prompt. Passing requires automatic
human prompt, linked tool call/result and answer evidence in the same session
**before manual backfill**. Backfill must then be idempotent. A fixture-provider
reply alone or a repaired ledger does not qualify.

### 3. Installed interactive smoke

```sh
node dist/verification/campaign.js \
  --runtime-dir /tmp/cledger-npm-runtimes \
  --mode interactive --only opencode,kimi \
  --output /tmp/cledger-interactive.json

CLEDGER_VERIFY_INTERACTIVE=1 npm run verify:opencode
```

The PTY driver launches the real TUI, types the prompt and follows observed
readiness/approval/exit screens. It is not a headless invocation dressed up as
interactive. When it fails, inspect the actual synthetic terminal output, CLI
help and native records. ANSI repainting and startup timing can invalidate a
driver's assumptions; do not loosen capture gates to make a driver pass.
For live debugging, the [PTY helper](src/verification/pty.ts) accepts an optional
`transcriptPath` in the disposable directory and writes a bounded terminal trace.
Use the campaign's `--mode interactive` for a consistent interface across CLIs;
some individual verifier entrypoints do not read `CLEDGER_VERIFY_INTERACTIVE`.

To run the installed OpenHands early-capture regression separately:

```sh
CLEDGER_VERIFY_OPENHANDS_BINARY=/absolute/path/to/openhands \
node --test --test-name-pattern='OpenHands installed TUI captures submitted prompt' \
  dist/test/verification-openhands.test.js
```

This deliberately stalls the first model request and checks that the submitted
prompt is already in annals while the TUI is running, before any model response
or backfill. Allow about two minutes for its deliberate timeout and cleanup.

Campaign exit codes: `0` success, `1` verification failure, `2` unmet
prerequisites. Missing login is a loud `blocked` result, not a pass. An absent
driver is `not-run`. `--allow-login-required` permits only that specific auth
blocker to exit successfully; it does not add coverage or qualify a pin update.
Droid's interactive BYOK route still needs Factory authentication. Supply a
dedicated test key through `CLEDGER_VERIFY_DROID_FACTORY_API_KEY` if appropriate,
never through a report or PR comment.

The [free GitHub workflow](.github/workflows/native-verification.yml) runs these
levels on macOS/Linux with real pinned installations and uploads reports. A
maintainer can dispatch it with `gh workflow run native-verification.yml --ref
YOUR_BRANCH`, then inspect the completed run and artifacts. Workflow configuration
without a completed run is not evidence.

### 4. Live provider verification

The generic campaign uses scripted providers; setting a model environment
variable does not turn it into live verification. The existing guarded OpenCode
live runner supports local HTTP loopback models:

```sh
CLEDGER_VERIFY_ENDPOINT=http://127.0.0.1:11434/v1 \
CLEDGER_VERIFY_MODEL=ledger-test \
CLEDGER_VERIFY_API_KEY=ollama \
npm run verify:opencode:local

# Add CLEDGER_VERIFY_INTERACTIVE=1 for its live TUI scenario.
```

Other CLIs currently require a separately prepared live session; there is no
universal live campaign or implemented paid-provider CI tier. Use the installed
CLI's actual provider settings, not guessed environment variables. Prefer a
local model or BYOK route, keep bounded requests/tokens/timeouts, and never
silently fall back to a paid provider or bypass a gateway refusal. Subscription
and account-credit sessions need their own reviewed budget. See the
[live guide](docs/LIVE_VERIFICATION.md#cost-and-execution-tiers).

For a manual or computer-driven session:

1. Create a disposable Git repo and random text canary, with transport disabled
   in its `.cledger.json` (`{"transport":{"hook":false,"fetchRefspec":false}}`).
   Isolate the CLI's home/config/data directories using its supported settings;
   do not inspect or export real user transcripts. Make the built `cledger`
   command available on that test session's PATH.
2. Install `cledger install <source>` hooks in that isolated configuration.
   For wrapper-based capture, use `cledger run aider --python PATH -- ...`,
   `cledger run continue --binary PATH -- ...`, or
   `cledger run crush --binary PATH -- --data-dir PATH`. Default Kiro V2 uses
   `cledger run kiro -- chat ...`; follow the coverage map for Cursor/V3 details.
3. Open the ordinary TUI, handle its real trust/auth screens within the approved
   test scope, and type a unique marker plus a request to read the canary and
   reply with its contents. Keep the canary's value out of the prompt.
4. Exit normally. In **that disposable repo**, inspect `cledger export --all`
   before any `cledger capture` call. Require the human marker, successful linked
   read result and answer containing the canary in the same conversation. Check
   normalized fields, not only preserved raw data. Verify any native follower
   finished; inspect full ledger records if command output is truncated.
5. Run the adapter's supported backfill twice and compare event identities;
   neither run should add or duplicate records from the completed scenario.
   Preserve sanitized evidence: CLI version, platform, provider/model, mode,
   request/usage limits, gates, exit behavior and remaining gaps. Record earlier
   failed attempts too. Do not store credentials or private terminal traces.

A live headless pass and a live TUI pass are separate results. A model failing to
use the tool, missing native result bodies or an uncompleted trust/login flow is
an explicit gap. Do not claim a live pass from a scripted scenario.

### 5. Record and lifecycle verification

Use the [coverage map](docs/CLI_RECORD_COVERAGE.md) to plan native scenarios for
each feature: human/assistant/system text, tool arguments/results/errors,
attachments, reasoning, model/provider metadata, usage, permissions, session
state, interruption/stalled requests, resume/forks and subagents where supported.
Exercise installed headless and TUI modes on both OSes as applicable. Obtain the
actual emitted formats, add sanitized fixtures, and check automatic capture,
ordering/linkage, replay identity and renormalization. There is no single command
that currently proves all of these; list what was exercised and open issues for
the rest. A file-read smoke pass is not full certification.

Retain known UTF-8 text within the retention limit. Binary, invalid or oversized
bodies become references with available locators/digests/metadata; do not embed
their bytes in annals. Preserve missing provenance as missing, and retain unknown
or malformed records as explicit unrecognized evidence instead of dropping them.
For attachment changes, explicitly cover known text formats, image/audio/video
or other binary inputs, invalid encodings, oversized bodies and external file
references where the CLI supports them. Check both normalized and retained raw
content, so binary bytes cannot survive in a second representation. Document
types the native CLI cannot expose instead of inferring support from text tests.

## Add a new CLI

1. **Inspect and run the product.** Install an exact version, identify its native
   hooks/plugins, configuration roots, transcript format and permissions, and
   observe both ordinary TUI and headless sessions. Prefer native hooks/plugins;
   use an explicit launch-scoped watcher if necessary. An import-only adapter
   supports manual backfill but does not provide automatic session capture.
2. **Implement capture and replay.** Add `src/adapters/<id>.ts` following the
   closest observed architecture, not just a similarly named product. Preserve
   actor/session/parent/tool links, ordering, model metadata, raw provenance and
   supported data types. Use shared retention and drift handling. Ensure replay
   is idempotent and unknown records can be renormalized later.
3. **Wire the public paths.** Update `src/install.ts` for supported native hooks
   or plugins, `src/cli.ts` for hook/capture/launcher routing, `src/index.ts` for
   public exports, and `src/renormalize.ts` for replay. Respect configuration
   overrides, preserve unrelated settings, and keep launcher exit/signal behavior.
   Only register installation for a path the CLI actually supports.
4. **Add reproducible verification.** Add its roster entry, pinned runtime recipe
   and portable asset/lock data as applicable; implement
   `src/verification/<id>.ts`, register it in `campaign.ts` and its interactive
   driver set when implemented, and add the npm script. Use the shared isolated
   process/provider/guard/PTY helpers. Require real linked evidence before any
   backfill, drift detection, normal exit, follower completion and replay identity.
   Keep absent drivers/auth prerequisites explicit. Update coverage denominators
   and hosted minimum-pass checks deliberately when changing the roster.
5. **Prove and document it.** Add fixture, installer and failure-path tests. Run
   installed headless and TUI checks on macOS/Linux, then a budgeted live scenario
   when available. Update the README, native/live guides and coverage map with
   versions, exclusions and evidence links. Open issues for missing record types,
   modes, providers or platforms instead of declaring complete support.

## Submit a PR

For npm pin updates, prepare a concrete proposal and optionally verify changed
packages in isolated prefixes:

```sh
npm run verify:maintenance -- /tmp/cledger-update-review
npm run verify:maintenance -- /tmp/cledger-update-review --verify-updates
```

Review `proposal.json`, `runtimes.proposed.ts` and `candidate-results.json`.
That command verifies candidates headlessly; also run the interactive campaign
against `/tmp/cledger-update-review/candidate-runtimes`, selecting only the
changed IDs with `--only`. Clear any `CLEDGER_VERIFY_<CLI_ID>_BINARY` overrides
first so the campaign uses the candidate, not a baseline installation. Non-npm
updates need their pinned asset/lock recipe and separate release review. See the
[update guide](docs/NATIVE_VERIFICATION.md#reviewing-upstream-package-updates).

Describe the concrete behavior change, affected CLIs, verification levels,
versions/platforms, results and linked gap issues. Include sanitized evidence
for native changes. Keep core Claude Code/Codex/OpenCode compatibility in view
when changing shared code. Update documentation and CLI help with user-visible
changes. Upstream pin changes must verify the candidate binary in both modes;
a passing baseline is insufficient. Maintenance proposals remain review-first.

Read [CLAUDE.md](CLAUDE.md) before writing secret-shaped fixtures. Put uppercase
`FAKE`, `EXAMPLE` or `TESTONLY` inside fake values. Format-valid token fixtures
belong in Annals' split secret corpus. If a push scan finds content, stop and
tell the human; do not read it into an agent conversation. This repository can
capture its own development conversations, so never use its private ledger as
a test fixture. Prefer disposable repos and keep generated runtimes, homes and
raw traces out of commits.

### Repeat Kimi against an explicitly selected local model

The individual runner supports the same actual native TUI, isolated configuration,
automatic evidence gates and two backfills with a real loopback model:

```sh
CLEDGER_VERIFY_BINARY=/absolute/path/to/kimi \
CLEDGER_VERIFY_INTERACTIVE=1 \
CLEDGER_VERIFY_ENDPOINT=http://127.0.0.1:11434/v1 \
CLEDGER_VERIFY_MODEL=ledger-test \
CLEDGER_VERIFY_API_KEY=ollama \
node dist/verification/kimi.js
```

Specify both endpoint and model; the runner has no inferred provider or paid
fallback. Forwarding is limited to four requests, 1024 output tokens per request,
180 seconds per request and 360 seconds per interactive session. It stops after
an upstream failure and reports a blocker; successful real-model evidence is
labeled `configured-loopback`, separately from the scripted campaign. A tiny
model may fail tool selection; that is a failed live check, not parser proof.
Omit endpoint/model for the existing zero-inference scripted verifier. The free
campaign always calls that scripted mode. Folder trust applies only to its
disposable synthetic repository. Use a local service you know is unmetered; paid
verification requires the separately approved budget tier.
