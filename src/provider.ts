import OpenAI from 'openai';
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { Config } from './config.js';
import type {
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ToolSpec,
} from './types.js';

/** Partially-received tool call, keyed by stream index. */
interface PendingToolCall {
  id?: string;
  name?: string;
  args: string;
}

/** One `tool_calls[]` entry as it arrives on a delta. Only `index` is certain. */
export interface ToolCallDelta {
  readonly index: number;
  readonly id?: string | undefined;
  readonly function?:
    | { readonly name?: string | undefined; readonly arguments?: string | undefined }
    | undefined;
}

/**
 * Reassembles tool calls from stream deltas.
 *
 * Exported for tests. This is where OpenAI-compatible vendors differ most —
 * whether `id`/`name` repeat on every chunk, and how `index` separates
 * parallel calls — so it is worth testing directly rather than through HTTP.
 */
export class ToolCallAccumulator {
  readonly #pending = new Map<number, PendingToolCall>();

  add(delta: ToolCallDelta): void {
    let slot = this.#pending.get(delta.index);
    if (!slot) {
      slot = { args: '' };
      this.#pending.set(delta.index, slot);
    }
    // Set-once: some providers repeat id/name on every chunk, others send
    // them only on the first.
    if (delta.id && !slot.id) slot.id = delta.id;
    if (delta.function?.name && !slot.name) slot.name = delta.function.name;
    // Arguments genuinely arrive in fragments, so these concatenate.
    if (delta.function?.arguments) slot.args += delta.function.arguments;
  }

  /**
   * Completed calls in the order the model produced them, plus anything that
   * never became complete. A half-built call is never returned as usable.
   */
  drain(): {
    complete: { id: string; name: string; argsJson: string }[];
    incomplete: { index: number; missing: 'id' | 'name' }[];
  } {
    const complete: { id: string; name: string; argsJson: string }[] = [];
    const incomplete: { index: number; missing: 'id' | 'name' }[] = [];

    // Map preserves insertion order, not numeric order; sort so parallel calls
    // run in the order the model intended.
    for (const [index, slot] of [...this.#pending.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (!slot.id) {
        incomplete.push({ index, missing: 'id' });
      } else if (!slot.name) {
        incomplete.push({ index, missing: 'name' });
      } else {
        complete.push({ id: slot.id, name: slot.name, argsJson: slot.args });
      }
    }

    return { complete, incomplete };
  }
}

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

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const pending = new ToolCallAccumulator();
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

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) stopReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        const reasoning = extractReasoning(delta);
        if (reasoning) {
          yield { type: 'reasoning_delta', text: reasoning };
        }

        for (const tc of delta.tool_calls ?? []) {
          pending.add(tc);
        }
      }

      // Emitted only after the stream closes, so a tool_call event is always
      // complete.
      const { complete, incomplete } = pending.drain();
      for (const { index, missing } of incomplete) {
        yield {
          type: 'error',
          message: `Incomplete tool call at index ${index}: missing ${missing}.`,
        };
      }
      for (const call of complete) {
        yield { type: 'tool_call', ...call };
      }

      yield { type: 'done', stopReason };
    } catch (err) {
      // Message only. Never surface the error object — SDK errors can carry
      // request details including headers.
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Exported for tests: this is the boundary between our types and the SDK's. */
export function toWireMessages(
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

/**
 * Reasoning tokens are outside the OpenAI-compatible surface and vendors
 * disagree on the shape: Z.ai native uses `reasoning_content`, OpenRouter uses
 * `reasoning` plus a structured `reasoning_details`. Treat all three as
 * untrusted and narrow before use.
 */
export function extractReasoning(delta: unknown): string {
  if (typeof delta !== 'object' || delta === null) return '';

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
