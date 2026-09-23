// Fake data sources for development: `npm run start:mock` or `electron . --mock=<scenario>`.
// Lets you design and screenshot every UI state without touching the real API.
import type { UsageSnapshot } from '../shared/types';
import { CredentialsNotFoundError, type ClaudeCredentials } from './credentials';
import { UsageHttpError } from './usage-errors';
import { parseUsage } from './usage-parse';
import type { UsageServiceDeps } from './usage-service';

export const MOCK_SCENARIOS = [
  'normal',
  'warning',
  'critical',
  'expired',
  'no-credentials',
  'rate-limited',
  'offline',
  'loading',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

export function createMockSource(
  scenario: MockScenario,
  intervalSec: () => number,
): { deps: UsageServiceDeps; initialSnapshot: UsageSnapshot | null } {
  const now = Date.now();
  const credentials: ClaudeCredentials = {
    accessToken: 'mock-token',
    expiresAt: now + 8 * HOUR,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    source: 'file',
  };
  const staleSnapshot = (ageMs: number) =>
    parseUsage(mockRawUsage(now - ageMs, LEVELS.normal), 'Max 20×', new Date(now - ageMs));
  const delay = <T>(value: T, ms = 400) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  const base = { intervalSec };
  switch (scenario) {
    case 'normal':
    case 'warning':
    case 'critical': {
      const levels = LEVELS[scenario];
      return {
        deps: { ...base, readCredentials: () => delay(credentials, 0), fetchUsage: () => delay(mockRawUsage(Date.now(), levels)) },
        initialSnapshot: null,
      };
    }
    case 'expired':
      return {
        deps: {
          ...base,
          readCredentials: () => delay({ ...credentials, expiresAt: now - 2 * HOUR }, 0),
          fetchUsage: () => Promise.reject(new Error('should not be called')),
        },
        initialSnapshot: staleSnapshot(2 * HOUR + 14 * MIN),
      };
    case 'no-credentials':
      return {
        deps: {
          ...base,
          readCredentials: () => Promise.reject(new CredentialsNotFoundError('mock')),
          fetchUsage: () => Promise.reject(new Error('should not be called')),
        },
        initialSnapshot: null,
      };
    case 'rate-limited':
      return {
        deps: { ...base, readCredentials: () => delay(credentials, 0), fetchUsage: () => Promise.reject(new UsageHttpError(429, 300)) },
        initialSnapshot: staleSnapshot(9 * MIN),
      };
    case 'offline':
      return {
        deps: {
          ...base,
          readCredentials: () => delay(credentials, 0),
          fetchUsage: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
        },
        initialSnapshot: staleSnapshot(26 * MIN),
      };
    case 'loading':
      return {
        deps: { ...base, readCredentials: () => delay(credentials, 0), fetchUsage: () => new Promise<never>(() => {}) },
        initialSnapshot: null,
      };
  }
}
