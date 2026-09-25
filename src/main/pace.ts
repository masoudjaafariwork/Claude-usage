// Usage history and the "at this pace" forecast: a least-squares line through the recent points of
// the current window, projected to 100 %. Built only from snapshots the regular polling already
// fetched — no extra requests. Pure module (Node fs only; unit-tested in pace.test.ts).
import type { LimitMeter, UsageSnapshot } from '../shared/types';
import { readJson, writeJsonAtomic } from './settings';

/** One fetched snapshot, reduced to what the forecast needs. */
export interface HistoryPoint {
  /** When the data was fetched (ms). */
  t: number;
  /** Per meter id: percent used and the window's reset time. */
  m: Record<string, { p: number; r: string | null }>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** History kept in memory and on disk. */
export const HISTORY_KEEP_MS = 24 * HOUR;
const MAX_POINTS = 2000;
/** Reset times closer than this belong to the same window (resets_at jitters by fractions of a second). */
const SAME_WINDOW_MS = HOUR;
export const FORECAST_MIN_POINTS = 3;
export const FORECAST_MIN_SPAN_MS = 15 * MINUTE;
/** "The current pace": the last hour of a 5-hour session, the last day of a weekly limit. */
const LOOKBACK_MS: Record<LimitMeter['group'], number> = { session: HOUR, weekly: 24 * HOUR, other: 24 * HOUR };

/** Appends a snapshot (ignored when it isn't newer than the last point) and drops points older than a day. */
export function addPoint(history: readonly HistoryPoint[], snapshot: UsageSnapshot, now: number): HistoryPoint[] {
  const t = Date.parse(snapshot.fetchedAt);
  const last = history.at(-1);
  if (Number.isNaN(t) || (last && t <= last.t)) return [...history];
  const m = Object.fromEntries(snapshot.meters.map((meter) => [meter.id, { p: meter.percent, r: meter.resetsAt }]));
  return [...history.filter((point) => now - point.t < HISTORY_KEEP_MS), { t, m }].slice(-MAX_POINTS);
}

/** Well-formed points only, oldest first (the file may be old, edited or damaged). */
export function sanitizeHistory(raw: unknown): HistoryPoint[] {
  const list = (raw as { points?: unknown } | undefined)?.points;
  if (!Array.isArray(list)) return [];
  const points = list.flatMap((item): HistoryPoint[] => {
    const point = item as Partial<HistoryPoint> | null;
    if (!point || typeof point.t !== 'number' || !Number.isFinite(point.t) || typeof point.m !== 'object' || point.m === null) return [];
    const m: HistoryPoint['m'] = {};
    for (const [id, value] of Object.entries(point.m)) {
      const v = value as { p?: unknown; r?: unknown } | null;
      if (v && typeof v.p === 'number' && Number.isFinite(v.p) && (v.r === null || typeof v.r === 'string')) m[id] = { p: v.p, r: v.r };
    }
    return [{ t: point.t, m }];
  });
  return points.sort((a, b) => a.t - b.t).slice(-MAX_POINTS);
}

/** Least-squares slope of y over x. */
function slope(points: ReadonlyArray<{ x: number; y: number }>): number {
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * When the limit reaches 100 % at the current pace (ms), or null when that isn't meaningful: no
 * reset time (Claude Desktop), already at 100 %, fewer than 3 points in the current window's recent
 * past, spanning under 15 min, a flat or falling trend, or a projection past the reset.
 */
export function forecastLimitAt(history: readonly HistoryPoint[], meter: LimitMeter): number | null {
  const resetAt = meter.resetsAt ? Date.parse(meter.resetsAt) : NaN;
  const last = history.at(-1);
  if (Number.isNaN(resetAt) || meter.percent >= 100 || !last) return null;
  const since = last.t - LOOKBACK_MS[meter.group];
  const points = history.flatMap((point) => {
    const value = point.m[meter.id];
    if (!value?.r || point.t < since || Math.abs(Date.parse(value.r) - resetAt) >= SAME_WINDOW_MS) return [];
    return [{ x: point.t, y: value.p }];
  });
  const first = points[0];
  const end = points.at(-1);
  if (!first || !end || points.length < FORECAST_MIN_POINTS || end.x - first.x < FORECAST_MIN_SPAN_MS) return null;
  const perMs = slope(points);
  if (!(perMs > 0)) return null;
  const limitAt = end.x + (100 - end.y) / perMs;
  return limitAt < resetAt ? limitAt : null;
}

/** Meter id → ISO time of the projected 100 %, for every limit with a meaningful forecast. */
export function forecasts(history: readonly HistoryPoint[], meters: readonly LimitMeter[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const meter of meters) {
    const limitAt = forecastLimitAt(history, meter);
    if (limitAt !== null) out[meter.id] = new Date(limitAt).toISOString();
  }
  return out;
}

/** The history in memory, persisted to `file` (null = memory only, for mock runs). */
export class UsageHistory {
  private points: HistoryPoint[];
  private readonly file: string | null;

  constructor(file: string | null, initial: HistoryPoint[] = []) {
    this.file = file;
    this.points = file ? sanitizeHistory(readJson(file)) : initial;
  }

  add(snapshot: UsageSnapshot, now = Date.now()): void {
    const before = this.points.at(-1);
    this.points = addPoint(this.points, snapshot, now);
    if (this.file && this.points.at(-1) !== before) {
      try {
        writeJsonAtomic(this.file, { version: 1, points: this.points }, 0);
      } catch (err) {
        console.error('Failed to save usage history:', err);
      }
    }
  }

  forecasts(meters: readonly LimitMeter[]): Record<string, string> {
    return forecasts(this.points, meters);
  }
}
