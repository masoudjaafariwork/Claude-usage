// Turns the raw JSON from the (unofficial) usage endpoint into a UsageSnapshot.
// The endpoint is undocumented and changes over time, so parsing is deliberately tolerant:
// prefer the modern `limits[]` array, fall back to the legacy `five_hour` / `seven_day*` keys,
// and never trust a field's type without checking it. Pure module — no Electron imports.
import type { BreakdownRow, LimitMeter, Severity, SpendInfo, UsageSnapshot } from '../shared/types';

type Json = Record<string, unknown>;

export class UsageParseError extends Error {
  override name = 'UsageParseError';
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

const SEVERITY_RANK: Record<Severity, number> = { normal: 0, warning: 1, critical: 2 };

/** Severity derived from the percentage, escalated (never lowered) by what the server reports. */
export function severityFor(percent: number, reported?: unknown): Severity {
  const derived: Severity = percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal';
  if (reported === 'normal' || reported === 'warning' || reported === 'critical') {
    return SEVERITY_RANK[reported] > SEVERITY_RANK[derived] ? reported : derived;
  }
  return derived;
}

function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function scopeName(scope: unknown): string | null {
  if (!isObject(scope)) return null;
  const parts: string[] = [];
  for (const key of ['model', 'surface']) {
    const value = scope[key];
    const name = isObject(value) ? (str(value.display_name) ?? str(value.id)) : str(value);
    if (name) parts.push(name);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function meterFromLimit(entry: unknown): LimitMeter | null {
  if (!isObject(entry)) return null;
  const kind = str(entry.kind);
  const percent = num(entry.percent);
  if (!kind || percent === null) return null;

  const rawGroup = str(entry.group);
  const group: LimitMeter['group'] =
    rawGroup === 'session' || rawGroup === 'weekly'
      ? rawGroup
      : kind === 'session'
        ? 'session'
        : kind.startsWith('weekly')
          ? 'weekly'
          : 'other';

  const scope = scopeName(entry.scope);
  let label: string;
  if (kind === 'session') label = 'Current session';
  else if (kind === 'weekly_all') label = 'Weekly · All models';
  else if (scope) label = group === 'weekly' ? `Weekly · ${scope}` : scope;
  else label = humanize(kind);

  return {
    id: scope ? `${kind}:${scope.toLowerCase()}` : kind,
    group,
    label,
    percent,
    severity: severityFor(percent, entry.severity),
    resetsAt: str(entry.resets_at),
    isActive: entry.is_active === true,
  };
}

/** Legacy top-level windows. Unknown (codenamed) keys are ignored on purpose. */
const LEGACY_WINDOWS: ReadonlyArray<{ key: string; id: string; group: LimitMeter['group']; label: string }> = [
  { key: 'five_hour', id: 'session', group: 'session', label: 'Current session' },
  { key: 'seven_day', id: 'weekly_all', group: 'weekly', label: 'Weekly · All models' },
  { key: 'seven_day_opus', id: 'weekly_scoped:opus', group: 'weekly', label: 'Weekly · Opus' },
  { key: 'seven_day_sonnet', id: 'weekly_scoped:sonnet', group: 'weekly', label: 'Weekly · Sonnet' },
];

function legacyMeters(raw: Json): LimitMeter[] {
  const meters: LimitMeter[] = [];
  for (const w of LEGACY_WINDOWS) {
    const entry = raw[w.key];
    if (!isObject(entry)) continue;
    const percent = num(entry.utilization);
    if (percent === null) continue;
    meters.push({
      id: w.id,
      group: w.group,
      label: w.label,
      percent,
      severity: severityFor(percent),
      resetsAt: str(entry.resets_at),
      isActive: false,
    });
  }
  return meters;
}

const GROUP_ORDER: Record<LimitMeter['group'], number> = { session: 0, weekly: 1, other: 2 };

function sortMeters(meters: LimitMeter[]): LimitMeter[] {
  // Session first, then "Weekly · All models", then everything else in server order.
  return meters
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const g = GROUP_ORDER[a.m.group] - GROUP_ORDER[b.m.group];
      if (g !== 0) return g;
      const allA = a.m.id === 'weekly_all' ? 0 : 1;
      const allB = b.m.id === 'weekly_all' ? 0 : 1;
      return allA - allB || a.i - b.i;
    })
    .map(({ m }) => m);
}

function parseBreakdown(raw: Json): BreakdownRow[] {
  const breakdown = raw.seven_day_breakdown;
  if (!isObject(breakdown) || !Array.isArray(breakdown.rows)) return [];
  const rows: BreakdownRow[] = [];
  for (const row of breakdown.rows) {
    if (!isObject(row)) continue;
    const key = str(row.key);
    const percent = num(row.percent);
    if (!key || percent === null || percent <= 0) continue;
    rows.push({ key, label: str(row.display_name) ?? humanize(key), percent });
  }
  return rows.sort((a, b) => b.percent - a.percent);
}

function formatMoney(amount: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    } catch {
      // Unknown currency code — fall through to a plain number.
    }
  }
  return amount.toFixed(2);
}

