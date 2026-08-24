# 08 — Quiz and Exercises

Answer from memory first. Answers at the bottom.

---

## Part A — Recall

1. The model has no memory. So how does a conversation work?
2. Why does an agent's history grow faster than a chat's?
3. Running out of context is worse than a normal error. Why exactly?
4. Name the four things competing for space in the context window.
5. Why is `reserveTokens` clamped at **both** ends?
6. Why not use a real tokenizer library?
7. Why 3 characters per token rather than 4?
8. A message has `content: ''` and 900 characters of `argsJson`. What does a
   naive estimator say, and what actually gets sent?
9. Why add a fixed cost per message?
10. Why is compaction checked inside the turn loop rather than once per user
    message?
11. What welds an `assistant` tool call to its `tool` result?
12. Define "orphaned tool result" and state what it costs.
13. Why is a `user` message the only safe cut point?
14. `planCompaction` returns `null`. What does that mean, and why is it not a
    failure?
15. Why keep **two** recent turns instead of one?
16. `shrinkToolResults` blanks tool results. Why must it never delete them?
17. Why is `ELIDED_TOOL_RESULT` a JSON string rather than `[removed]`?
18. Why is elided history sent to the summarizer as text, not as messages?
19. Where does the summary live, and why not as its own message?
20. What breaks if the second compaction ignores the first summary?
21. Why must `composeSystem` rebuild from `SYSTEM_PROMPT` rather than append?
22. Why does an empty summary count as a failure?
23. Why does `mechanicalDigest` announce that it is a digest?
24. The `signal` field existed on `ModelRequest` from day one. What was wrong?
25. Who holds the controller, who gets the signal, and why the split?
26. Why a fresh `AbortController` for every turn?
27. What happens on Ctrl-C during a permission prompt without the signal?
28. Why does an aborted stream yield `done` instead of `error`?
29. Why is the cancellation check placed **before** the permission gate?
30. Why is `cancelled` a separate flag from `timedOut`?
31. Why not spawn a command whose signal is already aborted?
32. Why must `removeEventListener` run on every exit path?
33. ⭐ The model asks for three tools. You cancel during the first. Why is
    `break` catastrophic, and what do we do instead?
34. Where is it safe to return early from `send()`?
35. Why throw away a summary that was interrupted?
36. What went wrong with the ripgrep cache, and what is the general rule?
37. Why does `FakeProvider` copy `request.messages`?
38. How do the tests tell a summarization call from a conversation call?
39. Why assert `summarizerCalls.length > 0` as well as the budget?
40. What question does mutation testing answer that a passing test does not?

---

## Part B — Read the code

Explain every line aloud. Tick when you can.

- [ ] `src/context.ts` — `estimateTokens`
- [ ] `src/context.ts` — `planCompaction`
- [ ] `src/context.ts` — `shrinkToolResults`
- [ ] `src/context.ts` — `composeSystem`
- [ ] `src/context.ts` — `renderTranscript` / `renderMessage`
- [ ] `src/context.ts` — `buildSummaryRequest`
- [ ] `src/context.ts` — `mechanicalDigest`
- [ ] `src/agent.ts` — `send`
- [ ] `src/agent.ts` — `#compactIfNeeded`
- [ ] `src/agent.ts` — `#summarize`
- [ ] `src/exec.ts` — `terminate` / `onAbort` / `finish`
- [ ] `src/index.ts` — the SIGINT handler and the REPL `finally`

---

## Part C — Break it on purpose

Run `npm test` after each. **Revert every change.**

### C1 — Cut in the wrong place

In `planCompaction`, change the cut-point test:

```ts
if (history[i]?.role === 'assistant') starts.push(i);
```

Run `npm test`. Read the name of the failing test — it states the rule you
broke.

### C2 — ⭐ Orphan the tool calls

In `agent.ts`, replace the cancel branch in the tool loop with:

```ts
if (signal?.aborted) break;
const result = await this.#runToolReported(call, signal);
```

Run `npm test`. Exactly one test fails. **This is the mutation test from
Chapter 06 — you are reproducing it yourself.** Revert.

### C3 — Delete instead of blank

In `shrinkToolResults`, remove the message rather than blanking it:

```ts
out.splice(i, 1);
```

Run `npm test`. Explain each failure before reading the names.

### C4 — Make the summary append

In `composeSystem`, append the new summary to the previous composed content
instead of to `basePrompt`. Run `npm test` and read the REGRESSION test.

Then reason about it: how many compactions before the system message alone
fills the window?

### C5 — Forget the arguments

Delete the `assistant` branch from `estimateTokens`. Run `npm test`.

Then think: which real-world conversation would this under-count worst?

### C6 — Freeze instead of cancel

