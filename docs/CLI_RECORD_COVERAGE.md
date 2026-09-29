# Record coverage and remaining proof

This is an audit map, not a full-certification claim. Native read scenarios prove
installation, real CLI execution, text/tool linkage, automatic capture and exact
backfill idempotency. Fixture tests exercise additional data types; they do not
prove that an upstream executable currently emits every fixture shape. Both
operating systems and broader lifecycle scenarios remain separate gates.

Common capture policy: preserve supported native structured fields and raw source;
unknown/malformed records remain explicit unrecognized evidence. A successful
native scenario must contain no unrecognized evidence, including nested markers.
Known embedded text is retained; binary bodies become references before storage
and hashing. External locators remain locators. Opaque provider reasoning is kept
in separate reasoning records with a digest in normalized identity. A source's
absence of timestamps, IDs, parent links or saved system instructions must not
be filled with invented provenance.

## Gemini CLI

Source: append-only native conversation mutation log. Fixtures in
`src/test/adapter-gemini-cli.test.ts` and `src/test/genai-parts.test.ts` cover:

- User/model turns, harness context attribution, system notices and model facts.
- Shared GenAI text/thought/tool call/result parts; supported native media/code
  shapes remain structured and binary bodies follow the attachment policy.
- Session headers and metadata patches, snapshot replacement, explicit rewind
  and implicitly withdrawn messages, subagent directory lineage.
- In-flight tool withholding, abandoned turns, later settled-message revisions,
  repeat capture, stable missing-time sentinel, and exact native file scoping.
- Unknown WAL records, malformed complete JSON, non-object records, malformed
  snapshot members/collections and unknown nested parts retained with drift.
  Only an unterminated malformed tail is deferred for a later write.

The native headless and interactive scenarios are verified on 0.61.0. A bounded
tail worker captures native notices/metadata written after SessionEnd returns. Fixture lifecycle coverage
must not be reported as native rewind/compaction/subagent proof. The adapter keeps
previously captured evidence append-only; backfilling a log whose same message
ID was repeatedly replaced retains its final replayed value, not an assertion
that every intermediate revision was captured live.

## Continue CLI

Source: native session JSON snapshots in the configured Continue directory.
Fixtures in `src/test/adapter-continue.test.ts` cover:

- User/assistant/system/tool/thinking roles, text and image references, tool calls
  and terminal tool-state results (success/error/cancel), context and metadata.
- Native reasoning/summary fields, redacted thinking, reasoning_details encrypted
  content and metadata fallback, with separate sealed records and revision IDs.
- Identical repeated rows, concurrent capture, compaction/removal snapshots,
  retained evidence, workspace scoping, unknown roles, malformed final JSON.

Native rows have no durable IDs or timestamps: normalized content explicitly
states `time_basis: not_recorded`, uses an epoch sentinel and first-observed
ordering; each snapshot preserves source order. Native save strips system
messages, so fixture import support does not promise they exist in native files.
Version1.5.47 exposes hook declarations without lifecycle call sites; only
`cledger run continue -- ...` provides automatic capture. Headless and typed-prompt interactive native proof
pass; unwrapped invocation is not represented as automatic integration.

## Acceptance gaps

Cursor and Kiro do not yet have implemented adapters or native proof. See
`CLI_ROSTER_RESEARCH.md` for the current authentication findings. Eighteen of
twenty headless smoke passes on macOS is 90% of this roster, not measured market
share, full record certification, or Linux coverage. Interactive scenarios,
resume/fork/compaction/cancellation, exact upstream discriminant inventories and
Linux results must be tracked independently. Intentionally unsupported backends
(Vibe unified, historical Python Open Interpreter) remain explicit limitations.

## Pi 0.87.1

Fixtures cover session/message, model and thinking-level changes, session info,
custom records/messages, labels, usage, compaction, branch summaries and context
edits. Message fixtures cover text, image, thinking and toolCall blocks; user,
assistant, tool-result and injected/custom roles; branch-aware model provenance;
legacy sequential sessions; malformed records; and byte-exact sealed reasoning
revisions. Native macOS proof covers the installed extension in headless and
interactive PTY sessions, real file-read linkage, clean exit and exact repeated
backfill. The interactive prompt is supplied as an initial CLI argument. Native
attachments, branching, compaction and ephemeral sessions remain unverified.

