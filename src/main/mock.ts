// Fake data sources for development: `npm run start:mock` or `electron . --mock=<scenario>`.
// Lets you design and screenshot every UI state without touching the real APIs. The scenarios use
// the real source classes with fake I/O, so Auto-mode fallback behaves exactly as in the app.
import type { SourceId, SourceMode, UsageSnapshot } from '../shared/types';
import { CredentialsNotFoundError, type ClaudeCredentials } from './credentials';
import { DesktopSource, desktopSnapshot } from './desktop-source';
import { UsageHttpError } from './usage-errors';
import { parseUsage } from './usage-parse';
import { ClaudeCodeSource, type UsageSource } from './usage-source';

export const MOCK_SCENARIOS = [
  'normal',
  'warning',
  'critical',
  'expired',
  'no-credentials',
  'rate-limited',
  'offline',
  'loading',
  'via-desktop',
  'desktop-unavailable',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MOCK_ORG = '00000000-0000-4000-8000-000000000001';

interface Levels {
  session: number;
  weekly: number;
  fable: number;
  spend?: number;
}

const LEVELS: Record<'normal' | 'warning' | 'critical', Levels> = {
  normal: { session: 23, weekly: 52, fable: 37 },
  warning: { session: 78, weekly: 64, fable: 81 },
  critical: { session: 96, weekly: 91, fable: 88, spend: 31 },
};

/** A raw response shaped like the real /api/oauth/usage payload. */
export function mockRawUsage(now: number, levels: Levels): unknown {
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const weeklyReset = iso(4 * DAY + 17 * HOUR + 12 * MIN);
  return {
    limits: [
      { kind: 'session', group: 'session', percent: levels.session, severity: 'normal', resets_at: iso(2 * HOUR + 17 * MIN), scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: levels.weekly, severity: 'normal', resets_at: weeklyReset, scope: null, is_active: true },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: levels.fable,
        severity: 'normal',
        resets_at: weeklyReset,
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
    seven_day_breakdown: {
      rows: [
        { key: 'claude_code', display_name: 'Claude Code', percent: 74 },
        { key: 'chat', display_name: 'Chats', percent: 16 },
        { key: 'cowork', display_name: 'Cowork', percent: 10 },
        { key: 'other', display_name: 'Other', percent: 0 },
      ],
    },
    spend: {
      enabled: levels.spend !== undefined,
      percent: levels.spend ?? 0,
      severity: 'normal',
      used: { amount_minor: Math.round(4000 * ((levels.spend ?? 0) / 100)), currency: 'GBP', exponent: 2 },
      limit: { amount_minor: 4000, currency: 'GBP', exponent: 2 },
    },
  };
}

export function isMockScenario(value: string): value is MockScenario {
  return (MOCK_SCENARIOS as readonly string[]).includes(value);
}

export interface MockSetup {
  sources: Record<SourceId, UsageSource>;
  initialSnapshot: UsageSnapshot | null;
  /** Source mode the scenario needs. */
  mode: SourceMode;
}

const delay = <T>(value: T, ms = 400) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

export function createMockSource(scenario: MockScenario): MockSetup {
  const now = Date.now();
  const credentials: ClaudeCredentials = {
    accessToken: 'mock-token',
    expiresAt: now + 8 * HOUR,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    source: 'file',
  };
  const expired = { ...credentials, expiresAt: now - 2 * HOUR };
  const staleSnapshot = (ageMs: number) => parseUsage(mockRawUsage(now - ageMs, LEVELS.normal), 'Max 20×', new Date(now - ageMs));
  const desktopSample = (ageMs: number) => ({ t: now - ageMs, org: MOCK_ORG, u: { fh: LEVELS.normal.session, sd: LEVELS.normal.weekly } });

  const claudeCode = (read: () => Promise<ClaudeCredentials>, fetchUsage: () => Promise<unknown> = () => delay(mockRawUsage(Date.now(), LEVELS.normal))) =>
    new ClaudeCodeSource({ readCredentials: read, fetchUsage, now: Date.now });
  const desktop = (sampleAgeMs: number | null) =>
    new DesktopSource({
      readHistory: async () => (sampleAgeMs === null ? null : JSON.stringify({ version: 2, samples: [desktopSample(sampleAgeMs)] })),
      preferredOrg: async () => null,
      now: Date.now,
    });
  const noCredentials = () => Promise.reject(new CredentialsNotFoundError('mock'));

  const setup = (
    sources: Partial<Record<SourceId, UsageSource>>,
    options: { initialSnapshot?: UsageSnapshot | null; mode?: SourceMode } = {},
  ): MockSetup => ({
    sources: {
      'claude-code': sources['claude-code'] ?? claudeCode(noCredentials),
      'claude-desktop': sources['claude-desktop'] ?? desktop(null),
    },
    initialSnapshot: options.initialSnapshot ?? null,
    mode: options.mode ?? 'auto',
  });

  switch (scenario) {
    case 'normal':
    case 'warning':
    case 'critical': {
      const levels = LEVELS[scenario];
      return setup({ 'claude-code': claudeCode(() => delay(credentials, 0), () => delay(mockRawUsage(Date.now(), levels))) });
    }
    case 'expired':
      return setup({ 'claude-code': claudeCode(() => delay(expired, 0)) }, { initialSnapshot: staleSnapshot(2 * HOUR + 14 * MIN) });
    case 'no-credentials':
      return setup({});
    case 'rate-limited':
      return setup(
        { 'claude-code': claudeCode(() => delay(credentials, 0), () => Promise.reject(new UsageHttpError(429, 300))) },
        { initialSnapshot: staleSnapshot(9 * MIN) },
      );
    case 'offline':
      return setup(
        { 'claude-code': claudeCode(() => delay(credentials, 0), () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))) },
        { initialSnapshot: staleSnapshot(26 * MIN) },
      );
    case 'loading':
      return setup({ 'claude-code': claudeCode(() => delay(credentials, 0), () => new Promise<never>(() => {})) });
    case 'via-desktop':
      // Claude Code's token is expired and "renews" after a minute: Auto shows Claude Desktop's
      // sample, then switches back to Claude Code on its own.
      return setup({
        'claude-code': claudeCode(() => delay(Date.now() - now < MIN ? expired : credentials, 0)),
        'claude-desktop': desktop(6 * MIN),
      });
    case 'desktop-unavailable':
      return setup({ 'claude-desktop': desktop(3 * HOUR) }, { mode: 'claude-desktop', initialSnapshot: desktopSnapshot(desktopSample(3 * HOUR)) });
  }
}
