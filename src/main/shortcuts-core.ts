// Global keyboard shortcuts: defaults, validation of hand-edited values and how they are shown.
// Pure module (unit-tested in shortcuts-core.test.ts); shortcuts.ts registers them with Electron.

/** Electron accelerators; CommandOrControl = Cmd on macOS, Ctrl elsewhere. */
export const DEFAULT_SHORTCUTS = {
  toggle: 'CommandOrControl+Alt+U',
  lock: 'CommandOrControl+Alt+Shift+U',
} as const;

export type ShortcutName = keyof typeof DEFAULT_SHORTCUTS;

/** One shortcut and whether the OS let us have it (another app may own the same keys). */
export interface ShortcutState {
  accelerator: string;
  registered: boolean;
}

export interface ShortcutsStatus {
  enabled: boolean;
  toggle: ShortcutState;
  lock: ShortcutState;
}

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);

/**
 * True for "Modifier+…+Key" with at least one modifier — a global shortcut without one would steal
 * a key from every app. Electron validates the key itself when registering.
 */
export function isValidShortcut(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 60) return false;
  const parts = value.split('+');
  const key = parts.pop();
  return parts.length > 0 && !!key && parts.every((p) => MODIFIERS.has(p.toLowerCase())) && !MODIFIERS.has(key.toLowerCase());
}

const MAC_SYMBOLS: Record<string, string> = {
  command: '⌘',
  cmd: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
};

const OTHER_NAMES: Record<string, string> = {
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  option: 'Alt',
};

/** "CommandOrControl+Alt+U" → "Ctrl+Alt+U" (Windows, Linux) or "⌘⌥U" (macOS), for labels. */
export function shortcutLabel(accelerator: string, platform: NodeJS.Platform): string {
  const parts = accelerator.split('+');
  if (platform === 'darwin') return parts.map((p) => MAC_SYMBOLS[p.toLowerCase()] ?? p).join('');
  const superKey = platform === 'win32' ? 'Win' : 'Super';
  return parts
    .map((p) => {
      const lower = p.toLowerCase();
      return lower === 'super' || lower === 'meta' ? superKey : (OTHER_NAMES[lower] ?? p);
    })
    .join('+');
}
