import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatClock } from '../shared/format';
import type { LimitMeter } from '../shared/types';
import { checkThresholds, notificationText, sanitizeRecords, type NotifyEvent, type NotifyPrefs, type NotifyRecord } from './notifications-core';

const NOW = Date.parse('2026-09-26T10:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL: NotifyPrefs = { thresholds: [75, 90, 100], reset: true };

const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_RESET = iso(NOW + 2 * HOUR);

function session(percent: number, resetsAt: string | null = SESSION_RESET): LimitMeter {
  return { id: 'session', group: 'session', label: 'Current session', percent, severity: 'normal', resetsAt, isActive: false };
}

/** Feeds snapshots one after another (3 min apart) and returns what each one announced. */
function run(steps: Array<LimitMeter[]>, prefs: NotifyPrefs = ALL, start: NotifyRecord[] = []) {
  let records = start;
  const announced: string[][] = [];
  steps.forEach((meters, i) => {
    const result = checkThresholds(meters, records, prefs, NOW + i * 3 * MIN);
    records = result.records;
    announced.push(result.events.map(describe));
  });
  return { announced, records };
}

function describe(event: NotifyEvent): string {
  return event.kind === 'reset' ? `${event.meter.id} reset` : `${event.meter.id} ${event.threshold}`;
}

test('each threshold is announced exactly once per window', () => {
  const { announced } = run([[session(70)], [session(76)], [session(80)], [session(91)], [session(95)], [session(100)], [session(100)]]);
  assert.deepEqual(announced, [[], ['session 75'], [], ['session 90'], [], ['session 100'], []]);
});

test('a jump over several thresholds gives one notification (the highest)', () => {
  const { announced, records } = run([[session(70)], [session(95)], [session(96)]]);
  assert.deepEqual(announced, [[], ['session 90'], []]);
  assert.deepEqual(
    records.map((r) => r.threshold),
    [75, 90],
  );
});

test('the first snapshot above a threshold notifies (fresh start, no history)', () => {
  assert.deepEqual(run([[session(78)]]).announced, [['session 75']]);
});

test('records survive a restart: no repeat for the same window', () => {
  const first = run([[session(78)]]);
  const again = run([[session(79)]], ALL, first.records);
  assert.deepEqual(again.announced, [[]]);
});

test('reset times that jitter by fractions of a second are the same window', () => {
  const jitter = (ms: number) => iso(Date.parse(SESSION_RESET) + ms);
  const { announced } = run([[session(76, jitter(0))], [session(77, jitter(431))], [session(78, jitter(-980))]]);
  assert.deepEqual(announced, [['session 75'], [], []]);
});

test('a new window re-arms the thresholds and can announce the reset', () => {
  const next = iso(NOW + 7 * HOUR);
  const { announced } = run([[session(92)], [session(3, next)], [session(80, next)]]);
  assert.deepEqual(announced, [['session 90'], ['session reset'], ['session 75']]);
});

test('no reset notice when switched off, and none for limits that never reached a threshold', () => {
  const next = iso(NOW + 7 * HOUR);
  assert.deepEqual(run([[session(92)], [session(3, next)]], { thresholds: [75, 90, 100], reset: false }).announced, [['session 90'], []]);
  assert.deepEqual(run([[session(40)], [session(3, next)]]).announced, [[], []]);
});

test('server still reporting the old window just after its reset time: no repeat', () => {
  const resetSoon = iso(NOW + 2 * MIN);
  // The second snapshot is taken after resetSoon has passed but still carries the old window.
  const { announced } = run([[session(100, resetSoon)], [session(100, resetSoon)]]);
  assert.deepEqual(announced, [['session 100'], []]);
});

test('disabled thresholds are recorded silently and not announced later', () => {
  const only90: NotifyPrefs = { thresholds: [90], reset: true };
  const first = run([[session(80)], [session(85)]], only90);
  assert.deepEqual(first.announced, [[], []]);
  // Turning 75 % on later doesn't bring up the old crossing.
  assert.deepEqual(run([[session(86)]], ALL, first.records).announced, [[]]);
});

test('Claude Desktop samples without reset times do not repeat or lose crossings', () => {
  // Claude Code saw 80 %, then Auto falls back to Desktop (no reset time, a slightly older 77 %),
  // then Claude Code is back.
  const { announced } = run([[session(80)], [session(77, null)], [session(81)]]);
  assert.deepEqual(announced, [['session 75'], [], []]);
});

test('without reset times, a drop in usage re-arms the threshold', () => {
  const { announced } = run([[session(80, null)], [session(81, null)], [session(2, null)], [session(76, null)]]);
  assert.deepEqual(announced, [['session 75'], [], ['session reset'], ['session 75']]);
});

test('a record without a reset time ends when a later window starts', () => {
  const start: NotifyRecord[] = [{ id: 'session', threshold: 75, resetsAt: null, at: NOW - 6 * HOUR }];
  // Asleep through the reset: the new window is already above 75 % when first seen.
  assert.deepEqual(run([[session(78)]], ALL, start).announced, [['session 75']]);
});

test('limits are tracked separately; missing limits keep their records', () => {
  const fable = (percent: number): LimitMeter => ({ ...session(percent, iso(NOW + 3 * 24 * HOUR)), id: 'weekly_scoped:fable', group: 'weekly', label: 'Weekly · Fable' });
  const { announced, records } = run([[session(76), fable(91)], [session(77)]]);
  assert.deepEqual(announced, [['session 75', 'weekly_scoped:fable 90'], []]);
  assert.ok(records.some((r) => r.id === 'weekly_scoped:fable' && r.threshold === 90));
});

test('sanitizeRecords drops malformed entries', () => {
  const good = { id: 'session', threshold: 75, resetsAt: null, at: NOW };
  assert.deepEqual(sanitizeRecords(undefined), []);
  assert.deepEqual(sanitizeRecords({ records: 'x' }), []);
  assert.deepEqual(sanitizeRecords({ records: [good, null, { ...good, at: 'x' }, { ...good, resetsAt: 5 }, { id: 1 }] }), [good]);
});

test('notificationText', () => {
  const now = new Date(NOW);
  const meter = session(78);
  assert.deepEqual(notificationText({ kind: 'threshold', meter, threshold: 75 }, now), {
    title: 'Current session: 78% used',
    body: `Resets in 2h (${formatClock(new Date(SESSION_RESET), now)}).`,
  });
  assert.match(notificationText({ kind: 'threshold', meter, threshold: 75 }, now, NOW + 83 * MIN).body, /^At this pace: limit in ~1h 25m\. Resets in 2h/);
  assert.equal(notificationText({ kind: 'threshold', meter: session(100), threshold: 100 }, now).title, 'Current session: limit reached');
  assert.equal(notificationText({ kind: 'threshold', meter: session(100, null), threshold: 100 }, now).body, 'It resets automatically.');
  assert.deepEqual(notificationText({ kind: 'reset', meter: session(3) }, now), { title: 'Current session has reset', body: 'Usage is back to 3%.' });
});
