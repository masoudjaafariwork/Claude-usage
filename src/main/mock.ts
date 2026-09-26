// Fake data sources for development: `npm run start:mock` or `electron . --mock=<scenario>`.
// Lets you design and screenshot every UI state without touching the real APIs. The scenarios use
// the real source classes with fake I/O, so Auto-mode fallback behaves exactly as in the app.
import type { SourceId, SourceMode, UsageSnapshot } from '../shared/types';
import { CredentialsNotFoundError, accountInfo, type ClaudeCodeAccount, type ClaudeCredentials } from './credentials';
import { DesktopSource, desktopSnapshot } from './desktop-source';
import type { HistoryPoint } from './pace';
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
  'forecast',
  'locked',
  'other-account',
  'update-ready',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MOCK_ORG = '00000000-0000-4000-8000-000000000001';
/** The account in Claude Code's `.claude.json` (personal org: its name isn't shown). */
const MOCK_ACCOUNT: ClaudeCodeAccount = { email: 'ada@example.com', name: 'Ada Lovelace', orgName: "ada@example.com's Organization", orgUuid: MOCK_ORG };
/** A long e-mail in a team org, to check the layout (used by the `critical` scenario). */
const MOCK_TEAM_ACCOUNT: ClaudeCodeAccount = {
  email: 'ada.lovelace@analytical-engines.example',
  name: 'Ada Lovelace',
  orgName: 'Analytical Engines Ltd',
  orgUuid: '00000000-0000-4000-8000-000000000002',
};
/** A second account in its own config folder (Phase 6, `other-account` scenario). */
const MOCK_FOLDER = { dir: 'D:\\Work\\claude-config', account: { ...MOCK_TEAM_ACCOUNT, email: 'ada@analytical-engines.example' } };

interface Levels {
  session: number;
  weekly: number;
  fable: number;
  spend?: number;
}

const LEVELS: Record<'normal' | 'warning' | 'critical' | 'forecast', Levels> = {
  normal: { session: 23, weekly: 52, fable: 37 },
  warning: { session: 78, weekly: 64, fable: 81 },
  critical: { session: 96, weekly: 91, fable: 88, spend: 31 },
  forecast: { session: 62, weekly: 64, fable: 45 },
};

const SESSION_RESET_IN = 2 * HOUR + 17 * MIN;
const WEEKLY_RESET_IN = 4 * DAY + 17 * HOUR + 12 * MIN;

