import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { createFileTool } from '../tools/create_file.js';
import { allowAll, denyAll, spyGate } from './helpers.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'krimi-create-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const create = (args: Record<string, unknown>, gate = allowAll()) =>
  createFileTool.run(JSON.stringify(args), { workspaceRoot: root }, gate);

test('a new file is created with its contents', async () => {
  const result = await create({ path: 'notes.txt', content: 'i love you\n' });

  assert.equal(result.success, true);
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'i love you\n');
});

test('an empty file can be created', async () => {
  const result = await create({ path: 'blank.txt', content: '' });

  assert.equal(result.success, true);
  assert.equal(await readFile(join(root, 'blank.txt'), 'utf8'), '');
});

test('SECURITY: an existing file is never overwritten', async () => {
  await writeFile(join(root, 'keep.txt'), 'ORIGINAL', 'utf8');

  const result = await create({ path: 'keep.txt', content: 'REPLACED' });

  assert.equal(result.success, false);
  assert.equal(
    await readFile(join(root, 'keep.txt'), 'utf8'),
    'ORIGINAL',
    'the original file was destroyed',
  );
});

test('creation goes through the permission gate', async () => {
  const { gate, seen } = spyGate(true);

  await create({ path: 'gated.txt', content: 'x' }, gate);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.operation, 'WRITE');
});

test('a denied creation writes nothing', async () => {
  const result = await create({ path: 'denied.txt', content: 'x' }, denyAll());

  assert.equal(result.success, false);
  await assert.rejects(() => readFile(join(root, 'denied.txt'), 'utf8'));
});

test('SECURITY: creating a credential file is DESTRUCTIVE', async () => {
  // So a standing "always" for create_file can never cover it.
  const { gate, seen } = spyGate(true);

  await create({ path: '.env', content: 'KEY=value' }, gate);

  assert.equal(seen[0]?.operation, 'DESTRUCTIVE');
});

test('SECURITY: a path outside the workspace is refused without prompting', async () => {
  const { gate, seen } = spyGate(true);

  const result = await create({ path: '../escaped.txt', content: 'x' }, gate);

  assert.equal(result.success, false);
  assert.deepEqual(seen, [], 'the user was asked about an escape attempt');
  assert.match(result.success ? '' : result.error, /outside the workspace/);
});

test('a missing parent directory fails loudly rather than being created', async () => {
  // Silently building a tree from a mistyped path is the same hazard that
  // makes edit_file refuse to create files at all.
  const result = await create({ path: 'nope/deep/f.txt', content: 'x' });

  assert.equal(result.success, false);
  assert.match(
    result.success ? '' : result.error,
    /does not create directories/,
  );
});

test('an existing file is refused before the user is prompted', async () => {
  // The point of precheck: no approval prompt for work that cannot happen.
  await writeFile(join(root, 'there.txt'), 'x', 'utf8');
  const { gate, seen } = spyGate(true);

  const result = await create({ path: 'there.txt', content: 'y' }, gate);

  assert.equal(result.success, false);
  assert.deepEqual(
    seen,
    [],
    'the user was prompted for an impossible creation',
  );
});

test('the result says what was created', async () => {
  const result = await create({ path: 'x.txt', content: 'a\nb\nc' });

  assert.equal(result.success, true);
  assert.match(result.success ? result.content : '', /x\.txt/);
});
