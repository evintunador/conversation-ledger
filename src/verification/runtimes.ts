/** Explicit, isolated public-package provisioning; never part of capture hooks. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment, runProcess } from "./process.js";

export const PINNED_NPM_RUNTIMES = [
  { cli: "continue", package: "@continuedev/cli", version: "1.5.47", binary: "cn" },
  { cli: "kilo", package: "@kilocode/cli", version: "7.8.1", binary: "kilo" },
  { cli: "cline", package: "cline", version: "3.0.65", binary: "cline" },
  { cli: "claude-code", package: "@anthropic-ai/claude-code", version: "2.1.284", binary: "claude" },
  { cli: "codex", package: "@openai/codex", version: "0.159.0", binary: "codex" },
  { cli: "gemini-cli", package: "@google/gemini-cli", version: "0.61.0", binary: "gemini" },
  { cli: "qwen-code", package: "@qwen-code/qwen-code", version: "0.24.6", binary: "qwen" },
  { cli: "opencode", package: "opencode-ai", version: "1.18.33", binary: "opencode" },
  { cli: "pi", package: "@earendil-works/pi-coding-agent", version: "0.87.1", binary: "pi" },
  { cli: "copilot", package: "@github/copilot", version: "1.0.89", binary: "copilot" },
  { cli: "kimi", package: "@moonshot-ai/kimi-code", version: "2.1.1", binary: "kimi" },
] as const;

export function runtimeBinary(directory: string, cli: string, binary: string): string {
  return join(resolve(directory), cli, "node_modules", ".bin", binary);
}

export async function provisionRuntimes(directory: string, selected?: string[], versions: Record<string, string> = {}) {
  const requested = selected ?? PINNED_NPM_RUNTIMES.map(r => r.cli);
  const unknown = requested.filter(id => !PINNED_NPM_RUNTIMES.some(r => r.cli === id));
  if (unknown.length) throw new Error(`No npm runtime recipe for: ${unknown.join(", ")}`);
  const root = resolve(directory);
  const home = join(root, "installer-home");
  await mkdir(home, { recursive: true });
  const env = isolatedEnvironment(home, process.env.PATH ?? "/usr/bin:/bin");
  // Ignore the user's npm configuration and credentials; use public packages.
  env.NPM_CONFIG_USERCONFIG = join(home, ".npmrc");
  env.NPM_CONFIG_GLOBALCONFIG = join(home, "global.npmrc");
  await writeFile(env.NPM_CONFIG_USERCONFIG, "registry=https://registry.npmjs.org/\n");
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "");
  const results = [];
  for (const recipe of PINNED_NPM_RUNTIMES.filter(r => requested.includes(r.cli))) {
    const prefix = join(root, recipe.cli);
    await mkdir(prefix, { recursive: true });
    const version = versions[recipe.cli] ?? recipe.version;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error(`Invalid exact version for ${recipe.cli}`);
    process.stderr.write(`Provisioning isolated ${recipe.cli} ${version}\n`);
    const result = await runProcess("npm", ["install", "--prefix", prefix, "--save-exact", "--no-audit", "--no-fund", `${recipe.package}@${version}`],
      { cwd: home, env, timeoutMs: 300_000 });
    if (result.code !== 0 || result.timedOut) throw new Error(`Provisioning ${recipe.cli} failed: ${result.timedOut ? "deadline" : result.stderr.slice(-2000)}`);
    results.push({ ...recipe, version, path: runtimeBinary(root, recipe.cli, recipe.binary) });
  }
  await writeFile(join(root, "runtimes.json"), JSON.stringify({ schema: "cledger-runtimes/1", installedAt: new Date().toISOString(), runtimes: results }, null, 2) + "\n");
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...selected] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: runtimes.js DIRECTORY [CLI_ID ...]");
  process.stdout.write(JSON.stringify(await provisionRuntimes(directory, selected.length ? selected : undefined), null, 2) + "\n");
}
