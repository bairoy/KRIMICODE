/**
 * Command-line options.
 *
 * A separate module from `index.ts` because that one runs `main()` on import,
 * so nothing there can be tested without starting a REPL.
 */

import { parseArgs } from 'node:util';

export interface CliArgs {
  /** Resume the most recent session for this directory. */
  readonly continue: boolean;
  /** Resume one specific session by id. */
  readonly resume: string | undefined;
  /** Print the saved sessions and exit. */
  readonly list: boolean;
  readonly help: boolean;
}

export const USAGE = `krimicode — a terminal coding agent

usage: krimicode [options]

options:
  -c, --continue      resume the most recent session for this directory
  -r, --resume <id>   resume a specific session
      --list          list saved sessions for this directory and exit
  -h, --help          show this message

Configuration comes from the environment (or a .env file in the current
directory): OPENAI_API_KEY, OPENAI_BASE_URL, MODEL_NAME, and optionally
MAX_CONTEXT_TOKENS.
`;

/**
 * Node's own `parseArgs`, so this needs no dependency.
 *
 * `strict: false` on purpose: an unrecognised flag should not stop the agent
 * from starting. The cost of ignoring a typo is smaller than the cost of
 * refusing to run.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: false,
    options: {
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'string', short: 'r' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  return {
    continue: values['continue'] === true,
    // An empty `--resume=` is not a usable id; treat it as absent so the error
    // message is about the missing id rather than about a session named "".
    resume:
      typeof values['resume'] === 'string' && values['resume'] !== ''
        ? values['resume']
        : undefined,
    list: values['list'] === true,
    help: values['help'] === true,
  };
}
