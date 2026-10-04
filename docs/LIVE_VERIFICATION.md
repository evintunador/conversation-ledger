# Live CLI verification

This is a separate gate from the scripted native smoke campaign. The scheduled
GitHub Actions campaign installs real CLI binaries and drives their terminal
interfaces, but its model replies come from local scripted providers. That
proves native launch, hooks, persisted records and parser behavior for those
scenarios; it does not prove an ordinary session against a real model or product
account. Its 18/20 result must never be described as live integration coverage.

For a live pass, record the exact installed CLI version, operating system,
provider and model route, execution mode, prompt, native tool result, automatic
ledger output before backfill, exit behavior, and any metered credits. Use a
disposable repository and benign canary. A headless live pass and an interactive
TUI live pass are distinct. A model choosing the wrong tool, unavailable native
result bodies, login-only behavior, or a skipped account flow is an explicit
gap. Raw preservation does not establish full normalized record coverage.

## Cost and execution tiers

The existing scheduled GitHub Actions tier spends no inference credits and
remains a compatibility alarm for pinned and candidate binaries. A separate
live-provider tier must be opt-in. Free local providers can run on a machine
with the service installed; GitHub-hosted runners cannot reach a laptop's
loopback Ollama endpoint. Product-account or paid API runs require an explicit
CLI/model selection, a per-CLI price estimate and the agreed $5 initial or
$5/month ceiling, request/output/timeout limits, and a recorded approval for
that run. No scheduled workflow may silently use paid secrets, and a local
estimate is not a provider-side hard spending cap. Keep review before merge.

The manual [budgeted live workflow](BUDGETED_LIVE_VERIFICATION.md) now has a
first installed OpenCode TUI consumer and a durable authority implementation.
No authority, protected environment, provider route or paid run is activated.
Other CLI consumers and protocols remain unsupported by this automation.
A per-run limit alone cannot enforce the monthly ceiling: the authority reserves
reviewed worst-case charges in persistent atomic state before forwarding.
Unknown prices, input/output bounds or billable features fail closed. Account
credit and subscription sessions remain individually reviewed manual checks.
The free scheduled workflow never receives paid inference credentials.

## Current observed live evidence (2026-10-03)

