import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runShim } from '../exec/exec.js';
import { defineTool } from './define.js';

const InputSchema = z.object({
  timeout_ms: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .optional()
    .describe('How long to allow the suite to run. Defaults to 120000.'),
});

const DEFAULT_TIMEOUT_MS = 120_000;
/** Test output is verbose; keep the failure summary rather than the noise. */
const MAX_OUTPUT_CHARS = 80_000;

/** The project's own test script, or null if it has none. */
async function testScript(root: string): Promise<string | null> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) return null;
    const test = (scripts as { test?: unknown }).test;
    return typeof test === 'string' && test.trim() !== '' ? test : null;
  } catch {
    return null;
  }
}

export const runTestsTool = defineTool({
  name: 'run_tests',
  description:
    "Run the project's test suite via its package.json test script. " +
    'Returns the output and whether it passed. A failing suite is reported ' +
    'as a normal result, not an error.',
  inputSchema: InputSchema,

  // EXECUTE, not READ: the test script runs arbitrary project code, so it goes
  // through the gate exactly like run_command.
  classify: () => ({ operation: 'EXECUTE', detail: 'npm test' }),

  async execute(input, context) {
    const script = await testScript(context.workspaceRoot);
    if (script === null) {
      return {
        success: false,
        error:
          'No "test" script in package.json, so there is no suite to run. ' +
          'Use run_command if you know the right command.',
        retryable: false,
      };
    }

    // `npm test` rather than the raw script: npm puts node_modules/.bin on
    // PATH, which the script almost certainly depends on.
    //
    // runShim, not runProgram: on Windows `npm` is `npm.cmd`, a batch file that
    // Node refuses to spawn without a shell. The argv here is fixed and no
    // model input reaches it, which is the condition runShim enforces.
    const result = await runShim('npm', ['test'], {
      cwd: context.workspaceRoot,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: MAX_OUTPUT_CHARS,
      signal: context.signal,
    });

    const sections: string[] = [];
    if (result.stdout.trim()) sections.push(result.stdout);
    if (result.stderr.trim()) sections.push(`[stderr]\n${result.stderr}`);
    const body = sections.join('\n') || '(no output)';

    if (result.timedOut) {
      return {
        success: false,
        error: `Tests timed out after ${result.durationMs}ms and were killed.\n${body}`,
        retryable: false,
      };
    }

    if (!result.success) {
      // A failing suite is information, not a malfunction — the model should
      // read the output and fix the code, not re-run the same tests.
      return {
        success: false,
        error: `Tests failed (exit ${result.exitCode}).\n${body}`,
        retryable: false,
      };
    }

    return { success: true, content: `Tests passed.\n${body}` };
  },
});