## Kimi 2.1.1

Fixtures cover metadata/session metadata, agent switching and turn lifecycle,
context messages and loop events, file-history checkpoints/tracked versions,
step boundaries and tool calls/results. Content fixtures cover text, thinking,
image/audio/video URL parts and encrypted thinking. Native file-history keys are
references; capture never opens backup files. Tests cover provenance, native
wire journals, mutable ciphertext identity, unknown nested content, exact cwd
selection, concurrent capture and bounded tail completion/failure. Native macOS
headless and keyboard-driven interactive PTY proof covers installed hooks, a file read, response, complete exited
tail worker and exact backfill. Native compaction, fork/resume, multimodal inputs
and all event types remain separate proof gaps.

## Droid 0.229.0

Fixtures cover session_start, todo_state, session_settings, agent_turn_outcome,
compaction_state and message records. The seven block types are text, thinking,
redacted_thinking, tool_use, tool_result, image and document. Fixtures distinguish
human input from system context, hook notices, tool results and delegated child
prompts, preserve settings revisions and lineage, and check sealed reasoning,
torn writes, rewritten files and unknown nested blocks. Native macOS headless
proof covers installed hooks, file-read linkage, final answer, exited bounded
tail worker and exact backfill. Interactive behavior, live subagents, compaction,
resume and actual multimodal entry remain unverified.

## Kilo 7.8.1

Fixtures exercise all twelve persisted part types: text, reasoning, tool, file,
agent, snapshot, patch, subtask, retry, compaction, step-start and step-finish.
All four tool states (pending/running/completed/error), Kilo model/provider and
editor context fields, child lineage, synthetic user content, mutable revisions,
deletions, malformed parts and replay identity are covered. Native macOS
headless and interactive PTY proof covers the installed session-idle plugin, real read tool result,
answer and exact repeated backfill. The TUI initial prompt is supplied by CLI argument; native keyboard prompt entry,
subagents, compaction/rewind and multimodal entry remain unverified. Snapshot hashes and file paths are locators;
embedded binary file parts become references under the common policy.

## Crush 0.97.1

Fixtures cover text, reasoning, image_url, binary, tool_call, tool_result, finish
and shell_command parts; sessions, messages, files, read_files and enabled/disabled
MCP server tables; summary/hidden context, child lineage, sealed Responses
reasoning and unknown schemas. Capture reads only allowlisted tables through
read-only SQLite, preserving their columns; unknown table schemas are recorded
without reading their rows. The closed WAL database regression exercises the
macOS upstream SQLite requirement. File-version bodies are retained only for
known text filenames without NULs. Other native string snapshots become path,
digest and byte-count references in both normalized and raw evidence; their
encoding is explicitly the native UTF-8 snapshot string, not original file bytes.
Native macOS headless and keyboard-driven interactive PTY proof covers the scoped launch wrapper, persisted SQLite
messages, linked file read, answer and exact backfill. Unwrapped sessions,
compaction/resume and all native data entry types remain unverified.

## Qwen Code 0.24.6

Fixtures cover native user/assistant/system records, slash and @ commands versus
harness bootstrap context, text/thought/tool call/result parts, subagent parent
links, source replay, append-only cursors and torn trailing writes. Shared GenAI
fixtures cover structured media/code parts and unknown nested part preservation.
Native macOS headless and actual typed-prompt PTY scenarios pass with installed
hooks, linked file read/result, assistant answer and exact repeated backfill.
ACP, live multimodal entry, subagents and compaction remain native proof gaps.

## GitHub Copilot CLI 1.0.89

Fixtures cover native identities, human/system/delegated attribution, tool
requests/completions, usage and lifecycle metadata, opaque reasoning, unknown
records, malformed complete records, exact workspace scoping and delayed final
transcript creation. Native macOS headless and typed-prompt PTY scenarios pass;
the PTY approves only its disposable workspace trust dialog. Proof includes
final terminal record, completed background tail, linked read/result, answer and
exact repeated backfill. Native individual hook timing, subagents, attachments,
compaction and ACP remain unverified.

## OpenCode 1.18.33

