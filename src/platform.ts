/**
 * Every decision that has to come out differently on Windows.
 *
 * These are pure functions that take `platform` as a parameter rather than
 * reading `process.platform` themselves, so the Windows branches can be tested
 * from a Mac or a Linux CI runner. CI also runs the whole suite on
 * `windows-latest`; this file is what makes the decisions checkable everywhere
 * else.
 */

/** A resolved spawn target: what to execute, and with which arguments. */
export interface Invocation {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * Windows only. Node re-quotes each argument for `CreateProcess` by default,
   * which mangles a command line that has already been quoted for `cmd.exe`.
   * Passing them through verbatim is exactly what `child_process` does for
   * itself when you use `shell: true`.
   */
  readonly windowsVerbatimArguments: boolean;
}

export function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/**
 * The shell used to interpret a whole command string.
 *
 * `/d` skips any AutoRun registry command, `/s` gives the documented quote
 * handling for the string that follows, and `/c` runs it and exits. This
 * mirrors what Node's own `shell: true` builds.
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform,
  comSpec: string | undefined = process.env['ComSpec'],
): Invocation {
  if (!isWindows(platform)) {
    return {
      file: '/bin/sh',
      args: ['-c', command],
      windowsVerbatimArguments: false,
    };
  }
  return {
    file: comSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Anything that cmd.exe would treat as syntax rather than as text. Deliberately
 * broad — this is a refusal list, so a false positive costs an error message
 * while a false negative costs a shell injection.
 */
const CMD_METACHARACTERS = /[&|<>^"'`%\r\n]/;

/**
 * Runs a program that is a `.cmd`/`.bat` shim on Windows — `npm` and friends.
 *
 * On POSIX these are ordinary executables and this is a straight passthrough.
 * On Windows they are batch files, and Node refuses to `spawn` a batch file
 * without a shell (the fix for CVE-2024-27980), so the call has to go through
 * `cmd.exe`.
 *
 * That reintroduces a shell, so this is **only** safe for a fixed argv that no
 * model input reaches. Rather than rely on remembering that, every part is
 * checked for cmd metacharacters and the call throws if one appears: misuse
 * fails loudly at the boundary instead of silently becoming an injection.
 * Anything carrying model-supplied arguments must use `runProgram` directly.
 */
export function shimInvocation(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  comSpec: string | undefined = process.env['ComSpec'],
): Invocation {
  if (!isWindows(platform)) {
    return { file, args, windowsVerbatimArguments: false };
  }

  const parts = [file, ...args];
  for (const part of parts) {
    if (CMD_METACHARACTERS.test(part) || part.includes(' ')) {
      throw new Error(
        `Refusing to route "${part}" through cmd.exe: only a fixed argv with ` +
          'no shell metacharacters may be run as a Windows shim.',
      );
    }
  }

  return {
    file: comSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${parts.join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Is `child` the same path as `root`, or somewhere beneath it?
 *
 * Case-insensitive on Windows. This is the workspace boundary check, so getting
 * it wrong is a security bug rather than a portability wart: `C:\Work` and
 * `c:\work` are the same directory, and a case-sensitive comparison would read
 * a path inside the workspace as being outside it — or, with a root that
 * differs only in case, the reverse.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the latter maps a dotted
 * capital I to a dotless one under a Turkish locale, which would make the
 * comparison depend on the machine's language settings.
 */
export function isInside(
  child: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  const fold = (p: string): string =>
    isWindows(platform) ? p.toLowerCase() : p;

  const c = fold(child);
  const r = fold(root);
  if (c === r) return true;

  // Windows accepts either separator in a path, so both have to be considered.
  const separators = isWindows(platform) ? ['\\', '/'] : ['/'];
  return separators.some((sep) =>
    // A root that is already a drive or filesystem root ends in a separator;
    // appending another would produce "C:\\" and never match.
    c.startsWith(r.endsWith(sep) ? r : r + sep),
  );
}

/**
 * Arguments for terminating a process and everything below it on Windows.
 * `/T` takes the whole tree, `/F` forces it.
 */
export function taskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}
