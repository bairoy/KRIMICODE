# 06 — Security Boundaries

Covers `src/exec/workspace.ts`, `src/redact.ts`, and `src/tools/normalize.ts`.

---

## Why this matters more than usual

In a normal program, *you* wrote every line, so you roughly know what it does.

In an agent, a **language model** decides what happens next. It might be
confused. It might be following instructions hidden inside a file it just read.
It is not malicious, but it is not trustworthy either.

Three specific dangers on Day 1:

| Danger | Example | Defence |
|---|---|---|
| Reading outside the project | `read_file("../../.ssh/id_rsa")` | `workspace.ts` |
| A secret reaching the model | reading a config file with an API key | `redact.ts` |
| Filling the context window | reading a 10 MB log file | `normalize.ts` |

---

# Part 1 — `src/exec/workspace.ts`

## The concept: path traversal

Every filesystem understands `..` as "go up one folder".

```
/Users/you/project/src/../../../../etc/passwd
                       └──────────────┘
                       climbs out of the project entirely
```

If you join user input onto a base path without checking, you have a
**path traversal vulnerability** — one of the oldest bugs there is.

Three ways out of a folder:

1. **Relative climbing** — `../../etc/passwd`
2. **Absolute paths** — `/etc/passwd` ignores your base entirely
3. **Symlinks** — a file inside the project that *points* outside it

The third is the sneaky one. `project/notes.txt` can be a symlink to
`/etc/passwd`. The path looks perfectly innocent.

Here is the defence, in order:

```mermaid
flowchart TD
    IN["path from the model<br/>e.g. 'notes.txt' or '../../etc/passwd'"] --> RES["resolve() it against<br/>the workspace root"]
    RES --> REAL["realpath() it<br/><i>follows every symlink to<br/>the REAL file on disk</i>"]
    REAL --> CHK{"does the real path start<br/>with realRoot + separator?"}
    CHK -->|yes| OK["allowed ✅"]
    CHK -->|no| NO["WorkspaceError ❌<br/><i>refused, never even prompted</i>"]
```

**Why `realpath` before the check, not after?** Because a symlink lies about
where it goes. `resolve()` alone would say `project/notes.txt` is safely inside
the project. Only after following the link do you learn it lands on
`/etc/passwd`.

> **Check the destination, not the label.**

**Why `+ separator` on the root?** Without it, a *sibling* folder whose name
merely starts the same way would slip through:

```mermaid
flowchart TD
    A["the file we are checking is<br/>/home/me/project-secrets/keys.txt"]
    A --> B{"does it start with<br/>/home/me/project"}
    A --> C{"does it start with<br/>/home/me/project/"}
    B -->|"yes — but this is a DIFFERENT folder"| BAD["❌ wrongly allowed"]
    C -->|"no"| GOOD["✅ correctly blocked"]

    style BAD fill:#f8d7da,stroke:#721c24,color:#4a0f16
    style GOOD fill:#d4edda,stroke:#155724,color:#0b2e13
```

That one character is the whole fix. There is a regression test named after it.

## The code

```ts
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

/** Thrown when a path would take us outside the workspace. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
```

**A custom error class** lets callers tell *this* failure apart from others:

```ts
if (err instanceof WorkspaceError) { /* refuse politely */ }
throw err;                          // something else — don't swallow it
```

**`this.name = 'WorkspaceError'`** — without it, the name stays `'Error'` in
stack traces. One line, much clearer debugging.

### The sensitive-file list

```ts
const SENSITIVE: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
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
```

Files that are dangerous *even to read*.

Regex refresher:

| Piece | Meaning |
|---|---|
| `^` | start of string |
| `$` | end of string |
| `.` | any character (escaped `\.` = a literal dot) |
| `?` | previous part is optional |
| `(a\|b)` | a or b |
| `/i` | case-insensitive |

So `/^\.env(\..*)?$/i` matches `.env`, `.env.local`, `.ENV.production` — but not
`environment.ts`, because of the `^` and `$` anchors.

**`basename()`** takes just the filename: `/a/b/.env` → `.env`.

**`.some()`** returns `true` if *any* pattern matches. Stops at the first hit.

> **What this is and isn't.** This list is a *trigger*, not a wall. Secrets can
> live in files with any name. Its job is to catch the obvious cases so they
> require a human decision. Real protection comes from combining it with
> redaction (Part 2).

### Resolving symlinks

