# 05 — Git and Test Tools

Three small tools: `git_status`, `git_diff`, `run_tests`. Each is short, and
each contains one decision worth understanding.

---

# `git_status`

## Machine-readable output, not human output

```ts
const result = await runProgram(
  'git',
  ['status', '--porcelain=v1', '--branch'],
  { cwd: context.workspaceRoot, timeoutMs: 15_000 },
);
```

Plain `git status` prints a friendly paragraph — *"Changes not staged for
commit: (use git restore...)"* — which is prose designed for humans and **not
guaranteed stable between git versions**.

`--porcelain=v1` prints a compact, explicitly stable format:

```
## main...origin/main [ahead 1]
 M src/agent.ts
?? notes.txt
```

The `v1` is deliberate. `--porcelain` alone means "current version", which could
change. Pinning the version means a git upgrade can't silently break parsing.

> **When shelling out to a tool, prefer its stable machine format and pin the
> version if it offers one.** Human-facing output is a UI, and UIs change.

## Explaining the codes to the model

```ts
const LEGEND =
  'Codes are "XY path": X = staged, Y = unstaged. ' +
  'M modified, A added, D deleted, R renamed, ?? untracked.';
```

Porcelain is compact but cryptic. ` M` (leading space) and `M ` (trailing) mean
opposite things. Rather than hoping the model remembers, we tell it.

**Cheap context beats hoping.** A line of explanation costs almost nothing and
removes a whole class of misreading.

## Distinguishing "clean" from "empty"

```ts
const lines = result.stdout.split('\n').filter((line) => line !== '');
// With --branch there is always a leading "## branch" line, so one line
// alone means a clean tree.
if (lines.length <= 1) {
  return {
    success: true,
    content: `${lines[0] ?? ''}\nWorking tree clean.`.trim(),
  };
}
```

A clean tree produces only the `## branch` line. Returning that alone is
ambiguous — the model can't tell "no changes" from "something went wrong and
produced nothing". Saying **"Working tree clean"** is unambiguous.

## Exit code 128

```ts
const NOT_A_REPO = 128;

if (result.exitCode === NOT_A_REPO) {
  return {
    success: false,
    error: 'Not a git repository. Run "git init" first.',
    retryable: false,
  };
}
```

Git uses 128 for "fatal error", most commonly not being in a repository. We
translate it into a sentence that says what to do, instead of forwarding git's
raw stderr.

---

# `git_diff`

## The `--` separator, again

```ts
const args = ['diff', '--no-color'];
if (input.staged === true) args.push('--staged');
// `--` separates revisions from paths, so a filename that looks like a
// branch name is still read as a path.
if (input.path !== undefined) args.push('--', input.path);
```

`git diff main` means "diff against the branch `main`". If you have a *file*
called `main`, git can't tell what you meant — it errors with "ambiguous
argument".

`--` resolves it: everything after is a path.

This is the third time `--` has appeared (`search_code`, `run_command`
patterns, here). Different tool, same rule: **`--` marks the end of options.**

## `--no-color`

Git detects a terminal and adds ANSI codes. Piped output usually disables that,
but not always — and colour codes in model context are noise that costs tokens
and can confuse parsing. Be explicit.

## "No changes" is success

```ts
if (result.stdout.trim() === '') {
  const scope = input.staged === true ? 'staged' : 'unstaged';
  return {
    success: true,
    content: `No ${scope} changes${input.path ? ` in ${input.path}` : ''}.`,
  };
}
```

An empty diff means "nothing changed" — a perfectly good answer, and often the
one you wanted after a denied edit. Empty output would be ambiguous, so it gets
a sentence.

## Why these are READ

Both git tools are classified `READ`, so they never prompt:

```ts
classify: () => ({ operation: 'READ', detail: 'git status' }),
```

CLAUDE.md says tools that "touch git state" must pass the gate. `git status`
and `git diff` **read** git state — they cannot alter a single byte of it.

This was a genuine judgement call, and the reasoning matters:

- The agent runs these constantly to verify its own edits. Prompting each time
  would produce approval fatigue.
