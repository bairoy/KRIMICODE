import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from '../tools/edit_file.js';
import { allowAll, denyAll, spyGate } from './helpers.js';

const ORIGINAL = [
  'const a = 1;',
  'const dup = 2;',
  'const b = 3;',
  'const dup = 4;',
  'const c = 5;',
].join('\n');

let root = '';
const FILE = 'sample.ts';

beforeEach(async () => {
  if (!root) root = await mkdtemp(join(tmpdir(), 'krimi-edit-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, FILE), ORIGINAL, 'utf8');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const edit = (args: Record<string, unknown>, gate = allowAll()) =>
  editFileTool.run(JSON.stringify(args), { workspaceRoot: root }, gate);

const contents = () => readFile(join(root, FILE), 'utf8');

test('§6.1 the file must already exist; edit_file never creates one', async () => {
  const result = await edit({ path: 'nope.ts', old_str: 'x', new_str: 'y' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('cannot create files'));
  await assert.rejects(() => readFile(join(root, 'nope.ts'), 'utf8'));
});

test('§6.1 old_str must be present', async () => {
  const result = await edit({ path: FILE, old_str: 'const zzz = 9;', new_str: 'x' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.retryable, 'model can re-read and retry');
  assert.equal(await contents(), ORIGINAL);
});

test('§6.2 more than one match fails rather than picking the first', async () => {
  const result = await edit({ path: FILE, old_str: 'const dup', new_str: 'changed' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('2 times'));
  assert.ok(!result.success && result.retryable);
  assert.equal(await contents(), ORIGINAL, 'nothing may be written on ambiguity');
});

test('§6.2 replace_all must be opted into explicitly', async () => {
  const result = await edit({
    path: FILE,
    old_str: 'const dup',
    new_str: 'const uniq',
    replace_all: true,
  });
  assert.equal(result.success, true);
  const after = await contents();
  assert.equal(after.includes('const dup'), false);
  assert.equal(after.split('const uniq').length - 1, 2);
  assert.ok(after.includes('const b = 3;'), 'untouched lines survive');
});

test('§6.3 a unique edit changes only its own region', async () => {
  const result = await edit({
    path: FILE,
    old_str: 'const b = 3;',
    new_str: 'const b = 30;',
  });
  assert.equal(result.success, true);
  assert.equal(await contents(), ORIGINAL.replace('const b = 3;', 'const b = 30;'));
});

test('§6.3 the file is spliced, never regenerated', async () => {
  // Trailing newline and exact whitespace must survive an edit elsewhere.
  const fussy = 'line one\n\n\tindented\n\nlast\n';
  await writeFile(join(root, 'fussy.txt'), fussy, 'utf8');
  await edit({ path: 'fussy.txt', old_str: 'line one', new_str: 'line 1' });
  assert.equal(
    await readFile(join(root, 'fussy.txt'), 'utf8'),
    fussy.replace('line one', 'line 1'),
  );
});

test('an empty new_str deletes', async () => {
  const result = await edit({ path: FILE, old_str: '\nconst c = 5;', new_str: '' });
  assert.equal(result.success, true);
  assert.equal((await contents()).endsWith('const dup = 4;'), true);
});

test('identical old_str and new_str is rejected as a no-op', async () => {
  const result = await edit({
    path: FILE,
    old_str: 'const a = 1;',
    new_str: 'const a = 1;',
  });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('identical'));
});

test('§6.4 a denied edit writes nothing', async () => {
  const result = await edit(
    { path: FILE, old_str: 'const a = 1;', new_str: 'HACKED' },
    denyAll(),
  );
  assert.equal(result.success, false);
  assert.equal(await contents(), ORIGINAL);
});

test('§6.5 success reports enough to confirm the edit landed', async () => {
  const result = await edit({
    path: FILE,
    old_str: 'const b = 3;',
    new_str: 'const b = 30;',
  });
  assert.ok(result.success);
  assert.match(result.content, /Replaced 1 occurrence/);
  assert.match(result.content, /line 3/);
  assert.match(result.content, /\d+ to \d+ characters/);
});

test('escaping the workspace is refused', async () => {
  const result = await edit({ path: '../evil.txt', old_str: 'a', new_str: 'b' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('outside the workspace'));
  assert.ok(!result.success && result.retryable === false);
});

test('an ordinary edit is a WRITE and carries a diff for the prompt', async () => {
  const { gate, seen } = spyGate(false);
  await edit({ path: FILE, old_str: 'const a = 1;', new_str: 'const a = 2;' }, gate);
  assert.equal(seen[0]?.operation, 'WRITE');
  assert.deepEqual(seen[0]?.diff, { before: 'const a = 1;', after: 'const a = 2;' });
});

test('editing a credential file escalates to DESTRUCTIVE', async () => {
  // DESTRUCTIVE is what stops a standing "always" for edit_file covering it.
  const { gate, seen } = spyGate(false);
  await edit({ path: '.env', old_str: 'a', new_str: 'b' }, gate);
  assert.equal(seen[0]?.operation, 'DESTRUCTIVE');
});

test('replace_all is surfaced in the approval prompt', async () => {
  const { gate, seen } = spyGate(false);
  await edit(
    { path: FILE, old_str: 'const dup', new_str: 'x', replace_all: true },
    gate,
  );
  assert.match(seen[0]?.detail ?? '', /all occurrences/);
});
