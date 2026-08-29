import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commandNames, handleCommand } from '../commands.js';
import type { CommandContext } from '../commands.js';

/** A context that records everything the commands did, with no terminal. */
function fakeContext(overrides: Partial<CommandContext> = {}) {
  const output: string[] = [];
  let model = 'test-model';
  let cleared = 0;

  const context: CommandContext = {
    write: (text) => output.push(text),
    getModel: () => model,
    setModel: (name) => {
      model = name;
    },
    clear: () => {
      cleared++;
    },
    listTools: () => [
      { name: 'read_file', description: 'Read a file. More detail here.' },
    ],
    listSessions: async () => [],
    ...overrides,
  };

  return {
    context,
    text: () => output.join(''),
    model: () => model,
    cleared: () => cleared,
  };
}

test('ordinary text is not treated as a command', async () => {
  const { context, text } = fakeContext();

  assert.equal(
    await handleCommand('what does agent.ts do?', context),
    'not-a-command',
  );
  assert.equal(text(), '', 'nothing should have been printed');
});

test('/exit ends the session', async () => {
  const { context } = fakeContext();

  assert.equal(await handleCommand('/exit', context), 'exit');
});

test('/help lists every command', async () => {
  const { context, text } = fakeContext();

  assert.equal(await handleCommand('/help', context), 'handled');
  for (const name of commandNames()) {
    assert.match(text(), new RegExp(name), `${name} missing from /help`);
  }
});

test('/clear forgets the conversation', async () => {
  const { context, cleared } = fakeContext();

  assert.equal(await handleCommand('/clear', context), 'handled');
  assert.equal(cleared(), 1);
});

test('/model with no argument reports the current model', async () => {
  const { context, text, model } = fakeContext();

  await handleCommand('/model', context);

  assert.match(text(), /test-model/);
  assert.equal(model(), 'test-model', 'reporting must not change anything');
});

test('/model with an argument switches model', async () => {
  const { context, model } = fakeContext();

  await handleCommand('/model other-model', context);

  assert.equal(model(), 'other-model');
});

test('/tools lists the registered tools', async () => {
  const { context, text } = fakeContext();

  await handleCommand('/tools', context);

  assert.match(text(), /read_file/);
});

test('/sessions says so when there are none', async () => {
  const { context, text } = fakeContext();

  assert.equal(await handleCommand('/sessions', context), 'handled');
  assert.match(text(), /no saved sessions/);
});

test('/sessions lists what it is given', async () => {
  const { context, text } = fakeContext({
    listSessions: async () => ['abc123  2 hours ago  fix the parser'],
  });

  await handleCommand('/sessions', context);

  assert.match(text(), /fix the parser/);
});

test('an unknown command is answered locally, not sent to the model', async () => {
  // Before the dispatcher existed, anything other than /exit went to the model
  // as a prompt, which wasted a request and produced a confused answer.
  const { context, text } = fakeContext();

  assert.equal(await handleCommand('/helo', context), 'handled');
  assert.match(text(), /unknown command/);
});

test('a path is not mistaken for a command', async () => {
  // "/usr/lib" and "/etc/hosts" are things a user genuinely asks about.
  for (const line of ['/usr/lib/node', '/etc/hosts', '/README.md']) {
    assert.equal(
      await handleCommand(line, fakeContext().context),
      'not-a-command',
      `"${line}" should have gone to the model`,
    );
  }
});

test('commands are recognised regardless of case and spacing', async () => {
  const { context, model } = fakeContext();

  await handleCommand('  /MODEL   spaced-model  ', context);

  assert.equal(model(), 'spaced-model');
});
