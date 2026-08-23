import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool } from '../tools/define.js';
import { getTool, toolSpecs } from '../tools/index.js';
import { allowAll, denyAll, spyGate } from './helpers.js';

const context = { workspaceRoot: process.cwd() };

/** A tool that records whether its handler actually ran. */
function probeTool(options: { throws?: boolean } = {}) {
  const state = { ran: 0, lastInput: null as { value: string } | null };
  const tool = defineTool({
    name: 'probe',
    description: 'test probe',
    inputSchema: z.object({ value: z.string().min(1).describe('a value') }),
    classify: (input) => ({ operation: 'WRITE', detail: input.value }),
    async execute(input) {
      state.ran++;
      state.lastInput = input;
      if (options.throws) throw new Error('handler exploded');
      return { success: true, content: `got ${input.value}` };
    },
  });
  return { tool, state };
}

test('valid arguments reach the handler fully typed', async () => {
  const { tool, state } = probeTool();
  const result = await tool.run(JSON.stringify({ value: 'hi' }), context, allowAll());
  assert.deepEqual(result, { success: true, content: 'got hi' });
  assert.equal(state.lastInput?.value, 'hi');
});

test('malformed JSON is a retryable result, never a throw', async () => {
  const { tool, state } = probeTool();
  const result = await tool.run('{not json', context, allowAll());
  assert.equal(result.success, false);
  assert.ok(!result.success && result.retryable, 'model should try again');
  assert.ok(!result.success && result.error.includes('not valid JSON'));
  assert.equal(state.ran, 0, 'handler must not run on bad input');
});

test('the malformed input is echoed back so the model can see its mistake', async () => {
  const { tool } = probeTool();
  const result = await tool.run('{oops', context, allowAll());
  assert.ok(!result.success && result.error.includes('{oops'));
});

test('empty arguments are treated as an empty object, not a parse error', async () => {
  const empty = defineTool({
    name: 'empty',
    description: 'no args',
    inputSchema: z.object({}),
    classify: () => ({ operation: 'READ', detail: 'none' }),
    execute: async () => ({ success: true, content: 'ok' }),
  });
  assert.deepEqual(await empty.run('', context, allowAll()), {
    success: true,
    content: 'ok',
  });
});

test('schema violations are retryable and name the offending field', async () => {
  const { tool, state } = probeTool();
  const result = await tool.run(JSON.stringify({ wrong: 1 }), context, allowAll());
  assert.equal(result.success, false);
  assert.ok(!result.success && result.retryable);
  assert.ok(!result.success && result.error.includes('value'));
  assert.equal(state.ran, 0);
});

test('a throwing handler is contained, not propagated', async () => {
  const { tool } = probeTool({ throws: true });
  const result = await tool.run(JSON.stringify({ value: 'x' }), context, allowAll());
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('handler exploded'));
  assert.ok(!result.success && result.retryable === false);
});

test('ARCHITECTURE §4: the gate runs before the handler', async () => {
  const { tool, state } = probeTool();
  const result = await tool.run(JSON.stringify({ value: 'x' }), context, denyAll());
  assert.equal(result.success, false);
  assert.equal(state.ran, 0, 'a denied call must never execute');
  assert.ok(!result.success && result.error.startsWith('Denied by the user'));
});

test('the gate runs after validation, so it never sees invalid input', async () => {
  const { tool } = probeTool();
  const { gate, seen } = spyGate();
  await tool.run('{broken', context, gate);
  assert.equal(seen.length, 0, 'must not prompt about a call that cannot run');
});

test('classification is derived from validated input', async () => {
  const { tool } = probeTool();
  const { gate, seen } = spyGate();
  await tool.run(JSON.stringify({ value: 'the-detail' }), context, gate);
  assert.equal(seen[0]?.detail, 'the-detail');
  assert.equal(seen[0]?.operation, 'WRITE');
  assert.equal(seen[0]?.toolName, 'probe');
});

test('JSON Schema is derived from the Zod schema, with $schema stripped', () => {
  const { tool } = probeTool();
  assert.equal('$schema' in tool.parameters, false, 'providers reject unknown top-level keys');
  assert.equal(tool.parameters['type'], 'object');
  const properties = tool.parameters['properties'] as Record<string, unknown>;
  assert.ok('value' in properties);
  assert.deepEqual(tool.parameters['required'], ['value']);
});

test('the registry exposes exactly the registered tools', () => {
  const names = toolSpecs().map((spec) => spec.name).sort();
  assert.deepEqual(names, ['edit_file', 'read_file', 'run_command']);
});

test('an unknown tool name resolves to undefined rather than throwing', () => {
  assert.equal(getTool('delete_everything'), undefined);
  assert.ok(getTool('read_file'));
});

test('every registered tool advertises a description and parameters', () => {
  for (const spec of toolSpecs()) {
    assert.ok(spec.description.length > 20, `${spec.name} needs a real description`);
    assert.equal(spec.parameters['type'], 'object', spec.name);
  }
});
