# CLI integration program

Status: implementation in progress, 2026-09-29. Native proof and its exclusions
are recorded in NATIVE_VERIFICATION.md; this plan is not a completion claim.

## Agreed constraints

- Target a practical roster of ten big-player CLIs and ten independent CLIs.
  GitHub stars inform independent selection; the user explicitly prefers useful
  coverage over a rigid classification/ranking exercise. The selected roster is
  in CLI_ROSTER_RESEARCH.md. Do not call roster coverage measured market share.
- Support macOS and Linux, interactive terminal and headless use. IDE,
  desktop, cloud, and Windows coverage are outside this initial baseline.
- Prefer native hooks/plugins. A background watcher is acceptable when the
  relevant CLI is installed. Manual import is useful for backfill but does
  not satisfy automatic integration.
- Capture known text formats; preserve references for images and other binary
  attachments instead of putting their bytes into Annals.
- Initial paid verification ceiling: $5 per CLI. Recurring ceiling: $5 per
  CLI per calendar month, aiming for approximately one-tenth of those amounts.
- Run scheduled compatibility checks every two weeks (interpretation of
  "bi-weekly"). Start with review of maintenance PRs; auto-merge is a future
  policy change, not enabled by this plan.
- A local scheduler/runner is acceptable. Keep execution portable to hosted
  CI without rewriting scenarios or adapters.
- Use the user's local Ollama `ledger-test` endpoint for compatible
  bring-your-own-provider model checks; the DeepSeek gateway is disabled. Paid native-provider checks remain necessary
  only for behavior the local route cannot validate.

## Discovery baseline (before this implementation)

The 107 existing tests passed during initial discovery. They cover meaningful
filesystem/Git integration, but the native adapter inputs are primarily
hand-built fixtures. OpenCode's executable test uses a fake binary. There is
no checked-in CI workflow, native scenario driver, or versioned native capture
corpus. Passing the suite does not establish upstream CLI compatibility.

Initial adapters: Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code.
The README records an unverified Qwen headless regression and the limitation
that Claude's final transcript tail may require a subsequent session to capture.

Audit findings to reproduce and resolve before declaring existing adapters
complete:

- Claude main-thread user envelopes containing tool results receive the
  human Git identity; Codex message roles other than assistant become human.
- Recognized Claude messages without expected fields may disappear without
  an unknown-record warning. Unknown nested variants also need accounting.
- OpenCode file/agent/snapshot/todo parts are intentionally preserved raw-only.
- Some Gemini/Qwen content parts pass through without a common normalized
  vocabulary. Raw preservation and semantic normalization need separate grades.
- Installer configuration roots do not consistently follow adapter roots.
- Native shutdown, hook trust, timeout, and asynchronous completion behavior
  need actual process tests, not only installed-config assertions.

## Completion contract

Track each CLI, tested version, operating system, execution mode, and native
record subtype. Each record has one disposition: normalized; raw-only fallback;
explicitly excluded with reason; unsupported by upstream; or untested.
An unobserved feature cannot be marked passed, and a skipped test is not a pass.
Every exclusion must name its rationale; duplicate suppression must identify
the retained counterpart. Inspect known-record shape drift as well as new tags.

The checklist includes human/assistant/system attribution; text and visible
reasoning; opaque reasoning; tool calls/results/errors; text attachments and
binary references; context injections; model/provider/source version; state and
activity; approvals/cancellation; compaction/rewind/branch/resume; subagents and
parentage; snapshots; partial writes; final tails; discovery scope; and dedup.
Features absent from a particular CLI are documented as such with evidence.

Automatic capture, explicit backfill, installation/repair/removal, and data
normalization are separate acceptance gates. Automatic capture must work in
both interactive and headless modes for a CLI to count as fully integrated.
Measure the fraction passing all required gates against the fixed roster;
for a roster of twenty, eighteen passes meet 90%, with the other two visible.
Aim to finish all twenty, rather than using that threshold to hide omissions.

## Text and attachment references

Context Graph is a design-stage reader, not an implemented resolver or a second
content store. Its draft identifies files by path at commit plus uncommitted
state. Preserve references that can support that model without assuming an API.

Proposed reference fields, only when evidenced: original path/URI or native
attachment identifier, source session/event, path base/cwd, repository and commit,
media type, byte size, digest, and whether content was unavailable or omitted.
Do not replace the original reference with a guessed path. A digest supports
verification; it cannot recover deleted bytes. Mutable URLs and dirty files
are not reconstructable solely from their names or a status fingerprint.

Define a central text-format allowlist, decoding rules and bounded read sizes
before enabling file-body extraction. Size defaults remain an implementation
decision to document. Unsupported, binary, missing and oversized files retain
references and an explicit reason. Do not crawl arbitrary mentioned paths or
fetch remote URLs merely because they appear in conversation text.

