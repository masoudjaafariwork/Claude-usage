// Launch at login, per OS: Windows and macOS through Electron's login item API, Linux through an
// XDG autostart entry. Only offered in packaged builds — in dev it would register bare Electron.
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WINDOWS_STARTUP_APPROVED_KEY,
  execLine,
  isStartupApprovedDisabled,
  linuxAutostartFile,
  linuxDesktopEntry,
  parseLinuxAutostart,
  type LoginItemState,
} from './login-item-core';

export interface LoginItem {
  /** False in dev and mock runs; the menu then shows the item disabled. */
  readonly available: boolean;
  state(): LoginItemState;
  set(on: boolean): void;
}

const unavailable: LoginItem = { available: false, state: () => 'off', set: () => {} };

/** Whether the entry was switched off in Task Manager → Startup apps (or Settings → Startup). */
function windowsStartupDisabled(name: string): boolean {
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  try {
    const out = execFileSync(reg, ['query', WINDOWS_STARTUP_APPROVED_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return isStartupApprovedDisabled(out);
  } catch {
    return false; // no entry → not switched off
  }
}

function windowsLoginItem(appId: string): LoginItem {
  // The Run value is named after appId (= AppUserModelId, which getLoginItemSettings reads).
  // The portable exe unpacks itself to a new temp folder on every start; register the exe itself.
  const options = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [], name: appId };
  return {
    available: true,
    state() {
      // Electron 44's launchItems / executableWillLaunchAtLogin never match a path with spaces
      // ("Claude Usage.exe" always has them), so read Task Manager's on/off flag directly.
      if (!app.getLoginItemSettings(options).openAtLogin) return 'off';
      return windowsStartupDisabled(appId) ? 'disabled' : 'on';
    },
    set(on) {
      // enabled (default true) also clears a "Disabled" flag set in Task Manager.
      app.setLoginItemSettings({ ...options, openAtLogin: on });
    },
  };
}

function macLoginItem(): LoginItem {
  return {
    available: true,
    state() {
      const s = app.getLoginItemSettings();
      if (s.status === 'requires-approval') return 'disabled'; // switched off in System Settings
      return s.openAtLogin ? 'on' : 'off';
    },
    set(on) {
      app.setLoginItemSettings({ openAtLogin: on });
    },
  };
}

function linuxLoginItem(): LoginItem {
  const file = linuxAutostartFile(process.env, homedir());
  // Keep --no-sandbox when the app needed it to start (AppImage on Ubuntu 24.04+).
  const args = process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [];
  // Read APPIMAGE each time: an update renames the AppImage and main.ts points APPIMAGE at the new file.
  const exec = () => execLine(process.env.APPIMAGE || process.execPath, args);
  return {
    available: true,
    state() {
      let text: string | null = null;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        // missing → off
      }
      return parseLinuxAutostart(text, exec());
    },
    set(on) {
      if (on) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, linuxDesktopEntry(app.getName(), exec()), 'utf8');
      } else {
        rmSync(file, { force: true });
      }
    },
  };
}

/** @param appId must equal the AppUserModelId set in main.ts (and build.appId in package.json). */
export function createLoginItem(allowed: boolean, appId: string): LoginItem {
  if (!allowed) return unavailable;
  switch (process.platform) {
    case 'win32':
      return windowsLoginItem(appId);
    case 'darwin':
      return macLoginItem();
    case 'linux':
      return linuxLoginItem();
    default:
      return unavailable;
  }
}
