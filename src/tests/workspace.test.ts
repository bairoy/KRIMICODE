import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  isSensitivePath,
  resolveInWorkspace,
  WorkspaceError,
} from '../workspace.js';

let root = '';
let sibling = '';

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'krimi-ws-'));
  root = join(base, 'project');
  // Named to start with the root's own name — this is the case a naive
  // startsWith() check gets wrong.
  sibling = join(base, 'project-secrets');

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'inside', 'utf8');
  await writeFile(join(sibling, 'keys.txt'), 'outside', 'utf8');
  await symlink(join(sibling, 'keys.txt'), join(root, 'innocent.txt'));
  await symlink(sibling, join(root, 'linkdir'));
});

after(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

const refuses = async (input: string): Promise<void> => {
  await assert.rejects(
    () => resolveInWorkspace(root, input),
    (err: unknown) => err instanceof WorkspaceError,
    `expected "${input}" to be refused`,
  );
};

test('a normal relative path inside the workspace resolves', async () => {
  const resolved = await resolveInWorkspace(root, 'src/a.ts');
  assert.ok(resolved.startsWith(root + sep));
});

test('the workspace root itself is allowed', async () => {
  await resolveInWorkspace(root, '.');
});

test('relative traversal is refused', async () => {
  await refuses('../../etc/passwd');
  await refuses('src/../../../etc/passwd');
});

test('absolute paths outside the workspace are refused', async () => {
  await refuses('/etc/passwd');
});

test('a symlink pointing outside is refused despite an innocent name', async () => {
  await refuses('innocent.txt');
});

test('a symlinked directory cannot smuggle a path out', async () => {
  await refuses('linkdir/keys.txt');
});

test('a path that does not exist yet is still checked via its parent', async () => {
  // Nothing at this path, but the parent is a symlink out of the workspace.
  await refuses('linkdir/not-created-yet.txt');
  // Whereas a non-existent path inside the workspace is fine.
  await resolveInWorkspace(root, 'src/new-file.ts');
});

test('REGRESSION: a sibling directory sharing the root name prefix is refused', async () => {
  // "/tmp/x/project-secrets/keys.txt".startsWith("/tmp/x/project") is true.
  // Only appending the path separator makes this check correct.
  await refuses(join(sibling, 'keys.txt'));
});

test('credential-shaped filenames are flagged', () => {
  for (const name of [
    '.env',
    '.env.local',
    '.ENV.production',
    '.npmrc',
    '.netrc',
    '.git-credentials',
    'id_rsa',
    'id_ed25519',
    'credentials',
    'server.pem',
    'private.key',
    'store.p12',
  ]) {
    assert.equal(isSensitivePath(`/a/b/${name}`), true, name);
  }
});

test('ordinary filenames are not flagged', () => {
  for (const name of [
    'environment.ts',
    'env.ts',
    'keyboard.ts',
    'credentials.md',
    'README.md',
    'index.ts',
  ]) {
    assert.equal(isSensitivePath(`/a/b/${name}`), false, name);
  }
});

test('sensitivity is judged on the basename, not the whole path', () => {
  assert.equal(isSensitivePath('/home/.env/notes.txt'), false);
  assert.equal(isSensitivePath('/home/notes/.env'), true);
});
