/** Additional native configurations, confined to the synthetic scenario home. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export interface NativeContext { root: string; repo: string; endpoint: string; env: NodeJS.ProcessEnv; binary: string; checked(command: string, args: string[]): Promise<string> }
export const ADDITIONAL_CONFORMANCE_DRIVERS = ["continue", "cline", "goose", "openhands", "droid", "mistral-vibe", "crush"] as const;
export async function prepareAdditionalNative(cli: string, c: NativeContext): Promise<void> {
  const json = async (path: string, value: unknown) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
  const directory = join(c.root, cli === "droid" ? ".factory" : "." + cli);
  await mkdir(directory, { recursive: true });
  if (cli === "continue") {
    Object.assign(c.env, { CONTINUE_GLOBAL_DIR: directory, DO_NOT_TRACK: "1" });
    await writeFile(join(directory, "config.yaml"), `name: Verification\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: fixture\n    provider: openai\n    model: gpt-4o\n    apiBase: ${c.endpoint}/v1\n    apiKey: TESTONLY-local-verification\n    roles: [chat]\n`);
  } else if (cli === "cline") {
    c.env.CLINE_DISABLE_CLINE_PASS_NOTICE = "1";
    c.env.CLINE_NO_AUTO_UPDATE = "1";
    c.env.CLINE_DIR = directory;
    c.env.BROWSER = "/usr/bin/true";
    await c.checked(c.binary, ["auth", "openai-compatible", "--apikey", "TESTONLY-local-verification", "--modelid", "fixture", "--baseurl", c.endpoint + "/v1"]);
  } else if (cli === "goose") {
    Object.assign(c.env, { GOOSE_PATH_ROOT: directory, GOOSE_DISABLE_KEYRING: "1", GOOSE_DISABLE_SESSION_NAMING: "true", GOOSE_TELEMETRY_ENABLED: "false", GOOSE_MODE: "auto", OPENAI_API_KEY: "TESTONLY-local-verification", OPENAI_BASE_URL: c.endpoint + "/v1" });
  } else if (cli === "openhands") {
    Object.assign(c.env, { OPENHANDS_PERSISTENCE_DIR: directory, OPENHANDS_CONVERSATIONS_DIR: join(directory, "conversations"), LLM_API_KEY: "TESTONLY-local-verification", LLM_MODEL: "openai/gpt-4o", LLM_BASE_URL: c.endpoint + "/v1", LITELLM_LOCAL_MODEL_COST_MAP: "True", OPENHANDS_SUPPRESS_BANNER: "1", DO_NOT_TRACK: "1" });
  } else if (cli === "droid") {
    Object.assign(c.env, { FACTORY_HOME_OVERRIDE: c.root, FACTORY_DISABLE_KEYRING: "1", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" });
    await json(join(directory, "settings.json"), { cloudSessionSync: false, model: "custom:Verification-0", customModels: [{ model: "fixture", displayName: "Verification", baseUrl: c.endpoint + "/v1", apiKey: "TESTONLY-local-verification", provider: "generic-chat-completion-api", maxOutputTokens: 1024 }] });
  } else if (cli === "mistral-vibe") {
    Object.assign(c.env, { VIBE_HOME: directory, VIBE_VERIFICATION_KEY: "TESTONLY-local-verification" });
    await writeFile(join(directory, "config.toml"), ['active_model = "fixture"', 'enable_telemetry = false', 'enable_update_checks = false', 'enable_auto_update = false', '[[providers]]', 'name = "verification"', `api_base = ${JSON.stringify(c.endpoint + "/v1")}`, 'api_key_env_var = "VIBE_VERIFICATION_KEY"', 'api_style = "openai"', '[[models]]', 'name = "fixture"', 'provider = "verification"', 'alias = "fixture"', 'supports_images = true', '[session_logging]', 'enabled = true', 'generate_titles = false'].join("\n") + "\n");
  } else if (cli === "crush") {
    await json(join(c.repo, "crush.json"), { providers: { verification: { id: "verification", name: "Verification", type: "openai-compat", base_url: c.endpoint + "/v1", api_key: "TESTONLY-local-verification", models: [{ id: "fixture", name: "Fixture", context_window: 32768, default_max_tokens: 1024, can_reason: false, supports_attachments: true, cost_per_1m_in: 0, cost_per_1m_out: 0, cost_per_1m_in_cached: 0, cost_per_1m_out_cached: 0 }] } }, models: { large: { provider: "verification", model: "fixture" }, small: { provider: "verification", model: "fixture" } }, permissions: { allowed_tools: ["view"] }, options: { disable_provider_auto_update: true, disable_default_providers: true, disable_metrics: true } });
  } else throw Error("No additional native configuration: " + cli);
}
export const WRAPPED_CONFORMANCE_DRIVERS = new Set(["continue", "crush"]);
export function additionalNativeArgs(cli: string, c: { root: string; repo: string; mode: "headless" | "interactive"; resume: boolean; prompt: string; session?: string }): string[] {
  const headless = c.mode === "headless";
  if (cli === "continue") return ["--config", join(c.root, ".continue", "config.yaml"), "--allow", "Read", ...(c.resume ? ["--resume"] : []), ...(headless ? ["--print", c.prompt] : [])];
  if (cli === "cline") return ["--provider", "openai-compatible", "--model", "fixture", "--retries", "1", "--timeout", "45", ...(c.resume && c.session ? ["--id", c.session] : []), ...(headless ? ["--json", c.prompt] : ["--tui"])];
  if (cli === "goose") return [headless ? "run" : "session", "--no-profile", "--with-builtin", "developer", "--provider", "openai", "--model", "gpt-4o", "--max-turns", "6", ...(c.resume ? ["--resume"] : []), ...(headless ? ["--output-format", "json", "--text", c.prompt] : [])];
  if (cli === "openhands") return ["--always-approve", "--override-with-envs", "--exit-without-confirmation", ...(c.resume && c.session ? ["--resume", c.session] : []), ...(headless ? ["--headless", "--json", "--task", c.prompt] : [])];
  if (cli === "droid") return ["--disable-builtin-skills", ...(headless ? ["exec", "--model", "custom:Verification-0", "--only-tools", "Read", "--output-format", "stream-json", ...(c.resume && c.session ? ["--session-id", c.session] : []), c.prompt] : [])];
  if (cli === "mistral-vibe") return ["--legacy-harness", "--trust", "--auto-approve", "--enabled-tools", "read_file", ...(c.resume ? ["--continue"] : []), ...(headless ? ["--max-turns", "6", "--output", "json", "--prompt", c.prompt] : [])];
  if (cli === "crush") return ["--data-dir", join(c.repo, ".crush"), ...(headless ? ["run", ...(c.resume ? ["--continue"] : []), c.prompt] : c.resume ? ["--continue"] : [])];
  throw Error("No additional native invocation: " + cli);
}
