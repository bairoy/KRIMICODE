import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isInside,
  isWindows,
  shellInvocation,
  shimInvocation,
  taskkillArgs,
  toPosixPath,
} from '../../exec/platform.js';

/**
 * These functions take `platform` as a parameter precisely so the Windows
 * branches can be exercised from a Mac. CI runs the whole suite on
 * windows-latest as well; this file is what makes the decisions themselves
 * checkable without one.
 */

// --- shellInvocation --------------------------------------------------------

test('a shell command runs under /bin/sh on POSIX', () => {
  const invocation = shellInvocation('echo hi | wc -l', 'darwin');

  assert.equal(invocation.file, '/bin/sh');
  assert.deepEqual(invocation.args, ['-c', 'echo hi | wc -l']);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

test('a shell command runs under cmd.exe on Windows', () => {
  const invocation = shellInvocation('dir', 'win32', 'C:\\Windows\\cmd.exe');

  assert.equal(invocation.file, 'C:\\Windows\\cmd.exe');
  // /d skips AutoRun, /s fixes the quoting rules for what follows, /c runs
  // and exits. The command itself is quoted as one argument.
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', '"dir"']);
});

test('Windows arguments are passed verbatim', () => {
  // Without this, Node re-quotes each argument for CreateProcess and mangles a
  // command line that has already been quoted for cmd.exe.
  const invocation = shellInvocation('echo hi', 'win32', 'cmd.exe');

  assert.equal(invocation.windowsVerbatimArguments, true);
});

test('cmd.exe is the fallback when ComSpec is unset', () => {
  const invocation = shellInvocation('dir', 'win32', undefined);

  assert.equal(invocation.file, 'cmd.exe');
});

// --- shimInvocation ---------------------------------------------------------

test('a shim is spawned directly on POSIX', () => {
  const invocation = shimInvocation('npm', ['test'], 'linux');

  assert.equal(invocation.file, 'npm');
  assert.deepEqual(invocation.args, ['test']);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

test('a shim is routed through cmd.exe on Windows', () => {
  // `npm` is `npm.cmd` there, and Node refuses to spawn a batch file without a
  // shell (the fix for CVE-2024-27980), so it has to go through cmd.
  const invocation = shimInvocation('npm', ['test'], 'win32', 'cmd.exe');

  assert.equal(invocation.file, 'cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', '"npm test"']);
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test('a shim refuses arguments that cmd.exe would read as syntax', () => {
  // Routing through cmd reintroduces a shell. This is the guard that stops the
  // reintroduced shell from ever becoming an injection: misuse throws at the
  // boundary rather than silently executing.
  for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a"b', "a'b", 'a%b']) {
    assert.throws(
      () => shimInvocation('npm', [bad], 'win32', 'cmd.exe'),
      /Refusing to route/,
      `expected "${bad}" to be refused`,
    );
  }
});

test('a shim refuses an argument containing a space', () => {
  // Parts are joined with spaces to build the command line, so a space inside
  // one would silently split it into two arguments.
  assert.throws(
    () => shimInvocation('npm', ['run build'], 'win32', 'cmd.exe'),
    /Refusing to route/,
  );
});

test('shim argument checks do not fire on POSIX', () => {
  // There is no shell involved there, so nothing needs escaping and a legal
  // argument must not be rejected for the sake of the other platform.
  const invocation = shimInvocation('npm', ['run build & echo'], 'darwin');

  assert.deepEqual(invocation.args, ['run build & echo']);
});

// --- isInside ---------------------------------------------------------------

test('a path equal to the root is inside it', () => {
  assert.equal(isInside('/work/proj', '/work/proj', 'darwin'), true);
});

test('a path below the root is inside it', () => {
  assert.equal(isInside('/work/proj/src/a.ts', '/work/proj', 'darwin'), true);
});

test('a sibling sharing the root name prefix is outside', () => {
  // The classic off-by-one: "/work/proj-evil" starts with "/work/proj" as a
  // string but is a different directory.
  assert.equal(isInside('/work/proj-evil/a.ts', '/work/proj', 'darwin'), false);
});

test('a parent of the root is outside', () => {
  assert.equal(isInside('/work', '/work/proj', 'darwin'), false);
});

test('Windows paths compare case-insensitively', () => {
  // C:\Work and c:\work are the same directory. Comparing them case-sensitively
  // makes the boundary check reject paths that are genuinely inside.
  assert.equal(
    isInside('C:\\Work\\proj\\a.ts', 'c:\\work\\proj', 'win32'),
    true,
  );
  assert.equal(isInside('c:\\WORK\\PROJ', 'C:\\work\\proj', 'win32'), true);
});

test('POSIX paths stay case-sensitive', () => {
  // On Linux /Work and /work really are different directories, so the Windows
  // fix must not leak across and loosen the check here.
  assert.equal(isInside('/Work/proj/a.ts', '/work/proj', 'linux'), false);
});

test('either separator is accepted on Windows', () => {
  // Windows APIs take both, so a forward-slash path is still inside the root.
  assert.equal(
    isInside('C:\\work\\proj/src/a.ts', 'C:\\work\\proj', 'win32'),
    true,
  );
});

test('a root that already ends in a separator still matches', () => {
  // A drive root is "C:\". Appending another separator would give "C:\\" and
  // never match anything.
  assert.equal(isInside('C:\\project\\a.ts', 'C:\\', 'win32'), true);
  assert.equal(isInside('/etc/hosts', '/', 'linux'), true);
});

test('a Windows sibling sharing the root prefix is still outside', () => {
  // Case-folding must not cost the prefix check.
  assert.equal(
    isInside('C:\\work\\proj-evil', 'C:\\work\\proj', 'win32'),
    false,
  );
});

// --- toPosixPath ------------------------------------------------------------

test('Windows paths are reported with forward slashes', () => {
  // The listing goes into model context and comes back as a path argument.
  // Reporting `src\a.ts` on one platform and `src/a.ts` on another describes
  // the same file two ways for no benefit — Windows accepts both.
  assert.equal(toPosixPath('src\\deep\\b.ts', 'win32'), 'src/deep/b.ts');
});

test('POSIX paths are left exactly alone', () => {
  // A backslash is illegal in a Windows filename but perfectly legal in a
  // POSIX one, so rewriting unconditionally would corrupt a real file name.
  assert.equal(toPosixPath('src/a.ts', 'linux'), 'src/a.ts');
  assert.equal(toPosixPath('odd\\name.ts', 'linux'), 'odd\\name.ts');
});

// --- misc -------------------------------------------------------------------

test('taskkill is asked for the whole tree, forced', () => {
  // /T is what reaches grandchildren; without it this has the same bug as
  // child.kill() on POSIX.
  assert.deepEqual(taskkillArgs(1234), ['/pid', '1234', '/T', '/F']);
});

test('only win32 counts as Windows', () => {
  assert.equal(isWindows('win32'), true);
  assert.equal(isWindows('darwin'), false);
  assert.equal(isWindows('linux'), false);
});
