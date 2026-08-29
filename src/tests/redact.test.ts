import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registerSecret } from '../redact.js';

test('exact registered secrets are removed everywhere they appear', () => {
  registerSecret('sk-or-v1-0123456789abcdefghij');
  const out = redact(
    'a sk-or-v1-0123456789abcdefghij b sk-or-v1-0123456789abcdefghij',
  );
  assert.equal(out, 'a [REDACTED] b [REDACTED]');
});

test('short values are not registered, so ordinary text is not corrupted', () => {
  registerSecret('the');
  assert.equal(redact('the quick brown fox'), 'the quick brown fox');
});

test('registered secrets are matched literally, not as a regex', () => {
  registerSecret('aaa.*bbb-literal-secret');
  assert.equal(redact('x aaaZZZbbb y'), 'x aaaZZZbbb y');
  assert.equal(redact('x aaa.*bbb-literal-secret y'), 'x [REDACTED] y');
});

test('vendor-prefixed API keys', () => {
  for (const key of [
    'sk-abcdefghijklmnopqrstuvwx',
    'sk-or-v1-abcdefghijklmnopqrst',
    'sk-ant-api03-abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'xoxb-1234567890-abcdefghij',
  ]) {
    assert.equal(redact(`token=${key} end`).includes(key), false, key);
  }
});

test('AWS access key ids', () => {
  assert.equal(redact('id AKIAIOSFODNN7EXAMPLE done'), 'id [REDACTED] done');
  assert.equal(redact('id ASIAIOSFODNN7EXAMPLE done'), 'id [REDACTED] done');
});

test('JWTs', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  assert.equal(redact(`auth ${jwt}`).includes(jwt), false);
});

test('bearer tokens in captured headers', () => {
  const out = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
  assert.equal(out.includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('PEM private key blocks are removed including the body', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAsecretbodyhere',
    'moresecretbodyhere',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redact(`before\n${pem}\nafter`);
  assert.equal(out.includes('secretbodyhere'), false);
  assert.equal(out.includes('before'), true);
  assert.equal(out.includes('after'), true);
});

test('two PEM blocks are redacted separately, not merged', () => {
  const block = (n: string) =>
    `-----BEGIN PRIVATE KEY-----\nbody${n}\n-----END PRIVATE KEY-----`;
  const out = redact(`${block('A')}\nKEEP-THIS-TEXT\n${block('B')}`);
  assert.equal(
    out.includes('KEEP-THIS-TEXT'),
    true,
    'lazy match must stop at first END',
  );
  assert.equal(out.includes('bodyA'), false);
  assert.equal(out.includes('bodyB'), false);
});

test('secret-shaped assignments keep the key name and drop the value', () => {
  // The point: "hunter2correcthorse" has no recognisable shape. Only the key
  // name reveals it is a secret.
  assert.equal(
    redact('DB_PASSWORD=hunter2correcthorse'),
    'DB_PASSWORD=[REDACTED]',
  );
  assert.equal(redact('api_key: "somethingsecret"'), 'api_key: "[REDACTED]"');
  assert.equal(redact('ACCESS_KEY = plainvalue123'), 'ACCESS_KEY = [REDACTED]');
});

test('quotes are preserved symmetrically via the back-reference', () => {
  assert.equal(redact("token='abcdefghij'"), "token='[REDACTED]'");
  assert.equal(redact('token="abcdefghij"'), 'token="[REDACTED]"');
});

test('non-secret assignments are left alone', () => {
  assert.equal(redact('region = ap-south-1'), 'region = ap-south-1');
  assert.equal(redact('retry_limit = 3'), 'retry_limit = 3');
  assert.equal(
    redact('service_name = billing-worker'),
    'service_name = billing-worker',
  );
});

test('ordinary prose survives untouched', () => {
  const prose = 'The agent reads a file and returns its contents to the model.';
  assert.equal(redact(prose), prose);
});
