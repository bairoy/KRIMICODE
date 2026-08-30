import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from '../../tools/edit_file.js';
import { allowAll, denyAll, spyGate } from '../helpers.js';

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
  const result = await edit({
    path: FILE,
    old_str: 'const zzz = 9;',
    new_str: 'x',
  });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.retryable, 'model can re-read and retry');
  assert.equal(await contents(), ORIGINAL);
});

test('§6.2 more than one match fails rather than picking the first', async () => {
  const result = await edit({
    path: FILE,
    old_str: 'const dup',
    new_str: 'changed',
  });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('2 times'));
  assert.ok(!result.success && result.retryable);
  assert.equal(
    await contents(),
    ORIGINAL,
    'nothing may be written on ambiguity',
  );
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
  assert.equal(
    await contents(),
    ORIGINAL.replace('const b = 3;', 'const b = 30;'),
  );
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
  const result = await edit({
    path: FILE,
    old_str: '\nconst c = 5;',
    new_str: '',
  });
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
  const result = await edit({
    path: '../evil.txt',
    old_str: 'a',
    new_str: 'b',
  });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('outside the workspace'));
  assert.ok(!result.success && result.retryable === false);
});

test('an ordinary edit is a WRITE and carries a diff for the prompt', async () => {
  const { gate, seen } = spyGate(false);
  await edit(
    { path: FILE, old_str: 'const a = 1;', new_str: 'const a = 2;' },
    gate,
  );
  assert.equal(seen[0]?.operation, 'WRITE');
  assert.deepEqual(seen[0]?.diff, {
    before: 'const a = 1;',
    after: 'const a = 2;',
  });
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

// --- the redaction dead end -------------------------------------------------

test('REGRESSION: a redacted placeholder in old_str fails unretryably', async () => {
  // Found in manual testing. read_file redacts secrets on the way out, so the
  // model only ever sees "SECRET_TOKEN=[REDACTED]". It copies that back into
  // old_str in good faith, no match is possible, and the generic "copy the
  // text verbatim" advice tells it to do exactly what it already did. It
  // reissued the identical call 22 times before running out of turns.
  await writeFile(
    join(root, 'creds.env'),
    'SECRET_TOKEN=sk-real-value-here-1234567890\n',
    'utf8',
  );

  const result = await edit({
    path: 'creds.env',
    old_str: 'SECRET_TOKEN=[REDACTED]',
    new_str: 'SECRET_TOKEN=xyz',
  });

  assert.equal(result.success, false);
  assert.equal(
    result.success === false && result.retryable,
    false,
    'a retryable failure here is what caused the loop',
  );
  assert.match(
    result.success ? '' : result.error,
    /placeholder/i,
    'the error must explain why no retry can work',
  );
});

test('a placeholder anywhere in old_str is caught, not just alone', async () => {
  await writeFile(
    join(root, 'mixed.ts'),
    'const key = "sk-real-value-here-1234567890";\nconst other = 1;\n',
    'utf8',
  );

  const result = await edit({
    path: 'mixed.ts',
    old_str: 'const key = "[REDACTED]";\nconst other = 1;',
    new_str: 'const other = 1;',
  });

  assert.equal(result.success, false);
  assert.match(result.success ? '' : result.error, /placeholder/i);
});

test('an ordinary missing old_str is still reported as retryable', async () => {
  // The placeholder check must not swallow the normal near-miss case, where
  // re-reading and trying again is genuinely the right move.
  const result = await edit({
    path: FILE,
    old_str: 'const nowhere = 99;',
    new_str: 'x',
  });

  assert.equal(result.success, false);
  assert.equal(result.success === false && result.retryable, true);
  assert.match(result.success ? '' : result.error, /was not found/);
});

// --- never prompt for an edit that cannot happen ----------------------------

test('SECURITY: a missing file is refused before the user is prompted', async () => {
  // Found in manual testing. Asking to edit a nonexistent file still showed a
  // full approval prompt with a diff, the user said yes, and only then did it
  // fail. Approving changes that cannot happen is how people learn to press y
  // without reading.
  const { gate, seen } = spyGate(true);

  const result = await edit(
    { path: 'no-such-file.ts', old_str: 'a', new_str: 'b' },
    gate,
  );

  assert.equal(result.success, false);
  assert.deepEqual(seen, [], 'the user was prompted for an impossible edit');
});

test('SECURITY: an unmatched old_str is refused before the user is prompted', async () => {
  // The diff in the prompt is built from the model's own old_str/new_str, so
  // for text that appears nowhere in the file the user was shown — and
  // approved — a change that was pure fiction.
  const { gate, seen } = spyGate(true);

  const result = await edit(
    { path: FILE, old_str: 'i love you', new_str: 'I love you' },
    gate,
  );

  assert.equal(result.success, false);
  assert.deepEqual(seen, [], 'the user approved a diff that could not apply');
});

test('an ambiguous old_str is refused before the user is prompted', async () => {
  const { gate, seen } = spyGate(true);

  const result = await edit(
    { path: FILE, old_str: 'const dup', new_str: 'const x' },
    gate,
  );

  assert.equal(result.success, false);
  assert.match(result.success ? '' : result.error, /appears 2 times/);
  assert.deepEqual(seen, []);
});

test('an edit that CAN happen is still gated', async () => {
  // The precheck must not become a way around the permission gate.
  const { gate, seen } = spyGate(true);

  const result = await edit(
    { path: FILE, old_str: 'const a = 1;', new_str: 'const a = 2;' },
    gate,
  );

  assert.equal(result.success, true);
  assert.equal(seen.length, 1, 'a real edit must still be approved');
  assert.equal(seen[0]?.operation, 'WRITE');
});

test('a denied edit still changes nothing', async () => {
  const before = await readFile(join(root, FILE), 'utf8');

  const result = await edit(
    { path: FILE, old_str: 'const a = 1;', new_str: 'const a = 2;' },
    denyAll(),
  );

  assert.equal(result.success, false);
  assert.equal(await readFile(join(root, FILE), 'utf8'), before);
});

test('SECURITY: a credential file is not read before approval', async () => {
  // precheck opens the file to check old_str. For a DESTRUCTIVE target that
  // would mean reading a secret before the human has agreed to anything, so
  // the precheck deliberately stands aside and lets the gate go first.
  await writeFile(join(root, '.env'), 'SECRET_TOKEN=abc\n', 'utf8');
  const { gate, seen } = spyGate(false); // user says no

  const result = await edit(
    { path: '.env', old_str: 'nothing-that-matches', new_str: 'x' },
    gate,
  );

  assert.equal(result.success, false);
  assert.equal(seen.length, 1, 'the gate must decide first for a secret');
  assert.equal(seen[0]?.operation, 'DESTRUCTIVE');
});

test('SECURITY: a workspace escape is refused without prompting', async () => {
  // The README claims escapes are "refused outright rather than prompted for".
  // That was untrue until precheck existed: resolveInWorkspace ran inside
  // execute(), so the user was asked to approve "../evil.txt" and only then
  // was it refused. The refusal held, but the human was made complicit in a
  // decision that should never have reached them.
  const { gate, seen } = spyGate(true);

  const result = await edit(
    { path: '../evil.txt', old_str: 'a', new_str: 'b' },
    gate,
  );

  assert.equal(result.success, false);
  assert.deepEqual(seen, [], 'the user was prompted about an escape attempt');
});