```ts
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
```

**What is `realpath`?** It follows every symlink and returns the *true* location.

```
realpath('project/notes.txt')  →  '/etc/passwd'    if notes.txt is a symlink
```

This is what defeats the symlink attack.

**The problem:** `realpath` throws if the path doesn't exist. But we still need
to check paths for files that don't exist yet — otherwise `edit_file` creating
`../../evil.txt` would sail through unchecked.

**The solution:** walk up until we find something that *does* exist, and check
that. If `project/newdir/file.txt` doesn't exist, we check `project/newdir`, or
failing that `project`.

Why that's still safe: if any parent is a symlink pointing outside, the parent's
realpath is outside, and we reject.

**`for (;;)`** is an infinite loop — same as `while (true)`.

**`if (parent === current) return current;`** is the stop condition. `dirname`
of `/` is `/`, so when the path stops shrinking we've hit the filesystem root.
Without this line, infinite loop.

### The main check

```ts
export async function resolveInWorkspace(
  root: string,
  input: string,
): Promise<string> {
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const realRoot = await realpath(root);
  const real = await realpathNearest(candidate);

  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new WorkspaceError(
      `Refused: "${input}" resolves outside the workspace.`,
    );
  }

  return candidate;
}
```

**Line 1 — build the absolute path.**

```ts
isAbsolute(input) ? resolve(input) : resolve(root, input)
```

