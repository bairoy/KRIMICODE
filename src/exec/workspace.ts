import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isInside } from './platform.js';

/** Thrown when a path would take us outside the workspace. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * Filenames whose contents are sensitive even to read. Matched on the
 * basename. This is not a boundary by itself — it is the trigger for
 * refusing (and, once the gate exists, for asking).
 */
const SENSITIVE: readonly RegExp[] = [
  // `.env`, `.env.local`, `.env.production` — the dotfile and its variants.
  /^\.env(\..*)?$/i,
  // Anything *ending* in .env: `production.env`, `secrets.env`, `creds.env`.
  // Common in real projects and not covered by the anchored pattern above,
  // which requires the name to start with ".env".
  /\.env$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

export function isSensitivePath(absolutePath: string): boolean {
  const name = basename(absolutePath);
  return SENSITIVE.some((pattern) => pattern.test(name));
}

/**
 * realpath of the deepest existing ancestor. A path that does not exist yet
 * still has to be checked, because a symlinked parent directory could
 * otherwise smuggle the final path outside the workspace.
 */
async function realpathNearest(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve `input` against the workspace root and refuse anything that escapes
 * it — via `../`, an absolute path, or a symlink.
 *
 * Note: this is a check-then-use, so a symlink swapped between the check and
 * the read would defeat it. Closing that would require openat2-style handles;
 * out of scope while every caller runs locally as the user themselves.
 */
export async function resolveInWorkspace(
  root: string,
  input: string,
): Promise<string> {
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const realRoot = await realpath(root);
  const real = await realpathNearest(candidate);

  // Case-folded on Windows, where "C:\Work" and "c:\work" are the same
  // directory. A case-sensitive comparison here is a boundary bug, not a
  // cosmetic one: it can read an in-workspace path as being outside.
  if (!isInside(real, realRoot, process.platform)) {
    throw new WorkspaceError(
      `Refused: "${input}" resolves outside the workspace.`,
    );
  }

  return candidate;
}
