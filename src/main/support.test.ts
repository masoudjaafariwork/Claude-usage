// Tests for the small pure helpers: credentials parsing, settings sanitizing, Retry-After, PNG icons.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { parseCredentials } from './credentials';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';
import { encodePng, renderRing } from './tray-icon';
import { parseRetryAfter } from './usage-errors';

test('parseCredentials extracts the Claude Code OAuth block', () => {
  const text = JSON.stringify({
    mcpOAuth: { other: 'ignored' },
    claudeAiOauth: { accessToken: 'abc', refreshToken: 'r', expiresAt: 123, subscriptionType: 'max', rateLimitTier: 't' },
  });
  assert.deepEqual(parseCredentials(text, 'file'), {
    accessToken: 'abc',
    expiresAt: 123,
    subscriptionType: 'max',
    rateLimitTier: 't',
    source: 'file',
  });
});

test('parseCredentials rejects missing or malformed data', () => {
  assert.equal(parseCredentials('not json', 'file'), null);
  assert.equal(parseCredentials('{}', 'file'), null);
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: '' } }), 'file'), null);
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }), 'keychain')?.expiresAt, null);
});

test('sanitizeSettings fills defaults and clamps values', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  const s = sanitizeSettings({ position: { x: 10.4, y: 'bad' }, opacity: 5, refreshIntervalSec: 5, compact: true });
  assert.equal(s.position, null);
  assert.equal(s.opacity, 1);
  assert.equal(s.refreshIntervalSec, 60);
  assert.equal(s.compact, true);
  assert.deepEqual(sanitizeSettings({ position: { x: 10.4, y: -20.6 } }).position, { x: 10, y: -21 });
});

test('parseRetryAfter handles seconds and HTTP dates', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(parseRetryAfter('120', now), 120);
  assert.equal(parseRetryAfter('Wed, 23 Sep 2026 12:05:00 GMT', now), 300);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});

test('encodePng produces a valid PNG whose pixels round-trip', () => {
  const size = 16;
  const pixels = renderRing(size, { percent: 50, severity: 'warning' });
  const png = encodePng(size, size, pixels);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Extract IDAT, inflate, strip filter bytes, compare with the input pixels.
  const idatAt = png.indexOf('IDAT');
  const length = png.readUInt32BE(idatAt - 4);
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1)));
  assert.deepEqual(new Uint8Array(Buffer.concat(rows)), pixels);
});

test('renderRing fills the arc clockwise from 12 o’clock', () => {
  const size = 32;
  const px = renderRing(size, { percent: 25, severity: 'normal' });
  const at = (x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  // Right-hand side of the top-right quadrant is inside the 25% arc → severity color (green).
  const inArc = at(26, 9);
  assert.ok(inArc[1]! > inArc[0]! && inArc[3]! > 200, `expected green arc pixel, got ${inArc}`);
  // Left side of the ring is track → grey.
  const onTrack = at(3, 16);
  assert.ok(onTrack[0] === onTrack[1] && onTrack[3]! > 0, `expected grey track pixel, got ${onTrack}`);
  // Center is transparent.
  assert.equal(at(16, 16)[3], 0);
});
