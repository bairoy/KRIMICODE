import { readFile } from 'node:fs/promises';
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
    .describe('File path, relative to the workspace root.'),
});

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Paths are relative to the ' +
    'workspace root. Reading outside the workspace is refused.',
  inputSchema: InputSchema,

  classify(input) {
    // A credential-shaped filename turns an ordinary read into one that needs
    // a human. Checked on the raw input, since the gate runs before the tool
    // resolves the path.
    return isSensitivePath(input.path)
      ? {
          operation: 'READ_SENSITIVE',
          detail: `Read "${input.path}" — this looks like a credential file.`,
        }
      : { operation: 'READ', detail: `Read "${input.path}"` };
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

    // A sensitive path is no longer refused outright — `classify` routed it
    // through the gate, so reaching here means the user approved it. Redaction
    // in normalize.ts still scrubs the contents on the way to the model.
    try {
      return { success: true, content: await readFile(absolute, 'utf8') };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${input.path}`,
          retryable: false,
        };
      }
      if (code === 'EISDIR') {
        return {
          success: false,
          error: `"${input.path}" is a directory, not a file.`,
          retryable: false,
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }
  },
});
