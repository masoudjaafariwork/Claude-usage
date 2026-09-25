// Global keyboard shortcuts — they work while another app has focus: show/hide the overlay and
// lock/unlock it (a locked overlay can't be clicked, so the keyboard is one way back).
// Registering fails when another app already owns the keys; the menu then says so.
import { globalShortcut } from 'electron';
import { describeError, type LogFn } from './log';
import type { ShortcutState, ShortcutsStatus } from './shortcuts-core';

export interface ShortcutConfig {
  enabled: boolean;
  toggle: string;
  lock: string;
}

/** (Re-)registers both shortcuts and reports which ones the OS granted. */
export function registerShortcuts(config: ShortcutConfig, handlers: { toggle(): void; lock(): void }, log: LogFn): ShortcutsStatus {
  globalShortcut.unregisterAll();
  const register = (accelerator: string, handler: () => void): ShortcutState => {
    if (!config.enabled) return { accelerator, registered: false };
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, handler);
    } catch (err) {
      log('warn', `Shortcut ${accelerator} rejected: ${describeError(err)}`);
      return { accelerator, registered: false };
    }
    if (!registered) log('warn', `Shortcut ${accelerator} is not available (another app may use it)`);
    return { accelerator, registered };
  };
  return { enabled: config.enabled, toggle: register(config.toggle, handlers.toggle), lock: register(config.lock, handlers.lock) };
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
