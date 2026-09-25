// Pure time/text formatting helpers for the overlay (unit-tested in format.test.ts).
import type { LimitMeter } from '../shared/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact duration: "<1m", "42m", "3h 12m", "2d 5h". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return '<1m';
  const totalMinutes = Math.round(ms / MINUTE);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local wall-clock time of a future moment: "14:32", "tomorrow 09:00", "Mon 19:29", "3 Oct 19:29". */
export function formatClock(target: Date, now: Date): string {
  const time = target.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(target, now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(target, tomorrow)) return `tomorrow ${time}`;
  if (target.getTime() - now.getTime() < 6 * DAY) {
    return `${target.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  }
  return `${target.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** Relative past time: "just now", "1 min ago", "25 min ago", "2h ago", "3d ago". */
export function formatAgo(past: Date, now: Date): string {
  const seconds = (now.getTime() - past.getTime()) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1 min ago';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Rings of the compact pill with their short labels: the session always, then each weekly limit not in `hidden`. */
export function compactMeters(meters: readonly LimitMeter[], hidden: readonly string[]): Array<{ meter: LimitMeter; label: string }> {
  const session = meters.find((m) => m.group === 'session');
  const weekly = meters.filter((m) => m.group === 'weekly' && !hidden.includes(m.id));
  return [
    ...(session ? [{ meter: session, label: 'Session' }] : []),
    ...weekly.map((meter) => ({ meter, label: meter.id === 'weekly_all' ? 'Week' : meter.label.replace(/^Weekly · /, '') })),
  ];
}
