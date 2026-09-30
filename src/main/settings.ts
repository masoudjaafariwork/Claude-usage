// Persistent user settings (JSON file in Electron's userData directory).
// Pure module (Node fs only) so sanitizing can be unit-tested.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SourceMode } from '../shared/types';
import { MAX_FOLDERS } from './claude-accounts';
import { NOTIFY_THRESHOLDS } from './notifications-core';
import { DEFAULT_SHORTCUTS, isValidShortcut } from './shortcuts-core';
import { sanitizeDesktopChoice, type DesktopChoice } from './virtual-desktops-core';

/** Overlay colours: 'system' follows the OS light/dark setting. */
export type ThemeSetting = 'system' | 'dark' | 'light';

/** One overlay window (Phase 7): the Claude Code account it shows, where it is, how it looks. */
export interface WindowSettings {
  /** The account shown: an added config folder (one of `claudeCodeDirs`), or null for the default one. */
  account: string | null;
  /** Top-left corner in screen DIPs; null = the first free spot at the top of the primary display. */
  position: { x: number; y: number } | null;
  compact: boolean;
  /** The virtual desktop it is shown on (Phase 10); null = all desktops. */
  desktop: DesktopChoice | null;
}

export interface Settings {
  /**
   * The open overlay windows, one per account (never two for the same one); the first is the main
   * window, which the tray menu and --claude-config-dir switch. Always at least one.
   */
  windows: WindowSettings[];
  /** Weekly meter ids (e.g. "weekly_all", "weekly_scoped:fable") hidden from the compact pill. */
  compactHidden: string[];
  /** Show whose usage it is (the account's e-mail) in both views. */
  showAccount: boolean;
  alwaysOnTop: boolean;
  /** Overlay opacity, 0.3–1. */
  opacity: number;
  refreshIntervalSec: number;
  /** Start with the OS. Mirrors the OS login item; reconciled with it on startup (login-item-core.ts). */
  launchAtLogin: boolean;
  /** Where usage comes from; 'auto' = Claude Code, then Claude Desktop. */
  source: SourceMode;
  /** Claude Code config folders the user added (several accounts, one CLAUDE_CONFIG_DIR each). */
  claudeCodeDirs: string[];
  /** Click-through: the overlay ignores the mouse. Unlocked from the tray menu or the lock shortcut. */
  locked: boolean;
  /** Zoom factor of the overlay, one of SCALE_OPTIONS. */
  scale: number;
  theme: ThemeSetting;
  /** Usage levels (%) that show a notification, a subset of NOTIFY_THRESHOLDS. */
  notifyAt: number[];
  /** Also notify when a limit that reached one of those levels resets. */
  notifyReset: boolean;
  shortcutsEnabled: boolean;
  /** Global shortcuts as Electron accelerators (hand-editable in settings.json). */
  toggleShortcut: string;
  lockShortcut: string;
  /** Let Claude Code renew an expired sign-in in the background (Phase 8, claude-code-renewal.ts). */
  autoRenew: boolean;
  /**
   * Accounts whose background renewal stopped because Claude Code answered unexpectedly, with that
   * Claude Code's version: tried again only with another version or after the switch is turned on again.
   */
  renewStopped: RenewStop[];
}

export interface RenewStop {
  /** An added folder, or null for the default account. */
  account: string | null;
  claudeVersion: string;
}

export const DEFAULT_WINDOW: Readonly<WindowSettings> = { account: null, position: null, compact: false, desktop: null };

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  windows: [{ ...DEFAULT_WINDOW }],
  compactHidden: [],
  showAccount: true,
  alwaysOnTop: true,
  opacity: 1,
  refreshIntervalSec: 180,
  launchAtLogin: false,
  source: 'auto',
  claudeCodeDirs: [],
  locked: false,
  scale: 1,
  theme: 'dark',
  notifyAt: [...NOTIFY_THRESHOLDS],
  notifyReset: true,
  shortcutsEnabled: true,
  toggleShortcut: DEFAULT_SHORTCUTS.toggle,
  lockShortcut: DEFAULT_SHORTCUTS.lock,
  autoRenew: true,
  renewStopped: [],
};

export const SOURCE_MODES: readonly SourceMode[] = ['auto', 'claude-code', 'claude-desktop'];

export const REFRESH_INTERVAL_OPTIONS_SEC = [60, 120, 180, 300, 600] as const;
export const OPACITY_OPTIONS = [1, 0.9, 0.8, 0.7, 0.6, 0.5] as const;
export const SCALE_OPTIONS = [0.9, 1, 1.15, 1.3, 1.5] as const;
export const THEMES: readonly ThemeSetting[] = ['system', 'dark', 'light'];

/** The next size up (+1) or down (-1) from `current`, staying within SCALE_OPTIONS. */
export function stepScale(current: number, step: 1 | -1): number {
  const index = SCALE_OPTIONS.findIndex((option) => option === current);
  const next = Math.min(SCALE_OPTIONS.length - 1, Math.max(0, (index < 0 ? SCALE_OPTIONS.indexOf(1) : index) + step));
  return SCALE_OPTIONS[next] ?? 1;
}
const MIN_REFRESH_SEC = 60;
const MAX_REFRESH_SEC = 3600;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Unique, non-empty strings up to `maxLength` characters, at most `maxCount`; anything else is dropped. */
function sanitizeStringList(v: unknown, maxLength = 100, maxCount = 50): string[] {
  if (!Array.isArray(v)) return [];
  const items = v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= maxLength);
  return [...new Set(items)].slice(0, maxCount);
}

