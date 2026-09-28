// Entry point of the Electron main process: wires settings, the overlay windows (one per Claude
// Code account the user opened, overlay.ts), the tray icon, the menu and IPC together.
//
// Dev flags:
//   --mock[=scenario]      fake data (scenarios in mock.ts), separate userData directory
//   --screenshot=<file>    render, save a PNG of the overlay to <file> (more windows: <file>-2.png …), then quit
//   --compact / --expanded override the view mode for this run
//   --theme=<system|dark|light>, --scale=<0.9|1|1.15|1.3|1.5> override theme and size (screenshots)
//   --keep-occlusion       Windows: leave Chromium's window occlusion tracker on (to test the
//                          blank-overlay watchdog, D60)
// User option:
//   --claude-config-dir=<folder|default>  show that Claude Code account (config folder): its own
//                          window if it has one, else the main window switches to it; a running copy
//                          does the same (claude-accounts.ts)
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Menu,
} from 'electron';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeCodeAction } from '../shared/format';
import {
  accountLogName,
  accountMenuEntries,
  accountShortLabel,
  accountStateKey,
  chooseFolder,
  claudeCodeLocation,
  configDirArg,
  nextAccountFolder,
  normalizeFolder,
  type ClaudeCodeLocation,
} from './claude-accounts';
import {
  CLAUDE_CODE_SETUP_URL,
  INSTALL_COMMANDS,
  findClaudeBinary,
  findLinuxTerminal,
  planTerminalJob,
  runLaunchPlan,
  type TerminalFacts,
} from './claude-code-launcher';
import {
  MIN_RENEWAL_VERSION,
  RENEWAL_ARGS,
  RENEW_TIMEOUT_MS,
  parseClaudeVersion,
  readClaudeVersion,
  renewalEnv,
  renewalResult,
  runHidden,
  usagePathClash,
  versionAtLeast,
  type RenewalResult,
} from './claude-code-renewal';
import { accountInfo, parseClaudeCodeAccount, readClaudeCodeAccount, readCredentials, type ClaudeCodeAccount } from './credentials';
import { DesktopSource, desktopDataDirs, readDesktopHistory, watchDesktopHistory } from './desktop-source';
import { AttemptBudget, describeProcessGone, isCleanExit, relaunchOptions } from './recovery-core';
import { RotatingLog, describeError } from './log';
import { createLoginItem } from './login-item';
import { reconcileLoginItem } from './login-item-core';
import { buildMenu, type MenuActions } from './menu';
import { MOCK_SCENARIOS, createMockSource, isMockScenario, type MockScenario, type MockSetup } from './mock';
import { Notifier } from './notifications';
import { Overlay, type OverlayHost, type OverlaySetup } from './overlay';
import { DEFAULT_WINDOW, SCALE_OPTIONS, SettingsStore, THEMES, type ThemeSetting } from './settings';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { shortcutLabel, type ShortcutsStatus } from './shortcuts-core';
import { loadSnapshot } from './snapshot-cache';
import { TrayController } from './tray';
import { updateMode, type UpdateMenuItem } from './update-core';
import { Updater } from './updater';
import { fetchUsageJson } from './usage-api';
import { ClaudeCodeSource } from './usage-source';
import { APP_ICON_PATH, arrangeOnDisplay } from './window';

interface CliOptions {
  mock: MockScenario | null;
  screenshot: string | null;
  compact: boolean | null;
  theme: ThemeSetting | null;
  scale: number | null;
  keepOcclusion: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mock: null, screenshot: null, compact: null, theme: null, scale: null, keepOcclusion: false };
  for (const arg of argv) {
    if (arg === '--mock') options.mock = 'normal';
    else if (arg === '--keep-occlusion') options.keepOcclusion = true;
    else if (arg.startsWith('--mock=')) {
      const scenario = arg.slice('--mock='.length);
      if (isMockScenario(scenario)) options.mock = scenario;
      else console.warn(`Unknown mock scenario "${scenario}". Options: ${MOCK_SCENARIOS.join(', ')}`);
    } else if (arg.startsWith('--screenshot=')) options.screenshot = resolve(arg.slice('--screenshot='.length));
    else if (arg === '--compact') options.compact = true;
    else if (arg === '--expanded') options.compact = false;
    else if (arg.startsWith('--theme=')) {
      const theme = arg.slice('--theme='.length) as ThemeSetting;
      if (THEMES.includes(theme)) options.theme = theme;
    } else if (arg.startsWith('--scale=')) {
      const scale = SCALE_OPTIONS.find((option) => option === Number(arg.slice('--scale='.length)));
      if (scale !== undefined) options.scale = scale;
    }
  }
  return options;
}

const cli = parseArgs(process.argv.slice(1));

/** Windows AppUserModelId; must equal build.appId in package.json (installer shortcuts use it). */
const APP_ID = 'com.masoudjaafari.claude-usage';

// Mock runs get their own settings/cache so they never touch real data (and can run side by side).
if (cli.mock) app.setPath('userData', join(app.getPath('userData'), 'mock-data'));

// Windows: Chromium's native window occlusion tracker decides when a window is fully covered — by
// another window, a full-screen capture overlay, the lock screen, a switched-off display — and then
// hides the page and stops drawing it. When the "uncovered" step goes missing (seen twice after the
// Snipping Tool's Win+Shift+S overlay), the overlay stays invisible although the window is shown,
// and nothing but a restart brings it back. An always-on-top overlay gains nothing from the
// tracker, so it is switched off (D60). Must be set before the app is ready.
if (process.platform === 'win32' && !cli.keepOcclusion) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start, (err: unknown) => {
    console.error(err);
    app.exit(1);
  });
}

/** Menu items that act on the window whose menu it is, or on all windows (menuFor below). */
type WindowAction = 'closeWindow' | 'refresh' | 'setCompact' | 'setClaudeCodeDir' | 'addClaudeCodeDir' | 'moveToDisplay' | 'resetPosition';

/** How long a sign-in for a new account may take before its empty folder is removed again. */
const NEW_ACCOUNT_WAIT_MS = 15 * 60_000;

