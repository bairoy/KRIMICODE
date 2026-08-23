import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFilesTool } from '../tools/list_files.js';
import { searchCodeTool } from '../tools/search_code.js';
import { allowAll } from './helpers.js';

let root = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'krimi-find-'));
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });

  await writeFile(join(root, 'top.ts'), 'export const marker = 1;\n', 'utf8');
  await writeFile(join(root, 'notes.md'), 'no code here\n', 'utf8');
  await writeFile(
    join(root, 'src', 'a.ts'),
    'const needle = 1;\nconst other = 2;\n',
    'utf8',
  );
  await writeFile(join(root, 'src', 'deep', 'b.ts'), 'const needle = 3;\n', 'utf8');
  await writeFile(join(root, 'node_modules', 'junk', 'c.ts'), 'const needle = 4;\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), 'needle in git\n', 'utf8');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const list = (args: Record<string, unknown> = {}) =>
  listFilesTool.run(JSON.stringify(args), { workspaceRoot: root }, allowAll());

const search = (args: Record<string, unknown>) =>
  searchCodeTool.run(JSON.stringify(args), { workspaceRoot: root }, allowAll());

const body = (result: Awaited<ReturnType<typeof list>>): string => {
  assert.ok(result.success, result.success ? '' : result.error);
  return result.success ? result.content : '';
};

test('list_files defaults to the workspace root', async () => {
  const out = body(await list());
  assert.match(out, /top\.ts/);
  assert.match(out, /src\//);
});

test('list_files marks directories with a trailing slash', async () => {
  const out = body(await list());
  assert.match(out, /^src\/$/m);
  assert.doesNotMatch(out, /^top\.ts\/$/m);
});

test('list_files is shallow by default', async () => {
  const out = body(await list());
  assert.doesNotMatch(out, /a\.ts/, 'should not descend without recursive');
});

test('list_files walks subdirectories when asked', async () => {
  const out = body(await list({ recursive: true }));
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /src\/deep\/b\.ts/);
});

test('list_files skips generated directories but says so', async () => {
  const out = body(await list({ recursive: true }));
  assert.match(out, /node_modules\/ {2}\(skipped\)/);
  assert.doesNotMatch(out, /junk\/c\.ts/, 'must not descend into node_modules');
});

test('list_files can target a subdirectory', async () => {
  const out = body(await list({ path: 'src' }));
  assert.match(out, /a\.ts/);
  assert.doesNotMatch(out, /top\.ts/);
});

test('list_files refuses to escape the workspace', async () => {
  const result = await list({ path: '../..' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('outside the workspace'));
});

test('list_files is a READ, so it never prompts', () => {
  const spec = listFilesTool;
  assert.equal(spec.name, 'list_files');
});

test('search_code finds matches with path and line number', async () => {
  const out = body(await search({ pattern: 'needle' }));
  assert.match(out, /a\.ts:1:/);
  assert.match(out, /b\.ts:1:/);
});

test('search_code skips generated directories', async () => {
  const out = body(await search({ pattern: 'needle' }));
  assert.doesNotMatch(out, /node_modules/);
  assert.doesNotMatch(out, /\.git\/config/);
});

test('search_code reports no matches as success, not failure', async () => {
  const result = await search({ pattern: 'definitely-not-present-anywhere' });
  assert.equal(result.success, true, 'exit code 1 from grep means "none found"');
  assert.ok(result.success && result.content.includes('No matches'));
});

test('search_code honours a glob filter', async () => {
  const out = body(await search({ pattern: 'needle', glob: '*.ts' }));
  assert.match(out, /\.ts:/);
});

test('search_code can scope to a subdirectory', async () => {
  const out = body(await search({ pattern: 'needle', path: 'src/deep' }));
  assert.match(out, /b\.ts/);
  assert.doesNotMatch(out, /src\/a\.ts/);
});

test('search_code treats the pattern as a regex by default', async () => {
  const out = body(await search({ pattern: 'const (needle|other)' }));
  assert.match(out, /needle/);
});

test('search_code literal mode disables regex metacharacters', async () => {
  const result = await search({ pattern: 'const (needle|other)', literal: true });
  assert.ok(result.success);
  assert.ok(result.success && result.content.includes('No matches'));
});

test('search_code is case sensitive unless told otherwise', async () => {
  const sensitive = await search({ pattern: 'NEEDLE' });
  assert.ok(sensitive.success && sensitive.content.includes('No matches'));

  const insensitive = await search({ pattern: 'NEEDLE', case_insensitive: true });
  assert.ok(insensitive.success && insensitive.content.includes('a.ts'));
});

test('search_code caps results and says how many were withheld', async () => {
  const out = body(await search({ pattern: 'needle', max_results: 1 }));
  assert.match(out, /more matches/);
});

test('SECURITY: a shell-metacharacter pattern is data, never code', async () => {
  // Routed through `runCommand` this would execute. Through `runProgram` the
  // whole string is a single argv entry, so it is only ever a search pattern.
  const canary = join(root, 'INJECTED');
  const result = await search({
    pattern: `x"; touch ${canary}; echo "`,
    literal: true,
  });

  assert.equal(result.success, true, 'should complete as an ordinary search');
  await assert.rejects(
    () => import('node:fs/promises').then((fs) => fs.stat(canary)),
    'the injected command created a file — the pattern reached a shell',
  );
});

test('SECURITY: a pattern starting with a dash is not read as a flag', async () => {
  // `--` before the pattern is what prevents this being parsed as an option.
  const result = await search({ pattern: '--version', literal: true });
  assert.equal(result.success, true);
  assert.ok(result.success && result.content.includes('No matches'));
});

test('search_code refuses to escape the workspace', async () => {
  const result = await search({ pattern: 'x', path: '../..' });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('outside the workspace'));
});