Text bodies and sensitive paths/URLs must go through the redaction-scanned
content/raw paths. Existing resolved metadata is for digest/size and is outside
identity and scanning; do not put extracted text there. Preserve source identity
independently of transient file availability so rescans do not mint duplicates.

Binary exclusion must cover embedded base64/data-URI payloads in raw data as well
as normalized content; otherwise raw preservation defeats the storage policy.
Use explicit omission metadata while retaining available source references.
Opaque provider reasoning is a separate existing record category, not a binary
file attachment. Preserve its current behavior unless deliberately revised.

## Agent-runnable verification

The gateway checkout is actually `../ds4-gateway`, not the older `~/dev` path
in the global instructions. Its README advertises OpenAI- and
Anthropic-compatible APIs; exact CLI-required features (including Responses,
streaming, tools and reasoning formats) still need protocol verification.
Do not assume Gemini protocol compatibility. The backend is serial: serialize
local inference campaigns even when adapter-development agents work in parallel.
Respect refusal without immediate retry or silent paid-provider fallback; report
the affected live gate as unavailable. Do not change power/availability settings.
Endpoint selection belongs in runner configuration, not hardcoded machine URLs.

1. Retain fast unit/filesystem regression tests. Add versioned, sanitized native
   fixtures with provenance and independently specified expected dispositions.
2. Run real CLI executables in disposable repositories and isolated config/data
   roots. Where supported, scripted local provider endpoints drive deterministic
   tool calls and uncommon events through the real CLI. A fake provider is not
   evidence that native provider authentication or reasoning works.
3. Add budgeted live-provider scenarios using the cheapest model that supports
   the feature being tested. Do not force every scenario onto one model when
   that would omit features. Native-provider-specific records need native runs.
4. Exercise interactive terminal paths with a PTY driver where headless mode
   differs. Initial account login/trust may require a person; record that setup
   explicitly and make subsequent runs autonomous where upstream permits.

Assertions compare native artifacts against ledger output: every record must
be accounted for, actors and parentage correct, binary bodies absent, references
present, rescans idempotent, and shutdown tails captured. A model saying it
completed a task is not an oracle. Fail if the required scenario never occurred.
Await evidence with bounded deadlines, including detached hook children, rather
than equating parent process exit with capture completion.

Keep test config, credentials, Git notes, capture cursors, and native transcripts
separate from everyday user sessions. Disable test-repository transport. Export
sanitized failure artifacts for the maintaining agent; do not collect private
historical user transcripts as a convenience corpus.

## Budgets and maintenance

One portable runner owns scenarios, version installation/selection, reports,
timeouts, and cost accounting. Scheduler adapters invoke it (local launchd/cron
first if useful; hosted CI later). Store no credentials in source or fixtures.

Use per-CLI initial and monthly spending ledgers, concurrency-safe reservation,
request/turn/output limits, retry limits, and provider-side caps where available.
Reserve estimated worst-case cost before dispatch and reconcile reported usage.
Local estimates are not a guaranteed billing cap when upstream pricing or hidden
requests are unknown; report that limitation and refuse unbounded paid runs.
No automatic plan purchases or subscriptions. Free/local runs do not establish
live-provider compatibility; missing credentials produce an explicit blocked gate.

Every two weeks, compare upstream release versions and run pinned baseline plus
latest stable checks. Ordinary PRs run offline regression; targeted paid runs can
verify adapter changes within the same budget. Record tested versions, platforms,
mode, feature dispositions, cost, and links to failure evidence. Keep a last-known
passing baseline rather than silently updating fixtures to match a regression.

Maintenance automation produces reports and, once configured, repair PRs for
review. Release auto-merge remains off. A local macOS runner cannot claim Linux
passes without a Linux execution environment; use a VM/container or another host
as appropriate to the CLI, and retain a separate macOS result.

## Work sequence and ownership

1. Finalize eligibility and dated roster; create the shared completeness matrix.
2. Build the isolated real-CLI runner, reference policy, cost accounting and
   report format. Pilot one existing integration end to end.
3. Re-audit and verify all five existing integrations against the same contract.
4. Delegate new CLIs to individual agents with exclusive adapter/test ownership.
   The orchestrator owns shared schema, installation registry, runner and review;
   shared-contract changes are coordinated rather than implemented independently.
5. Finish both platform gates, backfill/install lifecycle and completeness audit.
6. Enable the every-two-week schedule and reviewable maintenance workflow.

Do not publish a support claim based only on fixtures, undocumented assumptions,
raw-only preservation, or success on one execution surface.
