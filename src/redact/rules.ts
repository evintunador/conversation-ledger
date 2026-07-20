/**
 * Capture-time and scan-time redaction rulesets. See docs/
 * WIP_TECHNICAL_DESIGN.md ("Privacy and integrity") for the layered design:
 * capture-tier rules run unconditionally on every draft and must be
 * near-zero-false-positive (a false positive silently rewrites the record),
 * standard/paranoid tiers are scan-time-only and may be noisier since they
 * just warn a human rather than rewrite anything.
 */

export const RULESET_VERSION = "cledger-rules/1";

export type RuleTier = "capture" | "standard" | "paranoid";

export interface RedactionRule {
  id: string;
  tier: RuleTier;
  description: string;
  pattern: RegExp;
  /**
   * Paranoid-tier only: the pattern matches *candidate* tokens; the scanner
   * applies entropy filtering on top before treating a match as a finding.
   * Not consulted by capture-time redaction (redactText skips these rules).
   */
  entropyGated?: true;
}

const CAPTURE_RULES: RedactionRule[] = [
  {
    id: "github-token",
    tier: "capture",
    description: "GitHub personal access / OAuth / app / refresh token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    id: "github-fine-grained",
    tier: "capture",
    description: "GitHub fine-grained personal access token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  },
  {
    id: "anthropic-api-key",
    tier: "capture",
    description: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: "openai-api-key",
    tier: "capture",
    description: "OpenAI API key",
    pattern: /\bsk-(?!ant-)(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{48})\b/g,
  },
  {
    id: "aws-access-key-id",
    tier: "capture",
    description: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "google-api-key",
    tier: "capture",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "slack-token",
    tier: "capture",
    description: "Slack token",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    id: "stripe-key",
    tier: "capture",
    description: "Stripe live secret/restricted key",
    pattern: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/g,
  },
  {
    id: "gitlab-pat",
    tier: "capture",
    description: "GitLab personal access token",
    pattern: /\bglpat-[0-9a-zA-Z_-]{20,}\b/g,
  },
  {
    id: "npm-token",
    tier: "capture",
    description: "npm access token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "sendgrid-key",
    tier: "capture",
    description: "SendGrid API key",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  {
    id: "private-key-block",
    tier: "capture",
    description: "PEM-style private key block",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "jwt",
    tier: "capture",
    description: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

const STANDARD_RULES: RedactionRule[] = [
  {
    id: "keyword-assignment",
    tier: "standard",
    description: "Keyword-anchored secret assignment (password=, api_key:, ...)",
    pattern:
      /(?:password|passwd|secret|api_key|apikey|access_token|auth_token|credentials?)["']?\s*[:=]\s*["']?[^\s"']{8,}/gi,
  },
  {
    id: "url-credentials",
    tier: "standard",
    description: "Credentials embedded in a URL (scheme://user:pass@host)",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s@]{4,}@/gi,
  },
  {
    id: "bearer-token",
    tier: "standard",
    description: "Bearer token in an Authorization-style header value",
    pattern: /\bbearer\s+[A-Za-z0-9_\-.=]{20,}/gi,
  },
];

const PARANOID_RULES: RedactionRule[] = [
  {
    id: "high-entropy",
    tier: "paranoid",
    description: "High-entropy token candidate; entropy filtering applied by the scanner",
    pattern: /\b[A-Za-z0-9+/_=-]{24,}\b/g,
    entropyGated: true,
  },
];

export const RULES: readonly RedactionRule[] = [
  ...CAPTURE_RULES,
  ...STANDARD_RULES,
  ...PARANOID_RULES,
];

/** "capture" -> capture only; "standard" -> capture+standard; "paranoid" -> all. */
export function rulesForTier(tier: RuleTier): RedactionRule[] {
  if (tier === "capture") return [...CAPTURE_RULES];
  if (tier === "standard") return [...CAPTURE_RULES, ...STANDARD_RULES];
  return [...RULES];
}

/** Shannon entropy in bits per character, for paranoid-tier scan filtering. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
