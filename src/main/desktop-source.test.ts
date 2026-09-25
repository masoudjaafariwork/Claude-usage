import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClaudeCodeAccount } from './credentials';
import {
  DESKTOP_HISTORY_FILE,
  DESKTOP_MAX_AGE_MS,
  DesktopSource,
  desktopDataDirs,
  desktopSnapshot,
  latestSample,
  parseDesktopHistory,
  readDesktopHistory,
  watchDesktopHistory,
} from './desktop-source';
import realHistory from './fixtures/desktop-history-2026-09.json';
import { SourceUnavailableError } from './usage-source';

const REAL_TEXT = JSON.stringify(realHistory);
/** Newest sample in the fixture: 2026-09-25T14:49:52Z, { fh: 13, sd: 84, xu: 100 }. */
const REAL_NEWEST = 1790347792698;
const MIN = 60_000;

test('parses a real v2 history (Claude Desktop 2.7032) sample by sample', () => {
  const samples = parseDesktopHistory(REAL_TEXT);
  assert.equal(samples.length, 12);
  assert.deepEqual(samples.at(-1), { t: REAL_NEWEST, org: '00000000-0000-4000-8000-000000000001', u: { fh: 13, sd: 84, xu: 100 } });
});

test('parses v1 files (no org, values on the sample, null allowed) and ignores junk', () => {
  const v1 = JSON.stringify({ version: 1, samples: [{ t: 1000, fh: 12, sd: null }, { t: 'x' }, null, { t: 2000, fh: 5, sd: 40 }] });
  assert.deepEqual(parseDesktopHistory(v1), [
    { t: 1000, org: null, u: { fh: 12 } },
    { t: 2000, org: null, u: { fh: 5, sd: 40 } },
  ]);
  assert.deepEqual(parseDesktopHistory('not json'), []);
  assert.deepEqual(parseDesktopHistory('{"version":3}'), []);
});

test('latestSample prefers the known org, else the newest sample overall', () => {
  const samples = [
    { t: 1, org: 'a', u: { fh: 1 } },
    { t: 3, org: 'b', u: { fh: 3 } },
    { t: 2, org: 'a', u: { fh: 2 } },
  ];
  assert.equal(latestSample(samples, 'a')?.t, 2);
  assert.equal(latestSample(samples, null)?.t, 3);
  assert.equal(latestSample(samples, 'unknown')?.t, 3);
  assert.equal(latestSample([], 'a'), null);
});

test('maps Desktop keys to the API meter ids; no reset times, xu and codenames ignored', () => {
  const snap = desktopSnapshot({ t: REAL_NEWEST, org: null, u: { fh: 3, sd: 91, so: 40, sn: 10, xu: 100, cw: 5, om: 7 } });
  assert.ok(snap);
  assert.deepEqual(
    snap.meters.map((m) => [m.id, m.label, m.percent, m.severity, m.resetsAt]),
    [
      ['session', 'Current session', 3, 'normal', null],
      ['weekly_all', 'Weekly · All models', 91, 'critical', null],
      ['weekly_scoped:opus', 'Weekly · Opus', 40, 'normal', null],
      ['weekly_scoped:sonnet', 'Weekly · Sonnet', 10, 'normal', null],
    ],
  );
  assert.equal(snap.source, 'claude-desktop');
  assert.equal(snap.fetchedAt, new Date(REAL_NEWEST).toISOString());
  assert.equal(snap.spend, null);
  assert.equal(desktopSnapshot({ t: 1, org: null, u: { xu: 100 } }), null);
});

function source(
  history: string | null,
  now: number,
  account: ClaudeCodeAccount | null = null,
  orgMatch: 'off' | 'if-known' | 'strict' = 'off',
) {
  const src = new DesktopSource({
    readHistory: async () => history,
    claudeCodeAccount: async () => account,
    orgMatch: () => orgMatch,
    now: () => now,
  });
  return { src };
}

const account = (orgUuid: string): ClaudeCodeAccount => ({
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  orgName: "ada@example.com's Organization",
  orgUuid,
});

async function unavailableKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof SourceUnavailableError, String(err));
    return err.status.kind;
  }
  assert.fail('expected SourceUnavailableError');
}

test('a sample up to 20 min old is used; older means Desktop is not running', async () => {
  const fresh = source(REAL_TEXT, REAL_NEWEST + 12 * MIN);
  const snap = await fresh.src.fetch({ shownFetchedAt: null });
  assert.deepEqual(snap.meters.map((m) => m.percent), [13, 84]);

  const stale = source(REAL_TEXT, REAL_NEWEST + DESKTOP_MAX_AGE_MS + 1);
  assert.equal(await unavailableKind(stale.src.fetch({ shownFetchedAt: null })), 'desktop-unavailable');
});

test('no history file → unavailable', async () => {
  assert.equal(await unavailableKind(source(null, REAL_NEWEST).src.fetch({ shownFetchedAt: null })), 'desktop-unavailable');
});

