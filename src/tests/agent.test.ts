import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../agent.js';
import type { AgentOptions, CompactionInfo } from '../agent.js';
import { budgetTokens, defaultPolicy, estimateTokens } from '../context.js';
import type { ModelEvent, ModelProvider, ModelRequest } from '../types.js';
import { allowAll } from './helpers.js';

const MAX_CONTEXT = 6_000;
const BUDGET = budgetTokens(defaultPolicy(MAX_CONTEXT));

/**
 * A provider that records every request and replies from a script.
 *
 * The summarization call is the one sent without tools, which is how these
 * tests tell it apart from a real conversational turn.
 */
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

  get summarizerCalls(): ModelRequest[] {
    return this.requests.filter((r) => r.tools === undefined);
  }

  get conversationCalls(): ModelRequest[] {
    return this.requests.filter((r) => r.tools !== undefined);
  }
}

function isSummarizer(request: ModelRequest): boolean {
  return request.tools === undefined;
}

function makeAgent(
  provider: ModelProvider,
  extra: Partial<AgentOptions> = {},
): Agent {
  return new Agent({
    provider,
    model: 'test-model',
    workspaceRoot: process.cwd(),
    gate: allowAll(),
    onText: () => {},
    onReasoning: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    maxContextTokens: MAX_CONTEXT,
    ...extra,
  });
}

const text = (value: string): ModelEvent[] => [
  { type: 'text_delta', text: value },
  { type: 'done', stopReason: 'stop' },
];

/** Long enough that a handful of turns outgrows a 6000-token window. */
const LONG_INPUT = 'user says something at length. '.repeat(100);
const LONG_REPLY = 'assistant replies at length. '.repeat(60);

test('a long conversation stays inside the budget instead of growing forever', async () => {
  // Before compaction existed this was the fatal case: history grew until the
  // provider rejected the request, and every later request repeated the same
  // oversized payload, so the session could not recover.
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

test('the summary reaches later requests through the system message', async () => {
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY OF EARLIER WORK') : text(LONG_REPLY),
  );
  const agent = makeAgent(provider);

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);

  const after = provider.conversationCalls.at(-1);
  assert.ok(after);
  assert.equal(after.messages[0]?.role, 'system');
  assert.match(after.messages[0].content, /SUMMARY OF EARLIER WORK/);
});

test('the newest turn survives compaction verbatim', async () => {
  // ARCHITECTURE §7: never lose live task state. Whatever the user just asked
  // has to still be there, or the model answers the wrong question.
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY') : text(LONG_REPLY),
  );
  const agent = makeAgent(provider);

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);
  await agent.send('MARKER: the actual current question');

  const last = provider.conversationCalls.at(-1);
  assert.ok(last);
  assert.ok(
    last.messages.some((m) => m.content.includes('MARKER: the actual current question')),
    'the current question was summarized away',
  );
});

test('the summarizer is called without tools', async () => {
  // It has no reason to call one, and a tool call raised here would be
  // dispatched outside the permission flow of the real conversation.
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY') : text(LONG_REPLY),
  );
  const agent = makeAgent(provider);

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);

  assert.ok(provider.summarizerCalls.length > 0);
  for (const call of provider.summarizerCalls) {
    assert.equal(call.tools, undefined);
  }
});

test('a failed summarization falls back to a digest and the session continues', async () => {
  // The error path that matters most: if a failed summary aborted the send,
  // compaction would itself become the thing that kills long sessions.
  const provider = new FakeProvider((request) =>
    isSummarizer(request)
      ? [{ type: 'error', message: 'provider exploded' }]
      : text(LONG_REPLY),
  );
  const seen: CompactionInfo[] = [];
  const agent = makeAgent(provider, { onCompact: (info) => seen.push(info) });

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);

  assert.ok(seen.length > 0, 'compaction never ran');
  assert.ok(seen.some((info) => info.fallback), 'fallback was never reported');

  const after = provider.conversationCalls.at(-1);
  assert.match(after?.messages[0]?.content ?? '', /mechanical digest/i);
});

test('an empty summary is treated as a failure rather than erasing history', async () => {
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('   \n  ') : text(LONG_REPLY),
  );
  const seen: CompactionInfo[] = [];
  const agent = makeAgent(provider, { onCompact: (info) => seen.push(info) });

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);

  assert.ok(seen.some((info) => info.fallback));
});

test('compaction reports a real reduction', async () => {
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY') : text(LONG_REPLY),
  );
  const seen: CompactionInfo[] = [];
  const agent = makeAgent(provider, { onCompact: (info) => seen.push(info) });

  for (let i = 0; i < 12; i++) await agent.send(`${LONG_INPUT} ${i}`);

  const first = seen[0];
  assert.ok(first);
  assert.ok(first.tokensAfter < first.tokensBefore, 'compaction did not shrink anything');
  assert.ok(first.messagesElided > 0);
});

test('a short conversation never triggers compaction', async () => {
  const provider = new FakeProvider(() => text('short answer'));
  const seen: CompactionInfo[] = [];
  const agent = makeAgent(provider, { onCompact: (info) => seen.push(info) });

  await agent.send('hello');
  await agent.send('again');

  assert.deepEqual(seen, []);
  assert.equal(provider.summarizerCalls.length, 0);
});

