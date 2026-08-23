# 04 — The Model Provider (`src/provider.ts`)

This file is the **only** part of the program that knows how to talk to a model
over HTTP. Everything else works with our own types.

Its job: take a `ModelRequest`, call the API, and turn the streaming response
into a series of `ModelEvent`s.

---

## Concept 1 — Async generators

You'll see this signature:

```ts
async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
```

The `*` makes it a **generator**. `async` + `*` = **async generator**.

A normal function returns once:

```ts
function getNumbers(): number[] {
  return [1, 2, 3];        // all at once, when everything is ready
}
```

A generator **yields** many times, pausing in between:

```ts
function* getNumbers() {
  yield 1;    // hand out 1, pause here
  yield 2;    // resume, hand out 2, pause
  yield 3;
}
```

An *async* generator can `await` between yields — perfect for data arriving over
a network:

```ts
async function* getNumbers() {
  for await (const chunk of networkStream) {
    yield chunk.value;      // hand it out the moment it arrives
  }
}
```

You consume it with `for await`:

```ts
for await (const event of provider.stream(request)) {
  console.log(event);       // runs each time something new arrives
}
```

**Why does this matter here?** Without it, you'd wait for the model's entire
reply before showing anything. With it, text appears as it's generated — which
is why your terminal fills in progressively instead of freezing.

## Concept 2 — Streaming and "deltas"

The model sends its reply in small chunks. Each chunk is a **delta** — a piece,
not the whole thing.

```
chunk 1: { delta: { content: "The" } }
chunk 2: { delta: { content: " scripts" } }
chunk 3: { delta: { content: " are" } }
...
chunk N: { delta: {}, finish_reason: "stop" }
```

Your job as the receiver is to reassemble them.

---

## The code

### Imports and setup

```ts
import OpenAI from 'openai';
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { Config } from './config.js';
import type {
  Message, ModelEvent, ModelProvider, ModelRequest, ToolSpec,
} from './types.js';
```

Note `import type` for everything that's only a type — required by
`verbatimModuleSyntax` (see `01-setup-and-typescript.md`).

> **We're using the `openai` package, but not OpenAI.** That package is just a
> client for a *wire format* that many providers speak. We point it at
> OpenRouter. The name is misleading; think of it as "OpenAI-compatible client".

### The accumulator type

```ts
/** Partially-received tool call, keyed by stream index. */
interface PendingToolCall {
  id?: string;
  name?: string;
  args: string;
}
```

Everything optional except `args` (which starts as `''` and grows). This type
describes a tool call **still being assembled**.

### The class

```ts
export class OpenAICompatibleProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #extraBody: Record<string, unknown>;

  constructor(config: Config) {
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.#extraBody = config.extraBody;
  }
```

**`implements ModelProvider`** — a promise to the compiler: this class has the
methods that interface requires. If you delete `stream()`, you get an error
here, not at some distant call site.

**`#client`** — the `#` makes it a **truly private** field. Not a convention
like `_client`; genuinely inaccessible from outside:

```ts
const p = new OpenAICompatibleProvider(config);
p.#client;   // ❌ syntax error — cannot even be written
```

Why care? `#client` holds the API key. Making it unreachable from outside the
class is a small, free security improvement.

**`baseURL: config.baseURL`** — this line is why you can swap providers by
editing `.env`. Nothing about OpenRouter is written into this file.

### Starting the stream

```ts
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const pending = new Map<number, PendingToolCall>();
    let stopReason = 'stop';

    try {
      const stream = await this.#client.chat.completions.create(
        {
          model: request.model,
          messages: toWireMessages(request.messages),
          stream: true,
          ...(request.tools?.length
            ? { tools: toWireTools(request.tools) }
            : {}),
          // Opaque vendor-specific fields from config. Spread last so an
          // operator can override anything above without a code change.
          ...this.#extraBody,
        },
        request.signal ? { signal: request.signal } : {},
      );
```

**`new Map<number, PendingToolCall>()`** — collects tool-call fragments, keyed by
their stream index. Explained in detail below.

**`stream: true`** — ask for chunks instead of one big response.

**The conditional spread:**

```ts
...(request.tools?.length ? { tools: toWireTools(request.tools) } : {})
```

Reads as: *if there are tools, add a `tools` key; otherwise add nothing.*
Spreading `{}` adds zero keys. This avoids sending `tools: []`, which some
providers reject.

`request.tools?.length` uses **optional chaining** — if `tools` is `undefined`,
the whole expression is `undefined` (falsy) instead of crashing.

**`...this.#extraBody` last** — spread order matters. Later keys overwrite
earlier ones, so an operator can override anything via `.env` without editing
code. That's the point of an escape hatch.

### The main loop

```ts
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) stopReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }
```

