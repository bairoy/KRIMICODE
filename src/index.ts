#!/usr/bin/env node
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseCliArgs, USAGE } from './args.js';
import { loadConfig, loadEnvFile } from './config.js';
import { OpenAICompatibleProvider } from './provider.js';
import { Agent, MaxTurnsError } from './agent.js';
import type { CompactionInfo } from './agent.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import {
  deriveTitle,
  formatSessionLine,
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
} from './session.js';
import type { SavedSession } from './session.js';
import { toolSpecs } from './tools/index.js';
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
  CLEAR_SCREEN,
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
  const cli = parseCliArgs(process.argv.slice(2));

  // Before loadConfig, so `--help` still works for someone who has not set up
  // an API key yet — which is exactly who most needs to read it.
  if (cli.help) {
    console.log(USAGE);
    return;
  }

  loadEnvFile();
  const config = loadConfig();

  // Scrub the exact key from anything a tool returns, on top of the
  // pattern heuristics in redact.ts.
  registerSecret(config.apiKey);

  // --list is a query, not a session: print and leave without touching the
  // terminal mode or opening a connection to the model.
  if (cli.list) {
    const sessions = await listSessions(config.workspaceRoot);
    if (sessions.length === 0) {
      console.log('No saved sessions for this directory.');
    } else {
      for (const session of sessions) {
        console.log(formatSessionLine(session));
      }
    }
    return;
  }

  // Resolve any resume before the agent is built, so its restored history can
  // be handed to the constructor rather than pushed in afterwards.
  let resumed: SavedSession | null = null;
  if (cli.resume !== undefined) {
    resumed = await loadSession(cli.resume, undefined);
    if (!resumed) {
      throw new Error(
        `No session "${cli.resume}". Run with --list to see what there is.`,
      );
    }
  } else if (cli.continue) {
    resumed = await latestSession(config.workspaceRoot);
    if (!resumed) {
      console.log('No session to continue in this directory; starting fresh.');
    }
  }

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

  /**
   * Aborts the `> ` prompt when it is time to leave.
   *
   * `rl.close()` does **not** settle a pending `rl.question()` — the promise
   * simply never resolves or rejects. Closing the interface to quit therefore
   * hung the loop before the `finally` below could run, which left the terminal
   * in raw mode with bracketed paste still enabled: the user's shell was broken
   * after we exited. Aborting the question makes it reject, so the loop leaves
   * through its normal path and the cleanup actually happens.
   */
  let idle: AbortController | null = null;

  const stopWaitingForInput = (): void => idle?.abort();

  // Raw mode means SIGINT arrives here as a readline event rather than as a
  // process signal, so this is the only handler.
  rl.on('SIGINT', () => {
    if (active === null) {
      // Nothing to interrupt, so this means quit.
      stopWaitingForInput();
      return;
    }
    active.abort();
  });

  // Ctrl-D and an exhausted pipe both close the interface rather than sending
  // a line, and would strand the pending question for the same reason.
  rl.on('close', stopWaitingForInput);

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
      stdout.write(
        `${renderDiff(request.diff.before, request.diff.after, '    ')}\n`,
      );
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

    if (!destructive && (answer === 'a' || answer === 'always'))
      return 'always';
    if (answer === 'y' || answer === 'yes') return 'once';
    return 'no';
  };

  const gate = new PermissionGate(askUser);

  const agent = new Agent({
    provider: new OpenAICompatibleProvider(config),
    // A resumed session keeps the model it was held with, so continuing a
    // conversation does not silently change who is answering.
    model: resumed?.model ?? config.model,
    ...(resumed
      ? {
          initialState: {
            history: resumed.history,
            summary: resumed.summary,
          },
        }
      : {}),
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

  /**
   * The session being written to. A resumed one keeps its id so continuing
   * updates the same file rather than accumulating near-duplicates; `/clear`
   * starts a new one, so the cleared conversation stays on disk.
   */
  let sessionId = resumed?.id ?? newSessionId();
  let createdAt = resumed?.createdAt ?? new Date().toISOString();

  /**
   * Persist the conversation as it stands. Called after a turn settles, never
   * during one: a snapshot taken mid-turn can hold a tool call whose result has
   * not been recorded yet, which is exactly the malformed history that makes
   * every later request fail.
   */
  const persist = async (): Promise<void> => {
    const state = agent.snapshot();
    if (state.history.length === 0) return; // nothing worth a file yet

    try {
      await saveSession({
        version: 1,
        id: sessionId,
        workspaceRoot: config.workspaceRoot,
        model: agent.model,
        createdAt,
        updatedAt: new Date().toISOString(),
        title: deriveTitle(state.history),
        summary: state.summary,
        history: [...state.history],
      });
    } catch (err) {
      // Failing to save is worth knowing about but must not end the session —
      // the conversation in memory is still perfectly usable.
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`${DIM}could not save session: ${message}${RESET}\n`);
    }
  };

  /**
   * baseURL and model are not secrets; the apiKey is never printed.
   *
   * Reprinted after `/clear` wipes the screen, so a blank terminal still says
   * which model you are talking to and where it lives.
   */
  const printBanner = (note?: string): void => {
    console.log(
      `krimicode — ${agent.model} @ ${config.baseURL} ` +
        `${DIM}(context ${config.maxContextTokens} tokens)${RESET}`,
    );
    if (note !== undefined) console.log(note);
    console.log(`${DIM}/help for commands. Ctrl-C to stop or quit.${RESET}\n`);
  };

  const commandContext: CommandContext = {
    write: (text) => stdout.write(text),
    getModel: () => agent.model,
    setModel: (name) => {
      agent.model = name;
    },
    clear: () => {
      agent.reset();
      // A fresh id, so the cleared conversation is not overwritten by what
      // comes next.
      sessionId = newSessionId();
      createdAt = new Date().toISOString();

      // Wipe the screen too. Forgetting the conversation while leaving it all
      // visible reads as though the command did nothing — and the scrollback
      // would still hold what the agent has been told to forget.
      // Only on a terminal: these codes would be literal junk in a pipe or a
      // redirected log.
      if (stdout.isTTY) {
        stdout.write(CLEAR_SCREEN);
        printBanner();
      }
    },
    /**
     * Summarizing is a model call, so this runs through the same machinery as
     * a turn: spinner, an `active` controller so Ctrl-C interrupts it, and a
     * save afterwards — the summary is part of the session, and losing it would
     * mean paying for the same compaction again on resume.
     */
    compact: async () => {
      render.waiting();
      const controller = new AbortController();
      active = controller;
      try {
        const info = await agent.compact(controller.signal);
        // Cancelling is checked first: an aborted compaction also returns null,
        // and reporting that as "nothing to compact" would be a lie about a
        // conversation that may well have plenty to fold.
        if (controller.signal.aborted) return 'cancelled';
        return info === null ? 'nothing-to-do' : 'compacted';
      } finally {
        const cancelled = controller.signal.aborted;
        active = null;
        render.end();
        if (cancelled) stdout.write(`${DIM}cancelled${RESET}\n\n`);
        await persist();
      }
    },
    listTools: () =>
      toolSpecs().map((spec) => ({
        name: spec.name,
        description: spec.description,
      })),
    listSessions: async () =>
      (await listSessions(config.workspaceRoot)).map((session) =>
        formatSessionLine(session),
      ),
  };

  printBanner(
    resumed
      ? `${DIM}resumed ${resumed.id} — ${resumed.history.length} messages: ${resumed.title}${RESET}`
      : undefined,
  );

  try {
    for (;;) {
      let line: string;
      idle = new AbortController();
      try {
        line = (await rl.question('> ', { signal: idle.signal })).trim();
      } catch {
        // Ctrl-C at the prompt, Ctrl-D, or piped input exhausted. All three
        // mean the same thing here: stop asking for input and shut down
        // cleanly through the finally below.
        break;
      }
      if (!line) continue;

      const outcome = await handleCommand(line, commandContext);
      if (outcome === 'exit') break;
      if (outcome === 'handled') continue;

      render.waiting();
      active = new AbortController();
      try {
        await agent.send(line, active.signal);
      } catch (err) {
        // The turn limit is not a malfunction — the conversation is intact and
        // can be continued. Say what happened and what to do about it, rather
        // than rendering it as an unexplained failure.
        if (err instanceof MaxTurnsError) {
          console.error(
            `\n${YELLOW}⚠ ${err.message}${RESET}\n` +
              `${DIM}  The model made ${err.turns} rounds of tool calls without` +
              ' answering. The conversation is still intact — try narrowing the\n' +
              `  request, or ask it to summarize what it found so far.${RESET}\n`,
          );
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          const hint = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)
            ? ` (could not reach ${config.baseURL})`
            : '';
          console.error(`\nerror: ${msg}${hint}\n`);
        }
      } finally {
        const cancelled = active.signal.aborted;
        // Cleared before rendering, so a Ctrl-C landing in this window is read
        // as "quit" rather than aborting a controller nothing is watching.
        active = null;
        render.end();
        if (cancelled) stdout.write(`${DIM}cancelled${RESET}\n\n`);

        // After the turn has settled, including after an error or a
        // cancellation: history is well-formed at this point in all three
        // cases, and losing the work because the turn ended badly would be
        // worse than saving it.
        await persist();
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
