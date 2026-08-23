# 01 — Project Setup and TypeScript

Covers: `package.json`, `tsconfig.json`, ES modules, and the settings we chose.

---

## Part 1 — `package.json`

```json
{
  "name": "krimicode",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.12" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "openai": "^7.5.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "tsx": "^4.23.12",
    "typescript": "^7.0.2"
  }
}
```

Line by line:

**`"private": true`** — tells npm "never publish this to the public registry".
A safety switch. Without it, one mistyped `npm publish` uploads your client's
code to the internet.

**`"type": "module"`** — the single most important line here. It tells Node:
*"every `.js` file in this project is an ES module."*

This changes what syntax works:

```js
// With "type": "module"  ✅
import fs from 'node:fs';
export function hello() {}

// The old CommonJS way  ❌ (will now throw)
const fs = require('fs');
module.exports = { hello };
```

Our `CLAUDE.md` says "no CommonJS `require`" — this line is what enforces it.

**`"engines": { "node": ">=20.12" }`** — we use `process.loadEnvFile()`, which
only exists from Node 20.12. This documents that requirement.

### The scripts

| Script | Command | When you use it |
|---|---|---|
| `dev` | `tsx src/index.ts` | While developing. Runs TypeScript directly. |
| `build` | `tsc` | Compiles `src/*.ts` → `dist/*.js` |
| `start` | `node dist/index.js` | Runs the compiled output |
| `typecheck` | `tsc --noEmit` | Checks types, writes nothing |

**What is `tsx`?** Node cannot run `.ts` files. Normally you compile first, then
run. `tsx` compiles in memory as it goes, so you skip the wait. Great for
development, not for production.

**What does `--noEmit` mean?** "Check everything, but don't write any files."
It's the fastest way to ask *"did I break anything?"*

### dependencies vs devDependencies

- **dependencies** — needed when the program *runs*. `openai` and `zod` are
  imported by our actual code.
- **devDependencies** — only needed while *developing*. `typescript` and `tsx`
  build the code; the compiled output doesn't need them.

---

## Part 2 — `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "types": ["node"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

### `"target": "ES2022"`

Which JavaScript version to compile *down to*. Modern Node understands ES2022,
so nothing needs downgrading. This is what lets us use `#privateFields`.

### `"lib": ["ES2023"]`

Which built-in types TypeScript should know about.

Notice what's **missing**: `DOM`. We deliberately did not include browser types.
This is a Node program — there is no `document`, no `window`, no `alert`. By
leaving `DOM` out, TypeScript will error if you accidentally use browser-only
code.

### `"types": ["node"]`

An **allowlist** of which `@types/*` packages may add global names.

We hit a real bug here. Without this line, TypeScript couldn't find `process`
or `URL`, and the error message said *"Do you need to install @types/node?"* —
even though it **was** installed. Automatic inclusion wasn't working.

Keeping it has a second benefit: it pins exactly which packages can inject
globals. Without it, any type package that arrives as a sub-dependency silently
adds names to every file in your project.

> **Remember:** an error message tells you what the compiler *guessed*. Always
> verify before acting on it. We ran `ls node_modules/@types` and saw `node`
> sitting right there.

### `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`

"Use Node's own modern module rules." Together with `"type": "module"` in
`package.json`, this puts us fully in ES module land.

### ⚠️ The `.js` extension gotcha — read this twice

With NodeNext, **relative imports must end in `.js`, even when the file is
`.ts`.**

```ts
import { loadConfig } from './config.js';   // ✅ correct
import { loadConfig } from './config.ts';   // ❌ error
import { loadConfig } from './config';      // ❌ error
```

This looks wrong. It isn't.

**Why:** the import path in your source is copied *unchanged* into the compiled
output. At runtime, `dist/config.ts` doesn't exist — `dist/config.js` does. So
you write the name of the file that will exist *when it runs*, not the one you
are editing.

Everyone trips on this once. Now you won't.

### `"rootDir": "src"` and `"outDir": "dist"`

Read source from `src/`, write compiled output to `dist/`. Keeps generated files
out of your way, and lets `.gitignore` exclude `dist/` in one line.

### `"strict": true`

