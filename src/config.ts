import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'is required'),
  OPENAI_BASE_URL: z
    .string()
    .min(1, 'is required')
    .refine((v) => URL.canParse(v), 'must be a valid URL'),
  MODEL_NAME: z.string().min(1, 'is required'),
  EXTRA_BODY: z.string().optional(),
  // The model's context window. There is no portable way to ask an
  // OpenAI-compatible endpoint how large its window is, so it is configuration
  // rather than a guess. Set it below the real limit if unsure: compacting
  // early costs a summarization call, whereas guessing high costs the session.
  MAX_CONTEXT_TOKENS: z.coerce
    .number()
    .int('must be a whole number')
    .min(4_000, 'must be at least 4000')
    .optional(),
});

/** Windows smaller than this are rare, and the cost of guessing high is a dead session. */
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

export interface Config {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly workspaceRoot: string;
  /** Vendor-specific request-body fields. Opaque to the provider. */
  readonly extraBody: Record<string, unknown>;
  /** Context window the compaction policy is built from. */
  readonly maxContextTokens: number;
}

/**
 * Loads `.env` into `process.env`. Call once, at startup.
 *
 * Kept separate from `loadConfig` so that validation stays a pure function of
 * whatever environment it is handed. Reading a file and mutating a global
 * inside the validator would make it depend on the working directory.
 */
export function loadEnvFile(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // A missing .env is normal — in production the variables come from the
    // shell instead.
  }
}

/**
 * Validates the environment and returns config.
 *
 * Never log the returned object wholesale — it carries the API key.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
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
      throw new Error(
        'Invalid environment:\n  EXTRA_BODY: must be a JSON object',
      );
    }
    extraBody = raw as Record<string, unknown>;
  }

  return {
    apiKey: parsed.data.OPENAI_API_KEY,
    baseURL: parsed.data.OPENAI_BASE_URL,
    model: parsed.data.MODEL_NAME,
    workspaceRoot: process.cwd(),
    extraBody,
    maxContextTokens:
      parsed.data.MAX_CONTEXT_TOKENS ?? DEFAULT_MAX_CONTEXT_TOKENS,
  };
}
