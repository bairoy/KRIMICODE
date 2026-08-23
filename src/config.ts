import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'is required'),
  OPENAI_BASE_URL: z
    .string()
    .min(1, 'is required')
    .refine((v) => URL.canParse(v), 'must be a valid URL'),
  MODEL_NAME: z.string().min(1, 'is required'),
  EXTRA_BODY: z.string().optional(),
});

export interface Config {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly workspaceRoot: string;
  /** Vendor-specific request-body fields. Opaque to the provider. */
  readonly extraBody: Record<string, unknown>;
}

/**
 * Validates the environment and returns config.
 *
 * Never log the returned object wholesale — it carries the API key.
 */
export function loadConfig(): Config {
  // Missing .env is not an error; the vars may come from the shell.
  try {
    process.loadEnvFile('.env');
  } catch {
    // no-op
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report issue paths and messages only. Never echo the values —
    // one of them is the API key.
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${details}`);
  }

  let extraBody: Record<string, unknown> = {};
  if (parsed.data.EXTRA_BODY) {
    let raw: unknown;
    try {
      raw = JSON.parse(parsed.data.EXTRA_BODY);
    } catch {
      throw new Error('Invalid environment:\n  EXTRA_BODY: must be valid JSON');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Invalid environment:\n  EXTRA_BODY: must be a JSON object');
    }
    extraBody = raw as Record<string, unknown>;
  }

  return {
    apiKey: parsed.data.OPENAI_API_KEY,
    baseURL: parsed.data.OPENAI_BASE_URL,
    model: parsed.data.MODEL_NAME,
    workspaceRoot: process.cwd(),
    extraBody,
  };
}
