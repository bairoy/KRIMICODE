# 2 · Writing For A Machine You Cannot Run

> Windows support, written on a Mac, and how to make that honest.

---

## The uncomfortable request

The project was POSIX-only. Three things guaranteed it:

```ts
runCommand → '/bin/sh'                 // does not exist on Windows
spawn(..., { detached: true })          // means something else on Windows
process.kill(-pid, 'SIGTERM')           // there are no process groups on Windows
```

The honest options were: declare it POSIX-only and guard it, or write Windows
support **blind** — code that neither you nor your machine can execute.

Writing blind is normally how you ship something broken. So the interesting
question is not *"should we?"* but:

> **How do you write code for a platform you cannot run, and still have
> evidence it works?**

The answer has two halves, and both matter.

---

## Half one — make the decisions pure

Every place the behaviour must differ went into one file, `src/platform.ts`,
as functions that **take the platform as an argument** instead of asking the
computer they are running on.

```mermaid
flowchart LR
    subgraph BAD["the tempting way"]
        direction TB
        B1["if (process.platform === 'win32')<br/>scattered through 6 files"]
        B2["only ever runs one branch<br/>on your machine"]
        B1 --> B2
    end

    subgraph GOOD["what we did"]
        direction TB
        G1["shellInvocation(cmd, platform)<br/>isInside(a, b, platform)"]
        G2["both branches testable<br/>from a Mac"]
        G1 --> G2
    end

    style BAD fill:#f8d7da,stroke:#721c24,color:#4a0f16
    style GOOD fill:#d4edda,stroke:#155724,color:#0b2e13
```

The difference is enormous and it is only one parameter.

`if (process.platform === 'win32')` can only ever take one branch on your
machine. The Windows path is *unreachable* — you could type anything there and
never know.

`shellInvocation(command, 'win32')` is a pure function you can call from a test
on a Mac and assert on the result. The Windows branch becomes ordinary code.

```ts
test('a shell command runs under cmd.exe on Windows', () => {
  const invocation = shellInvocation('dir', 'win32', 'C:\\Windows\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', '"dir"']);
});
```

That test runs on your Mac, right now, and it genuinely checks the Windows
decision.

> ⭐ **Take the environment as a parameter, not as a fact. A function that asks
> the world what it is can only be tested in one world.**

---

## Half two — make the real machine vote

Pure functions prove the *decisions*. They cannot prove that `cmd.exe` actually
accepts those arguments, or that `taskkill` really kills a tree.

So `windows-latest` went into the CI matrix. Now the whole suite runs on a real
Windows machine on every push. "Untested" became "tested by a machine on every
commit."

> ⭐ **Blind code plus CI on the real platform is not blind. Blind code alone
> is a guess you have written down.**

---

## The three things that differ

### 1 · The shell

```ts
POSIX:    /bin/sh  -c  "<command>"
Windows:  cmd.exe  /d /s /c  "<command>"     + windowsVerbatimArguments
```

`/d` skips any AutoRun registry command, `/s` gives documented quoting for what
follows, `/c` runs and exits. This mirrors exactly what Node itself builds for
`shell: true`.

`windowsVerbatimArguments` is the subtle one. Node normally re-quotes each
argument for `CreateProcess`. If you have already quoted a command line for
`cmd.exe`, that second quoting mangles it. Verbatim says *"I have done this,
pass it through."*

### 2 · Killing

This is the CLAUDE.md non-negotiable — kill the **group**, never just the
child, or grandchildren survive.

```mermaid
flowchart TD
    subgraph POSIX
        direction TB
        P1["detached: true<br/>→ child leads a new group"] --> P2["kill(-pid, SIGTERM)"]
        P2 --> P3["3s grace"] --> P4["kill(-pid, SIGKILL)"]
    end

    subgraph WINDOWS
        direction TB
        W1["detached: false<br/>(on Windows it means<br/>'new console window')"] --> W2["taskkill /pid N /T /F"]
        W2 --> W3["no grace period —<br/>/F is already forced"]
    end

    style P4 fill:#d4edda,stroke:#155724,color:#0b2e13
    style W3 fill:#fff3cd,stroke:#856404,color:#4d3a02
```

Two traps here, and both are the kind you only find by reading documentation
rather than guessing:

- On Windows, `detached: true` does **not** create a process group. It means
  "give this its own console window" — the opposite of helpful. So it is set
  on POSIX only.
