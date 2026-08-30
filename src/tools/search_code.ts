import { z } from 'zod';
import { runProgram } from '../exec/exec.js';
import { isWindows } from '../exec/platform.js';
import { resolveInWorkspace, WorkspaceError } from '../exec/workspace.js';
import { defineTool } from './define.js';
import { counted } from '../plural.js';

const InputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Text to find. A regular expression unless literal is true.'),
  path: z
    .string()
    .optional()
    .describe(
      'Directory or file to search, relative to the workspace root. Defaults to ".".',
    ),
  literal: z
    .boolean()
    .optional()
    .describe('Treat pattern as plain text rather than a regular expression.'),
  case_insensitive: z
    .boolean()
    .optional()
    .describe('Ignore case. Defaults to false.'),
  glob: z
    .string()
    .optional()
    .describe('Only search files matching this glob, e.g. "*.ts".'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum matching lines to return. Defaults to 100.'),
});

const SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
];

const SEARCH_TIMEOUT_MS = 20_000;

/**
 * Whether ripgrep is on PATH. Probed once per process: ripgrep is much faster
 * and respects .gitignore, but it is not installed everywhere, so grep is the
 * fallback rather than a hard requirement.
 */
let ripgrepAvailable: boolean | null = null;

async function hasRipgrep(cwd: string, signal?: AbortSignal): Promise<boolean> {
  if (ripgrepAvailable === null) {
    const probe = await runProgram('rg', ['--version'], {
      cwd,
      timeoutMs: 5_000,
      signal,
    });
    // A cancelled probe says nothing about whether ripgrep is installed.
    // Caching it would let a single Ctrl-C downgrade the session to grep for
    // good, with no way to recover short of a restart.
    if (probe.cancelled) return false;
    ripgrepAvailable = probe.success;
  }
  return ripgrepAvailable;
}

function ripgrepArgs(
  input: z.infer<typeof InputSchema>,
  target: string,
): string[] {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--text'];
  if (input.literal === true) args.push('--fixed-strings');
  if (input.case_insensitive === true) args.push('--ignore-case');
  if (input.glob !== undefined) args.push('--glob', input.glob);
  for (const dir of SKIP_DIRS) args.push('--glob', `!${dir}/`);
  // `--` stops flag parsing, so a pattern beginning with "-" is a pattern.
  args.push('--', input.pattern, target);
  return args;
}

function grepArgs(
  input: z.infer<typeof InputSchema>,
  target: string,
): string[] {
  const args = ['-r', '-n', '-I'];
  args.push(input.literal === true ? '-F' : '-E');
  if (input.case_insensitive === true) args.push('-i');
  if (input.glob !== undefined) args.push(`--include=${input.glob}`);
  for (const dir of SKIP_DIRS) args.push(`--exclude-dir=${dir}`);
  args.push('--', input.pattern, target);
  return args;
}

export const searchCodeTool = defineTool({
  name: 'search_code',
  description:
    'Search file contents across the workspace and return matching lines as ' +
    '"path:line:text". Uses a regular expression unless literal is true. ' +
    'Generated directories are skipped. Use this to find where something is ' +
    'defined or used before reading whole files.',
  inputSchema: InputSchema,

  classify(input) {
    // READ, not EXECUTE: the program is fixed and every argument is passed
    // through execve as data, never interpreted by a shell.
    const where = input.path ?? '.';
    return { operation: 'READ', detail: `"${input.pattern}" in ${where}` };
  },

  async execute(input, context) {
    const target = input.path ?? '.';

    try {
      await resolveInWorkspace(context.workspaceRoot, target);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return { success: false, error: err.message, retryable: false };
      }
      throw err;
    }

    const useRipgrep = await hasRipgrep(context.workspaceRoot, context.signal);

    // Windows has no grep, so the fallback does not exist there. Say so
    // plainly — otherwise this surfaces as a bare ENOENT that reads like the
    // tool is broken rather than like a missing dependency.
    if (!useRipgrep && isWindows(process.platform)) {
      return {
        success: false,
        error:
          'search_code needs ripgrep on Windows, and "rg" is not on PATH. ' +
          'Install it with "winget install BurntSushi.ripgrep.MSVC" and try ' +
          'again, or use list_files and read_file instead.',
        retryable: false,
      };
    }

    const [program, args] = useRipgrep
      ? (['rg', ripgrepArgs(input, target)] as const)
      : (['grep', grepArgs(input, target)] as const);

    const result = await runProgram(program, args, {
      cwd: context.workspaceRoot,
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: context.signal,
    });

    if (result.timedOut) {
      return {
        success: false,
        error: `Search timed out after ${SEARCH_TIMEOUT_MS}ms. Narrow the path or the pattern.`,
        retryable: true,
      };
    }

    // Both tools exit 1 for "no matches", which is an answer, not a failure.
    if (result.exitCode === 1 && result.stdout === '') {
      return {
        success: true,
        content: `No matches for "${input.pattern}" in ${target}.`,
      };
    }

    if (!result.success) {
      return {
        success: false,
        error:
          `Search failed (exit ${result.exitCode}). ` +
          `${result.stderr.trim() || 'no error output'}`,
        retryable: true,
      };
    }

    const limit = input.max_results ?? 100;
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    const shown = lines.slice(0, limit);
    const note =
      lines.length > limit
        ? `\n\n[... ${lines.length - limit} more matches; raise max_results or narrow the search ...]`
        : '';

    return {
      success: true,
      content: `${counted(shown.length, 'match', 'matches')} (${program}):\n${shown.join('\n')}${note}`,
    };
  },
});
