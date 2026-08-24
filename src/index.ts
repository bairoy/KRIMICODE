import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, loadEnvFile } from './config.js';
import { OpenAICompatibleProvider } from './provider.js';
import { Agent } from './agent.js';
import type { CompactionInfo } from './agent.js';
import { registerSecret } from './redact.js';
import {
  createPasteFilter,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
} from './paste.js';
import { PermissionGate } from './permissions.js';
import type { AskUser, OperationClass, UserAnswer } from './permissions.js';
import type { ToolResult } from './types.js';
import {
  BOLD_RED,
  DIM,
  RESET,
  renderDiff,
  YELLOW,
} from './render.js';

/** Short human labels for the approval prompt. */
const OPERATION_LABEL: Record<OperationClass, string> = {
  READ: 'read',
  READ_SENSITIVE: 'read credential file',
  WRITE: 'write file',
  EXECUTE: 'run command',
  DESTRUCTIVE: 'DESTRUCTIVE',
  GIT_STATE_CHANGE: 'change git state',
};


/**
 * Owns every byte written to stdout during a turn: the waiting spinner, dimmed
 * reasoning, and the answer. ARCHITECTURE §2 — rendering belongs to the CLI,
 * not the agent runtime.
 */
function createRenderer() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinner: NodeJS.Timeout | null = null;
  let inReasoning = false;

  const clearSpinner = (): void => {
    if (!spinner) return;
    clearInterval(spinner);
    spinner = null;
    stdout.write('\r\x1b[K'); // return to column 0, clear to end of line
  };

  return {
    /** Nothing has arrived yet — there is no content to show, only a pulse. */
    waiting(): void {
      if (!stdout.isTTY) return;
      let i = 0;
      spinner = setInterval(() => {
        stdout.write(`\r${frames[i++ % frames.length] ?? ''} thinking…`);
      }, 80);
    },
    reasoning(text: string): void {
      // Don't open a dim block for whitespace — models often emit a stray
      // newline of "reasoning" even when they did none.
      if (!inReasoning && text.trim() === '') return;
      clearSpinner();
      if (!inReasoning) {
        stdout.write('\x1b[2m'); // dim
        inReasoning = true;
      }
      stdout.write(text);
    },
    text(text: string): void {
      clearSpinner();
      if (inReasoning) {
        stdout.write('\x1b[0m\n\n'); // reset, then separate from the answer
        inReasoning = false;
      }
      stdout.write(text);
    },
    toolStart(name: string, argsJson: string): void {
      clearSpinner();
      if (inReasoning) {
        stdout.write('\x1b[0m\n');
        inReasoning = false;
      }
      const args =
        argsJson.length > 120 ? `${argsJson.slice(0, 120)}…` : argsJson;
      stdout.write(`\n\x1b[36m⚒ ${name}\x1b[0m \x1b[2m${args}\x1b[0m\n`);
    },
    /**
     * History was folded into a summary. Worth surfacing: the model has just
     * lost detail it previously had, and silently forgetting things is the
     * kind of behaviour that reads as the agent being broken.
     */
    compacted(info: CompactionInfo): void {
      clearSpinner();
      const note = info.fallback ? ', summary unavailable — used a digest' : '';
      stdout.write(
        `\n${DIM}⟳ compacted context: ~${info.tokensBefore} → ~${info.tokensAfter} tokens, ` +
          `${info.messagesElided} message${info.messagesElided === 1 ? '' : 's'} summarized${note}${RESET}\n`,
      );
    },
    toolEnd(result: ToolResult): void {
      stdout.write(
        result.success
          ? `  \x1b[32m✓\x1b[0m \x1b[2m${result.content.length} chars\x1b[0m\n\n`
          : `  \x1b[31m✗\x1b[0m \x1b[2m${result.error}\x1b[0m\n\n`,
      );
    },
    /** Must run on every path, including errors, or dim leaks into the shell. */
    end(): void {
      clearSpinner();
      if (inReasoning) {
        stdout.write('\x1b[0m');
        inReasoning = false;
      }
      stdout.write('\n\n');
    },
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();

  // Scrub the exact key from anything a tool returns, on top of the
  // pattern heuristics in redact.ts.
  registerSecret(config.apiKey);

  const render = createRenderer();

  // On a real terminal, route stdin through the bracketed-paste filter so a
  // multi-line paste lands in the buffer instead of submitting itself. Raw
  // mode has to be set on the real stdin, since readline only sees the filter.
  // When stdin is a pipe there is no paste to bracket, so use it unchanged.
  const interactive = Boolean(stdin.isTTY);
  if (interactive) {
    stdin.setRawMode(true);
    stdout.write(ENABLE_BRACKETED_PASTE);
  }
  const rl = readline.createInterface({
    input: interactive ? stdin.pipe(createPasteFilter()) : stdin,
    output: stdout,
    // Forced on when interactive, because readline sees the filter rather than
    // the TTY and would otherwise skip line editing. Left off for a pipe, or
    // readline emits cursor-control codes into non-terminal output.
    terminal: interactive,
  });
  /**
   * The turn in flight, or null while waiting for input. Ctrl-C means "stop
   * what you are doing" during a turn and "quit" when there is nothing to
   * stop — the same key, read from context, as in any shell.
   */
  let active: AbortController | null = null;

  // Raw mode means SIGINT arrives here as a readline event rather than as a
  // process signal, so this is the only handler.
  rl.on('SIGINT', () => {
    if (active === null) {
      rl.close();
      return;
    }
    active.abort();
  });

  /**
   * The approval prompt. Anything other than an explicit yes is a refusal —
   * including a closed stdin, so a non-interactive run can never be
   * auto-approved into writing or executing something.
   */
  const askUser: AskUser = async (request): Promise<UserAnswer> => {
    const destructive = request.operation === 'DESTRUCTIVE';
    const accent = destructive ? BOLD_RED : YELLOW;
    const label = OPERATION_LABEL[request.operation];

    stdout.write('\n');
    stdout.write(
      `  ${accent}⚠ ${label}${RESET} ${DIM}via ${request.toolName}${RESET}\n`,
    );
    stdout.write(`  ${request.detail}\n`);

    if (request.diff) {
      stdout.write('\n');
      stdout.write(`${renderDiff(request.diff.before, request.diff.after, '    ')}\n`);
    }

    // "always" is never offered for a destructive op — the gate refuses to
    // remember one, so offering it would be a lie.
    const options = destructive
      ? `${DIM}[y]${RESET}es  ${DIM}[n]${RESET}o`
      : `${DIM}[y]${RESET}es  ${DIM}[n]${RESET}o  ${DIM}[a]${RESET}lways`;

    let answer: string;
    try {
      // The signal makes Ctrl-C dismiss the prompt. Without it the question
      // stays pending forever and the cancelled turn never finishes.
      const signal = active?.signal;
      answer = (
        await rl.question(
          `\n  ${options} ${DIM}›${RESET} `,
          signal ? { signal } : {},
        )
      )
        .trim()
        .toLowerCase();
    } catch {
      return 'no'; // stdin closed mid-prompt, or the turn was cancelled
    }

    if (!destructive && (answer === 'a' || answer === 'always')) return 'always';
    if (answer === 'y' || answer === 'yes') return 'once';
    return 'no';
  };

  const gate = new PermissionGate(askUser);

  const agent = new Agent({
    provider: new OpenAICompatibleProvider(config),
    model: config.model,
    workspaceRoot: config.workspaceRoot,
    gate,
    onText: (text) => render.text(text),
    onReasoning: (text) => render.reasoning(text),
    onToolStart: (name, argsJson) => render.toolStart(name, argsJson),
    onToolEnd: (_name, result) => {
      render.toolEnd(result);
      render.waiting(); // back to waiting on the model
    },
    maxContextTokens: config.maxContextTokens,
    onCompact: (info) => {
      render.compacted(info);
      render.waiting();
    },
  });

  // baseURL and model are not secrets. apiKey is never printed.
  console.log(
    `krimicode — ${config.model} @ ${config.baseURL} ` +
      `${DIM}(context ${config.maxContextTokens} tokens)${RESET}`,
  );
  console.log('/exit or Ctrl-C to quit.\n');

  try {
    for (; ;) {
      let line: string;
      try {
        line = (await rl.question('> ')).trim();
      } catch {
        break; // stdin closed: Ctrl-D, or piped input exhausted.
      }
      if (!line) continue;
      if (line === '/exit') break;

      render.waiting();
      active = new AbortController();
      try {
        await agent.send(line, active.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)
          ? ` (could not reach ${config.baseURL})`
          : '';
        console.error(`\nerror: ${msg}${hint}\n`);
      } finally {
        const cancelled = active.signal.aborted;
        // Cleared before rendering, so a Ctrl-C landing in this window is read
        // as "quit" rather than aborting a controller nothing is watching.
        active = null;
        render.end();
        if (cancelled) stdout.write(`${DIM}cancelled${RESET}\n\n`);
      }
    }
  } finally {
    rl.close();
    // Restore the terminal, whatever happened. Leaving bracketed paste or raw
    // mode on would corrupt the user's shell after we exit.
    if (interactive) {
      stdout.write(DISABLE_BRACKETED_PASTE);
      stdin.setRawMode(false);
      stdin.pause();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