function sanitizePosition(v: unknown): { x: number; y: number } | null {
  const pos = v as Record<string, unknown> | null | undefined;
  return pos && isFiniteNumber(pos.x) && isFiniteNumber(pos.y) ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null;
}

/**
 * The window list: entries whose account is the default one or an added folder, one per account.
 * Settings from before Phase 7 had one window — `position`, `compact` and the selected folder
 * `claudeCodeDir` — and become its entry; windows from before Phase 10 are on all desktops.
 */
function sanitizeWindows(r: Record<string, unknown>, dirs: readonly string[]): WindowSettings[] {
  const list = Array.isArray(r.windows) ? r.windows : [{ account: r.claudeCodeDir, position: r.position, compact: r.compact }];
  const windows: WindowSettings[] = [];
  for (const item of list) {
    const w = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const account = typeof w.account === 'string' && dirs.includes(w.account) ? w.account : null;
    // An entry whose folder was removed (or never valid) falls back to the default account.
    if (windows.some((known) => known.account === account)) continue;
    windows.push({
      account,
      position: sanitizePosition(w.position),
      compact: typeof w.compact === 'boolean' ? w.compact : DEFAULT_WINDOW.compact,
      desktop: sanitizeDesktopChoice(w.desktop),
    });
  }
  return windows.length > 0 ? windows : [{ ...DEFAULT_WINDOW }];
}

/** Entries of accounts that still exist (the default one or an added folder), one per account. */
function sanitizeRenewStopped(v: unknown, dirs: readonly string[]): RenewStop[] {
  if (!Array.isArray(v)) return [];
  const stops: RenewStop[] = [];
  for (const item of v) {
    const s = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const account = s.account === null ? null : typeof s.account === 'string' && dirs.includes(s.account) ? s.account : undefined;
    if (account === undefined || typeof s.claudeVersion !== 'string' || s.claudeVersion.length > 40) continue;
    if (!stops.some((known) => known.account === account)) stops.push({ account, claudeVersion: s.claudeVersion });
  }
  return stops;
}

export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const claudeCodeDirs = sanitizeStringList(r.claudeCodeDirs, 1024, MAX_FOLDERS);
  return {
    windows: sanitizeWindows(r, claudeCodeDirs),
    compactHidden: sanitizeStringList(r.compactHidden),
    showAccount: typeof r.showAccount === 'boolean' ? r.showAccount : DEFAULT_SETTINGS.showAccount,
    alwaysOnTop: typeof r.alwaysOnTop === 'boolean' ? r.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    opacity: isFiniteNumber(r.opacity) ? Math.min(1, Math.max(0.3, r.opacity)) : DEFAULT_SETTINGS.opacity,
    refreshIntervalSec: isFiniteNumber(r.refreshIntervalSec)
      ? Math.min(MAX_REFRESH_SEC, Math.max(MIN_REFRESH_SEC, Math.round(r.refreshIntervalSec)))
      : DEFAULT_SETTINGS.refreshIntervalSec,
    launchAtLogin: typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    source: SOURCE_MODES.includes(r.source as SourceMode) ? (r.source as SourceMode) : DEFAULT_SETTINGS.source,
    claudeCodeDirs,
    locked: typeof r.locked === 'boolean' ? r.locked : DEFAULT_SETTINGS.locked,
    scale: SCALE_OPTIONS.find((option) => option === r.scale) ?? DEFAULT_SETTINGS.scale,
    theme: THEMES.includes(r.theme as ThemeSetting) ? (r.theme as ThemeSetting) : DEFAULT_SETTINGS.theme,
    notifyAt: Array.isArray(r.notifyAt)
      ? NOTIFY_THRESHOLDS.filter((t) => (r.notifyAt as unknown[]).includes(t))
      : [...DEFAULT_SETTINGS.notifyAt],
    notifyReset: typeof r.notifyReset === 'boolean' ? r.notifyReset : DEFAULT_SETTINGS.notifyReset,
    shortcutsEnabled: typeof r.shortcutsEnabled === 'boolean' ? r.shortcutsEnabled : DEFAULT_SETTINGS.shortcutsEnabled,
    toggleShortcut: isValidShortcut(r.toggleShortcut) ? r.toggleShortcut : DEFAULT_SETTINGS.toggleShortcut,
    lockShortcut: isValidShortcut(r.lockShortcut) ? r.lockShortcut : DEFAULT_SETTINGS.lockShortcut,
    autoRenew: typeof r.autoRenew === 'boolean' ? r.autoRenew : DEFAULT_SETTINGS.autoRenew,
    renewStopped: sanitizeRenewStopped(r.renewStopped, claudeCodeDirs),
  };
}

/** Writes JSON atomically (temp file + rename) so a crash never leaves a half-written file. */
export function writeJsonAtomic(file: string, value: unknown, indent = 2): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, indent), 'utf8');
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
