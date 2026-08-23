import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

const FAKE_KEY = 'sk-test-value-not-real-000000';

/** A complete valid environment, with overrides applied on top. */
const env = (overrides: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    OPENAI_API_KEY: FAKE_KEY,
    OPENAI_BASE_URL: 'https://example.invalid/v1',
    MODEL_NAME: 'test-model',
  };
  return { ...base, ...overrides } as NodeJS.ProcessEnv;
};

test('a valid environment produces config', () => {
  const config = loadConfig(env());
  assert.equal(config.apiKey, FAKE_KEY);
  assert.equal(config.baseURL, 'https://example.invalid/v1');
  assert.equal(config.model, 'test-model');
  assert.equal(config.workspaceRoot, process.cwd());
  assert.deepEqual(config.extraBody, {});
});

test('unrelated environment variables are ignored', () => {
  const config = loadConfig(env({ PATH: '/usr/bin', HOME: '/home/x' }));
  assert.equal(config.model, 'test-model');
});

test('a missing variable is named without revealing any value', () => {
  try {
    loadConfig(env({ MODEL_NAME: undefined }));
    assert.fail('expected loadConfig to throw');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /MODEL_NAME/);
    // The whole point of the error branch: it must not echo the API key.
    assert.equal(
      message.includes(FAKE_KEY),
      false,
      'error message leaked the API key',
    );
  }
});

test('an empty value is rejected, not treated as present', () => {
  assert.throws(() => loadConfig(env({ OPENAI_API_KEY: '' })), /OPENAI_API_KEY/);
});

test('a structurally invalid base URL is rejected', () => {
  assert.throws(
    () => loadConfig(env({ OPENAI_BASE_URL: 'not a url' })),
    /OPENAI_BASE_URL/,
  );
});

test('a well-formed but unreachable URL is accepted', () => {
  // Config validates shape, not reachability — deliberately, so startup is
  // neither slow nor flaky. The cost is that a wrong-but-valid URL surfaces
  // later as a connection error.
  const config = loadConfig(env({ OPENAI_BASE_URL: 'http://localhost:8000/v1' }));
  assert.equal(config.baseURL, 'http://localhost:8000/v1');
});

test('EXTRA_BODY is parsed into an object', () => {
  const config = loadConfig(env({ EXTRA_BODY: '{"include_reasoning":true}' }));
  assert.deepEqual(config.extraBody, { include_reasoning: true });
});

test('EXTRA_BODY must be valid JSON', () => {
  assert.throws(() => loadConfig(env({ EXTRA_BODY: '{broken' })), /valid JSON/);
});

test('EXTRA_BODY must be an object, not an array or a scalar', () => {
  for (const value of ['[1,2]', '5', '"text"']) {
    assert.throws(
      () => loadConfig(env({ EXTRA_BODY: value })),
      /must be a JSON object/,
      `accepted ${value}`,
    );
  }
});

test('REGRESSION: EXTRA_BODY=null is rejected despite typeof null === "object"', () => {
  assert.throws(
    () => loadConfig(env({ EXTRA_BODY: 'null' })),
    /must be a JSON object/,
  );
});

test('all four problems are reported at once, not one at a time', () => {
  try {
    loadConfig({ OPENAI_BASE_URL: 'nope' } as NodeJS.ProcessEnv);
    assert.fail('expected a throw');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /OPENAI_API_KEY/);
    assert.match(message, /OPENAI_BASE_URL/);
    assert.match(message, /MODEL_NAME/);
  }
});
