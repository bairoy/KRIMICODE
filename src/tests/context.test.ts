import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ELIDED_TOOL_RESULT,
  budgetTokens,
  buildSummaryRequest,
  composeSystem,
  defaultPolicy,
  estimateTokens,
  mechanicalDigest,
  needsCompaction,
  planCompaction,
  renderTranscript,
  shrinkToolResults,
} from '../context.js';
import type { Message } from '../types.js';

const POLICY = defaultPolicy(10_000);

/** One complete turn: user asks, assistant calls a tool, the tool answers. */
function turn(n: number, toolChars = 50): Message[] {
  return [
    { role: 'user', content: `question ${n}` },
    {
      role: 'assistant',
      content: `thinking about ${n}`,
      toolCalls: [{ id: `call-${n}`, name: 'read_file', argsJson: '{"path":"a.ts"}' }],
    },
    { role: 'tool', toolCallId: `call-${n}`, content: 'x'.repeat(toolChars) },
    { role: 'assistant', content: `answer ${n}` },
  ];
}

function history(turns: number, toolChars = 50): Message[] {
  return Array.from({ length: turns }, (_, i) => turn(i, toolChars)).flat();
}

// --- estimateTokens ---------------------------------------------------------

test('token estimate grows with content length', () => {
  const small = estimateTokens([{ role: 'user', content: 'hi' }]);
  const large = estimateTokens([{ role: 'user', content: 'x'.repeat(3_000) }]);
  assert.ok(large > small + 900, 'roughly 1000 tokens for 3000 characters');
});

test('tool call arguments are counted, not just message content', () => {
  const withoutArgs = estimateTokens([{ role: 'assistant', content: 'ok' }]);
  const withArgs = estimateTokens([
    {
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'c1', name: 'edit_file', argsJson: 'y'.repeat(900) }],
    },
  ]);
  // Args are a real part of the request; ignoring them was how the estimate
  // could read "well under budget" for a request that then got rejected.
  assert.ok(withArgs > withoutArgs + 250);
});

test('an empty conversation costs nothing', () => {
  assert.equal(estimateTokens([]), 0);
});

// --- planCompaction: the turn-integrity invariant ---------------------------

test('nothing is elided while there are only the turns we must keep', () => {
  assert.equal(planCompaction(history(2), POLICY), null);
  assert.equal(planCompaction(history(1), POLICY), null);
  assert.equal(planCompaction([], POLICY), null);
});

test('the most recent turns are kept verbatim', () => {
  const plan = planCompaction(history(5), POLICY);
  assert.ok(plan);
  assert.equal(plan.keep.length, 8); // two turns of four messages
  assert.deepEqual(plan.keep[0], { role: 'user', content: 'question 3' });
  assert.equal(plan.elide.length, 12);
});

test('SECURITY: a cut never orphans a tool message from its assistant call', () => {
  // The failure this prevents: an OpenAI-compatible provider rejects the whole
  // request when a `tool` message has no preceding assistant tool call with a
  // matching id. That is a hard 400, and every later request repeats it.
  for (let turns = 3; turns <= 12; turns++) {
    const plan = planCompaction(history(turns), POLICY);
    assert.ok(plan, `expected a plan for ${turns} turns`);

    const announced = new Set<string>();
    for (const message of plan.keep) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) announced.add(call.id);
      } else if (message.role === 'tool') {
        assert.ok(
          announced.has(message.toolCallId),
          `orphaned tool result ${message.toolCallId} at ${turns} turns`,
        );
      }
    }
  }
});

test('a cut point is always a user message', () => {
  const plan = planCompaction(history(6), POLICY);
  assert.ok(plan);
  assert.equal(plan.keep[0]?.role, 'user');
});

test('the two halves reassemble into the original history', () => {
  const original = history(7);
  const plan = planCompaction(original, POLICY);
  assert.ok(plan);
  assert.deepEqual([...plan.elide, ...plan.keep], original);
});

// --- composeSystem ----------------------------------------------------------

test('with no summary the system prompt is untouched', () => {
  assert.deepEqual(composeSystem('BASE', null), {
    role: 'system',
    content: 'BASE',
  });
});

test('REGRESSION: repeated compaction replaces the summary, never appends', () => {
  // The summary lives inside the system message and is rebuilt from the base
  // prompt each time. Appending instead would grow the system message without
  // limit — a context leak in the code meant to prevent one.
  const first = composeSystem('BASE', 'summary one');
  const second = composeSystem('BASE', 'summary two');
  assert.ok(second.content.includes('summary two'));
  assert.ok(!second.content.includes('summary one'));
  assert.ok(second.content.length < first.content.length + 20);
});

