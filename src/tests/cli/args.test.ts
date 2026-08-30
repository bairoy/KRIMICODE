import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCliArgs, USAGE } from '../../cli/args.js';

test('no arguments means a fresh interactive session', () => {
  const args = parseCliArgs([]);

  assert.equal(args.continue, false);
  assert.equal(args.resume, undefined);
  assert.equal(args.list, false);
  assert.equal(args.help, false);
});

test('--continue and its short form are both accepted', () => {
  assert.equal(parseCliArgs(['--continue']).continue, true);
  assert.equal(parseCliArgs(['-c']).continue, true);
});

test('--resume takes an id in either form', () => {
  assert.equal(parseCliArgs(['--resume', 'abc123']).resume, 'abc123');
  assert.equal(parseCliArgs(['--resume=abc123']).resume, 'abc123');
  assert.equal(parseCliArgs(['-r', 'abc123']).resume, 'abc123');
});

test('an empty --resume is treated as absent', () => {
  // Otherwise this looks for a session literally named "", and the error
  // message is about the wrong thing.
  assert.equal(parseCliArgs(['--resume=']).resume, undefined);
});

test('--list and --help are recognised', () => {
  assert.equal(parseCliArgs(['--list']).list, true);
  assert.equal(parseCliArgs(['--help']).help, true);
  assert.equal(parseCliArgs(['-h']).help, true);
});

test('an unknown flag does not stop the agent from starting', () => {
  // Refusing to run over a typo is worse than ignoring it.
  assert.doesNotThrow(() => parseCliArgs(['--nonsense']));
  assert.equal(parseCliArgs(['--nonsense', '-c']).continue, true);
});

test('the usage text documents every flag', () => {
  for (const flag of ['--continue', '--resume', '--list', '--help']) {
    assert.match(USAGE, new RegExp(flag), `${flag} is undocumented`);
  }
});

test('the usage text never suggests putting a key on the command line', () => {
  // A key in argv is visible in `ps` to every user on the machine.
  assert.equal(/--(api-)?key/i.test(USAGE), false);
});