/** A raw response shaped like the real /api/oauth/usage payload. */
export function mockRawUsage(now: number, levels: Levels): unknown {
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const weeklyReset = iso(WEEKLY_RESET_IN);
  return {
    limits: [
      { kind: 'session', group: 'session', percent: levels.session, severity: 'normal', resets_at: iso(SESSION_RESET_IN), scope: null, is_active: false },
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
  /** Start in lock (click-through) mode. */
  locked: boolean;
  /** Usage history to start with (the pace forecast needs earlier points). */
  history: HistoryPoint[];
  /** An added Claude Code account folder to show instead of the default account. */
  folder: { dir: string; account: ClaudeCodeAccount } | null;
  /** Pretend a downloaded update waits for a restart (the coral dots, D56). */
  updateReady: boolean;
}

/**
 * A day of polls every 5 min leading up to `now`, as if usage had grown steadily: the session by
 * 0.5 %/min over its last 100 min, the weekly limit by 14 % a day, Fable flat (no forecast).
 */
function forecastHistory(now: number): HistoryPoint[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const levels = LEVELS.forecast;
  const points: HistoryPoint[] = [];
  for (let ago = 24 * HOUR; ago > 0; ago -= 5 * MIN) {
    const minutes = ago / MIN;
    const m: HistoryPoint['m'] = {
      weekly_all: { p: levels.weekly - (14 * minutes) / (24 * 60), r: iso(now + WEEKLY_RESET_IN) },
      'weekly_scoped:fable': { p: levels.fable, r: iso(now + WEEKLY_RESET_IN) },
    };
    if (minutes <= 100) m.session = { p: levels.session - 0.5 * minutes, r: iso(now + SESSION_RESET_IN) };
    points.push({ t: now - ago, m });
  }
  return points;
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
  const staleSnapshot = (ageMs: number): UsageSnapshot => ({
    ...parseUsage(mockRawUsage(now - ageMs, LEVELS.normal), 'Max 20×', new Date(now - ageMs)),
    account: accountInfo(MOCK_ACCOUNT),
  });
  const desktopSample = (ageMs: number) => ({ t: now - ageMs, org: MOCK_ORG, u: { fh: LEVELS.normal.session, sd: LEVELS.normal.weekly } });

  const claudeCode = (
    read: () => Promise<ClaudeCredentials>,
    fetchUsage: () => Promise<unknown> = () => delay(mockRawUsage(Date.now(), LEVELS.normal)),
    account: ClaudeCodeAccount = MOCK_ACCOUNT,
  ) => new ClaudeCodeSource({ readCredentials: read, fetchUsage, readAccount: async () => account, now: Date.now });
  const desktop = (sampleAgeMs: number | null, account = MOCK_ACCOUNT, orgMatch: 'if-known' | 'strict' = 'if-known') =>
    new DesktopSource({
      readHistory: async () => (sampleAgeMs === null ? null : JSON.stringify({ version: 2, samples: [desktopSample(sampleAgeMs)] })),
      claudeCodeAccount: async () => account,
      orgMatch: () => orgMatch,
      now: Date.now,
    });
  const noCredentials = () => Promise.reject(new CredentialsNotFoundError('mock'));

  const setup = (
    sources: Partial<Record<SourceId, UsageSource>>,
    options: {
      initialSnapshot?: UsageSnapshot | null;
      mode?: SourceMode;
      locked?: boolean;
      history?: HistoryPoint[];
      folder?: MockSetup['folder'];
      updateReady?: boolean;
    } = {},
  ): MockSetup => ({
    sources: {
      'claude-code': sources['claude-code'] ?? claudeCode(noCredentials),
      'claude-desktop': sources['claude-desktop'] ?? desktop(null),
    },
    initialSnapshot: options.initialSnapshot ?? null,
    mode: options.mode ?? 'auto',
    locked: options.locked ?? false,
    history: options.history ?? [],
    folder: options.folder ?? null,
    updateReady: options.updateReady ?? false,
  });
  const withLevels = (levels: Levels, account = MOCK_ACCOUNT) =>
    claudeCode(() => delay(credentials, 0), () => delay(mockRawUsage(Date.now(), levels)), account);

  switch (scenario) {
    case 'normal':
    case 'warning':
      return setup({ 'claude-code': withLevels(LEVELS[scenario]) });
    case 'critical':
      return setup({ 'claude-code': withLevels(LEVELS.critical, MOCK_TEAM_ACCOUNT) });
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
      // The cached sample carries no account (as when Desktop's org isn't Claude Code's).
      return setup({ 'claude-desktop': desktop(3 * HOUR) }, { mode: 'claude-desktop', initialSnapshot: desktopSnapshot(desktopSample(3 * HOUR)) });
    case 'forecast':
      return setup({ 'claude-code': withLevels(LEVELS.forecast) }, { history: forecastHistory(now) });
    case 'locked':
      return setup({ 'claude-code': withLevels(LEVELS.normal) }, { locked: true });
    case 'other-account':
      // An added folder whose sign-in has expired, nothing cached yet; Claude Desktop has only the
      // default account's org, which doesn't count for it.
      return setup(
        {
          'claude-code': claudeCode(() => delay(expired, 0), undefined, MOCK_FOLDER.account),
          'claude-desktop': desktop(6 * MIN, MOCK_FOLDER.account, 'strict'),
        },
        { folder: MOCK_FOLDER },
      );
    case 'update-ready':
      return setup({ 'claude-code': withLevels(LEVELS.normal) }, { updateReady: true });
  }
}
