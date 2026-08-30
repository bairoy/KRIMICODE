import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isWindows } from '../../exec/platform.js';
import { registerSecret } from '../../redact.js';
import {
  deriveTitle,
  describeAge,
  formatSessionLine,
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  sessionsDir,
} from '../../agent/session.js';
import type { SavedSession } from '../../agent/session.js';
import type { Message } from '../../types.js';

/** A throwaway home directory, so tests never touch the real ~/.krimicode. */
const fakeHome = () => mkdtemp(join(tmpdir(), 'krimicode-session-'));

function session(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    version: 1,
    id: newSessionId(),
    workspaceRoot: '/work/proj',
    model: 'test-model',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: 'a conversation',
    summary: null,
    history: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    ...overrides,
  };
}

// --- round trip -------------------------------------------------------------

test('a saved session comes back identical', async () => {
  const home = await fakeHome();
  const original = session();

  await saveSession(original, home);
  const loaded = await loadSession(original.id, home);

  assert.deepEqual(loaded, original);
});

test('tool calls and results survive the round trip', async () => {
  // These are the messages with structure to lose. A dropped toolCallId makes
  // the resumed conversation malformed and every later request a 400.
  const home = await fakeHome();
  const history: Message[] = [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'read_file', argsJson: '{"path":"a"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: '{"success":true}' },
    { role: 'assistant', content: 'done' },
  ];
  const original = session({ history });

  await saveSession(original, home);
  const loaded = await loadSession(original.id, home);

  assert.deepEqual(loaded?.history, history);
});

test('a summary is preserved', async () => {
  const home = await fakeHome();
  const original = session({ summary: 'earlier: looked at the parser' });

  await saveSession(original, home);

  assert.equal(
    (await loadSession(original.id, home))?.summary,
    original.summary,
  );
});

// --- untrusted input --------------------------------------------------------

test('a missing session is null, not an error', async () => {
  const home = await fakeHome();

  assert.equal(await loadSession('no-such-session', home), null);
});

test('a corrupt session file is rejected rather than crashing', async () => {
  // Otherwise a truncated write leaves the user unable to start at all.
  const home = await fakeHome();
  const original = session();
  await saveSession(original, home);
  await writeFile(join(sessionsDir(home), `${original.id}.json`), '{ oh no');

  assert.equal(await loadSession(original.id, home), null);
});

test('a session with the wrong shape is rejected', async () => {
  // Valid JSON, wrong contents — a hand-edit, or a file from a future version.
  const home = await fakeHome();
  const original = session();
  await saveSession(original, home);
  await writeFile(
    join(sessionsDir(home), `${original.id}.json`),
    JSON.stringify({ version: 1, id: 'x', history: 'not an array' }),
  );

  assert.equal(await loadSession(original.id, home), null);
});

test('a message with an unknown role is rejected', async () => {
  const home = await fakeHome();
  const original = session();
  await saveSession(original, home);
  await writeFile(
    join(sessionsDir(home), `${original.id}.json`),
    JSON.stringify({
      ...original,
      history: [{ role: 'wizard', content: 'x' }],
    }),
  );

  assert.equal(await loadSession(original.id, home), null);
});

// --- secrets ----------------------------------------------------------------

test('a secret pasted into the prompt is redacted before it reaches disk', async () => {
  // Tool results are already scrubbed by normalize.ts, but user input is not.
  // Without this, asking "is sk-... still valid?" writes the key to disk in
  // cleartext, where it outlives the session.
  const home = await fakeHome();
  const secret = 'sk-testonly-abcdefghijklmnopqrstuvwxyz0123456789';
  registerSecret(secret);

  const original = session({
    history: [{ role: 'user', content: `is ${secret} still valid?` }],
  });
  await saveSession(original, home);

  const raw = await readFile(
    join(sessionsDir(home), `${original.id}.json`),
    'utf8',
  );
  assert.equal(
    raw.includes(secret),
    false,
    'the key reached disk in cleartext',
  );
});

test('session files are readable only by their owner', async () => {
  // A transcript quotes source code and whatever the user typed.
  if (isWindows(process.platform)) return; // POSIX modes only

  const home = await fakeHome();
  const original = session();
  await saveSession(original, home);

  const info = await stat(join(sessionsDir(home), `${original.id}.json`));
  assert.equal(info.mode & 0o777, 0o600);

  const dir = await stat(sessionsDir(home));
  assert.equal(dir.mode & 0o777, 0o700);
});

