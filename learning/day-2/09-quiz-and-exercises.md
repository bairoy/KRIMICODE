# 09 — Quiz and Exercises

Answer from memory first. Answers at the bottom.

---

## Part A — Recall

1. Why classify the *call* rather than the tool?
2. `classify()` has no `default` case. What does that buy you?
3. What does the `remembered` flag do, and why is it computed once instead of
   checked twice?
4. Answering "always" to a DESTRUCTIVE call — what happens to *this* call, and
   what happens to the next one?
5. Why is the gate absent from `ToolContext`?
6. Why does killing a spawned shell not kill what it started?
7. What exactly does `detached: true` do, and why is `-pid` meaningful?
8. Why SIGTERM before SIGKILL? Why `.unref()` the escalation timer?
9. Write the injection that breaks `runCommand(\`grep "${pattern}" .\`)`.
10. Why is argv better than escaping the pattern?
11. What does `--` do, and name two tools here that need it.
12. Why does `edit_file` refuse to create files?
13. `old_str` matches three times. Why is picking the first one dangerous?
14. Why `indexOf` instead of a regex to count matches?
15. Why is editing `.env` DESTRUCTIVE rather than WRITE?
16. Why is `search_code` READ even though it spawns a process?
17. grep exits 1. Why is that not a failure?
18. Why `npm test` rather than running the test script directly?
19. Failing tests are `success: false, retryable: false`. Explain both.
20. Why must a stream parser handle tokens split across chunks?
21. Why did the original approval prompt show two identical lines?
22. Why does the gate pass `{before, after}` instead of formatted text?
23. Name the three bugs the test suite caught on its first run.
24. Why is `git_status` READ when CLAUDE.md says tools that "touch git state"
    must be gated?
25. Two different output caps exist — `exec.ts` and `normalize.ts`. What does
    each protect?

---

## Part B — Read the code

Explain every line aloud. Tick when you can.

- [ ] `src/permissions.ts`
- [ ] `src/exec/exec.ts`
- [ ] `src/tools/edit_file.ts`
- [ ] `src/tools/search_code.ts`
- [ ] `src/tools/list_files.ts`
- [ ] `src/tools/git_status.ts`
- [ ] `src/tools/git_diff.ts`
- [ ] `src/tools/run_tests.ts`
- [ ] `src/cli/paste.ts`
- [ ] `src/cli/ansi.ts`

---

## Part C — Break it on purpose

Run `npm test` after each. **Revert every change.**

### C1 — Orphan the processes

In `exec.ts`, change `killGroup` to `child.kill(signal)`.

```bash
npm test 2>&1 | grep -A5 "process group"
```

Then watch it for real:

```bash
npx tsx -e "
import { runCommand } from './src/exec/exec.ts';
await runCommand('sleep 9911 & sleep 9911', { cwd: process.cwd(), timeoutMs: 1000 });
" ; sleep 1; pgrep -f 'sleep 9911' | wc -l
```

Non-zero means orphans. Clean up: `pkill -f 'sleep 9911'`.

### C2 — Open the injection hole

In `search_code.ts`, replace the `runProgram` call with:

```ts
const result = await runCommand(`grep -rn "${input.pattern}" ${target}`, {
  cwd: context.workspaceRoot,
});
```

Run `npm test`. The canary test creates `INJECTED` and fails. **Revert
immediately** — you now have a live command-injection vulnerability.

### C3 — Let "always" cover destructive

In `permissions.ts`, change `const remembered = request.operation !== 'DESTRUCTIVE';`
to `const remembered = true;`.

Two tests fail. Read their names — they state the rule you just broke.

### C4 — Pick the first match

In `edit_file.ts`, delete the `occurrences > 1` block. Then:

```bash
printf 'const x = 1;\nconst y = 2;\nconst x = 1;\n' > /tmp/dup.ts
```

Point the agent at it and change `const x = 1;` to `const x = 99;`. Only one
changes, silently, and you can't tell which without looking.

### C5 — Break the paste filter

In `paste.ts`, make `partialMarkerLength` always return `0`. Run `npm test` —
the split-marker tests fail. That function is the entire chunk-boundary defence.

### C6 — Restore the unreadable diff

In `ansi.ts`, replace the head/tail trimming with `head = 0; tail = 0;`. Ask
the agent to edit a line sitting under a long comment. You've reproduced the
original bug.

### C7 — Leak the environment

In `exec.ts`, make `childEnv()` return `process.env` unchanged. Run `npm test` —
the env-stripping test fails. Then run the agent and ask it to `run_command("env")`
and find your API key in the output. **Revert, and consider the key exposed.**

---

## Part D — Build something

### D1 — `git_log` (recommended)

Write `src/tools/git_log.ts`.

- Input: `{ limit?: number, path?: string }`
- `git log --oneline -n <limit>` via `runProgram`
- `READ` — it doesn't mutate
- Handle exit 128 (not a repo)
- Use `--` before any path
- Register it, and update the registry test

Check yourself: did you write any JSON Schema by hand? Any redaction? Any
capping? Any permission logic? **All four should be "no."**

