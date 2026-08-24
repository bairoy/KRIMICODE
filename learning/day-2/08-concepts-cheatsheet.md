# 08 — Day 2 Concepts Cheat Sheet

New material only. Day 1's cheat sheet still applies.

---

## Processes

### Spawning

```ts
spawn('/bin/sh', ['-c', 'echo hi'])   // through a shell
spawn('grep', ['foo', 'src/'])        // direct, no shell
```

### Process groups

```ts
spawn(file, args, { detached: true })   // child becomes group leader
process.kill(-pid, 'SIGTERM')           // negative pid = the whole group
child.kill('SIGTERM')                   // ❌ shell only; children orphaned
```

### Signals

| Signal | Catchable | Use |
|---|---|---|
| `SIGTERM` | yes | ask politely first |
| `SIGKILL` | **no** | escalate after a grace period |

### Timers

```ts
setTimeout(fn, ms).unref()   // won't keep the process alive on its own
```

### Child process events

| Event | Fires when |
|---|---|
| `error` | spawn failed (bad cwd, program not found) |
| `exit` | process ended — **output may still be buffered** |
| `close` | process ended **and** stdio drained ← use this |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | grep/ripgrep: no matches (an answer, not an error) |
| `2` | grep/ripgrep: actual error |
| `128` | git: fatal, usually "not a repository" |
| `null` | killed by a signal, or never spawned |

---

## Command injection

**The bug:**

```ts
runCommand(`grep "${pattern}" .`);   // ❌ pattern reaches a shell
// pattern = 'x"; rm -rf ~; echo "'  → three commands run
```

**The fix — not escaping, but argv:**

```ts
runProgram('grep', [pattern, '.']);  // ✅ pattern is one argv element
```

**The rule:** any value from the model → `runProgram`. `runCommand` is only for
a whole command a human approved.

**`--` ends option parsing:**

```ts
args.push('--', pattern, target);   // pattern starting with "-" stays data
```

Needed by `search_code`, `git diff`, and anything else taking user data as a
positional argument.

---

## Streams

### Transform

```ts
new Transform({
  transform(chunk, encoding, callback) { callback(null, modified); },
  flush(callback) { callback(null, leftovers); },
});

stdin.pipe(myTransform);
```

### The chunk-boundary rule

Data arrives in arbitrary pieces. A multi-byte token can be split:

```
chunk 1: "\x1b[20"
chunk 2: "0~text"
```

Hold back any trailing bytes that could start a token; prepend them to the next
chunk. **Every hand-written stream parser needs this.**

---

## Terminal control

| Sequence | Effect |
|---|---|
| `\x1b[?2004h` | enable bracketed paste |
| `\x1b[?2004l` | disable it |
| `\x1b[200~` | paste begins |
| `\x1b[201~` | paste ends |
| `\x1b[1;31m` | bold red |

```ts
stdin.setRawMode(true);   // keystrokes arrive immediately
stdout.isTTY              // false when piped
```

**Always restore terminal state in a `finally`** — raw mode or bracketed paste
left on outlives your process and breaks the user's shell.

---

## Filesystem

```ts
readdir(dir, { withFileTypes: true })   // Dirent objects; no stat per entry
entry.isDirectory()
mkdtemp(join(tmpdir(), 'prefix-'))      // unique temp dir
rm(path, { recursive: true, force: true })
```

Breadth-first walk with an explicit queue:

```ts
const queue = [start];
while (queue.length > 0) {
  const current = queue.shift();   // shift = BFS, pop = DFS
  ...
  queue.push(child);
}
```

No stack overflow, easy to cap, better ordering.

---

## Node's test runner

```ts
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

test('name', async () => {
  assert.equal(a, b);
  assert.deepEqual(obj, expected);
  assert.match(text, /pattern/);
  assert.ok(value, 'message');
  assert.throws(() => fn(), /Error/);
  await assert.rejects(() => promise());
  assert.fail('should not reach here');
});
```

```bash
node --import tsx --test "src/tests/*.test.ts"
```

---

## Testing techniques

**Fake an interface with one method:**

```ts
const gate = { check: async () => true } as unknown as PermissionGate;
```

**Spy — record what was asked:**

```ts
const seen: Request[] = [];
const gate = { check: async (r) => { seen.push(r); return true; } };
```

**Scripted answers — for sequences:**

```ts
const answers = ['always', 'no'];
let i = 0;
const ask = async () => answers[i++] ?? 'no';
```

**Canary — prove a vulnerability is gone:**

```ts
await doThing(`x"; touch ${canary}; echo "`);
await assert.rejects(() => stat(canary));   // file must not exist
```

**Count invocations** — return values alone can't tell "remembered" from "asked
again and said yes".

---

## Two tsconfigs

```json
// tsconfig.json — includes tests, used by typecheck
{ "include": ["src/**/*.ts"] }

// tsconfig.build.json — excludes tests, used by build
{ "extends": "./tsconfig.json", "exclude": ["src/tests"] }
```

---

## Permission model

| Class | Decision | Example |
|---|---|---|
| `READ` | allow | `read_file`, `list_files`, `git_status` |
| `READ_SENSITIVE` | ask | `read_file` on `.env` |
| `WRITE` | ask | `edit_file` |
| `EXECUTE` | ask | `run_command`, `run_tests` |
| `DESTRUCTIVE` | ask, **never remembered** | `rm -rf`, editing `.env` |
| `GIT_STATE_CHANGE` | ask | a future `git_commit` |

**Key rules:**

- Classify the **call**, not the tool
- `"always"` is scoped **per tool**
- `DESTRUCTIVE` is never covered by a standing approval
- Denial is `retryable: false`
- The gate lives in `defineTool`, so no tool can skip it
- `ToolContext` does **not** carry the gate — least privilege

---

## `success` and `retryable`

| Situation | success | retryable | Why |
|---|---|---|---|
| Malformed JSON args | false | **true** | model can re-send |
| Wrong argument shape | false | **true** | model can fix it |
| `old_str` matched twice | false | **true** | add more context |
| File not found | false | false | retrying won't create it |
| Path outside workspace | false | false | refused permanently |
| Denied by user | false | false | "no" means no |
| Tests failed | false | false | fix the code, not the call |
| No search matches | **true** | — | that's an answer |
| Empty git diff | **true** | — | that's an answer |

`retryable` means: *can the model fix this by sending different arguments?*

---

## Design principles added on Day 2

1. **Make the mistake unexpressible**, don't rely on remembering the rule.
   (argv over escaping)
2. **Fail closed** — unfinished or uncertain means refuse.
3. **A prompt that fires constantly is a prompt nobody reads.**
4. **Ambiguity is an error, never a guess.** (multiple `old_str` matches)
5. **A tool that cannot fail will lie to you.** (`edit_file` won't create files)
6. **Approving something you can't see isn't consent.**
7. **Describe heuristics accurately** — overstating a control is worse than
   having none.
8. **Hard-to-test code is badly-shaped code.**
9. **Test the property, not the formatting.**
10. **Restore any global state you change, in a `finally`.**

Next: `09-quiz-and-exercises.md`.