| CLI | Live headless | Live interactive TUI | Evidence / gap |
| --- | --- | --- | --- |
| Claude Code | Pending | Pass on macOS | Installed 2.1.280 in a real PTY with local Ollama `ledger-test`: after the prompt and Enter were sent separately, its native hook automatically captured the typed human prompt, linked `Read(evidence.txt)` call/result containing the synthetic canary, and assistant answer before backfill (19 events, zero unrecognized). `/exit` ended normally; the tiny model included the canary but added numbering and extra prose despite an exact-only request. The earlier attempt had left the prompt in the editor without submitting it. [Synthetic evidence](verification-evidence/live-claude-code-macos-2026-10-01.json). |
| Codex | Provider reachable on macOS; capture pending | Pass on macOS | Installed 0.160.0 with logged-in GPT-6.1-Sol in a real PTY: typed prompt, `exec` file-read call, linked result containing the exact synthetic file content, and exact assistant answer were captured automatically by generated project hooks before backfill (20 events, no unrecognized records). `/exit` ended normally. The PTY driver needed a separate Enter after displaying typed text; earlier stalled attempts had sent no model requests. [Synthetic evidence](verification-evidence/live-codex-macos-2026-10-01.json). |
| Gemini CLI | Pending | Pass on macOS | Installed 0.61.0 with logged-in provider: human prompt, `read_file` call/result and exact file answer appeared in disposable ledger. |
| GitHub Copilot CLI | Partial on macOS | Pass on macOS | Installed 1.0.89 with local DeepSeek `deepseek-v4-flash` in a fresh disposable real TUI session: typed human prompt, linked `view` call/successful result and answer containing the exact synthetic file text were captured automatically before backfill (17 events, no unrecognized records); normal `/quit` exit. Two guarded local requests, no premium requests. The first DeepSeek attempt was blocked when the gateway went offline; the user restored it before this fresh rerun. Earlier tiny-Ollama headless testing had invalid tool arguments and remains partial. [Synthetic evidence](verification-evidence/live-copilot-macos-2026-10-02.json). |
| Cursor CLI | Pass on macOS | Pass on macOS | Installed 2026.10.01-e373342 with an existing logged-in account in a real TUI: native hooks automatically captured the typed prompt, two sequential `Read` calls with exact native IDs, both linked synthetic text bodies and the answer before backfill (11 events, zero unrecognized); normal exit. Bodies are staged privately until a uniquely matched successful post hook confirms them. Ambiguous same-file reads retain references. No metered charge amount was exposed; this is not a claim of free usage. [Synthetic evidence](verification-evidence/live-cursor-macos-2026-10-03.json). |
| Qwen Code | Pending | Pass on macOS | Installed 0.21.5 in a real TUI with local DeepSeek `deepseek-v4-flash`: native hooks automatically captured the typed prompt, linked `read_file` call/successful result and exact synthetic file answer before backfill (9 events, no unrecognized records); normal `/exit`. Three guarded local requests. This replaces the earlier tiny-Ollama partial result and records the current binary’s observed version. [Synthetic evidence](verification-evidence/live-qwen-code-macos-2026-10-02.json). |
| Kimi Code | Partial on macOS | Pass on Linux; partial on macOS | Installed 2.1.1 actual Linux TUI with local Ollama Qwen3:8b: typed prompt, linked Read call/result, exact-file answer and native session state appeared automatically before backfill (36 events, no unknown records), followed by normal exit. Two bounded local requests. Native folder trust was accepted under the user's prior authorization. The repaired-guard macOS DeepSeek attempt separately stopped on HTTP 503 without retry. Native macOS Unicode/image-reference/resume/error proofs remain distinct from a final-answer pass. [Linux live evidence](verification-evidence/live-kimi-linux-2026-10-03.json), [macOS live attempt](verification-evidence/live-kimi-macos-2026-10-03.json), [native input](verification-evidence/native-kimi-input-macos-2026-10-03.json), [resume](verification-evidence/native-kimi-resume-macos-2026-10-03.json). |
| Mistral Vibe | Pending | Pass on macOS | Installed 2.25.8 legacy TUI with local Ollama `ledger-test` and typed prompts: native `post_agent` hook captured two human turns, linked `read_file` calls/results, exact synthetic file answer, and session state before backfill. The tiny model invented a missing path first; a second prompt supplied the absolute path and succeeded. [Synthetic evidence](verification-evidence/live-mistral-vibe-macos-2026-10-01.json). |
| Factory Droid | Pass on macOS | Pass on macOS | Installed 0.232.0 with existing login and local DeepSeek `deepseek-v4-flash` through ds4-gateway: project native Stop hook automatically captured the typed prompt, linked `Read(evidence.txt)` call/result and exact file answer before backfill (14 events); `/quit` exited normally. BYOK runtime settings disabled cloud sync. An empty isolated profile requires login; the existing normal login works. The top-level TUI treated unsupported `--model` arguments as an extra initial prompt, which was cancelled; runtime `settings.model` selects the model correctly. Prior local Ollama headless run passed and reported zero Factory credits. [Synthetic evidence](verification-evidence/live-droid-macos-2026-10-02.json). |
| Kiro CLI | Pass on macOS | Pass on macOS | Installed 2.27.0 with logged-in free account captured synthetic prompt, file read/result and answer; roughly 0.05 credits for interactive turn. Default V2 uses a watched launcher, V3 uses native hooks. |
| OpenCode | Pending | Pass on macOS | Installed 1.18.10 actual TUI with restored local DeepSeek `deepseek-v4-flash`: native plugin automatically captured human prompt, linked `read(evidence.txt)` call/result and assistant answer containing the exact synthetic file text before backfill; no unrecognized records, normal `/exit`, two backfills idempotent. Three guarded local requests in 54.4 seconds, no paid use. An earlier bounded attempt hit the 60-second upstream deadline; the separately authorized final attempt used 180 seconds per request. [Synthetic evidence](verification-evidence/live-opencode-macos-2026-10-02.json). |
| Pi | Pending | Pass on macOS | Installed 0.87.1 actual TUI with restored local DeepSeek `deepseek-v4-flash`: typed prompt, linked `read(evidence.txt)` call/result, exact assistant answer, and native session state automatically captured before backfill (8 events, zero unrecognized); `/quit` exited normally. Two guarded local requests, no paid use. [Synthetic evidence](verification-evidence/live-pi-macos-2026-10-02.json). |
| OpenHands CLI | Pending | Pass on macOS | Installed 1.16.0 with local DeepSeek `deepseek-v4-flash` in a real TUI: six native hooks automatically captured the submitted prompt before any model reply, then the linked `file_editor` view/successful result and answer quoting the exact synthetic file text before backfill (19 events, no unrecognized records); normal Ctrl+Q exit. Default tool approvals stayed enabled; only the observed synthetic read was approved. The same conversation resumed once to handle its approval screen; two cumulative guarded requests, 360-second request and 600-second session limits. The model added prose around the quoted file text. The earlier 180-second timeout is retained. An installed-TUI regression also proves prompt capture while a fixture sends no model reply; SDK’s ignored shutdown visualizer traceback remains an upstream limitation. [Synthetic evidence](verification-evidence/live-openhands-macos-2026-10-02.json). |
| Cline CLI | Pending | Pass on macOS | Installed 3.0.65 TUI used an isolated OpenAI-compatible provider against local Ollama `ledger-test`, with no account or browser onboarding. The native hooks automatically captured the initial prompt, linked `read_files` call/result containing the exact synthetic file, and exact answer before backfill (9 events, no unrecognized records). The repaired tail follower stayed running while the TUI remained open for 40 seconds after `agent_end`, then completed after normal exit. Welcome-editor prompt entry remains untested. [Synthetic evidence](verification-evidence/live-cline-macos-2026-10-01.json). |
| Open Interpreter | Pending | Pass on macOS | Installed Rust 0.0.45 in a real TUI with local DeepSeek `deepseek-v4-flash`, explicit `harness = "native"`, `wire_api = "chat"` and `--chat-completions`: native hooks automatically captured the typed prompt, linked read-only `exec_command` file read and exact synthetic file answer before backfill (18 events, no unrecognized records); normal `/exit`. Four guarded local requests. The targeted prompt names the observed supported tool; prior transport failures and a request-limited turn are retained in the evidence. The default DeepSeek harness had rejected this local route before inference. [Synthetic evidence](verification-evidence/live-open-interpreter-macos-2026-10-02.json). |
| Goose | Pending | Pass on macOS | Installed 1.52.0 TUI with local Ollama captured the human prompt, linked `shell` call/result and exact file answer through native hooks before backfill. |
| Aider | Pending | Pass on macOS | Installed 0.86.2 with local Ollama `ledger-test` in a real PTY: explicit `cledger run aider` wrapper automatically captured the human prompt, linked `read_text` call/result with exact synthetic file text, model context, assistant output containing that text, and normal exit before any backfill. The tiny model formatted its answer as a file listing and attempted an unchanged write despite the no-edit prompt. |
| Continue CLI | Pending | Pass on macOS | Installed 1.5.47 in a real PTY with local Ollama `ledger-test`: explicit `cledger run continue` wrapper automatically captured the typed human prompt, `Read(evidence.txt)` call, linked result containing the synthetic file, and exact assistant answer before exit or manual backfill; `/exit` ended normally. [Synthetic evidence](verification-evidence/live-continue-macos-2026-10-01.json). |
| Crush | Pending | Pass on macOS | Installed 0.97.1 in a real TUI with local DeepSeek `deepseek-v4-flash`: the explicit watched launcher automatically captured the typed prompt, linked `view` call/successful result and exact synthetic file answer before backfill (18 events, no unrecognized records); normal quit. Four guarded local requests including auxiliary generation. An earlier driver attempt typed the prompt without submitting it because wrapping defeated the readiness matcher; it made zero model requests and is excluded. The driver was corrected from the observed terminal trace. [Synthetic evidence](verification-evidence/live-crush-macos-2026-10-02.json). |
| Kilo CLI | Pending | Pass on macOS | Installed 7.8.1 TUI with local Ollama `ledger-test` read the synthetic file and exited normally. Before manual backfill, the native plugin had captured 10 events: human prompt, linked `read` call/result with exact file text, assistant answer containing that text, and session/activity state. A later backfill added a changed session title; a second backfill was idempotent. An earlier TUI attempt produced a model hallucination and timed out before ledger inspection. [Synthetic evidence](verification-evidence/live-kilo-macos-2026-10-01.json). |

Cursor and Kiro adapters were built against these observed sessions; their
macOS runs are not a claim of completed automatic capture on both operating
systems. Live model results on macOS do not establish Linux
behavior. This table records only observed cases, not market coverage.

All twenty selected products now have a real-model TUI canary pass on at least
one target OS. Nineteen were observed on macOS; Kimi's passing live check was on
Linux. This does not certify all record types, both modes/OSes or market share.
The separate [fresh installed Linux campaign](verification-evidence/native-installed-linux-2026-10-03.json)
records seventeen scripted-provider TUI passes, one explicit Droid authentication
blocker and two account-only products outside that free campaign.
