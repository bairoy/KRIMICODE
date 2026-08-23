# 09 — Concepts Cheat Sheet

Every JavaScript/TypeScript concept used on Day 1, in one place. Use this for
quick revision.

---

## TypeScript

### Discriminated union

A union whose members share a field identifying which one it is.

```ts
type Result =
  | { success: true; content: string }
  | { success: false; error: string };

if (r.success) r.content;   // ✅ TS knows content exists
else            r.error;    // ✅ TS knows error exists
```

Used for: `Message`, `ModelEvent`, `ToolResult`.

### `unknown` vs `any`

```ts
let a: any = x;      a.foo.bar;    // compiles, may crash — checking is OFF
let u: unknown = x;  u.foo;        // ❌ error — must narrow first
```

`any` disables type checking. `unknown` keeps it on. **Always prefer
`unknown`.**

### Type narrowing

Proving to the compiler what a value is.

```ts
if (typeof v === 'string')  v.toUpperCase();
if (Array.isArray(v))       v.length;
if (v instanceof Error)     v.message;
if (r.success)              r.content;      // discriminant
```

### Type assertion (`as`)

"Trust me, it's this type." No runtime check happens.

```ts
const obj = raw as Record<string, unknown>;
```

**Only honest when a real check sits immediately before it.**

### Generics

A type as a parameter.

```ts
interface Tool<TInput> {
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput): Promise<ToolResult>;
}
```

`Tool<{path: string}>` fills `TInput` with `{path: string}`.

### `readonly`

```ts
readonly apiKey: string;        // cannot reassign the field
readonly items: string[];       // cannot reassign; CAN still push
```

### Optional properties and chaining

```ts
toolCalls?: ToolCall[];      // may be absent
request.tools?.length        // undefined instead of crashing
value ?? 'default'           // use default only if null/undefined
```

**`??` vs `||`:**

```ts
0 || 'x'    // 'x'   — 0 is falsy
0 ?? 'x'    // 0     — 0 is not null/undefined
```

Use `??` when `0` or `''` are legitimate values.

### `import type`

```ts
import type { Config } from './config.js';   // erased at compile time
import { loadConfig } from './config.js';    // real value
```

Required by `verbatimModuleSyntax`.

### `as const`

```ts
type: 'function'            // widened to `string`
type: 'function' as const   // stays exactly 'function'
```

### Exhaustive switch

Handle every variant of a union and TypeScript verifies you did.

```ts
switch (m.role) {
  case 'system': ...
  case 'user': ...
  case 'assistant': ...
  case 'tool': ...
  // no default needed — all four handled
}
```

---

## JavaScript

### Async generators

```ts
async function* stream() {
  for await (const chunk of source) {
    yield transform(chunk);      // hand out now, continue later
  }
}

for await (const item of stream()) { ... }
```

`yield` produces a value and pauses. `for await` consumes as items arrive.

### Private class fields

```ts
class Agent {
  readonly #provider: ModelProvider;   // truly private
}
agent.#provider;   // ❌ syntax error outside the class
```

Real privacy, unlike the `_name` convention.

### Closures

```ts
function makeCounter() {
  let n = 0;
  return () => ++n;      // still sees `n` after makeCounter returns
}
```

Used by `createRenderer()` for private state.

### Destructuring

```ts
const { text, toolCalls } = await this.#streamOnce();
const [key, value] = entry;
```

### Spread

```ts
{ ...base, ...override }        // later keys win
[...map.entries()]              // iterator → array
```

Conditional spread:

```ts
...(cond ? { key: value } : {})   // add a key only if cond
```

### Map and Set

```ts
const m = new Map<number, Slot>();
m.get(0); m.set(0, slot); m.entries();

const s = new Set<string>();
s.add('x');                       // duplicates ignored
```

`Map` allows any key type; plain objects only allow strings.

### Shorthand

```ts
{ extraBody }     // same as { extraBody: extraBody }
```

### `typeof null === 'object'`

A 1995 JavaScript bug, preserved forever.

```ts
if (typeof v === 'object' && v !== null && !Array.isArray(v)) { ... }
```

**Always all three checks together.**

### Numeric separators

```ts
30_000 === 30000     // underscores are cosmetic
```

### `try` / `catch` / `finally`

```ts
try { risky(); }
catch (err) { handle(err); }
finally { cleanup(); }      // ALWAYS runs
```

