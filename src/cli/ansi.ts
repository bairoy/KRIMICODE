import { stdout } from 'node:process';

export const DIM = '\x1b[2m';
export const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BOLD_RED = '\x1b[1;31m';

/**
 * Wipe the screen, the scrollback, and put the cursor back at the top.
 *
 * `2J` clears what is visible, `3J` clears the scrollback buffer, and `H` homes
 * the cursor. The scrollback matters: without `3J` the user can scroll up and
 * read a conversation the agent has been told to forget, which makes `/clear`
 * look like it did not work.
 */
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** Longest run of identical leading array elements. */
function commonPrefixLength(
  a: readonly string[],
  b: readonly string[],
): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Renders a before/after pair as -/+ lines.
 *
 * Identical leading and trailing lines are dropped first, so what remains is
 * the part that actually differs. Without that, an edit whose old_str and
 * new_str share a long prefix shows two identical truncated lines — which
 * tells the user nothing about what they are approving.
 */
export function renderDiff(
  before: string,
  after: string,
  indent: string,
): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const head = commonPrefixLength(beforeLines, afterLines);
  const reversedB = [...beforeLines].reverse();
  const reversedA = [...afterLines].reverse();
  const tail = Math.min(
    commonPrefixLength(reversedB, reversedA),
    beforeLines.length - head,
    afterLines.length - head,
  );

  let removed = beforeLines.slice(head, beforeLines.length - tail);
  let added = afterLines.slice(head, afterLines.length - tail);

  // Both sides are a single line sharing a long prefix: trim that too, so the
  // difference is visible rather than pushed past the right edge.
  const onlyRemoved = removed[0];
  const onlyAdded = added[0];
  if (removed.length === 1 && added.length === 1 && onlyRemoved && onlyAdded) {
    let shared = 0;
    while (
      shared < onlyRemoved.length &&
      shared < onlyAdded.length &&
      onlyRemoved[shared] === onlyAdded[shared]
    ) {
      shared++;
    }
    if (shared > 24) {
      const cut = shared - 8; // keep a little context before the change
      removed = [`…${onlyRemoved.slice(cut)}`];
      added = [`…${onlyAdded.slice(cut)}`];
    }
  }

  const width = Math.max(40, (stdout.columns ?? 80) - indent.length - 4);
  const fit = (line: string): string =>
    line.length > width ? `${line.slice(0, width - 1)}…` : line;

  const MAX_LINES = 6;
  const render = (lines: string[], sign: string, color: string): string[] => {
    if (lines.length === 0) return [];
    const shown = lines
      .slice(0, MAX_LINES)
      .map((line) => `${indent}${color}${sign} ${fit(line)}${RESET}`);
    if (lines.length > MAX_LINES) {
      shown.push(
        `${indent}${DIM}${sign} … ${lines.length - MAX_LINES} more lines${RESET}`,
      );
    }
    return shown;
  };

  const context =
    head > 0 || tail > 0
      ? [
          `${indent}${DIM}(${head + tail} unchanged line${head + tail === 1 ? '' : 's'} hidden)${RESET}`,
        ]
      : [];

  return [
    ...render(removed, '-', RED),
    ...render(added, '+', GREEN),
    ...context,
  ].join('\n');
}
