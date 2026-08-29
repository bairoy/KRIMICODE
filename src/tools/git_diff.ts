import { z } from 'zod';
import { runProgram } from '../exec.js';
import { resolveInWorkspace, WorkspaceError } from '../workspace.js';
import { defineTool } from './define.js';

const InputSchema = z.object({
  staged: z
    .boolean()
    .optional()
    .describe(
      'Show staged changes instead of unstaged ones. Defaults to false.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Limit the diff to this file or directory, relative to the workspace root.',
    ),
});

const NOT_A_REPO = 128;
/** Diffs get large; bound the read before normalize.ts caps it further. */
const MAX_OUTPUT_CHARS = 80_000;

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description:
    'Show a unified diff of changes in the working tree. Use this after ' +
    'edit_file to confirm exactly what changed. Read-only — it never ' +
    'changes git state.',
  inputSchema: InputSchema,

  classify(input) {
    const scope = input.staged === true ? 'staged' : 'unstaged';
    return {
      operation: 'READ',
      detail: `git diff (${scope})${input.path ? ` — ${input.path}` : ''}`,
    };
  },

  async execute(input, context) {
    if (input.path !== undefined) {
      try {
        await resolveInWorkspace(context.workspaceRoot, input.path);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return { success: false, error: err.message, retryable: false };
        }
        throw err;
      }
    }

    const args = ['diff', '--no-color'];
    if (input.staged === true) args.push('--staged');
    // `--` separates revisions from paths, so a filename that looks like a
    // branch name is still read as a path.
    if (input.path !== undefined) args.push('--', input.path);

    const result = await runProgram('git', args, {
      cwd: context.workspaceRoot,
      timeoutMs: 20_000,
      maxOutputChars: MAX_OUTPUT_CHARS,
      signal: context.signal,
    });

    if (result.exitCode === NOT_A_REPO) {
      return {
        success: false,
        error: 'Not a git repository. Run "git init" first.',
        retryable: false,
      };
    }

    if (!result.success) {
      return {
        success: false,
        error: `git diff failed (exit ${result.exitCode}). ${result.stderr.trim()}`,
        retryable: false,
      };
    }

    if (result.stdout.trim() === '') {
      const scope = input.staged === true ? 'staged' : 'unstaged';
      return {
        success: true,
        content: `No ${scope} changes${input.path ? ` in ${input.path}` : ''}.`,
      };
    }

    return { success: true, content: result.stdout };
  },
});