Use `finally` to restore anything global (terminal colours, open handles).

### Errors are not always `Error`

```ts
err instanceof Error ? err.message : String(err)
```

JavaScript lets you `throw` anything.

### Custom errors

```ts
class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';   // else it shows as "Error"
  }
}
```

### String replace with a function

```ts
text.replace(RE, (_match, g1: string, g2: string) => `${g1}${g2}X${g2}`);
```

Arguments are: the whole match, then each capture group.

### Exact string replace-all

```ts
text.split(secret).join('[REDACTED]');
```

Treats `secret` literally — no regex interpretation.

---

## Regex

| Piece | Meaning |
|---|---|
| `^` `$` | start / end of string |
| `\b` | word boundary |
| `.` | any char except newline |
| `[\s\S]` | any char **including** newline |
| `*` `+` `?` | 0+, 1+, 0 or 1 |
| `*?` | lazy — as few as possible |
| `{16,}` | 16 or more |
| `(...)` | capture group |
| `(?:...)` | group without capturing |
| `\2` | back-reference to group 2 |
| `/g` | replace all |
| `/i` | case-insensitive |

---

## Node.js

### Built-in module prefix

```ts
import { readFile } from 'node:fs/promises';
```

Explicit, faster, cannot be shadowed by a package.

### Paths

```ts
resolve(root, input)      // absolute path, flattens ..
isAbsolute(p)             // starts at /
basename('/a/b.txt')      // 'b.txt'
dirname('/a/b.txt')       // '/a'
sep                       // '/' on macOS/Linux
```

### realpath

Resolves symlinks to the true location. Throws if the path doesn't exist.

### Filesystem error codes

| Code | Meaning |
|---|---|
| `ENOENT` | no such file |
| `EISDIR` | is a directory |
| `EACCES` | permission denied |

### Environment

```ts
process.env.NAME          // string | undefined — always validate
process.cwd()             // current working directory
process.loadEnvFile('.env')   // Node 20.12+
process.exit(1)           // non-zero = failure
```

### stdout

```ts
stdout.write(text)        // no newline added
stdout.isTTY              // is it a real terminal?
console.log(text)         // adds a newline
```

---

## ANSI codes

| Code | Effect |
|---|---|
| `\x1b[0m` | reset |
| `\x1b[2m` | dim |
| `\x1b[31m` | red |
| `\x1b[32m` | green |
| `\x1b[36m` | cyan |
| `\x1b[K` | clear to end of line |
| `\r` | column 0, same line |

---

## Zod v4

```ts
z.object({ ... })              z.string()          z.number()
.min(1, 'message')             .optional()         .describe('for the model')
.refine(fn, 'message')

schema.safeParse(x)   // { success, data } | { success, error }
schema.parse(x)       // throws on failure

error.issues          // [{ path: ['field'], message: '...' }]
z.toJSONSchema(schema)   // v4 only — generates JSON Schema
```

---

## The agent-specific ideas

| Term | Meaning |
|---|---|
| **Tool call** | Model asks us to run something: id + name + JSON args |
| **Tool result** | What we send back |
| **Delta** | One fragment of a streamed reply |
| **Turn** | One trip around the loop |
| **Context window** | How much text the model can hold at once |
| **System prompt** | Standing instructions, first message |
| **Reasoning tokens** | The model's visible thinking. Display, don't store. |
| **Accumulator** | Code that reassembles fragments into a whole |
| **Composition root** | The one place everything is wired together |
| **Chokepoint** | A single path that enforces a rule |
| **Fail closed** | When unsure or unfinished, refuse |
| **TOCTOU** | Time-of-check to time-of-use race condition |

---

## Design principles from Day 1

1. **One road, one rule.** If something must always happen, make it structurally
   impossible to skip.
2. **Types should tell the truth.** `argsJson: string` admits it isn't parsed.
3. **Validate every boundary.** TypeScript can't help with runtime data.
4. **Fail closed.** Unfinished security → refuse.
5. **Sanitise before transforming.** Redact *then* cap.
6. **Don't leak library types into your core.** Translate at the edge.
7. **Extract an interface on the second implementation, not the first.**
8. **Document the limitations you chose not to fix.**
9. **Errors should name what failed.**
10. **Keep the loop small.** Extensibility belongs in the seams.

Next: `10-quiz-and-exercises.md`.
