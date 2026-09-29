# Coding CLI roster research

## Selected implementation roster

The user authorized practical judgment rather than strict lab definitions or
exact rankings. Freeze these twenty for the initial program:

- **Big players:** Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Cursor CLI,
  Qwen Code, Kimi Code, Mistral Vibe, Factory Droid, Kiro CLI.
- **Independents:** OpenCode, Pi, OpenHands CLI, Cline CLI, Open Interpreter,
  Goose, Aider, Continue CLI, Crush, Kilo CLI.

Continue is explicitly legacy support. OpenHands uses product-level popularity
rather than the much smaller standalone CLI repository's stars. These are
practical groups, not a taxonomy of corporate ownership. Amp, MiniMax Code,
Trae Agent and CodeBuddy remain follow-up candidates, not hidden denominator
changes. Subscription/authentication obstacles remain visible blocked gates.

Existing adapters cover Claude Code, Codex, Gemini CLI, Qwen Code and OpenCode;
none is yet certified against the new native verification gates. Eighteen of
twenty fully passing integrations would meet the 90% roster target; all twenty
remain the intended implementation scope.

The research below explains selection; its earlier classification questions
are historical caveats, not open questions to the user.

Discovery snapshot: 2026-09-28. Provisional candidates, not a final denominator
or claim of exhaustive GitHub ranking. Counts are rounded GitHub display values
observed during research, not exact API counts. Freeze exact counts and eligibility
before implementation assignments. Stars for a whole product are not CLI users.

## Independent candidates

Proposed eligibility: usable coding CLI, one canonical product repository,
excluding libraries, orchestration-only projects and nonproduction exhibits.
This list uses product-repository stars, including mixed CLI/IDE repositories.

| Order among researched candidates | Product / star source | Displayed stars | Caveat |
|---|---|---:|---|
| 1 | [OpenCode](https://github.com/anomalyco/opencode) | 210.6k | Existing adapter |
| 2 | [Pi](https://github.com/earendil-works/pi) | 110.1k | Monorepo includes libraries |
| 3 | [OpenHands](https://github.com/OpenHands/OpenHands) | 89.4k | Umbrella repository; separate CLI repository has far fewer stars |
| 4 | [Cline](https://github.com/cline/cline) | 69.5k | Shared IDE/CLI audience |
| 5 | [Open Interpreter](https://github.com/openinterpreter/openinterpreter) | 68.5k | Current Rust implementation differs from historical Python product |
| 6 | [Goose](https://github.com/aaif-goose/goose) | 54.7k | Desktop and CLI |
| 7 | [Aider](https://github.com/Aider-AI/aider) | 49.2k | Terminal product |
| 8 | [Continue](https://github.com/continuedev/continue) | 36.1k | README says no longer actively maintained; eligibility decision needed |
| 9 | [Crush](https://github.com/charmbracelet/crush) | 28.3k | Terminal product |
| 10 | [Kilo](https://github.com/Kilo-Org/kilocode) | 27.4k | Shared IDE/CLI audience |

[Claw Code](https://github.com/ultraworkers/claw-code), 195.3k, would alter this
ranking but describes itself as a museum exhibit rather than a serious production
project. [SWE-agent](https://github.com/SWE-agent/SWE-agent) and
[Plandex](https://github.com/plandex-ai/plandex) are lower-star alternatives.
Do not silently transfer OpenHands umbrella stars to its separate CLI repository;
the proposed product-level interpretation must be stated in the final roster.

## Lab and vendor candidates

Definition pending: strict model labs versus commercial coding vendors, including
model-owning parent companies. Public issue/feedback repositories and implementation
repositories are not equally informative. Proprietary products without a meaningful
repository remain unranked rather than being assigned zero stars.

| Product / repository | Displayed stars | Classification note |
|---|---:|---|
| [Claude Code](https://github.com/anthropics/claude-code) | 148.5k | Anthropic; existing adapter |
| [Codex](https://github.com/openai/codex) | 127.0k | OpenAI; existing adapter |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 107.2k | Google; existing adapter |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | 28.2k | Alibaba; existing adapter |
| [Trae Agent](https://github.com/bytedance/trae-agent) | 12.1k | ByteDance; research-oriented, distinct from Trae IDE |
| [Copilot CLI](https://github.com/github/copilot-cli) | 11.2k | GitHub/Microsoft; bucket decision |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | 7.7k | Moonshot; successor to archived kimi-cli, distinct format |
| [Mistral Vibe](https://github.com/mistralai/mistral-vibe) | 5.0k | Mistral |
| [Kiro](https://github.com/kirodotdev/Kiro) | 4.3k | Amazon; whole-product feedback repository |
| [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) | 1.9k | MiniMax; current end-user product rather than Mini-Agent demo |

Additional eligibility cases: [Hermes](https://github.com/NousResearch/hermes-agent)
is a very high-star Nous Research general agent, not primarily a coding CLI.
[Tencent CodeBuddy](https://www.codebuddy.ai/docs/cli/cli-reference) has a CLI but
no meaningful canonical star ranking was established in this research. Cursor,
Factory and Amp are commercial independent vendors and need a stated treatment
if commercial vendors replace the strict lab bucket. No roster is final yet.

## Provider and cost evidence

- [Copilot BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
  permits external providers; an API key need not mean a Copilot subscription.
- [OpenCode CLI](https://opencode.ai/docs/cli/),
  [Qwen authentication](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/),
  and [Aider API keys](https://aider.chat/docs/config/api-keys.html) support provider
  configuration. Test local DeepSeek compatibility instead of assuming it.
- [Gemini authentication](https://geminicli.com/docs/get-started/authentication/)
  supports API-key/Vertex routes; the local gateway's advertised protocols do not
  establish a Gemini-compatible endpoint.
- [Kiro authentication](https://kiro.dev/docs/cli/authentication/) ties its API-key
  mode to a paid account. A product API key is not proof of direct-provider billing.
- [Amp pricing](https://ampcode.com/docs/pricing) documents credits without a
  subscription commitment; this does not determine roster eligibility.

This research is a starting inventory. Each assigned agent must pin the native
version, verify installation/authentication/protocol contracts and run the shared
acceptance suite before support claims or spending estimates become commitments.

## Current blockers (2026-09-29)

**Kiro CLI remains unsupported and is not counted as verified coverage.** Its
[authentication documentation](https://kiro.dev/docs/getting-started/authentication/)
requires a Pro, Pro+, Pro Max, or Power account to create a `KIRO_API_KEY`; API-key
usage consumes subscription credits. The
[headless guide](https://kiro.dev/docs/cli/headless/) requires that key for CI runs.
No documented direct-provider or loopback endpoint was established, so this is
not an API-direct, zero-cost native-test target yet. No account was created, no
subscription was purchased, and no authenticated run was attempted.

The [official release manifest](https://prod.download.cli.kiro.dev/stable/latest/manifest.json)
reported binary version **2.25.0** on this date. The V3 terminology in current
docs names its selectable agent harness, not the published binary version.
[Session persistence documentation](https://kiro.dev/docs/cli/chat/session-management/)
describes a local per-directory database and session JSON export, but does not
supply a complete persisted-record schema. Hook payloads alone do not establish
full conversation, attachment, reasoning, compaction, or child-session capture.
Before claiming integration, validate an authorized native session/export and
its schema, native hook timing, and a tractable recurring authentication budget.
