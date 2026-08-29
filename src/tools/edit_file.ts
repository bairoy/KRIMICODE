import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { PLACEHOLDER } from '../redact.js';
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
    .describe('File path, relative to the workspace root. Must already exist.'),
  old_str: z
    .string()
    .min(1)
    .describe(
      'Exact text to replace, including whitespace and indentation. Must ' +
        'appear exactly once in the file unless replace_all is true.',
    ),
  new_str: z
    .string()
    .describe('Replacement text. Use an empty string to delete old_str.'),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      'Replace every occurrence. Without this, more than one match is an error.',
    ),
});

/** Non-overlapping literal occurrences. No regex — old_str is never a pattern. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. old_str must match the file ' +
    'byte for byte, including indentation, and must be unique unless ' +
    'replace_all is set. Never rewrites the whole file. Read the file first ' +
    'so old_str is exact.',
  inputSchema: InputSchema,

  classify(input) {
    const scope = input.replace_all === true ? ' (all occurrences)' : '';
    const diff = { before: input.old_str, after: input.new_str };

    // Writing to a credential file is treated as destructive, so a standing
    // "always" approval for edit_file can never cover it.
    return isSensitivePath(input.path)
      ? {
          operation: 'DESTRUCTIVE',
          detail: `${input.path}${scope}  — credential file`,
          diff,
        }
      : { operation: 'WRITE', detail: `${input.path}${scope}`, diff };
  },

  /**
   * Everything that makes this call impossible, checked before the user is
   * asked. All of it was previously discovered inside `execute`, i.e. after
   * approval — so a request to edit a file that does not exist still cost a
   * prompt, and the diff on screen described a change that could not happen.
   *
   * Read-only by contract: it opens the file and counts, nothing more.
   */
  async precheck(input, context) {
    if (input.old_str === input.new_str) {
      return {
        success: false,
        error: 'old_str and new_str are identical; nothing would change.',
        retryable: true,
      };
    }

    // A credential file is never read before approval — the whole point of
    // classifying it DESTRUCTIVE is that the human decides first. Let it fall
    // through to the gate and be checked in execute() as before.
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

    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          success: false,
          error:
            `File not found: ${input.path}. edit_file cannot create files — ` +
            'use create_file for a new one.',
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
      // Anything else — a permissions problem, say — is a real failure that
      // execute() would hit too. Report it rather than prompting first.
      throw err;
    }

    const occurrences = countOccurrences(content, input.old_str);

    if (occurrences === 0) {
      if (input.old_str.includes(PLACEHOLDER)) {
        return {
          success: false,
          error:
            `old_str contains ${PLACEHOLDER}, which is a placeholder put there ` +
            'to keep a secret out of this conversation — it is not the real ' +
            `text of ${input.path}, so no edit can match it. The value was ` +
            'withheld deliberately and cannot be retrieved. Either edit a part ' +
            'of the file that does not contain a secret, or tell the user to ' +
            'make this change themselves.',
          retryable: false,
        };
      }
      return {
        success: false,
        error:
          `old_str was not found in ${input.path}. It must match exactly, ` +
          'including whitespace and indentation. Read the file and copy the ' +
          'text verbatim.',
        retryable: true,
      };
    }

    if (occurrences > 1 && input.replace_all !== true) {
      return {
        success: false,
        error:
          `old_str appears ${occurrences} times in ${input.path}. Include ` +
          'more surrounding context to make it unique, or pass ' +
          'replace_all: true to change every occurrence.',
        retryable: true,
      };
    }

    return null; // the edit can actually happen — go and ask the user
  },

  async execute(input, context) {
    if (input.old_str === input.new_str) {
      return {
        success: false,
        error: 'old_str and new_str are identical; nothing would change.',
        retryable: true,
      };
    }

    let absolute: string;
    try {
      absolute = await resolveInWorkspace(context.workspaceRoot, input.path);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return { success: false, error: err.message, retryable: false };
      }
      throw err;
    }

    // §6.1: the file must already exist. edit_file never creates one — that
    // would let a typo in `path` silently produce a new file instead of
    // failing loudly.
    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${input.path}. edit_file cannot create files.`,
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
      throw err;
    }

    const occurrences = countOccurrences(content, input.old_str);

    if (occurrences === 0) {
      // A redaction placeholder in old_str is a dead end, not a near miss.
      // read_file scrubs secrets on the way out, so the model has only ever
      // seen the placeholder and will copy it back here in good faith. No
      // retry can succeed, and the generic "copy the text verbatim" advice
      // below is exactly what it already did — so say what is really wrong and
      // mark it unretryable, or the model loops until it runs out of turns.
      if (input.old_str.includes(PLACEHOLDER)) {
        return {
          success: false,
          error:
            `old_str contains ${PLACEHOLDER}, which is a placeholder put there ` +
            'to keep a secret out of this conversation — it is not the real ' +
            `text of ${input.path}, so no edit can match it. The value was ` +
            'withheld deliberately and cannot be retrieved. Either edit a part ' +
            'of the file that does not contain a secret, or tell the user to ' +
            'make this change themselves.',
          retryable: false,
        };
      }

      return {
        success: false,
        error:
          `old_str was not found in ${input.path}. It must match exactly, ` +
          'including whitespace and indentation. Read the file and copy the ' +
          'text verbatim.',
        retryable: true,
      };
    }

    // §6.2: never silently pick the first match.
    if (occurrences > 1 && input.replace_all !== true) {
      return {
        success: false,
        error:
          `old_str appears ${occurrences} times in ${input.path}. Include ` +
          'more surrounding context to make it unique, or pass ' +
          'replace_all: true to change every occurrence.',
        retryable: true,
      };
    }

    // §6.3: splice around the match so every other byte is preserved. The
    // whole file is never regenerated.
    let updated: string;
    let changedAt: number;
    if (input.replace_all === true) {
      changedAt = content.indexOf(input.old_str);
      updated = content.split(input.old_str).join(input.new_str);
    } else {
      changedAt = content.indexOf(input.old_str);
      updated =
        content.slice(0, changedAt) +
        input.new_str +
        content.slice(changedAt + input.old_str.length);
    }

    try {
      await writeFile(absolute, updated, 'utf8');
    } catch (err) {
      return {
        success: false,
        error: `Failed to write ${input.path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        retryable: false,
      };
    }

    // §6.5: enough detail for the model to know the edit landed.
    const line = content.slice(0, changedAt).split('\n').length;
    return {
      success: true,
      content:
        `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ` +
        `${input.path}, first at line ${line}. ` +
        `File went from ${content.length} to ${updated.length} characters.`,
    };
  },
});
