import assert from 'node:assert/strict';
import { test } from 'node:test';
import realResponse from './fixtures/usage-2026-09.json';
import { UsageParseError, formatPlan, parseUsage, severityFor } from './usage-parse';

const NOW = new Date('2026-09-23T23:00:00Z');

test('parses the modern limits[] array from a real response', () => {
  const snap = parseUsage(realResponse, 'Max 20×', NOW);
  assert.deepEqual(
    snap.meters.map((m) => [m.id, m.label, m.percent, m.group]),
    [
      ['session', 'Current session', 5, 'session'],
      ['weekly_all', 'Weekly · All models', 52, 'weekly'],
      ['weekly_scoped:fable', 'Weekly · Fable', 37, 'weekly'],
    ],
  );
  assert.equal(snap.meters[0]!.resetsAt, '2026-09-24T03:39:59.643446+00:00');
  assert.equal(snap.meters[1]!.isActive, true);
  assert.equal(snap.plan, 'Max 20×');
  assert.equal(snap.fetchedAt, NOW.toISOString());
});

test('parses the weekly split, dropping empty rows and sorting by share', () => {
  const snap = parseUsage(realResponse, null, NOW);
  assert.deepEqual(
    snap.breakdown.map((r) => [r.label, r.percent]),
    [
      ['Claude Code', 74],
      ['Chats', 16],
      ['Cowork', 10],
    ],
  );
});

test('parses extra-usage spend with formatted money', () => {
  const snap = parseUsage(realResponse, null, NOW);
  assert.deepEqual(snap.spend, { enabled: false, percent: 100, severity: 'critical', used: '£40.53', limit: '£40.00' });
});

test('falls back to legacy five_hour / seven_day keys and ignores codenamed ones', () => {
  const { limits: _limits, spend: _spend, ...legacy } = realResponse;
  const snap = parseUsage(legacy, null, NOW);
  assert.deepEqual(
    snap.meters.map((m) => [m.id, m.percent]),
    [
      ['session', 5],
      ['weekly_all', 52],
    ],
  );
  assert.equal(snap.spend?.used, '£40.53', 'legacy extra_usage is used when spend is missing');
});

test('orders session first and weekly_all before scoped limits', () => {
  const snap = parseUsage(
    {
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: { display_name: 'Opus' } } },
        { kind: 'weekly_all', group: 'weekly', percent: 20 },
        { kind: 'session', group: 'session', percent: 30 },
      ],
    },
    null,
    NOW,
  );
  assert.deepEqual(
    snap.meters.map((m) => m.id),
    ['session', 'weekly_all', 'weekly_scoped:opus'],
  );
});

test('skips malformed limit entries and de-duplicates ids', () => {
  const snap = parseUsage(
    {
      limits: [
        null,
        { kind: 'session' },
        { kind: 'session', percent: 'x' },
        { kind: 'session', percent: 40 },
        { kind: 'session', percent: 99 },
        { kind: 'mystery_window', percent: 12 },
      ],
    },
    null,
    NOW,
  );
  assert.deepEqual(
    snap.meters.map((m) => [m.id, m.label, m.percent]),
    [
      ['session', 'Current session', 40],
      ['mystery_window', 'Mystery window', 12],
    ],
  );
});

test('throws UsageParseError for unrecognizable responses', () => {
  assert.throws(() => parseUsage('nope', null, NOW), UsageParseError);
  assert.throws(() => parseUsage({ limits: [], something: 1 }, null, NOW), UsageParseError);
});

test('severityFor escalates by percentage and never lowers the server severity', () => {
  assert.equal(severityFor(10), 'normal');
  assert.equal(severityFor(75), 'warning');
  assert.equal(severityFor(90), 'critical');
  assert.equal(severityFor(10, 'critical'), 'critical');
  assert.equal(severityFor(95, 'normal'), 'critical');
  assert.equal(severityFor(10, 'bogus'), 'normal');
});

test('formatPlan builds a readable plan name', () => {
  assert.equal(formatPlan('max', 'default_claude_max_20x'), 'Max 20×');
  assert.equal(formatPlan('max', 'default_claude_max_5x'), 'Max 5×');
  assert.equal(formatPlan('pro', null), 'Pro');
  assert.equal(formatPlan('team_premium', null), 'Team premium');
  assert.equal(formatPlan(null, 'x'), null);
});
