import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { resolveInWorkspace, WorkspaceError } from '../workspace.js';
import { defineTool } from './define.js';

const InputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'Directory to list, relative to the workspace root. Defaults to ".".',
    ),
  recursive: z
    .boolean()
    .optional()
    .describe('Walk subdirectories too. Defaults to false.'),
});

/**
 * Directories that are never worth listing: huge, generated, or noise. Not a
 * security boundary — the workspace guard handles that. This keeps the output
 * useful and stops a recursive walk from spending its whole budget inside
 * node_modules.
 */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
  '.venv',
  '__pycache__',
]);

/** Hard ceiling so a recursive walk cannot run away on a large tree. */
const MAX_ENTRIES = 1_000;

interface WalkResult {
  readonly entries: string[];
  readonly truncated: boolean;
}

async function walk(
  root: string,
  dir: string,
  recursive: boolean,
): Promise<WalkResult> {
  const entries: string[] = [];
  const queue: string[] = [dir];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    let listing: Dirent[];
    try {
      listing = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable subdirectory; skip rather than abort the walk
    }

    for (const entry of listing) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return { entries, truncated };
      }

      const full = join(current, entry.name);
      const shown = relative(root, full) || entry.name;

      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) {
          entries.push(`${shown}/  (skipped)`);
          continue;
        }
        entries.push(`${shown}/`);
        if (recursive) queue.push(full);
      } else {
        entries.push(shown);
      }
    }
  }

  return { entries, truncated };
}

export const listFilesTool = defineTool({
  name: 'list_files',
  description:
    'List files and directories in the workspace. Directories end with "/". ' +
    'Set recursive to walk subdirectories. Generated directories such as ' +
    'node_modules, .git and dist are skipped. Use this to discover paths ' +
    'before reading files.',
  inputSchema: InputSchema,

  classify(input) {
    const target = input.path ?? '.';
    return {
      operation: 'READ',
      detail: input.recursive === true ? `${target} (recursive)` : target,
    };
  },

  async execute(input, context) {
    const target = input.path ?? '.';

    let absolute: string;
    try {
      absolute = await resolveInWorkspace(context.workspaceRoot, target);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return { success: false, error: err.message, retryable: false };
      }
      throw err;
    }

    const { entries, truncated } = await walk(
      absolute,
      absolute,
      input.recursive === true,
    );

    if (entries.length === 0) {
      return { success: true, content: `${target} is empty.` };
    }

    entries.sort();
    const note = truncated
      ? `\n\n[... stopped at ${MAX_ENTRIES} entries; narrow the path ...]`
      : '';

    return {
      success: true,
      content: `${entries.length} entries in ${target}:\n${entries.join('\n')}${note}`,
    };
  },
});
