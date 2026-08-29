/**
 * Slash commands.
 *
 * Kept out of `index.ts` so the dispatcher can be tested without a terminal.
 * Everything it needs arrives as plain callbacks rather than as the Agent
 * itself, which keeps the surface these commands can touch small and explicit.
 */

export type CommandOutcome =
  /** Recognised and dealt with. Nothing goes to the model. */
  | 'handled'
  /** Recognised, and the session should end. */
  | 'exit'
  /** Not a command at all — send it to the model as an ordinary prompt. */
  | 'not-a-command';

export interface CommandContext {
  readonly write: (text: string) => void;
  readonly getModel: () => string;
  readonly setModel: (name: string) => void;
  /** Forget the conversation and start a new one. */
  readonly clear: () => void;
  readonly listTools: () => readonly { name: string; description: string }[];
  /** One line per saved session, newest first. */
  readonly listSessions: () => Promise<readonly string[]>;
}

interface CommandSpec {
  readonly usage: string;
  readonly summary: string;
  readonly run: (
    argument: string,
    context: CommandContext,
  ) => CommandOutcome | Promise<CommandOutcome>;
}

const COMMANDS = new Map<string, CommandSpec>([
  [
    '/help',
    {
      usage: '/help',
      summary: 'show this list',
      run: (_argument, context) => {
        context.write('\ncommands:\n');
        for (const spec of COMMANDS.values()) {
          // Pad to the longest usage string so the summaries line up.
          context.write(`  ${spec.usage.padEnd(16)}${spec.summary}\n`);
        }
        context.write(
          '\nCtrl-C stops the current turn; press it again when idle to quit.\n\n',
        );
        return 'handled';
      },
    },
  ],
  ['/exit', { usage: '/exit', summary: 'quit', run: () => 'exit' }],
  [
    '/clear',
    {
      usage: '/clear',
      summary: 'forget the conversation and start fresh',
      run: (_argument, context) => {
        context.clear();
        context.write('\nconversation cleared.\n\n');
        return 'handled';
      },
    },
  ],
  [
    '/model',
    {
      usage: '/model [name]',
      summary: 'show the current model, or switch to another',
      run: (argument, context) => {
        if (argument === '') {
          context.write(`\n${context.getModel()}\n\n`);
          return 'handled';
        }
        const previous = context.getModel();
        context.setModel(argument);
        context.write(`\nmodel: ${previous} → ${argument}\n\n`);
        return 'handled';
      },
    },
  ],
  [
    '/tools',
    {
      usage: '/tools',
      summary: 'list the tools the model can call',
      run: (_argument, context) => {
        context.write('\n');
        for (const tool of context.listTools()) {
          // First sentence only: the full descriptions are written for the
          // model and are far too long to read as a list.
          const short = tool.description.split('. ')[0] ?? '';
          context.write(`  ${tool.name.padEnd(14)}${short}\n`);
        }
        context.write('\n');
        return 'handled';
      },
    },
  ],
  [
    '/sessions',
    {
      usage: '/sessions',
      summary: 'list saved conversations for this directory',
      run: async (_argument, context): Promise<CommandOutcome> => {
        const sessions = await context.listSessions();
        if (sessions.length === 0) {
          context.write('\nno saved sessions for this directory.\n\n');
          return 'handled';
        }
        context.write('\n');
        for (const line of sessions) context.write(`  ${line}\n`);
        context.write('\nresume one with: krimicode --resume <id>\n\n');
        return 'handled';
      },
    },
  ],
]);

/**
 * Interpret one line of input.
 *
 * A line that merely starts with `/` is not automatically a command — `/usr`
 * or a path is ordinary text — but an unrecognised single word beginning with
 * `/` almost certainly is a typo, and answering it locally is more useful than
 * letting the model try to guess what was meant.
 */
export async function handleCommand(
  line: string,
  context: CommandContext,
): Promise<CommandOutcome> {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return 'not-a-command';

  const separator = trimmed.indexOf(' ');
  const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const argument = separator === -1 ? '' : trimmed.slice(separator + 1).trim();

  const spec = COMMANDS.get(name.toLowerCase());
  if (spec) return spec.run(argument, context);

  // Anything with a slash or a dot is far more likely to be a path the user is
  // asking about than a mistyped command.
  if (name.includes('/', 1) || name.includes('.')) return 'not-a-command';

  context.write(
    `\nunknown command: ${name}. Type /help to see what there is.\n\n`,
  );
  return 'handled';
}

/** The command names, for tests and for anything that wants to offer completion. */
export function commandNames(): string[] {
  return [...COMMANDS.keys()];
}