Turns on a bundle of safety checks at once. The most important:

```ts
// Without strict — this compiles, then crashes at runtime
function greet(name) {        // `name` is silently `any`
  return name.toUpperCase();
}
greet(null);                  // 💥 TypeError

// With strict
function greet(name) {        // ❌ Error: implicit 'any'
```

It also enables `strictNullChecks`, which separates `string` from
`string | null`, forcing you to handle the empty case.

### `"noUncheckedIndexedAccess": true`

Not part of `strict` — we added it deliberately.

```ts
const frames = ['⠋', '⠙', '⠹'];

// Without this flag
const f = frames[10];   // TypeScript says: string    (a lie! it's undefined)

// With this flag
const f = frames[10];   // TypeScript says: string | undefined  (the truth)
```

Any array index gives you `T | undefined`, because TypeScript can't know if the
index is in range.

You saw this in the spinner:

```ts
stdout.write(`\r${frames[i++ % frames.length] ?? ''} thinking…`);
//                                              ^^^^^ required by this flag
```

Slightly annoying. But this codebase constantly indexes into arrays that came
from model output (`chunk.choices[0]`), where being wrong is a real crash. Worth
it.

### `"verbatimModuleSyntax": true`

Forces you to write `import type` when importing only a type.

```ts
import type { Config } from './config.js';        // type only, erased at build
import { loadConfig } from './config.js';         // real value, stays
```

**Why it matters:** types vanish when compiled — they don't exist at runtime.
Without this flag, TypeScript guesses which imports to delete, and can guess
wrong. Being explicit removes the guesswork.

Rule of thumb: **interfaces and type aliases → `import type`. Functions,
classes, and constants → normal `import`.**

### `"skipLibCheck": true`

Don't type-check inside `node_modules`. Those are someone else's problem, and
checking them is slow.

### `"sourceMap": true`

When compiled code crashes, show the error at the **TypeScript** line, not the
generated JavaScript line. Makes stack traces readable.

---

## Part 3 — The other files

### `.gitignore`

```
node_modules/
dist/
.env
*.log
```

`.env` is here for a reason: **it holds your API key.** If it were committed,
your key would live in git history forever, even after deleting the file.

### `.env` and `.env.example`

```
# .env  (real values, never committed)
OPENAI_API_KEY=sk-or-v1-...
OPENAI_BASE_URL=https://openrouter.ai/api/v1
MODEL_NAME=z-ai/glm-4.6
EXTRA_BODY={"include_reasoning":true}
```

```
# .env.example  (committed, shows the shape, no values)
OPENAI_API_KEY=
OPENAI_BASE_URL=http://localhost:8000/v1
MODEL_NAME=
EXTRA_BODY=
```

The pattern: `.env.example` is documentation. A new developer copies it to
`.env` and fills in their own values.

> **Real bug we hit:** the base URL in `.env` was still the `.env.example`
> placeholder `http://localhost:8000/v1`. Nothing was listening there, so we got
> a connection error. The lesson: **copying the example file is step one, not the
> whole job.**

> **Security habit:** never write a secret using a shell command like
> `echo "KEY=sk-..." >> .env`. That line gets saved in `~/.zsh_history` and
> outlives the file. Edit `.env` in your editor instead.

---

## Things to remember

1. `"type": "module"` in `package.json` = ES modules, no `require`.
2. Relative imports end in **`.js`** even for `.ts` files.
3. `dependencies` = needed to run. `devDependencies` = needed to build.
4. `tsc --noEmit` is your fast "did I break it?" check.
5. `.env` is never committed. `.env.example` always is.
6. When a compiler error suggests a fix, **verify it first** — it's a guess.

## Common mistakes

| Mistake | What you'll see | Fix |
|---|---|---|
| `import './config'` | `Cannot find module` | Add `.js` |
| `require(...)` | `require is not defined` | Use `import` |
| Importing a type without `import type` | Confusing build errors | Add `type` |
| Forgetting `?? ''` on array index | `possibly undefined` | Handle the undefined case |
| Committing `.env` | Key leaked forever | Check `.gitignore` first |

Next: `02-config-and-zod.md`.
