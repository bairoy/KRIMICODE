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
    // Accumulated across chunks, keyed by `index`. Only `index` is guaranteed
    // present on a delta — `id`, `name` and `arguments` all arrive piecemeal,
    // and providers differ on which chunk carries what.
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
      }

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
