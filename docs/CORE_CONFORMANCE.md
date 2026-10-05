# Installed CLI and TUI conformance

The [support matrix](SUPPORT_MATRIX.md) tracks all 20 supported CLIs, both
headless and interactive modes, on macOS and Linux, at pinned versions. It is
the closure ledger for [issue #27](https://github.com/evintunador/conversation-ledger/issues/27).
A native smoke pass or fixture regression cannot close an installed input or
lifecycle case. Historical evidence at other versions remains visible.

`src/verification/conformance.ts` launches real installed binaries in disposable
native homes/configs and synthetic Git repositories. A bounded loopback provider
requests real native tools; it never writes native transcript fixtures or makes
real model requests. Interactive scenarios drive the actual terminal editor;
headless scenarios use the documented native prompt interface. Reports record
the input method and compare actual persisted automatic ledger events before
any manual repair. No user transcript or account credential is inspected.

```sh
npm run verify:conformance -- --runtime-dir /tmp/cledger-runtimes \
  --output-dir /tmp/cledger-conformance \
  --only claude-code,codex,opencode,gemini-cli,qwen-code,pi,kilo,copilot,kimi
# Add --mode headless or --mode interactive to select one interface.
```

Provision npm runtimes with `node dist/verification/runtimes.js /tmp/cledger-runtimes`.
For other runtimes, select an absolute path with
`CLEDGER_CONFORMANCE_<CLI_ID_IN_UPPERCASE_WITH_UNDERSCORES>_BINARY`.
The opt-in `dist/test/verification-conformance.test.js` runs both modes for each
selected binary. Unset variables skip installed tests explicitly; this is not a
support claim. The campaign lists absent drivers as `not-run` and exits nonzero
for unresolved cases. Missing runtimes never become silent passes.

A sandbox must permit native processes and loopback sockets. For one installed
scenario, use `CLEDGER_VERIFY_BINARY=/absolute/path/to/gemini node
dist/verification/conformance.js gemini-cli --mode interactive --retain`.
`--retain` keeps only the synthetic diagnostic home, ledger and terminal traces
for local debugging; normal runs remove them. Do not commit raw terminal traces
or native configuration homes. Commit summarized conformance reports and retain
reproducible CI artifacts instead.

Each implemented scenario:

- Bracket-pastes multiline Unicode into the native editor, checking normalized
  human text rather than terminal echo.
- Executes a real missing-file read and checks its linked native error result.
- Reads a known UTF-8 text file and checks its linked result retains the canary
  and Unicode text.
- Uses native image input/output: Codex's installed `--image` entry, Claude and
  OpenCode's native image read and resumed editor `@image` entry. It checks
  references across normalized and raw records, including nested carriers.
- Exits, relaunches native `--continue`/`resume --last`, enters another multiline
  turn, and requires a new captured answer in the original stream.
- Compares two supported manual backfills with the completed automatic ledger;
  neither may add or duplicate records. Codex uses its documented transcript
  backfill rather than an unsupported `--all` call.

Actual editor attachment processing exposed readiness differences: Claude needs
an extra Enter after its attachment loads; OpenCode's file autocomplete needs
selection followed by submission. OpenCode 1.18.33 requires opening the `@`
menu through keyboard input and typing the filename separately from the pasted
body; pasting everything at once selected the default `@explore` agent instead
of attaching the image. The driver pins the native `opencode` theme and waits
for the selected file row's rendering before pressing Enter; the echoed
filename in the editor cannot satisfy this readiness check. A PTY regression
proves that distinction. The driver follows those observed screens.
Image attachment and tool-returned image output remain separately reported.
A malformed earlier PNG was rejected by the native Codex decoder; the current
fixture is a valid synthetic PNG with PNG chunk CRCs.

The installed Claude `@image` scenario also exposed a previously missed native
attachment carrier, `attachment.content.file.base64` with MIME in `file.type`,
size and geometry. The shared policy now replaces this carrier in both normalized
and raw content while keeping its filename/displayPath, dimensions and digest.
The regression includes a negative control for unrelated tool JSON, and the
actual installed TUI is rerun after the fix. Existing captured data is not purged
by this forward policy.

A passing report covers these observed cases only. It does not certify every
record type, live-provider behavior, untested headless behavior, clipboard/drop entry,
text-file editor attachment, arbitrary document/oversized/invalid input,
compaction/forks/subagents, or an untested operating system. Each report marks
`fullyCertified: false` and lists these gaps. Extend this registry only after an
installed scenario exists; maintain explicit per-CLI issues for uncovered cases.

## Observed macOS checkpoint (2026-10-03)

All eight selected cases passed in installed TUIs after the attachment repair:

| CLI | Installed version | Captured events | Scripted requests | Evidence |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.280 | 45 | 6 | [Report](verification-evidence/conformance-claude-code-macos-2026-10-03.json) |
| Codex | 0.160.0 | 47 | 7 | [Report](verification-evidence/conformance-codex-macos-2026-10-03.json) |
| OpenCode | 1.18.10 | 20 | 6 | [Report](verification-evidence/conformance-opencode-macos-2026-10-03.json) |
| OpenCode (isolated pinned runtime) | 1.18.33 | 20 | 6 | [Report](verification-evidence/conformance-opencode-pinned-macos-2026-10-03.json) |

The initial installed opt-in suite passed 4/4 checks with zero skips; its attachment
regression and all three actual TUI sessions took about 65 seconds. These exact
installed versions are recorded separately from pinned smoke versions. A
subsequent actual OpenCode 1.18.33 session passed all eight cases after the
observed autocomplete repair, including a rerun with strict selected-row
readiness on its default native file-search backend. Its selected isolated executable was also bound
to the native command name on the disposable PATH, so hook exports used the
same tested version. An intentionally failing fallback command was never
invoked. Earlier failure reports exposed the missing command binding and
incorrect autocomplete selection; neither failure was counted as a pass.
The evidence wrappers preserve the executed reports and add explicit subset
scope/exclusions; they do not include raw terminal logs, native binary payloads
or private configuration. Earlier failed attempts exposed the malformed PNG,
attachment submission timing, and Claude's missed retention carrier; those
causes and their repairs are documented above, rather than counted as passes.

OpenCode can explicitly select its supported native ripgrep search backend with
`CLEDGER_CONFORMANCE_OPENCODE_RIPGREP=1` for the installed test
entrypoint. Such reports identify `native-ripgrep` and exclude verification of
the default index backend; a backend-specific pass does not resolve a default
picker failure. This choice does not relax attachment or automatic-capture gates.

Remaining per-CLI conformance gaps are tracked in [issue #27](https://github.com/evintunador/conversation-ledger/issues/27).

## Observed Linux checkpoint (2026-10-03)

The same eight cases passed in actual installed Linux x64 TUIs:

| CLI | Installed version | Events | Scripted requests | Evidence |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.284 | 46 | 6 | [Report](verification-evidence/conformance-claude-code-linux-2026-10-03.json) |
| Codex | 0.159.0 | 39 | 6 | [Report](verification-evidence/conformance-codex-linux-2026-10-03.json) |
| OpenCode | 1.18.33 | 20 | 6 | [Default backend](verification-evidence/conformance-opencode-linux-2026-10-03.json) |

Read each report for its exact event/request count. Codex's disposable test config
disables startup update checks so its resume input cannot accidentally select
an updater. OpenCode's initial attachment-selection attempts advanced on the
editor's filename echo and failed; the strict selected native row matcher passes
the default backend. A separate [native ripgrep backend pass](verification-evidence/conformance-opencode-ripgrep-linux-2026-10-03.json)
is recorded as an alternative and explicitly excludes default-backend proof.
These results contain no runner access settings, machine identities or private
operational configuration.

## Follow-up gate review

The final assertions require complete multiline Unicode on the resumed turn,
not only its marker, and a binary reference inside the result linked to the
actual image read. An unrelated attachment cannot satisfy the image-result gate.
The stricter installed macOS rerun passed all eight cases without skips:

| CLI | Installed version | Events | Requests | Evidence |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.280 | 45 | 6 | [Report](verification-evidence/conformance-claude-code-strict-macos-2026-10-04.json) |
| Codex | 0.160.0 | 47 | 7 | [Report](verification-evidence/conformance-codex-strict-macos-2026-10-04.json) |
| OpenCode | 1.18.33 | 20 | 6 | [Report](verification-evidence/conformance-opencode-strict-macos-2026-10-04.json) |

These locally installed versions do not change the separate CI pins. The hosted
macOS/Linux rerun exercises the stricter assertions against those pins.

## Issue #27 expansion (2026-10-05)

The installed macOS campaign resolves the eight cases (passes or observed upstream
limitations) in both modes for seventeen CLIs: Claude, Codex, OpenCode, Gemini,
Qwen, Pi, Kilo, Copilot, Kimi, Continue, Cline, Goose, Open Interpreter,
OpenHands, Crush, Mistral Vibe and Aider. Aider reloads native chat history but
has no stable native session ID, recorded as a resume limitation. Droid is blocked on isolated resume authentication;
Cursor and Kiro still need conformance proof. The initial nine-CLI CI run
passed all macOS scenarios; Linux Gemini TUI backfill remains a recorded failure. See the matrix
for the latest per-case result; partial runs do not certify a CLI.

Qwen 0.24.6 persists image tool responses in `functionResponse.parts`, alongside
`response`. The shared Google-parts conversion previously discarded that native
field from normalized tool results. It now retains the sibling fields and the
linked image reference. A regression and both installed interfaces pass after
the repair. Raw and normalized evidence retain references rather than bytes.

Kimi 2.1.1 headless `--prompt` leaves `@image` literal and exposes no attachment
flag. This observed limitation is recorded separately from the successful TUI
Ctrl-V path. The TUI uses an isolated OS file-clipboard lookup fixture pointing
at our synthetic PNG; it does not access the user's clipboard. The native
`kimi-file://f_…` locator has no digest/size in this persisted API and remains an
opaque locator. Real OS clipboard/drop integration is tracked in #29.

Local DeepSeek and usual-provider checks use a smaller canary: a random value
absent from the prompt must come from a linked real read/result and appear in
the final answer, with normal exit/resume, automatic capture before repair, no
unrecognized records, and two idempotent backfills. A `cledger-canary/1` report
must explicitly prove all eight gates. Older live reports are retained as
historical evidence rather than being promoted to this new contract.

Local inference waits for the user's machine to be plugged in with cooling
ready. Paid checks share a $20 total API budget, prefer API-key routes and the
cheapest suitable models, and do not purchase subscriptions. Subscription-only
usual-provider checks may remain blocked with a recorded contributor-account
prerequisite; other missing evidence keeps the issue open.

Follow-up issues cover [text-file attachment entry (#28)](https://github.com/evintunador/conversation-ledger/issues/28),
[clipboard/drop (#29)](https://github.com/evintunador/conversation-ledger/issues/29),
[documents/archives (#30)](https://github.com/evintunador/conversation-ledger/issues/30),
[oversized/invalid text (#31)](https://github.com/evintunador/conversation-ledger/issues/31),
[fork/branch (#32)](https://github.com/evintunador/conversation-ledger/issues/32),
[compaction/rewind (#33)](https://github.com/evintunador/conversation-ledger/issues/33),
and [subagents (#34)](https://github.com/evintunador/conversation-ledger/issues/34).

### Real-model canary runner

`npm run verify:canary -- --local` currently implements OpenCode, using the
explicit `CLEDGER_VERIFY_ENDPOINT`, `CLEDGER_VERIFY_MODEL`,
`CLEDGER_VERIFY_BINARY` and optional `CLEDGER_VERIFY_INTERACTIVE=1`. Run this
only after local power and cooling are ready. No model endpoint is selected
implicitly. Other CLI canary drivers remain pending.

The runner performs an initial read/answer, normal exit, native session resume,
and a second read of a newly randomized file value. Neither value appears in
the prompt. It requires automatic linked evidence before both manual backfills.
CI verifies this driver with scripted model substitutes; those reports are
explicitly scripted and cannot satisfy real-model matrix cells. Paid canaries use `budget-client authorize-canary` and
`budget-client run-canary SESSION OUTPUT OPENCODE_BINARY headless|interactive`.
The durable authority now enforces a shared $20 `issue27` campaign ceiling
in addition to per-CLI limits. No paid execution has been activated; selected
funded API routes and current reviewed prices are still required.

### Remaining prerequisites

Kiro's freshly probed installed version is 2.27.1; historical 2.27.0 proof is
not promoted to that pin. Its [official authentication contract](https://kiro.dev/docs/getting-started/authentication/)
restricts API-key creation to paid accounts, and
[headless mode](https://kiro.dev/docs/cli/headless/) requires that key. Usual-provider
headless canaries are blocked pending a subscription-owning contributor on both
OSes. This prerequisite record does not assert an installed Linux run. Browser
sign-in/free-account TUI verification is a separate pending path.

Cursor 2026.10.01-e373342's installed help exposes `--endpoint`; a synthetic
loopback probe reached native authentication exchange, protobuf model discovery,
prompt persistence and the native HTTP/2 `AgentService/Run` stream. Its agent uses a distinct bidirectional RPC protocol;
an OpenAI-compatible model endpoint is insufficient. A subsequent headless exploratory probe completed an actual native Read,
linked automatic tool evidence, native checkpoint persistence of the submitted
prompt and scripted answer, normal exit, and `--resume` of the saved session.
The resumed run received the two saved native prompt-message pointers and read
a fresh file value. This temporary protocol probe is not a reproducible
conformance driver and does not close Cursor cases or any TUI item. Cursor
conformance remains pending.

### CI reproduction and native boundaries

The expanded sixteen-CLI CI run recorded 29/32 Linux scenario passes and
29/32 macOS passes. Failures remain in the matrix until newer installed evidence
supersedes them. The [focused six-CLI rerun](https://github.com/evintunador/conversation-ledger/actions/runs/37384076086) passed all 12 scenarios on each OS, including Aider and all previously failing cases. A full seventeen-CLI gate remains required. Kilo's isolated profile now uses its
[documented `snapshot: false` setting](https://kilo.ai/docs/code-with-ai/features/checkpoints)
because native snapshot initialization stalled on resume; snapshot/rewind proof
is excluded. Cline's native single-file path paste creates an image attachment;
`@image` selects a generic text-file context and may reject a PNG as binary.
Open Interpreter exits only after automatic capture and a bounded idle terminal
interval, so a busy native Stop hook cannot consume the exit command.

Gemini may leave a separate unused bootstrap transcript during resume, without
a hook for it. If first backfill adds only two unchanged creation-metadata rows
and one system `session_context` in a new stream, and the second adds nothing,
this is an observed backfill limitation. Missing human, assistant, tool, active
stream or additional lifecycle records remain failures.

A manual `native-verification.yml` dispatch can set `focus` to comma-separated
CLI IDs (for example `kilo,cline,gemini-cli,open-interpreter,aider,opencode`).
It provisions pinned binaries and runs installed cases on both OSes, skipping
the broad smoke campaign for that focused dispatch. The normal PR/default
workflow retains the full smoke and conformance gate. Focused dispatch is not
a substitute for the full gate.