Remove the `{ signal }` option from `rl.question` in `index.ts`. Run the agent,
trigger a permission prompt, press Ctrl-C. Nothing happens — the program is
stuck. Ctrl-\ to escape. Revert.

### C7 — Orphan the processes on cancel

In `exec.ts`, make `onAbort` call `child.kill('SIGTERM')` instead of
`terminate()`. Then:

```bash
npx tsx -e "
import { runCommand } from './src/exec.ts';
const c = new AbortController();
setTimeout(() => c.abort(), 500);
await runCommand('sleep 9912 & sleep 9912', { cwd: process.cwd(), timeoutMs: 60000, signal: c.signal });
" ; sleep 1; pgrep -f 'sleep 9912' | wc -l
```

Non-zero means orphans. Clean up with `pkill -f 'sleep 9912'`. Revert.

### C8 — Poison the ripgrep cache

Delete `if (probe.cancelled) return false;` from `search_code.ts`. Run the
agent, start a search, Ctrl-C during the probe, then search again.

You are now silently on grep for the rest of the session. Note how nothing told
you. Revert.

### C9 — Leak the listeners

Delete the `removeEventListener` line in `exec.ts`. Run `npm test` and read the
REGRESSION test. Then reason about how long a session would run before Node
warned you.

---

## Part D — Build something

### D1 — A `/compact` command (recommended)

Let the user force a compaction from the REPL instead of waiting for the
budget.

- Handle `/compact` in the REPL loop alongside `/exit`
- The agent needs a public method — think about what it should return
- What happens if there is nothing to elide? (`planCompaction` returns `null`)
- Print the same `⟳ compacted context` line

Check yourself: did you have to touch `planCompaction`, `composeSystem`, or
`shrinkToolResults`? **All three should be "no."**

### D2 — A `/context` command

Print the current token estimate, the budget, how many messages are in history,
and whether a summary exists. Two lines of output.

Which existing function gives you every number for free?

### D3 — Warn before compacting

Show a dim line at 80% of budget: `context 80% full — compacting soon`.

Consider: where does the check go so it fires **once** rather than on every
request?

### D4 — Cancel with a reason (design only, don't build)

Right now cancellation is a bare abort. Suppose you wanted timeout-driven
cancellation *and* user cancellation, distinguished in the result. Write down:

- How would the reason travel with the signal?
- What would `CANCELLED_RESULT` become?
- Would `CommandResult` still need both `timedOut` and `cancelled`?

### D5 — Persist the summary

Save `#summary` to disk so a new session can resume with prior context.

Write down before coding: what could go wrong with restoring a summary written
by a **different model**? What about one containing content from a file the
user has since deleted — or a secret?

---

## Part E — Design questions

1. `keepRecentTurns` is 2. Argue for 1, and for 5. What would change your mind?
2. Compaction costs an extra model call at the worst possible moment — mid-turn,
   while the user waits. Design an alternative that avoids the wait. What does
   it cost you?
3. The summary is written by the same model doing the work. What could go wrong?
   Would a smaller, cheaper model be better here?
4. `CHARS_PER_TOKEN = 3` over-estimates for prose. When would over-estimating
   actually hurt?
5. We fold the summary into the system prompt. What happens if the summary
   grows to 50,000 characters? Is anything stopping that?
6. Cancelling mid-summarization throws the work away. Argue for keeping it
   instead.
7. `shrinkToolResults` blanks the **oldest** first. When would newest-first be
   better?
8. A cancelled tool call returns `retryable: false`. Should the model be allowed
   to retry after a cancellation? Who decides?
9. Chapter 03 and Chapter 05 describe the same class of bug. Name a third place
   in this codebase where the same principle applies.

---

## Answers to Part A

1. We re-send the whole history on every request. "Memory" is an illusion
   created by repetition.
2. Tool results go into history. One capped result can be 30,000 characters,
   and a turn may contain many.
3. The oversized history is still there on the next request, so every attempt
   to recover makes it bigger. **The recovery path is gone.**
4. System prompt, tool specs, conversation history, and the model's reply.
5. Without the **floor**, a tiny window reserves almost nothing and the reply
   cannot fit. Without the **ceiling**, a huge window wastes 200,000 tokens on
   a 500-token reply.
6. Every model tokenizes differently and the endpoint is swappable. **An exact
   count for the wrong model is worse than an honest estimate** — it is a wrong
   answer delivered confidently.
7. It over-estimates, so we compact slightly early. Early costs one summary;
   late costs the session.
8. Naive: roughly zero. Reality: ~300 tokens. That gap is how an estimate reads
   "well under budget" for a request that then gets rejected.
9. Each message costs role and JSON scaffolding. Without it, 500 tiny messages
   look 5× cheaper than they are.
