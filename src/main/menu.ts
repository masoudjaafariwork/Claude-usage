// The context menu, shared by the tray icon, the overlay's ⋯ button and right-click.
import { Menu, app, nativeImage, screen, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { ClaudeCodeAction } from '../shared/format';
import type { SourceMode } from '../shared/types';
import type { AccountMenuEntry } from './claude-accounts';
import { NOTIFY_THRESHOLDS } from './notifications-core';
import { OPACITY_OPTIONS, REFRESH_INTERVAL_OPTIONS_SEC, SCALE_OPTIONS, type Settings, type ThemeSetting } from './settings';
import { shortcutLabel, type ShortcutState, type ShortcutsStatus } from './shortcuts-core';
import { dotPng } from './tray-icon';
import type { UpdateMenuItem } from './update-core';
import type { DesktopChoice, DesktopMenuEntry } from './virtual-desktops-core';

let updateDot: NativeImage | null = null;

/** The coral dot beside "Restart to update" — the same dot as on the ⋯ button and the tray icon (D56). */
function updateDotIcon(): NativeImage {
  if (!updateDot) {
    updateDot = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
      const size = 16 * scaleFactor;
      updateDot.addRepresentation({ scaleFactor, width: size, height: size, buffer: dotPng(size) });
    }
  }
  return updateDot;
}

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

/**
 * What the menu items do. Items about one window (its account, view and position) act on the window
 * whose menu it is — or, in the tray menu while several windows are open, on all of them.
 */
export interface MenuActions {
  toggleWindow(): void;
  /** Close this window (Phase 7; only offered while another window is open). */
  closeWindow(): void;
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
  /** Show the window on one virtual desktop, or on all of them (null) (Phase 10). */
  setDesktop(choice: DesktopChoice | null): void;
  setLaunchAtLogin(on: boolean): void;
  setSource(mode: SourceMode): void;
  /** Show another Claude Code account in this window: an added config folder, or null for the default one. */
  setClaudeCodeDir(dir: string | null): void;
  /** Open a window of its own for an account, or close that window (Phase 7). */
  setAccountWindow(dir: string | null, open: boolean): void;
  addClaudeCodeDir(): void;
  removeClaudeCodeDir(dir: string): void;
  setNotifyAt(threshold: number, on: boolean): void;
  setNotifyReset(on: boolean): void;
  testNotification(): void;
  setShortcutsEnabled(on: boolean): void;
  /** Open Claude Code for an account whose sign-in is missing or expired, so it renews it (D34). */
  openClaudeCode(dir: string | null): void;
  /** Sign an account in through Claude Code (`claude auth login` in a terminal, Phase 8). */
  signIn(dir: string | null): void;
  /** Install Claude Code (Anthropic's installer, after a dialog), then sign that account in. */
  installClaudeCode(dir: string | null): void;
  /** A new account: a new config folder, signed in through Claude Code, in a window of its own. */
  addAccountBySignIn(): void;
  /** Let Claude Code renew expired sign-ins in the background. */
  setAutoRenew(on: boolean): void;
  openSettingsFolder(): void;
  openLogsFolder(): void;
  checkForUpdates(): void;
  installUpdate(): void;
  openUpdateDownloadPage(): void;
  showAbout(): void;
  /** Start the app again (the one-click fix when the overlay stopped showing up, D60). */
  restart(): void;
  quit(): void;
}

export interface MenuContext {
  /** Some window can be seen on this (virtual) desktop: the first item says *Hide*, else *Show*. */
  windowVisible: boolean;
  /** How many overlay windows are open (one per account, Phase 7). */
  windowCount: number;
  /**
   * 'window': the menu of one window (⋯ button, right-click; the tray while there is one window).
   * 'all': the tray menu while several windows are open.
   */
  scope: 'window' | 'all';
  /** Compact mode of that window, or of every window. */
  compact: boolean;
  /** Launch at login works only in the packaged app. */
  loginItemAvailable: boolean;
  /** Weekly limits in the current data, offered as compact-pill toggles. */
  weeklyMeters: ReadonlyArray<{ id: string; label: string }>;
  /** The default Claude Code account and the added config folders (claude-accounts.ts). */
  accounts: readonly AccountMenuEntry[];
  /** Accounts whose sign-in needs the user: Open Claude Code, Sign in or Install (Phase 8), each with its label. */
  claudeCodeActions: ReadonlyArray<{ dir: string | null; action: ClaudeCodeAction; label: string }>;
  /** Accounts whose background renewal stopped (unexpected answer from Claude Code), by short label. */
  renewStopped: readonly string[];
  shortcuts: ShortcutsStatus;
  notificationsSupported: boolean;
  /** The updates item: at the top when there is something to do, else next to About. */
  update: UpdateMenuItem;
  /** *Show on desktop* ▸ (virtual-desktops-core.ts builds the entries). */
  desktops: { title: string; entries: readonly DesktopMenuEntry[] };
}