Fixtures enumerate all twelve persisted parts: text, reasoning, tool, file,
agent, snapshot, patch, subtask, retry, compaction, step-start and step-finish.
They cover file/symbol/resource references, synthetic context, child lineage,
error results, pending tools, deletion-stable ordering and capture/replay
idempotency. Native macOS headless and typed-prompt PTY scenarios pass with the
installed session-idle plugin and strict read/result/answer/backfill gates.
Native compaction, subagents and multimodal entry remain separate proof gaps.

## Aider 0.86.2

Fixtures cover the explicit launch recorder's structured human/assistant I/O,
model context, file operations/results, confirmation decisions, terminal status,
attachment references and partial writes. Automatic confirmations stay system
attributed; read failures remain visible. Native macOS headless and typed-prompt
PTY whole-file edits pass, proving read/context/answer/write linkage, real file
change, final recorder status and exact repeated backfill. The test uses --yes;
interactive approval decisions, streaming and summarization are not native
certified. Unwrapped sessions and historical Markdown history are unsupported.

## Cline 3.0.65

Fixtures cover SDK message/session artifacts, native content variants, tool and
context state, child/model provenance, opaque reasoning, unknown nested parts
with replay envelopes, attachment policy, compaction snapshots and delayed
terminal manifests. Native macOS headless and PTY scenarios pass with installed
hooks, linked read/result/answer, completed tail and exact repeated backfill.
The PTY uses documented `-i` with a CLI initial prompt and keyboard `/exit`;
welcome-editor prompt entry remains unverified. Native multimodal entry,
subagents, compaction, legacy VS Code history and yolo mode (hooks disabled)
remain explicit exclusions.

## Claude Code 2.1.284

Fixtures cover human/assistant turns, tool-result and delegated-context attribution,
visible thinking, sealed redacted_thinking siblings, image/document references,
file-history snapshots/deltas, session settings, activity and context injection.
Current native atis-latch and cumulative cost-state records retain their fields.
Ciphertext revisions have distinct digest-bearing identities, and replay recreates
both visible and sealed siblings. Malformed supported turn envelopes remain drift.
Native macOS headless and PTY sessions pass installed Stop/SessionEnd hooks,
linked read/result/answer, graceful exit and exact final-tail/backfill identity.
PTY prompts are initial CLI arguments; disposable onboarding, workspace and dummy
key approvals are preconfigured. Typed prompt entry, live attachments, branching,
compaction, ephemeral sessions and full native type coverage remain unverified.

## Codex CLI 0.159.0

Fixtures cover explicit role attribution, message/tool variants, visible reasoning
summaries and sealed ciphertext, inter-agent messages, session/turn context, activity
and current token_usage_record accounting. Ciphertext changes at an identical
source position produce distinct identities. Native macOS headless and PTY proof
passes installed Stop/SessionEnd hooks, linked shell read/result/answer, graceful
exit, no unknown records and exact final-tail/repeated-backfill IDs. Interactive
background title generation uses a bounded deterministic fixture. PTY prompts
are initial CLI arguments. Disposable workspace trust is preconfigured and hook
trust bypass is invocation-scoped; interactive trust review, typed prompt entry,
attachments, forks, compaction and ephemeral sessions remain unverified.

## Mistral Vibe 2.25.8, legacy backend

Fixtures cover native message roles, visible reasoning, tool calls/results,
resources and input text, image locators, display content, injected context,
compaction boundaries, manual shell results, metadata/system instructions and
configuration credential omission. Mutable snapshots retain source ordering
across deletion and same-length rewrites. Tests cover concurrent capture, verified
child links, escaped pointers, unknown shapes, ciphertext siblings and replay.
Native macOS headless and initial-prompt PTY proof passes the installed post_agent
hook, real read/result/answer, keyboard exit and exact repeated backfill. PTY uses
invocation-scoped --trust and --auto-approve for its disposable repository. Typed
prompt entry, approval dialogs, live attachments, compaction and subagents remain
unverified. Unified backend installations remain explicitly unsupported.

## Goose 1.52.0

Fixtures cover all eleven native content variants: text, image, document,
thinking, redactedThinking, toolRequest, toolResponse,
toolConfirmationRequest, actionRequired, systemNotification and error. They
exercise confirmation/elicitation actions, tool errors, provider metadata,
invisible context, composite attribution, linked descendants, mutable snapshots,
rewind/deletion-stable identity and unknown shapes. Native macOS headless and
typed-prompt PTY scenarios pass with installed Stop/SessionEnd plugin hooks,
linked successful shell read, answer, session header and exact backfills.
Native approvals/elicitation, media, branching, compaction and ephemeral sessions
remain unverified.

