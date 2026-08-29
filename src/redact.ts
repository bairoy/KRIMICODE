/**
 * Scrubs secret-shaped text before it reaches model context or logs.
 *
 * CLAUDE.md non-negotiable. Deliberately called from exactly one place —
 * `normalizeToolResult` — so that no tool can forget to apply it.
 */

/**
 * What replaces a secret. Exported because a tool that receives this text back
 * from the model needs to recognise it: the model can only ever have seen the
 * placeholder, never the real value, so matching it against a file is
 * guaranteed to fail.
 */
export const PLACEHOLDER = '[REDACTED]';

/** Exact values known at runtime, e.g. the configured API key. */
const knownSecrets = new Set<string>();

/**
 * Register an exact value to scrub wherever it appears. Short values are
 * ignored: redacting a 4-character string would corrupt ordinary prose.
 */
export function registerSecret(value: string): void {
  if (value.length >= 12) knownSecrets.add(value);
}

const PATTERNS: readonly RegExp[] = [
  // PEM private key blocks, body included.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // Vendor-prefixed API keys (OpenAI, OpenRouter, Anthropic, Stripe, ...).
  /\b(?:sk|pk|rk)-(?:or-|ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens in captured headers.
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/**
 * `KEY=value` / `"key": "value"` assignments where the key name looks
 * secret-bearing. Captures the prefix and quote so only the value is replaced.
 */
const ASSIGNMENT =
  /(\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\b\s*[:=]\s*)(["']?)([^\s"',]{6,})\2/gi;

export function redact(text: string): string {
  let out = text;

  // Exact known values first — these are certain, unlike the heuristics below.
  for (const secret of knownSecrets) {
    out = out.split(secret).join(PLACEHOLDER);
  }

  for (const pattern of PATTERNS) {
    out = out.replace(pattern, PLACEHOLDER);
  }

  out = out.replace(
    ASSIGNMENT,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}${PLACEHOLDER}${quote}`,
  );

  return out;
}