### D2 — Extend `list_files` with a depth limit

Add `max_depth?: number`. You'll need to track depth per queue entry — the queue
currently holds paths only. Think about what changes.

### D3 — Make the destructive list configurable

Move `run_command`'s `DESTRUCTIVE` patterns into config, read from an env var,
validated with Zod. Consider: is letting an operator *shrink* that list a good
idea? What would you do about it?

### D4 — A `git_commit` tool (design only, don't build)

Write down:

- Its operation class, and why
- Whether "always" should ever cover it
- What the approval prompt shows
- Whether it may commit `.env`, and what enforces that

---

## Part E — Design questions

1. `search_code` is READ so it never prompts, but it does spawn a process. Argue
   the opposite position. What would change your mind?
2. `run_tests` is EXECUTE. But tests are meant to be safe. When is that
   assumption wrong?
3. The paste filter turns newlines into spaces. Design an alternative that keeps
   them. What does it cost?
4. `edit_file` can't create files, so the agent can't write new ones at all. Is
   that right? What would a `create_file` tool need?
5. The gate's memory is per-session and in-memory. What breaks if you persist it
   to disk? What would you need to add?
6. `MAX_ENTRIES = 1000` in `list_files`. What actually goes wrong at 100? At
   100,000?
7. All three bugs the tests found were in code I had *just written and
   reviewed*. What does that suggest about code review versus tests?

---

## Answers to Part A

1. **The same tool can be safe or dangerous depending on its argument.**
   `read_file` on `src/a.ts` versus on `.env`.
2. **Exhaustiveness.** Adding a class stops compiling until you decide its
   policy. A `default` would silently swallow it.
3. It excludes DESTRUCTIVE from standing approvals. Computed once because
   **both** uses must agree — checking twice risks them drifting apart.
4. **This call is approved; nothing is remembered.** The next one asks again.
5. **Least privilege.** A tool that never receives the gate cannot consult,
   re-run, or bypass it.
6. Children are separate processes. Signalling the shell doesn't reach them;
   they get reparented to init and keep running.
7. It makes the child a **process group leader** (`pgid === pid`), and children
   inherit the group. A negative pid signals the whole group.
8. SIGTERM is catchable, so a process can clean up; SIGKILL cannot be ignored.
   `.unref()` stops a pure-cleanup timer from keeping Node alive.
9. `x"; rm -rf ~; echo "` — closes the quote, runs a second command.
10. Escaping is a rule you must remember correctly every time. With argv there
    is **nothing to escape** — no shell parses the value at all.
11. Ends option parsing so a leading `-` is data. Needed by `search_code` and
    `git_diff` (and `grep`/`rg` generally).
12. A typo in `path` would silently create a new file and report success, while
    the intended file went unedited.
13. It's a **coin flip that silently corrupts code** — the edit reports success
    and the wrong line changed.
14. `old_str` is code, full of regex metacharacters (`.`, `[`, `(`). A regex
    would match the wrong things and miss the literal text.
15. DESTRUCTIVE is never covered by a standing approval, so a convenience
    "always" on `edit_file` can't reach `.env`.
16. The program is fixed, arguments are passed as data through `execve`, and
    nothing changes. Prompting constantly would cause approval fatigue.
17. Exit 1 means "no matches found" for grep and ripgrep — an answer. Exit 2 is
    a real error.
18. npm puts `node_modules/.bin` on PATH, which the script depends on.
19. `success: false` — they didn't pass, and the model must not think they did.
    `retryable: false` — re-running changes nothing; fix the code.
20. Streams deliver arbitrary chunks. A multi-byte token can be split, and a
    naive parser emits the fragment and then misreads everything after it.
21. Both sides shared a long first line and were truncated at the same column,
    so the truncation removed the only part that differed.
22. So the CLI owns formatting (ARCHITECTURE §2). It's what let the diff be
    rewritten entirely without touching `permissions.ts`.
23. `extractReasoning(null)` crashed; `loadConfig()` was untestable because it
    read a file and mutated a global; the tool-call accumulator was unreachable
    except through HTTP.
24. Because it **reads** git state and cannot change it. The line is "can this
    change anything?" — a future `git_commit` would be GIT_STATE_CHANGE.
25. `exec.ts` caps while the command runs to protect **memory**;
    `normalize.ts` caps afterwards to protect the **context window**.

---

## Ready for Day 3?

You should be able to:

- [ ] Draw the tool lifecycle including the gate, and say why the gate sits there
- [ ] Explain command injection and why argv fixes it structurally
- [ ] Explain process groups and demonstrate the orphan problem
- [ ] State all five `edit_file` rules and the failure each prevents
- [ ] Decide the operation class for a new tool and defend it
- [ ] Explain why a stream parser must handle split tokens
- [ ] Write a test that recreates a vulnerability rather than describing it

**Known gaps, still open:** no cancellation (Ctrl-C mid-stream), no context
compaction (a long session will eventually exceed the model's window and fail
hard), no lint or formatter.
