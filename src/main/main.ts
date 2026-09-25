// Entry point of the Electron main process: wires settings, the usage service, the overlay
// window, the tray icon and IPC together.
//
// Dev flags:
//   --mock[=scenario]      fake data (scenarios in mock.ts), separate userData directory
//   --screenshot=<file>    render, save a PNG of the overlay to <file>, then quit
//   --compact / --expanded override the view mode for this run
//   --theme=<system|dark|light>, --scale=<0.9|1|1.15|1.3|1.5> override theme and size (screenshots)
// User option:
//   --claude-config-dir=<folder|default>  show that Claude Code account (config folder); a running
//                          copy switches to it (claude-accounts.ts)
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppState, SourceId, UsageSnapshot } from '../shared/types';
import {
  accountMenuEntries,
  accountStateKey,
  chooseFolder,
  claudeCodeLocation,
  configDirArg,
  normalizeFolder,
  type ClaudeCodeLocation,
} from './claude-accounts';
import { gatherLaunchFacts, launchClaudeCode, planClaudeCodeLaunch } from './claude-code-launcher';
import { accountInfo, readClaudeCodeAccount, readCredentials, type ClaudeCodeAccount } from './credentials';
import { DesktopSource, desktopDataDirs, readDesktopHistory, watchDesktopHistory } from './desktop-source';
import { watchFileInDirs } from './file-watch';
import { RotatingLog, describeError } from './log';
import { createLoginItem } from './login-item';
import { reconcileLoginItem } from './login-item-core';
import { buildMenu, type MenuActions } from './menu';
import { MOCK_SCENARIOS, createMockSource, isMockScenario, type MockScenario } from './mock';
import { Notifier } from './notifications';
import { UsageHistory, type HistoryPoint } from './pace';
import { SCALE_OPTIONS, SettingsStore, THEMES, stepScale, type ThemeSetting } from './settings';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { shortcutLabel, type ShortcutsStatus } from './shortcuts-core';
import { loadSnapshot, saveSnapshot } from './snapshot-cache';
import { TrayController } from './tray';
import { updateMode } from './update-core';
import { Updater } from './updater';
import { fetchUsageJson } from './usage-api';
import { UsageService } from './usage-service';
import { ClaudeCodeSource, type UsageSource } from './usage-source';
import {
  APP_ICON_PATH,
  applyAlwaysOnTop,
  applyLocked,
  createOverlayWindow,
  ensureOnScreen,
  fitToContent,
  moveToDisplay,
  resetPosition,
} from './window';

interface CliOptions {
  mock: MockScenario | null;
  screenshot: string | null;
  compact: boolean | null;
  theme: ThemeSetting | null;
  scale: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mock: null, screenshot: null, compact: null, theme: null, scale: null };
  for (const arg of argv) {
    if (arg === '--mock') options.mock = 'normal';
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start, (err: unknown) => {
    console.error(err);
    app.exit(1);
  });
}

