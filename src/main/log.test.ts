import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOG_FILE, RotatingLog, redact } from './log';

// Fake secrets, shaped like the real ones.
const OAUTH = 'sk-ant-oat01-AbCdEf0123456789_xyz-QWERTY';
const SESSION = 'sk-ant-sid01-Zyx987654321-abcDEF_ghi';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl';

test('redacts bearer tokens and Anthropic keys', () => {
  assert.equal(redact(`Authorization: Bearer ${OAUTH}`), 'Authorization: Bearer [redacted]');
  assert.equal(redact(`token was ${OAUTH}.`), 'token was sk-ant-[redacted].');
  assert.equal(redact(`key ${SESSION}`), 'key sk-ant-[redacted]');
});

test('redacts cookies: headers, name=value pairs and JSON fields', () => {
  assert.equal(redact(`Cookie: sessionKey=${SESSION}; cf_clearance=abc.def-123`), 'Cookie: [redacted]');
  assert.equal(redact(`set-cookie: __cf_bm=xyz; path=/`), 'set-cookie: [redacted]');
  assert.equal(redact(`got sessionKey=abc123&next=1`), 'got sessionKey=[redacted]&next=1');
  assert.equal(redact('url?access_token=abc&refresh_token=def'), 'url?access_token=[redacted]&refresh_token=[redacted]');
  assert.equal(
    redact('{"accessToken": "abc", "refreshToken":"def", "expiresAt": 123}'),
    '{"accessToken":"[redacted]", "refreshToken":"[redacted]", "expiresAt": 123}',
  );
});

test('redacts JWTs and e-mail addresses, shortens UUIDs', () => {
  assert.equal(redact(`id ${JWT} end`), 'id [redacted-jwt] end');
  assert.equal(redact('signed in as someone.name+tag@example.co.uk'), 'signed in as [email]');
  assert.equal(redact('org 1a2b3c4d-1111-4222-8333-444455556666 picked'), 'org 1a2b3c4d-… picked');
});

test('leaves ordinary diagnostics untouched', () => {
  const lines = [
    'GET api.anthropic.com/api/oauth/usage → 200 in 312 ms',
    'ok via Claude Desktop',
    'Claude Code: network-error — Can\'t reach Anthropic (net::ERR_INTERNET_DISCONNECTED).',
    'no usable source (auto): token-expired, desktop-unavailable',
  ];
  for (const line of lines) assert.equal(redact(line), line);
});

test('RotatingLog writes redacted lines and keeps one previous file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-log-'));
  try {
    const log = new RotatingLog(dir, { maxBytes: 300, now: () => new Date('2026-09-25T10:00:00Z') });
    log.info(`Authorization: Bearer ${OAUTH}`);
    const first = readFileSync(join(dir, LOG_FILE), 'utf8');
    assert.equal(first, '2026-09-25T10:00:00.000Z INFO  Authorization: Bearer [redacted]\n');
    assert.ok(!first.includes('oat01'));

    for (let i = 0; i < 10; i++) log.warn(`line ${i} ${'x'.repeat(40)}`);
    assert.ok(existsSync(join(dir, 'claude-usage.1.log')), 'rotated');
    assert.ok(readFileSync(join(dir, LOG_FILE), 'utf8').length <= 300);
    assert.ok(readFileSync(join(dir, LOG_FILE), 'utf8').includes('line 9'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
