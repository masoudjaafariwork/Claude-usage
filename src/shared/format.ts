// Pure time/text formatting helpers (unit-tested in format.test.ts). Used by the renderer and by the
// main process (notification text), so no DOM and no Node APIs here.
import type { LimitMeter } from './types';

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

/** A projected duration, rounded to 5 minutes: "~5m", "~1h 20m", "~2d 5h". */
export function formatApprox(ms: number): string {
  const step = 5 * MINUTE;
  return `~${formatDuration(Math.max(step, Math.round(ms / step) * step))}`;
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

/**
 * Shortens an e-mail to at most `max` characters by trimming the part before the @, so the domain
 * stays readable: "ada.lovelace@analytical-engines.example" → "ada.lo…@analytical-engines.example" (34).
 */
export function shortenEmail(email: string, max: number): string {
  const chars = Array.from(email);
  if (chars.length <= max) return email;
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? Array.from(email.slice(at)) : [];
  const keep = max - domain.length - 1;
  if (keep >= 3) return `${chars.slice(0, keep).join('')}…${domain.join('')}`;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** Avatar letters, as on claude.ai: "Ada Lovelace" → "AL", "ada@example.com" → "A", nothing → "". */
export function initials(name: string | null, email: string | null): string {
  const first = (word: string | undefined) => (word ? (Array.from(word)[0] ?? '') : '');
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 0 ? first(words[0]) + (words.length > 1 ? first(words.at(-1)) : '') : first(email?.trim());
  return letters.toLocaleUpperCase();
}
