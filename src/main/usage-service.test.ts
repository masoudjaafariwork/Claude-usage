import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceMode } from '../shared/types';
import { CredentialsNotFoundError, type ClaudeCredentials } from './credentials';
import { DesktopSource } from './desktop-source';
import { mockRawUsage } from './mock';
import { UsageHttpError } from './usage-errors';
import { ClaudeCodeSource } from './usage-source';
import { MIN_GAP_SEC, RECHECK_CREDENTIALS_SEC, UsageService, backoffSec } from './usage-service';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const creds = (overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials => ({
  accessToken: 'token-a',
  expiresAt: NOW + 8 * HOUR,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  source: 'file',
  ...overrides,
});

interface Setup {
  mode?: SourceMode;
  readCredentials?: () => Promise<ClaudeCredentials>;
  fetchUsage?: (token: string) => Promise<unknown>;
  /** Age of Claude Desktop's newest sample in ms; null = no history file. */
  desktopAgeMs?: number | null;
  now?: () => number;
}

function service(setup: Setup = {}) {
  const counts = { reads: 0, fetches: 0, desktopReads: 0 };
  let mode: SourceMode = setup.mode ?? 'auto';
  const now = setup.now ?? (() => NOW);
  const claudeCode = new ClaudeCodeSource({
    readCredentials: () => {
      counts.reads++;
      return (setup.readCredentials ?? (async () => creds()))();
    },
    fetchUsage: (token) => {
      counts.fetches++;
      return (setup.fetchUsage ?? (async () => mockRawUsage(NOW, { session: 20, weekly: 50, fable: 30 })))(token);
    },
    now,
  });
  const desktopAge = setup.desktopAgeMs === undefined ? null : setup.desktopAgeMs;
  const desktop = new DesktopSource({
    readHistory: async () => {
      counts.desktopReads++;
      return desktopAge === null
        ? null
        : JSON.stringify({ version: 2, samples: [{ t: now() - desktopAge, org: 'org', u: { fh: 7, sd: 61 } }] });
    },
    preferredOrg: async () => null,
    now,
  });
  const svc = new UsageService({
    sources: { 'claude-code': claudeCode, 'claude-desktop': desktop },
    mode: () => mode,
    intervalSec: () => 180,
    now,
  });
  return { svc, counts, setMode: (m: SourceMode) => (mode = m) };
}

const expiredCreds = async () => creds({ expiresAt: NOW - 1 });
const noCreds = async (): Promise<ClaudeCredentials> => Promise.reject(new CredentialsNotFoundError('x'));

// ---- Claude Code source (behaviour kept from Phase 1) -------------------------------------------

test('a successful fetch stores the snapshot and schedules the normal interval', async () => {
  const { svc } = service();
  const delay = await svc.attempt();
  assert.equal(svc.status.kind, 'ok');
  assert.equal(svc.snapshot?.plan, 'Max 20×');
  assert.equal(svc.snapshot?.source, 'claude-code');
  assert.equal(svc.snapshot?.meters[0]?.percent, 20);
  assert.equal(delay, 180);
});

test('polls again shortly after the earliest reset when it comes before the interval', async () => {
  const { svc } = service({
    fetchUsage: async () => ({ limits: [{ kind: 'session', percent: 50, resets_at: new Date(NOW + 100_000).toISOString() }] }),
  });
  assert.equal(await svc.attempt(), 105);
});

test('never schedules closer than MIN_GAP_SEC, even right before a reset', async () => {
  const { svc } = service({
    fetchUsage: async () => ({ limits: [{ kind: 'session', percent: 50, resets_at: new Date(NOW + 1_000).toISOString() }] }),
  });
  assert.equal(await svc.attempt(), MIN_GAP_SEC);
});

test('Claude Code only: missing credentials → no-credentials, re-checked without calling the API', async () => {
  const { svc, counts } = service({ mode: 'claude-code', readCredentials: noCreds });
  assert.equal(await svc.attempt(), RECHECK_CREDENTIALS_SEC);
  assert.equal(svc.status.kind, 'no-credentials');
  assert.equal(counts.fetches, 0);
  assert.equal(counts.desktopReads, 0, 'Claude Code only never looks at Claude Desktop');
});

test('an expired token is not sent to the API', async () => {
  const { svc, counts } = service({ mode: 'claude-code', readCredentials: expiredCreds });
  assert.equal(await svc.attempt(), RECHECK_CREDENTIALS_SEC);
  assert.equal(svc.status.kind, 'token-expired');
  assert.equal(counts.fetches, 0);
});

test('a 401 marks the token rejected until Claude Code writes a new one', async () => {
  let token = 'token-a';
  const { svc, counts } = service({
    readCredentials: async () => creds({ accessToken: token }),
    fetchUsage: async (t) => {
      if (t === 'token-a') throw new UsageHttpError(401, null);
      return mockRawUsage(NOW, { session: 1, weekly: 2, fable: 3 });
    },
  });
  await svc.attempt();
  assert.equal(svc.status.kind, 'token-expired');
  await svc.attempt();
  assert.equal(counts.fetches, 1, 'same rejected token is not retried');
  token = 'token-b';
  await svc.attempt();
  assert.equal(svc.status.kind, 'ok');
  assert.equal(counts.fetches, 2);
});

test('a 429 honours Retry-After and keeps the previous snapshot', async () => {
  let fail = false;
  const { svc } = service({
    fetchUsage: async () => {
      if (fail) throw new UsageHttpError(429, 600);
      return mockRawUsage(NOW, { session: 20, weekly: 50, fable: 30 });
    },
  });
  await svc.attempt();
  const before = svc.snapshot;
  fail = true;
  assert.equal(await svc.attempt(), 600);
  assert.equal(svc.status.kind, 'rate-limited');
  assert.equal(svc.snapshot, before);
});

test('network errors back off exponentially', async () => {
  const { svc } = service({ fetchUsage: async () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')) });
  assert.equal(await svc.attempt(), 30);
  assert.equal(await svc.attempt(), 60);
  assert.equal(await svc.attempt(), 120);
  assert.equal(svc.status.kind, 'network-error');
});

test('an unrecognized response is reported as an error', async () => {
  const { svc } = service({ fetchUsage: async () => ({ unexpected: true }) });
  assert.equal(await svc.attempt(), 180);
  assert.equal(svc.status.kind, 'error');
});

test('backoffSec doubles per failure and is capped', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffSec(30, n)), [30, 60, 120, 240]);
  assert.equal(backoffSec(600, 10), 1800);
});

