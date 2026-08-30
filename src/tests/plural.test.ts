import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MaxTurnsError } from '../agent/agent.js';
import { formatSessionLine } from '../agent/session.js';
import { counted, plural } from '../plural.js';
import type { SavedSession } from '../agent/session.js';

test('one is singular, everything else is not', () => {
  assert.equal(plural(1, 'turn'), 'turn');
  assert.equal(plural(0, 'turn'), 'turns');
  assert.equal(plural(2, 'turn'), 'turns');
  assert.equal(plural(-1, 'turn'), 'turns');
});

test('an irregular plural is given, never guessed', () => {
  assert.equal(plural(1, 'entry', 'entries'), 'entry');
  assert.equal(plural(3, 'entry', 'entries'), 'entries');
  assert.equal(counted(1, 'match', 'matches'), '1 match');
  assert.equal(counted(0, 'match', 'matches'), '0 matches');
});

test('counted puts the number in front', () => {
  assert.equal(counted(1, 'round'), '1 round');
  assert.equal(counted(3, 'round'), '3 rounds');
});

function session(turns: number): SavedSession {
  return {
    version: 1,
    id: 'abc',
    workspaceRoot: '/w',
    model: 'm',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: 'the title',
    summary: null,
    history: Array.from({ length: turns }, () => ({
      role: 'user' as const,
      content: 'hello',
    })),
  };
}

test('REGRESSION: --list does not say "1 turns"', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  assert.match(formatSessionLine(session(1), now), /\b1 turn\b/);
  assert.doesNotMatch(formatSessionLine(session(1), now), /1 turns/);
  assert.match(formatSessionLine(session(2), now), /\b2 turns\b/);
});

test('the title column stays aligned whichever word is used', () => {
  // "turn" is a character shorter than "turns", so padding the number alone
  // would move the title one column left for every single-turn session.
  const now = new Date('2026-01-01T00:00:00.000Z');
  const one = formatSessionLine(session(1), now);
  const two = formatSessionLine(session(2), now);

  assert.equal(one.indexOf('the title'), two.indexOf('the title'));
});

test('the turn limit reports one turn as singular', () => {
  assert.match(new MaxTurnsError(1).message, /after 1 turn\b/);
  assert.doesNotMatch(new MaxTurnsError(1).message, /1 turns/);
  assert.match(new MaxTurnsError(30).message, /after 30 turns\b/);
});
