import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../exec.js';
import { isWindows } from '../platform.js';

const cwd = process.cwd();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `sh` and `cmd.exe` share almost no syntax, so anything that needs to run on
 * both is expressed as a Node one-liner instead. Node is by definition present,
 * and this keeps these tests about our own collecting, capping, and killing
 * rather than about shell dialects.
 *
 * The outer quotes survive on Windows because `cmd /s /c` strips only the
 * first and last quote of the whole command line and takes the rest literally.
 */
const node = (script: string): string => `node -e "${script}"`;

const POSIX_ONLY = { skip: isWindows(process.platform) };

/** How many processes match this marker right now. POSIX-only. */
function countMatching(marker: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [
      '-c',
      `pgrep -f "sleep ${marker}" | wc -l`,
    ]);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('close', () => resolve(Number(out.trim())));
  });
}

test('stdout and stderr are captured separately', async () => {
  const result = await runCommand(
    node("process.stdout.write('out');process.stderr.write('err')"),
    { cwd },
  );
  assert.equal(result.success, true);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('the command really goes through a shell', async () => {
  // `&&` is one of the few operators sh and cmd agree on. Without a shell it
  // would be passed to the program as a literal argument.
  const result = await runCommand('echo first && echo second', { cwd });
  assert.equal(result.success, true);
  assert.match(result.stdout, /first/);
  assert.match(result.stdout, /second/);
});

test('a non-zero exit is a result, not an exception', async () => {
  const result = await runCommand(node('process.exit(42)'), { cwd });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 42);
  assert.equal(result.timedOut, false);
});

test('a failure to spawn is reported, not thrown', async () => {
  const result = await runCommand('echo hi', {
    cwd: isWindows(process.platform) ? 'Z:\\no\\such\\dir' : '/no/such/dir',
  });
  assert.equal(result.success, false);
  assert.ok(result.stderr.length > 0);
});

test('duration is recorded', async () => {
  const result = await runCommand(node('setTimeout(()=>{},250)'), { cwd });
  assert.ok(result.durationMs >= 150, `got ${result.durationMs}ms`);
});

test('output is capped while the command runs, bounding memory', async () => {
  // Capping as output arrives, rather than truncating at the end, is what
  // stops a runaway command exhausting memory before it can be killed.
  const result = await runCommand(
    node("process.stdout.write('x'.repeat(400000))"),
    { cwd, maxOutputChars: 1_000 },
  );
  assert.ok(result.stdout.length < 1_200, `got ${result.stdout.length}`);
  assert.match(result.stdout, /\[\.\.\. \d+ more characters dropped \.\.\.\]/);
});

test('a shell pipeline is collected correctly', POSIX_ONLY, async () => {
  // Pipes exist in both shells but `yes`/`head` do not, and the point here is
  // that a real pipeline's output reaches the collector.
  const result = await runCommand('yes hello | head -c 400000', {
    cwd,
    maxOutputChars: 1_000,
  });
  assert.ok(result.stdout.length < 1_200, `got ${result.stdout.length}`);
});

test('output below the cap has no dropped marker', async () => {
  const result = await runCommand('echo small', { cwd, maxOutputChars: 1_000 });
  assert.equal(result.stdout.includes('dropped'), false);
});

test('secret-shaped env vars are stripped from the child', async () => {
  // Without this, `env` or `echo $OPENAI_API_KEY` would put the key straight
  // into model context. Read through Node rather than shell expansion, since
  // `$VAR` and `%VAR%` are not the same language.
  process.env['TEST_FAKE_API_KEY'] = 'sk-should-not-be-visible';
  process.env['TEST_HARMLESS_VALUE'] = 'visible';
  try {
    const result = await runCommand(
      node(
        "process.stdout.write('key=['+(process.env.TEST_FAKE_API_KEY||'')+']" +
          "ok=['+(process.env.TEST_HARMLESS_VALUE||'')+']')",
      ),
      { cwd },
    );
    assert.match(result.stdout, /key=\[\]/, 'secret-shaped var must be absent');
    assert.match(
      result.stdout,
      /ok=\[visible\]/,
      'ordinary vars still pass through',
    );
  } finally {
    delete process.env['TEST_FAKE_API_KEY'];
    delete process.env['TEST_HARMLESS_VALUE'];
  }
});

test('a command that overruns its timeout is killed and reported', async () => {
  const result = await runCommand(node('setTimeout(()=>{},30000)'), {
    cwd,
    timeoutMs: 800,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
  assert.ok(result.durationMs < 5_000, `took ${result.durationMs}ms`);
});

test(
  'CLAUDE.md: the whole process group dies, not just the shell',
  POSIX_ONLY,
  async () => {
    // `sh -c "sleep N & sleep N"` leaves grandchildren behind if only the shell
    // is signalled. detached:true plus kill(-pid) is what prevents the orphans.
    // Windows reaches the same end through `taskkill /T`, which has no
    // process-group concept and so cannot be checked this way.
    const marker = '31421';
    assert.equal(
      await countMatching(marker),
      0,
      'stale processes from a previous run',
    );

    const result = await runCommand(`sleep ${marker} & sleep ${marker}`, {
      cwd,
      timeoutMs: 1_000,
    });
    assert.equal(result.timedOut, true);

    await wait(800); // let SIGTERM land
    assert.equal(
      await countMatching(marker),
      0,
      'orphaned grandchildren survived',
    );
  },
);
