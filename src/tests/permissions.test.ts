import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  PermissionGate,
  type OperationClass,
  type PermissionRequest,
  type UserAnswer,
} from '../permissions.js';

/** An AskUser that replays scripted answers and counts how often it was asked. */
function scripted(answers: UserAnswer[]) {
  let index = 0;
  const state = { asked: 0, seen: [] as PermissionRequest[] };
  const ask = async (request: PermissionRequest): Promise<UserAnswer> => {
    state.asked++;
    state.seen.push(request);
    return answers[index++] ?? 'no';
  };
  return { ask, state };
}

const request = (
  operation: OperationClass,
  toolName = 'tool',
): PermissionRequest => ({ toolName, operation, detail: 'x' });

test('only plain reads run unattended', () => {
  assert.equal(classify('READ'), 'allow');
  for (const op of [
    'READ_SENSITIVE',
    'WRITE',
    'EXECUTE',
    'DESTRUCTIVE',
    'GIT_STATE_CHANGE',
  ] as const) {
    assert.equal(classify(op), 'ask', op);
  }
});

test('READ never reaches the prompt', async () => {
  const { ask, state } = scripted([]);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('READ')), true);
  assert.equal(state.asked, 0);
});

test('a refusal blocks the call', async () => {
  const { ask, state } = scripted(['no']);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('WRITE')), false);
  assert.equal(state.asked, 1);
});

test('"once" approves this call only', async () => {
  const { ask, state } = scripted(['once', 'once']);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('WRITE')), true);
  assert.equal(await gate.check(request('WRITE')), true);
  assert.equal(state.asked, 2, 'must ask again the second time');
});

test('"always" silences later calls to the same tool', async () => {
  const { ask, state } = scripted(['always']);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('WRITE')), true);
  assert.equal(await gate.check(request('WRITE')), true);
  assert.equal(await gate.check(request('EXECUTE')), true);
  assert.equal(state.asked, 1);
});

test('"always" is scoped to one tool, not the whole session', async () => {
  const { ask, state } = scripted(['always', 'no']);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('WRITE', 'edit_file')), true);
  assert.equal(await gate.check(request('WRITE', 'run_command')), false);
  assert.equal(state.asked, 2);
});

test('an unrecognised answer is treated as a refusal', async () => {
  const { ask } = scripted(['no']);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('WRITE')), false);
});

test('ARCHITECTURE §8: "always" is never remembered for DESTRUCTIVE', async () => {
  const { ask, state } = scripted(['always', 'always', 'no']);
  const gate = new PermissionGate(ask);

  assert.equal(await gate.check(request('DESTRUCTIVE')), true);
  assert.equal(await gate.check(request('DESTRUCTIVE')), true);
  assert.equal(await gate.check(request('DESTRUCTIVE')), false);

  assert.equal(state.asked, 3, 'every destructive call must be re-confirmed');
});

test('a standing approval for a tool does not cover its destructive calls', async () => {
  // edit_file approved with "always" for ordinary writes; editing a credential
  // file classifies as DESTRUCTIVE and must still prompt.
  const { ask, state } = scripted(['always', 'no']);
  const gate = new PermissionGate(ask);

  assert.equal(await gate.check(request('WRITE', 'edit_file')), true);
  assert.equal(await gate.check(request('DESTRUCTIVE', 'edit_file')), false);
  assert.equal(state.asked, 2);
});

test('the request reaches the prompt intact', async () => {
  const { ask, state } = scripted(['once']);
  const gate = new PermissionGate(ask);
  await gate.check({
    toolName: 'edit_file',
    operation: 'WRITE',
    detail: 'src/a.ts',
    diff: { before: 'a', after: 'b' },
  });
  assert.deepEqual(state.seen[0]?.diff, { before: 'a', after: 'b' });
  assert.equal(state.seen[0]?.detail, 'src/a.ts');
});
