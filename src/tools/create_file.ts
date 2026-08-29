import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  isSensitivePath,
  resolveInWorkspace,
  WorkspaceError,
} from '../workspace.js';
import { defineTool } from './define.js';

const InputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Path for the new file, relative to the workspace root. Must not exist ' +
        'yet, and its parent directory must already exist.',
    ),
  content: z
    .string()
    .describe(
      'Full contents of the new file. Use an empty string for a blank file.',
    ),
});

export const createFileTool = defineTool({
  name: 'create_file',
  description:
    'Create a new file with the given contents. Fails if the file already ' +
    'exists — use edit_file to change an existing one. The parent directory ' +
    'must already exist; create it with run_command if it does not.',
  inputSchema: InputSchema,

  classify(input) {
    // Same rule as edit_file: writing a credential file can never be covered
    // by a standing "always" approval.
    return isSensitivePath(input.path)
      ? {
          operation: 'DESTRUCTIVE',
          detail: `${input.path}  — credential file (new)`,
          diff: { before: '', after: input.content },
        }
      : {
          operation: 'WRITE',
          detail: `${input.path}  (new file)`,
          diff: { before: '', after: input.content },
        };
  },

  /**
   * Refuse before asking, so the user is never prompted to approve a creation
   * that cannot happen.
   *
   * This is a convenience, not the safety mechanism: the file could appear
   * between here and `execute`. The real guarantee is the `wx` flag below,
   * which fails atomically if the path already exists.
   */
  async precheck(input, context) {
    // A credential file is never inspected before approval — the human decides
    // first. execute() still refuses to overwrite one.
    if (isSensitivePath(input.path)) return null;

    let absolute: string;
    try {
      absolute = await resolveInWorkspace(context.workspaceRoot, input.path);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return { success: false, error: err.message, retryable: false };
      }
      throw err;
    }

    try {
      await stat(absolute);
      return {
        success: false,
        error:
          `${input.path} already exists. create_file never overwrites. To ` +
          'change it: read_file it first, then edit_file using its exact ' +
          'current text as old_str. Or choose a different path.',
        retryable: false,
      };
    } catch {
      // Missing, which is what we want.
    }

    // §6.1's reasoning applied to directories: silently building a tree from a
    // mistyped path is exactly the kind of surprise edit_file refuses to
    // create files to avoid. Fail loudly and let the directory be made
    // deliberately, through the gate, by run_command.
    try {
      await stat(dirname(absolute));
    } catch {
      return {
        success: false,
        error:
          `The directory for ${input.path} does not exist. create_file does ` +
          'not create directories — make it first with run_command, then ' +
          'create the file.',
        retryable: false,
      };
    }

    return null;
  },

  async execute(input, context) {
    let absolute: string;
    try {
      absolute = await resolveInWorkspace(context.workspaceRoot, input.path);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return { success: false, error: err.message, retryable: false };
      }
      throw err;
    }

    try {
      // 'wx' fails if the path exists. This, not the precheck, is what makes
      // "never overwrites" true: it is a single atomic operation, so a file
      // appearing in the gap between the check and the write cannot be
      // clobbered.
      await writeFile(absolute, input.content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return {
          success: false,
          error:
            `${input.path} already exists. create_file never overwrites. To ` +
            'change it: read_file it first, then edit_file using its exact ' +
            'current text as old_str.',
          retryable: false,
        };
      }
      if (code === 'ENOENT') {
        return {
          success: false,
          error: `The directory for ${input.path} does not exist.`,
          retryable: false,
        };
      }
      return {
        success: false,
        error: `Failed to create ${input.path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        retryable: false,
      };
    }

    const lines = input.content === '' ? 0 : input.content.split('\n').length;
    return {
      success: true,
      content: `Created ${input.path} — ${input.content.length} characters, ${lines} lines.`,
    };
  },
});
