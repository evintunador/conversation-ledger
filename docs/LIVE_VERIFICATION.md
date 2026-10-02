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
| Claude Code | Pending | Blocked on macOS | Installed 2.1.280 TUI accepted disposable-folder trust and sent a prompt to local Ollama; tiny model produced no answer before the deadline, so no automatic turn evidence was captured. A minimal logged-in provider check is pending. |
| Codex | Pending | Blocked on macOS | Installed 0.160.0 TUI accepted disposable-folder trust and sent a prompt to local Ollama; tiny model produced no answer before the deadline, so no automatic turn evidence was captured. A minimal logged-in provider check is pending. |
| Gemini CLI | Pending | Pass on macOS | Installed 0.61.0 with logged-in provider: human prompt, `read_file` call/result and exact file answer appeared in disposable ledger. |
| GitHub Copilot CLI | Partial on macOS | Partial on macOS | Installed 1.0.89 with offline local Ollama `ledger-test`: real headless and interactive TUI sessions automatically captured human prompt, model response, native tool call/result, and shutdown with no unrecognized records. The tiny model supplied invalid arguments (`glob.paths` and `view.file_path`), so neither session proved a successful file read or exact answer; a sandbox-blocked first attempt was excluded. No premium requests. |
| Cursor CLI | Pass on macOS | Partial on macOS | Installed 2026.10.01 logged-in CLI read a synthetic file in both modes. The optional headless stream-JSON wrapper captures full results; the interactive native transcript lacks tool-result bodies. |
| Qwen Code | Pending | Pending | Scripted native tests alone are insufficient. |
| Kimi Code | Partial on macOS | Pending | Installed 2.1.1 reached local Ollama `ledger-test` and captured human/tool/result/answer, but the tiny model chose the wrong tool. Interactive folder-trust approval remains pending. |
| Mistral Vibe | Pending | Pending | Scripted native tests alone are insufficient. |
| Factory Droid | Pass on macOS | Deferred | Installed 0.232.0 with local Ollama captured prompt, Read call/result and answer; Factory reported zero credits. Interactive approval pending. |
| Kiro CLI | Pass on macOS | Pass on macOS | Installed 2.27.0 with logged-in free account captured synthetic prompt, file read/result and answer; roughly 0.05 credits for interactive turn. Default V2 uses a watched launcher, V3 uses native hooks. |
| OpenCode | Pending | Partial on macOS | Installed 1.18.10 TUI reached local Ollama and native hook; small `ledger-test` model produced inconsistent file paths/answers. Scripted TUI passes, but live answer/linkage gate has not passed. |
| Pi | Pending | Partial on macOS | Installed 0.87.1 with local Ollama: TUI captured two prompts, `read` call/result, state and assistant text; tiny model's answer was malformed. |
| OpenHands CLI | Pending | Pending | Scripted native tests alone are insufficient. |
| Cline CLI | Pending | Deferred | Browser onboarding interrupted previous interactive check. |
| Open Interpreter | Pending | Pending | Scripted native tests alone are insufficient. |
| Goose | Pending | Pass on macOS | Installed 1.52.0 TUI with local Ollama captured the human prompt, linked `shell` call/result and exact file answer through native hooks before backfill. |
| Aider | Pending | Pending | Scripted native tests alone are insufficient. |
| Continue CLI | Pending | Pending | Scripted native tests alone are insufficient. |
| Crush | Pending | Pending | Scripted native tests alone are insufficient. |
| Kilo CLI | Pending | Pending | Scripted native tests alone are insufficient. |

Cursor and Kiro adapters were built against these observed sessions; their
macOS runs are not a claim of completed automatic capture on both operating
systems. Live model results on macOS do not establish Linux
behavior. This table records only observed cases, not market coverage.
