import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReasoning,
  ToolCallAccumulator,
  toWireMessages,
} from '../provider.js';

test('a tool call split across chunks is reassembled', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } });
  acc.add({ index: 0, function: { arguments: '{"pa' } });
  acc.add({ index: 0, function: { arguments: 'th":"a.' } });
  acc.add({ index: 0, function: { arguments: 'txt"}' } });

  const { complete, incomplete } = acc.drain();
  assert.equal(incomplete.length, 0);
  assert.deepEqual(complete, [
    { id: 'call_1', name: 'read_file', argsJson: '{"path":"a.txt"}' },
  ]);
});

test('id and name are set once, so a provider that repeats them is fine', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{' } });
  acc.add({ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '}' } });

  const { complete } = acc.drain();
  assert.deepEqual(complete, [{ id: 'call_1', name: 'read_file', argsJson: '{}' }]);
});

test('REGRESSION: a later chunk without id must not erase the id', () => {
  // Assigning unconditionally would wipe the id to undefined here, and the
  // call would be reported incomplete.
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } });
  acc.add({ index: 0, function: { arguments: '' } });

  const { complete, incomplete } = acc.drain();
  assert.equal(incomplete.length, 0);
  assert.equal(complete[0]?.id, 'call_1');
});

test('parallel calls are kept apart by index even when interleaved', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"x"' } });
  acc.add({ index: 1, id: 'b', function: { name: 'run_command', arguments: '{"y"' } });
  acc.add({ index: 0, function: { arguments: ':1}' } });
  acc.add({ index: 1, function: { arguments: ':2}' } });

  const { complete } = acc.drain();
  assert.equal(complete.length, 2);
  assert.deepEqual(complete[0], { id: 'a', name: 'read_file', argsJson: '{"x":1}' });
  assert.deepEqual(complete[1], { id: 'b', name: 'run_command', argsJson: '{"y":2}' });
});

test('calls come back in index order regardless of arrival order', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 2, id: 'c', function: { name: 'third', arguments: '{}' } });
  acc.add({ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } });
  acc.add({ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } });

  assert.deepEqual(
    acc.drain().complete.map((call) => call.name),
    ['first', 'second', 'third'],
  );
});

test('a call missing id or name is reported incomplete, never guessed at', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, function: { name: 'no_id', arguments: '{}' } });
  acc.add({ index: 1, id: 'no_name', function: { arguments: '{}' } });

  const { complete, incomplete } = acc.drain();
  assert.equal(complete.length, 0);
  assert.deepEqual(incomplete, [
    { index: 0, missing: 'id' },
    { index: 1, missing: 'name' },
  ]);
});

test('a tool call with no arguments yields an empty string, not undefined', () => {
  const acc = new ToolCallAccumulator();
  acc.add({ index: 0, id: 'a', function: { name: 'noargs' } });
  assert.equal(acc.drain().complete[0]?.argsJson, '');
});

test('reasoning is read from every vendor field shape', () => {
  assert.equal(extractReasoning({ reasoning: 'openrouter' }), 'openrouter');
  assert.equal(extractReasoning({ reasoning_content: 'zai' }), 'zai');
  assert.equal(
    extractReasoning({ reasoning_details: [{ text: 'a' }, { text: 'b' }] }),
    'ab',
  );
});

test('malformed reasoning payloads yield an empty string rather than throwing', () => {
  assert.equal(extractReasoning({}), '');
  assert.equal(extractReasoning({ reasoning: 42 }), '');
  assert.equal(extractReasoning({ reasoning_details: 'not-an-array' }), '');
  assert.equal(extractReasoning({ reasoning_details: [null, 7, { text: 'x' }] }), 'x');
  assert.equal(extractReasoning({ reasoning_details: [{ nope: 1 }] }), '');
  assert.equal(extractReasoning(null), '');
});

test('our message shape is translated to the wire format', () => {
  const wire = toWireMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: '{"success":true}' },
  ]);

  assert.equal(wire.length, 4);
  // camelCase becomes snake_case at this boundary and nowhere else.
  assert.deepEqual(wire[2], {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    ],
  });
  assert.deepEqual(wire[3], {
    role: 'tool',
    tool_call_id: 'c1',
    content: '{"success":true}',
  });
});

test('an assistant message with no tool calls omits tool_calls entirely', () => {
  const wire = toWireMessages([{ role: 'assistant', content: 'plain' }]);
  assert.deepEqual(wire[0], { role: 'assistant', content: 'plain' });
});

test('empty assistant content becomes null when tool calls are present', () => {
  // The API rejects an empty string here.
  const wire = toWireMessages([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c', name: 'n', argsJson: '{}' }],
    },
  ]);
  assert.equal((wire[0] as { content: unknown }).content, null);
});