**`chunk.choices[0]`** — the API can return several alternative replies. We
asked for one, so we want the first.

**`if (!choice) continue;`** — remember `noUncheckedIndexedAccess`? That flag
makes `choices[0]` typed as `Choice | undefined`, forcing this check. It looks
like paranoia. It isn't: some providers send an empty `choices` array in their
final chunk. Without this line, that's a crash.

**`if (delta.content)`** — skips both `undefined` and `''`. No point emitting an
empty text event.

**`yield`** — hands the event to whoever is looping, then pauses here until they
ask for the next one.

### Reasoning

```ts
        const reasoning = extractReasoning(delta);
        if (reasoning) {
          yield { type: 'reasoning_delta', text: reasoning };
        }
```

Covered below in `extractReasoning`.

### ⭐ The tool-call accumulator — the important part

```ts
        for (const tc of delta.tool_calls ?? []) {
          let slot = pending.get(tc.index);
          if (!slot) {
            slot = { args: '' };
            pending.set(tc.index, slot);
          }
          // Set-once: some providers repeat id/name on every chunk.
          if (tc.id && !slot.id) slot.id = tc.id;
          if (tc.function?.name && !slot.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
```

**The problem this solves.** A tool call arrives split across many chunks:

```
chunk 1: tool_calls: [{ index: 0, id: "call_abc", function: { name: "read_file", arguments: "" } }]
chunk 2: tool_calls: [{ index: 0, function: { arguments: "{\"pa" } }]
chunk 3: tool_calls: [{ index: 0, function: { arguments: "th\":\"a." } }]
chunk 4: tool_calls: [{ index: 0, function: { arguments: "txt\"}" } }]
```

Only after chunk 4 do you have `{"path":"a.txt"}`.

**Why `index` is the key.** We checked the SDK's actual type definition and
found:

```ts
interface ToolCall {
  index: number;        // ← required
  id?: string;          // ← optional
  function?: {          // ← optional
    name?: string;
    arguments?: string;
  };
}
```

**`index` is the only field guaranteed to be present.** Everything else may be
missing from any given chunk. So `index` is the only safe thing to group by.

It also handles **parallel tool calls** — if the model asks for two tools at
once, their fragments interleave with `index: 0` and `index: 1`. The Map keeps
them separate automatically.

**Why "set-once" for id and name.** Some providers send `id` and `name` once, on
the first chunk. Others repeat them on every chunk. `if (tc.id && !slot.id)`
handles both: take it the first time, ignore repeats.

If we'd written `slot.id = tc.id` unconditionally, a provider that sends `id`
only on chunk 1 would have it wiped to `undefined` on chunk 2.

**Why `+=` for arguments.** Arguments genuinely arrive in pieces, so they must
be concatenated. This is the one field that accumulates.

> **The general lesson:** "OpenAI-compatible" is a loose promise. Providers agree
> on the broad shape and disagree on details. Write your reader to accept the
> widest reasonable behaviour, not just the one provider you tested against.

### Emitting complete tool calls

```ts
      // Emit only complete tool calls, in the order the model produced them.
      for (const [index, slot] of [...pending.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        if (!slot.id || !slot.name) {
          yield {
            type: 'error',
            message: `Incomplete tool call at index ${index}: missing ${!slot.id ? 'id' : 'name'}.`,
          };
          continue;
        }
        yield {
          type: 'tool_call',
          id: slot.id,
          name: slot.name,
          argsJson: slot.args,
        };
      }

      yield { type: 'done', stopReason };
```

This runs **after** the chunk loop finishes — that is, after the stream ends.

**Why wait?** Because a half-built tool call is worse than useless. By emitting
only here, anything downstream can trust that a `tool_call` event is complete.

**`[...pending.entries()].sort((a, b) => a[0] - b[0])`**

- `pending.entries()` gives `[key, value]` pairs
- `[...]` turns that iterator into an array
- `.sort((a, b) => a[0] - b[0])` sorts by key (the index), ascending

Map preserves insertion order, not numeric order. Sorting guarantees tools run
in the order the model intended.

**The completeness check** — if a provider misbehaves and never sends an `id` or
`name`, we emit an error event instead of a broken tool call. We do not guess.

### Error handling

```ts
    } catch (err) {
      // Message only. Never surface the error object — SDK errors can carry
      // request details including headers.
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
```

The whole method body is wrapped in `try`. Network failure, bad key, provider
outage — all become an `error` **event** rather than a thrown exception.

**Why an event and not a throw?** Because a generator that throws mid-stream
leaves the consumer in a messy half-state. Emitting an event lets the consumer
finish its loop cleanly and decide what to do.

**The security note is real.** SDK error objects can contain the full request —
including the `Authorization: Bearer sk-...` header. Logging `err` directly
would print your API key. We take `err.message` only.