- Windows has no graceful signal that console programs reliably honour, so
  there is nothing to escalate *from*. `taskkill /F` is the first and only
  blow. **A command interrupted on Windows does not get to clean up.** That is
  a real behavioural difference, and it is written in the README rather than
  hidden.

> ⭐ **When a platform genuinely cannot do what the other one does, document
> the difference. Do not paper over it and let the user discover it.**

### 3 · Paths — and a real security bug

This one was not a portability wart. It was a **boundary bug**.

The workspace check looked like this:

```ts
if (real !== realRoot && !real.startsWith(realRoot + sep)) → refuse
```

A plain string comparison. Now:

> On Windows, `C:\Work\proj` and `c:\work\proj` are **the same directory**.

A case-sensitive comparison says they are different. So a path genuinely inside
the workspace could be read as outside it — or, with a root differing only in
case, the reverse.

That is the check protecting every file operation in the program.

```ts
export function isInside(child, root, platform): boolean {
  const fold = (p) => isWindows(platform) ? p.toLowerCase() : p;
  ...
}
```

Two details in three lines, both deliberate:

**`toLowerCase`, not `toLocaleLowerCase`.** Under a Turkish locale the latter
maps a dotted capital `I` to a dotless `ı`, which would make your security
boundary depend on the machine's language settings. Genuinely.

**POSIX stays case-sensitive.** On Linux `/Work` and `/work` really *are*
different directories. The Windows fix must not leak across and loosen the
check everywhere else — so there is a test asserting exactly that.

---

## Proving the boundary fix was real

It would be easy to write this and assume it works. Instead, the check was
mutated on purpose — the separator dropped, reverting it to the classic
prefix bug:

```ts
c.startsWith(r.endsWith(sep) ? r : r + sep)   // correct
c.startsWith(r)                                // the bug
```

Result: **six tests went red**, including two pre-existing symlink tests from
Day 1 that had nothing to do with Windows.

That is the proof that `isInside` is genuinely load-bearing and not decorative.

> ⭐ **A test you have never seen fail is a test you should not trust. Put the
> bug back, watch it go red, then revert.** (Same rule as Day 3. It keeps
> earning its place.)

---

## The trap: reintroducing a shell

On Windows, `npm` is `npm.cmd` — a batch file. And Node **refuses** to spawn a
batch file without a shell (the fix for CVE-2024-27980). So `run_tests` has to
go through `cmd.exe`.

Which means a shell comes back. And a shell is exactly what `runProgram` exists
to avoid.

The weak answer is a comment saying "only use this with fixed arguments." The
answer we used makes the mistake **unexpressible**:

```ts
const CMD_METACHARACTERS = /[&|<>^"'`%\r\n]/;

for (const part of parts) {
  if (CMD_METACHARACTERS.test(part) || part.includes(' ')) {
    throw new Error(`Refusing to route "${part}" through cmd.exe: ...`);
  }
}
```

Try to pass model-supplied text through `runShim` and it throws at the
boundary. It cannot silently become an injection.

> ⭐ **When you must reintroduce a hazard, put a guard on it that fails loudly.
> "Remember not to do X" is not a security control. Code that refuses to do X
> is.**

---

## Things to remember

1. **Take the platform as a parameter.** It turns unreachable branches into
   ordinary testable code.

2. **Pure functions + CI on the real OS.** Neither alone is enough; together
   they are honest.

3. **`detached: true` means different things on different systems.** Read the
   docs for the platform you cannot run.

4. **Case-insensitive filesystems break string-comparison boundaries.** This is
   a security bug, not a cosmetic one.

5. **`toLowerCase`, never `toLocaleLowerCase`, for security comparisons.**

6. **If you must bring back a shell, guard it so misuse throws.**

---

## Try it yourself

**1 — Feel the difference a parameter makes.**
Open `src/platform.ts` and rewrite `isInside` to read `process.platform`
directly instead of taking it as an argument. Now try to keep
`src/tests/platform.test.ts` passing. You cannot — half those tests become
unwritable. Revert.

**2 — Re-run the mutation.**
Change `c.startsWith(r.endsWith(sep) ? r : r + sep)` to `c.startsWith(r)` and
run `npm test`. Count the failures. Note which ones are from Day 1. Revert.

**3 — Try to smuggle a command.**
In a Node REPL, call
`shimInvocation('npm', ['test && whoami'], 'win32', 'cmd.exe')`.
Watch it throw. That is the guard doing its job.
