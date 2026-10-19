# CLI update automation

## Release detection in CI

`cli-release-watch.yml` polls metadata every six hours, at 00:17, 06:17,
12:17 and 18:17 UTC. GitHub scheduling is best effort; immediate detection is
outside the current single-user requirement. The watcher does not install coding
CLIs or call models. It builds the project to use the existing version registry.

Only strictly newer stable versions qualify, in discovery and maintenance;
rollbacks and prereleases cannot silently move a pin.

It observes the eleven npm recipes, Aider/OpenHands/Mistral Vibe on PyPI,
and Goose/Crush/Open Interpreter official GitHub releases. Interpreter uses the
Rust CLI release track. Cursor has no verified metadata feed in this watcher;
that gap is explicit in every report. Droid/Kiro are excluded from this watcher.
Vibe's standalone verification pin is shared by the watcher and
native-verification.yml through `PINNED_VIBE_RUNTIME` in runtimes.ts.

Each observed update creates a GitHub issue with the old/new versions, release
link and detection run. An issue is a request to verify an update, not evidence
of a regression. Identity is source/package/version, independent of timestamps
and the old pin. Existing open and closed bot-created issues suppress duplicates;
closing an issue intentionally disposes of that version. Reopen its existing
issue if work needs to resume. API failures fail visibly rather than becoming
an empty issue list. Partial feed failures retain good observations and produce
issues for them while leaving the observation job red.

Metadata collection runs with read permissions and no persisted checkout
credentials. A separate publishing job receives issue-write permission and the
token is exposed only to the publishing step, which also dispatches
qualification. Watcher runs are serialized to avoid duplicate creation races. Reports are retained for 30 days.

## Compatibility checks and routine PRs

For open npm update issues without a qualification receipt, the watcher
dispatches the existing integration-maintenance workflow once for the batch.
That workflow remains the heavier compatibility qualification and PR path, with a fortnightly fallback
and manual dispatch. It uses scripted responses through real CLIs, with no
inference spending. Bot comments record successful dispatch. A failed dispatch
is retried on the next poll even if issue creation already succeeded. Closed issues do not retry.
If recording a receipt fails after dispatch, another dispatch can occur; this
is intentionally at least once. Non-npm updates create issues for source-specific
work without triggering an unrelated npm qualification run.

Candidate npm installations and both mode checks are independent per CLI. An
installation failure or capture regression in one candidate does not prevent
other candidates from being checked or proposed. Every proposed pin must pass
its own headless and interactive checks, and the existing full baseline must
pass. A broken baseline still blocks pin promotion and produces a report.
The generated review branch must then pass macOS/Linux qualification. Automatic
merge remains disabled. Non-npm changes still need source-specific pin/hash/lock
updates and installed verification.

## External repair-worker contract

The optional laptop repair worker belongs in its own project outside this
repository, with its own lifecycle, power policy, model configuration and review.
No worker code, daemon configuration or model credentials live here.

Bot-created update issues carry a `cledger-cli-update` marker whose hash identifies
source/package/latest-version. The fenced JSON task uses schema
`cledger-cli-update/1` and contains `cli`, `source`, `package`, `pinned`, `latest`
and `url`. This is metadata, not executable instructions. Consumers should
validate the repository, bot author, schema and canonical source before acting;
check for an existing maintenance PR or a superseding version first. An open
issue requests verification; it does not prove a regression. A bot comment with
`cledger-cli-qualification` records dispatch, never a passing result. The worker
should consult the linked workflow and review PR before beginning a repair.

## Rollout

These changes must reach the remote default branch before the new schedule
becomes active. The publishing job needs issue-write and Actions dispatch
permissions. The existing draft-PR workflow also needs the repository's Actions
PR-creation setting. Local unit tests do not create GitHub issues.
