# 10 — Quiz and Exercises

Do this **without looking at the code first**. Then check yourself.

---

## Part A — Recall (answers at the bottom)

1. Why is the agent a loop and not a pipeline?
2. Can a language model read a file by itself? Explain what actually happens.
3. In `provider.ts`, why do we group tool-call fragments by `index` and not by
   `id`?
4. Why is `id` set *once* but `arguments` *appended*?
5. Why does the provider emit `tool_call` only after the stream ends?
6. Name the three ways a path can escape the workspace.
7. Why is `realRoot + sep` used instead of just `realRoot` in the containment
   check?
8. Why does `redact()` run *before* `capOutput()`?
9. Why is reasoning shown to the user but never added to `#messages`?
10. Why does `MAX_TURNS` exist?
11. What breaks if you push a `tool` message without first pushing the
    `assistant` message that requested it?
12. Why is `argsJson` typed as a `string` instead of an object?
13. What does `retryable` tell the model, and give one `true` and one `false`
    example?
14. Why must `render.end()` be in a `finally`?
15. Why do relative imports end in `.js` when the files are `.ts`?
16. What is wrong with `if (typeof v === 'object')` on its own?
17. Why does `ToolContext` contain only `workspaceRoot`?
18. Why did we put `defineTool` in `define.ts` instead of `tools/index.ts`?
19. What does `stdout.isTTY` protect against?
20. Why do we never print the whole error object from the OpenAI SDK?

---

## Part B — Read the code and explain

Open each file and explain **out loud** (or in writing) what every line does.
This is the real test.

- [ ] `src/config.ts`
- [ ] `src/types.ts`
- [ ] `src/tools/normalize.ts`
- [ ] `src/exec/workspace.ts`
- [ ] `src/redact.ts`
- [ ] `src/tools/define.ts`
- [ ] `src/tools/read_file.ts`
- [ ] `src/tools/index.ts`
- [ ] `src/agent/agent.ts`
- [ ] `src/provider.ts`
- [ ] `src/index.ts` + `src/cli/` — the CLI, split out of it since

If you get stuck on a line, that's the section to re-read.

---

## Part C — Break it on purpose

The fastest way to understand code is to break it and watch what happens.
**Undo each change afterwards.**

### C1 — Remove the containment separator

In `workspace.ts`, change:

```ts
!real.startsWith(realRoot + sep)
```

to

```ts
!real.startsWith(realRoot)
```

Then:

```bash
mkdir -p ../KRIMICODE-secrets && echo "leaked" > ../KRIMICODE-secrets/x.txt
npm run dev
```

Ask it to read `../KRIMICODE-secrets/x.txt`. It works — that's the bug.
Restore the `+ sep` and confirm it's refused again.

Clean up: `rm -rf ../KRIMICODE-secrets`

### C2 — Swap redact and cap

In `normalize.ts`, change `capOutput(redact(x))` to `redact(capOutput(x))`.

Create a file where a secret sits past the 20,000-character head boundary and
confirm you can leak half of it. Restore the order.

### C3 — Store the reasoning

In `agent.ts`, add `text += event.text;` to the `reasoning_delta` case. Ask
three questions in a row. Watch the model's thinking contaminate its later
answers. Remove it.

### C4 — Break the accumulator

In `provider.ts`, change:

```ts
if (tc.id && !slot.id) slot.id = tc.id;
```

to

```ts
slot.id = tc.id;
```

Ask something that triggers a tool call. Depending on the provider you may get
"Incomplete tool call: missing id". Restore it.

### C5 — Remove the JSON try/catch

In `define.ts`, remove the `try`/`catch` around `JSON.parse`. Then find a way to
make the model emit malformed arguments (asking for a path with lots of quotes
and backslashes sometimes does it). Watch the whole session die instead of one
call failing.

### C6 — Leak the colour

In `cli/renderer.ts`, delete `stdout.write('\x1b[0m')` from `end()`. Trigger an error
mid-reasoning. Your entire shell goes dim, permanently. Run `reset` to recover.

---

## Part D — Build something

### D1 — Add a `list_files` tool (recommended)

Write `src/tools/list_files.ts`.

Requirements:

- Input: `{ path?: string }` — defaults to `'.'`
- Use `resolveInWorkspace()` **before** touching disk
- Use `readdir` from `node:fs/promises` with `{ withFileTypes: true }`
- Mark directories with a trailing `/`
- Skip `node_modules`, `.git`, and `dist`
- Return `{ success: true, content: names.join('\n') }`
- Register it in `src/tools/index.ts`

