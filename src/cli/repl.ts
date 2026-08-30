import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

import type { Agent } from '../agent/agent.js';
import { MaxTurnsError } from '../agent/agent.js';
import {
  deriveTitle,
  formatSessionLine,
  listSessions,
  newSessionId,
  saveSession,
} from '../agent/session.js';
import type { SavedSession } from '../agent/session.js';
import type { Config } from '../config.js';
import { counted } from '../plural.js';
import { toolSpecs } from '../tools/index.js';
import { CLEAR_SCREEN, DIM, RESET, YELLOW } from './ansi.js';
import type { ApprovalTerminal } from './approve.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import {
  createPasteFilter,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
} from './paste.js';
import type { Renderer } from './renderer.js';

export interface Repl {
  /**
   * Input and output for the approval prompt, already wired to whichever turn
   * is live. Handed to `createApprovalPrompt` before the agent exists, which
   * is why the terminal is built first and the loop started afterwards.
   */
  readonly terminal: ApprovalTerminal;
  /** Read, evaluate, print, until the user leaves. */
  readonly run: (agent: Agent, resumed: SavedSession | null) => Promise<void>;
  /**
   * Restore the terminal. Must run even if the caller fails between building
   * this and calling `run`, or the user's shell is left in raw mode with
   * bracketed paste enabled.
   */
  readonly close: () => void;
}

export function createRepl(options: {
  readonly config: Config;
  readonly render: Renderer;
}): Repl {
  const { config, render } = options;

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
   * hung the loop before the cleanup could run, which left the terminal in raw
   * mode with bracketed paste still enabled: the user's shell was broken after
   * we exited. Aborting the question makes it reject, so the loop leaves
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

  const terminal: ApprovalTerminal = {
    // `active` is read at call time, not captured: the approval prompt is
    // built once, before the first turn exists, and must follow whichever turn
    // is live. Without the signal the question stays pending forever and a
    // cancelled turn never finishes.
    ask: (prompt) => {
      const signal = active?.signal;
      return rl.question(prompt, signal ? { signal } : {});
    },
    write: (text) => stdout.write(text),
  };

  /**
   * Run something that talks to the model, with the whole turn apparatus
   * around it: a spinner, a controller Ctrl-C can abort, and the cancellation
   * notice afterwards. Both a user turn and a manual `/compact` are this.
   */
  const withTurn = async <T>(
    body: (signal: AbortSignal) => Promise<T>,
    afterwards: () => Promise<void>,
  ): Promise<{ value: T; cancelled: boolean }> => {
    render.waiting();
    const controller = new AbortController();
    active = controller;
    try {
      const value = await body(controller.signal);
      return { value, cancelled: controller.signal.aborted };
    } finally {
      const cancelled = controller.signal.aborted;
      // Cleared before rendering, so a Ctrl-C landing in this window is read
      // as "quit" rather than aborting a controller nothing is watching.
      active = null;
      render.end();
      if (cancelled) stdout.write(`${DIM}cancelled${RESET}\n\n`);
      await afterwards();
    }
  };

  const close = (): void => {
    rl.close();
    // Restore the terminal, whatever happened. Leaving bracketed paste or raw
    // mode on would corrupt the user's shell after we exit.
    if (interactive) {
      stdout.write(DISABLE_BRACKETED_PASTE);
      stdin.setRawMode(false);
      stdin.pause();
    }
  };

  const run = async (
    agent: Agent,
    resumed: SavedSession | null,
  ): Promise<void> => {
    /**
     * The session being written to. A resumed one keeps its id so continuing
     * updates the same file rather than accumulating near-duplicates;
     * `/clear` starts a new one, so the cleared conversation stays on disk.
     */
    let sessionId = resumed?.id ?? newSessionId();
    let createdAt = resumed?.createdAt ?? new Date().toISOString();

    /**
     * Persist the conversation as it stands. Called after a turn settles,
     * never during one: a snapshot taken mid-turn can hold a tool call whose
     * result has not been recorded yet, which is exactly the malformed history
     * that makes every later request fail.
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
        // Failing to save is worth knowing about but must not end the session
        // — the conversation in memory is still perfectly usable.
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`${DIM}could not save session: ${message}${RESET}\n`);
      }
    };

    /**
     * baseURL and model are not secrets; the apiKey is never printed.
     *
     * Reprinted after `/clear` wipes the screen, so a blank terminal still
     * says which model you are talking to and where it lives.
     */
    const printBanner = (note?: string): void => {
      console.log(
        `krimicode — ${agent.model} @ ${config.baseURL} ` +
          `${DIM}(context ${config.maxContextTokens} tokens)${RESET}`,
      );
      if (note !== undefined) console.log(note);
      console.log(
        `${DIM}/help for commands. Ctrl-C to stop or quit.${RESET}\n`,
      );
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

        // Wipe the screen too. Forgetting the conversation while leaving it
        // all visible reads as though the command did nothing — and the
        // scrollback would still hold what the agent has been told to forget.
        // Only on a terminal: these codes would be literal junk in a pipe or a
        // redirected log.
        if (stdout.isTTY) {
          stdout.write(CLEAR_SCREEN);
          printBanner();
        }
      },
      /**
       * Summarizing is a model call, so it gets the same apparatus as a turn:
       * spinner, an abortable controller, and a save afterwards — the summary
       * is part of the session, and losing it would mean paying for the same
       * compaction again on resume.
       */
      compact: async () => {
        const { value, cancelled } = await withTurn(
          (signal) => agent.compact(signal),
          persist,
        );
        // Cancelling is checked first: an aborted compaction also returns
        // null, and reporting that as "nothing to compact" would be a lie
        // about a conversation that may well have plenty to fold.
        if (cancelled) return 'cancelled';
        return value === null ? 'nothing-to-do' : 'compacted';
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
        ? `${DIM}resumed ${resumed.id} — ${counted(resumed.history.length, 'message')}: ${resumed.title}${RESET}`
        : undefined,
    );

    for (;;) {
      let line: string;
      idle = new AbortController();
      try {
        line = (await rl.question('> ', { signal: idle.signal })).trim();
      } catch {
        // Ctrl-C at the prompt, Ctrl-D, or piped input exhausted. All three
        // mean the same thing here: stop asking for input and shut down.
        return;
      }
      if (!line) continue;

      const outcome = await handleCommand(line, commandContext);
      if (outcome === 'exit') return;
      if (outcome === 'handled') continue;

      await withTurn(async (signal) => {
        try {
          await agent.send(line, signal);
        } catch (err) {
          reportTurnError(err, config.baseURL);
        }
        // After the turn has settled, including after an error or a
        // cancellation: history is well-formed at this point in all three
        // cases, and losing the work because the turn ended badly would be
        // worse than saving it.
      }, persist);
    }
  };

  return { terminal, run, close };
}

/**
 * A failed turn is not a failed session — the conversation is intact either
 * way, so this prints and returns rather than throwing.
 */
function reportTurnError(err: unknown, baseURL: string): void {
  // The turn limit is not a malfunction. Say what happened and what to do
  // about it, rather than rendering it as an unexplained failure.
  if (err instanceof MaxTurnsError) {
    console.error(
      `\n${YELLOW}⚠ ${err.message}${RESET}\n` +
        `${DIM}  The model made ${counted(err.turns, 'round')} of tool calls without` +
        ' answering. The conversation is still intact — try narrowing the\n' +
        `  request, or ask it to summarize what it found so far.${RESET}\n`,
    );
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  const hint = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)
    ? ` (could not reach ${baseURL})`
    : '';
  console.error(`\nerror: ${msg}${hint}\n`);
}
