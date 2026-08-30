import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPasteFilter } from '../../cli/paste.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

/** Feed chunks through the filter exactly as stdin would deliver them. */
async function filter(chunks: string[]): Promise<string> {
  const stream = createPasteFilter();
  let out = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => (out += chunk));
  for (const chunk of chunks) stream.write(Buffer.from(chunk, 'utf8'));
  await new Promise<void>((resolve) => stream.end(() => resolve()));
  return out;
}

test('typed text passes through untouched, so Enter still submits', async () => {
  assert.equal(await filter(['hello\n']), 'hello\n');
  assert.equal(await filter(['a', 'b', '\n']), 'ab\n');
});

test('newlines inside a paste become spaces and do not submit', async () => {
  assert.equal(
    await filter([`${START}line one\nline two\nline three${END}`]),
    'line one line two line three',
  );
});

test('the user pressing Enter after a paste still submits', async () => {
  assert.equal(await filter([`${START}a\nb${END}`, '\n']), 'a b\n');
});

test('CRLF inside a paste collapses to a single space', async () => {
  assert.equal(await filter([`${START}a\r\nb${END}`]), 'a b');
});

test('a start marker split across two reads is still recognised', async () => {
  assert.equal(await filter(['\x1b[20', `0~x\ny${END}`]), 'x y');
});

test('an end marker split across two reads is still recognised', async () => {
  assert.equal(await filter([`${START}x\ny\x1b[201`, '~']), 'x y');
});

test('a marker split one byte at a time survives', async () => {
  const chunks = [...`${START}a\nb${END}`];
  assert.equal(await filter(chunks), 'a b');
});

test('typing between two pastes is preserved', async () => {
  assert.equal(
    await filter([`${START}a\nb${END}`, 'mid', `${START}c\nd${END}`]),
    'a bmidc d',
  );
});

test('an unterminated paste is still flushed rather than swallowed', async () => {
  assert.equal(await filter([`${START}a\nb`]), 'a b');
});

test('other escape sequences are not mistaken for paste markers', async () => {
  assert.equal(await filter(['\x1b[A']), '\x1b[A'); // up arrow
  assert.equal(await filter(['\x1b[2004~']), '\x1b[2004~');
  assert.equal(await filter(['\x1b[200']), '\x1b[200'); // never completed
});

test('markers themselves never reach readline', async () => {
  const out = await filter([`${START}text${END}`]);
  assert.equal(out.includes('200~'), false);
  assert.equal(out.includes('201~'), false);
  assert.equal(out, 'text');
});
