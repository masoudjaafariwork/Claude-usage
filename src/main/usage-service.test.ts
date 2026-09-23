import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialsNotFoundError, type ClaudeCredentials } from './credentials';
import { mockRawUsage } from './mock';
import { UsageHttpError } from './usage-errors';
import { MIN_GAP_SEC, RECHECK_CREDENTIALS_SEC, UsageService, backoffSec, type UsageServiceDeps } from './usage-service';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;

const creds = (overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials => ({
  accessToken: 'token-a',
  expiresAt: NOW + 8 * HOUR,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  source: 'file',
  ...overrides,
});

function service(overrides: Partial<UsageServiceDeps>) {
  let fetches = 0;
  const deps: UsageServiceDeps = {
    readCredentials: async () => creds(),
    fetchUsage: async () => mockRawUsage(NOW, { session: 20, weekly: 50, fable: 30 }),
    intervalSec: () => 180,
    now: () => NOW,
    ...overrides,
  };
  const wrapped: UsageServiceDeps = {
    ...deps,
    fetchUsage: (token) => {
      fetches++;
      return deps.fetchUsage(token);
    },
  };
  return { svc: new UsageService(wrapped), fetches: () => fetches };
}

test('a successful fetch stores the snapshot and schedules the normal interval', async () => {
  const { svc } = service({});
  const delay = await svc.attempt();
  assert.equal(svc.status.kind, 'ok');
  assert.equal(svc.snapshot?.plan, 'Max 20×');
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

test('missing credentials → no-credentials, re-checked without calling the API', async () => {
  const { svc, fetches } = service({ readCredentials: async () => Promise.reject(new CredentialsNotFoundError('x')) });
  assert.equal(await svc.attempt(), RECHECK_CREDENTIALS_SEC);
  assert.equal(svc.status.kind, 'no-credentials');
  assert.equal(fetches(), 0);
});

test('an expired token is not sent to the API', async () => {
  const { svc, fetches } = service({ readCredentials: async () => creds({ expiresAt: NOW - 1 }) });
  assert.equal(await svc.attempt(), RECHECK_CREDENTIALS_SEC);
  assert.equal(svc.status.kind, 'token-expired');
  assert.equal(fetches(), 0);
});

test('a 401 marks the token rejected until Claude Code writes a new one', async () => {
  let token = 'token-a';
  const { svc, fetches } = service({
    readCredentials: async () => creds({ accessToken: token }),
    fetchUsage: async (t) => {
      if (t === 'token-a') throw new UsageHttpError(401, null);
      return mockRawUsage(NOW, { session: 1, weekly: 2, fable: 3 });
    },
  });
  await svc.attempt();
  assert.equal(svc.status.kind, 'token-expired');
  await svc.attempt();
  assert.equal(fetches(), 1, 'same rejected token is not retried');
  token = 'token-b';
  await svc.attempt();
  assert.equal(svc.status.kind, 'ok');
  assert.equal(fetches(), 2);
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
