// In-app updates from GitHub Releases through electron-updater (D45): a check 30 s after start and
// every 6 h; in 'auto' mode the new version downloads in the background and installs when the app
// quits, or right away from the menu ("Restart to update to vX"). In 'notify' mode (macOS, portable
// exe, deb) it only tells that a new version exists and opens its download page. Decisions and
// texts live in update-core.ts.
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { LogFn } from './log';
import {
  FIRST_CHECK_DELAY_MS,
  SCHEDULE_TICK_MS,
  describeUpdateError,
  isCheckDue,
  oneLine,
  releasePageUrl,
  updateMenuItem,
  updateNotice,
  type CheckHistory,
  type UpdateMenuItem,
  type UpdateMode,
  type UpdateNotice,
  type UpdatePhase,
} from './update-core';

export interface UpdaterOptions {
  mode: UpdateMode;
  currentVersion: string;
  log: LogFn;
  /** The phase changed (the menu shows it). */
  onChange(): void;
  notify(notice: UpdateNotice): void;
  openUrl(url: string): void;
  /** Right before the app quits to install (flush settings). */
  beforeInstall(): void;
  /** Linux: the new AppImage has a new file name (launch at login must point at it). */
  onAppImageMoved(path: string): void;
}

export class Updater {
  private current: UpdatePhase = { kind: 'idle' };
  /** The running check was started from the menu. */
  private manual = false;
  private readonly history: CheckHistory = { lastAttemptAt: null, lastFailed: false };
  /** Versions already announced as ready / available in this run. */
  private readonly announced = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly options: UpdaterOptions;

  constructor(options: UpdaterOptions) {
    this.options = options;
  }

  get phase(): UpdatePhase {
    return this.current;
  }

  get menuItem(): UpdateMenuItem {
    return updateMenuItem(this.options.mode, this.current);
  }

  start(): void {
    const { mode, log } = this.options;
    if (mode === 'off') return;
    log('info', `Updates: ${mode === 'auto' ? 'download and install' : 'notify only'} (GitHub Releases)`);
    // electron-updater logs every error itself (with the stack); keep its warnings and errors, one
    // line each. Its info lines repeat what this class logs and would add local paths.
    autoUpdater.logger = {
      info: () => {},
      warn: (message?: unknown) => log('warn', `Updater: ${oneLine(String(message))}`),
      error: (message?: unknown) => log('error', `Updater: ${oneLine(String(message))}`),
    };
    autoUpdater.autoDownload = mode === 'auto';
    autoUpdater.autoInstallOnAppQuit = mode === 'auto';
    autoUpdater.disableDifferentialDownload = true; // full downloads only (no blockmaps published)
    autoUpdater.disableWebInstaller = true; // releases carry the full installer

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log('info', `Update available: ${info.version}`);
      this.set(mode === 'auto' ? { kind: 'downloading', version: info.version, percent: 0 } : { kind: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      log('info', `No update (latest release: ${info.version})`);
      this.set({ kind: 'up-to-date' });
    });
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      const phase = this.current;
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
      // The menu is rebuilt on every change: every 5 % is enough.
      if (phase.kind === 'downloading' && Math.floor(percent / 5) !== Math.floor(phase.percent / 5)) {
        this.set({ ...phase, percent });
      }
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log('info', `Update downloaded: ${info.version} (installs on quit)`);
      this.set({ kind: 'ready', version: info.version });
    });
    autoUpdater.on('error', (err: Error) => {
      // Already logged by electron-updater (logger.error above).
      const phase = this.current;
      if (phase.kind === 'checking' || phase.kind === 'downloading') {
        this.history.lastFailed = true;
        this.set({ kind: 'error', message: describeUpdateError(`${(err as { code?: string }).code ?? ''} ${err.message}`) });
      }
    });
    autoUpdater.on('appimage-filename-updated', (path: string) => {
      log('info', 'AppImage replaced by a file with the new version in its name');
      this.options.onAppImageMoved(path);
    });

    this.timers.push(
      setTimeout(() => this.tick(), FIRST_CHECK_DELAY_MS),
      setInterval(() => this.tick(), SCHEDULE_TICK_MS),
    );
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }

  /** From the menu: check now and report the outcome in a notification. */
  checkNow(): void {
    this.check(true);
  }

  /** From the menu: quit, install the downloaded update and start the new version. */
  install(): void {
    const phase = this.current;
    if (phase.kind !== 'ready') return;
    this.options.log('info', `Restarting to install ${phase.version}`);
    this.options.beforeInstall();
    // Silent install, then start the app again.
    autoUpdater.quitAndInstall(true, true);
  }

  openDownloadPage(): void {
    const phase = this.current;
    this.options.openUrl(releasePageUrl(phase.kind === 'available' ? phase.version : null));
  }

  private tick(): void {
    if (isCheckDue(this.current, this.history, Date.now())) this.check(false);
  }

  private check(manual: boolean): void {
    const kind = this.current.kind;
    if (this.options.mode === 'off' || kind === 'checking' || kind === 'downloading' || kind === 'ready') return;
    this.manual = manual;
    this.history.lastAttemptAt = Date.now();
    this.history.lastFailed = false;
    this.options.log('info', `Checking for updates (${manual ? 'from the menu' : 'scheduled'}, current ${this.options.currentVersion})`);
    this.set({ kind: 'checking' });
    autoUpdater
      .checkForUpdates()
      .then((result) => {
        // A failed download is reported through the 'error' event.
        result?.downloadPromise?.catch(() => {});
        if (result === null && this.current.kind === 'checking') this.set({ kind: 'idle' }); // updater inactive
      })
      .catch(() => {
        // Reported through the 'error' event.
      });
  }

  private set(phase: UpdatePhase): void {
    const previous = this.current;
    this.current = phase;
    this.options.onChange();
    if (phase.kind === previous.kind) return; // progress steps notify nobody
    const notice = updateNotice(phase, this.manual, this.options.currentVersion);
    if (!notice) return;
    if (phase.kind === 'ready' || phase.kind === 'available') {
      // Once per version and run: scheduled checks find the same version again.
      const key = `${phase.kind}:${phase.version}`;
      if (this.announced.has(key)) return;
      this.announced.add(key);
    }
    this.options.notify(notice);
  }
}
