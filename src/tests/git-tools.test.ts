import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProgram } from '../exec.js';
import { gitDiffTool } from '../tools/git_diff.js';
import { gitStatusTool } from '../tools/git_status.js';
import { runTestsTool } from '../tools/run_tests.js';
import { allowAll, denyAll, spyGate } from './helpers.js';

let repo = '';
let bare = '';

const git = (args: string[], cwd: string) => runProgram('git', args, { cwd });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'krimi-git-'));
  bare = await mkdtemp(join(tmpdir(), 'krimi-nogit-'));

  await git(['init', '-q'], repo);
  await git(['config', 'user.email', 'test@example.invalid'], repo);
  await git(['config', 'user.name', 'Test'], repo);

  await writeFile(join(repo, 'tracked.txt'), 'original\n', 'utf8');
  await git(['add', '.'], repo);
  await git(['commit', '-q', '-m', 'initial'], repo);
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

const status = (cwd = repo) =>
  gitStatusTool.run('{}', { workspaceRoot: cwd }, allowAll());

const diff = (args: Record<string, unknown> = {}, cwd = repo) =>
  gitDiffTool.run(JSON.stringify(args), { workspaceRoot: cwd }, allowAll());

test('git_status reports a clean tree', async () => {
  const result = await status();
  assert.ok(result.success, result.success ? '' : result.error);
  assert.ok(result.success && result.content.includes('Working tree clean'));
});

test('git_status shows modified and untracked files', async () => {
  await writeFile(join(repo, 'tracked.txt'), 'changed\n', 'utf8');
  await writeFile(join(repo, 'fresh.txt'), 'new\n', 'utf8');

  const result = await status();
  assert.ok(result.success);
  assert.match(result.content, / M tracked\.txt/);
  assert.match(result.content, /\?\? fresh\.txt/);
  assert.match(result.content, /untracked/, 'legend explains the codes');
});

test('git_status fails clearly outside a repository', async () => {
  const result = await status(bare);
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('Not a git repository'));
  assert.ok(!result.success && result.retryable === false);
});

test('git_diff shows unstaged changes', async () => {
  const result = await diff();
  assert.ok(result.success, result.success ? '' : result.error);
  assert.match(result.content, /-original/);
  assert.match(result.content, /\+changed/);
});

test('git_diff distinguishes staged from unstaged', async () => {
  await git(['add', 'tracked.txt'], repo);

  const unstaged = await diff();
  assert.ok(
    unstaged.success && unstaged.content.includes('No unstaged changes'),
  );

  const staged = await diff({ staged: true });
  assert.ok(staged.success && staged.content.includes('+changed'));

  await git(['reset', '-q'], repo);
});

test('git_diff can be limited to one path', async () => {
  await writeFile(join(repo, 'second.txt'), 'x\n', 'utf8');
  await git(['add', 'second.txt'], repo);
  await git(['commit', '-q', '-m', 'second'], repo);
  await writeFile(join(repo, 'second.txt'), 'y\n', 'utf8');

  const scoped = await diff({ path: 'second.txt' });
  assert.ok(scoped.success);
  assert.match(scoped.content, /second\.txt/);
  assert.doesNotMatch(scoped.content, /tracked\.txt/);
});

test('git_diff reports "no changes" as success, not failure', async () => {
  const result = await diff({ path: 'tracked.txt', staged: true });
  assert.equal(result.success, true);
  assert.ok(result.success && result.content.includes('No staged changes'));
});

test('git_diff refuses a path outside the workspace', async () => {
  const result = await diff({ path: '../../etc' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('outside the workspace'));
});

test('git_diff fails clearly outside a repository', async () => {
  const result = await diff({}, bare);
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('Not a git repository'));
});

test('the git read tools do not prompt', async () => {
  const statusSpy = spyGate();
  await gitStatusTool.run('{}', { workspaceRoot: repo }, statusSpy.gate);
  assert.equal(statusSpy.seen[0]?.operation, 'READ');

  const diffSpy = spyGate();
  await gitDiffTool.run('{}', { workspaceRoot: repo }, diffSpy.gate);
  assert.equal(diffSpy.seen[0]?.operation, 'READ');
});

test('run_tests is EXECUTE and passes through the gate', async () => {
  const { gate, seen } = spyGate(false);
  const result = await runTestsTool.run('{}', { workspaceRoot: repo }, gate);
  assert.equal(seen[0]?.operation, 'EXECUTE');
  assert.equal(result.success, false, 'denied, so it must not run');
});

test('run_tests never executes when denied', async () => {
  const result = await runTestsTool.run(
    '{}',
    { workspaceRoot: repo },
    denyAll(),
  );
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.startsWith('Denied by the user'));
});

test('run_tests explains itself when the project has no test script', async () => {
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }),
    'utf8',
  );
  const result = await runTestsTool.run(
    '{}',
    { workspaceRoot: repo },
    allowAll(),
  );
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('No "test" script'));
});

test('run_tests handles a missing or malformed package.json', async () => {
  const missing = await runTestsTool.run(
    '{}',
    { workspaceRoot: bare },
    allowAll(),
  );
  assert.equal(missing.success, false);
  assert.ok(!missing.success && missing.error.includes('No "test" script'));

  await writeFile(join(repo, 'package.json'), '{not json', 'utf8');
  const malformed = await runTestsTool.run(
    '{}',
    { workspaceRoot: repo },
    allowAll(),
  );
  assert.equal(malformed.success, false);
  assert.ok(!malformed.success && malformed.error.includes('No "test" script'));
});
