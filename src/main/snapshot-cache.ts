// Remembers the last successful snapshot on disk so the overlay shows (stale) data immediately
// on startup, while offline, or while the Claude Code sign-in is expired.
import type { UsageSnapshot } from '../shared/types';
import { readJson, writeJsonAtomic } from './settings';

export function loadSnapshot(file: string): UsageSnapshot | null {
  const raw = readJson(file) as Partial<UsageSnapshot> | undefined;
  if (!raw || typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.meters) || raw.meters.length === 0) return null;
  return {
    fetchedAt: raw.fetchedAt,
    plan: typeof raw.plan === 'string' ? raw.plan : null,
    meters: raw.meters,
    breakdown: Array.isArray(raw.breakdown) ? raw.breakdown : [],
    spend: raw.spend ?? null,
  };
}

export function saveSnapshot(file: string, snapshot: UsageSnapshot): void {
  try {
    writeJsonAtomic(file, snapshot);
  } catch (err) {
    console.error('Failed to cache usage snapshot:', err);
  }
}
