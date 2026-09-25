// The context menu, shared by the tray icon, the overlay's ⋯ button and right-click.
import { Menu, app, screen, type MenuItemConstructorOptions } from 'electron';
import type { SourceMode, StatusKind } from '../shared/types';
import { NOTIFY_THRESHOLDS } from './notifications-core';
import { OPACITY_OPTIONS, REFRESH_INTERVAL_OPTIONS_SEC, SCALE_OPTIONS, type Settings, type ThemeSetting } from './settings';
import { shortcutLabel, type ShortcutState, type ShortcutsStatus } from './shortcuts-core';
import type { UpdateMenuItem } from './update-core';

const SOURCE_ITEMS: ReadonlyArray<{ mode: SourceMode; label: string }> = [
  { mode: 'auto', label: 'Auto — Claude Code, then Claude Desktop' },
  { mode: 'claude-code', label: 'Claude Code only' },
  { mode: 'claude-desktop', label: 'Claude Desktop only' },
];

const THEME_ITEMS: ReadonlyArray<{ theme: ThemeSetting; label: string }> = [
  { theme: 'system', label: 'System' },
  { theme: 'dark', label: 'Dark' },
  { theme: 'light', label: 'Light' },
];

export interface MenuActions {
  toggleWindow(): void;
  refresh(): void;
  setCompact(compact: boolean): void;
  setCompactMeterVisible(id: string, visible: boolean): void;
  setShowAccount(on: boolean): void;
  setLocked(on: boolean): void;
  setAlwaysOnTop(on: boolean): void;
  setScale(scale: number): void;
  setOpacity(opacity: number): void;
  setTheme(theme: ThemeSetting): void;
  setRefreshInterval(seconds: number): void;
  moveToDisplay(displayId: number): void;
  resetPosition(): void;
  setLaunchAtLogin(on: boolean): void;
  setSource(mode: SourceMode): void;
  setNotifyAt(threshold: number, on: boolean): void;
  setNotifyReset(on: boolean): void;
  testNotification(): void;
  setShortcutsEnabled(on: boolean): void;
  openClaudeCode(): void;
  openSettingsFolder(): void;
  openLogsFolder(): void;
  checkForUpdates(): void;
  installUpdate(): void;
  openUpdateDownloadPage(): void;
  showAbout(): void;
  quit(): void;
}

export interface MenuContext {
  windowVisible: boolean;
  /** Launch at login works only in the packaged app. */
  loginItemAvailable: boolean;
  /** Weekly limits in the current data, offered as compact-pill toggles. */
  weeklyMeters: ReadonlyArray<{ id: string; label: string }>;
  statusKind: StatusKind;
  shortcuts: ShortcutsStatus;
  notificationsSupported: boolean;
  /** The updates item: at the top when there is something to do, else next to About. */
  update: UpdateMenuItem;
}

/** Shows a working global shortcut next to its menu item (the menu doesn't register it again). */
function accelerator(shortcut: ShortcutState): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> {
  return shortcut.registered ? { accelerator: shortcut.accelerator, registerAccelerator: false } : {};
}

