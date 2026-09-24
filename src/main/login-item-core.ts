// Launch-at-login logic that needs no Electron: reconciling the saved setting with the OS login
// item, and the Linux XDG autostart entry (~/.config/autostart/*.desktop). Pure module.
import { isAbsolute, join } from 'node:path';

/**
 * What the OS says about our login item for *this* executable:
 * - `on`       registered, and it will start at login
 * - `disabled` registered, but switched off in the OS (Task Manager → Startup apps,
 *              System Settings → Login Items, GNOME Startup Applications)
 * - `off`      not registered for this executable (missing, or pointing at an old path)
 */
export type LoginItemState = 'on' | 'disabled' | 'off';

export interface Reconciled {
  /** New value for settings.launchAtLogin. */
  launchAtLogin: boolean;
  /** Register the login item (again) for the current executable. */
  register: boolean;
}

/**
 * Startup sync between the saved setting and the OS. The OS wins when it has a clear answer (on,
 * or switched off by the user there); otherwise the saved setting is re-applied, which also repairs
 * the path after a portable exe or AppImage was moved.
 */
export function reconcileLoginItem(wanted: boolean, state: LoginItemState): Reconciled {
  if (state === 'on') return { launchAtLogin: true, register: false };
  if (state === 'disabled') return { launchAtLogin: false, register: false };
  return { launchAtLogin: wanted, register: wanted };
}

// --- Windows ------------------------------------------------------------------------------------------

export const WINDOWS_STARTUP_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/**
 * True when `reg query <StartupApproved\Run> /v <name>` output says the entry was switched off in
 * Task Manager / Settings → Startup (REG_BINARY whose first byte has bit 0 set, e.g. 03 00 00 00…).
 */
export function isStartupApprovedDisabled(regQueryOutput: string): boolean {
  const match = /\bREG_BINARY\s+([0-9A-Fa-f]{2})/.exec(regQueryOutput);
  return match ? (Number.parseInt(match[1]!, 16) & 1) === 1 : false;
}

// --- Linux autostart entry -------------------------------------------------------------------------

export function linuxAutostartFile(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
  return join(configHome, 'autostart', 'claude-usage-overlay.desktop');
}

/**
 * Quotes one Exec argument as the Desktop Entry spec requires: double quotes with \ " ` $ escaped,
 * % doubled (field codes), then the general string escaping of backslashes.
 */
export function quoteExecArg(arg: string): string {
  const quoted = `"${arg.replace(/[\\"`$]/g, '\\$&')}"`;
  return quoted.replace(/%/g, '%%').replace(/\\/g, '\\\\');
}

export function execLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(quoteExecArg).join(' ');
}

export function linuxDesktopEntry(name: string, exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=Shows your Claude plan usage limits',
    `Exec=${exec}`,
    'Icon=claude-usage-overlay',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** State of our autostart entry (file contents, or null when it doesn't exist) for the given Exec line. */
export function parseLinuxAutostart(text: string | null, exec: string): LoginItemState {
  if (text === null) return 'off';
  const keys = new Map<string, string>();
  let inMainGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) inMainGroup = line === '[Desktop Entry]';
    else if (inMainGroup && line.includes('=') && !line.startsWith('#')) {
      const at = line.indexOf('=');
      keys.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  if (keys.get('Hidden') === 'true' || keys.get('X-GNOME-Autostart-enabled') === 'false') return 'disabled';
  return keys.get('Exec') === exec ? 'on' : 'off';
}
