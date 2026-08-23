# 03 — Types and Contracts (`src/types.ts`)

This file has **no logic**. It defines the shapes that every other file agrees
on. Think of it as the vocabulary of the project.

---

## The concept: discriminated unions

This is the single most useful TypeScript pattern in the codebase. Learn it
properly and a lot of code becomes obvious.

A **union** means "one of these":

```ts
type Answer = string | number;
```

A **discriminated union** adds a shared field whose value tells you *which* one
you have:

```ts
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; side: number };
```

`kind` is the **discriminant**. Now TypeScript can narrow:

```ts
function area(shape: Shape): number {
  if (shape.kind === 'circle') {
    return Math.PI * shape.radius ** 2;   // ✅ TS knows radius exists here
  }
  return shape.side ** 2;                 // ✅ TS knows side exists here
}
```

Inside the `if`, TypeScript **knows** it's a circle, so `shape.radius` is valid
and `shape.side` would be an error. You get this for free, with no casts.

Why this matters: it makes illegal states impossible. There is no way to build a
`Shape` that has both `radius` and `side`, or neither.

---

## The code

### ToolCall

```ts
/** A tool call from the model, fully accumulated from stream deltas. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string as the model produced it. NOT parsed — parse in a try/catch. */
  readonly argsJson: string;
}
```

The model's request to run something.

- **`id`** — a unique string the model made up, like `call_abc123`. When we send
  the result back we must quote this id so the model knows which call it
  answers. Essential when it calls two tools at once.
- **`name`** — which tool, e.g. `"read_file"`.
- **`argsJson`** — the arguments **as a raw string**, e.g. `'{"path":"a.txt"}'`.

**Why is it a string and not an object?** Because that's literally what arrives
over the wire, and because it might not be valid JSON at all. Models sometimes
produce broken output.

Storing it as a string is honest: the type says *"this has not been parsed
yet"*. If we typed it as an object, we'd be claiming something we haven't
verified. The comment makes the obligation explicit.

> **Principle:** let your types tell the truth about what you actually know.

### Message

```ts
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: readonly ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
```

A discriminated union — `role` is the discriminant. The conversation history is
just `Message[]`.

The four roles:

| Role | Who wrote it | Purpose |
|---|---|---|
| `system` | Us, once at startup | Standing instructions for the model |
| `user` | The human | What you typed |
| `assistant` | The model | Its reply, and any tools it wants run |
| `tool` | Us | The result of running a tool |

Notice each variant has **exactly the fields it needs**:

- Only `assistant` can have `toolCalls` — the model requests tools, nobody else.
- Only `tool` has `toolCallId` — it must point back at the call it answers.
- You cannot accidentally build a `user` message with `toolCalls`. The type
  forbids it.

**`toolCalls?`** — the `?` means optional. Most assistant messages are plain
text with no tools.

**`readonly ToolCall[]`** — the array can't be mutated after creation. Prevents a
whole class of "who changed my array?" bugs.

### Why not just use the OpenAI SDK's types?

The SDK ships its own `ChatCompletionMessageParam`. We defined our own instead.

The reason is in the comment:

```ts
/**
 * Our own message shape, deliberately not the SDK's.
 * ARCHITECTURE §2: the agent runtime must not contain provider-specific details.
 */
```

If `agent.ts` used SDK types, then `agent.ts` would depend on the OpenAI SDK.
Swapping to a different model API later would mean rewriting the agent loop —
exactly what this project promised not to require.

Instead: `provider.ts` translates our shape → the SDK's shape. That translation
lives in **one file**. A new provider writes a new translation; the loop never
changes.

This costs us a small mapping function. It buys us the ability to change model
backends without touching the core.

### ToolSpec

```ts
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the parameters. */
  readonly parameters: Record<string, unknown>;
}
```

How we *advertise* a tool to the model. The model reads `description` to decide
when to use it, and `parameters` to know what arguments to send.

**JSON Schema** is a standard way to describe data shape as JSON:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File path..." }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

We don't write this by hand — `z.toJSONSchema()` generates it from the Zod
schema. Covered in `07-tool-system.md`.

