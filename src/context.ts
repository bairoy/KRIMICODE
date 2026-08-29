import type { Message } from './types.js';

/**
 * The context engine (ARCHITECTURE §7): decides what the model sees when the
 * conversation stops fitting in the window.
 *
 * Everything here is a pure function of the messages it is handed. The one
 * part that needs the model — producing the actual summary text — lives in
 * `Agent`, so this file stays trivially testable.
 */

/**
 * Characters per token. Deliberately low, which over-estimates the token
 * count: compacting slightly early is cheap, whereas discovering the real
 * limit costs a failed request. Code and JSON tokenize denser than prose, and
 * the endpoint may be a self-hosted model whose tokenizer we cannot see — so a
 * real tokenizer dependency would be a guess with extra steps and a wrong
 * answer whenever the backend is swapped.
 */
const CHARS_PER_TOKEN = 3;

/** Roughly the role and formatting scaffolding each message costs on the wire. */
const PER_MESSAGE_TOKENS = 4;

/** Per-message clip when rendering elided history for the summarizer. */
const MAX_TRANSCRIPT_CHARS_PER_MESSAGE = 2_000;

const SUMMARY_HEADER =
  'Earlier turns of this conversation were elided to stay within the context ' +
  'window. This is what happened before the messages that follow:';

/**
 * Replacement body for a tool result dropped by the last-resort shrink. It
 * keeps the `ToolResult` shape the system prompt promises, so the model reads
 * it as a failed call rather than as corrupted data.
 */
export const ELIDED_TOOL_RESULT = JSON.stringify({
  success: false,
  error: 'Result elided to stay within the context window.',
  retryable: false,
});

export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        chars += call.name.length + call.argsJson.length;
      }
    } else if (message.role === 'tool') {
      chars += message.toolCallId.length;
    }
  }
  return (
    Math.ceil(chars / CHARS_PER_TOKEN) + messages.length * PER_MESSAGE_TOKENS
  );
}

export interface CompactionPolicy {
  /** The model's context window, in tokens. */
  readonly maxTokens: number;
  /** Held back for the tool specs, the reply, and estimation error. */
  readonly reserveTokens: number;
  /** How many recent user turns are always kept verbatim. */
  readonly keepRecentTurns: number;
}

export function defaultPolicy(maxTokens: number): CompactionPolicy {
  return {
    maxTokens,
    // The tool specs go out on every request, the reply has to fit alongside
    // them, and the estimate above is approximate. 20% covers all three
    // without leaving a small window unusable.
    reserveTokens: Math.max(
      1_000,
      Math.min(16_000, Math.floor(maxTokens * 0.2)),
    ),
    // The current turn plus the one before it. ARCHITECTURE §7: never lose
    // live task state — whatever the user just asked for stays verbatim.
    keepRecentTurns: 2,
  };
}

export function budgetTokens(policy: CompactionPolicy): number {
  return policy.maxTokens - policy.reserveTokens;
}

export function needsCompaction(
  messages: readonly Message[],
  policy: CompactionPolicy,
): boolean {
  return estimateTokens(messages) > budgetTokens(policy);
}

export interface CompactionPlan {
  /** Older history, to be folded into the running summary. */
  readonly elide: readonly Message[];
  /** Recent history, kept exactly as it is. */
  readonly keep: readonly Message[];
}

/**
 * Chooses where to cut. Returns null when there is nothing that can be safely
 * elided at turn granularity.
 *
 * Cut points are only ever the index of a `user` message. That is what makes
 * this safe: a user message always begins a fresh turn, so everything before
 * it is a completed exchange and everything after it is well-formed. Cutting
 * anywhere else risks leaving a `tool` message whose assistant `toolCalls`
 * were removed, which every OpenAI-compatible provider rejects outright.
 */
export function planCompaction(
  history: readonly Message[],
  policy: CompactionPolicy,
): CompactionPlan | null {
  const starts: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.role === 'user') starts.push(i);
  }

  if (starts.length <= policy.keepRecentTurns) return null;

  const cut = starts[starts.length - policy.keepRecentTurns];
  if (cut === undefined || cut === 0) return null;

  return { elide: history.slice(0, cut), keep: history.slice(cut) };
}

/**
 * Builds the system message actually sent to the model.
 *
 * The summary is folded into the system prompt rather than inserted as its own
 * message. Two alternatives were rejected: a second `system` message (chat
 * templates on self-hosted backends often accept only one, and only in first
 * position), and a `user` message (it would read as something the user said,
 * and the model may act on it as an instruction).
 */
export function composeSystem(
  basePrompt: string,
  summary: string | null,
): Message {
  return {
    role: 'system',
    content:
      summary === null
        ? basePrompt
        : `${basePrompt}\n\n${SUMMARY_HEADER}\n${summary}`,
  };
}