test('the summary is marked as elided history, not presented as instructions', () => {
  const composed = composeSystem('BASE', 'the user asked for X');
  assert.match(composed.content, /elided/i);
});

// --- needsCompaction --------------------------------------------------------

test('compaction triggers below the window, leaving room for the reply', () => {
  const policy = defaultPolicy(10_000);
  assert.ok(budgetTokens(policy) < policy.maxTokens);

  // Comfortably past the budget: 4 characters per budgeted token, against an
  // estimate of 3 characters per token.
  const over: Message[] = [
    { role: 'user', content: 'x'.repeat(budgetTokens(policy) * 4) },
  ];
  assert.equal(needsCompaction(over, policy), true);
  assert.equal(needsCompaction([{ role: 'user', content: 'hi' }], policy), false);
});

// --- shrinkToolResults ------------------------------------------------------

test('shrinking never removes a tool message, only empties it', () => {
  const original = history(2, 40_000);
  const shrunk = shrinkToolResults(original, 100);

  assert.equal(shrunk.length, original.length);
  assert.deepEqual(
    shrunk.map((m) => m.role),
    original.map((m) => m.role),
  );
  // The ids must survive too — they are what pairs a result with its call.
  const ids = shrunk.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  assert.deepEqual(ids, ['call-0', 'call-1']);
});

test('shrinking empties the oldest results first', () => {
  // Two big results, a budget that only forces one of them out.
  const messages = history(2, 30_000);
  const target = estimateTokens(messages) - 5_000;
  const shrunk = shrinkToolResults(messages, target);

  const results = shrunk.filter((m) => m.role === 'tool');
  assert.equal(results[0]?.content, ELIDED_TOOL_RESULT);
  assert.notEqual(results[1]?.content, ELIDED_TOOL_RESULT);
});

test('an elided result still parses as a ToolResult', () => {
  // The system prompt promises tool results are that shape. A bare marker
  // string would read as corrupted data rather than a failed call.
  const parsed: unknown = JSON.parse(ELIDED_TOOL_RESULT);
  assert.equal((parsed as { success: boolean }).success, false);
  assert.equal((parsed as { retryable: boolean }).retryable, false);
});

test('nothing is touched when the conversation already fits', () => {
  const messages = history(2);
  assert.deepEqual(shrinkToolResults(messages, 1_000_000), messages);
});

test('shrinking stops once under budget rather than blanking everything', () => {
  const messages = history(6, 20_000);
  const shrunk = shrinkToolResults(messages, estimateTokens(messages) - 6_000);
  const remaining = shrunk.filter(
    (m) => m.role === 'tool' && m.content !== ELIDED_TOOL_RESULT,
  );
  assert.ok(remaining.length > 0, 'the newest results should survive');
});

// --- the summarization request ----------------------------------------------

test('history reaches the summarizer as text, never as messages', () => {
  // A tool message passed through as a message would be malformed, because the
  // elided range routinely begins or ends mid-turn.
  const request = buildSummaryRequest(null, history(3), POLICY);
  assert.equal(request.length, 2);
  assert.equal(request[0]?.role, 'system');
  assert.equal(request[1]?.role, 'user');
  assert.ok(!request.some((m) => m.role === 'tool'));
});

test('the transcript records tool calls and their results', () => {
  const text = renderTranscript(turn(1));
  assert.match(text, /USER: question 1/);
  assert.match(text, /called read_file/);
});

test('a previous summary is carried into the next summarization', () => {
  // Otherwise the second compaction silently discards everything the first one
  // preserved, and the session loses its early history entirely.
  const request = buildSummaryRequest('EARLIER FACTS', history(3), POLICY);
  assert.match(request[1]?.content ?? '', /EARLIER FACTS/);
});

test('the summarization request is itself capped to the budget', () => {
  const huge: Message[] = [{ role: 'user', content: 'z'.repeat(5_000_000) }];
  const request = buildSummaryRequest(null, huge, POLICY);
  assert.ok(estimateTokens(request) < budgetTokens(POLICY));
});

// --- the fallback digest ----------------------------------------------------

test('the digest keeps what the user asked and which tools ran', () => {
  const digest = mechanicalDigest(null, history(3));
  assert.match(digest, /question 0/);
  assert.match(digest, /read_file/);
});

test('the digest says it is a digest, so the model does not invent detail', () => {
  const digest = mechanicalDigest(null, history(2));
  assert.match(digest, /mechanical digest/i);
  assert.match(digest, /ask the user/i);
});

test('the digest also carries the previous summary forward', () => {
  assert.match(mechanicalDigest('EARLIER', history(2)), /EARLIER/);
});
