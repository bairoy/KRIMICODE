import {
  budgetTokens,
  composeSystem,
  buildSummaryRequest,
  defaultPolicy,
  estimateTokens,
  mechanicalDigest,
  needsCompaction,
  planCompaction,
  shrinkToolResults,
  type CompactionPolicy,
} from './context.js';
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

/** Stands in for a tool call the user cancelled before it could run. */
const CANCELLED_RESULT: ToolResult = {
  success: false,
  error: 'Cancelled by the user.',
  retryable: false,
};

/** Reported to the CLI after a compaction, so the user knows history was folded. */
export interface CompactionInfo {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesElided: number;
  /** True when the model-written summary failed and the digest was used. */
  readonly fallback: boolean;
}

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
  readonly maxContextTokens: number;
  readonly onCompact?: (info: CompactionInfo) => void;
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
  readonly #onCompact: ((info: CompactionInfo) => void) | undefined;
  readonly #policy: CompactionPolicy;

  /**
   * Live turns only — the system message is not stored here. It is rebuilt for
   * every request from the base prompt plus the running summary, so compaction
   * can replace the summary without rewriting history, and so a `user` cut
   * point is never confused with the message at index 0.
   */
  #history: Message[] = [];

  /** Summary of everything elided so far, or null while nothing has been. */
  #summary: string | null = null;

  constructor(options: AgentOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#onText = options.onText;
    this.#onReasoning = options.onReasoning;
    this.#workspaceRoot = options.workspaceRoot;
    this.#gate = options.gate;
    this.#onToolStart = options.onToolStart;
    this.#onToolEnd = options.onToolEnd;
    this.#onCompact = options.onCompact;
    this.#policy = defaultPolicy(options.maxContextTokens);
  }

  /**
   * Runs one user turn to completion.
   *
   * Aborting `signal` stops the model stream and kills any running command,
   * then returns normally. It is not an error: the user asked for it, and the
   * conversation must still be usable afterwards.
   */
  async send(userInput: string, signal?: AbortSignal): Promise<void> {
    this.#history.push({ role: 'user', content: userInput });

    // The loop, not a pipeline (ARCHITECTURE §1): the model may call tools
    // many times before a final answer. Each pass is one model turn.
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Safe to bail here and nowhere else in the middle: at the top of the
      // loop every announced tool call already has its result, so history is
      // well-formed and the next send can build on it.
      if (signal?.aborted) return;

      // Before every request, not just at the start of a turn: a single turn
      // can add thirty capped tool results and outgrow the window on its own.
      await this.#compactIfNeeded(signal);
      if (signal?.aborted) return;

      const { text, toolCalls } = await this.#streamOnce(signal);

      this.#history.push(
        toolCalls.length > 0
          ? { role: 'assistant', content: text, toolCalls }
          : { role: 'assistant', content: text },
      );

      if (toolCalls.length === 0) return;

      for (const call of toolCalls) {
        // Every announced call gets a result, cancelled ones included. Leaving
        // one unanswered would make the next request malformed — providers
        // reject an assistant tool call with no matching tool message — and
        // the session could never recover.
        const result = signal?.aborted
          ? CANCELLED_RESULT
          : await this.#runToolReported(call, signal);

        // ARCHITECTURE §5: the model sees the structured result, so it can
        // tell "the file does not exist" from "the tool is broken".
        this.#history.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    throw new Error(`Exceeded ${MAX_TURNS} turns without a final answer.`);
  }

  async #runToolReported(
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    this.#onToolStart(call.name, call.argsJson);
    const result = await this.#runTool(call, signal);
    this.#onToolEnd(call.name, result);
    return result;
  }

  /** Everything the model sees: the composed system message, then live turns. */
  #requestMessages(): Message[] {
    return [composeSystem(SYSTEM_PROMPT, this.#summary), ...this.#history];
  }

  /**
   * ARCHITECTURE §7. Folds older turns into a running summary once the
   * conversation approaches the window, rather than letting the request grow
   * until the provider rejects it — at which point every later request would
   * carry the same oversized history and the session would be unrecoverable.
   */
  async #compactIfNeeded(signal: AbortSignal | undefined): Promise<void> {
    const tokensBefore = estimateTokens(this.#requestMessages());
    if (!needsCompaction(this.#requestMessages(), this.#policy)) return;

    const plan = planCompaction(this.#history, this.#policy);
    let fallback = false;
    let messagesElided = 0;

    if (plan !== null) {
      const summary = await this.#summarize(plan.elide, signal);
      // Cancelling mid-summary would otherwise bake the fallback digest into
      // history permanently. Leave it untouched and compact properly next time.
      if (signal?.aborted) return;

      this.#summary = summary.text;
      this.#history = [...plan.keep];
      fallback = summary.fallback;
      messagesElided = plan.elide.length;
    }

    // Even after summarizing, the turns we are obliged to keep may not fit —
    // or there may have been nothing to elide at turn granularity in the first
    // place. Blanking old tool bodies is the only remaining move that does not
    // break turn structure.
    const systemTokens = estimateTokens([
      composeSystem(SYSTEM_PROMPT, this.#summary),
    ]);
    this.#history = shrinkToolResults(
      this.#history,
      budgetTokens(this.#policy) - systemTokens,
    );

    this.#onCompact?.({
      tokensBefore,
      tokensAfter: estimateTokens(this.#requestMessages()),
      messagesElided,
      fallback,
    });
  }

  /**
   * Asks the model to summarize the elided turns. Sent without tools — the
   * summarizer has no reason to call one, and a tool call here would be
   * dispatched outside the permission flow of the real conversation.
   */
  async #summarize(
    elided: readonly Message[],
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; fallback: boolean }> {
    const digest = (): { text: string; fallback: boolean } => ({
      text: mechanicalDigest(this.#summary, elided),
      fallback: true,
    });

    let text = '';
    try {
      for await (const event of this.#provider.stream({
        model: this.#model,
        messages: buildSummaryRequest(this.#summary, elided, this.#policy),
        signal,
      })) {
        if (event.type === 'text_delta') text += event.text;
        else if (event.type === 'error') throw new Error(event.message);
      }
    } catch {
      // A failed summary must not end the session — that is the exact failure
      // compaction exists to prevent. Fall back to the mechanical digest.
      return digest();
    }

    const trimmed = text.trim();
    return trimmed === '' ? digest() : { text: trimmed, fallback: false };
  }

  /**
   * Dispatch one tool call. Every result leaves here already normalized —
   * redacted and capped — because this is the only path from a tool into
   * history.
   */
  async #runTool(
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
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
        { workspaceRoot: this.#workspaceRoot, signal },
        this.#gate,
      ),
    );
  }

  async #streamOnce(
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    let text = '';
    const toolCalls: ToolCall[] = [];

    for await (const event of this.#provider.stream({
      model: this.#model,
      messages: this.#requestMessages(),
      tools: toolSpecs(),
      signal,
    })) {
      switch (event.type) {
        // Rendered for the human, never accumulated into `text` and so never
        // pushed into history. Feeding thinking back as assistant content
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
