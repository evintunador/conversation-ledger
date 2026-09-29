/** Fixed denominator agreed 2026-09-28. Presence is never a support claim. */
export interface TargetCli {
  id: string;
  name: string;
  group: "big-player" | "independent";
  command: string;
  repository?: string;
}

export const TARGET_CLIS: readonly TargetCli[] = [
  { id: "claude-code", name: "Claude Code", group: "big-player", command: "claude", repository: "anthropics/claude-code" },
  { id: "codex", name: "Codex", group: "big-player", command: "codex", repository: "openai/codex" },
  { id: "gemini-cli", name: "Gemini CLI", group: "big-player", command: "gemini", repository: "google-gemini/gemini-cli" },
  { id: "copilot", name: "GitHub Copilot CLI", group: "big-player", command: "copilot", repository: "github/copilot-cli" },
  { id: "cursor", name: "Cursor CLI", group: "big-player", command: "agent" },
  { id: "qwen-code", name: "Qwen Code", group: "big-player", command: "qwen", repository: "QwenLM/qwen-code" },
  { id: "kimi", name: "Kimi Code", group: "big-player", command: "kimi", repository: "MoonshotAI/kimi-code" },
  { id: "mistral-vibe", name: "Mistral Vibe", group: "big-player", command: "vibe", repository: "mistralai/mistral-vibe" },
  { id: "droid", name: "Factory Droid", group: "big-player", command: "droid" },
  { id: "kiro", name: "Kiro CLI", group: "big-player", command: "kiro-cli", repository: "kirodotdev/Kiro" },
  { id: "opencode", name: "OpenCode", group: "independent", command: "opencode", repository: "anomalyco/opencode" },
  { id: "pi", name: "Pi", group: "independent", command: "pi", repository: "earendil-works/pi" },
  { id: "openhands", name: "OpenHands CLI", group: "independent", command: "openhands", repository: "OpenHands/OpenHands-CLI" },
  { id: "cline", name: "Cline CLI", group: "independent", command: "cline", repository: "cline/cline" },
  { id: "open-interpreter", name: "Open Interpreter", group: "independent", command: "interpreter", repository: "openinterpreter/openinterpreter" },
  { id: "goose", name: "Goose", group: "independent", command: "goose", repository: "aaif-goose/goose" },
  { id: "aider", name: "Aider", group: "independent", command: "aider", repository: "Aider-AI/aider" },
  { id: "continue", name: "Continue CLI", group: "independent", command: "cn", repository: "continuedev/continue" },
  { id: "crush", name: "Crush", group: "independent", command: "crush", repository: "charmbracelet/crush" },
  { id: "kilo", name: "Kilo CLI", group: "independent", command: "kilo", repository: "Kilo-Org/kilocode" },
];