/**
 * Last resort, for when a single turn is itself too large to fit — thirty
 * tool calls of capped output will do it. Blanks tool result bodies from the
 * oldest forward.
 *
 * The `tool` messages themselves must survive. Deleting one orphans the
 * assistant tool call that produced it, and the next request fails.
 */
export function shrinkToolResults(
  messages: readonly Message[],
  budget: number,
): Message[] {
  const out = [...messages];
  if (estimateTokens(out) <= budget) return out;

  // Oldest first: recent results are the ones the model is still reasoning
  // about, so they are the last thing worth losing.
  for (let i = 0; i < out.length; i++) {
    const message = out[i];
    if (message === undefined || message.role !== 'tool') continue;
    if (message.content === ELIDED_TOOL_RESULT) continue;

    out[i] = {
      role: 'tool',
      toolCallId: message.toolCallId,
      content: ELIDED_TOOL_RESULT,
    };
    if (estimateTokens(out) <= budget) break;
  }

  return out;
}

function clip(text: string, max = MAX_TRANSCRIPT_CHARS_PER_MESSAGE): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [clipped]`;
}

function renderMessage(message: Message): string {
  switch (message.role) {
    // The system prompt is rebuilt on every request and is never part of
    // history, so it is never elided and never needs summarizing.
    case 'system':
      return '';
    case 'user':
      return `USER: ${clip(message.content)}`;
    case 'assistant': {
      const parts: string[] = [];
      if (message.content.trim() !== '') {
        parts.push(`ASSISTANT: ${clip(message.content)}`);
      }
      for (const call of message.toolCalls ?? []) {
        parts.push(`  -> called ${call.name}(${clip(call.argsJson, 400)})`);
      }
      return parts.join('\n');
    }
    case 'tool':
      return `  <- ${clip(message.content, 600)}`;
  }
}

/**
 * Renders history as plain text rather than passing the messages through as
 * messages. A `tool` message separated from its assistant call is malformed,
 * and the elided range routinely starts or ends mid-turn — so the transcript
 * becomes data inside one user message, where structure cannot be violated.
 */
export function renderTranscript(elided: readonly Message[]): string {
  return elided
    .map(renderMessage)
    .filter((line) => line !== '')
    .join('\n');
}

const SUMMARIZER_PROMPT = [
  'You are compacting the history of a coding session so it fits in a smaller',
  'context window. Summarize the transcript below in under 400 words.',
  'Preserve, in this order of priority: what the user is trying to achieve;',
  'decisions made and the reasons given; files created or modified and what',
  'changed in each; commands run and their outcomes; anything still unfinished',
  'or unresolved. Drop pleasantries, restated file contents, and reasoning that',
  'led nowhere. Write plain prose and short lists, no preamble, no offer to',
  'help. If a previous summary is included, merge it with the newer material',
  'into one continuous summary rather than describing the two separately.',
].join(' ');

/** The request sent to the model to produce the summary. */
export function buildSummaryRequest(
  previousSummary: string | null,
  elided: readonly Message[],
  policy: CompactionPolicy,
): Message[] {
  const previous =
    previousSummary === null
      ? ''
      : `Previous summary of still earlier turns:\n${previousSummary}\n\n`;

  const body = `${previous}Transcript:\n${renderTranscript(elided)}`;

  // The summarization request has to fit in the same window as everything
  // else, so it gets capped too — half the budget, since it is the only thing
  // in that request.
  const max = Math.floor((budgetTokens(policy) * CHARS_PER_TOKEN) / 2);

  return [
    { role: 'system', content: SUMMARIZER_PROMPT },
    { role: 'user', content: clip(body, max) },
  ];
}

/**
 * Fallback for when the summarization request itself fails — a dropped
 * connection, a provider error, the user cancelling.
 *
 * Not a second implementation of summarization: it is the error path. Without
 * it a failed summary leaves the history over budget and the session dead,
 * which is precisely the failure compaction exists to prevent.
 */
export function mechanicalDigest(
  previousSummary: string | null,
  elided: readonly Message[],
): string {
  const requests = elided
    .filter((message) => message.role === 'user')
    .map((message) => `- ${clip(message.content, 200)}`);

  const tools = new Set<string>();
  for (const message of elided) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) tools.add(call.name);
  }

  const parts: string[] = [];
  if (previousSummary !== null) parts.push(previousSummary);
  if (requests.length > 0) {
    parts.push(`Earlier requests from the user:\n${requests.join('\n')}`);
  }
  if (tools.size > 0) {
    parts.push(`Tools used earlier: ${[...tools].sort().join(', ')}.`);
  }
  parts.push(
    '(The model-written summary could not be produced, so this is a mechanical' +
      ' digest. Details of earlier turns are lost — ask the user rather than' +
      ' guessing what was decided.)',
  );

  return parts.join('\n\n');
}