function money(value: unknown): string | null {
  if (!isObject(value)) return null;
  const minor = num(value.amount_minor);
  if (minor === null) return null;
  const exponent = num(value.exponent) ?? 2;
  return formatMoney(minor / 10 ** exponent, str(value.currency));
}

function parseSpend(raw: Json): SpendInfo | null {
  const spend = raw.spend;
  if (isObject(spend)) {
    const percent = num(spend.percent) ?? 0;
    const cap = isObject(spend.cap) ? spend.cap.money : undefined;
    return {
      enabled: spend.enabled === true,
      percent,
      severity: severityFor(percent, spend.severity),
      used: money(spend.used),
      limit: money(spend.limit) ?? money(cap),
    };
  }
  const extra = raw.extra_usage;
  if (isObject(extra)) {
    const percent = num(extra.utilization) ?? 0;
    const decimals = num(extra.decimal_places) ?? 2;
    const currency = str(extra.currency);
    const used = num(extra.used_credits);
    const limit = num(extra.monthly_limit);
    return {
      enabled: extra.is_enabled === true,
      percent,
      severity: severityFor(percent),
      used: used === null ? null : formatMoney(used / 10 ** decimals, currency),
      limit: limit === null ? null : formatMoney(limit / 10 ** decimals, currency),
    };
  }
  return null;
}

/** Human-readable plan name from Claude Code's credential metadata, e.g. "Max 20×". */
export function formatPlan(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  const type = subscriptionType?.trim().toLowerCase();
  if (!type) return null;
  const names: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  const base = names[type] ?? humanize(type);
  const multiplier = /(\d+)x\b/i.exec(rateLimitTier ?? '')?.[1];
  return multiplier && type === 'max' ? `${base} ${multiplier}×` : base;
}

export function parseUsage(raw: unknown, plan: string | null, fetchedAt: Date): UsageSnapshot {
  if (!isObject(raw)) throw new UsageParseError('Usage response is not a JSON object');

  let meters: LimitMeter[] = [];
  if (Array.isArray(raw.limits)) {
    const seen = new Set<string>();
    for (const entry of raw.limits) {
      const meter = meterFromLimit(entry);
      if (meter && !seen.has(meter.id)) {
        seen.add(meter.id);
        meters.push(meter);
      }
    }
  }
  if (meters.length === 0) meters = legacyMeters(raw);
  if (meters.length === 0) throw new UsageParseError('Usage response contains no recognizable limits');

  return {
    fetchedAt: fetchedAt.toISOString(),
    plan,
    meters: sortMeters(meters),
    breakdown: parseBreakdown(raw),
    spend: parseSpend(raw),
  };
}
