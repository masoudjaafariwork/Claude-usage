// Entry point of the Electron main process: wires settings, the usage service, the overlay
// window, the tray icon and IPC together.
//
// Dev flags:
//   --mock[=scenario]      fake data (scenarios in mock.ts), separate userData directory
//   --screenshot=<file>    render, save a PNG of the overlay to <file>, then quit
//   --compact / --expanded override the view mode for this run
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AppState } from '../shared/types';
import { readCredentials } from './credentials';
import { createLoginItem } from './login-item';
import { reconcileLoginItem } from './login-item-core';
import { buildMenu, type MenuActions } from './menu';
import { MOCK_SCENARIOS, createMockSource, isMockScenario, type MockScenario } from './mock';
import { SettingsStore } from './settings';
import { loadSnapshot, saveSnapshot } from './snapshot-cache';
import { TrayController } from './tray';
import { fetchUsageJson } from './usage-api';
import { UsageService } from './usage-service';
import {
  APP_ICON_PATH,
  applyAlwaysOnTop,
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
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mock: null, screenshot: null, compact: null };
  for (const arg of argv) {
    if (arg === '--mock') options.mock = 'normal';
    else if (arg.startsWith('--mock=')) {
      const scenario = arg.slice('--mock='.length);
      if (isMockScenario(scenario)) options.mock = scenario;
      else console.warn(`Unknown mock scenario "${scenario}". Options: ${MOCK_SCENARIOS.join(', ')}`);
    } else if (arg.startsWith('--screenshot=')) options.screenshot = resolve(arg.slice('--screenshot='.length));
    else if (arg === '--compact') options.compact = true;
    else if (arg === '--expanded') options.compact = false;
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
  const settings = new SettingsStore(join(userData, 'settings.json'), !cli.screenshot);
  if (cli.compact !== null) settings.update({ compact: cli.compact });

  // Dev, mock and screenshot runs never touch the OS login items.
  const loginItem = createLoginItem(app.isPackaged && !cli.mock && !cli.screenshot, APP_ID);
  if (loginItem.available) {
    try {
      const wanted = settings.get().launchAtLogin;
      const { launchAtLogin, register } = reconcileLoginItem(wanted, loginItem.state());
      if (register) loginItem.set(true);
      if (launchAtLogin !== wanted) settings.update({ launchAtLogin });
    } catch (err) {
      console.error('Launch at login sync failed:', err);
    }
  }

  const snapshotFile = join(userData, 'last-usage.json');
  const intervalSec = () => settings.get().refreshIntervalSec;
  const userAgent = `ClaudeUsage/${app.getVersion()} (${process.platform}; Electron ${process.versions.electron})`;
  const source = cli.mock
    ? createMockSource(cli.mock, intervalSec)
    : {
        deps: { readCredentials, fetchUsage: (token: string) => fetchUsageJson(token, userAgent), intervalSec },
        initialSnapshot: loadSnapshot(snapshotFile),
      };
  const service = new UsageService(source.deps, source.initialSnapshot);

  const { win, restoredPosition } = createOverlayWindow(settings.get());
  let quitting = false;
  let shown = false;

  const state = (): AppState => ({
    snapshot: service.snapshot,
    status: service.status,
    refreshing: service.refreshing,
    view: { compact: settings.get().compact, opacity: settings.get().opacity },
  });

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
    setAlwaysOnTop: (on) => {
      settings.update({ alwaysOnTop: on });
      applyAlwaysOnTop(win, on);
      updateTray();
    },
    setOpacity: (opacity) => {
      settings.update({ opacity });
      broadcast();
    },
    setRefreshInterval: (seconds) => {
      settings.update({ refreshIntervalSec: seconds });
      service.reschedule();
      updateTray();
    },
    moveToDisplay: (displayId) => {
      const display = screen.getAllDisplays().find((d) => d.id === displayId);
      if (display) moveToDisplay(win, display);
      if (!win.isVisible()) actions.toggleWindow();
    },
    resetPosition: () => {
      resetPosition(win);
      if (!win.isVisible()) actions.toggleWindow();
    },
    setLaunchAtLogin: (on) => {
      let actual = on;
      try {
        loginItem.set(on);
        actual = loginItem.state() === 'on';
      } catch (err) {
        console.error('Launch at login failed:', err);
        actual = !on;
      }
      settings.update({ launchAtLogin: actual });
      updateTray();
    },
    openSettingsFolder: () => void shell.openPath(userData),
    showAbout: () => void showAbout(),
    quit: () => app.quit(),
  };

  const menu = () =>
    buildMenu(settings.get(), { windowVisible: win.isVisible(), loginItemAvailable: loginItem.available }, actions);
  const tray = new TrayController(() => actions.toggleWindow());

  function updateTray(): void {
    tray.update(state(), menu());
  }

  function broadcast(): void {
    if (!win.isDestroyed()) win.webContents.send('state:changed', state());
    updateTray();
  }

  let lastCachedAt: string | null = null;
  service.on('change', () => {
    broadcast();
    const snapshot = service.snapshot;
    if (!cli.mock && service.status.kind === 'ok' && snapshot && snapshot.fetchedAt !== lastCachedAt) {
      lastCachedAt = snapshot.fetchedAt;
      saveSnapshot(snapshotFile, snapshot);
    }
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
  ipcMain.on('window:resize', (event, width: unknown, height: unknown) => {
    if (!fromOverlay(event) || typeof width !== 'number' || typeof height !== 'number') return;
    // Before the first show, a restored position keeps its top-left corner (see fitToContent).
    fitToContent(win, width, height, shown || !restoredPosition);
    if (!shown) showFirstTime();
  });

  // --- Window behaviour ---------------------------------------------------------------------------
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

  app.on('second-instance', () => {
    if (!win.isVisible()) actions.toggleWindow();
  });
  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });
  app.on('before-quit', () => {
    quitting = true;
    service.stop();
    settings.flush();
    tray.destroy();
  });

  service.start();
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
