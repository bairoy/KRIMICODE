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
import { counted } from '../plural.js';
import { normalizeToolResult } from '../tools/normalize.js';
import type { PermissionGate } from '../permissions.js';
import { getTool, toolSpecs } from '../tools/index.js';
import type { Message, ModelProvider, ToolCall, ToolResult } from '../types.js';

/** Runaway-loop guard: a model that keeps calling tools must still terminate. */
const MAX_TURNS = 30;

/**
 * How many times the identical failing call is allowed before it stops being
 * executed at all.
 *
 * Two, so one retry is still permitted — a genuinely transient failure (a
 * timeout, a file being written just then) deserves a second attempt. The
 * third identical call is refused without running.
 */
const MAX_IDENTICAL_FAILURES = 2;

const SYSTEM_PROMPT = [
  "You are a terminal coding assistant working inside the user's workspace.",
  'Use the provided tools to inspect real files rather than guessing.',
  // Without this, a weaker model answers a "change this file" request by
  // printing the new code in its reply and calling it done. The user reads a
  // confident answer and the file is untouched.
  'When the user asks you to create or change a file, do it with the tools.',
  'Code in your reply is not the work — nothing has changed until a tool call',
  'succeeds.',
  // The one workflow the tool set does not make obvious: neither tool
  // overwrites, so replacing a file means reading it and editing what is there.
  'create_file makes new files only and never overwrites. To replace what is',
  'already in a file, read_file it first, then edit_file using its exact',
  'current text as old_str.',
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

/**
 * The runaway-loop guard tripped: the model kept calling tools without ever
 * producing a final answer.
 *
 * A distinct type rather than a bare Error so the CLI can say something
 * actionable. Rendered identically to a network failure, this reads as "the
 * agent is broken" when the real fix is usually to narrow the request.
 *
 * History is well-formed when this is thrown — the loop only exits after every
 * announced tool call has received its result — so the session stays usable
 * and the user can simply continue.
 */
export class MaxTurnsError extends Error {
  readonly turns: number;

  constructor(turns: number) {
    super(`Stopped after ${counted(turns, 'turn')} without a final answer.`);
    this.name = 'MaxTurnsError';
    this.turns = turns;
  }
}

/** Reported to the CLI after a compaction, so the user knows history was folded. */
export interface CompactionInfo {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesElided: number;
  /** True when the model-written summary failed and the digest was used. */
  readonly fallback: boolean;
}

/**
 * The resumable part of a conversation.
 *
 * Deliberately just these two fields: everything else the agent needs is either
 * configuration or rebuilt per request.
 */
export interface SessionState {
  readonly history: readonly Message[];
  readonly summary: string | null;
}

export interface AgentOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  /** Restores a saved conversation. Omit to start fresh. */
  readonly initialState?: SessionState;
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
  /** Mutable so `/model` can switch it without rebuilding the session. */
  #model: string;
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

  /**
   * How many times each exact tool call has already failed, keyed by name and
   * arguments.
   *
   * Only failures are counted: calling `git_status` five times because the
   * working tree keeps changing is legitimate, and repeating a call that
   * *worked* says nothing. What this catches is the model retrying something
   * that cannot succeed — which it will do until MAX_TURNS, burning a request
   * and real money on each pass.
   */
  readonly #failedCalls = new Map<string, number>();

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

    if (options.initialState) {
      this.#history = [...options.initialState.history];
      this.#summary = options.initialState.summary;
    }
  }

  get model(): string {
    return this.#model;
  }

  set model(name: string) {
    this.#model = name;
  }

  /**
   * Forget the conversation and start over.
   *
   * Both fields have to go together: a summary describing turns that are no
   * longer in history would be silently reintroduced into the next request.
   */
  reset(): void {
    this.#history = [];
    this.#summary = null;
    // A new conversation deserves a clean slate: a call that could not work
    // before may be exactly right once the context has changed.
    this.#failedCalls.clear();
  }

  /**
   * Everything needed to rebuild this conversation later.
   *
   * History and summary are the whole of the resumable state — the system
   * prompt is rebuilt from them on every request, so it is not worth storing.
   * Copied rather than returned live, so a caller holding a snapshot does not
   * see it mutate under them mid-turn.
   */
  snapshot(): SessionState {
    return { history: [...this.#history], summary: this.#summary };
  }

  /** True when nothing has been said yet — used to avoid saving empty sessions. */
  get isEmpty(): boolean {
    return this.#history.length === 0;
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

    throw new MaxTurnsError(MAX_TURNS);
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
   * Fold older turns into the summary now, without waiting for the window to
   * demand it — what `/compact` calls.
   *
   * Useful before an expensive request: compaction that happens on its own
   * always happens at the worst moment, part-way through a turn the user is
   * waiting on. Returns null when there was nothing it could safely do.
   */
  async compact(signal?: AbortSignal): Promise<CompactionInfo | null> {
    return this.#compact(true, signal);
  }

  /**
   * ARCHITECTURE §7. Folds older turns into a running summary once the
   * conversation approaches the window, rather than letting the request grow
   * until the provider rejects it — at which point every later request would
   * carry the same oversized history and the session would be unrecoverable.
   */
  async #compactIfNeeded(signal: AbortSignal | undefined): Promise<void> {
    await this.#compact(false, signal);
  }

  /**
   * The one implementation. `force` is the only difference between the
   * automatic path and `/compact`: what may be elided, and what must be kept,
   * is the same question either way — a manual compaction that dropped the
   * live turn would be a worse bug than never compacting at all.
   */
  async #compact(
    force: boolean,
    signal: AbortSignal | undefined,
  ): Promise<CompactionInfo | null> {
    const tokensBefore = estimateTokens(this.#requestMessages());
    if (!force && !needsCompaction(this.#requestMessages(), this.#policy)) {
      return null;
    }

    const plan = planCompaction(this.#history, this.#policy);
    let fallback = false;
    let messagesElided = 0;

    if (plan !== null) {
      const summary = await this.#summarize(plan.elide, signal);
      // Cancelling mid-summary would otherwise bake the fallback digest into
      // history permanently. Leave it untouched and compact properly next time.
      if (signal?.aborted) return null;

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

    const tokensAfter = estimateTokens(this.#requestMessages());

    // Nothing was elided and nothing shrank: the conversation is too short to
    // have anything behind the turns that must be kept. Report that honestly
    // rather than announcing a compaction that did not happen — a note saying
    // "0 messages summarized, same token count" is how a working command
    // starts to look broken.
    if (messagesElided === 0 && tokensAfter === tokensBefore) return null;

    const info: CompactionInfo = {
      tokensBefore,
      tokensAfter,
      messagesElided,
      fallback,
    };
    this.#onCompact?.(info);
    return info;
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
    // Wraps every dispatch path, the unknown-tool one included: a model that
    // keeps inventing the same nonexistent tool is in the same runaway loop as
    // one repeating an impossible edit, and each attempt costs a request.
    const key = `${call.name} ${call.argsJson}`;
    const failures = this.#failedCalls.get(key) ?? 0;

    // Identical arguments, so identical outcome. Refuse without running rather
    // than spend another request, another permission prompt, and possibly
    // another side effect on a call that has already proven it cannot work.
    if (failures >= MAX_IDENTICAL_FAILURES) {
      return normalizeToolResult({
        success: false,
        error:
          `This exact ${call.name} call has already failed ${failures} times ` +
          'with the same arguments, so it was not run again. Repeating it ' +
          'will not help. Change the arguments, use a different tool, or ' +
          'explain to the user what is blocking you.',
        retryable: false,
      });
    }

    const result = await this.#dispatch(call, signal);
    if (!result.success) this.#failedCalls.set(key, failures + 1);
    return result;
  }

  /** The dispatch itself, split out so the repeat guard covers all of it. */
  async #dispatch(
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