Then ask the agent: *"what files are in src/tools?"*

Things to check when you're done:

- Does `list_files` on `..` get refused?
- Did you have to write any JSON Schema by hand? (You shouldn't have.)
- Did you have to write any redaction or capping? (You shouldn't have.)

**If the answer to the last two is "no", you've understood the design.**

### D2 — Add a line range to `read_file`

Extend the schema with optional `offset` and `limit`, and return only those
lines. Think about:

- What if `offset` is past the end of the file?
- Should that be `retryable: true` or `false`?
- What `.describe()` text will make the model use it correctly?

### D3 — Add a `/history` command

In `cli/commands.ts`, handle a `/history` command that prints how many
messages are in the conversation. (When this was written there was no
dispatcher and it would have gone in `index.ts` — the exercise is the same, and
the callback on `CommandContext` is now the interesting part.)

You'll notice `#messages` is private. **Don't make it public.** Add a small
read-only accessor on `Agent` instead — and think about why that's better.

---

## Part E — Design questions

No code. Just think.

1. We built `read_file` first, not `edit_file`. Why is reading the safer place
   to start?
2. Step 4 adds a permission gate. Where exactly in the lifecycle must it sit,
   and why not earlier or later?
3. `EXTRA_BODY` lets you inject arbitrary fields into the API request. Is that a
   security risk? Who can set it, and does that change the answer?
4. Our `ARCHITECTURE.md` lists ten interfaces. We built one. Argue *for* the
   other position — when would building them up front be right?
5. `MAX_TURNS = 25`. What actually goes wrong at 5? At 500?
6. Redaction can produce false positives — mangling text that only looks like a
   secret. Is that acceptable? What would change your mind?

---

## Answers to Part A

1. **Because the model decides how many steps are needed.** A pipeline has a
   fixed sequence; here the model may call tools repeatedly before answering.
2. **No.** It only outputs text. It emits a request naming a tool and arguments;
   *our* code decides whether to run it and does the actual work.
3. **`index` is the only field guaranteed present on every delta.** `id` and
   `name` are optional and often missing after the first chunk.
4. **Providers differ.** Some send `id`/`name` once, some repeat them —
   set-once handles both. `arguments` genuinely arrives in pieces, so it must be
   concatenated.
5. **A half-built tool call is useless and dangerous.** Emitting only at the end
   means a `tool_call` event is always complete.
6. `../` traversal, absolute paths, and symlinks.
7. **Without the separator, a sibling folder whose name starts with the root
   name passes.** `/x/project-secrets` starts with `/x/project`.
8. **Capping first could cut a secret in half**, destroying the pattern the
   redactor matches on, leaking a fragment.
9. **Cost and quality.** It would inflate every later request, and models expect
   their past *answers* in history, not scratch work.
10. **To stop an infinite tool loop.** A confused model could otherwise loop
    forever, burning money and context.
11. **The provider rejects the conversation as malformed.** A `tool` message is
    an answer; an answer with no question is invalid.
12. **Because that's what arrives, and it may not be valid JSON.** The type
    tells the truth about what we've verified.
13. **Whether to try again.** `true`: malformed JSON args. `false`: file not
    found.
14. **So terminal state is restored even when an error is thrown**, otherwise
    the spinner keeps running and dim leaks into the shell.
15. **The import path is copied unchanged into the compiled output**, where only
    `.js` files exist.
16. **`typeof null === 'object'`.** You must also check `!== null`, and
    `Array.isArray` if you mean a plain object.
17. **Least privilege.** A tool that never receives the API key or message
    history cannot leak them.
18. **To avoid a circular import** — `read_file.ts` needs `defineTool`, and
    `index.ts` needs `read_file.ts`.
19. **Writing animation frames into piped output**, where there's no cursor to
    move and the frames become garbage in the file.
20. **SDK errors can contain the full request**, including the
    `Authorization: Bearer sk-...` header.

---

## Ready for Day 2?

You should be able to:

- [ ] Draw the agent loop from memory
- [ ] Explain what happens between "model asks for a tool" and "result is in the
      conversation"
- [ ] Add a new tool without copying redaction or validation code
- [ ] Explain why each security check exists and what it stops
- [ ] Point at the three chokepoints and say what each guarantees

**Day 2 is the permission gate** — `y`/`n`/`a` prompts, the `READ`/`WRITE`/
`EXECUTE` classification, and turning the blunt `.env` refusal into a real ask.
Then `edit_file` and `run_command`, which is where getting this right starts to
matter a lot more.
