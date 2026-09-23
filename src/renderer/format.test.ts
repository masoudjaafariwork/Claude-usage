import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgo, formatClock, formatDuration } from './format';

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
