// Claude Desktop's own record of plan usage (`plan-usage-history.json`) as a read-only,
// no-network source that needs no sign-in. Desktop polls claude.ai/api/organizations/{org}/usage
// about every 15 min while it runs (paused while the computer is idle or locked, and only while a
// server-side feature flag is on) and appends one sample per poll.
// It is another app's internal file: parse tolerantly, never write to Desktop's folder, never read
// any other file there — its sign-in in particular is off limits (D26). Pure module.
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { LimitMeter, UsageSnapshot } from '../shared/types';
import { accountInfo, type ClaudeCodeAccount } from './credentials';
import { watchFileInDirs } from './file-watch';
import { severityFor } from './usage-parse';
import { SourceUnavailableError, type FetchContext, type UsageSource } from './usage-source';

export const DESKTOP_HISTORY_FILE = 'plan-usage-history.json';
/** Samples older than this count as unavailable (Desktop is probably closed, or the PC idle). */
export const DESKTOP_MAX_AGE_MS = 20 * 60_000;

export interface DesktopSample {
  /** Epoch ms. */
  t: number;
  org: string | null;
  /** Short keys → percent 0–100, e.g. { fh: 12, sd: 40 }. */
  u: Record<string, number>;
}

/** Candidate Claude Desktop data folders, most likely first. */
export function desktopDataDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
    return [
      // Microsoft Store / MSIX installer: the package's virtualized AppData.
      win32.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'),
      // Older Squirrel installer.
      win32.join(roaming, 'Claude'),
    ];
  }
  if (platform === 'darwin') return [posix.join(home, 'Library', 'Application Support', 'Claude')];
  // No official Linux app; community builds use the XDG config folder.
  return [posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'Claude')];
}

const joinFor = (dir: string, file: string) => (dir.includes('\\') ? win32.join(dir, file) : posix.join(dir, file));

/** Reads plan-usage-history.json from the first folder that has it (read-only). */
export async function readDesktopHistory(dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    try {
      return await readFile(joinFor(dir, DESKTOP_HISTORY_FILE), 'utf8');
    } catch {
      // Not installed there, or mid-write (Desktop replaces the file atomically): try the next one.
    }
  }
  return null;
}

/**
 * Calls `onChange` (debounced) when Desktop rewrites its history file (atomically, so the folders
 * are watched — see file-watch.ts). Returns a function that stops watching.
 */
export function watchDesktopHistory(dirs: readonly string[], onChange: () => void, debounceMs = 1500): () => void {
  return watchFileInDirs(dirs, DESKTOP_HISTORY_FILE, onChange, debounceMs);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** v2: { version: 2, samples: [{ t, org, u: { fh, sd, … } }] }; v1: { version: 1, samples: [{ t, fh, sd }] }. */
export function parseDesktopHistory(text: string): DesktopSample[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(data) || !Array.isArray(data.samples)) return [];
  const samples: DesktopSample[] = [];
  for (const entry of data.samples) {
    if (!isObject(entry) || !isNum(entry.t)) continue;
    const values = isObject(entry.u) ? entry.u : entry;
    const u: Record<string, number> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key !== 't' && key !== 'org' && isNum(value)) u[key] = value;
    }
    samples.push({ t: entry.t, org: typeof entry.org === 'string' ? entry.org : null, u });
  }
  return samples;
}

/** Newest sample of the preferred org when it has any, otherwise the newest sample overall. */
export function latestSample(samples: readonly DesktopSample[], preferredOrg: string | null): DesktopSample | null {
  let newest: DesktopSample | null = null;
  let newestPreferred: DesktopSample | null = null;
  for (const sample of samples) {
    if (!newest || sample.t > newest.t) newest = sample;
    if (preferredOrg && sample.org === preferredOrg && (!newestPreferred || sample.t > newestPreferred.t)) {
      newestPreferred = sample;
    }
  }
  return newestPreferred ?? newest;
}

/**
 * Desktop's short keys (five_hour → fh, seven_day → sd, seven_day_opus → so, seven_day_sonnet → sn).
 * Ids match the API's so animations and the compact view line up. `xu` (extra-usage utilization)
 * is deliberately not shown: Desktop records it even while extra usage is switched off (D30).
 */
