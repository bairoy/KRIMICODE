import { redact } from './redact.js';
import type { ToolResult } from './types.js';

/**
 * Output cap. Chosen so a single runaway tool result cannot dominate the
 * context window. Head and tail are both kept: the head carries the shape of
 * the output, the tail usually carries the error or the conclusion.
 */
const MAX_CHARS = 30_000;
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 10_000;

export function capOutput(text: string): string {
  if (text.length <= MAX_CHARS) return text;

  const elided = text.length - HEAD_CHARS - TAIL_CHARS;
  return (
    text.slice(0, HEAD_CHARS) +
    `\n\n[... ${elided} characters elided ...]\n\n` +
    text.slice(text.length - TAIL_CHARS)
  );
}

/**
 * The single boundary every tool result crosses before it reaches model
 * context (ARCHITECTURE §4: normalize -> output limiting -> context update).
 *
 * Redaction runs before capping, so a secret straddling the cut point cannot
 * survive as a half-string.
 */
export function normalizeToolResult(result: ToolResult): ToolResult {
  return result.success
    ? { success: true, content: capOutput(redact(result.content)) }
    : {
        success: false,
        error: capOutput(redact(result.error)),
        retryable: result.retryable,
      };
}
