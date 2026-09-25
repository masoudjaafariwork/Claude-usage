// Decides when to show a usage notification: once per limit, threshold and usage window — plus an
// optional "limit has reset" notice — and writes its text. Pure module (unit-tested in
// notifications-core.test.ts); notifications.ts shows them and persists the records.
//
// A window is recognised by the limit's reset time, but only loosely: resets_at moves by fractions
// of a second between responses, and Claude Desktop's samples have no reset time at all. So a
// crossing is remembered until its window is clearly over — the reset time moved by an hour or more,
// the recorded reset time has passed, or usage fell well below the threshold (usage only drops at a
// reset).
import { formatApprox, formatClock, formatDuration } from '../shared/format';
import type { LimitMeter } from '../shared/types';

export const NOTIFY_THRESHOLDS = [75, 90, 100] as const;

/** A threshold a limit reached within one usage window (notified or not). */
export interface NotifyRecord {
  /** Meter id, e.g. "session", "weekly_scoped:fable". */
  id: string;
  threshold: number;
  /** Reset time of the window it happened in; null when unknown (Claude Desktop, no active session). */
  resetsAt: string | null;
  /** When it was first seen (ms). */
  at: number;
}

export interface NotifyPrefs {
  /** Enabled thresholds (subset of NOTIFY_THRESHOLDS). */
  thresholds: readonly number[];
  /** Also tell when a limit that reached a threshold has reset. */
  reset: boolean;
}

export type NotifyEvent =
  | { kind: 'threshold'; meter: LimitMeter; threshold: number }
  | { kind: 'reset'; meter: LimitMeter };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Reset times closer than this belong to the same window (windows are at least 5 h apart). */
const SAME_WINDOW_MS = HOUR;
/** Usage this far below a threshold means the window has reset (tolerates small source differences). */
const REARM_MARGIN = 5;
/** Longest usage window per group, for records whose reset time is unknown. */
const WINDOW_MS: Record<LimitMeter['group'], number> = { session: 5 * HOUR, weekly: 7 * DAY, other: 7 * DAY };
/** Records are dropped after this, whatever happens. */
const MAX_RECORD_AGE_MS = 8 * DAY;

function isWindowOver(record: NotifyRecord, meter: LimitMeter, now: number): boolean {
  if (meter.percent < record.threshold - REARM_MARGIN || now - record.at >= MAX_RECORD_AGE_MS) return true;
  const recorded = record.resetsAt ? Date.parse(record.resetsAt) : NaN;
  const current = meter.resetsAt ? Date.parse(meter.resetsAt) : NaN;
  if (!Number.isNaN(recorded) && !Number.isNaN(current)) return Math.abs(recorded - current) >= SAME_WINDOW_MS;
  // Current reset time unknown: the recorded window is over once its reset time has passed.
  if (!Number.isNaN(recorded)) return now >= recorded;
  const length = WINDOW_MS[meter.group];
  // Recorded without a reset time: over when it happened before the current window started…
  if (!Number.isNaN(current)) return record.at < current - length;
  // …or, with no reset times at all, when a whole window has passed since.
  return now - record.at >= length;
}

/**
 * Compares a fresh snapshot's limits with what was already seen. Returns the notifications to show
 * (at most one threshold notice per limit — the highest newly reached one — plus reset notices) and
 * the records to keep. Thresholds are recorded even when switched off, so switching one on later
 * doesn't announce an old crossing.
 */
export function checkThresholds(
  meters: readonly LimitMeter[],
  records: readonly NotifyRecord[],
  prefs: NotifyPrefs,
  now: number,
): { events: NotifyEvent[]; records: NotifyRecord[] } {
  const events: NotifyEvent[] = [];
  const ids = new Set(meters.map((m) => m.id));
  // Limits missing from this snapshot (e.g. per-model limits while Claude Desktop is the source) keep theirs.
  const next = records.filter((r) => !ids.has(r.id) && now - r.at < MAX_RECORD_AGE_MS);

  for (const meter of meters) {
    const mine = records.filter((r) => r.id === meter.id);
    const over = mine.filter((r) => isWindowOver(r, meter, now));
    const live = mine
      .filter((r) => !over.includes(r))
      // Learn the reset time of a window first seen without one.
      .map((r) => (r.resetsAt === null && meter.resetsAt !== null ? { ...r, resetsAt: meter.resetsAt } : r));

    if (prefs.reset && over.length > 0 && meter.percent < Math.min(...over.map((r) => r.threshold))) {
      events.push({ kind: 'reset', meter });
    }

    const reached = NOTIFY_THRESHOLDS.filter((t) => meter.percent >= t && !live.some((r) => r.threshold === t));
    live.push(...reached.map((threshold) => ({ id: meter.id, threshold, resetsAt: meter.resetsAt, at: now })));
    const shown = reached.filter((t) => prefs.thresholds.includes(t));
    if (shown.length > 0) events.push({ kind: 'threshold', meter, threshold: Math.max(...shown) });

    next.push(...live);
  }
  return { events, records: next };
}

/** Keeps well-formed records only (the file may be old, edited or damaged). */
export function sanitizeRecords(raw: unknown): NotifyRecord[] {
  const list = (raw as { records?: unknown } | undefined)?.records;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): NotifyRecord[] => {
    const r = item as Partial<NotifyRecord> | null;
    if (!r || typeof r.id !== 'string' || typeof r.threshold !== 'number' || typeof r.at !== 'number') return [];
    if (!Number.isFinite(r.at) || (r.resetsAt !== null && typeof r.resetsAt !== 'string')) return [];
    return [{ id: r.id, threshold: r.threshold, resetsAt: r.resetsAt ?? null, at: r.at }];
  });
}

/** Title and body of a notification. `limitAt` = projected time of 100 % at the current pace, if any. */
export function notificationText(event: NotifyEvent, now: Date, limitAt: number | null = null): { title: string; body: string } {
  const { meter } = event;
  const percent = Math.round(meter.percent);
  if (event.kind === 'reset') {
    return { title: `${meter.label} has reset`, body: `Usage is back to ${percent}%.` };
  }
  const reset = meter.resetsAt ? new Date(meter.resetsAt) : null;
  const resetText =
    reset && reset.getTime() > now.getTime()
      ? `Resets in ${formatDuration(reset.getTime() - now.getTime())} (${formatClock(reset, now)}).`
      : '';
  if (event.threshold >= 100) {
    return { title: `${meter.label}: limit reached`, body: resetText || 'It resets automatically.' };
  }
  const pace = limitAt !== null && limitAt > now.getTime() ? `At this pace: limit in ${formatApprox(limitAt - now.getTime())}.` : '';
  return { title: `${meter.label}: ${percent}% used`, body: [pace, resetText].filter(Boolean).join(' ') || `${percent}% of this limit used.` };
}