**`err instanceof Error ? err.message : String(err)`** — in JavaScript you can
`throw` anything, not just `Error` objects. This handles both.

---

## The translation functions

### toWireMessages

```ts
function toWireMessages(
  messages: readonly Message[],
): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        return m.toolCalls?.length
          ? {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argsJson },
            })),
          }
          : { role: 'assistant', content: m.content };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}
```

**This is the boundary.** Our `Message` type goes in; the SDK's type comes out.
The entire "we don't leak provider types into the core" promise lives in this
one function.

Notice the naming differences it absorbs:

| Ours | Wire format |
|---|---|
| `toolCalls` | `tool_calls` |
| `toolCallId` | `tool_call_id` |
| `argsJson` | `function.arguments` |

We use `camelCase`; the API uses `snake_case`. Translating in one place means
the rest of the codebase never thinks about it.

**`content: m.content || null`** — when the assistant only calls a tool with no
text, the API wants `null`, not `''`. `||` converts the empty string to `null`.

**`type: 'function' as const`** — without `as const`, TypeScript widens the type
of `'function'` to `string`. The SDK wants the exact literal `'function'`.
`as const` says "keep this as the specific value, don't generalise it".

**No `default` case needed** — `Message` is a discriminated union with four
variants, and we handled all four. TypeScript verifies the function always
returns.

### extractReasoning

```ts
/**
 * Reasoning tokens are outside the OpenAI-compatible surface and vendors
 * disagree on the shape: Z.ai native uses `reasoning_content`, OpenRouter uses
 * `reasoning` plus a structured `reasoning_details`. Treat all three as
 * untrusted and narrow before use.
 */
function extractReasoning(delta: unknown): string {
  const d = delta as {
    reasoning?: unknown;
    reasoning_content?: unknown;
    reasoning_details?: unknown;
  };

  if (typeof d.reasoning === 'string') return d.reasoning;
  if (typeof d.reasoning_content === 'string') return d.reasoning_content;

  if (Array.isArray(d.reasoning_details)) {
    return d.reasoning_details
      .map((part) => {
        if (typeof part !== 'object' || part === null) return '';
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }

  return '';
}
```

**The problem:** "reasoning models" (like GLM-4.6) think before answering, and
send that thinking separately. But this isn't part of the OpenAI spec, so every
vendor invented their own field name:

| Vendor | Field |
|---|---|
| Z.ai (native) | `reasoning_content` (string) |
| OpenRouter | `reasoning` (string) |
| OpenRouter | `reasoning_details` (array of objects) |

**Why `delta: unknown`?** Because the SDK's type doesn't include these fields —
they're non-standard. We take it as `unknown` and narrow it ourselves.

**Look at the narrowing pattern:**

```ts
if (typeof d.reasoning === 'string') return d.reasoning;
```

We don't assume. We *check* the type, then use it. Inside the `if`, TypeScript
knows it's a string.

Same in the array branch: check it's an object, check it's not null (remember
`typeof null === 'object'`), check `.text` is a string. Every step verified.

Compare to the lazy version:

```ts
return (delta as any).reasoning;    // ❌ could be anything. Crashes downstream.
```

Our `CLAUDE.md` bans `any` without justification, and this is why. `unknown`
plus explicit checks is barely more code and cannot lie to you.

**Returns `''` when nothing matches** — a normal model with no reasoning just
gets an empty string, and the caller's `if (reasoning)` skips it. No special
case needed.

### toWireTools

```ts
function toWireTools(
  tools: readonly ToolSpec[],
): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
```

Our `ToolSpec` → the wire format's nested shape.

> **Version note:** we used `ChatCompletionFunctionTool`, not
> `ChatCompletionTool`. In openai v7, `ChatCompletionTool` became a *union* of
> function tools and custom tools. We checked the installed package rather than
> guessing — worth doing whenever a library has recently changed major version.

---

## Things to remember

1. `async function*` + `yield` + `for await` = streaming.
2. Streaming responses arrive as **deltas** you must reassemble.
3. Group tool-call fragments by **`index`** — the only guaranteed field.
4. Set `id`/`name` **once**; **append** `arguments`.
5. Emit a tool call only when **complete**.
6. Never log an error object from an HTTP client — take `.message`.
7. Translate to library types in **one** function, at the edge.
8. `unknown` + explicit checks, never `any`.
9. Check the installed library's types instead of trusting memory.

## Try it yourself

Add this inside the chunk loop temporarily, then run a query:

```ts
console.error('\nCHUNK:', JSON.stringify(chunk.choices[0]?.delta));
```

Watch the raw fragments arrive. You'll see text coming a few characters at a
time, and — if you ask something requiring a tool — you'll see `arguments`
building up piece by piece. Remove it when you're done.

Next: `05-agent-loop.md`.
