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

The opt-in paid GitHub workflow and per-provider budget enforcement are not yet
implemented. Until they are, live checks run manually on disposable machines
and their evidence is reviewed before promotion. Do not relabel the scripted
campaign as the paid/live tier.

The paid tier should be a separate manual-dispatch workflow, with a protected
GitHub environment approval for the exact CLI, model and run. Its runner should
give the CLI only a localhost proxy URL; the proxy holds the provider key and
reserves the maximum possible cost before each request, with request, token and
wall-clock limits. A per-run limit alone cannot enforce the $5 monthly
per-CLI ceiling: that needs provider-side hard budgets or a durable, atomic
spend ledger shared across runs. If price or usage accounting is unknown, the
gateway must fail closed. Account-credit and subscription sessions bypass that
proxy and remain individually reviewed manual checks. The free scheduled
workflow never receives paid credentials.

## Current observed live evidence (2026-10-01)

| CLI | Live headless | Live interactive TUI | Evidence / gap |
| --- | --- | --- | --- |
| Claude Code | Pending | Pass on macOS | Installed 2.1.280 in a real PTY with local Ollama `ledger-test`: after the prompt and Enter were sent separately, its native hook automatically captured the typed human prompt, linked `Read(evidence.txt)` call/result containing the synthetic canary, and assistant answer before backfill (19 events, zero unrecognized). `/exit` ended normally; the tiny model included the canary but added numbering and extra prose despite an exact-only request. The earlier attempt had left the prompt in the editor without submitting it. [Synthetic evidence](verification-evidence/live-claude-code-macos-2026-10-01.json). |
| Codex | Provider reachable on macOS; capture pending | Pass on macOS | Installed 0.160.0 with logged-in GPT-6.1-Sol in a real PTY: typed prompt, `exec` file-read call, linked result containing the exact synthetic file content, and exact assistant answer were captured automatically by generated project hooks before backfill (20 events, no unrecognized records). `/exit` ended normally. The PTY driver needed a separate Enter after displaying typed text; earlier stalled attempts had sent no model requests. [Synthetic evidence](verification-evidence/live-codex-macos-2026-10-01.json). |
| Gemini CLI | Pending | Pass on macOS | Installed 0.61.0 with logged-in provider: human prompt, `read_file` call/result and exact file answer appeared in disposable ledger. |
| GitHub Copilot CLI | Partial on macOS | Partial on macOS | Installed 1.0.89 with offline local Ollama `ledger-test`: real headless and interactive TUI sessions automatically captured human prompt, model response, native tool call/result, and shutdown with no unrecognized records. The tiny model supplied invalid arguments (`glob.paths` and `view.file_path`), so neither session proved a successful file read or exact answer; a sandbox-blocked first attempt was excluded. No premium requests. |
| Cursor CLI | Pass on macOS | Partial on macOS | Installed 2026.10.01 logged-in CLI read a synthetic file in both modes. The optional headless stream-JSON wrapper captures full results; the interactive native transcript lacks tool-result bodies. |
| Qwen Code | Pending | Partial on macOS | Installed CLI reported 0.21.9 (`0.21.5` in the running TUI/transcript). With local Ollama `ledger-test`, its native Stop hook captured two typed prompts, a successful `read_file` call/result containing the exact synthetic file, and assistant responses before backfill. The tiny model's final answer paraphrased the file instead of copying it exactly. |
| Kimi Code | Partial on macOS | Pending | Installed 2.1.1 reached local Ollama `ledger-test` and captured human/tool/result/answer, but the tiny model chose the wrong tool. Interactive folder-trust approval remains pending. |
| Mistral Vibe | Pending | Pass on macOS | Installed 2.25.8 legacy TUI with local Ollama `ledger-test` and typed prompts: native `post_agent` hook captured two human turns, linked `read_file` calls/results, exact synthetic file answer, and session state before backfill. The tiny model invented a missing path first; a second prompt supplied the absolute path and succeeded. [Synthetic evidence](verification-evidence/live-mistral-vibe-macos-2026-10-01.json). |
| Factory Droid | Pass on macOS | Deferred | Installed 0.232.0 with local Ollama captured prompt, Read call/result and answer; Factory reported zero credits. Interactive approval pending. |
| Kiro CLI | Pass on macOS | Pass on macOS | Installed 2.27.0 with logged-in free account captured synthetic prompt, file read/result and answer; roughly 0.05 credits for interactive turn. Default V2 uses a watched launcher, V3 uses native hooks. |
| OpenCode | Pending | Partial on macOS | Installed 1.18.10 TUI reached local Ollama and native hook; small `ledger-test` model produced inconsistent file paths/answers. Scripted TUI passes, but live answer/linkage gate has not passed. |
| Pi | Pending | Partial on macOS | Installed 0.87.1 with local Ollama: TUI captured two prompts, `read` call/result, state and assistant text; tiny model's answer was malformed. |
| OpenHands CLI | Pending | Partial on macOS | Installed 1.16.0 TUI with local Ollama `ledger-test` captured two typed prompts, a linked `file_editor` call/error result, assistant responses, session state and Stop hook observations automatically before backfill; normal exit. The tiny model omitted the required `security_risk` argument, so no successful file read or exact answer occurred. [Synthetic evidence](verification-evidence/live-openhands-macos-2026-10-01.json). |
| Cline CLI | Pending | Pass on macOS | Installed 3.0.65 TUI used an isolated OpenAI-compatible provider against local Ollama `ledger-test`, with no account or browser onboarding. The native hooks automatically captured the initial prompt, linked `read_files` call/result containing the exact synthetic file, and exact answer before backfill (9 events, no unrecognized records). The repaired tail follower stayed running while the TUI remained open for 40 seconds after `agent_end`, then completed after normal exit. Welcome-editor prompt entry remains untested. [Synthetic evidence](verification-evidence/live-cline-macos-2026-10-01.json). |
| Open Interpreter | Pending | Partial on macOS | Installed 0.0.45 TUI with local Ollama `ledger-test` captured three prompts, a linked tool call/result, session state and an assistant response through native hooks before backfill (36 events); normal `/exit`. The tiny model tried `view_image` on the text file, then hallucinated an unrelated answer, so successful file read and exact answer remain unverified. [Synthetic evidence](verification-evidence/live-open-interpreter-macos-2026-10-01.json). |
| Goose | Pending | Pass on macOS | Installed 1.52.0 TUI with local Ollama captured the human prompt, linked `shell` call/result and exact file answer through native hooks before backfill. |
| Aider | Pending | Pass on macOS | Installed 0.86.2 with local Ollama `ledger-test` in a real PTY: explicit `cledger run aider` wrapper automatically captured the human prompt, linked `read_text` call/result with exact synthetic file text, model context, assistant output containing that text, and normal exit before any backfill. The tiny model formatted its answer as a file listing and attempted an unchanged write despite the no-edit prompt. |
| Continue CLI | Pending | Pass on macOS | Installed 1.5.47 in a real PTY with local Ollama `ledger-test`: explicit `cledger run continue` wrapper automatically captured the typed human prompt, `Read(evidence.txt)` call, linked result containing the synthetic file, and exact assistant answer before exit or manual backfill; `/exit` ended normally. [Synthetic evidence](verification-evidence/live-continue-macos-2026-10-01.json). |
| Crush | Pending | Partial on macOS | Installed 0.97.1 TUI with local Ollama `ledger-test` accepted a typed prompt and the explicit `cledger run crush` watched launcher captured nine native SQLite records, including the human prompt and model thinking, before exit or manual backfill. The tiny model described a `view` call but never made it, so tool call/result and exact answer remain unverified. The TUI exited normally. [Synthetic evidence](verification-evidence/live-crush-macos-2026-10-01.json). |
| Kilo CLI | Pending | Pass on macOS | Installed 7.8.1 TUI with local Ollama `ledger-test` read the synthetic file and exited normally. Before manual backfill, the native plugin had captured 10 events: human prompt, linked `read` call/result with exact file text, assistant answer containing that text, and session/activity state. A later backfill added a changed session title; a second backfill was idempotent. An earlier TUI attempt produced a model hallucination and timed out before ledger inspection. [Synthetic evidence](verification-evidence/live-kilo-macos-2026-10-01.json). |

Cursor and Kiro adapters were built against these observed sessions; their
macOS runs are not a claim of completed automatic capture on both operating
systems. Live model results on macOS do not establish Linux
behavior. This table records only observed cases, not market coverage.
