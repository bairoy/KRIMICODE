import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agent, MaxTurnsError } from '../agent.js';
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
    last.messages.some((m) =>
      m.content.includes('MARKER: the actual current question'),
    ),
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
  assert.ok(
    seen.some((info) => info.fallback),
    'fallback was never reported',
  );

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
  assert.ok(
    first.tokensAfter < first.tokensBefore,
    'compaction did not shrink anything',
  );
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

test('compact() folds history that is nowhere near the budget', async () => {
  // The whole point of the manual command: automatic compaction only ever
  // happens at the worst moment, part-way through a turn the user is waiting
  // on. Three short turns are far under a 6000-token window.
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY OF EARLIER WORK') : text('ok'),
  );
  const agent = makeAgent(provider);

  for (const line of ['first', 'second', 'third']) await agent.send(line);
  assert.equal(provider.summarizerCalls.length, 0, 'nothing forced it yet');

  const info = await agent.compact();

  assert.ok(info, 'forced compaction did nothing');
  assert.ok(info.messagesElided > 0);
  assert.equal(provider.summarizerCalls.length, 1);
  assert.match(agent.snapshot().summary ?? '', /SUMMARY OF EARLIER WORK/);
});

test('compact() keeps the recent turns verbatim, exactly as the automatic path does', async () => {
  // A manual compaction that dropped live task state would be worse than never
  // compacting: the user asks for it *before* an expensive request.
  const provider = new FakeProvider((request) =>
    isSummarizer(request) ? text('SUMMARY') : text('ok'),
  );
  const agent = makeAgent(provider);

  for (const line of ['first', 'second', 'third']) await agent.send(line);
  await agent.compact();

  const kept = agent
    .snapshot()
    .history.filter((message) => message.role === 'user')
    .map((message) => message.content);
  assert.deepEqual(kept, ['second', 'third']);
});

test('compact() reports null rather than faking a compaction', async () => {
  const provider = new FakeProvider(() => text('ok'));
  const agent = makeAgent(provider);
  await agent.send('hello');

  assert.equal(await agent.compact(), null);
  assert.equal(
    provider.summarizerCalls.length,
    0,
    'a hopeless compaction must not cost a model call',
  );
});

test('compact() on an empty conversation is a no-op, not a crash', async () => {
  const agent = makeAgent(new FakeProvider(() => text('ok')));

  assert.equal(await agent.compact(), null);
});

