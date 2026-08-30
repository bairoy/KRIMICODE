import type { AskUser, OperationClass, UserAnswer } from '../permissions.js';
import { BOLD_RED, DIM, renderDiff, RESET, YELLOW } from './ansi.js';

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
 * The two things the prompt needs from the terminal, and nothing else.
 *
 * `ask` is expected to already carry the current turn's cancellation — the
 * REPL owns that, since it is the only place that knows which turn is live.
 * Keeping it out of here means this file has no opinion about AbortSignals at
 * all, and can be driven from a test with two plain functions.
 */
export interface ApprovalTerminal {
  /** Prompt for a line. Rejects if stdin closes or the turn is cancelled. */
  readonly ask: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
}

/**
 * The approval prompt. Anything other than an explicit yes is a refusal —
 * including a closed stdin, so a non-interactive run can never be
 * auto-approved into writing or executing something.
 */
export function createApprovalPrompt(terminal: ApprovalTerminal): AskUser {
  return async (request): Promise<UserAnswer> => {
    const destructive = request.operation === 'DESTRUCTIVE';
    const accent = destructive ? BOLD_RED : YELLOW;
    const label = OPERATION_LABEL[request.operation];

    terminal.write('\n');
    terminal.write(
      `  ${accent}⚠ ${label}${RESET} ${DIM}via ${request.toolName}${RESET}\n`,
    );
    terminal.write(`  ${request.detail}\n`);

    if (request.diff) {
      terminal.write('\n');
      terminal.write(
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
      answer = (await terminal.ask(`\n  ${options} ${DIM}›${RESET} `))
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
}
