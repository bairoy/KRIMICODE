import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';

import { runCommand } from '../exec.js';
import { defineTool } from '../tools/define.js';
import type { ToolContext } from '../tools/define.js';
import { z } from 'zod';
import { spyGate } from './helpers.js';

const cwd = process.cwd();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countMatching(marker: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', `pgrep -f "sleep ${marker}" | wc -l`]);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('close', () => resolve(Number(out.trim())));
  });
}

// --- exec.ts ----------------------------------------------------------------

test('aborting kills the command and reports it as cancelled', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);

  const started = Date.now();
  const result = await runCommand('sleep 30', {
    cwd,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.success, false);
  // Distinct from a timeout: the caller needs to tell "you stopped this" from
  // "this took too long", and only one of those is worth retrying.
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - started < 10_000, 'the command was not actually killed');
});

test('CLAUDE.md: cancelling kills the process group, not just the shell', async () => {
  // The same guarantee the timeout path has. A cancelled `npm test` spawns
  // children; killing only the shell leaves them running with nothing left to
  // reap them, and the user believes they stopped it.
  const marker = `99${Date.now() % 100000}`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);

  await runCommand(`sleep ${marker} & sleep ${marker}`, {
    cwd,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  await wait(600); // let SIGTERM land
  assert.equal(await countMatching(marker), 0, 'orphaned processes survived');
});

test('a signal already aborted never spawns anything', async () => {
  // Starting a process only to kill it can still leave side effects behind.
  const marker = `98${Date.now() % 100000}`;
  const result = await runCommand(`sleep ${marker}`, {
    cwd,
    signal: AbortSignal.abort(),
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.durationMs, 0);
  assert.equal(await countMatching(marker), 0);
});

test('REGRESSION: listeners are detached when a command finishes', async () => {
  // One controller covers every command in a turn. Without cleanup, a long
  // session accumulates listeners on it until Node warns about a leak.
  const controller = new AbortController();
  for (let i = 0; i < 12; i++) {
    await runCommand('true', { cwd, signal: controller.signal });
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an uncancelled command is unaffected', async () => {
  const result = await runCommand('echo fine', {
    cwd,
    signal: new AbortController().signal,
  });
  assert.equal(result.cancelled, false);
  assert.equal(result.success, true);
  assert.equal(result.stdout.trim(), 'fine');
});

// --- the tool chokepoint ----------------------------------------------------

const probe = defineTool({
  name: 'probe',
  description: 'test tool',
  inputSchema: z.object({}),
  classify: () => ({ operation: 'EXECUTE', detail: 'probe' }),
  execute: async () => ({ success: true as const, content: 'ran' }),
});

test('a cancelled call is refused before the user is prompted', async () => {
  // Otherwise Ctrl-C leaves an approval prompt on screen asking permission for
  // work that has already been abandoned.
  const { gate, seen } = spyGate(true);
  const context: ToolContext = {
    workspaceRoot: cwd,
    signal: AbortSignal.abort(),
  };

  const result = await probe.run('{}', context, gate);

  assert.equal(result.success, false);
  assert.deepEqual(seen, [], 'the gate was consulted for a cancelled call');
  assert.match(result.success ? '' : result.error, /[Cc]ancelled/);
});

test('a cancelled call is not retryable', async () => {
  // Re-sending the same arguments will not un-cancel it.
  const { gate } = spyGate(true);
  const result = await probe.run(
    '{}',
    { workspaceRoot: cwd, signal: AbortSignal.abort() },
    gate,
  );
  assert.equal(result.success === false && result.retryable, false);
});

test('an unaborted context runs normally', async () => {
  const { gate, seen } = spyGate(true);
  const controller = new AbortController();
  const result = await probe.run(
    '{}',
    { workspaceRoot: cwd, signal: controller.signal },
    gate,
  );
  assert.equal(result.success, true);
  assert.equal(seen.length, 1);
});