function start(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  const userData = app.getPath('userData');
  // Electron's logs folder: userData/logs on Windows and Linux, ~/Library/Logs/Claude Usage on macOS.
  // Mock runs keep theirs next to their own userData.
  app.setAppLogsPath(cli.mock ? join(userData, 'logs') : undefined);
  const log = new RotatingLog(app.getPath('logs'));
  const settings = new SettingsStore(join(userData, 'settings.json'), !cli.screenshot);
  if (cli.compact !== null) settings.update({ compact: cli.compact });
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
  // or with --claude-config-dir; one is shown at a time.
  const home = homedir();
  const startDir = folderFromArgs(process.argv.slice(1), process.cwd());
  // An account's launch script sets CLAUDE_CONFIG_DIR for its own VS Code and passes it to us with
  // --claude-config-dir too. The option names the account; the inherited variable would also turn
  // the default account into that folder (and reach Open Claude Code's terminal), so drop it.
  if (startDir !== undefined) delete process.env.CLAUDE_CONFIG_DIR;
  const locationOf = (dir: string | null): ClaudeCodeLocation => claudeCodeLocation(dir, process.platform, process.env, home);
  const defaultLocation = locationOf(null);
  if (startDir !== undefined) settings.update(chooseFolder(settings.get().claudeCodeDirs, startDir, defaultLocation.dir, process.platform));
  let location = locationOf(settings.get().claudeCodeDir);
  const accountStateDir = (dir: string) => join(userData, 'accounts', accountStateKey(dir, process.platform));
  /** The shown account's own files: cached snapshot, pace history, notification records. */
  const accountFile = (name: string) => {
    const dir = settings.get().claudeCodeDir;
    return dir === null ? join(userData, name) : join(accountStateDir(dir), name);
  };
  /** Every account as its `.claude.json` says (null key = the default account): menu and card. */
  const accounts = new Map<string | null, ClaudeCodeAccount | null>();

  const userAgent = `ClaudeUsage/${app.getVersion()} (${process.platform}; Electron ${process.versions.electron})`;
  const desktopDirs = desktopDataDirs(process.platform, process.env, home);
  let sources: Record<SourceId, UsageSource>;
  let initialSnapshot: UsageSnapshot | null;
  let initialHistory: HistoryPoint[] = [];
  if (cli.mock) {
    const mock = createMockSource(cli.mock);
    sources = mock.sources;
    initialSnapshot = mock.initialSnapshot;
    initialHistory = mock.history;
    // Scenarios decide the account too, so a folder picked in an earlier mock run doesn't carry over.
    settings.update({
      source: mock.mode,
      locked: mock.locked,
      claudeCodeDirs: mock.folder ? [mock.folder.dir] : [],
      claudeCodeDir: mock.folder?.dir ?? null,
    });
    if (mock.folder) accounts.set(mock.folder.dir, mock.folder.account);
  } else {
    sources = {
      'claude-code': new ClaudeCodeSource({
        readCredentials: () => readCredentials(location),
        fetchUsage: (token) => fetchUsageJson(token, userAgent, log.write),
        readAccount: () => readClaudeCodeAccount(location),
        now: Date.now,
      }),
      'claude-desktop': new DesktopSource({
        readHistory: () => readDesktopHistory(desktopDirs),
        claudeCodeAccount: () => readClaudeCodeAccount(location),
        orgMatch: () => (settings.get().claudeCodeDir !== null ? 'strict' : settings.get().source === 'auto' ? 'if-known' : 'off'),
        now: Date.now,
      }),
    };
    initialSnapshot = loadSnapshot(accountFile('last-usage.json'));
  }
  log.info(
    `Claude Usage ${app.getVersion()} starting (${process.platform}, Electron ${process.versions.electron}, ` +
      `${app.isPackaged ? 'installed' : 'dev'}${cli.mock ? `, mock=${cli.mock}` : ''}, source=${settings.get().source}, ` +
      `account=${accountLogName()})`,
  );
  const service = new UsageService(
    { sources, mode: () => settings.get().source, intervalSec: () => settings.get().refreshIntervalSec, log: log.write },
    initialSnapshot,
  );
  // Claude Desktop rewrites its history about every 15 min; pick new samples up right away.
  const stopWatchingDesktop = cli.mock ? () => {} : watchDesktopHistory(desktopDirs, () => service.desktopHistoryChanged());
  // Claude Code rewrites its credentials file when it renews its token: recover in seconds, not 60 s.
  // `/login` rewrites it too, so the menu's e-mails are read again.
  const watchCredentials = () =>
    cli.mock
      ? () => {}
      : watchFileInDirs([location.dir], '.credentials.json', () => {
          service.credentialsChanged();
          void readAccounts();
        });
  let stopWatchingCredentials = watchCredentials();
  let lastClaudeCodeLaunch = 0;
  // Snapshot history for the pace forecast (last 24 h, per account; mock runs keep theirs in memory).
  let history = new UsageHistory(cli.mock ? null : accountFile('usage-history.json'), initialHistory);
  let forecast: Record<string, string> = {};
  const notifier = new Notifier({
    file: cli.mock ? null : accountFile('notifications.json'),
    onClick: () => showOverlay(),
    log: log.write,
  });
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
    onChange: () => updateTray(),
    notify: (notice) => notifier.show(notice, notice.opensDownloadPage ? () => updater.openDownloadPage() : undefined),
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
  let shortcuts: ShortcutsStatus = {
    enabled: false,
    toggle: { accelerator: settings.get().toggleShortcut, registered: false },
    lock: { accelerator: settings.get().lockShortcut, registered: false },
  };

  const { win, restoredPosition } = createOverlayWindow(settings.get());
  // Chromium remembers a zoom level per page (userData/Preferences) and prefers it to
  // webPreferences.zoomFactor, so apply the Size setting again as soon as the page is committed.
  win.webContents.on('did-navigate', () => win.webContents.setZoomFactor(settings.get().scale));
  let quitting = false;
  let shown = false;
  /** Last content size reported by the renderer, in CSS pixels (the window needs it × zoom factor). */
  let contentSize: { width: number; height: number } | null = null;
  /** True while the user drags the overlay (Windows; see the 'will-move' handler). */
  let dragging = false;

  const state = (): AppState => {
    const current = settings.get();
    return {
      snapshot: service.snapshot,
      status: service.status,
      refreshing: service.refreshing,
      view: {
        compact: current.compact,
        opacity: current.opacity,
        compactHidden: current.compactHidden,
        locked: current.locked,
        unlockShortcut: shortcuts.lock.registered ? shortcutLabel(shortcuts.lock.accelerator, process.platform) : null,
        showAccount: current.showAccount,
      },
      sourceMode: current.source,
      selectedAccount: accountInfo(accounts.get(current.claudeCodeDir) ?? null),
      addedAccount: current.claudeCodeDir !== null,
      forecast: service.status.kind === 'ok' ? forecast : {},
    };
  };

  const showOverlay = () => {
    if (!win.isVisible()) actions.toggleWindow();
  };

  const actions: MenuActions = {
    toggleWindow: () => {
      if (win.isVisible()) win.hide();
      else win.showInactive();
      updateTray();
    },
    refresh: () => service.refreshNow(),
    setCompact: (compact) => {
      settings.update({ compact });
      broadcast();
    },
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
      applyLocked(win, on);
      log.info(on ? 'Locked (click-through)' : 'Unlocked');
      showOverlay();
      broadcast();
    },
    setAlwaysOnTop: (on) => {
      settings.update({ alwaysOnTop: on });
      applyAlwaysOnTop(win, on);
      updateTray();
    },
    setScale: (scale) => {
      if (scale === settings.get().scale) return;
      settings.update({ scale });
      win.webContents.setZoomFactor(scale);
      fit(true);
      updateTray();
    },
    setOpacity: (opacity) => {
      settings.update({ opacity });
      broadcast();
    },
    setTheme: (theme) => {
      settings.update({ theme });
      nativeTheme.themeSource = theme;
      updateTray();
    },
    setRefreshInterval: (seconds) => {
      settings.update({ refreshIntervalSec: seconds });
      service.reschedule();
      updateTray();
    },
    moveToDisplay: (displayId) => {
      const display = screen.getAllDisplays().find((d) => d.id === displayId);
      if (display) moveToDisplay(win, display);
      showOverlay();
    },
    resetPosition: () => {
      resetPosition(win);
      showOverlay();
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
      service.sourcesChanged();
    },
    setClaudeCodeDir: (dir) => switchAccount(dir),
    addClaudeCodeDir: () => void addClaudeCodeDir(),
    removeClaudeCodeDir: (dir) => {
      if (settings.get().claudeCodeDir === dir) switchAccount(null);
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
    testNotification: () => notifier.test(),
    setShortcutsEnabled: (on) => {
      settings.update({ shortcutsEnabled: on });
      applyShortcuts();
      broadcast();
    },
    openClaudeCode: () => {
      if (Date.now() - lastClaudeCodeLaunch < 5000) return; // a double click opens one window, not two
      lastClaudeCodeLaunch = Date.now();
      const addedFolder = settings.get().claudeCodeDir === null ? null : location.dir;
      const plan = planClaudeCodeLaunch(gatherLaunchFacts(process.platform, process.env, home, addedFolder, tmpdir()));
      launchClaudeCode(plan, (url) => shell.openExternal(url), log.write).catch((err: unknown) =>
        log.warn(`Open Claude Code failed: ${describeError(err)}`),
      );
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

  const menu = () =>
    buildMenu(
      settings.get(),
      {
        windowVisible: win.isVisible(),
        loginItemAvailable: loginItem.available,
        weeklyMeters: (service.snapshot?.meters ?? []).filter((m) => m.group === 'weekly'),
        accounts: accountMenuEntries({
          dirs: settings.get().claudeCodeDirs,
          selected: settings.get().claudeCodeDir,
          defaultDir: defaultLocation.dir,
          emailOf: (dir) => accounts.get(dir)?.email ?? null,
          showEmail: settings.get().showAccount,
          home,
          platform: process.platform,
        }),
        statusKind: service.status.kind,
        shortcuts,
        notificationsSupported: notifier.supported,
        update: updater.menuItem,
      },
      actions,
    );
  const tray = new TrayController(() => actions.toggleWindow());

  function updateTray(): void {
    tray.update(state(), menu());
  }

  function broadcast(): void {
    if (!win.isDestroyed()) win.webContents.send('state:changed', state());
    updateTray();
  }

  function applyShortcuts(): void {
    const current = settings.get();
    shortcuts = registerShortcuts(
      // Screenshot runs never grab keys (they may run next to the real app).
      { enabled: current.shortcutsEnabled && !cli.screenshot, toggle: current.toggleShortcut, lock: current.lockShortcut },
      { toggle: () => actions.toggleWindow(), lock: () => actions.setLocked(!settings.get().locked) },
      log.write,
    );
  }
  applyShortcuts();

  // --- Claude Code accounts -----------------------------------------------------------------------
  function accountLogName(): string {
    return settings.get().claudeCodeDir === null ? 'default' : 'added folder';
  }

  /** --claude-config-dir from a command line: an existing folder, null for the default, else undefined. */
  function folderFromArgs(argv: readonly string[], cwd: string): string | null | undefined {
    const dir = configDirArg(argv, cwd, process.platform);
    if (typeof dir === 'string' && !existsSync(dir)) {
      log.warn('--claude-config-dir: that folder does not exist; ignored');
      return undefined;
    }
    return dir;
  }

  /**
   * Shows another account (an added config folder, or null for the default one), adding the folder
   * when it is new. Everything that belongs to an account follows: sign-in, credentials watch, cached
   * snapshot, pace history and notification records.
   */
  function switchAccount(dir: string | null): void {
    const before = settings.get().claudeCodeDir;
    settings.update(chooseFolder(settings.get().claudeCodeDirs, dir, defaultLocation.dir, process.platform));
    if (settings.get().claudeCodeDir === before) {
      updateTray();
      return;
    }
    location = locationOf(settings.get().claudeCodeDir);
    stopWatchingCredentials();
    stopWatchingCredentials = watchCredentials();
    history = new UsageHistory(cli.mock ? null : accountFile('usage-history.json'));
    forecast = {};
    notifier.useRecords(cli.mock ? null : accountFile('notifications.json'));
    lastSeenAt = null;
    log.info(`Claude Code account → ${accountLogName()}`);
    service.accountChanged(cli.mock ? null : loadSnapshot(accountFile('last-usage.json')));
    void readAccounts();
  }

  /** Menu → Add folder…: a folder picker, with a warning when the folder has no Claude Code files. */
  async function addClaudeCodeDir(): Promise<void> {
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
    switchAccount(dir);
  }

  /** Reads every account's `.claude.json` (no secrets) for the menu and the card (mock runs: none). */
  async function readAccounts(): Promise<void> {
    if (cli.mock) return;
    const dirs = [null, ...settings.get().claudeCodeDirs];
    const read = await Promise.all(dirs.map((dir) => readClaudeCodeAccount(locationOf(dir))));
    dirs.forEach((dir, i) => accounts.set(dir, read[i] ?? null));
    broadcast();
  }

  // Every fresh snapshot: history, forecast, notifications, cache. Stale data (status not ok) is
  // left alone.
  let lastSeenAt: string | null = null;
  service.on('change', () => {
    const snapshot = service.snapshot;
    if (service.status.kind === 'ok' && snapshot && snapshot.fetchedAt !== lastSeenAt) {
      lastSeenAt = snapshot.fetchedAt;
      history.add(snapshot);
      forecast = history.forecasts(snapshot.meters);
      if (!cli.screenshot) {
        const { notifyAt, notifyReset } = settings.get();
        notifier.check(snapshot, { thresholds: notifyAt, reset: notifyReset }, forecast);
      }
      if (!cli.mock) saveSnapshot(accountFile('last-usage.json'), snapshot);
    }
    broadcast();
  });

  // --- IPC (only accepted from our own overlay page) -------------------------------------------
  const fromOverlay = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === win.webContents;

  ipcMain.handle('state:get', (event) => (fromOverlay(event) ? state() : null));
  ipcMain.on('usage:refresh', (event) => {
    if (fromOverlay(event)) service.refreshNow();
  });
  ipcMain.on('view:set-compact', (event, compact: unknown) => {
    if (fromOverlay(event) && typeof compact === 'boolean') actions.setCompact(compact);
  });
  ipcMain.on('menu:show', (event) => {
    if (fromOverlay(event)) menu().popup({ window: win });
  });
  ipcMain.on('claude-code:open', (event) => {
    if (fromOverlay(event)) actions.openClaudeCode();
  });
  ipcMain.on('window:resize', (event, width: unknown, height: unknown) => {
    if (!fromOverlay(event) || typeof width !== 'number' || typeof height !== 'number') return;
    contentSize = { width, height };
    // Before the first show, a restored position keeps its top-left corner (see fitToContent).
    fit(shown || !restoredPosition);
    if (!shown) showFirstTime();
  });

  // --- Window behaviour ---------------------------------------------------------------------------
  /** Fits the window to the content at the current size setting (CSS pixels x zoom factor = DIPs). */
  function fit(keepNearestEdge: boolean): void {
    if (!contentSize || dragging) return;
    const { scale } = settings.get();
    fitToContent(win, contentSize.width * scale, contentSize.height * scale, keepNearestEdge);
  }

  // Ctrl/Cmd + plus / minus / 0 and Ctrl + mouse wheel step through the Size options, so the
  // window always fits (plain page zoom would leave it cropped or with empty space).
  win.webContents.on('before-input-event', (event, input) => {
    const primary = process.platform === 'darwin' ? input.meta : input.control; // not Win+plus (Magnifier)
    if (input.type !== 'keyDown' || !primary || input.alt) return;
    const step = input.key === '+' || input.key === '=' ? 1 : input.key === '-' ? -1 : input.key === '0' ? 0 : null;
    if (step === null) return;
    event.preventDefault();
    actions.setScale(step === 0 ? 1 : stepScale(settings.get().scale, step));
  });
  win.webContents.on('zoom-changed', (_event, direction) => {
    actions.setScale(stepScale(settings.get().scale, direction === 'in' ? 1 : -1));
  });

  function showFirstTime(): void {
    shown = true;
    win.showInactive();
    updateTray();
    if (cli.screenshot) void captureAndQuit(win, cli.screenshot);
  }
  // Fallback in case the renderer never reports a size.
  setTimeout(() => {
    if (!shown) showFirstTime();
  }, 2500);

  // No resizing while the user drags the overlay. Crossing onto a display with another scale factor
  // makes the renderer report a slightly different size mid-drag, and a setBounds then made the
  // overlay jump back to where it crossed once it was dropped (D44). Fit after the drop instead.
  // Windows sends 'will-move' throughout the drag and 'moved' once at its end; on macOS 'moved' is an
  // alias of 'move', so there the flag only lasts one step; Linux sends neither.
  win.on('will-move', () => {
    dragging = true;
  });
  win.on('moved', () => {
    dragging = false;
    fit(true);
  });

  let moveTimer: NodeJS.Timeout | null = null;
  win.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      if (x !== undefined && y !== undefined) settings.update({ position: { x, y } });
    }, 400);
  });

  // Right-clicking the drag area on Windows opens the native system menu; show ours instead.
  win.on('system-context-menu', (event) => {
    event.preventDefault();
    menu().popup({ window: win });
  });

  // Alt+F4 & co. hide the overlay instead of leaving a window-less tray app.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    updateTray();
  });

  const onDisplaysChanged = () => {
    ensureOnScreen(win);
    updateTray();
  };
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  // Timers are unreliable across sleep; refresh once the network is likely back.
  const refreshSoon = () => setTimeout(() => service.refreshNow(), 5000);
  powerMonitor.on('resume', refreshSoon);
  powerMonitor.on('unlock-screen', refreshSoon);

  // Started again (e.g. from an account's own .bat with --claude-config-dir): switch, then show.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const dir = folderFromArgs(argv, workingDirectory);
    if (dir !== undefined) switchAccount(dir);
    showOverlay();
  });
  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });
  app.on('before-quit', () => {
    quitting = true;
    log.info('Quitting');
    stopWatchingDesktop();
    stopWatchingCredentials();
    service.stop();
    updater.stop();
    settings.flush();
    tray.destroy();
  });
  app.on('will-quit', () => unregisterShortcuts());

  service.start();
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

async function captureAndQuit(win: BrowserWindow, file: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500)); // let data arrive and animations settle
  try {
    const image = await win.webContents.capturePage();
    await writeFile(file, image.toPNG());
    console.log(`Screenshot saved to ${file}`);
  } catch (err) {
    console.error('Screenshot failed:', err);
  }
  app.exit(0);
}