/** Shows a working global shortcut next to its menu item (the menu doesn't register it again). */
function accelerator(shortcut: ShortcutState): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> {
  return shortcut.registered ? { accelerator: shortcut.accelerator, registerAccelerator: false } : {};
}

/**
 * *Claude Code account*: in a window's menu, radio items switch that window (an account shown in
 * another window can't be picked) and *Open in its own window* opens one for an account without a
 * window; in the tray menu with several windows, a checkbox per account opens or closes its window.
 */
function accountItems(context: MenuContext, actions: MenuActions): MenuItemConstructorOptions[] {
  if (context.scope === 'all') {
    return context.accounts.map((entry) => ({
      label: entry.label,
      type: 'checkbox',
      checked: entry.hasWindow,
      enabled: !entry.hasWindow || context.windowCount > 1, // the last window can only be hidden
      click: (item) => actions.setAccountWindow(entry.dir, item.checked),
    }));
  }
  const withoutWindow = context.accounts.filter((entry) => !entry.hasWindow);
  return [
    ...context.accounts.map(
      (entry): MenuItemConstructorOptions => ({
        label: entry.hasWindow && !entry.selected ? `${entry.label} (in its own window)` : entry.label,
        type: 'radio',
        checked: entry.selected,
        enabled: entry.selected || !entry.hasWindow,
        click: () => actions.setClaudeCodeDir(entry.dir),
      }),
    ),
    ...(withoutWindow.length > 0
      ? [
          { type: 'separator' as const },
          {
            label: 'Open in its own window',
            submenu: withoutWindow.map(({ dir, label }) => ({ label, click: () => actions.setAccountWindow(dir, true) })),
          },
        ]
      : []),
  ];
}

export function buildMenu(settings: Readonly<Settings>, context: MenuContext, actions: MenuActions): Menu {
  const { windowVisible, loginItemAvailable, shortcuts, notificationsSupported } = context;
  const several = context.windowCount > 1;
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
    ...(update.prominent ? { icon: updateDotIcon() } : {}),
    click: () => {
      if (update.action === 'check') actions.checkForUpdates();
      else if (update.action === 'install') actions.installUpdate();
      else if (update.action === 'open-download-page') actions.openUpdateDownloadPage();
    },
  };
  const added = context.accounts.flatMap(({ dir, label }) => (dir === null ? [] : [{ dir, label }]));

  const template: MenuItemConstructorOptions[] = [
    ...(update.prominent ? [updateItem, { type: 'separator' as const }] : []),
    {
      label: `${windowVisible ? 'Hide' : 'Show'} ${several ? 'overlays' : 'overlay'}`,
      ...accelerator(shortcuts.toggle),
      click: () => actions.toggleWindow(),
    },
    ...(context.scope === 'window' && several ? [{ label: 'Close this window', click: () => actions.closeWindow() }] : []),
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
    {
      label: 'Claude Code account',
      submenu: [
        ...accountItems(context, actions),
        { type: 'separator' },
        { label: 'Add account (sign in)…', click: () => actions.addAccountBySignIn() },
        { label: 'Add folder…', click: () => actions.addClaudeCodeDir() },
        ...(added.length > 0
          ? [
              {
                label: 'Remove folder',
                submenu: added.map(({ dir, label }) => ({ label, click: () => actions.removeClaudeCodeDir(dir) })),
              },
            ]
          : []),
        { type: 'separator' },
        // Claude Code renews its own sign-in; the overlay only runs it (D3, Phase 8).
        { label: 'Renew sign-in automatically', type: 'checkbox', checked: settings.autoRenew, click: (item) => actions.setAutoRenew(item.checked) },
        ...context.renewStopped.map((who) => ({ label: `Renewal stopped for ${who} — see the log`, enabled: false })),
      ],
    },
    // Sign-ins that need the user: always through their own Claude Code (D3, D28).
    ...context.claudeCodeActions.map(({ dir, action, label }) => ({
      label,
      click: () => (action === 'open' ? actions.openClaudeCode(dir) : action === 'sign-in' ? actions.signIn(dir) : actions.installClaudeCode(dir)),
    })),
    { type: 'separator' },
    { label: 'Compact mode', type: 'checkbox', checked: context.compact, click: (item) => actions.setCompact(item.checked) },
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
    {
      label: context.desktops.title,
      submenu: context.desktops.entries.map((entry): MenuItemConstructorOptions => {
        if (entry.kind === 'separator') return { type: 'separator' };
        if (entry.kind === 'note') return { label: entry.label, enabled: false };
        return { label: entry.label, type: 'radio', checked: entry.checked, click: () => actions.setDesktop(entry.choice) };
      }),
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
    { label: 'Restart Claude Usage', click: () => actions.restart() },
    { label: 'Quit Claude Usage', click: () => actions.quit() },
  );

  return Menu.buildFromTemplate(template);
}
