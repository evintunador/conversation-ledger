# Installed core TUI conformance

`src/verification/conformance.ts` drives installed Claude Code, Codex and OpenCode
in disposable native homes/configs and synthetic Git repositories. A bounded
loopback model substitute requests real native tools; it does not write native
transcript fixtures or make real model requests. This supplements the ordinary
read smoke scenario with actual editor input and lifecycle/data cases. It is
explicitly an interactive scenario; no headless result qualifies as a TUI pass.
No user transcript, normal configuration or account credential is inspected.

After building, select installed binaries and run:

```sh
CLEDGER_CONFORMANCE_CLAUDE_CODE_BINARY=/absolute/path/to/claude \
CLEDGER_CONFORMANCE_CODEX_BINARY=/absolute/path/to/codex \
CLEDGER_CONFORMANCE_OPENCODE_BINARY=/absolute/path/to/opencode \
CLEDGER_CONFORMANCE_REPORT_DIRECTORY=/tmp/cledger-core-conformance-reports \
node --test dist/test/verification-conformance.test.js
```

Unset binary variables explicitly skip that installed test. The attachment-proof
checker still runs as an ordinary regression. A sandbox must permit native
processes and loopback sockets. Select a single TUI directly with
`CLEDGER_VERIFY_BINARY=/absolute/path/to/codex node dist/verification/conformance.js codex`;
CLI IDs are `claude-code`, `codex`, and `opencode`. The runner rejects unsupported
arguments, including a headless mode. `--retain` keeps its synthetic diagnostic
home/terminal traces for debugging; ordinary runs clean them up. Do not commit
raw traces or native fixture homes.

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
record type, live-provider behavior, headless behavior, clipboard/drop entry,
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