// ---- Source selection and Auto fallback (Phase 3) ----------------------------------------------

test('Auto: expired Claude Code token + recent Desktop sample → data via Claude Desktop, not an error', async () => {
  const { svc, counts } = service({ readCredentials: expiredCreds, desktopAgeMs: 6 * MIN });
  assert.equal(await svc.attempt(), 180);
  assert.equal(svc.status.kind, 'ok');
  assert.equal(svc.snapshot?.source, 'claude-desktop');
  assert.deepEqual(svc.snapshot?.meters.map((m) => m.percent), [7, 61]);
  assert.equal(counts.fetches, 0);
});

test('Auto: once Claude Code’s token is renewed, it switches back to Claude Code', async () => {
  let current = creds({ expiresAt: NOW - 1 });
  const { svc } = service({ readCredentials: async () => current, desktopAgeMs: 6 * MIN });
  await svc.attempt();
  assert.equal(svc.snapshot?.source, 'claude-desktop');
  current = creds({ accessToken: 'renewed' });
  await svc.attempt();
  assert.equal(svc.status.kind, 'ok');
  assert.equal(svc.snapshot?.source, 'claude-code');
});

test('Auto: expired token and Desktop not running → token-expired banner, last data kept', async () => {
  let current = creds();
  const { svc } = service({ readCredentials: async () => current, desktopAgeMs: 45 * MIN });
  await svc.attempt();
  const before = svc.snapshot;
  current = creds({ expiresAt: NOW - 1 });
  assert.equal(await svc.attempt(), RECHECK_CREDENTIALS_SEC);
  assert.equal(svc.status.kind, 'token-expired');
  assert.equal(svc.snapshot, before);
});

test('Auto: nothing available → one "not signed in" status naming both ways to fix it', async () => {
  const { svc } = service({ readCredentials: noCreds, desktopAgeMs: null });
  await svc.attempt();
  assert.equal(svc.status.kind, 'no-credentials');
  assert.match(svc.status.message ?? '', /Claude Code.*Claude desktop app/);
});