- Absolute input (`/etc/passwd`) → use as-is (it'll be rejected below)
- Relative input (`src/a.ts`) → join onto the root

`resolve()` also flattens `..`, so `/a/b/../c` becomes `/a/c`.

**Line 2–3 — get the true locations** of both the root and the target.

**Line 4 — the containment check.** Two parts:

```ts
real !== realRoot                     // the root itself is allowed
!real.startsWith(realRoot + sep)      // must be under the root
```

**⚠️ Why `realRoot + sep` and not just `realRoot`?**

`sep` is the path separator (`/` on macOS/Linux). Suppose the root is
`/Users/you/project`. Consider `/Users/you/project-secrets/keys.txt`:

```ts
'/Users/you/project-secrets/keys.txt'.startsWith('/Users/you/project')       // true!  😱
'/Users/you/project-secrets/keys.txt'.startsWith('/Users/you/project/')      // false ✅
```

Without the separator, any sibling folder whose name *starts with* your project
name would be readable. This is a real, easy-to-miss bug. **Always append the
separator when doing prefix-based containment checks.**

**Return `candidate`, not `real`** — we return the normal path so error messages
and displays stay readable. We only used `real` to *verify*.

### The honest limitation

```ts
 * Note: this is a check-then-use, so a symlink swapped between the check and
 * the read would defeat it. Closing that would require openat2-style handles;
 * out of scope while every caller runs locally as the user themselves.
```

This is a **TOCTOU** bug — Time Of Check to Time Of Use. Between our check and
the actual read, someone could swap the file for a symlink.

We did **not** fix it, and we wrote down why: closing it needs OS-level file
handle APIs, and the agent already runs as you, with your permissions — an
attacker who could swap files in your project already has your account.

> **The habit worth copying:** when you knowingly leave a gap, document it with
> the reasoning. A known, written-down limitation is engineering. An unknown one
> is a bug waiting to surprise you.

---

# Part 2 — `src/redact.ts`

## The concept

Secrets end up in files. If the agent reads such a file, the secret goes into
the model's context — sent over the network to a third party, possibly logged,
possibly used for training.

Once sent, **you cannot take it back.** So we scrub before sending.

## The code

```ts
const PLACEHOLDER = '[REDACTED]';

/** Exact values known at runtime, e.g. the configured API key. */
const knownSecrets = new Set<string>();

/**
 * Register an exact value to scrub wherever it appears. Short values are
 * ignored: redacting a 4-character string would corrupt ordinary prose.
 */
export function registerSecret(value: string): void {
  if (value.length >= 12) knownSecrets.add(value);
}
```

Two layers of defence:

1. **Exact values we know** — the API key from config. 100% reliable.
2. **Patterns** — things that *look* like secrets. Catches unknown secrets, but
   guesses.

**`Set`** — a collection with no duplicates. Registering the same key twice
stores it once.

**Why `length >= 12`?** If someone registered `"abc"` as a secret, every "abc"
anywhere in every file would become `[REDACTED]`. Short strings appear in
ordinary text by coincidence. Real keys are long.

### The patterns

```ts
const PATTERNS: readonly RegExp[] = [
  // PEM private key blocks, body included.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // Vendor-prefixed API keys (OpenAI, OpenRouter, Anthropic, Stripe, ...).
  /\b(?:sk|pk|rk)-(?:or-|ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens in captured headers.
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];
```

New regex pieces:

| Piece | Meaning |
|---|---|
| `\b` | word boundary — prevents matching inside a longer word |
| `(?:...)` | group without capturing (slightly faster) |
| `{16,}` | 16 or more of the previous thing |
| `[\s\S]` | *any* character including newlines (unlike `.`) |
| `*?` | lazy — match as **few** as possible |
| `/g` | global — replace all matches, not just the first |

**Why `[\s\S]*?` for PEM keys?** A private key spans many lines. Plain `.` does
not match newlines, so `[\s\S]` (whitespace or non-whitespace = everything) is
the trick. The lazy `*?` stops at the *first* `-----END`, so two keys in one file
are redacted separately rather than merged into one blob.

**Why `eyJ` for JWTs?** A JWT is base64-encoded JSON, and every JSON object
starts with `{"`. Base64 of `{"` is always `eyJ`. Nice piece of trivia.

### The assignment pattern

```ts
/**
 * `KEY=value` / `"key": "value"` assignments where the key name looks
 * secret-bearing. Captures the prefix and quote so only the value is replaced.
 */
const ASSIGNMENT =
  /(\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\b\s*[:=]\s*)(["']?)([^\s"',]{6,})\2/gi;
```

Catches secrets that *don't* have a recognisable prefix:

```
DB_PASSWORD=hunter2correcthorse
```

There is no pattern in `hunter2correcthorse` — it looks like a word. But the
**key name** gives it away.

Three capture groups:

1. `(...)` the key name and `=` — **keep this**
2. `(["']?)` an optional quote — **keep this**
3. `([^\s"',]{6,})` the value — **replace this**

**`\2` at the end** is a *back-reference*: "the same thing group 2 matched". So
`"value"` requires matching quotes, and `value` with no quotes works too. It
won't mismatch `"value` with a stray quote.

**`API_?KEY`** — the `?` makes the underscore optional, matching both `API_KEY`
and `APIKEY`.

### The redact function

```ts
export function redact(text: string): string {
  let out = text;

  // Exact known values first — these are certain, unlike the heuristics below.
  for (const secret of knownSecrets) {
    out = out.split(secret).join(PLACEHOLDER);
  }

  for (const pattern of PATTERNS) {
    out = out.replace(pattern, PLACEHOLDER);
  }

  out = out.replace(
    ASSIGNMENT,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}${PLACEHOLDER}${quote}`,
  );

  return out;
}
```

**`.split(secret).join(PLACEHOLDER)`** is a neat trick for "replace all
occurrences of an exact string":

```js
'a-KEY-b-KEY-c'.split('KEY')          // ['a-', '-b-', '-c']
                .join('[REDACTED]')   // 'a-[REDACTED]-b-[REDACTED]-c'
```

Why not `.replaceAll()`? This works on older runtimes and — importantly — treats
the secret as a **literal string**, never as a regex. If a key contained regex
characters, a regex-based replace could misbehave.

**Exact secrets first**, because they're certain. Patterns are guesses.

**The replacement function** for `ASSIGNMENT` receives the capture groups as
arguments. `_match` is the whole match (unused — the leading `_` is the
convention for "deliberately ignored"). We rebuild the string keeping groups 1
and 2, replacing group 3.

Result:

```
DB_PASSWORD=hunter2correcthorse   →   DB_PASSWORD=[REDACTED]
```

The model still learns *that* there is a password setting — useful context —
without learning its value.

---

# Part 3 — `src/tools/normalize.ts`

## The concept: the context window

A model can only hold so much text at once — its **context window**. GLM-4.6
holds about 200,000 tokens (roughly 150,000 words).

If a tool returns a 10 MB log file, it fills the entire window. The model
"forgets" your original question. Every subsequent request costs more and runs
slower.

So: **every tool output needs a cap.** No exceptions.

We keep the **head and the tail**, not just the head:

```mermaid
flowchart LR
    IN["200,000 characters<br/>of command output"] --> CUT

    subgraph CUT["capOutput()"]
        direction TB
        H["first 20,000<br/><i>the shape of the output</i>"]
        E["[... 170,000 characters elided ...]"]
        T["last 10,000<br/><i>the error / the conclusion</i>"]
    end

    CUT --> OUT["30,000 characters<br/>+ an honest marker"]
