import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LimitMeter } from '../shared/types';
import { compactMeters, formatAgo, formatClock, formatDuration } from './format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatDuration', () => {
  assert.equal(formatDuration(10_000), '<1m');
  assert.equal(formatDuration(42 * MIN), '42m');
  assert.equal(formatDuration(3 * HOUR), '3h');
  assert.equal(formatDuration(3 * HOUR + 12 * MIN), '3h 12m');
  assert.equal(formatDuration(2 * DAY), '2d');
  assert.equal(formatDuration(4 * DAY + 17 * HOUR + 20 * MIN), '4d 17h');
});

test('formatClock picks today / tomorrow / weekday / date', () => {
  const now = new Date(2026, 8, 23, 10, 0); // Wed 23 Sep 2026, local time
  assert.equal(formatClock(new Date(2026, 8, 23, 14, 32), now), '14:32');
  assert.equal(formatClock(new Date(2026, 8, 24, 9, 5), now), 'tomorrow 09:05');
  assert.equal(formatClock(new Date(2026, 8, 28, 19, 29), now), 'Mon 19:29');
  assert.equal(formatClock(new Date(2026, 9, 3, 19, 29), now), '3 Oct 19:29');
});

test('formatAgo', () => {
  const now = new Date(2026, 8, 23, 12, 0);
  const ago = (ms: number) => formatAgo(new Date(now.getTime() - ms), now);
  assert.equal(ago(10_000), 'just now');
  assert.equal(ago(60_000), '1 min ago');
  assert.equal(ago(25 * MIN), '25 min ago');
  assert.equal(ago(2 * HOUR + 10 * MIN), '2h ago');
  assert.equal(ago(3 * DAY), '3d ago');
});

test('compactMeters shows the session and every weekly limit that is not hidden', () => {
  const meter = (id: string, group: LimitMeter['group'], label: string, percent: number): LimitMeter => ({
    id,
    group,
    label,
    percent,
    severity: 'normal',
    resetsAt: null,
    isActive: false,
  });
  const meters = [
    meter('session', 'session', 'Current session', 11),
    meter('weekly_all', 'weekly', 'Weekly · All models', 83),
    meter('weekly_scoped:fable', 'weekly', 'Weekly · Fable', 37),
  ];
  const labels = (hidden: string[]) => compactMeters(meters, hidden).map((item) => `${item.label} ${item.meter.percent}`);
  // A per-model limit lower than the all-models one still shows (it used to be hidden).
  assert.deepEqual(labels([]), ['Session 11', 'Week 83', 'Fable 37']);
  assert.deepEqual(labels(['weekly_scoped:fable']), ['Session 11', 'Week 83']);
  assert.deepEqual(labels(['weekly_all']), ['Session 11', 'Fable 37']);
  // The session ring can't be hidden.
  assert.deepEqual(labels(['session', 'weekly_all', 'weekly_scoped:fable']), ['Session 11']);
});
