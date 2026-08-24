# 06 — Testing What You Cannot See

Day 2's testing chapter was about *what is worth testing*. This one is about a
harder situation:

> **How do you test something that only happens after forty turns, against a
> model you would have to pay to call?**

We went from 156 tests to 206. Fifty new tests, none of which touch the
network.

---

## The problem

To test compaction you need a long conversation. To have a long conversation
you need a model. To use a model you need the network, money, and patience —
and you get a *different* answer every time.

That is untestable.

Unless you notice something: **the agent does not need a real model. It needs
something shaped like one.**

```ts
export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

One method. That is the whole interface. Anything with a `stream` method that
yields `ModelEvent`s is a valid provider, as far as the agent is concerned.

> **A narrow interface is a testing superpower.** The smaller the surface, the
> easier it is to stand in front of.

---

## The fake provider

```ts
class FakeProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly #script: (request: ModelRequest) => ModelEvent[];

  constructor(script: (request: ModelRequest) => ModelEvent[]) {
    this.#script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    // Snapshot the messages: the agent mutates its history afterwards, and a
    // live reference would make every recorded request look identical.
    this.requests.push({ ...request, messages: [...request.messages] });
    for (const event of this.#script(request)) yield event;
  }
}
```

It does two jobs:

1. **Records** every request, so we can inspect what the agent sent.
2. **Replies** from a script we control, instantly and identically every time.

### ⭐ The snapshot line

```ts
this.requests.push({ ...request, messages: [...request.messages] });
```

This one line took thought. Miss it and every test lies to you.

`request.messages` is the agent's own array. If we store a **reference** to it,
then when the agent pushes the next message, our stored "request 1" changes
too. Every recorded request would show the final state of history.

You would inspect request 1 and see request 40's content. Your assertions would
pass or fail for reasons that have nothing to do with the code.

`[...request.messages]` copies the array, freezing that moment.

> **When recording history for later inspection, copy it.** A reference is a
> live window, not a photograph.

### Telling the two kinds of call apart

The agent makes two very different requests: real conversation, and
summarization. Tests need to distinguish them. There is a natural marker:

```ts
function isSummarizer(request: ModelRequest): boolean {
  return request.tools === undefined;
}
```

The summarizer is sent **without tools** — deliberately, so it cannot call one
outside the real conversation's permission flow. That design choice doubles as
a free label.

```ts
get summarizerCalls(): ModelRequest[] {
  return this.requests.filter((r) => r.tools === undefined);
}

get conversationCalls(): ModelRequest[] {
  return this.requests.filter((r) => r.tools !== undefined);
}
```

Now a script can behave differently for each:

```ts
const provider = new FakeProvider((request) =>
  isSummarizer(request) ? text('SUMMARY OF EARLIER WORK') : text(LONG_REPLY),
);
```

Read that as: *"when asked to summarize, say `SUMMARY OF EARLIER WORK`;
otherwise give a long answer."*

Because the summary text is a fixed marker string, we can later assert it
actually reached the model:

```ts
assert.match(after.messages[0].content, /SUMMARY OF EARLIER WORK/);
```

> **Make fakes return distinctive markers.** `"SUMMARY OF EARLIER WORK"` is
> traceable; `"ok"` is not.

---

## Testing the whole loop, fast

```ts
test('a long conversation stays inside the budget instead of growing forever', async () => {
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY OF EARLIER WORK') : text(LONG_REPLY),
  );
  const agent = makeAgent(provider);

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);

  assert.ok(provider.summarizerCalls.length > 0, 'compaction never ran');
  for (const request of provider.requests) {
    assert.ok(
      estimateTokens(request.messages) <= BUDGET,
      `a request of ~${estimateTokens(request.messages)} tokens exceeded the ${BUDGET} budget`,
    );
  }
});
```

Twelve full turns, in **under two milliseconds**.

Two assertions, and both matter:

**`summarizerCalls.length > 0`** — proves compaction actually happened. Without
it, a bug that disables compaction entirely would make the second assertion
trivially pass (a short conversation is always under budget). **Always check
that the thing you are testing actually ran.**

**Every request under budget** — the real guarantee, checked on *every* request
rather than just the last.

The failure message includes the numbers, so when it breaks you learn how badly
without opening a debugger.

---

## Shrinking the world to make it testable

```ts
const MAX_CONTEXT = 6_000;
```

Real window: 128,000 tokens. Reaching it in a test would need enormous strings.

But the budget is **configuration**. So we shrink the world: a 6,000-token
window, a few long-ish messages, and compaction triggers in twelve turns.

The logic under test is identical. Only the numbers changed.

> **If a threshold is hard to reach in a test, make the threshold a parameter.**
> This is another case of "hard to test" pointing at a design improvement — a
> hardcoded constant would have made this untestable.

---

## Testing timing

Cancellation depends on *when* things happen. The fake gives you exact control:

```ts
const controller = new AbortController();
const provider = new FakeProvider(() => {
  controller.abort();                              // cancel mid-stream
  return [{ type: 'done', stopReason: 'cancelled' }];
});
```

Or cancel while a specific tool is running, using the agent's own callback:

```ts
const agent = makeAgent(provider, {
  onToolStart: () => controller.abort(),
});
```

`onToolStart` exists for the CLI to print `⚒ read_file`. Here it becomes a
precise trigger: **abort exactly when the first tool begins.**

No sleeps, no race conditions, no flakiness. Deterministic every run.

> **Callbacks that exist for rendering often make excellent test hooks.**

---

## ⭐⭐ Breaking the code on purpose

This is the most valuable thing in this chapter.

The most important new test:

```ts
test('SECURITY: cancelling mid-turn still answers every announced tool call', ...)
```

It passed. **But a test that passes tells you almost nothing.**

It might pass because the code is correct. It might pass because the test never
actually checks anything — a typo in a variable, an assertion in an unreachable
branch, a loop that runs zero times. A useless test looks exactly like a
working one from the outside.

So: **put the bug back and confirm the test screams.**

The correct code:

```ts
const result = signal?.aborted
  ? CANCELLED_RESULT
  : await this.#runToolReported(call, signal);