test('Auto: a Desktop sample older than the data shown does not replace it', async () => {
  let clock = NOW;
  let current = creds();
  // Desktop's sample is always 10 min old; Claude Code data is fresh.
  const { svc } = service({ readCredentials: async () => current, desktopAgeMs: 10 * MIN, now: () => clock });
  await svc.attempt();
  assert.equal(svc.snapshot?.source, 'claude-code');
  current = creds({ expiresAt: clock - 1 });
  clock += 2 * MIN;
  await svc.attempt();
  assert.equal(svc.status.kind, 'token-expired', 'the 12-min-old Claude Code data stays, marked stale');
  assert.equal(svc.snapshot?.source, 'claude-code');
});

test('Auto: a transient Claude Code error is reported, not hidden behind Desktop data', async () => {
  const { svc, counts } = service({ fetchUsage: async () => Promise.reject(new Error('net::ERR_TIMED_OUT')), desktopAgeMs: 2 * MIN });
  await svc.attempt();
  assert.equal(svc.status.kind, 'network-error');
  assert.equal(counts.desktopReads, 0);
});

test('Claude Desktop only: Claude Code is never read; a stale sample → desktop-unavailable', async () => {
  const fresh = service({ mode: 'claude-desktop', desktopAgeMs: 3 * MIN });
  await fresh.svc.attempt();
  assert.equal(fresh.svc.snapshot?.source, 'claude-desktop');
  assert.equal(fresh.counts.reads, 0);

  const stale = service({ mode: 'claude-desktop', desktopAgeMs: 2 * HOUR });
  assert.equal(await stale.svc.attempt(), RECHECK_CREDENTIALS_SEC);
  assert.equal(stale.svc.status.kind, 'desktop-unavailable');
});

test('switching the mode takes effect on the next attempt', async () => {
  const { svc, setMode } = service({ desktopAgeMs: 3 * MIN });
  await svc.attempt();
  assert.equal(svc.snapshot?.source, 'claude-code');
  setMode('claude-desktop');
  await svc.attempt();
  assert.equal(svc.snapshot?.source, 'claude-desktop', 'Desktop-only mode shows its sample even if older');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a new Desktop sample is picked up at once only when Desktop is (or may become) the source', async () => {
  const onDesktop = service({ readCredentials: expiredCreds, desktopAgeMs: 4 * MIN });
  onDesktop.svc.start();
  await settle();
  const reads = onDesktop.counts.desktopReads;
  onDesktop.svc.desktopHistoryChanged();
  await settle();
  assert.equal(onDesktop.counts.desktopReads, reads + 1);
  onDesktop.svc.stop();

  const onClaudeCode = service({ desktopAgeMs: 4 * MIN });
  onClaudeCode.svc.start();
  await settle();
  const fetches = onClaudeCode.counts.fetches;
  onClaudeCode.svc.desktopHistoryChanged();
  await settle();
  assert.equal(onClaudeCode.counts.fetches, fetches, 'no extra API request while Claude Code is the source');
  onClaudeCode.svc.stop();
});

test('a rewritten credentials file brings Claude Code back at once — but never skips a backoff', async () => {
  // Expired → Claude Code renews its token → recovered without waiting for the 60 s re-check.
  let current = creds({ expiresAt: NOW - 1 });
  const expired = service({ mode: 'claude-code', readCredentials: async () => current });
  expired.svc.start();
  await settle();
  assert.equal(expired.svc.status.kind, 'token-expired');
  current = creds({ accessToken: 'renewed' });
  expired.svc.credentialsChanged();
  await settle();
  assert.equal(expired.svc.status.kind, 'ok');
  expired.svc.stop();

  // Auto on Claude Desktop's numbers → switches back to Claude Code.
  let auto = creds({ expiresAt: NOW - 1 });
  const onDesktop = service({ readCredentials: async () => auto, desktopAgeMs: 3 * MIN });
  onDesktop.svc.start();
  await settle();
  assert.equal(onDesktop.svc.snapshot?.source, 'claude-desktop');
  auto = creds({ accessToken: 'renewed' });
  onDesktop.svc.credentialsChanged();
  await settle();
  assert.equal(onDesktop.svc.snapshot?.source, 'claude-code');
  onDesktop.svc.stop();

  // Offline: a credentials change must not trigger an extra request inside the backoff.
  const offline = service({ fetchUsage: async () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')) });
  offline.svc.start();
  await settle();
  const fetches = offline.counts.fetches;
  offline.svc.credentialsChanged();
  await settle();
  assert.equal(offline.counts.fetches, fetches);
  offline.svc.stop();
});
