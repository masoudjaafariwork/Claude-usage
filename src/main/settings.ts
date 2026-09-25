// Persistent user settings (JSON file in Electron's userData directory).
// Pure module (Node fs only) so sanitizing can be unit-tested.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SourceMode } from '../shared/types';

export interface Settings {
  /** Top-left corner of the overlay in screen DIPs; null = default spot on the primary display. */
  position: { x: number; y: number } | null;
  compact: boolean;
  /** Weekly meter ids (e.g. "weekly_all", "weekly_scoped:fable") hidden from the compact pill. */
  compactHidden: string[];
  alwaysOnTop: boolean;
  /** Overlay opacity, 0.3–1. */
  opacity: number;
  refreshIntervalSec: number;
  /** Start with the OS. Mirrors the OS login item; reconciled with it on startup (login-item-core.ts). */
  launchAtLogin: boolean;
  /** Where usage comes from; 'auto' = Claude Code, then Claude Desktop. */
  source: SourceMode;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  position: null,
  compact: false,
  compactHidden: [],
  alwaysOnTop: true,
  opacity: 1,
  refreshIntervalSec: 180,
  launchAtLogin: false,
  source: 'auto',
};

export const SOURCE_MODES: readonly SourceMode[] = ['auto', 'claude-code', 'claude-desktop'];

export const REFRESH_INTERVAL_OPTIONS_SEC = [60, 120, 180, 300, 600] as const;
export const OPACITY_OPTIONS = [1, 0.9, 0.8, 0.7, 0.6, 0.5] as const;
const MIN_REFRESH_SEC = 60;
const MAX_REFRESH_SEC = 3600;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Unique, non-empty, reasonably short strings; anything else is dropped. */
function sanitizeIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ids = v.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100);
  return [...new Set(ids)].slice(0, 50);
}

export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pos = r.position as Record<string, unknown> | null | undefined;
  return {
    position:
      pos && isFiniteNumber(pos.x) && isFiniteNumber(pos.y) ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null,
    compact: typeof r.compact === 'boolean' ? r.compact : DEFAULT_SETTINGS.compact,
    compactHidden: sanitizeIdList(r.compactHidden),
    alwaysOnTop: typeof r.alwaysOnTop === 'boolean' ? r.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    opacity: isFiniteNumber(r.opacity) ? Math.min(1, Math.max(0.3, r.opacity)) : DEFAULT_SETTINGS.opacity,
    refreshIntervalSec: isFiniteNumber(r.refreshIntervalSec)
      ? Math.min(MAX_REFRESH_SEC, Math.max(MIN_REFRESH_SEC, Math.round(r.refreshIntervalSec)))
      : DEFAULT_SETTINGS.refreshIntervalSec,
    launchAtLogin: typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    source: SOURCE_MODES.includes(r.source as SourceMode) ? (r.source as SourceMode) : DEFAULT_SETTINGS.source,
  };
}

/** Writes JSON atomically (temp file + rename) so a crash never leaves a half-written file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export class SettingsStore {
  private data: Settings;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly persist: boolean;

  /** @param persist false = keep changes in memory only (mock / screenshot runs). */
  constructor(file: string, persist = true) {
    this.file = file;
    this.persist = persist;
    this.data = sanitizeSettings(readJson(file));
  }

  get(): Readonly<Settings> {
    return this.data;
  }

  update(patch: Partial<Settings>): Readonly<Settings> {
    this.data = sanitizeSettings({ ...this.data, ...patch });
    if (this.persist) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), 400);
    }
    return this.data;
  }

  /** Writes pending changes immediately (call on quit). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.persist) return;
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  }
}
