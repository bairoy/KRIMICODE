import { normalizeToolResult } from './normalize.js';
import type { PermissionGate } from './permissions.js';
import { getTool, toolSpecs } from './tools/index.js';
import type {
  Message,
  ModelProvider,
  ToolCall,
  ToolResult,
} from './types.js';

/** Runaway-loop guard: a model that keeps calling tools must still terminate. */
const MAX_TURNS = 30;

const SYSTEM_PROMPT = [
  'You are a terminal coding assistant working inside the user\'s workspace.',
  'Use the provided tools to inspect real files rather than guessing.',
  'Tool results are JSON: {"success":true,"content":...} or',
  '{"success":false,"error":...,"retryable":...}. If a call fails, read the',
  'error and correct the arguments instead of repeating the same call.',
  'Be concise and direct.',
].join(' ');

export interface AgentOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  /** Called with each streamed text fragment, for incremental rendering. */
  readonly onText: (text: string) => void;
  /** Called with each streamed reasoning fragment. Display only. */
  readonly onReasoning: (text: string) => void;
  readonly workspaceRoot: string;
  readonly gate: PermissionGate;
  readonly onToolStart: (name: string, argsJson: string) => void;
  readonly onToolEnd: (name: string, result: ToolResult) => void;
}

export class Agent {
  readonly #provider: ModelProvider;
  readonly #model: string;
  readonly #onText: (text: string) => void;
  readonly #onReasoning: (text: string) => void;
  readonly #workspaceRoot: string;
  readonly #gate: PermissionGate;
  readonly #onToolStart: (name: string, argsJson: string) => void;
  readonly #onToolEnd: (name: string, result: ToolResult) => void;
  readonly #messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  constructor(options: AgentOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#onText = options.onText;
    this.#onReasoning = options.onReasoning;
    this.#workspaceRoot = options.workspaceRoot;
    this.#gate = options.gate;
    this.#onToolStart = options.onToolStart;
    this.#onToolEnd = options.onToolEnd;
  }

  async send(userInput: string): Promise<void> {
    this.#messages.push({ role: 'user', content: userInput });

    // The loop, not a pipeline (ARCHITECTURE §1): the model may call tools
    // many times before a final answer. Each pass is one model turn.
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { text, toolCalls } = await this.#streamOnce();

      this.#messages.push(
        toolCalls.length > 0
          ? { role: 'assistant', content: text, toolCalls }
          : { role: 'assistant', content: text },
      );

      if (toolCalls.length === 0) return;

      for (const call of toolCalls) {
        this.#onToolStart(call.name, call.argsJson);
        const result = await this.#runTool(call);
        this.#onToolEnd(call.name, result);

        // ARCHITECTURE §5: the model sees the structured result, so it can
        // tell "the file does not exist" from "the tool is broken".
        this.#messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    throw new Error(`Exceeded ${MAX_TURNS} turns without a final answer.`);
  }

  /**
   * Dispatch one tool call. Every result leaves here already normalized —
   * redacted and capped — because this is the only path from a tool into
   * #messages.
   */
  async #runTool(call: ToolCall): Promise<ToolResult> {
    const tool = getTool(call.name);
    if (!tool) {
      return normalizeToolResult({
        success: false,
        error: `Unknown tool: "${call.name}".`,
        retryable: false,
      });
    }

    return normalizeToolResult(
      await tool.run(
        call.argsJson,
        { workspaceRoot: this.#workspaceRoot },
        this.#gate,
      ),
    );
  }

  async #streamOnce(): Promise<{ text: string; toolCalls: ToolCall[] }> {
    let text = '';
    const toolCalls: ToolCall[] = [];

    for await (const event of this.#provider.stream({
      model: this.#model,
      messages: this.#messages,
      tools: toolSpecs(),
    })) {
      switch (event.type) {
        // Rendered for the human, never accumulated into `text` and so never
        // pushed into #messages. Feeding thinking back as assistant content
        // would inflate every later request and can degrade output.
        case 'reasoning_delta':
          this.#onReasoning(event.text);
          break;
        case 'text_delta':
          text += event.text;
          this.#onText(event.text);
          break;
        case 'tool_call':
          toolCalls.push({
            id: event.id,
            name: event.name,
            argsJson: event.argsJson,
          });
          break;
        case 'done':
          break;
        case 'error':
          throw new Error(event.message);
      }
    }

    return { text, toolCalls };
  }
}
