/**
 * Finds the test files and hands them to `node --test` as explicit paths.
 *
 * Not `node --test "src/tests/**\/*.test.ts"`. Glob expansion inside the test
 * runner needs Node 22, and package.json declares 20.12 as the floor — on Node
 * 20 the pattern arrives as a literal filename and the run dies with
 * "Could not find '.../src/tests/**\/*.test.ts'". Leaving the expansion to the
 * shell is not portable either: npm scripts run through cmd.exe on Windows,
 * which does not expand globs at all, and bash needs `globstar` for `**`.
 *
 * Explicit paths work on every supported Node and every platform.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = 'src/tests';

async function collect(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(full)));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const files = (await collect(ROOT)).sort();

/**
 * The failure this exists to prevent is not "no tests" — it is a pattern that
 * quietly matches *fewer* files than it should and still exits 0. That already
 * happened once: `src/tests/*.test.ts` stopped matching after the tests moved
 * into subdirectories, and the suite reported 49 passing out of 333.
 */
if (files.length === 0) {
  console.error(`No *.test.ts files found under ${ROOT}/.`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});
