import { z } from 'zod';
import { runProgram } from '../exec.js';
import { defineTool } from './define.js';

const InputSchema = z.object({});

/** git exits 128 when the directory is not a repository. */
const NOT_A_REPO = 128;

const LEGEND =
  'Codes are "XY path": X = staged, Y = unstaged. ' +
  'M modified, A added, D deleted, R renamed, ?? untracked.';

export const gitStatusTool = defineTool({
  name: 'git_status',
  description:
    'Show the git working tree status: current branch, staged and unstaged ' +
    'changes, and untracked files. Read-only — it never changes git state.',
  inputSchema: InputSchema,

  // Read-only: it reports git state without altering it, so it runs without
  // prompting. A tool that mutated git state would be GIT_STATE_CHANGE.
  classify: () => ({ operation: 'READ', detail: 'git status' }),

  async execute(_input, context) {
    const result = await runProgram(
      'git',
      ['status', '--porcelain=v1', '--branch'],
      { cwd: context.workspaceRoot, timeoutMs: 15_000 },
    );

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
        error: `git status failed (exit ${result.exitCode}). ${result.stderr.trim()}`,
        retryable: false,
      };
    }

    const lines = result.stdout.split('\n').filter((line) => line !== '');
    // With --branch there is always a leading "## branch" line, so one line
    // alone means a clean tree.
    if (lines.length <= 1) {
      return {
        success: true,
        content: `${lines[0] ?? ''}\nWorking tree clean.`.trim(),
      };
    }

    return { success: true, content: `${lines.join('\n')}\n\n${LEGEND}` };
  },
});