function start(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  const userData = app.getPath('userData');
  // Electron's logs folder: userData/logs on Windows and Linux, ~/Library/Logs/Claude Usage on macOS.
  // Mock runs keep theirs next to their own userData.
  app.setAppLogsPath(cli.mock ? join(userData, 'logs') : undefined);
  const log = new RotatingLog(app.getPath('logs'));
  const settings = new SettingsStore(join(userData, 'settings.json'), !cli.screenshot);
  if (cli.theme) settings.update({ theme: cli.theme });
  if (cli.scale) settings.update({ scale: cli.scale });
  // Sets prefers-color-scheme for the overlay page; styles.css switches its colours with it.
  nativeTheme.themeSource = settings.get().theme;

  // Dev, mock and screenshot runs never touch the OS login items.
  const loginItem = createLoginItem(app.isPackaged && !cli.mock && !cli.screenshot, APP_ID);
  if (loginItem.available) {
    try {
      const wanted = settings.get().launchAtLogin;
      const { launchAtLogin, register } = reconcileLoginItem(wanted, loginItem.state());
      if (register) loginItem.set(true);
      if (launchAtLogin !== wanted) settings.update({ launchAtLogin });
    } catch (err) {
      log.error(`Launch at login sync failed: ${describeError(err)}`);
    }
  }

  // Several Claude Code accounts (Phase 6): the default one plus config folders added from the menu
  // or with --claude-config-dir. Each open window shows one of them (Phase 7).
  const home = homedir();
  const startDir = folderFromArgs(process.argv.slice(1), process.cwd());
  // An account's launch script sets CLAUDE_CONFIG_DIR for its own VS Code and passes it to us with
  // --claude-config-dir too. The option names the account; the inherited variable would also turn
  // the default account into that folder (and reach Open Claude Code's terminal), so drop it.
  if (startDir !== undefined) delete process.env.CLAUDE_CONFIG_DIR;
  const locationOf = (dir: string | null): ClaudeCodeLocation => claudeCodeLocation(dir, process.platform, process.env, home);
  const defaultLocation = locationOf(null);
  const accountStateDir = (dir: string) => join(userData, 'accounts', accountStateKey(dir, process.platform));
  /** An account's own files: cached snapshot, pace history, notification records (mock runs: memory only). */
  const accountFile = (dir: string | null, name: string): string | null =>
    cli.mock ? null : dir === null ? join(userData, name) : join(accountStateDir(dir), name);
  /** Every account as its `.claude.json` says (null key = the default account): menu and card. */
  const accounts = new Map<string | null, ClaudeCodeAccount | null>();

  const userAgent = `ClaudeUsage/${app.getVersion()} (${process.platform}; Electron ${process.versions.electron})`;
  const desktopDirs = desktopDataDirs(process.platform, process.env, home);
  let mock: MockSetup | null = null;
  /** Mock runs: pretend an update is ready (`update-ready` scenario), so the dot can be screenshotted. */
  let mockUpdate: UpdateMenuItem | null = null;
  if (cli.mock) {
    mock = createMockSource(cli.mock);
    // Scenarios decide the accounts and windows too, so folders picked in an earlier mock run don't
    // carry over (a window keeps its position when its account comes back).
    const extra = mock.extraWindows.map((w) => w.folder);
    const folders = [...(mock.folder ? [mock.folder] : []), ...extra];
    const before = settings.get().windows;
    settings.update({
      source: mock.mode,
      locked: mock.locked,
      claudeCodeDirs: folders.map((folder) => folder.dir),
      windows: [mock.folder?.dir ?? null, ...extra.map((folder) => folder.dir)].map((account) => ({
        ...DEFAULT_WINDOW,
        ...before.find((w) => w.account === account),
        account,
      })),
    });
    for (const folder of folders) accounts.set(folder.dir, folder.account);
    if (mock.updateReady) mockUpdate = { label: 'Restart to update to v9.9.9', enabled: true, action: null, prominent: true };
  }
  const compact = cli.compact;
  if (compact !== null) settings.update({ windows: settings.get().windows.map((w) => ({ ...w, compact })) });
  // --claude-config-dir at start: that account's window, or the main window shows it (as in Phase 6).
  if (startDir !== undefined) {
    const account = resolveAccount(startDir);
    const { windows } = settings.get();
    if (!windows.some((w) => w.account === account)) settings.update({ windows: windows.map((w, i) => (i === 0 ? { ...w, account } : w)) });
  }
  log.info(
    `Claude Usage ${app.getVersion()} starting (${process.platform}, Electron ${process.versions.electron}, ` +
      `${app.isPackaged ? 'installed' : 'dev'}${cli.mock ? `, mock=${cli.mock}` : ''}, source=${settings.get().source}, ` +
      `windows=${settings.get().windows.map((w) => accountLogName(w.account, process.platform)).join(' + ')})`,
  );

  /** The open overlay windows, one per account; the first is the main window. */
  const overlays: Overlay[] = [];
  let quitting = false;
  let screenLocked = false;
  let shortcuts: ShortcutsStatus = {
    enabled: false,
    toggle: { accelerator: settings.get().toggleShortcut, registered: false },
    lock: { accelerator: settings.get().lockShortcut, registered: false },
  };
  // Crash loops: windows are rebuilt after a GPU death at most 3 times in 10 minutes; the app
  // restarts itself for a blank overlay at most once per 30 minutes (D60).
  const rebuildBudget = new AttemptBudget(3, 10 * 60_000);
  const relaunchBudget = new AttemptBudget(1, 30 * 60_000);

  // Notices that belong to no account (updates, the test notification); each window's account has
  // its own Notifier with its own records (overlay.ts).
  const notices = new Notifier({ file: null, onClick: () => showAll(), log: log.write });
  // Updates from GitHub Releases (installed builds only; dev, mock and screenshot runs never update).
  const updater = new Updater({
    mode: updateMode({
      packaged: app.isPackaged,
      devRun: Boolean(cli.mock || cli.screenshot),
      platform: process.platform,
      env: process.env,
    }),
    currentVersion: app.getVersion(),
    log: log.write,
    onChange: () => broadcast(), // the overlay shows a dot while an update waits (D56)
    notify: (notice) => notices.show(notice, notice.opensDownloadPage ? () => updater.openDownloadPage() : undefined),
    openUrl: (url) => void shell.openExternal(url),
    beforeInstall: () => settings.flush(),
    onAppImageMoved: (path) => {
      process.env.APPIMAGE = path;
      try {
        if (loginItem.available && settings.get().launchAtLogin) loginItem.set(true);
      } catch (err) {
        log.error(`Launch at login update failed: ${describeError(err)}`);
      }
    },
  });

  const host: OverlayHost = {
    settings,
    log,
    mock: Boolean(cli.mock),
    screenshot: Boolean(cli.screenshot),
    home,
    locationOf,
    accountFile,
    accountInfo: (account) => accountInfo(accounts.get(account) ?? null),
    notificationLabel: (account) => (overlays.length > 1 ? shortLabel(account) : null),
    otherBounds: (overlay) => overlays.filter((o) => o !== overlay && !o.win.isDestroyed()).map((o) => o.win.getBounds()),
    canClose: () => overlays.length > 1,
    updateReady: () => (mockUpdate ?? updater.menuItem).prominent,
    unlockShortcut: () => (shortcuts.lock.registered ? shortcutLabel(shortcuts.lock.accelerator, process.platform) : null),
    isQuitting: () => quitting,
    isScreenLocked: () => screenLocked,
    changed: () => updateTray(),
    showMenu: (overlay) => menuFor(overlay).popup({ window: overlay.win }),
    requestClose: (overlay) => closeWindow(overlay, 'window closed'),
    setScale: (scale) => actions.setScale(scale),
    showAll: () => showAll(),
    credentialsChanged: () => void readAccounts(),
    claudeCodeInstalled: () => claudeBinary() !== null,
    renewSignIn: (overlay, started) => renewSignIn(overlay, started),
    shownFirstTime: () => {
      updateTray();
      if (cli.screenshot) captureOnce(cli.screenshot);
    },
    blankAfterRebuild: () => {
      if (!relaunchBudget.take()) {
        log.error('Still blank after a rebuild; not restarting again within 30 min (menu → Restart Claude Usage)');
        return;
      }
      log.warn('Restarting the app');
      relaunchApp();
    },
  };

  /** The sources and starting data of a window's account (mock runs: the scenario's). */
  function setupFor(account: string | null, show: boolean): OverlaySetup {
    if (mock) {
      const extra = mock.extraWindows.find((w) => w.folder.dir === account);
      if (extra) return { account, show, sources: () => extra.sources, initialSnapshot: null };
      const { sources, initialSnapshot, history } = mock;
      return { account, show, sources: () => sources, initialSnapshot, initialHistory: history };
    }
    const cache = accountFile(account, 'last-usage.json');
    return {
      account,
      show,
      sources: (overlay) => ({
        'claude-code': new ClaudeCodeSource({
          readCredentials: () => readCredentials(overlay.location),
          fetchUsage: (token) => fetchUsageJson(token, userAgent, log.write),
          readAccount: () => readClaudeCodeAccount(overlay.location),
          now: Date.now,
        }),
        'claude-desktop': new DesktopSource({
          readHistory: () => readDesktopHistory(desktopDirs),
          claudeCodeAccount: () => readClaudeCodeAccount(overlay.location),
          orgMatch: () => (overlay.account !== null ? 'strict' : settings.get().source === 'auto' ? 'if-known' : 'off'),
          now: Date.now,
        }),
      }),
      initialSnapshot: cache ? loadSnapshot(cache) : null,
    };
  }

  function addOverlay(account: string | null, show: boolean): Overlay {
    const overlay = new Overlay(host, setupFor(account, show));
    overlays.push(overlay);
    overlay.start();
    return overlay;
  }

  const actions: Omit<MenuActions, WindowAction> = {
    toggleWindow: () => toggleAll(),
    setCompactMeterVisible: (id, visible) => {
      const others = settings.get().compactHidden.filter((hidden) => hidden !== id);
      settings.update({ compactHidden: visible ? others : [...others, id] });
      broadcast();
    },
    setShowAccount: (on) => {
      settings.update({ showAccount: on });
      broadcast();
    },
    setLocked: (on) => {
      settings.update({ locked: on });
      for (const overlay of overlays) overlay.applyLocked(on);
      log.info(on ? 'Locked (click-through)' : 'Unlocked');
      showAll();
      broadcast();
    },
    setAlwaysOnTop: (on) => {
      settings.update({ alwaysOnTop: on });
      for (const overlay of overlays) overlay.applyAlwaysOnTop(on);
      updateTray();
    },
    setScale: (scale) => {
      if (scale === settings.get().scale) return;
      settings.update({ scale });
      for (const overlay of overlays) overlay.applyScale(scale);
      updateTray();
    },
    setOpacity: (opacity) => {
      settings.update({ opacity });
      for (const overlay of overlays) overlay.holdHover(); // the menu opens over the overlay: show the new value right away
      broadcast();
    },
    setTheme: (theme) => {
      settings.update({ theme });
      nativeTheme.themeSource = theme;
      updateTray();
    },
    setRefreshInterval: (seconds) => {
      settings.update({ refreshIntervalSec: seconds });
      for (const overlay of overlays) overlay.service.reschedule();
      updateTray();
    },
    restart: () => {
      log.info('Restart from the menu');
      relaunchApp();
    },
    setLaunchAtLogin: (on) => {
      let actual = on;
      try {
        loginItem.set(on);
        actual = loginItem.state() === 'on';
      } catch (err) {
        log.error(`Launch at login failed: ${describeError(err)}`);
        actual = !on;
      }
      settings.update({ launchAtLogin: actual });
      updateTray();
    },
    setSource: (mode) => {
      if (mode === settings.get().source) return;
      settings.update({ source: mode });
      log.info(`Source mode → ${mode}`);
      broadcast();
      for (const overlay of overlays) overlay.service.sourcesChanged();
    },
    setAccountWindow: (dir, open) => {
      if (open) openWindow(dir);
      else {
        const overlay = overlays.find((o) => o.account === dir);
        if (overlay) closeWindow(overlay, 'menu');
      }
    },
    removeClaudeCodeDir: (dir) => {
      const shown = overlays.find((o) => o.account === dir);
      if (shown && overlays.length > 1) closeWindow(shown, 'folder removed');
      else if (shown) switchAccount(shown, null);
      settings.update({ claudeCodeDirs: settings.get().claudeCodeDirs.filter((d) => d !== dir) });
      accounts.delete(dir);
      // Its cached snapshot, pace history and notification records go with it.
      if (!cli.mock) rmSync(accountStateDir(dir), { recursive: true, force: true });
      log.info('Claude Code account folder removed');
      updateTray();
    },
    setNotifyAt: (threshold, on) => {
      const others = settings.get().notifyAt.filter((t) => t !== threshold);
      settings.update({ notifyAt: on ? [...others, threshold] : others });
      updateTray();
    },
    setNotifyReset: (on) => {
      settings.update({ notifyReset: on });
      updateTray();
    },
    testNotification: () => notices.test(),
    setShortcutsEnabled: (on) => {
      settings.update({ shortcutsEnabled: on });
      applyShortcuts();
      broadcast();
    },
    openClaudeCode: (dir) => overlays.find((o) => o.account === dir)?.openClaudeCode(),
    signIn: (dir) => {
      const overlay = overlays.find((o) => o.account === dir);
      if (overlay) void signIn(overlay);
    },
    installClaudeCode: (dir) => {
      const overlay = overlays.find((o) => o.account === dir);
      if (overlay) void installFor(overlay);
    },
    addAccountBySignIn: () => void addAccountBySignIn(),
    setAutoRenew: (on) => {
      // Turning it on again also gives accounts whose renewal stopped another try.
      settings.update({ autoRenew: on, renewStopped: on ? [] : settings.get().renewStopped });
      log.info(`Renew sign-in automatically → ${on ? 'on' : 'off'}`);
      if (on) for (const overlay of overlays) overlay.maybeRenew();
      updateTray();
    },
    openSettingsFolder: () => void shell.openPath(userData),
    openLogsFolder: () => {
      mkdirSync(log.dir, { recursive: true });
      void shell.openPath(log.dir);
    },
    checkForUpdates: () => updater.checkNow(),
    installUpdate: () => updater.install(),
    openUpdateDownloadPage: () => updater.openDownloadPage(),
    showAbout: () => void showAbout(),
    quit: () => app.quit(),
  };

  /**
   * The menu of one window (its ⋯ button, a right-click, or the tray while there is one window) —
   * or, for `null`, the tray menu while several windows are open: then the window items (compact
   * mode, refresh, position) act on all of them, and the account list opens and closes windows.
   */
  function menuFor(target: Overlay | null): Menu {
    const scoped = target ? [target] : overlays;
    const current = settings.get();
    const weekly = new Map<string, { id: string; label: string }>();
    for (const overlay of scoped) {
      for (const meter of overlay.service.snapshot?.meters ?? []) if (meter.group === 'weekly' && !weekly.has(meter.id)) weekly.set(meter.id, meter);
    }
    const claudeCodeActions = scoped.flatMap((o) => {
      const { status, claudeCode } = o.state();
      const action = claudeCodeAction(status, claudeCode);
      if (!action) return [];
      const label = { open: 'Open Claude Code', 'sign-in': 'Sign in to Claude Code…', install: 'Install Claude Code…' }[action];
      return [{ dir: o.account, action, label: target ? label : `${label} — ${shortLabel(o.account)}` }];
    });
    return buildMenu(
      current,
      {
        windowVisible: overlays.some((o) => o.isVisible()),
        windowCount: overlays.length,
        scope: target ? 'window' : 'all',
        compact: scoped.every((o) => o.view.compact),
        loginItemAvailable: loginItem.available,
        weeklyMeters: [...weekly.values()],
        accounts: accountMenuEntries({
          dirs: current.claudeCodeDirs,
          selected: target ? target.account : undefined,
          windows: overlays.map((o) => o.account),
          defaultDir: defaultLocation.dir,
          emailOf: (dir) => accounts.get(dir)?.email ?? null,
          showEmail: current.showAccount,
          home,
          platform: process.platform,
        }),
        claudeCodeActions,
        renewStopped: current.renewStopped.map((stop) => shortLabel(stop.account)),
        shortcuts,
        notificationsSupported: notices.supported,
        update: mockUpdate ?? updater.menuItem,
      },
      {
        ...actions,
        closeWindow: () => {
          if (target) closeWindow(target, 'menu');
        },
        refresh: () => scoped.forEach((o) => o.refresh()),
        setCompact: (on) => {
          for (const overlay of scoped) overlay.setCompact(on);
          updateTray();
        },
        setClaudeCodeDir: (dir) => {
          if (target) switchAccount(target, dir);
        },
        addClaudeCodeDir: () => void addClaudeCodeDir(target),
        moveToDisplay: (displayId) => {
          const display = screen.getAllDisplays().find((d) => d.id === displayId);
          if (display && target) target.moveToDisplay(display);
          else if (display) arrangeOnDisplay(overlays.map((o) => o.win), display);
          showAll();
        },
        resetPosition: () => {
          if (target) target.resetPosition();
          else arrangeOnDisplay(overlays.map((o) => o.win), screen.getPrimaryDisplay());
          showAll();
        },
      },
    );
  }

  const tray = new TrayController(() => toggleAll());

  function updateTray(): void {
    tray.update(
      overlays.map((o) => ({ state: o.state(), who: shortLabel(o.account) })),
      (mockUpdate ?? updater.menuItem).prominent,
      menuFor(overlays.length === 1 ? (overlays[0] ?? null) : null),
    );
  }

  function broadcast(): void {
    for (const overlay of overlays) overlay.send();
    updateTray();
  }

  function applyShortcuts(): void {
    const current = settings.get();
    shortcuts = registerShortcuts(
      // Screenshot runs never grab keys (they may run next to the real app).
      { enabled: current.shortcutsEnabled && !cli.screenshot, toggle: current.toggleShortcut, lock: current.lockShortcut },
      { toggle: () => toggleAll(), lock: () => actions.setLocked(!settings.get().locked) },
      log.write,
    );
  }
  applyShortcuts();

  // --- Windows (one per account, Phase 7) --------------------------------------------------------
  /** Shows every overlay window (tray click, shortcut, a notification, lock, …). */
  function showAll(): void {
    const hidden = overlays.filter((o) => !o.isVisible());
    if (hidden.length === 0) return;
    for (const overlay of hidden) overlay.show();
    log.info('Overlay shown');
    updateTray();
  }

  /** Show / hide: all windows together. */
  function toggleAll(): void {
    if (!overlays.some((o) => o.isVisible())) {
      showAll();
      return;
    }
    for (const overlay of overlays) overlay.hide();
    log.info('Overlay hidden');
    updateTray();
  }

  /** Opens a window of its own for an account, next to the others (or shows the one it has). */
  function openWindow(account: string | null): void {
    if (!overlays.some((o) => o.account === account)) {
      settings.update({ windows: [...settings.get().windows, { ...DEFAULT_WINDOW, account }] });
      const overlay = addOverlay(account, true);
      log.info(`[${overlay.logName}] Overlay window opened`);
      broadcast(); // the others get their close button
    }
    showAll();
  }

  /** Closes one account's window for good (× button, menu, Alt+F4) — the last one is only hidden. */
  function closeWindow(overlay: Overlay, how: string): void {
    if (overlays.length <= 1) {
      overlay.hide();
      log.info(`Overlay hidden (${how})`);
      updateTray();
      return;
    }
    overlays.splice(overlays.indexOf(overlay), 1);
    overlay.dispose();
    settings.update({ windows: settings.get().windows.filter((w) => w.account !== overlay.account) });
    log.info(`[${overlay.logName}] Overlay window closed (${how})`);
    broadcast(); // with one window left, it loses its close button
  }

  // --- Claude Code accounts -----------------------------------------------------------------------
  /** --claude-config-dir from a command line: an existing folder, null for the default, else undefined. */
  function folderFromArgs(argv: readonly string[], cwd: string): string | null | undefined {
    const dir = configDirArg(argv, cwd, process.platform);
    if (typeof dir === 'string' && !existsSync(dir)) {
      log.warn('--claude-config-dir: that folder does not exist; ignored');
      return undefined;
    }
    return dir;
  }

  /** The account a folder stands for (null = the default one); a new folder is added to the list. */
  function resolveAccount(dir: string | null): string | null {
    const { claudeCodeDirs, account } = chooseFolder(settings.get().claudeCodeDirs, dir, defaultLocation.dir, process.platform);
    settings.update({ claudeCodeDirs });
    return account;
  }

  /**
   * Shows another account (an added config folder, or null for the default one) in `overlay`,
   * adding the folder when it is new. An account that has a window of its own is shown there instead.
   */
  function switchAccount(overlay: Overlay, dir: string | null): void {
    const account = resolveAccount(dir);
    if (overlays.some((o) => o !== overlay && o.account === account)) {
      showAll();
      updateTray();
      return;
    }
    overlay.switchAccount(account);
    updateTray();
    void readAccounts();
  }

  /**
   * Menu → Add folder…: a folder picker, with a warning when the folder has no Claude Code files.
   * From a window's menu the window shows it; from the tray (several windows) it gets its own window.
   */
  async function addClaudeCodeDir(target: Overlay | null): Promise<void> {
    const result = await dialog.showOpenDialog({
      title: 'Add a Claude Code config folder',
      message: 'Choose the folder that CLAUDE_CONFIG_DIR points to for that account.',
      buttonLabel: 'Add folder',
      defaultPath: home,
      properties: ['openDirectory', 'showHiddenFiles', 'dontAddToRecent'],
    });
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (!picked) return;
    const dir = normalizeFolder(picked, process.platform);
    if (!['.claude.json', '.credentials.json'].some((name) => existsSync(join(dir, name)))) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Claude Usage',
        message: 'No Claude Code sign-in in this folder',
        detail:
          `${dir} has no .claude.json or .credentials.json.\n\n` +
          'Pick the folder that CLAUDE_CONFIG_DIR is set to for that account, or sign in to Claude Code ' +
          'with that folder first.',
        buttons: ['Add anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    if (target && overlays.includes(target)) switchAccount(target, dir);
    else {
      openWindow(resolveAccount(dir));
      void readAccounts();
    }
  }

  /** Reads every account's `.claude.json` (no secrets) for the menu and the cards (mock runs: none). */
  async function readAccounts(): Promise<void> {
    if (cli.mock) return;
    const dirs = [null, ...settings.get().claudeCodeDirs];
    const read = await Promise.all(dirs.map((dir) => readClaudeCodeAccount(locationOf(dir))));
    dirs.forEach((dir, i) => accounts.set(dir, read[i] ?? null));
    broadcast();
  }

  /** An account where space is tight (tray tooltip, notifications, menu items): e-mail or folder. */
  function shortLabel(account: string | null): string {
    const email = accounts.get(account)?.email ?? overlays.find((o) => o.account === account)?.service.snapshot?.account?.email ?? null;
    return accountShortLabel(account, email, settings.get().showAccount, home, process.platform);
  }

  // --- Signing in through Claude Code, installing it, renewing its sign-in (Phase 8) ----------------
  // Always the user's own, unmodified Claude Code: the overlay never offers a login of its own, never
  // sees a password or session, and never refreshes or writes a token (D3, D28).
  const openExternal = (url: string) => shell.openExternal(url);
  /** A found Claude Code, looked up again after 5 s (the card asks with every state it gets). */
  let claudeLookup: { at: number; path: string | null } | null = null;
  function claudeBinary(fresh = false): string | null {
    if (mock) return mock.claudeCode.installed ? 'claude' : null;
    if (fresh || !claudeLookup || Date.now() - claudeLookup.at > 5000) {
      claudeLookup = { at: Date.now(), path: findClaudeBinary({ platform: process.platform, env: process.env, home }) };
    }
    return claudeLookup.path;
  }

  function terminalFacts(configDir: string | null): TerminalFacts {
    return { platform: process.platform, home, configDir, tempDir: tmpdir(), linuxTerminal: findLinuxTerminal(process.platform, process.env) };
  }

  /** Linux without a known terminal emulator: say what to run instead. */
  async function noTerminal(command: string): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Claude Usage',
      message: 'No terminal program found',
      detail: `Claude Usage opens x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal or xterm, and none of them is installed. Run this in a terminal yourself:\n\n    ${command}`,
      buttons: ['OK', 'Open setup page'],
      noLink: true,
    });
    if (response === 1) void openExternal(CLAUDE_CODE_SETUP_URL);
  }

  /**
   * *Sign in* (banner, menu): a terminal runs `claude auth login` for this window's account; Claude
   * Code opens the browser and stores the sign-in where the overlay reads it (watched meanwhile).
   * Without a Claude Code, the Install dialog comes first.
   */
  async function signIn(overlay: Overlay): Promise<void> {
    if (mock) return void log.info('Sign in: not started in mock runs');
    const claude = claudeBinary(true);
    if (!claude) return installFor(overlay);
    const known = await readClaudeCodeAccount(overlay.location);
    // The default account is Claude Code's own: signing in there changes it for VS Code and the terminals too.
    if (overlay.account === null && known !== null) {
      const who = known.email ?? 'the same account';
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Claude Usage',
        message: 'Sign in to Claude Code again?',
        detail:
          `This signs in Claude Code itself on this computer — the sign-in that VS Code and your terminals use too. ` +
          `Sign in with ${who} to keep that account; another Claude account would replace it there as well.\n\n` +
          'To see another account next to this one, use Claude Code account → Add account (sign in)… instead.',
        buttons: ['Sign in', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return;
    }
    const plan = planTerminalJob(terminalFacts(overlay.account === null ? null : overlay.location.dir), { kind: 'sign-in', claude, email: known?.email ?? null });
    if (!plan) return noTerminal('claude auth login');
    const terminal = await runLaunchPlan(plan, `[${overlay.logName}] Sign in`, openExternal, log.write);
    overlay.watchSignIn(plan.kind === 'spawn' && plan.waits ? terminal : null);
  }

  /** *Install Claude Code* for a window's account: installer, then its sign-in, watched like *Sign in*. */
  async function installFor(overlay: Overlay): Promise<void> {
    if (mock) return void log.info('Install Claude Code: not started in mock runs');
    const terminal = await installClaudeCode(overlay.account === null ? null : overlay.location.dir, `[${overlay.logName}]`);
    if (terminal !== 'cancelled') overlay.watchSignIn(terminal);
  }

  /**
   * Explains, then (on OK) opens a terminal that runs Anthropic's official installer and signs the
   * installed Claude Code in (for `configDir`, null = the default account). Nothing is installed
   * without the user's click, and nothing is bundled. Returns the terminal's process when its exit
   * means the window was closed (Windows), null when that can't be told, 'cancelled' otherwise.
   */
  async function installClaudeCode(configDir: string | null, tag: string): Promise<ChildProcess | null | 'cancelled'> {
    const windows = process.platform === 'win32';
    const command = windows ? INSTALL_COMMANDS.windows : INSTALL_COMMANDS.unix;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Install Claude Code',
      message: 'Install Claude Code to sign in',
      detail: [
        "Claude Usage shows your limits through Claude Code, Anthropic's coding tool — it never signs in by itself.",
        '',
        "A terminal window will run Anthropic's official installer:",
        '',
        `    ${command}`,
        '',
        `It installs Claude Code for your user, without admin rights (into ${windows ? '%USERPROFILE%\\.local\\bin' : '~/.local/bin'}). ` +
          'Then Claude Code opens your browser: sign in to your Claude account there.',
        '',
        "Claude Code needs a Pro, Max, Team or Enterprise plan; the free plan doesn't include it.",
      ].join('\n'),
      buttons: ['Install', 'Open setup page', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 1) void openExternal(CLAUDE_CODE_SETUP_URL);
    if (response !== 0) return 'cancelled';
    const plan = planTerminalJob(terminalFacts(configDir), { kind: 'install' });
    if (!plan) {
      await noTerminal(command);
      return 'cancelled';
    }
    const terminal = await runLaunchPlan(plan, `${tag} Install Claude Code`, openExternal, log.write);
    claudeLookup = null;
    return plan.kind === 'spawn' && plan.waits ? terminal : null;
  }

  /** The new account of *Add account (sign in)…* while its sign-in runs (one at a time). */
  let pendingAccount: { dir: string; deadline: number; timer: NodeJS.Timeout } | null = null;

  /**
   * *Add account (sign in)…*: the app makes a new config folder (nextAccountFolder), Claude Code
   * signs in with it in a terminal, and once it has, the account is added and gets a window of its
   * own (Phase 7). A folder left without a sign-in is removed again.
   */
  async function addAccountBySignIn(): Promise<void> {
    if (mock) return void log.info('Add account (sign in): not started in mock runs');
    if (pendingAccount) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Claude Usage',
        message: 'A sign-in is already open',
        detail: 'Finish the sign-in for the new account in its terminal window (or close that window) first.',
        buttons: ['OK'],
      });
      return;
    }
    const dir = nextAccountFolder(home, settings.get().claudeCodeDirs, process.platform, existsSync);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error(`Add account: could not create its folder: ${describeError(err)}`);
      return;
    }
    const tag = '[new account]';
    const claude = claudeBinary(true);
    let terminal: ChildProcess | null;
    if (claude) {
      const plan = planTerminalJob(terminalFacts(dir), { kind: 'sign-in', claude, email: null });
      if (!plan) {
        removeUnusedFolder(dir);
        return noTerminal(`CLAUDE_CONFIG_DIR="${dir}" claude auth login`);
      }
      const child = await runLaunchPlan(plan, `${tag} Sign in`, openExternal, log.write);
      terminal = plan.kind === 'spawn' && plan.waits ? child : null;
    } else {
      const installed = await installClaudeCode(dir, tag);
      if (installed === 'cancelled') return removeUnusedFolder(dir);
      terminal = installed;
    }
    const pending = { dir, deadline: Date.now() + NEW_ACCOUNT_WAIT_MS, timer: setInterval(() => checkNewAccount(false), 2000) };
    pendingAccount = pending;
    terminal?.on('exit', () => setTimeout(() => checkNewAccount(true), 3000)); // Claude Code may still be writing
  }

  /** The new account signed in → add it and open its window; closed / timed out without → remove its folder. */
  function checkNewAccount(terminalClosed: boolean): void {
    const pending = pendingAccount;
    if (!pending) return;
    const signedIn = signedInThere(pending.dir);
    if (!signedIn && !terminalClosed && Date.now() < pending.deadline) return;
    clearInterval(pending.timer);
    pendingAccount = null;
    if (!signedIn) {
      removeUnusedFolder(pending.dir);
      log.info(`New account: no sign-in (${terminalClosed ? 'its terminal was closed' : 'nothing after 15 min'}); its folder was removed again`);
      return;
    }
    const account = resolveAccount(pending.dir);
    log.info(`[${accountLogName(account, process.platform)}] New account signed in`);
    openWindow(account);
    void readAccounts();
  }

  /** Claude Code has signed in with this config folder (its account file names the account; macOS keeps the token in the Keychain). */
  function signedInThere(dir: string): boolean {
    let accountText = '';
    try {
      accountText = readFileSync(join(dir, '.claude.json'), 'utf8');
    } catch {
      // no account file yet
    }
    return existsSync(join(dir, '.credentials.json')) || parseClaudeCodeAccount(accountText) !== null;
  }

  /** Removes a folder made for a new account, unless Claude Code signed in there after all. */
  function removeUnusedFolder(dir: string): void {
    if (signedInThere(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`Could not remove an unused account folder: ${describeError(err)}`);
    }
  }

  // Background renewal: claude-code-renewal.ts explains why `/usage` never reaches the model.
  /** Working folder of the hidden runs: the app's own, so no project's settings apply. */
  const renewalCwd = join(userData, 'claude-code-runs');
  /** Claude Code versions by binary (path + modification time): `claude --version` once per binary. */
  const claudeVersions = new Map<string, string | null>();
  /** Config folders a hidden run is going on for. */
  const renewingDirs = new Set<string>();
  const loggedOnce = new Set<string>();
  const logOnce = (key: string, level: 'info' | 'warn', line: string) => {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log.write(level, line);
  };

  async function claudeVersion(claude: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    let key = claude;
    try {
      key += `|${statSync(claude).mtimeMs}`;
    } catch {
      return null;
    }
    if (!claudeVersions.has(key)) claudeVersions.set(key, await readClaudeVersion(claude, env));
    return claudeVersions.get(key) ?? null;
  }

  async function renewSignIn(overlay: Overlay, started: () => void): Promise<RenewalResult | null> {
    if (mock) {
      if (!mock.claudeCode.renewing) return null;
      started();
      return new Promise<never>(() => {}); // the `renewing` scenario: renewing for good
    }
    if (cli.screenshot) return null;
    const account = overlay.account;
    const tag = `[${overlay.logName}]`;
    const runDir = overlay.location.dir;
    const configDir = account === null ? null : runDir;
    const claude = claudeBinary(true);
    if (!claude || !net.isOnline() || renewingDirs.has(runDir)) return null;
    const env = renewalEnv(process.env, configDir);
    const version = await claudeVersion(claude, env);
    const parsed = version === null ? null : parseClaudeVersion(version);
    if (version === null || !parsed || !versionAtLeast(parsed, MIN_RENEWAL_VERSION)) {
      logOnce(`old:${version}`, 'info', `Claude Code ${version ?? '(unknown version)'} is older than ${MIN_RENEWAL_VERSION.join('.')}: no background renewal with it — update Claude Code`);
      return null;
    }
    const stop = settings.get().renewStopped.find((s) => s.account === account);
    if (stop?.claudeVersion === version) return null;
    mkdirSync(renewalCwd, { recursive: true });
    if (usagePathClash(renewalCwd, process.platform, existsSync)) {
      logOnce('clash', 'warn', 'A file or folder named "usage" at the root of the drive would turn /usage into a prompt: no background renewal');
      return null;
    }
    renewingDirs.add(runDir);
    log.info(`${tag} Sign-in expired: letting Claude Code ${version} renew it (its local /usage command, hidden)`);
    started();
    const startedAt = Date.now();
    try {
      const run = await runHidden(claude, RENEWAL_ARGS, { cwd: renewalCwd, env, timeoutMs: RENEW_TIMEOUT_MS, platform: process.platform });
      const result = renewalResult(run);
      const took = `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
      if (result.kind === 'renewed') log.info(`${tag} Renewal: Claude Code answered with its usage in ${took}`);
      else if (result.kind === 'no-usage') log.warn(`${tag} Renewal: Claude Code ran /usage but had no plan usage to show — its sign-in didn't renew`);
      else if (result.kind === 'signed-out') log.warn(`${tag} Renewal: Claude Code says the account isn't signed in ("${result.excerpt}") — sign in again`);
      else if (result.kind === 'failed') log.warn(`${tag} Renewal didn't run through: ${result.detail}`);
      else {
        log.error(
          `${tag} Renewal: unexpected answer from Claude Code ${version} ("${result.excerpt}"); background renewal stopped for this ` +
            'account until Claude Code is updated or Renew sign-in automatically is switched on again',
        );
        settings.update({ renewStopped: [...settings.get().renewStopped.filter((s) => s.account !== account), { account, claudeVersion: version }] });
        updateTray();
      }
      return result;
    } finally {
      renewingDirs.delete(runDir);
    }
  }

  // --- IPC (only accepted from our own overlay pages; routed to the window that sent it) ------------
  const overlayOf = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    overlays.find((o) => !o.win.isDestroyed() && event.sender === o.win.webContents);

  ipcMain.handle('state:get', (event) => overlayOf(event)?.state() ?? null);
  ipcMain.on('usage:refresh', (event) => overlayOf(event)?.refresh());
  ipcMain.on('view:set-compact', (event, on: unknown) => {
    const overlay = overlayOf(event);
    if (!overlay || typeof on !== 'boolean') return;
    overlay.setCompact(on);
    updateTray();
  });
  ipcMain.on('menu:show', (event) => {
    const overlay = overlayOf(event);
    if (overlay) menuFor(overlay).popup({ window: overlay.win });
  });
  ipcMain.on('window:close', (event) => {
    const overlay = overlayOf(event);
    if (overlay && overlays.length > 1) closeWindow(overlay, 'close button');
  });
  ipcMain.on('claude-code:open', (event) => overlayOf(event)?.openClaudeCode());
  ipcMain.on('claude-code:sign-in', (event) => {
    const overlay = overlayOf(event);
    if (overlay) void signIn(overlay);
  });
  ipcMain.on('claude-code:install', (event) => {
    const overlay = overlayOf(event);
    if (overlay) void installFor(overlay);
  });
  ipcMain.on('page:visibility', (event, hidden: unknown) => {
    const overlay = overlayOf(event);
    if (overlay && typeof hidden === 'boolean') overlay.pageVisibility(hidden);
  });
  ipcMain.on('window:resize', (event, width: unknown, height: unknown) => {
    const overlay = overlayOf(event);
    if (overlay && typeof width === 'number' && typeof height === 'number') overlay.resized(width, height);
  });

  // --- Displays, helper processes, power ----------------------------------------------------------
  // One log line per burst: a monitor change fires 'display-metrics-changed' several times in a row.
  let displaysLogTimer: NodeJS.Timeout | null = null;
  const onDisplaysChanged = (what: string) => () => {
    if (displaysLogTimer) clearTimeout(displaysLogTimer);
    displaysLogTimer = setTimeout(() => log.info(`Displays changed (${what}): ${screen.getAllDisplays().length} display(s)`), 1000);
    for (const overlay of overlays) overlay.ensureOnScreen();
    updateTray();
  };
  screen.on('display-added', onDisplaysChanged('added'));
  screen.on('display-removed', onDisplaysChanged('removed'));
  screen.on('display-metrics-changed', onDisplaysChanged('metrics'));

  // A helper process died. Chromium starts a new GPU process itself, but a transparent window can
  // stay blank afterwards: rebuild the overlay windows. Other helpers are only logged.
  app.on('child-process-gone', (_event, details) => {
    if (quitting || isCleanExit(details)) return;
    log.warn(describeProcessGone(details.type, details));
    if (details.type !== 'GPU') return;
    if (!rebuildBudget.take()) {
      log.error('The GPU process keeps dying; not rebuilding the overlay windows again');
      return;
    }
    setTimeout(() => {
      for (const overlay of overlays) overlay.recreateWindow('the GPU process died');
    }, 1000);
  });

  /** Starts the app again and quits; a downloaded update is installed on the way (it restarts too). */
  function relaunchApp(): void {
    if (updater.menuItem.action === 'install') {
      updater.install();
      return;
    }
    app.relaunch(relaunchOptions(process.env, process.platform));
    app.quit();
  }

  // Claude Desktop rewrites its history about every 15 min; pick new samples up right away.
  const stopWatchingDesktop = cli.mock
    ? () => {}
    : watchDesktopHistory(desktopDirs, () => {
        for (const overlay of overlays) overlay.service.desktopHistoryChanged();
      });

  // Timers are unreliable across sleep; refresh once the network is likely back.
  const refreshSoon = () =>
    setTimeout(() => {
      for (const overlay of overlays) overlay.refresh();
    }, 5000);
  powerMonitor.on('resume', refreshSoon);
  powerMonitor.on('unlock-screen', refreshSoon);
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
    log.info('Screen locked');
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    log.info('Screen unlocked');
  });

  // Started again (e.g. from an account's own .bat with --claude-config-dir): that account's window,
  // or the main window switches to it; then everything shows.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const dir = folderFromArgs(argv, workingDirectory);
    const main = overlays[0];
    if (dir !== undefined && main) switchAccount(main, dir);
    showAll();
  });
  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });
  app.on('before-quit', () => {
    quitting = true;
    log.info('Quitting');
    if (pendingAccount) {
      // A new account's sign-in still open: keep the account if it got signed in, else its folder goes.
      clearInterval(pendingAccount.timer);
      const { dir } = pendingAccount;
      pendingAccount = null;
      if (signedInThere(dir)) resolveAccount(dir);
      else removeUnusedFolder(dir);
    }
    stopWatchingDesktop();
    for (const overlay of overlays) overlay.stop();
    updater.stop();
    settings.flush();
    tray.destroy();
  });
  app.on('will-quit', () => unregisterShortcuts());

  // Screenshot runs: every window is captured once the first one has been shown.
  let captureStarted = false;
  function captureOnce(file: string): void {
    if (captureStarted) return;
    captureStarted = true;
    void captureAndQuit(() => overlays.map((o) => o.win), file);
  }

  for (const { account } of settings.get().windows) addOverlay(account, true);
  updateTray();
  updater.start();
  void readAccounts();
}

async function showAbout(): Promise<void> {
  await dialog.showMessageBox({
    type: 'none',
    title: 'About Claude Usage',
    message: `Claude Usage ${app.getVersion()}`,
    detail: [
      'Always-on-top overlay for your Claude plan usage limits.',
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      '',
      'License: MIT. Not affiliated with Anthropic.',
    ].join('\n'),
    icon: nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 64, height: 64, quality: 'best' }),
    buttons: ['OK'],
  });
}

/** Saves every window to a PNG: the first to `file`, the others to `<file>-2.png`, `<file>-3.png` … */
async function captureAndQuit(windows: () => BrowserWindow[], file: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500)); // let data arrive and animations settle
  for (const [i, win] of windows().entries()) {
    const target = i === 0 ? file : file.replace(/(\.png)?$/i, `-${i + 1}.png`);
    try {
      const image = await win.webContents.capturePage();
      await writeFile(target, image.toPNG());
      console.log(`Screenshot saved to ${target}`);
    } catch (err) {
      console.error('Screenshot failed:', err);
    }
  }
  app.exit(0);
}