const DESKTOP_METERS: ReadonlyArray<{ key: string; id: string; group: LimitMeter['group']; label: string }> = [
  { key: 'fh', id: 'session', group: 'session', label: 'Current session' },
  { key: 'sd', id: 'weekly_all', group: 'weekly', label: 'Weekly · All models' },
  { key: 'so', id: 'weekly_scoped:opus', group: 'weekly', label: 'Weekly · Opus' },
  { key: 'sn', id: 'weekly_scoped:sonnet', group: 'weekly', label: 'Weekly · Sonnet' },
];

export function desktopSnapshot(sample: DesktopSample): UsageSnapshot | null {
  const meters: LimitMeter[] = [];
  for (const m of DESKTOP_METERS) {
    const percent = sample.u[m.key];
    if (percent === undefined) continue;
    meters.push({ id: m.id, group: m.group, label: m.label, percent, severity: severityFor(percent), resetsAt: null, isActive: false });
  }
  if (meters.length === 0) return null;
  return { fetchedAt: new Date(sample.t).toISOString(), plan: null, meters, breakdown: [], spend: null, source: 'claude-desktop' };
}

export interface DesktopSourceDeps {
  /** Contents of plan-usage-history.json from the first Desktop folder that has one; null when none does. */
  readHistory(): Promise<string | null>;
  /**
   * Claude Code's account: its org picks the right samples when several orgs appear, and samples of
   * that org are labelled with it.
   */
  claudeCodeAccount(): Promise<ClaudeCodeAccount | null>;
  /**
   * Whether a sample must be of Claude Code's org (D51) — Desktop has one sign-in, and another org's
   * numbers are someone else's: 'strict' for an added account folder; 'if-known' in Auto (only when
   * Claude Code's account is known: Desktop-only users have none); 'off' shows any (Desktop only).
   */
  orgMatch?(): 'off' | 'if-known' | 'strict';
  now(): number;
}

export class DesktopSource implements UsageSource {
  readonly id = 'claude-desktop' as const;
  private readonly deps: DesktopSourceDeps;

  constructor(deps: DesktopSourceDeps) {
    this.deps = deps;
  }

  async fetch(context: FetchContext): Promise<UsageSnapshot> {
    const text = await this.deps.readHistory();
    if (text === null) {
      throw new SourceUnavailableError({
        kind: 'desktop-unavailable',
        message: 'Its usage history was not found on this computer. Install or open the Claude desktop app.',
      });
    }
    const samples = parseDesktopHistory(text);
    const account = await this.deps.claudeCodeAccount();
    const orgMatch = this.deps.orgMatch?.() ?? 'off';
    const mustMatch = orgMatch === 'strict' || (orgMatch === 'if-known' && Boolean(account?.orgUuid));
    const severalOrgs = new Set(samples.map((s) => s.org)).size > 1;
    const sample = latestSample(samples, severalOrgs || mustMatch ? (account?.orgUuid ?? null) : null);
    if (mustMatch && sample && (sample.org === null || sample.org !== account?.orgUuid)) {
      throw new SourceUnavailableError({
        kind: 'desktop-unavailable',
        message: 'Claude Desktop has no usage of this account (it is signed in to another one).',
      });
    }
    const snapshot = sample && this.deps.now() - sample.t <= DESKTOP_MAX_AGE_MS ? desktopSnapshot(sample) : null;
    if (!snapshot) {
      throw new SourceUnavailableError({
        kind: 'desktop-unavailable',
        message: 'Open the Claude desktop app: it records usage about every 15 minutes while you use it.',
      });
    }
    // Never replace newer data from another source with an older Desktop sample (Auto mode).
    if (context.shownFetchedAt !== null && sample!.t < context.shownFetchedAt) {
      throw new SourceUnavailableError({
        kind: 'desktop-unavailable',
        message: 'Claude Desktop has no usage newer than the data shown.',
      });
    }
    // A sample names only its org (Desktop's own sign-in is off limits, D26): the account is known
    // when that is Claude Code's org, otherwise it stays unknown.
    const known = sample!.org !== null && sample!.org === account?.orgUuid ? accountInfo(account) : null;
    return known ? { ...snapshot, account: known } : snapshot;
  }
}