10. One turn can make up to 30 tool calls. It can blow the window open without
    the user typing anything. **Check where it can grow.**
11. The tool call **id**. The assistant announces id `abc`; the tool message
    answers id `abc`.
12. A `tool` message whose announcing `assistant` message was removed. The
    provider returns 400, and since the bad history persists, **every later
    request fails too**.
13. A user message starts a fresh request, so everything before it is finished
    business and everything after is self-contained. **Nothing is mid-sentence
    there.**
14. "I have no safe move." Being over budget is bad; corrupting history is
    worse. Refusing is correct.
15. Conversations reference backwards — "now edit *that* function". One turn
    keeps only what you just typed and loses the referent.
16. Deleting a `tool` message orphans the assistant call that produced it. The
    skeleton must stay; only the flesh goes.
17. The system prompt promises tool results are that shape. A bare marker would
    read as corrupted data rather than a failed call.
18. The elided range routinely begins or ends mid-turn, so sending it
    structurally could create the very orphan we are avoiding. **Text has no
    structure to violate.**
19. Folded into the single system message. A second `system` message breaks
    chat templates that allow only one; a `user` message reads as an
    instruction from the user.
20. Everything the first summary preserved is silently lost. Nothing must
    vanish in one step.
21. Appending would grow the system message on every compaction — **the code
    preventing context overflow would cause it**.
22. A model returning whitespace has not succeeded just because it did not
    throw. "It didn't crash" ≠ "it worked."
23. So the model knows the record is incomplete and asks the user instead of
    **inventing** the missing details.
24. Nothing ever passed one. The agent called `stream()` without `signal`, so
    the whole mechanism was decorative — and looked exactly like a working
    feature.
25. The controller stays at the top (`index.ts`); the signal is handed down.
    Downstream code can observe but not decide — least privilege, same idea as
    keeping the gate out of `ToolContext`.
26. They are single-use. Reuse one and every turn after the first Ctrl-C is
    instantly cancelled.
27. The code is inside `await rl.question(...)` waiting for a line that never
    comes. **The program hangs — cancel becomes freeze.**
28. The user chose it. It is not a failure, and the agent throws on `error`,
    which would print a scary message for pressing the key we documented.
29. Otherwise a permission prompt appears asking approval for work that has
    already been abandoned.
30. They give opposite advice: **timed out** → maybe retry with a longer
    timeout; **cancelled** → do not retry.
31. Starting a process only to kill it can still leave side effects — a file
    written, a port bound — in the milliseconds before the signal lands.
32. One controller covers every command in a turn. Twenty tool calls means
    twenty listeners on the same signal, and Node eventually warns about a
    leak.
33. `break` leaves tools b and c **announced but unanswered** — two orphaned
    tool calls, so every later request is a 400 and the conversation is dead.
    Instead we finish the loop, pushing `CANCELLED_RESULT` for each remaining
    call without executing it.
34. At the **top of the turn loop**, where every announced call already has its
    result.
35. The interrupted summary falls back to the crude digest, and that digest
    would be written into history **permanently**. Better to leave history
    alone and compact properly next turn.
36. A cancelled probe returned `success: false`, which got cached — so one
    Ctrl-C disabled ripgrep for the whole session, silently. Rule: **never
    cache a result you were interrupted while obtaining.**
37. `request.messages` is the agent's live array. Storing a reference means
    every recorded request shows the *final* history. A copy is a photograph;
    a reference is a window.
38. The summarizer is sent **without tools** (`request.tools === undefined`) —
    a design decision that doubles as a free label.
39. Otherwise a bug that disables compaction entirely makes the budget
    assertion pass trivially, since a short conversation is always under
    budget. **Always check the behaviour under test actually ran.**
40. Not "does my code work?" but **"would I find out if it stopped working?"**
    A useless test looks identical to a working one until you make it fail.

---

## Ready for Day 4?

You should be able to:

- [ ] Explain why running out of context is unrecoverable, not just annoying
- [ ] Estimate tokens and say why the estimate leans high on purpose
- [ ] Define an orphaned tool result and name every place one could appear
- [ ] Justify `user` messages as the only safe cut point, from first principles
- [ ] Explain why the summary lives inside the system prompt
- [ ] Trace an `AbortSignal` through all four layers from memory
- [ ] Explain why `break` in the tool loop is catastrophic
- [ ] Write a fake provider and explain why it copies the message array
- [ ] Mutation-test one of your own tests

**Known gaps, still open:** `MAX_TURNS` throws a bare error instead of failing
gracefully; no lint or formatter; no CI. `CommandResult` in `ARCHITECTURE.md`
no longer matches the code — it gained a `cancelled` field.