```

**Why keep the tail?** Because for test runs, builds and stack traces, the
answer you actually want — "3 tests failed" — is at the **end**. A plain
`slice(0, 30000)` would throw away the only part that mattered.

And the order matters:

```mermaid
flowchart LR
    R["redact secrets"] --> C["then cap the size"]
    R -.->|"if you swap these..."| X["a secret sitting on the cut point<br/>gets sliced in half, no longer matches<br/>the pattern, and half of it leaks"]
```

## The code

```ts
const MAX_CHARS = 30_000;
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 10_000;

export function capOutput(text: string): string {
  if (text.length <= MAX_CHARS) return text;

  const elided = text.length - HEAD_CHARS - TAIL_CHARS;
  return (
    text.slice(0, HEAD_CHARS) +
    `\n\n[... ${elided} characters elided ...]\n\n` +
    text.slice(text.length - TAIL_CHARS)
  );
}
```

**`30_000`** — underscores are just visual separators in JS numbers.
`30_000 === 30000`. Easier to read at a glance.

**⭐ Why head AND tail, not simple truncation?**

The naive version:

```ts
return text.slice(0, MAX_CHARS);   // ❌ throws away the end
```

But the end is usually where the answer is:

- A log file → the **last** lines have the error
- A test run → the **last** lines have pass/fail
- A stack trace → the **last** lines have the cause

Keeping head *and* tail means the model sees how the output starts **and** how it
ended. In the demo we ran, `demo/big-log.txt` was 90,093 characters, and the
model could still tell you the last line — because the tail survived.

**The elision marker matters too.** `[... 60093 characters elided ...]` tells the
model explicitly that content is missing. Without it, the model might think the
file simply ends there and reason from a false premise.

### normalizeToolResult

```ts
/**
 * The single boundary every tool result crosses before it reaches model
 * context (ARCHITECTURE §4: normalize -> output limiting -> context update).
 *
 * Redaction runs before capping, so a secret straddling the cut point cannot
 * survive as a half-string.
 */
export function normalizeToolResult(result: ToolResult): ToolResult {
  return result.success
    ? { success: true, content: capOutput(redact(result.content)) }
    : {
        success: false,
        error: capOutput(redact(result.error)),
        retryable: result.retryable,
      };
}
```

**⭐ Order matters: `redact()` runs first, then `capOutput()`.**

Think about the reverse. Suppose a secret sits exactly at the 20,000-character
boundary. Cap first, and it gets cut in half:

```
...DB_PASSWORD=hunter2corr[... elided ...]
```

Now the pattern no longer matches — the redactor sees a fragment, not a full
assignment. Half a password has leaked.

Redacting first means the secret is `[REDACTED]` *before* any cutting happens.

> **General principle: sanitise before you transform.** Any transformation can
> break the pattern your sanitiser depends on.

**Error messages are redacted too.** Easy to forget — but error text often
quotes the input that failed, which may contain the secret.

---

## Things to remember

1. Three escape routes: `..`, absolute paths, symlinks. Handle all three.
2. `realpath` resolves symlinks. It throws if the path doesn't exist — walk up
   to the nearest existing ancestor.
3. **Always append the path separator** in prefix containment checks.
4. Two layers of redaction: exact known values, plus patterns.
5. Key *names* (`DB_PASSWORD=`) catch secrets that patterns can't.
6. Cap every tool output. Keep head **and** tail.
7. Say explicitly when content was elided.
8. **Redact before capping.**
9. Document limitations you choose not to fix.

## Try it yourself

```bash
mkdir -p demo
printf 'DB_PASSWORD=hunter2correcthorse\nAWS=AKIAIOSFODNN7EXAMPLE\nregion=ap-south-1\n' > demo/leaky.txt
npm run dev
```

Then ask: `read demo/leaky.txt and tell me the DB password`

It will tell you the region and that the password is redacted — because **it
never received the value**. Not "it refused". It genuinely does not have it.

Also try:

- `read ../../etc/passwd` → refused
- `read /etc/hosts` → refused
- `read .env` → refused on the filename

Clean up: `rm -rf demo`

Next: `07-tool-system.md`.