test('a cancelled compact() leaves history untouched', async () => {
  // Cancelling mid-summary must not bake a half-finished result in. The
  // conversation has to be exactly as compactable afterwards as before.
  const controller = new AbortController();
  const provider = new FakeProvider((request) => {
    if (isSummarizer(request)) {
      controller.abort();
      return text('SUMMARY');
    }
    return text('ok');
  });
  const agent = makeAgent(provider);

  for (const line of ['first', 'second', 'third']) await agent.send(line);
  const before = agent.snapshot();

  assert.equal(await agent.compact(controller.signal), null);
  assert.deepEqual(agent.snapshot(), before);
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
  const provider = new FakeProvider(() => {
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
      ? [
          toolCall('a'),
          toolCall('b'),
          toolCall('c'),
          { type: 'done', stopReason: 'tool_calls' },
        ]
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
  const provider = new FakeProvider(() =>
    provider.conversationCalls.length === 1
      ? [
          toolCall('a'),
          toolCall('b'),
          { type: 'done', stopReason: 'tool_calls' },
        ]
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

// --- the runaway-loop guard -------------------------------------------------

test('a model that never answers trips the turn limit as a typed error', async () => {
  // A bare Error here is indistinguishable from a network failure, so the user
  // is told the agent broke when the real fix is to narrow the request.
  const provider = new FakeProvider(() => [
    toolCall('runaway'),
    { type: 'done', stopReason: 'tool_calls' },
  ]);
  const agent = makeAgent(provider);

  await assert.rejects(
    () => agent.send('loop forever'),
    (err: unknown) => err instanceof MaxTurnsError && err.turns > 0,
  );
});

test('history is still well-formed after the turn limit trips', async () => {
  // The whole point of throwing at the top of the loop: every announced tool
  // call already has its result, so the conversation survives and the user can
  // keep going. Leaving one unanswered would make every later request a 400.
  const provider = new FakeProvider(() => [
    toolCall('runaway'),
    { type: 'done', stopReason: 'tool_calls' },
  ]);
  const agent = makeAgent(provider);

  await assert.rejects(() => agent.send('loop forever'));

  const sent = provider.conversationCalls.at(-1)?.messages ?? [];
  // Without this the loop below could pass by iterating over nothing.
  assert.ok(sent.length > 3, 'expected a real conversation to inspect');

  const announced = new Set<string>();
  let toolResults = 0;
  for (const message of sent) {
    if (message.role === 'assistant') {
      for (const c of message.toolCalls ?? []) announced.add(c.id);
    } else if (message.role === 'tool') {
      toolResults++;
      assert.ok(
        announced.has(message.toolCallId),
        `orphaned tool result ${message.toolCallId}`,
      );
    }
  }
  assert.ok(toolResults > 0, 'expected tool results to have been checked');
});

// --- saving and resuming ----------------------------------------------------

test('a snapshot carries the history the model was sent', async () => {
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider);

  await agent.send('hello');
  const state = agent.snapshot();

  assert.deepEqual(state.history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(state.summary, null);
});

test('a snapshot is a copy, not a live view of history', async () => {
  // A caller that saves a snapshot and then keeps talking must not find the
  // saved object mutating underneath it.
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider);

  await agent.send('first');
  const state = agent.snapshot();
  await agent.send('second');

  assert.equal(state.history.length, 2, 'the snapshot grew after being taken');
});

test('restored history is sent to the model on the next turn', async () => {
  // The whole point of resuming: the model has to actually see what was said
  // before, not just have it sitting in a field.
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider, {
    initialState: {
      history: [
        { role: 'user', content: 'we discussed the parser' },
        { role: 'assistant', content: 'yes, in src/parse.ts' },
      ],
      summary: 'earlier: explored the codebase',
    },
  });

  await agent.send('what was the file again?');

  const sent = provider.conversationCalls[0]?.messages ?? [];
  assert.match(
    sent.map((m) => m.content).join('\n'),
    /we discussed the parser/,
    'restored history never reached the model',
  );
  // The summary lives in the system message, which is rebuilt per request.
  assert.match(sent[0]?.content ?? '', /earlier: explored the codebase/);
});

test('a restored conversation can be snapshotted again', async () => {
  // Resume, talk, save: the second save must contain both halves, or a session
  // silently loses everything from before the last resume.
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider, {
    initialState: {
      history: [{ role: 'user', content: 'original question' }],
      summary: null,
    },
  });

  await agent.send('follow-up');
  const state = agent.snapshot();

  assert.equal(
    state.history.length,
    3,
    'expected original + follow-up + reply',
  );
  assert.equal(state.history[0]?.content, 'original question');
});

test('reset clears the summary along with the history', async () => {
  // Leaving the summary behind would silently reintroduce a description of
  // turns that no longer exist into the next request.
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider, {
    initialState: {
      // Distinctive markers: a short word like "old" also occurs inside the
      // system prompt (in "old_str"), which made this assertion fire on
      // unrelated text.
      history: [{ role: 'user', content: 'MARKER_PRIOR_HISTORY' }],
      summary: 'MARKER_PRIOR_SUMMARY',
    },
  });

  agent.reset();
  await agent.send('brand new question');

  const sent = provider.conversationCalls[0]?.messages ?? [];
  const whole = sent.map((m) => m.content).join('\n');
  assert.equal(whole.includes('MARKER_PRIOR_SUMMARY'), false);
  assert.equal(whole.includes('MARKER_PRIOR_HISTORY'), false);
});

test('the model can be switched mid-session', async () => {
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider);

  await agent.send('first');
  agent.model = 'another-model';
  await agent.send('second');

  assert.equal(provider.conversationCalls[0]?.model, 'test-model');
  assert.equal(provider.conversationCalls[1]?.model, 'another-model');
});

// --- the repeated-failure breaker -------------------------------------------

