import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LimitMeter, UsageSnapshot } from '../shared/types';
import { HISTORY_KEEP_MS, addPoint, forecastLimitAt, forecasts, sanitizeHistory, type HistoryPoint } from './pace';

const NOW = Date.parse('2026-09-26T10:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_RESET = iso(NOW + 2 * HOUR);
const WEEKLY_RESET = iso(NOW + 3 * 24 * HOUR);

function meter(id: string, percent: number, resetsAt: string | null): LimitMeter {
  const group = id === 'session' ? 'session' : 'weekly';
  return { id, group, label: id, percent, severity: 'normal', resetsAt, isActive: false };
}

/** Points every `stepMin` minutes ending at NOW, percent rising linearly from `from` to `to`. */
function rising(id: string, from: number, to: number, spanMin: number, resetsAt: string | null, stepMin = 3): HistoryPoint[] {
  const steps = Math.round(spanMin / stepMin);
  return Array.from({ length: steps + 1 }, (_, i) => ({
    t: NOW - (steps - i) * stepMin * MIN,
    m: { [id]: { p: from + ((to - from) * i) / steps, r: resetsAt } },
  }));
}

const minutesUntil = (at: number | null) => (at === null ? null : Math.round((at - NOW) / MIN));

test('a steady rise projects to 100 % before the reset', () => {
  // 40 → 62 % in 45 min ≈ 0.49 %/min; 38 % left ≈ 78 min.
  const history = rising('session', 40, 62, 45, SESSION_RESET);
  assert.equal(minutesUntil(forecastLimitAt(history, meter('session', 62, SESSION_RESET))), 78);
});

test('weekly limits use the last day of points', () => {
  // 50 → 64 % over 24 h; 36 % left ≈ 61.7 h, before the reset in 72 h.
  const history = rising('weekly_all', 50, 64, 24 * 60, WEEKLY_RESET, 30);
  assert.equal(minutesUntil(forecastLimitAt(history, meter('weekly_all', 64, WEEKLY_RESET))), Math.round((36 / 14) * 24 * 60));
});

test('no forecast from sparse data', () => {
  const m = meter('session', 62, SESSION_RESET);
  assert.equal(forecastLimitAt([], m), null);
  // Two points only.
  assert.equal(forecastLimitAt(rising('session', 40, 62, 30, SESSION_RESET, 30), m), null);
  // Enough points, but spanning only 12 minutes.
  assert.equal(forecastLimitAt(rising('session', 40, 62, 12, SESSION_RESET), m), null);
});

test('no forecast for flat or falling usage, or when the reset comes first', () => {
  assert.equal(forecastLimitAt(rising('session', 50, 50, 45, SESSION_RESET), meter('session', 50, SESSION_RESET)), null);
  assert.equal(forecastLimitAt(rising('session', 60, 55, 45, SESSION_RESET), meter('session', 55, SESSION_RESET)), null);
  // 10 → 20 % in 45 min: 100 % in 6 h, after the reset in 2 h.
  assert.equal(forecastLimitAt(rising('session', 10, 20, 45, SESSION_RESET), meter('session', 20, SESSION_RESET)), null);
});

test('no forecast without a reset time (Claude Desktop) or at the limit', () => {
  assert.equal(forecastLimitAt(rising('session', 40, 62, 45, null), meter('session', 62, null)), null);
  assert.equal(forecastLimitAt(rising('session', 80, 100, 45, SESSION_RESET), meter('session', 100, SESSION_RESET)), null);
});

test('only points of the current window count', () => {
  const oldReset = iso(NOW - 10 * MIN);
  // Heavy use in the previous window, then two points in the new one.
  const history = [...rising('session', 60, 99, 40, oldReset).map((p) => ({ ...p, t: p.t - 15 * MIN })), ...rising('session', 1, 3, 6, SESSION_RESET)];
  assert.equal(forecastLimitAt(history, meter('session', 3, SESSION_RESET)), null);
});

test('reset times that jitter within the window still match', () => {
  const history = rising('session', 40, 62, 45, SESSION_RESET).map((p, i) => ({
    ...p,
    m: { session: { p: p.m.session!.p, r: iso(Date.parse(SESSION_RESET) + (i % 2 ? 437 : -212)) } },
  }));
  assert.equal(minutesUntil(forecastLimitAt(history, meter('session', 62, SESSION_RESET))), 78);
});

test('the session forecast follows the last hour, not older bursts', () => {
  // Fast rise 2–3 h ago, flat for the last hour.
  const burst = rising('session', 10, 60, 60, SESSION_RESET).map((p) => ({ ...p, t: p.t - 2 * HOUR }));
  const flat = rising('session', 60, 60, 60, SESSION_RESET);
  assert.equal(forecastLimitAt([...burst, ...flat], meter('session', 60, SESSION_RESET)), null);
});

test('forecasts() maps meter ids to ISO times', () => {
  const history = rising('session', 40, 62, 45, SESSION_RESET);
  const result = forecasts(history, [meter('session', 62, SESSION_RESET), meter('weekly_all', 64, WEEKLY_RESET)]);
  assert.deepEqual(Object.keys(result), ['session']);
  assert.equal(minutesUntil(Date.parse(result.session!)), 78);
});

test('addPoint appends newer snapshots only and keeps one day', () => {
  const snapshot = (at: number, percent: number): UsageSnapshot => ({
    fetchedAt: iso(at),
    plan: null,
    meters: [meter('session', percent, SESSION_RESET)],
    breakdown: [],
    spend: null,
    source: 'claude-code',
  });
  let history = addPoint([], snapshot(NOW - HISTORY_KEEP_MS, 1), NOW - HISTORY_KEEP_MS);
  history = addPoint(history, snapshot(NOW - HOUR, 20), NOW - HOUR);
  history = addPoint(history, snapshot(NOW - HOUR, 20), NOW - HOUR); // same fetch again
  history = addPoint(history, snapshot(NOW - 2 * HOUR, 15), NOW - HOUR); // older sample
  assert.equal(history.length, 2);
  history = addPoint(history, snapshot(NOW, 30), NOW);
  assert.deepEqual(
    history.map((p) => p.m.session?.p),
    [20, 30],
  );
  assert.deepEqual(history.at(-1), { t: NOW, m: { session: { p: 30, r: SESSION_RESET } } });
});

test('sanitizeHistory keeps well-formed points, oldest first', () => {
  assert.deepEqual(sanitizeHistory(undefined), []);
  assert.deepEqual(sanitizeHistory({ points: {} }), []);
  const raw = {
    points: [
      { t: NOW, m: { session: { p: 30, r: SESSION_RESET }, bad: { p: 'x', r: null }, alsoBad: { p: 1, r: 5 } } },
      { t: 'x', m: {} },
      null,
      { t: NOW - MIN, m: { session: { p: 29, r: null } } },
    ],
  };
  assert.deepEqual(sanitizeHistory(raw), [
    { t: NOW - MIN, m: { session: { p: 29, r: null } } },
    { t: NOW, m: { session: { p: 30, r: SESSION_RESET } } },
  ]);
});
