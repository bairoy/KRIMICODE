# 07 — Testing (`src/tests/`)

156 tests, zero test-framework dependencies. This chapter is less about syntax
and more about **what is worth testing** — and about the three real bugs the
suite found the first time it ran.

---

## Why tests, and why at this point

Before the suite existed, every guarantee in this codebase was verified once, by
hand, with a throwaway script that was then deleted.

That means the guarantees were protected by **nothing**. Someone reorders two
lines in `normalize.ts` and secrets start leaking. Someone "simplifies"
`killGroup` and orphan processes come back. Nothing would say a word.

For a codebase whose entire selling point is *"these properties always hold"*,
that's the weakest possible position.

> A guarantee you have not automated is a guarantee you are hoping for.

---

## The setup

Node has a built-in test runner, so there is nothing to install:

```json
"test": "node --import tsx --test \"src/tests/*.test.ts\""
```

- **`--test`** — run files as tests
- **`--import tsx`** — lets Node execute TypeScript
- **the quoted glob** — Node expands it, not the shell, so it behaves the same
  everywhere

A test looks like this:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a name that states the rule', () => {
  assert.equal(actual, expected);
});
```

**`node:assert/strict`** means `assert.equal` is `===` rather than `==`. Always
use the strict form; the loose one will eventually tell you `'1' equals 1`.

## Keeping tests out of the build

`tsconfig.json` includes `src/**/*.ts`, so tests are **type-checked**. But they
shouldn't ship in `dist/`:

```json
// tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/tests"]
}
```

```json
"build": "tsc -p tsconfig.build.json",
"typecheck": "tsc --noEmit"
```

Type-checked, not shipped. Both things you want.

---

## What is worth testing

Not everything. Aim at these:

### 1. Security properties

```ts
test('REGRESSION: a sibling directory sharing the root name prefix is refused', ...)
test('SECURITY: a shell-metacharacter pattern is data, never code', ...)
test('ARCHITECTURE §8: "always" is never remembered for DESTRUCTIVE', ...)
```

The whole point of the project. These get the most attention.

### 2. Things you got wrong once

Every bug becomes a test. `REGRESSION:` in the name plus a comment explaining
what breaks if it fails:

```ts
test('REGRESSION: redaction runs before capping', () => {
  // A secret placed just past the 20,000-char head boundary. If capping ran
  // first the secret would be cut in half, the pattern would no longer match,
  // and a fragment would leak. Ordering is the only thing preventing that.
```

A future reader sees *why the order matters*, not just that a test failed.

### 3. Behaviour at the edges

Empty input, one item, past the limit, malformed data, missing files.

### 4. The contracts other code relies on

```ts
test('the registry exposes exactly the registered tools', () => {
  assert.deepEqual(names, ['edit_file', 'git_diff', /* ... */]);
});
```

This one failed twice while writing Day 2 — each time I added tools. That's the
test **working**: it forces you to notice the registry changed.

### What is *not* worth testing

- That Zod validates (Zod has tests)
- That `readFile` reads (Node has tests)
- Exact wording of a message — assert the *property*, or the test breaks on every
  rephrasing and gets deleted

---

## Techniques used here

### Fakes instead of the real thing

```ts
export function allowAll(): PermissionGate {
  return { check: async () => true } as unknown as PermissionGate;
}

export function spyGate(answer = true): { gate: PermissionGate; seen: PermissionRequest[] } {
  const seen: PermissionRequest[] = [];
  const gate = {
    check: async (request: PermissionRequest) => {
      seen.push(request);
      return answer;
    },
  } as unknown as PermissionGate;
  return { gate, seen };
}
```

`defineTool` only calls `.check()`, so an object with that one method is enough.
No terminal, no real gate, no mocking library.

`spyGate` also **records** what it was asked, which is how we verify a tool
classified a call correctly:

```ts
test('editing a credential file escalates to DESTRUCTIVE', async () => {
  const { gate, seen } = spyGate(false);
  await edit({ path: '.env', old_str: 'a', new_str: 'b' }, gate);
  assert.equal(seen[0]?.operation, 'DESTRUCTIVE');
});
```

### Scripted answers for sequences

```ts
function scripted(answers: UserAnswer[]) {
  let index = 0;
  const state = { asked: 0, seen: [] as PermissionRequest[] };
  const ask = async (request: PermissionRequest): Promise<UserAnswer> => {
    state.asked++;
    state.seen.push(request);
    return answers[index++] ?? 'no';
  };
  return { ask, state };
}
```

Counting `asked` is what proves "always" actually silenced later prompts:

```ts
test('"always" silences later calls to the same tool', async () => {
  const { ask, state } = scripted(['always']);
  const gate = new PermissionGate(ask);
  assert.equal(await gate.check(request('WRITE')), true);
  assert.equal(await gate.check(request('WRITE')), true);
  assert.equal(state.asked, 1);          // ← the actual assertion
});
```

The return values alone wouldn't distinguish "remembered" from "asked again and
got yes twice".

### Real files in temp directories

```ts
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'krimi-ws-'));
  await symlink(join(sibling, 'keys.txt'), join(root, 'innocent.txt'));
});

