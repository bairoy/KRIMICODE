import { z } from 'zod';
import { runCommand } from '../exec.js';
import { defineTool } from './define.js';

const InputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command, run from the workspace root.'),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .optional()
    .describe('Timeout in milliseconds. Defaults to 30000.'),
});

/**
 * High-confidence destructive patterns. Matching one raises the operation from
 * EXECUTE to DESTRUCTIVE, which the gate refuses to cover with a standing
 * "always" approval (ARCHITECTURE §8).
 *
 * This is a heuristic, not a boundary — a determined command can always dodge
 * it. Its job is to make sure the genuinely dangerous cases are re-confirmed
 * every single time rather than waved through by an earlier approval.
 */
const DESTRUCTIVE: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bgit\s+push\b.*(--force|-f)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bnpm\s+publish\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, // pipe-to-shell
  />\s*\/dev\/(sd|nvme|disk)/,
];

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Run a shell command from the workspace root and return its output. ' +
    'Requires user approval. A non-zero exit code is returned as a normal ' +
    'result, not an error. Long-running commands are killed on timeout.',
  inputSchema: InputSchema,

  classify(input) {
    const destructive = DESTRUCTIVE.some((re) => re.test(input.command));
    return {
      operation: destructive ? 'DESTRUCTIVE' : 'EXECUTE',
      detail: input.command,
    };
  },

  async execute(input, context) {
    const result = await runCommand(input.command, {
      cwd: context.workspaceRoot,
      ...(input.timeout_ms !== undefined
        ? { timeoutMs: input.timeout_ms }
        : {}),
      signal: context.signal,
    });

    const sections: string[] = [];
    if (result.stdout) sections.push(result.stdout);
    if (result.stderr) sections.push(`[stderr]\n${result.stderr}`);
    const body = sections.join('\n') || '(no output)';

    if (result.timedOut) {
      return {
        success: false,
        error: `Timed out and was killed after ${result.durationMs}ms.\n${body}`,
        retryable: false,
      };
    }

    if (!result.success) {
      // An expected operational failure (ARCHITECTURE §5). The model should
      // read the output and decide what to do, not simply run it again.
      return {
        success: false,
        error: `Exited with code ${result.exitCode}.\n${body}`,
        retryable: false,
      };
    }

    return { success: true, content: body };
  },
});
