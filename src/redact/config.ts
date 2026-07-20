import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { rulesForTier, type RedactionRule } from "./rules.js";

export interface CledgerConfig {
  redact?: {
    capture?: boolean;
    env?: boolean;
    patterns?: { id?: string; pattern: string }[];
  };
  scan?: {
    tier?: "standard" | "paranoid" | "off";
  };
}

/** Names that routinely hold long non-secret values; excluded from env scrubbing. */
const NON_SECRET_ENV_NAME = /^(?:PATH|HOME|PWD|OLDPWD|SHELL|TERM.*|USER|LOGNAME|LANG|LC_.*|EDITOR|VISUAL|PAGER|TMPDIR|DISPLAY|SSH_AUTH_SOCK|XDG_.*)$/;

async function readJsonConfig(path: string): Promise<CledgerConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CledgerConfig;
    }
    return null;
  } catch {
    // Missing or malformed config: capture hooks must never fail a session.
    return null;
  }
}

/**
 * Merges ~/.config/cledger/config.json then <repoRoot>/.cledger.json.
 * Repo wins, shallow per-section: whichever config defines a given
 * top-level section ("redact", "scan") supplies that whole section — the
 * two are never merged key-by-key within a section.
 */
export async function loadConfig(repoRoot: string): Promise<CledgerConfig> {
  const userPath = join(homedir(), ".config", "cledger", "config.json");
  const repoPath = join(repoRoot, ".cledger.json");
  const [userConfig, repoConfig] = await Promise.all([
    readJsonConfig(userPath),
    readJsonConfig(repoPath),
  ]);
  const base = userConfig ?? {};
  const override = repoConfig ?? {};
  const redact = override.redact ?? base.redact;
  const scan = override.scan ?? base.scan;
  return {
    ...(redact !== undefined ? { redact } : {}),
    ...(scan !== undefined ? { scan } : {}),
  };
}

/**
 * Capture-tier rules plus compiled user patterns from config. Invalid user
 * regexes are skipped silently (never throw — capture must never fail a
 * session). Returns [] when redact.capture is explicitly false.
 */
export function captureRules(config: CledgerConfig): RedactionRule[] {
  if (config.redact?.capture === false) return [];
  const rules = rulesForTier("capture");
  const userPatterns = config.redact?.patterns ?? [];
  userPatterns.forEach((p, i) => {
    if (!p || !p.pattern) return;
    try {
      const pattern = new RegExp(p.pattern, "g");
      rules.push({
        id: p.id ?? `user-pattern-${i}`,
        tier: "capture",
        description: "User-configured capture pattern",
        pattern,
      });
    } catch {
      // Invalid regex: skip silently.
    }
  });
  return rules;
}

async function parseDotEnv(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value) values.push(value);
  }
  return values;
}

/**
 * Exact values to scrub for opt-in env masking (layer C): process.env
 * values that look secret-shaped, plus values parsed from <repoRoot>/.env.
 * Only call this when config.redact?.env === true.
 */
export async function collectEnvValues(repoRoot: string): Promise<string[]> {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (NON_SECRET_ENV_NAME.test(name)) continue;
    if (value.startsWith("/")) continue;
    values.add(value);
  }
  const dotEnvValues = await parseDotEnv(join(repoRoot, ".env"));
  for (const value of dotEnvValues) {
    if (value.length >= 8 && !value.startsWith("/")) values.add(value);
  }
  return [...values];
}