after(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});
```

The workspace tests create **actual symlinks**, because symlink resolution is
the thing under test. Mocking the filesystem would test the mock.

`mkdtemp` gives a unique directory, so parallel runs don't collide. `after`
cleans up regardless of outcome.

### Canary files for security tests

```ts
const canary = join(root, 'INJECTED');
await search({ pattern: `x"; touch ${canary}; echo "`, literal: true });
await assert.rejects(() => fs.stat(canary), 'the pattern reached a shell');
```

If injection ever becomes possible again, the file appears and the test fails.
**The test recreates the vulnerability rather than describing it.**

---

## ⭐ The three bugs the suite found immediately

This is the part worth remembering.

### 1. A real crash: `extractReasoning(null)`

```ts
export function extractReasoning(delta: unknown): string {
  const d = delta as { reasoning?: unknown; ... };
  if (typeof d.reasoning === 'string') return d.reasoning;
```

I wrote a test for malformed input almost as an afterthought:

```ts
assert.equal(extractReasoning(null), '');
```

It threw: `TypeError: Cannot read properties of null (reading 'reasoning')`.

The function took `unknown` and cast it *without checking*. A provider sending
`delta: null` would have killed the stream mid-response.

Fix:

```ts
if (typeof delta !== 'object' || delta === null) return '';
```

**The irony is the lesson.** Day 1's notes warn about `typeof null === 'object'`
in two separate places. I wrote that warning and then made the mistake anyway.
Knowing a rule and applying it under pressure are different skills — which is
precisely what tests are for.

### 2. A design smell exposed: `loadConfig()` was untestable

The config test failed strangely: env vars I set were being overwritten.

Cause:

```ts
export function loadConfig(): Config {
  process.loadEnvFile('.env');           // reads a file
  const parsed = EnvSchema.safeParse(process.env);   // reads a global
```

It read a file from disk **and** mutated a global. So its behaviour depended on
the working directory and on whatever `.env` happened to contain. Untestable —
and surprising in production too.

The fix separated the two responsibilities:

```ts
export function loadEnvFile(path = '.env'): void { ... }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  ...
}
```

Now `loadConfig` is pure with respect to the environment it's handed. Tests pass
an object; `main` calls `loadEnvFile()` once at startup.

> **Difficulty writing a test is usually information about the design, not about
> testing.** When something is hard to test, ask what it's reaching out and
> touching — that's normally the real problem.

### 3. Untestable logic pulled into the open

The tool-call accumulator — the trickiest code in the project — was buried
inside `stream()` and reachable only through a real HTTP call.

It became a class:

```ts
/**
 * Exported for tests. This is where OpenAI-compatible vendors differ most —
 * whether `id`/`name` repeat on every chunk, and how `index` separates
 * parallel calls — so it is worth testing directly rather than through HTTP.
 */
export class ToolCallAccumulator {
  add(delta: ToolCallDelta): void { ... }
  drain(): { complete: ...; incomplete: ... } { ... }
}
```

Seven tests now cover it, including the set-once behaviour that a "cleanup"
refactor would otherwise quietly break:

```ts
test('REGRESSION: a later chunk without id must not erase the id', () => {
  // Assigning unconditionally would wipe the id to undefined here, and the
  // call would be reported incomplete.
```

**Writing tests improved the design in all three cases.** That's the usual
outcome, and it's a better argument for testing than "catches bugs".

---

## Naming

The test name should state the **rule**, so a failure reads as a sentence about
what broke:

```
✖ ARCHITECTURE §8: "always" is never remembered for DESTRUCTIVE
✖ REGRESSION: redaction runs before capping
✖ §6.2 more than one match fails rather than picking the first
```

Compare with `✖ test permission gate 3`. The first tells you what's wrong before
you open a file.

Prefixes used here:

| Prefix | Meaning |
|---|---|
| `REGRESSION:` | this broke once; here's the guard |
| `SECURITY:` | a vulnerability is prevented |
| `§6.2` | traceable to a spec rule |

---

## Things to remember

1. An unautomated guarantee is a hope.
2. Node's built-in runner needs no dependencies. Use `assert/strict`.
3. Type-check tests; don't ship them. Two tsconfigs.
4. Test security properties, past bugs, edges, and contracts — not the standard
   library.
5. Fakes beat mocking libraries when the interface is one method.
6. Count how often a fake was called; return values alone hide bugs.
7. Use real files for filesystem behaviour. Mocks test the mock.
8. Security tests should recreate the vulnerability.
9. Hard-to-test code is usually badly-shaped code.
10. Name tests after the rule they enforce.

## Try it yourself

1. Run `npm test`. Read the names as a specification of the system.
2. Break something on purpose — swap `redact` and `capOutput` in
   `normalize.ts` — and read the failure. Revert.
3. Add a test for something not covered: what happens if `edit_file` gets a
   1 MB `old_str`? Write the test first, then see whether the behaviour is what
   you want.
4. Find every `REGRESSION:` test and, for each, explain what would break.

Next: `08-concepts-cheatsheet.md`.
