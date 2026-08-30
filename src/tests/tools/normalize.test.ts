import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capOutput, normalizeToolResult } from '../../tools/normalize.js';
import { registerSecret } from '../../redact.js';

test('output under the cap is returned unchanged', () => {
  const text = 'x'.repeat(29_999);
  assert.equal(capOutput(text), text);
});

test('output over the cap keeps head and tail with an elision marker', () => {
  const text = `HEAD${'x'.repeat(60_000)}TAIL`;
  const capped = capOutput(text);

  assert.ok(capped.startsWith('HEAD'), 'head must survive');
  assert.ok(capped.endsWith('TAIL'), 'tail must survive');
  assert.match(capped, /\[\.\.\. \d+ characters elided \.\.\.\]/);
  assert.ok(capped.length < text.length);
});

test('the tail is kept because errors and conclusions live at the end', () => {
  const log = `${'noise\n'.repeat(20_000)}FATAL: the actual cause`;
  assert.ok(capOutput(log).includes('FATAL: the actual cause'));
});

test('the elided count is accurate', () => {
  const text = 'x'.repeat(50_000);
  const match = /\[\.\.\. (\d+) characters elided \.\.\.\]/.exec(
    capOutput(text),
  );
  assert.ok(match);
  // 50000 total - 20000 head - 10000 tail
  assert.equal(Number(match[1]), 20_000);
});

test('successful results are redacted and capped', () => {
  const result = normalizeToolResult({
    success: true,
    content: 'DB_PASSWORD=hunter2correcthorse',
  });
  assert.equal(result.success, true);
  assert.ok(result.success && result.content.includes('[REDACTED]'));
});

test('error messages are redacted too — they often quote the bad input', () => {
  const result = normalizeToolResult({
    success: false,
    error: 'failed on API_KEY=supersecretvalue',
    retryable: true,
  });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.includes('[REDACTED]'));
  assert.ok(
    !result.success && result.error.includes('supersecretvalue') === false,
  );
});

test('retryable is carried through unchanged', () => {
  for (const retryable of [true, false]) {
    const result = normalizeToolResult({
      success: false,
      error: 'x',
      retryable,
    });
    assert.equal(result.success === false && result.retryable, retryable);
  }
});

test('REGRESSION: redaction runs before capping', () => {
  // A secret placed just past the 20,000-char head boundary. If capping ran
  // first the secret would be cut in half, the pattern would no longer match,
  // and a fragment would leak. Ordering is the only thing preventing that.
  registerSecret('sk-test-leakcanary-0123456789');
  const secret = 'sk-test-leakcanary-0123456789';
  const text = `${'a'.repeat(19_990)}${secret}${'b'.repeat(40_000)}`;

  const result = normalizeToolResult({ success: true, content: text });
  assert.equal(result.success, true);
  assert.ok(result.success);

  assert.equal(
    result.content.includes(secret),
    false,
    'whole secret must not appear',
  );
  // No partial either — check every prefix long enough to be identifiable.
  for (let len = 12; len < secret.length; len++) {
    assert.equal(
      result.content.includes(secret.slice(0, len)),
      false,
      `leaked a ${len}-char prefix of the secret`,
    );
  }
});
