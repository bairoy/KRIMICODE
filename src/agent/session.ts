/**
 * Saving and resuming conversations.
 *
 * Concrete functions, not a `SessionStore` interface: ARCHITECTURE.md lists
 * that among the abstractions to defer, and CLAUDE.md says one real
 * implementation comes first. If a second backing store ever appears, the
 * interface can be extracted from what is actually needed rather than guessed
 * at now.
 *
 * Sessions live under the user's home directory rather than in the workspace,
 * so they never end up in the client's repository and still work when
 * krimicode is installed globally and run from anywhere.
 */

import { homedir } from 'node:os';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { plural } from '../plural.js';
import { redact } from '../redact.js';
import type { Message } from '../types.js';

/** Bumped when the on-disk shape changes incompatibly. */
const CURRENT_VERSION = 1;

/** Owner-only, both ways: a transcript can quote source code and secrets. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const MAX_TITLE_LENGTH = 60;

/**
 * A session file is a system boundary — it may have been written by an older
 * build, hand-edited, or truncated by a full disk — so it is validated rather
 * than trusted (CLAUDE.md).
 */
const MessageSchema: z.ZodType<Message> = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          argsJson: z.string(),
        }),
      )
      .optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    content: z.string(),
  }),
]);

const SessionSchema = z.object({
  version: z.literal(CURRENT_VERSION),
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  history: z.array(MessageSchema),
});

export type SavedSession = z.infer<typeof SessionSchema>;

/** Where sessions live. Overridable for tests. */
export function sessionsDir(home: string = homedir()): string {
  return join(home, '.krimicode', 'sessions');
}

/**
 * Sortable and unique without a dependency: a timestamp prefix means a plain
 * lexicographic sort is also newest-last, and the suffix separates two sessions
 * started in the same millisecond.
 */
export function newSessionId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

/** A one-line label for a session, taken from how the conversation opened. */
export function deriveTitle(history: readonly Message[]): string {
  const first = history.find((m) => m.role === 'user');
  if (!first) return '(empty)';
  const line = first.content.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TITLE_LENGTH
    ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : line;
}

/**
 * Write a session, replacing any previous version of it.
 *
 * Two things matter here beyond writing the file:
 *
 * Redaction. Tool results are already scrubbed by `normalize.ts`, but *user
 * input* is not — someone pastes a key into the prompt to ask about it, and it
 * would otherwise sit in cleartext on disk forever. The whole serialized
 * document goes through `redact` for that reason.
 *
 * Atomicity. Writing in place means a crash or a full disk leaves a truncated
 * file where a valid session used to be. Writing a temporary file and renaming
 * it means the session is either the old one or the new one, never a fragment.
 */
export async function saveSession(
  session: SavedSession,
  home?: string,
): Promise<void> {
  const dir = sessionsDir(home);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is ignored when the directory already exists, so an existing
  // directory created with a laxer umask is tightened here.
  await chmod(dir, DIR_MODE);

  const target = join(dir, `${session.id}.json`);
  const temporary = `${target}.tmp`;

  const body = redact(JSON.stringify(session, null, 2));

  await writeFile(temporary, body, { encoding: 'utf8', mode: FILE_MODE });
  try {
    await rename(temporary, target);
  } catch (err) {
    // Don't leave the fragment behind if the rename is what failed.
    await unlink(temporary).catch(() => {});
    throw err;
  }
}

/** Read one session, or null if it is missing or unreadable. */
export async function loadSession(
  id: string,
  home?: string,
): Promise<SavedSession | null> {
  const path = join(sessionsDir(home), `${id}.json`);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt file must not crash the CLI on startup — the user would have
    // no way past it short of deleting the file by hand.
    return null;
  }

  const result = SessionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Every session recorded for `workspaceRoot`, newest first.
 *
 * Unreadable and foreign-workspace files are skipped rather than reported: this
 * feeds a listing, and one bad file should not hide the rest.
 */
export async function listSessions(
  workspaceRoot: string,
  home?: string,
): Promise<SavedSession[]> {
  const dir = sessionsDir(home);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // nothing saved yet
  }

  const sessions: SavedSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // skip .tmp leftovers
    const session = await loadSession(name.slice(0, -'.json'.length), home);
    if (session && session.workspaceRoot === workspaceRoot) {
      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The most recently updated session for this workspace, if there is one. */
export async function latestSession(
  workspaceRoot: string,
  home?: string,
): Promise<SavedSession | null> {
  const sessions = await listSessions(workspaceRoot, home);
  return sessions[0] ?? null;
}

/** How long ago, in the roughest terms that are still useful. */
export function describeAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One line per session, for `/sessions` and `--list`. */
export function formatSessionLine(
  session: SavedSession,
  now: Date = new Date(),
): string {
  const turns = session.history.filter((m) => m.role === 'user').length;
  // Padded as one unit rather than padding the number alone: "turn" is a
  // character shorter than "turns", which would shift the title column.
  const count = `${String(turns).padStart(3)} ${plural(turns, 'turn')}`;
  return (
    `${session.id}  ${describeAge(session.updatedAt, now).padEnd(10)}` +
    `${count.padEnd(9)}  ${session.title}`
  );
}
