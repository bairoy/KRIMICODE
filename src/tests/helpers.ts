import { spawn } from 'node:child_process';
import type { PermissionGate, PermissionRequest } from '../permissions.js';

/**
 * Stand-ins for the real gate. The tool dispatcher only calls `check`, so a
 * plain object with that method is enough — no need to construct a real gate
 * with a fake terminal behind it.
 */
export function allowAll(): PermissionGate {
  return { check: async () => true } as unknown as PermissionGate;
}

export function denyAll(): PermissionGate {
  return { check: async () => false } as unknown as PermissionGate;
}

/** Records what the gate was asked, then answers with `answer`. */
export function spyGate(answer = true): {
  gate: PermissionGate;
  seen: PermissionRequest[];
} {
  const seen: PermissionRequest[] = [];
  const gate = {
    check: async (request: PermissionRequest) => {
      seen.push(request);
      return answer;
    },
  } as unknown as PermissionGate;
  return { gate, seen };
}

/**
 * How many processes matching `marker` are still **alive**.
 *
 * Deliberately not `pgrep`: a killed child whose parent was killed too becomes
 * a zombie until something reaps it, and pgrep counts zombies. A zombie is not
 * a survivor — it is already dead — so counting them makes the process-group
 * tests assert something stricter than they mean, and racier: macOS reaps
 * quickly enough to hide it, Linux does not.
 *
 * Filtering in JS rather than piping through grep also removes the classic
 * problem of the search command matching itself.
 */
export function countLiveMatching(marker: string): Promise<number> {
  return new Promise((resolve) => {
    // `stat` first, then the full command line. Works on both macOS and Linux.
    const child = spawn('ps', ['-A', '-o', 'stat=', '-o', 'args=']);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const live = out
        .split('\n')
        .filter((line) => line.includes(marker))
        // Zombie ("Z"/"Z+") — dead already, just not yet reaped.
        .filter((line) => !line.trimStart().startsWith('Z'));
      resolve(live.length);
    });
  });
}
