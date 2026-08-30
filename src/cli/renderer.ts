import { stdout } from 'node:process';

import type { CompactionInfo } from '../agent/agent.js';
import { counted } from '../plural.js';
import type { ToolResult } from '../types.js';
import { DIM, RESET } from './ansi.js';

/**
 * Owns every byte written to stdout during a turn: the waiting spinner, dimmed
 * reasoning, and the answer. ARCHITECTURE §2 — rendering belongs to the CLI,
 * not the agent runtime.
 *
 * Stateful, unlike `ansi.ts`: it remembers whether a spinner is running and
 * whether a dim block is open, and both have to be closed on every exit path
 * or the escape codes leak into the user's shell.
 */
export interface Renderer {
  waiting(): void;
  reasoning(text: string): void;
  text(text: string): void;
  toolStart(name: string, argsJson: string): void;
  compacted(info: CompactionInfo): void;
  toolEnd(result: ToolResult): void;
  end(): void;
}

export function createRenderer(): Renderer {
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
          `${counted(info.messagesElided, 'message')} summarized${note}${RESET}\n`,
      );
    },
    toolEnd(result: ToolResult): void {
      stdout.write(
        result.success
          ? `  \x1b[32m✓\x1b[0m \x1b[2m${counted(result.content.length, 'char')}\x1b[0m\n\n`
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