test('never replaces newer data from another source with an older sample', async () => {
  const { src } = source(REAL_TEXT, REAL_NEWEST + 5 * MIN);
  assert.equal(await unavailableKind(src.fetch({ shownFetchedAt: REAL_NEWEST + 60_000 })), 'desktop-unavailable');
  assert.ok(await src.fetch({ shownFetchedAt: REAL_NEWEST - 60_000 }));
});

test('with several orgs, the samples of Claude Code’s org win even when another org is newer', async () => {
  const history = JSON.stringify({
    version: 2,
    samples: [
      { t: 1000, org: 'mine', u: { fh: 11, sd: 22 } },
      { t: 2000, org: 'team', u: { fh: 99, sd: 99 } },
    ],
  });
  const { src } = source(history, 3000, account('mine'));
  const snap = await src.fetch({ shownFetchedAt: null });
  assert.equal(snap.meters[0]?.percent, 11);
  assert.deepEqual(snap.account, { email: 'ada@example.com', name: 'Ada Lovelace', organization: null });
});

test('samples are labelled with Claude Code’s account only when they are of its org', async () => {
  const history = (org: string | null) => JSON.stringify({ version: 2, samples: [{ t: 1000, org, u: { fh: 11 } }] });
  const label = async (org: string | null, who: ClaudeCodeAccount | null) =>
    (await source(history(org), 2000, who).src.fetch({ shownFetchedAt: null })).account ?? null;
  assert.equal((await label('mine', account('mine')))?.email, 'ada@example.com');
  assert.equal(await label('team', account('mine')), null, 'another org: Desktop may be signed in to another account');
  assert.equal(await label(null, account('mine')), null, 'v1 samples have no org');
  assert.equal(await label('mine', null), null, 'Claude Code not signed in');
});

test('org match (D51): strict for an added account folder, only when Claude Code’s account is known in Auto', async () => {
  const history = (...orgs: Array<string | null>) =>
    JSON.stringify({ version: 2, samples: orgs.map((org, i) => ({ t: 1000 + i * 100, org, u: { fh: 10 + i } })) });
  const fetch = (text: string, who: ClaudeCodeAccount | null, orgMatch: 'off' | 'if-known' | 'strict') =>
    source(text, 2000, who, orgMatch).src.fetch({ shownFetchedAt: null });
  for (const orgMatch of ['if-known', 'strict'] as const) {
    assert.equal((await fetch(history('mine', 'team'), account('mine'), orgMatch)).meters[0]?.percent, 10, 'its own org, though older');
    assert.equal(await unavailableKind(fetch(history('team'), account('mine'), orgMatch)), 'desktop-unavailable', 'only another org');
    assert.equal(await unavailableKind(fetch(history(null), account('mine'), orgMatch)), 'desktop-unavailable', 'org unknown (v1)');
  }
  // Claude Code's account unknown: an added folder shows nothing; Auto still serves Desktop-only users.
  assert.equal(await unavailableKind(fetch(history('team'), null, 'strict')), 'desktop-unavailable');
  assert.equal((await fetch(history('team'), null, 'if-known')).meters[0]?.percent, 10);
  // Claude Desktop only: any org, just not labelled (D41).
  assert.equal((await fetch(history('team'), account('mine'), 'off')).account, undefined);
});

test('desktopDataDirs covers MSIX, Squirrel, macOS and Linux community builds', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.deepEqual(desktopDataDirs('win32', env, 'C:\\Users\\u'), [
    'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude',
    'C:\\Users\\u\\AppData\\Roaming\\Claude',
  ]);
  assert.deepEqual(desktopDataDirs('darwin', {}, '/Users/u'), ['/Users/u/Library/Application Support/Claude']);
  assert.deepEqual(desktopDataDirs('linux', {}, '/home/u'), ['/home/u/.config/Claude']);
});

test('readDesktopHistory reads the first folder that has the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-usage-desktop-'));
  try {
    const missing = join(root, 'missing');
    const present = join(root, 'present');
    mkdirSync(present);
    writeFileSync(join(present, DESKTOP_HISTORY_FILE), REAL_TEXT);
    assert.equal(await readDesktopHistory([missing, present]), REAL_TEXT);
    assert.equal(await readDesktopHistory([missing]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('watchDesktopHistory fires (debounced) when Desktop atomically replaces the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-usage-watch-'));
  let calls = 0;
  // macOS (FSEvents) reports changes late and sometimes in more than one batch, so the debounce is
  // generous and the test waits for the call instead of a fixed time (it failed on a macOS runner).
  const stop = watchDesktopHistory([join(root, 'missing'), root], () => calls++, 300);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    // Like Desktop's writeFileAtomic: write a temp file, then rename it over the history file.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, 'tmp.json'), REAL_TEXT);
      renameSync(join(root, 'tmp.json'), join(root, DESKTOP_HISTORY_FILE));
    }
    writeFileSync(join(root, 'unrelated.json'), '{}');
    for (let waited = 0; calls === 0 && waited < 5000; waited += 50) await sleep(50);
    await sleep(600); // a second, late call would show up here
    assert.equal(calls, 1);
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
});
