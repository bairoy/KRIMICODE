import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR_SCREEN, renderDiff } from '../render.js';

/** Strip ANSI so assertions read clearly. */
const plain = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();

const lines = (before: string, after: string): string[] =>
  plain(renderDiff(before, after, ''))
    .split('\n')
    .map((line) => line.trim());

test('identical leading lines are hidden so the real change is visible', () => {
  const shared =
    '/** A long shared comment line that would otherwise dominate. */';
  const out = lines(`${shared}\nconst MAX = 25;`, `${shared}\nconst MAX = 30;`);

  assert.deepEqual(out, [
    '- const MAX = 25;',
    '+ const MAX = 30;',
    '(1 unchanged line hidden)',
  ]);
});

test('REGRESSION: the two sides must not render identically', () => {
  // The original bug: both sides were truncated at the same column, so the
  // prompt showed the same text twice and told the user nothing.
  const shared = 'x'.repeat(200);
  const out = lines(`${shared}\nold`, `${shared}\nnew`);
  const removed = out.find((line) => line.startsWith('-'));
  const added = out.find((line) => line.startsWith('+'));
  assert.notEqual(removed?.slice(1), added?.slice(1));
});

test('identical trailing lines are hidden too', () => {
  const out = lines('a\nchanged\nz', 'a\nCHANGED\nz');
  assert.deepEqual(out, [
    '- changed',
    '+ CHANGED',
    '(2 unchanged lines hidden)',
  ]);
});

test('a single line with a long shared prefix is trimmed to the difference', () => {
  const out = lines(
    'export const SOMETHING_QUITE_LONG_HERE = 25;',
    'export const SOMETHING_QUITE_LONG_HERE = 30;',
  );
  assert.equal(out.length, 2);
  assert.ok(out[0]?.startsWith('- …'), out[0] ?? '(no output)');
  assert.ok(out[0]?.includes('25'));
  assert.ok(out[1]?.includes('30'));
  assert.ok(
    (out[0]?.length ?? 0) < 30,
    'should be much shorter than the original',
  );
});

test('a short line is shown in full without an ellipsis', () => {
  assert.deepEqual(lines('const a = 1;', 'const b = 2;'), [
    '- const a = 1;',
    '+ const b = 2;',
  ]);
});

test('a pure deletion shows only removed lines', () => {
  const out = lines('keep\ngone', 'keep');
  assert.ok(out.some((line) => line.startsWith('- gone')));
  assert.equal(
    out.some((line) => line.startsWith('+')),
    false,
  );
});

test('a pure insertion shows only added lines', () => {
  const out = lines('keep', 'keep\nfresh');
  assert.ok(out.some((line) => line.startsWith('+ fresh')));
  assert.equal(
    out.some((line) => line.startsWith('-')),
    false,
  );
});

test('long runs of lines collapse with an accurate count', () => {
  const after = [
    'start',
    ...Array.from({ length: 10 }, (_, i) => `line${i}`),
    'end',
  ];
  const out = lines('start\nend', after.join('\n'));
  const collapsed = out.find((line) => line.includes('more lines')) ?? '';
  assert.ok(collapsed, 'expected a collapse marker');
  assert.match(collapsed, /… 4 more lines/); // 10 added, 6 shown
});

test('no unchanged-lines note when everything differs', () => {
  const out = lines('a', 'b');
  assert.equal(
    out.some((line) => line.includes('unchanged')),
    false,
  );
});

test('output is coloured but every sequence is closed', () => {
  const raw = renderDiff('a', 'b', '  ');
  const opens = (raw.match(/\x1b\[(?:2|31|32)m/g) ?? []).length;
  const resets = (raw.match(/\x1b\[0m/g) ?? []).length;
  assert.equal(
    opens,
    resets,
    'an unclosed sequence would leak colour into the shell',
  );
});

test('clearing the screen also clears the scrollback', () => {
  // 2J alone wipes only what is visible. Without 3J the user can scroll up and
  // read the conversation the agent has just been told to forget, which makes
  // /clear look broken — and leaves the transcript on screen.
  assert.match(CLEAR_SCREEN, /\x1b\[2J/, 'must clear the visible screen');
  assert.match(CLEAR_SCREEN, /\x1b\[3J/, 'must clear the scrollback');
  assert.match(CLEAR_SCREEN, /\x1b\[H/, 'must home the cursor');
});