## OpenHands CLI 1.16.0 / SDK 1.21.0

Fixtures cover every concrete SDK event type: messages, actions, observations,
rejection/error events, system prompts, condensation/summary/request,
conversation state updates, streaming deltas, ACP tool calls, tokens, pauses,
hook execution, completion logs and conversation errors. They exercise sealed
provider reasoning, structured completion-log decoding, media references,
conservative attribution, child directories, exact workspace scoping and drift.
Native macOS headless and typed-prompt Textual PTY scenarios pass with installed
hooks, linked file read/result, answer, base state, persisted Stop self-observation,
exited tail worker and exact repeated backfill. SDK1.21.0's visualizer raises
`App is not running` during atexit before persisting SessionEnd self-observation;
that missing upstream event is an explicit exclusion. Native media, forks,
compaction, ephemeral sessions and all lifecycle variants remain unverified.

## Open Interpreter Rust 0.0.45

The adapter targets the current Rust product, not historical Python sessions.
Fixtures enumerate its rollout kinds, response variants and EventMsg union,
including native ordinals, revert streams, compressed journals, inherited history
references, explicit child lineage, tool search/local shell/web/image operations,
realtime items, configuration/compaction context, accounting and security events.
Unknown nested parts remain drift. Ciphertext, including encrypted function
arguments and inter-agent content, gets separate digest-bearing records; replay
preserves siblings. Native macOS headless and initial-prompt PTY proof passes
installed Stop/SessionEnd hooks, real read/result/answer, graceful exit and exact
final-tail/backfill IDs. Interactive testing uses a custom fixture model to avoid
the native retired-model migration screen. Typed prompt entry, trust review,
live forks, compaction, realtime and multimodal input remain unverified.

### Droid public-startup qualification (2026-09-29)

Earlier experimental headless runs set `FACTORY_AIRGAP_ENABLED`; they are not
accepted evidence for public startup. Factory documents airgap builds as a
separate enterprise distribution. The verifier now removes that override and
also removes undocumented `FACTORY_DISABLE_DYNAMIC_CONFIG`. A fresh public
0.229.0 headless run passed all capture gates with only the synthetic BYOK
provider (two requests, no Factory account). This is consistent with Factory's
published BYOK authentication fixes. See [airgap deployment](https://docs.factory.ai/enterprise/airgapped-deployment),
[BYOK configuration](https://docs.factory.ai/model-independence/byok), and
[release notes](https://docs.factory.ai/changelog/release-notes).

Public interactive startup is blocked by a concrete login requirement. After
removing both `CI` and `NO_COLOR` from the PTY environment and selecting the
custom model explicitly, public 0.229.0 renders “Please login with your Factory
account to continue.” The earlier blank-frame result was a harness environment
issue, not proof of an idle authentication request. The public headless BYOK
result remains valid; these modes have different startup behavior.

An interactive rerun requires an authorized Factory test account. The official
CLI reference documents `FACTORY_API_KEY` authentication. For this verifier,
set `CLEDGER_VERIFY_DROID_FACTORY_API_KEY` outside chat using a test key from the
Factory API-key settings; the verifier maps it to `FACTORY_API_KEY` only for the
native Droid process. The programmatic option is `factoryApiKey`. This opt-in
never borrows a normal `FACTORY_API_KEY`, keychain login or user-profile file.
HOME/config and captured content remain synthetic, and inference remains pinned
to the scripted local BYOK model. An authenticated interactive run has not yet
been verified. No undocumented enterprise override is used, no login was
attempted, and no credential should be pasted into chat.

The updater-disable setting is documented in the [CLI reference](https://docs.factory.ai/droid-cli/cli-reference);
keyring control is documented in release notes. The native HOME override is used
only to bound all state to the synthetic profile. No authentication bypass flags
remain. Factory's [individual pricing](https://docs.factory.ai/pricing/individuals)
lists paid plans with a BYOK allowance; it does not establish free account
entitlement. This does not alter the observed unauthenticated local-BYOK headless
result.