### ModelRequest

```ts
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly signal?: AbortSignal;
}
```

Everything needed for one call to the model.

**`AbortSignal`** — a standard way to cancel an in-flight async operation. If
the user hits Ctrl-C mid-response, this is how we'd stop the HTTP request. We
pass it through but don't use it yet; the plumbing is ready.

### ModelEvent — the streaming vocabulary

```ts
export type ModelEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; argsJson: string }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string };
```

Another discriminated union, discriminant `type`. This is what the provider
emits as the reply streams in.

| Event | Meaning |
|---|---|
| `reasoning_delta` | A piece of the model's *thinking*. Display only. |
| `text_delta` | A piece of the actual answer. |
| `tool_call` | A **complete** tool request. |
| `done` | The reply finished. `stopReason` says why. |
| `error` | Something went wrong. |

**"delta" means "a small piece".** The model doesn't send its answer at once; it
sends fragments. `text_delta` might be `"Hello"`, then `" there"`, then `"!"`.

**Why is `tool_call` not a delta?** Tool calls also arrive in fragments over the
wire — but a half-built tool call is useless and dangerous. So the provider
collects the pieces internally and emits `tool_call` **only when complete**.

This is a deliberate design choice: *the event type expresses the guarantee.*
Anything downstream that receives `tool_call` can rely on it being whole.

### ModelProvider

```ts
export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

**The entire contract for talking to an AI model — one method.**

`AsyncIterable<ModelEvent>` means "something you can loop over with
`for await`, where each item arrives whenever it's ready".

Any class with a `stream` method of this shape can be a provider. Today we have
one (`OpenAICompatibleProvider`). Tomorrow you could add an Anthropic one, and
`agent.ts` wouldn't notice.

> **Note:** we did **not** create an interface for everything on day one. Our
> `ARCHITECTURE.md` lists ten possible interfaces; we built one. The rule is:
> *write the concrete version first; extract the interface when a second real
> implementation needs it.* Building all ten up front is guessing.

### ToolResult

```ts
export type ToolResult =
  | { success: true; content: string }
  | { success: false; error: string; retryable: boolean };
```

What every tool returns. Discriminated on `success` — a **boolean** discriminant
this time, which works just as well as a string.

```ts
if (result.success) {
  console.log(result.content);   // ✅ TS knows content exists
} else {
  console.log(result.error);     // ✅ TS knows error exists
}
```

You literally cannot read `result.content` on a failure. The compiler stops you.

**`retryable`** — should the model try again with different arguments?

| Situation | retryable | Why |
|---|---|---|
| Arguments weren't valid JSON | `true` | Model should re-send properly |
| Wrong argument shape | `true` | Model should fix the shape |
| File not found | `false` | Retrying won't create the file |
| Path outside workspace | `false` | It's refused. Permanently. |

This tells the model *"fix your call"* vs *"stop, this won't work"* — which
prevents the classic failure of a model calling the same broken tool ten times
in a row.

---

## The big idea in this file

Every type here makes some wrong state **unrepresentable**:

- A `tool` message must have a `toolCallId`.
- A successful result has no `error` field.
- A `user` message cannot carry tool calls.
- `argsJson` is a string, so you can't forget it might be malformed.

You are not writing types to please the compiler. You are writing them so that
**a whole category of bug can't be typed in the first place.**

---

## Things to remember

1. Discriminated union = union + a shared field that says which variant it is.
2. TypeScript narrows automatically inside `if` / `switch` on the discriminant.
3. Define your own types at boundaries; don't leak a library's types into your
   core.
4. Types should be honest — `argsJson: string` admits it isn't parsed yet.
5. Only extract an interface when a **second** real implementation needs it.
6. `readonly` on shared data prevents accidental mutation.

## Try it yourself

Open `src/types.ts` and try to write this. See what the compiler says:

```ts
const bad: Message = { role: 'user', content: 'hi', toolCalls: [] };
```

Then this:

```ts
function show(r: ToolResult) {
  console.log(r.content);
}
```

Understanding *why* both fail is the point of this file.

Next: `04-provider-and-streaming.md`.