- A future `git_commit` or `git_push` **would** be `GIT_STATE_CHANGE` and would
  prompt, because those mutate.

The line is **"can this change anything?"** — not "does this feel serious?"

---

# `run_tests`

## Reading the project's own test command

```ts
async function testScript(root: string): Promise<string | null> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) return null;
    const test = (scripts as { test?: unknown }).test;
    return typeof test === 'string' && test.trim() !== '' ? test : null;
  } catch {
    return null;
  }
}
```

Look at how carefully this is narrowed. `package.json` is a **boundary** — an
external file we didn't write — so nothing is assumed:

- parse in a try/catch (it might be malformed)
- check the result is an object **and not null** (`typeof null === 'object'`)
- check `scripts` is an object and not null
- check `test` is a non-empty string

The lazy version — `JSON.parse(raw).scripts.test` — throws on a malformed file,
a missing `scripts` key, or `scripts: null`. Four different crashes.

Every failure returns `null`, and the caller turns that into one clear message.

## Why `npm test` and not the script directly

```ts
// `npm test` rather than the raw script: npm puts node_modules/.bin on
// PATH, which the script almost certainly depends on.
const result = await runProgram('npm', ['test'], { ... });
```

Our test script is `node --import tsx --test ...`. Run directly, `tsx` isn't on
PATH — it lives in `node_modules/.bin`, which **npm adds** when it runs a
script. So we read the script to check it *exists*, then let npm run it.

## Why this is EXECUTE

```ts
// EXECUTE, not READ: the test script runs arbitrary project code, so it goes
// through the gate exactly like run_command.
classify: () => ({ operation: 'EXECUTE', detail: 'npm test' }),
```

`run_tests` *sounds* safe. It isn't: it runs whatever `scripts.test` says, which
is arbitrary code, possibly with side effects — touching a database, calling a
network service, writing fixtures.

It is `run_command` with a friendlier name, so it gets the same class.

## A failing suite: `success: false`, `retryable: false`

```ts
if (!result.success) {
  // A failing suite is information, not a malfunction — the model should
  // read the output and fix the code, not re-run the same tests.
  return {
    success: false,
    error: `Tests failed (exit ${result.exitCode}).\n${body}`,
    retryable: false,
  };
}
```

This combination is worth pausing on.

**`success: false`** — the tests did not pass, and the model must not conclude
they did.

**`retryable: false`** — but re-running is pointless. Nothing changed. The model
should read the failure and fix the *code*.

Recall the distinction from Day 1: `retryable` means *"can the model fix this by
sending different arguments?"* Here, no — the arguments were fine. The world is
what's wrong.

## Head-and-tail capping earns its keep here

```ts
const MAX_OUTPUT_CHARS = 80_000;
```

Test output is long, and the part you need — the failure summary and counts —
is at the **end**. This is exactly why `normalize.ts` keeps head *and* tail
rather than truncating. A plain `slice(0, N)` would throw away the answer.

---

## Things to remember

1. Prefer stable machine-readable output (`--porcelain=v1`) over human output.
2. Explain cryptic formats to the model — a legend line is cheap.
3. `--` marks the end of options. Third appearance; it will not be the last.
4. Translate tool-specific exit codes into actionable sentences.
5. Empty output is ambiguous. Say "clean" or "no changes" explicitly.
6. READ vs EXECUTE is about *effect*: can this change anything?
7. `run_tests` executes arbitrary project code — it is not a read.
8. Narrow every field when reading an external JSON file.
9. `npm test` gives the script the PATH it expects.
10. Failing tests: `success: false`, `retryable: false`.

## Try it yourself

1. Make an edit, then ask the agent to show you `git_diff`. Notice no prompt.
2. Ask it to run the tests. Notice it *does* prompt. Explain why to yourself.
3. Break a test on purpose, ask the agent to run tests and fix it. Watch it read
   the failure output rather than re-running blindly.
4. Run `git_status` in a directory that isn't a repo and read the message.

Next: `06-terminal-io.md`.