test('SECURITY: no request ever carries a tool result without its call', async () => {
  // A `tool` message whose assistant tool call was elided is a hard 400 on
  // every OpenAI-compatible provider. Turn-granular cut points are what
  // prevent it; this checks the whole loop honours that, not just the planner.
  let call = 0;
  const provider = new FakeProvider((request) => {
    if (isSummarizer(request)) return text('SUMMARY');
    call++;
    // Alternate: some turns call a tool, some answer directly, so cuts land in
    // varied places relative to tool exchanges.
    return call % 2 === 1
      ? [
          {
            type: 'tool_call',
            id: `id-${call}`,
            name: 'no_such_tool',
            argsJson: `{"padding":"${'p'.repeat(600)}"}`,
          },
          { type: 'done', stopReason: 'tool_calls' },
        ]
      : text(LONG_REPLY);
  });
  const agent = makeAgent(provider);

  for (let i = 0; i < 10; i++) await agent.send(`${LONG_INPUT} ${i}`);

  assert.ok(provider.summarizerCalls.length > 0, 'compaction never ran');

  for (const request of provider.conversationCalls) {
    const announced = new Set<string>();
    for (const message of request.messages) {
      if (message.role === 'assistant') {
        for (const c of message.toolCalls ?? []) announced.add(c.id);
      } else if (message.role === 'tool') {
        assert.ok(
          announced.has(message.toolCallId),
          `orphaned tool result ${message.toolCallId}`,
        );
      }
    }
  }
});

// --- cancellation -----------------------------------------------------------

const toolCall = (id: string): ModelEvent => ({
  type: 'tool_call',
  id,
  name: 'no_such_tool',
  argsJson: '{}',
});

test('a cancelled turn returns normally instead of throwing', async () => {
  // Cancelling is something the user chose. Surfacing it as an error would put
  // a stack-trace-shaped message on screen for working as intended.
  const controller = new AbortController();
  const provider = new FakeProvider(() => {
    controller.abort();
    return [{ type: 'done', stopReason: 'cancelled' }];
  });
  const agent = makeAgent(provider);

  await agent.send('do something slow', controller.signal);
});

test('partial output from a cancelled stream is kept', async () => {
  const controller = new AbortController();
  const provider = new FakeProvider((request) => {
    if (provider.conversationCalls.length > 1) return text('second answer');
    controller.abort();
    return [
      { type: 'text_delta', text: 'PARTIAL ANSWER' },
      { type: 'done', stopReason: 'cancelled' },
    ];
  });
  const agent = makeAgent(provider);

  await agent.send('first', controller.signal);
  await agent.send('second');

  const last = provider.conversationCalls.at(-1);
  assert.ok(last?.messages.some((m) => m.content.includes('PARTIAL ANSWER')));
});

test('SECURITY: cancelling mid-turn still answers every announced tool call', async () => {
  // The worst cancellation bug available: bail out of the tool loop early and
  // history holds an assistant tool call with no matching tool message. Every
  // later request is then a hard 400 and the session is unrecoverable — the
  // user cancelled one turn and lost the conversation.
  const controller = new AbortController();
  const provider = new FakeProvider((request) => {
    if (isSummarizer(request)) return text('SUMMARY');
    return provider.conversationCalls.length === 1
      ? [toolCall('a'), toolCall('b'), toolCall('c'), { type: 'done', stopReason: 'tool_calls' }]
      : text('later answer');
  });

  // Cancel while the first of the three tools is running.
  const agent = makeAgent(provider, {
    onToolStart: () => controller.abort(),
  });

  await agent.send('run three tools', controller.signal);
  await agent.send('carry on');

  const last = provider.conversationCalls.at(-1);
  assert.ok(last);

  const announced = new Set<string>();
  const answered = new Set<string>();
  for (const message of last.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) announced.add(call.id);
    } else if (message.role === 'tool') {
      answered.add(message.toolCallId);
    }
  }
  assert.deepEqual([...announced].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...answered].sort(), ['a', 'b', 'c']);
});

test('tool calls after the cancellation point are not executed', async () => {
  const controller = new AbortController();
  const provider = new FakeProvider((request) =>
    provider.conversationCalls.length === 1
      ? [toolCall('a'), toolCall('b'), { type: 'done', stopReason: 'tool_calls' }]
      : text('later answer'),
  );

  const started: string[] = [];
  const agent = makeAgent(provider, {
    onToolStart: (name) => {
      started.push(name);
      controller.abort();
    },
  });

  await agent.send('run two tools', controller.signal);

  assert.equal(started.length, 1, 'the second tool ran despite cancellation');
});

test('the signal reaches the provider so the HTTP request can be aborted', async () => {
  // It was declared on ModelRequest from the start but never supplied, so
  // cancelling left generation running and still billable.
  const controller = new AbortController();
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider);

  await agent.send('hello', controller.signal);

  assert.equal(provider.requests[0]?.signal, controller.signal);
});

test('a turn with no signal behaves exactly as before', async () => {
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider);

  await agent.send('hello');

  assert.equal(provider.requests[0]?.signal, undefined);
});