// --- listing ----------------------------------------------------------------

test('listing is scoped to one workspace', async () => {
  // Sessions from every project share a directory, so a listing that ignored
  // the workspace would offer to resume an unrelated conversation.
  const home = await fakeHome();
  await saveSession(
    session({ workspaceRoot: '/work/a', title: 'from a' }),
    home,
  );
  await saveSession(
    session({ workspaceRoot: '/work/b', title: 'from b' }),
    home,
  );

  const listed = await listSessions('/work/a', home);

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, 'from a');
});

test('listing is newest first', async () => {
  const home = await fakeHome();
  await saveSession(
    session({ title: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
    home,
  );
  await saveSession(
    session({ title: 'newer', updatedAt: '2026-06-01T00:00:00.000Z' }),
    home,
  );

  const listed = await listSessions('/work/proj', home);

  assert.equal(listed[0]?.title, 'newer');
});

test('latestSession picks the most recent for the workspace', async () => {
  const home = await fakeHome();
  await saveSession(
    session({ title: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
    home,
  );
  await saveSession(
    session({ title: 'newer', updatedAt: '2026-06-01T00:00:00.000Z' }),
    home,
  );

  assert.equal((await latestSession('/work/proj', home))?.title, 'newer');
});

test('listing an empty or missing directory is not an error', async () => {
  const home = await fakeHome();

  assert.deepEqual(await listSessions('/work/proj', home), []);
  assert.equal(await latestSession('/work/proj', home), null);
});

test('one unreadable file does not hide the rest', async () => {
  const home = await fakeHome();
  const good = session({ title: 'readable' });
  await saveSession(good, home);
  await writeFile(join(sessionsDir(home), 'broken.json'), 'not json at all');

  const listed = await listSessions('/work/proj', home);

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, 'readable');
});

// --- helpers ----------------------------------------------------------------

test('ids sort chronologically as plain strings', async () => {
  // The listing sorts on updatedAt, but a lexicographic id keeps directory
  // listings and any future globbing in a sensible order too.
  const early = newSessionId(new Date('2026-01-01T00:00:00Z'));
  const late = newSessionId(new Date('2026-06-01T00:00:00Z'));

  assert.ok(early < late, `${early} should sort before ${late}`);
});

test('ids do not collide within the same millisecond', () => {
  const now = new Date();
  const ids = new Set(Array.from({ length: 200 }, () => newSessionId(now)));

  assert.equal(ids.size, 200);
});

test('an id is safe to use as a filename', () => {
  // It is interpolated straight into a path, so a separator in it would write
  // outside the sessions directory.
  const id = newSessionId();

  assert.equal(/^[A-Za-z0-9_-]+$/.test(id), true, `unsafe id: ${id}`);
});

test('a title is taken from the first thing the user said', () => {
  assert.equal(
    deriveTitle([
      { role: 'user', content: '  fix   the parser\n bug ' },
      { role: 'user', content: 'and then the tests' },
    ]),
    'fix the parser bug',
  );
});

test('a long title is truncated', () => {
  const title = deriveTitle([{ role: 'user', content: 'x'.repeat(200) }]);

  assert.ok(title.length <= 60, `got ${title.length}`);
});

test('a history with no user message still has a title', () => {
  assert.equal(deriveTitle([]), '(empty)');
});

test('age is described in the roughest useful terms', () => {
  const now = new Date('2026-01-02T12:00:00.000Z');

  assert.equal(describeAge('2026-01-02T11:59:30.000Z', now), 'just now');
  assert.equal(describeAge('2026-01-02T11:30:00.000Z', now), '30m ago');
  assert.equal(describeAge('2026-01-02T09:00:00.000Z', now), '3h ago');
  assert.equal(describeAge('2025-12-30T12:00:00.000Z', now), '3d ago');
  assert.equal(describeAge('not a date', now), 'unknown');
});

test('a session line carries the id, so it can be resumed', () => {
  const one = session({ id: 'abc-123', title: 'fix the parser' });

  const line = formatSessionLine(one, new Date('2026-01-01T01:00:00.000Z'));

  assert.match(line, /abc-123/);
  assert.match(line, /fix the parser/);
});
