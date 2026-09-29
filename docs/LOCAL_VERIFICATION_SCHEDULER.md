# Reviewable local scheduling

`dist/verification/schedule.js` generates local scheduler files; it never installs,
loads, starts, enables, or modifies an operating-system scheduler. The generated
`ACTIVATION.md` contains concrete commands to review and run later. Automation is
review-first: update candidates produce proposals and reports, never commits,
pull requests, baseline pin changes, or merges.

Build the checkout, provision npm CLIs into a persistent runtime directory with
`dist/verification/runtimes.js`, and provision the non-npm runtimes separately.
A default full campaign requires explicit absolute binary paths for Aider
(its virtualenv Python), Goose, OpenHands, Mistral Vibe, Droid, Crush and Open
Interpreter. The binary-overrides JSON maps CLI IDs to paths, not environment
variable names. An explicit `{}` is valid when `--only` selects npm-backed CLIs.
Temporary proof runtimes are rejected, including existing ancestor symlinks that
resolve into temporary directories. No existing runtime is moved or installed
by the generator.

Example (replace these illustrative persistent paths with the intended machine's
paths; the selected output directory must be empty):

```sh
node dist/verification/schedule.js \
  --output-dir /Users/example/verification-scheduler \
  --repository /Users/example/repos/conversation-ledger \
  --runtime-dir /Users/example/verification-runtimes \
  --binary-overrides /Users/example/verification-binaries.json
```

Optional `--only` selects comma-separated implemented CLI IDs. `--node` supplies
an absolute Node executable, and `--path-directories` accepts a JSON array of
additional persistent absolute executable directories. PATH is constructed from
these paths, the Node/binary-override directories and standard macOS/Linux tool
directories. Nothing inherits the scheduler's provider credentials, AWS keys,
NODE_OPTIONS, PATH, HOME or Git configuration. Native verifiers add their own
synthetic configuration isolation. A supported Node version, npm, Python3, git,
and each CLI's prerequisites (including native SQLite for Crush) must be present.

The six generated files are:

- `schedule.json`: explicit reviewed paths, targets and execution policy.
- `run-verification.mjs`: standalone portable invocation script.
- `org.conversation-ledger.verification.plist`: daily macOS LaunchAgent.
- `org.conversation-ledger.verification.service` and `.timer`: Linux user units.
- `ACTIVATION.md`: exact manual-run, activation and deactivation commands.

Daily triggers call the existing campaign state machine. Headless and interactive
modes have separate last-attempt timestamps and each runs at most once per
14 elapsed days. Both modes observe upstream release metadata. Only headless
mode provisions and checks changed npm candidates; interactive mode tests the
reviewed pinned runtimes. A failure does not silently reset its cadence, and a
headless nonzero exit does not prevent the interactive attempt. An existing
campaign lock blocks concurrent execution; inspect the process before manually
removing a stale lock.

The launchd job runs when loaded and at noon daily; the systemd timer catches up
missed triggers and adds up to 30 minutes of jitter. Neither is activated by
artifact generation. Linux user services require a user manager; choosing to
allow them while logged out is a separate administrator decision. These Linux
unit files do not constitute Linux CLI verification.

Keep the chosen artifact directory and state permanently once activated. Reports,
review proposals and cadence files live under its `state/` directory. Launchd
logs are alongside the artifacts; systemd logs go to the user journal. Arrange
log/report retention. Regenerate for moved checkouts, changed Node locations or
another machine. Hosted scheduling can invoke the same runner after provisioning
persistent state and runtimes; it does not require a different campaign format.

The separate `integration-maintenance.yml` hosted workflow checks the full native
matrix every other Monday after this review branch is merged. It also observes
public releases, runs changed npm candidates in both supported modes on Linux,
and opens a draft review PR with evidence. Pin changes require a passing baseline
and candidate checks; the review branch gets a further macOS/Linux qualification
run. Non-npm releases are reported for source-specific review. No subscription,
paid inference or auto-merge is enabled. Manual workflow dispatch works between
scheduled runs. The local scheduler remains available when hosted execution is
not desired.

Validation covers plist parsing and macOS `plutil`, shell activation-command
syntax, literal paths with spaces/apostrophes/dollar signs/percent signs, rejected
temporary runtimes, and execution of the generated runner against a recording
fixture. Linux `systemd-analyze verify` should be run on the target Linux host
before enabling its units; no Linux host was available for this validation.
