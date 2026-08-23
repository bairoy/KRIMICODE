import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runCommand } from '../exec.js';

const cwd = process.cwd();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many processes match this marker right now. */
function countMatching(marker: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', `pgrep -f "sleep ${marker}" | wc -l`]);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('close', () => resolve(Number(out.trim())));
  });
}

test('stdout and stderr are captured separately', async () => {
  const result = await runCommand('echo out && echo err >&2', { cwd });
  assert.equal(result.success, true);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('a non-zero exit is a result, not an exception', async () => {
  const result = await runCommand('exit 42', { cwd });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 42);
  assert.equal(result.timedOut, false);
});

test('a failure to spawn is reported, not thrown', async () => {
  const result = await runCommand('echo hi', { cwd: '/no/such/directory' });
  assert.equal(result.success, false);
  assert.ok(result.stderr.length > 0);
});

test('duration is recorded', async () => {
  const result = await runCommand('sleep 0.2', { cwd });
  assert.ok(result.durationMs >= 150, `got ${result.durationMs}ms`);
});

test('output is capped while the command runs, bounding memory', async () => {
  const result = await runCommand('yes hello | head -c 400000', {
    cwd,
    maxOutputChars: 1_000,
  });
  assert.ok(result.stdout.length < 1_200, `got ${result.stdout.length}`);
  assert.match(result.stdout, /\[\.\.\. \d+ more characters dropped \.\.\.\]/);
});

test('output below the cap has no dropped marker', async () => {
  const result = await runCommand('echo small', { cwd, maxOutputChars: 1_000 });
  assert.equal(result.stdout.includes('dropped'), false);
});

test('secret-shaped env vars are stripped from the child', async () => {
  // Without this, `env` or `echo $OPENAI_API_KEY` would put the key straight
  // into model context.
  process.env['TEST_FAKE_API_KEY'] = 'sk-should-not-be-visible';
  process.env['TEST_HARMLESS_VALUE'] = 'visible';
  try {
    const result = await runCommand(
      'echo "key=[$TEST_FAKE_API_KEY]" ; echo "ok=[$TEST_HARMLESS_VALUE]"',
      { cwd },
    );
    assert.match(result.stdout, /key=\[\]/, 'secret-shaped var must be absent');
    assert.match(result.stdout, /ok=\[visible\]/, 'ordinary vars still pass through');
  } finally {
    delete process.env['TEST_FAKE_API_KEY'];
    delete process.env['TEST_HARMLESS_VALUE'];
  }
});

test('a command that overruns its timeout is killed and reported', async () => {
  const result = await runCommand('sleep 30', { cwd, timeoutMs: 800 });
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
  assert.ok(result.durationMs < 5_000, `took ${result.durationMs}ms`);
});

test('CLAUDE.md: the whole process group dies, not just the shell', async () => {
  // `sh -c "sleep N & sleep N"` leaves grandchildren behind if only the shell
  // is signalled. detached:true plus kill(-pid) is what prevents the orphans.
  const marker = '31421';
  assert.equal(await countMatching(marker), 0, 'stale processes from a previous run');

  const result = await runCommand(`sleep ${marker} & sleep ${marker}`, {
    cwd,
    timeoutMs: 1_000,
  });
  assert.equal(result.timedOut, true);

  await wait(800); // let SIGTERM land
  assert.equal(await countMatching(marker), 0, 'orphaned grandchildren survived');
});