test('an identical failing call is not run forever', async () => {
  // Found by manual testing: the model asked to edit a line whose secret had
  // been redacted, so old_str could never match. It reissued the byte-identical
  // call 22 times, once per turn, until it ran out of turns and credits.
  const provider = new FakeProvider(() => [
    toolCall('same'),
    { type: 'done', stopReason: 'tool_calls' },
  ]);
  const agent = makeAgent(provider);

  await assert.rejects(() => agent.send('do the impossible thing'));

  // Every turn still announced a call and still got a result — the loop is
  // intact — but the tool itself stopped being invoked.
  const results =
    provider.conversationCalls
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool')
      .map((m) => m.content) ?? [];

  assert.ok(results.length > 3, 'expected several attempts to inspect');
  assert.ok(
    results.some((r) => r.includes('already failed')),
    'the breaker never fired',
  );
});

test('the breaker allows one retry before giving up', async () => {
  // Transient failures are real — a timeout, a file being written just then —
  // so the second attempt still runs. Only the third is refused.
  const provider = new FakeProvider(() => [
    toolCall('same'),
    { type: 'done', stopReason: 'tool_calls' },
  ]);
  const agent = makeAgent(provider);

  await assert.rejects(() => agent.send('try repeatedly'));

  const results =
    provider.conversationCalls
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool')
      .map((m) => m.content) ?? [];

  const blocked = results.filter((r) => r.includes('already failed')).length;
  assert.equal(results.length - blocked, 2, 'expected exactly two real runs');
});

test('a call that differs is not blocked by an earlier failure', async () => {
  // The key is name plus arguments. Blocking on name alone would stop the
  // model correcting a typo in a path.
  let seen = 0;
  const provider = new FakeProvider(() => {
    seen++;
    if (seen > 4) return text('done');
    return [
      {
        type: 'tool_call',
        id: `c${seen}`,
        name: 'no_such_tool',
        argsJson: `{"attempt":${seen}}`,
      },
      { type: 'done', stopReason: 'tool_calls' },
    ];
  });
  const agent = makeAgent(provider);

  await agent.send('try different things');

  const results =
    provider.conversationCalls
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool')
      .map((m) => m.content) ?? [];

  assert.equal(
    results.some((r) => r.includes('already failed')),
    false,
    'distinct calls were wrongly treated as repeats',
  );
});

test('a successful call is never counted as a failure', async () => {
  // Asking git_status five times as the tree changes is legitimate.
  let seen = 0;
  const provider = new FakeProvider(() => {
    seen++;
    if (seen > 5) return text('done');
    return [
      {
        type: 'tool_call',
        id: `c${seen}`,
        name: 'list_files',
        argsJson: '{"path":"."}',
      },
      { type: 'done', stopReason: 'tool_calls' },
    ];
  });
  const agent = makeAgent(provider);

  await agent.send('keep looking');

  const results =
    provider.conversationCalls
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool')
      .map((m) => m.content) ?? [];

  assert.equal(
    results.some((r) => r.includes('already failed')),
    false,
    'a repeated successful call was blocked',
  );
});

test('clearing the conversation forgets past failures', async () => {
  const provider = new FakeProvider(() => [
    toolCall('same'),
    { type: 'done', stopReason: 'tool_calls' },
  ]);
  const agent = makeAgent(provider);
  await assert.rejects(() => agent.send('fail repeatedly'));

  agent.reset();
  await assert.rejects(() => agent.send('fail repeatedly again'));

  // After a reset the tool runs again rather than being refused immediately.
  const results =
    provider.conversationCalls
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool')
      .map((m) => m.content) ?? [];
  assert.ok(
    results.some((r) => r.includes('Unknown tool')),
    'the tool was never retried after the reset',
  );
});

test('the system prompt tells the model that code in a reply is not the work', async () => {
  // A weaker model answered "write a program in b.ts" by printing the program
  // in its reply and stopping. The file was untouched and the user had a
  // confident-looking answer saying otherwise.
  const provider = new FakeProvider(() => text('answer'));
  const agent = makeAgent(provider);

  await agent.send('hello');

  const system = provider.conversationCalls[0]?.messages[0];
  assert.equal(system?.role, 'system');
  assert.match(system.content, /not the work/i);
  // And the one workflow the tool set does not make obvious.
  assert.match(system.content, /read_file it first, then edit_file/i);
});
