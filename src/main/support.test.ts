// Tests for the small pure helpers: credentials parsing, settings sanitizing, snapshot cache,
// Retry-After, PNG icons.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { accountInfo, parseClaudeCodeAccount, parseCredentials } from './credentials';
import { DEFAULT_SETTINGS, sanitizeSettings, stepScale } from './settings';
import { loadSnapshot } from './snapshot-cache';
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

test('parseClaudeCodeAccount reads oauthAccount from .claude.json', () => {
  const text = JSON.stringify({
    numStartups: 3,
    oauthAccount: {
      accountUuid: 'a-1',
      emailAddress: 'ada@example.com',
      displayName: 'Ada Lovelace',
      organizationUuid: 'org-1',
      organizationName: "ada@example.com's Organization",
      organizationRole: 'admin',
    },
  });
  assert.deepEqual(parseClaudeCodeAccount(text), {
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    orgName: "ada@example.com's Organization",
    orgUuid: 'org-1',
  });
  assert.equal(parseClaudeCodeAccount('not json'), null);
  assert.equal(parseClaudeCodeAccount('{}'), null, 'signed out: no oauthAccount');
  assert.equal(parseClaudeCodeAccount(JSON.stringify({ oauthAccount: { emailAddress: '' } })), null);
});

test('accountInfo leaves out the personal org name but keeps a team org', () => {
  const ada = { email: 'ada@example.com', name: 'Ada Lovelace', orgUuid: 'org-1' };
  assert.deepEqual(accountInfo({ ...ada, orgName: "ada@example.com's Organization" }), {
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    organization: null,
  });
  assert.equal(accountInfo({ ...ada, orgName: "Ada Lovelace's Organization" })?.organization, null);
  assert.equal(accountInfo({ ...ada, orgName: 'Analytical Engines Ltd' })?.organization, 'Analytical Engines Ltd');
  assert.equal(accountInfo({ email: null, name: null, orgName: 'Team', orgUuid: 'org-1' }), null, 'nobody to show');
  assert.equal(accountInfo(null), null);
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

test('sanitizeSettings keeps known source modes only', () => {
  assert.equal(DEFAULT_SETTINGS.source, 'auto');
  assert.equal(sanitizeSettings({ source: 'claude-desktop' }).source, 'claude-desktop');
  assert.equal(sanitizeSettings({ source: 'claude-ai' }).source, 'auto');
  assert.equal(sanitizeSettings({ source: 42 }).source, 'auto');
});

test('sanitizeSettings: Phase 4 options (lock, scale, theme, notifications, shortcuts)', () => {
  assert.equal(DEFAULT_SETTINGS.locked, false);
  assert.equal(DEFAULT_SETTINGS.theme, 'dark');
  assert.deepEqual(DEFAULT_SETTINGS.notifyAt, [75, 90, 100]);
  const s = sanitizeSettings({
    locked: true,
    scale: 1.3,
    theme: 'light',
    notifyAt: [100, 90, 'x', 50, 90],
    notifyReset: false,
    shortcutsEnabled: false,
    toggleShortcut: 'Ctrl+Shift+F9',
    lockShortcut: 'L',
  });
  assert.equal(s.locked, true);
  assert.equal(s.scale, 1.3);
  assert.equal(s.theme, 'light');
  assert.deepEqual(s.notifyAt, [90, 100]);
  assert.equal(s.notifyReset, false);
  assert.equal(s.shortcutsEnabled, false);
  assert.equal(s.toggleShortcut, 'Ctrl+Shift+F9');
  assert.equal(s.lockShortcut, DEFAULT_SETTINGS.lockShortcut); // no modifier: rejected
  const bad = sanitizeSettings({ locked: 'yes', scale: 1.2, theme: 'blue', notifyAt: 'all' });
  assert.equal(bad.locked, false);
  assert.equal(bad.scale, 1);
  assert.equal(bad.theme, 'dark');
  assert.deepEqual(bad.notifyAt, [75, 90, 100]);
  assert.deepEqual(sanitizeSettings({ notifyAt: [] }).notifyAt, []); // all switched off
});

test('stepScale moves one size up or down and stops at the ends', () => {
  assert.equal(stepScale(1, 1), 1.15);
  assert.equal(stepScale(1.15, -1), 1);
  assert.equal(stepScale(1.5, 1), 1.5);
  assert.equal(stepScale(0.9, -1), 0.9);
  assert.equal(stepScale(1.2, 1), 1.15); // unknown value: treated as 100 %
});

test('sanitizeSettings keeps compactHidden as a list of unique ids', () => {
  assert.deepEqual(DEFAULT_SETTINGS.compactHidden, []);
  assert.deepEqual(sanitizeSettings({ compactHidden: 'weekly_all' }).compactHidden, []);
  assert.deepEqual(
    sanitizeSettings({ compactHidden: ['weekly_all', 7, '', 'weekly_scoped:fable', 'weekly_all', 'x'.repeat(101)] }).compactHidden,
    ['weekly_all', 'weekly_scoped:fable'],
  );
});

test('sanitizeSettings keeps Claude Code folders, and a selected folder only when it is in the list', () => {
  assert.deepEqual([DEFAULT_SETTINGS.claudeCodeDirs, DEFAULT_SETTINGS.claudeCodeDir], [[], null]);
  const dirs = ['D:\\Revaal\\claude-config', 'E:\\work', 'D:\\Revaal\\claude-config', ' ', 42, 'x'.repeat(1025)];
  const clean = sanitizeSettings({ claudeCodeDirs: dirs, claudeCodeDir: 'E:\\work' });
  assert.deepEqual(clean.claudeCodeDirs, ['D:\\Revaal\\claude-config', 'E:\\work']);
  assert.equal(clean.claudeCodeDir, 'E:\\work');
  assert.equal(sanitizeSettings({ claudeCodeDirs: ['E:\\work'], claudeCodeDir: 'F:\\gone' }).claudeCodeDir, null);
  assert.equal(sanitizeSettings({ claudeCodeDir: 'E:\\work' }).claudeCodeDir, null, 'not in the list');
  assert.equal(sanitizeSettings({ claudeCodeDirs: Array.from({ length: 30 }, (_, i) => `D:\\a${i}`) }).claudeCodeDirs.length, 20);
});

test('loadSnapshot treats snapshots cached before Phase 3 as Claude Code data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-cache-'));
  try {
    const file = join(dir, 'last-usage.json');
    const meter = { id: 'session', group: 'session', label: 'Current session', percent: 5, severity: 'normal', resetsAt: null, isActive: false };
    writeFileSync(file, JSON.stringify({ fetchedAt: '2026-09-24T10:00:00.000Z', plan: 'Max 20×', meters: [meter], breakdown: [], spend: null }));
    assert.equal(loadSnapshot(file)?.source, 'claude-code');
    writeFileSync(file, JSON.stringify({ fetchedAt: '2026-09-24T10:00:00.000Z', plan: null, meters: [meter], source: 'claude-desktop' }));
    assert.equal(loadSnapshot(file)?.source, 'claude-desktop');
    assert.equal(loadSnapshot(file)?.account, null, 'cached before accounts were shown');
    const account = { email: 'ada@example.com', name: null, organization: 'Analytical Engines Ltd' };
    writeFileSync(file, JSON.stringify({ fetchedAt: '2026-09-24T10:00:00.000Z', plan: null, meters: [meter], account }));
    assert.deepEqual(loadSnapshot(file)?.account, account);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