```

Deliberately broken back to the tempting version:

```ts
if (signal?.aborted) break;
const result = await this.#runToolReported(call, signal);
```

Run the tests:

```
✖ SECURITY: cancelling mid-turn still answers every announced tool call
ℹ pass 14
ℹ fail 1
```

**Now** we know the test is real. It detects exactly the bug it claims to
prevent. Restore the correct code, confirm green again.

This technique is called **mutation testing**: change the code, and check that
a test notices.

The question it answers is not *"does my code work?"* but:

> **"Would I find out if it stopped working?"**

Those are different questions, and only the second one protects you six months
from now.

Worth doing for every test that guards something expensive — security
properties, data integrity, anything whose failure is permanent. Not worth it
for `assert.equal(add(2, 2), 4)`.

**A test you have never seen fail is a test you should not trust.**

---

## Naming that explains itself

Names from the new suites:

```
✔ SECURITY: a cut never orphans a tool message from its assistant call
✔ SECURITY: cancelling mid-turn still answers every announced tool call
✔ REGRESSION: repeated compaction replaces the summary, never appends
✔ REGRESSION: listeners are detached when a command finishes
✔ the newest turn survives compaction verbatim
✔ a cancelled turn returns normally instead of throwing
✔ an empty summary is treated as a failure rather than erasing history
```

Read top to bottom, that is a **specification of the system**. Someone who has
never seen the code learns the rules from the test names alone.

Compare with `✔ compaction test 3`.

---

## Comments that explain the stakes

Several tests carry a comment about *what breaks*:

```ts
test('SECURITY: cancelling mid-turn still answers every announced tool call', async () => {
  // The worst cancellation bug available: bail out of the tool loop early and
  // history holds an assistant tool call with no matching tool message. Every
  // later request is then a hard 400 and the session is unrecoverable — the
  // user cancelled one turn and lost the conversation.
```

Imagine a future developer who finds this test annoying. They are refactoring,
it fails, and they are tempted to "fix" it by deleting it.

That comment is the only thing standing between them and a catastrophe.

> **Write the comment for the person who wants to delete your test.**

---

## Things to remember

1. A narrow interface is easy to fake. `ModelProvider` has one method.
2. A fake that **records** is worth twice one that only replies.
3. Copy arrays when recording, or you store a live window instead of a photo.
4. Give fakes distinctive marker strings so you can trace them.
5. Always assert that the behaviour under test actually ran.
6. Shrink the world — make thresholds configurable — instead of building huge
   fixtures.
7. Use existing callbacks as deterministic timing hooks. No sleeps.
8. ⭐ Mutation-test the important ones: reintroduce the bug, watch it fail,
   revert.
9. "Does it work?" and "would I notice if it broke?" are different questions.
10. Name tests so the list reads as a specification.
11. Comment the stakes, for the person who wants to delete the test.

## Try it yourself

1. Run `npm test` and read only the names of the new tests. Can you describe
   compaction and cancellation from names alone?
2. Delete the `[...request.messages]` copy in `FakeProvider`. Predict which
   tests break and why, then check.
3. Pick any `SECURITY:` test in the project. Reintroduce the bug it guards,
   confirm it fails, revert. Do this for three of them.
4. Write a new test: what happens if the summarizer returns 50,000 characters?
   Should the summary be capped? Decide, then test what you decided.
5. Find a test in the suite that would still pass if you deleted a line of
   production code. If you find one, strengthen it.

Next: `07-concepts-cheatsheet.md`.
