// The context menu, shared by the tray icon, the overlay's ⋯ button and right-click.
import { Menu, app, screen, type MenuItemConstructorOptions } from 'electron';
import type { SourceMode, StatusKind } from '../shared/types';
import { OPACITY_OPTIONS, REFRESH_INTERVAL_OPTIONS_SEC, type Settings } from './settings';

const SOURCE_ITEMS: ReadonlyArray<{ mode: SourceMode; label: string }> = [
  { mode: 'auto', label: 'Auto — Claude Code, then Claude Desktop' },
  { mode: 'claude-code', label: 'Claude Code only' },
  { mode: 'claude-desktop', label: 'Claude Desktop only' },
];

export interface MenuActions {
  toggleWindow(): void;
  refresh(): void;
  setCompact(compact: boolean): void;
  setCompactMeterVisible(id: string, visible: boolean): void;
  setAlwaysOnTop(on: boolean): void;
  setOpacity(opacity: number): void;
  setRefreshInterval(seconds: number): void;
  moveToDisplay(displayId: number): void;
  resetPosition(): void;
  setLaunchAtLogin(on: boolean): void;
  setSource(mode: SourceMode): void;
  openClaudeCode(): void;
  openSettingsFolder(): void;
  openLogsFolder(): void;
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
}

export function buildMenu(settings: Readonly<Settings>, context: MenuContext, actions: MenuActions): Menu {
  const { windowVisible, loginItemAvailable } = context;
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;

  const template: MenuItemConstructorOptions[] = [
    { label: windowVisible ? 'Hide overlay' : 'Show overlay', click: () => actions.toggleWindow() },
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
    { label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop, click: (item) => actions.setAlwaysOnTop(item.checked) },
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
      label: loginItemAvailable ? 'Launch at login' : 'Launch at login (installed app only)',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      enabled: loginItemAvailable,
      click: (item) => actions.setLaunchAtLogin(item.checked),
    },
    { label: 'Open settings folder', click: () => actions.openSettingsFolder() },
    { label: 'Open logs folder', click: () => actions.openLogsFolder() },
    { label: `About Claude Usage v${app.getVersion()}`, click: () => actions.showAbout() },
    { type: 'separator' },
    { label: 'Quit Claude Usage', click: () => actions.quit() },
  );

  return Menu.buildFromTemplate(template);
}
