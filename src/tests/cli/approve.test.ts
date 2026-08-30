import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApprovalPrompt } from '../../cli/approve.js';
import type { ApprovalTerminal } from '../../cli/approve.js';
import type { PermissionRequest } from '../../permissions.js';

/**
 * Until the prompt was lifted out of `index.ts` none of this could be tested:
 * `main()` runs on import, so nothing inside it was reachable from a test
 * runner. It is the last human check before a write or a shell command, which
 * makes it the worst thing in the program to have had no coverage.
 */
function fakeTerminal(
  answer: string | Error,
): ApprovalTerminal & { output: () => string; prompts: () => string[] } {
  const written: string[] = [];
  const prompts: string[] = [];

  return {
    ask: async (prompt) => {
      prompts.push(prompt);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    write: (text) => {
      written.push(text);
    },
    output: () => written.join(''),
    prompts: () => prompts,
  };
}

const write: PermissionRequest = {
  toolName: 'edit_file',
  operation: 'WRITE',
  detail: 'src/app.ts',
};

const destructive: PermissionRequest = {
  toolName: 'run_command',
  operation: 'DESTRUCTIVE',
  detail: 'rm -rf build',
};

test('yes approves the call once', async () => {
  for (const answer of ['y', 'yes', 'Y', '  YES  ']) {
    const ask = createApprovalPrompt(fakeTerminal(answer));
    assert.equal(await ask(write), 'once', `"${answer}" should approve`);
  }
});

test('always is accepted for an ordinary write', async () => {
  for (const answer of ['a', 'always', 'ALWAYS']) {
    const ask = createApprovalPrompt(fakeTerminal(answer));
    assert.equal(await ask(write), 'always', `"${answer}" should stand`);
  }
});

test('SECURITY: anything that is not a yes is a refusal', async () => {
  // The default has to be "no". A prompt that approves on anything unexpected
  // turns a stray keystroke into a write.
  for (const answer of ['n', 'no', '', ' ', 'maybe', 'Y E S', '\n', 'ok']) {
    const ask = createApprovalPrompt(fakeTerminal(answer));
    assert.equal(await ask(write), 'no', `"${answer}" must not approve`);
  }
});

test('SECURITY: a destructive call can never be approved for always', async () => {
  // The gate refuses to remember a destructive approval, so offering one here
  // would be a promise the rest of the program does not keep.
  for (const answer of ['a', 'always']) {
    const ask = createApprovalPrompt(fakeTerminal(answer));
    assert.equal(await ask(destructive), 'no');
  }
});

test('a destructive call is still approvable once', async () => {
  const ask = createApprovalPrompt(fakeTerminal('y'));

  assert.equal(await ask(destructive), 'once');
});

test('the destructive prompt does not offer always', async () => {
  const terminal = fakeTerminal('n');
  await createApprovalPrompt(terminal)(destructive);

  assert.doesNotMatch(terminal.prompts().join(''), /lways/);
});

test('an ordinary prompt does offer always', async () => {
  const terminal = fakeTerminal('n');
  await createApprovalPrompt(terminal)(write);

  assert.match(terminal.prompts().join(''), /lways/);
});

test('SECURITY: a closed or cancelled prompt refuses', async () => {
  // Piped input runs out, or Ctrl-C aborts the question. Neither may be read
  // as consent — that is what would let a non-interactive run auto-approve
  // itself into writing files.
  const ask = createApprovalPrompt(fakeTerminal(new Error('stdin closed')));

  assert.equal(await ask(write), 'no');
});

test('the request is shown before the question is asked', async () => {
  const terminal = fakeTerminal('n');
  await createApprovalPrompt(terminal)(write);

  const shown = terminal.output();
  assert.match(shown, /edit_file/, 'the tool should be named');
  assert.match(shown, /src\/app\.ts/, 'the target should be shown');
  assert.match(shown, /write file/, 'the operation should be in words');
});

test('a diff is rendered when the request carries one', async () => {
  const terminal = fakeTerminal('n');
  await createApprovalPrompt(terminal)({
    ...write,
    diff: { before: 'const a = 1;\n', after: 'const a = 2;\n' },
  });

  const shown = terminal.output();
  assert.match(shown, /const a = 1;/);
  assert.match(shown, /const a = 2;/);
});