export function buildMenu(settings: Readonly<Settings>, context: MenuContext, actions: MenuActions): Menu {
  const { windowVisible, loginItemAvailable, shortcuts, notificationsSupported } = context;
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const shortcutInfo = (name: string, shortcut: ShortcutState): MenuItemConstructorOptions => ({
    label: `${name}: ${shortcutLabel(shortcut.accelerator, process.platform)}${
      shortcuts.enabled && !shortcut.registered ? ' — in use by another app' : ''
    }`,
    enabled: false,
  });
  const { update } = context;
  const updateItem: MenuItemConstructorOptions = {
    label: update.label,
    enabled: update.enabled,
    click: () => {
      if (update.action === 'check') actions.checkForUpdates();
      else if (update.action === 'install') actions.installUpdate();
      else if (update.action === 'open-download-page') actions.openUpdateDownloadPage();
    },
  };

  const template: MenuItemConstructorOptions[] = [
    ...(update.prominent ? [updateItem, { type: 'separator' as const }] : []),
    {
      label: windowVisible ? 'Hide overlay' : 'Show overlay',
      ...accelerator(shortcuts.toggle),
      click: () => actions.toggleWindow(),
    },
    {
      label: 'Lock (click-through)',
      type: 'checkbox',
      checked: settings.locked,
      ...accelerator(shortcuts.lock),
      click: (item) => actions.setLocked(item.checked),
    },
    { label: 'Refresh now', click: () => actions.refresh() },
    { type: 'separator' },
    {
      label: 'Source',
      submenu: SOURCE_ITEMS.map(({ mode, label }) => ({
        label,
        type: 'radio' as const,
        checked: settings.source === mode,
        click: () => actions.setSource(mode),
      })),
    },
    // Claude Code renews its own sign-in when it starts (the overlay never does, D3).
    ...(context.statusKind === 'token-expired' || context.statusKind === 'no-credentials'
      ? [{ label: 'Open Claude Code', click: () => actions.openClaudeCode() }]
      : []),
    { type: 'separator' },
    { label: 'Compact mode', type: 'checkbox', checked: settings.compact, click: (item) => actions.setCompact(item.checked) },
    {
      label: 'Compact mode shows',
      submenu: [
        { label: 'Current session (always)', type: 'checkbox', checked: true, enabled: false },
        ...context.weeklyMeters.map(({ id, label }): MenuItemConstructorOptions => ({
          label,
          type: 'checkbox',
          checked: !settings.compactHidden.includes(id),
          click: (item) => actions.setCompactMeterVisible(id, item.checked),
        })),
      ],
    },
    { label: 'Show account', type: 'checkbox', checked: settings.showAccount, click: (item) => actions.setShowAccount(item.checked) },
    { label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop, click: (item) => actions.setAlwaysOnTop(item.checked) },
    {
      label: 'Size',
      submenu: SCALE_OPTIONS.map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: 'radio' as const,
        checked: settings.scale === value,
        click: () => actions.setScale(value),
      })),
    },
    {
      label: 'Opacity',
      submenu: OPACITY_OPTIONS.map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: 'radio' as const,
        checked: Math.abs(settings.opacity - value) < 0.01,
        click: () => actions.setOpacity(value),
      })),
    },
    {
      label: 'Theme',
      submenu: THEME_ITEMS.map(({ theme, label }) => ({
        label,
        type: 'radio' as const,
        checked: settings.theme === theme,
        click: () => actions.setTheme(theme),
      })),
    },
    {
      label: 'Refresh every',
      submenu: REFRESH_INTERVAL_OPTIONS_SEC.map((seconds) => ({
        label: `${seconds / 60} min`,
        type: 'radio' as const,
        checked: settings.refreshIntervalSec === seconds,
        click: () => actions.setRefreshInterval(seconds),
      })),
    },
  ];

  if (displays.length > 1) {
    template.push({
      label: 'Move to display',
      submenu: displays.map((display, index) => ({
        label: `Display ${index + 1} — ${display.size.width}×${display.size.height}${display.id === primaryId ? ' (primary)' : ''}`,
        click: () => actions.moveToDisplay(display.id),
      })),
    });
  }

  template.push(
    { label: 'Reset position', click: () => actions.resetPosition() },
    { type: 'separator' },
    {
      label: 'Notifications',
      submenu: [
        ...NOTIFY_THRESHOLDS.map(
          (threshold): MenuItemConstructorOptions => ({
            label: threshold === 100 ? 'When a limit is reached (100%)' : `At ${threshold}%`,
            type: 'checkbox',
            checked: settings.notifyAt.includes(threshold),
            enabled: notificationsSupported,
            click: (item) => actions.setNotifyAt(threshold, item.checked),
          }),
        ),
        {
          label: 'When a limit resets (after 75%+)',
          type: 'checkbox',
          checked: settings.notifyReset,
          enabled: notificationsSupported,
          click: (item) => actions.setNotifyReset(item.checked),
        },
        { type: 'separator' },
        notificationsSupported
          ? { label: 'Send a test notification', click: () => actions.testNotification() }
          : { label: 'Not supported on this system', enabled: false },
      ],
    },
    {
      label: 'Keyboard shortcuts',
      submenu: [
        {
          label: 'Global shortcuts',
          type: 'checkbox',
          checked: settings.shortcutsEnabled,
          click: (item) => actions.setShortcutsEnabled(item.checked),
        },
        { type: 'separator' },
        shortcutInfo('Show / hide', shortcuts.toggle),
        shortcutInfo('Lock / unlock', shortcuts.lock),
      ],
    },
    {
      label: loginItemAvailable ? 'Launch at login' : 'Launch at login (installed app only)',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      enabled: loginItemAvailable,
      click: (item) => actions.setLaunchAtLogin(item.checked),
    },
    { label: 'Open settings folder', click: () => actions.openSettingsFolder() },
    { label: 'Open logs folder', click: () => actions.openLogsFolder() },
    ...(update.prominent ? [] : [updateItem]),
    { label: `About Claude Usage v${app.getVersion()}`, click: () => actions.showAbout() },
    { type: 'separator' },
    { label: 'Quit Claude Usage', click: () => actions.quit() },
  );

  return Menu.buildFromTemplate(template);
}
