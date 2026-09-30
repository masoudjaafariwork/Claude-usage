// One overlay window and the Claude Code account it shows (Phase 7). Every window has an account of
// its own — the default one or an added config folder, never one another window shows — with that
// account's usage service (its own requests, one per interval), cached snapshot, pace history,
// notification records and credentials watch, plus the window's own position and view (expanded /
// compact). Everything else — look, lock, source, interval, tray, menu, shortcuts, updates — is
// global and lives in main.ts, which reaches the windows through this class.
import { screen, shell, type BrowserWindow, type Display, type Rectangle } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo, AppState, ClaudeCodeView, SourceId, UsageSnapshot } from '../shared/types';
import { accountLogName, type ClaudeCodeLocation } from './claude-accounts';
import { gatherLaunchFacts, planClaudeCodeLaunch, runLaunchPlan } from './claude-code-launcher';
import { RenewalSchedule, type RenewalResult } from './claude-code-renewal';
import { watchFileInDirs } from './file-watch';
import { HoverWatch } from './hover';
import { describeError, type RotatingLog } from './log';
import { Notifier } from './notifications';
import { UsageHistory, type HistoryPoint } from './pace';
import { AttemptBudget, describeProcessGone, isCleanExit } from './recovery-core';
import { DEFAULT_WINDOW, stepScale, type SettingsStore, type WindowSettings } from './settings';
import { loadSnapshot, saveSnapshot } from './snapshot-cache';
import { UsageService } from './usage-service';
import type { UsageSource } from './usage-source';
import type { VirtualDesktops } from './virtual-desktops';
import { desktopLogName, type DesktopSet } from './virtual-desktops-core';
import { applyAlwaysOnTop, applyLocked, createOverlayWindow, ensureOnScreen, fitToContent, moveToDisplay, resetPosition } from './window';

/** What a window needs from the rest of the app (main.ts). */
export interface OverlayHost {
  readonly settings: SettingsStore;
  readonly log: RotatingLog;
  /** Mock run: no credentials watch. */
  readonly mock: boolean;
  /** Screenshot run: no hover, no notifications, no window rebuilds. */
  readonly screenshot: boolean;
  readonly home: string;
  locationOf(account: string | null): ClaudeCodeLocation;
  /** The account's own file (cached snapshot, pace history, notification records); null = memory only (mock runs). */
  accountFile(account: string | null, name: string): string | null;
  /** The account as its `.claude.json` says: shown on the card before any data. */
  accountInfo(account: string | null): AccountInfo | null;
  /** Whose limits a notification is about while several windows are open; null with one window. */
  notificationLabel(account: string | null): string | null;
  /** Bounds of the other overlay windows: a new or reset window goes next to them. */
  otherBounds(overlay: Overlay): Rectangle[];
  canClose(): boolean;
  updateReady(): boolean;
  unlockShortcut(): string | null;
  isQuitting(): boolean;
  isScreenLocked(): boolean;
  /** Something the tray or the menus show has changed. */
  changed(): void;
  showMenu(overlay: Overlay): void;
  /** Alt+F4 & co.: closed while another window is open, otherwise hidden (main.ts decides). */
  requestClose(overlay: Overlay): void;
  /** Ctrl +/-/0 or Ctrl+wheel over a window: the Size setting (all windows). */
  setScale(scale: number): void;
  /** Clicking one of this account's notifications: every window shows, this one on its own desktop if need be. */
  reveal(overlay: Overlay): void;
  /** Places windows on their virtual desktops (Phase 10). */
  readonly desktops: VirtualDesktops;
  /** Claude Code rewrote this account's credentials (e.g. `/login`): the menu's e-mails are read again. */
  credentialsChanged(): void;
  /** A Claude Code the overlay can run was found (Phase 8): the card offers Sign in, else Install. */
  claudeCodeInstalled(): boolean;
  /**
   * Lets Claude Code renew this window's expired sign-in in the background (its local `/usage`,
   * claude-code-renewal.ts); `started` is called when Claude Code actually runs. Null when it didn't
   * run: no (recent enough) Claude Code, offline, stopped for this account, already running.
   */
  renewSignIn(overlay: Overlay, started: () => void): Promise<RenewalResult | null>;
  /** The renderer's first size report fitted (and showed) the window. */
  shownFirstTime(overlay: Overlay): void;
  /** The blank-overlay watchdog saw a rebuilt window go blank again: restart the app (D60). */
  blankAfterRebuild(): void;
}

export interface OverlaySetup {
  /** The account to show: an added config folder, or null for the default one. */
  account: string | null;
  /** The account's sources; they read the overlay's current location, which a switch changes. */
  sources(overlay: Overlay): Record<SourceId, UsageSource>;
  initialSnapshot: UsageSnapshot | null;
  /** History to start with when the account's history lives only in memory (mock runs). */
  initialHistory?: HistoryPoint[];
  /** Show the window once its content is fitted (false while the other overlays are hidden). */
  show: boolean;
}

export class Overlay {
  /** The account shown: an added config folder, or null for the default one. Its key in `settings.windows`. */
  account: string | null;
  /** Where that account's sign-in lives. */
  location: ClaudeCodeLocation;
  readonly service: UsageService;
  /** `let`-like: rebuilt in place after the GPU process dies or the page went blank (recreateWindow). */
  win: BrowserWindow;

  private readonly host: OverlayHost;
  private restoredPosition: boolean;
  private history: UsageHistory;
  private forecast: Record<string, string> = {};
  private readonly notifier: Notifier;
  private stopWatchingCredentials: () => void;
  /** `fetchedAt` of the last snapshot that went into the history and the notification check. */
  private lastSeenAt: string | null = null;
  private lastClaudeCodeLaunch = 0;
  /** Background renewal of an expired sign-in through Claude Code (Phase 8). */
  private renewal = new RenewalSchedule();
  /** The host's renewSignIn() for this account while it runs (its checks, then maybe Claude Code). */
  private renewCall: Promise<void> | null = null;
  /** Claude Code itself runs for it (the card says "Renewing sign-in…"). */
  private renewing = false;
  /** Claude Code said the account isn't signed in any more: only signing in again helps. */
  private signInEnded = false;
  /** Renewals in a row in which Claude Code had no plan usage to show (its sign-in didn't renew). */
  private noUsageRuns = 0;
  /** A sign-in terminal is open for this account: its files are checked every 2 s (watchSignIn). */
  private signInTimer: NodeJS.Timeout | null = null;
  /** False until the renderer's first size report has fitted (and shown) the current window. */
  private shown = false;
  /** Whether that first fit shows the window. */
  private showWhenFitted: boolean;
  /** Last content size reported by the renderer, in CSS pixels (the window needs it × zoom factor). */
  private contentSize: { width: number; height: number } | null = null;
  /** True while the user drags the window (Windows; see the 'will-move' handler). */
  private dragging = false;
  private firstShowTimer: NodeJS.Timeout | null = null;
  private moveTimer: NodeJS.Timeout | null = null;
  private blankTimer: NodeJS.Timeout | null = null;
  private lastBlankRebuild = 0;
  /** The watchdog found the window on another virtual desktop: once back, it waits one more round. */
  private blankGrace = false;
  private activateCheckTimer: NodeJS.Timeout | null = null;
  /** Crash loops: the page is reloaded at most 3 times in 10 minutes. */
  private readonly reloadBudget = new AttemptBudget(3, 10 * 60_000);
  private readonly hover: HoverWatch;
  private disposed = false;

  constructor(host: OverlayHost, setup: OverlaySetup) {
    this.host = host;
    this.account = setup.account;
    this.location = host.locationOf(setup.account);
    const { settings } = host;
    this.service = new UsageService(
      {
        sources: setup.sources(this),
        mode: () => settings.get().source,
        intervalSec: () => settings.get().refreshIntervalSec,
        log: (level, line) => host.log.write(level, `[${this.logName}] ${line}`),
      },
      setup.initialSnapshot,
    );
    // Snapshot history for the pace forecast (last 24 h, per account; mock runs keep theirs in memory).
    this.history = new UsageHistory(host.accountFile(setup.account, 'usage-history.json'), setup.initialHistory);
    this.notifier = new Notifier({ file: host.accountFile(setup.account, 'notifications.json'), onClick: () => host.reveal(this), log: host.log.write });
    this.stopWatchingCredentials = this.watchCredentials();
    this.showWhenFitted = setup.show;
    const created = createOverlayWindow(settings.get(), this.view.position, host.otherBounds(this));
    this.win = created.win;
    this.restoredPosition = created.restoredPosition;
    this.placeOnDesktop(); // macOS: Spaces before the first show; Windows moves it once shown

    // A see-through overlay turns fully opaque while the cursor is over it (D57). Windows and Linux
    // compare physical pixels: with displays at different scale factors, the DIP bounds of a window
    // lying across two of them don't line up with the cursor's DIP position.
    const physical = process.platform !== 'darwin';
    this.hover = new HoverWatch({
      cursor: () => (physical ? screen.dipToScreenPoint(screen.getCursorScreenPoint()) : screen.getCursorScreenPoint()),
      bounds: () => (physical ? screen.dipToScreenRect(this.win, this.win.getBounds()) : this.win.getBounds()),
      onThisDesktop: () => this.isOnThisDesktop(),
      onChange: (hovered) => {
        if (!this.win.isDestroyed()) this.win.webContents.send('hover:changed', hovered);
      },
    });

    this.service.on('change', () => this.onUsageChange());
    this.attachWindowHandlers();
  }

  /** How the log names this window's account (no folder paths). */
  get logName(): string {
    return accountLogName(this.account, process.platform);
  }

  /** This window's own settings: position and view. */
  get view(): Readonly<WindowSettings> {
    return this.host.settings.get().windows.find((w) => w.account === this.account) ?? DEFAULT_WINDOW;
  }

  private updateView(patch: Partial<WindowSettings>): void {
    const { settings } = this.host;
    settings.update({ windows: settings.get().windows.map((w) => (w.account === this.account ? { ...w, ...patch } : w)) });
  }

  start(): void {
    this.service.start();
  }

  state(): AppState {
    const { host, service } = this;
    const current = host.settings.get();
    return {
      snapshot: service.snapshot,
      status: service.status,
      refreshing: service.refreshing,
      view: {
        compact: this.view.compact,
        opacity: current.opacity,
        compactHidden: current.compactHidden,
        locked: current.locked,
        unlockShortcut: host.unlockShortcut(),
        showAccount: current.showAccount,
      },
      sourceMode: current.source,
      selectedAccount: host.accountInfo(this.account),
      addedAccount: this.account !== null,
      claudeCode: this.claudeCodeView(),
      canClose: host.canClose(),
      updateReady: host.updateReady(),
      forecast: service.status.kind === 'ok' ? this.forecast : {},
    };
  }

  /** Sends the current state to the page. */
  send(): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('state:changed', this.state());
  }

  // --- The account ---------------------------------------------------------------------------------

  /**
   * Shows another account in this window (Phase 6's switch). Everything that belongs to an account
   * follows: sign-in, credentials watch, cached snapshot, pace history and notification records; a
   * request still running for the previous account is dropped (UsageService.accountChanged). The
   * caller has made sure no other window shows it and the folder is in the settings.
   */
  switchAccount(account: string | null): void {
    if (account === this.account) return;
    const before = this.logName;
    this.updateView({ account });
    this.account = account;
    this.location = this.host.locationOf(account);
    this.stopWatchingCredentials();
    this.stopWatchingCredentials = this.watchCredentials();
    this.history = new UsageHistory(this.host.accountFile(account, 'usage-history.json'));
    this.forecast = {};
    this.notifier.useRecords(this.host.accountFile(account, 'notifications.json'));
    this.lastSeenAt = null;
    this.renewal = new RenewalSchedule();
    this.renewCall = null; // a run still going for the previous account ends unseen
    this.renewing = false;
    this.signInEnded = false;
    this.noUsageRuns = 0;
    this.stopSignInWatch();
    this.host.log.info(`[${before}] Claude Code account → ${this.logName}`);
    const cache = this.host.accountFile(account, 'last-usage.json');
    this.service.accountChanged(cache ? loadSnapshot(cache) : null);
  }

  refresh(): void {
    this.service.refreshNow();
  }

  /** Opens Claude Code for this account, so it renews its own sign-in (D34, D53). */
  openClaudeCode(): void {
    if (Date.now() - this.lastClaudeCodeLaunch < 5000) return; // a double click opens one window, not two
    this.lastClaudeCodeLaunch = Date.now();
    const addedFolder = this.account === null ? null : this.location.dir;
    const plan = planClaudeCodeLaunch(gatherLaunchFacts(process.platform, process.env, this.host.home, addedFolder, tmpdir()));
    runLaunchPlan(plan, `[${this.logName}] Open Claude Code`, (url) => shell.openExternal(url), this.host.log.write).catch((err: unknown) =>
      this.host.log.warn(`Open Claude Code failed: ${describeError(err)}`),
    );
  }

  /** Claude Code rewrites its credentials file when it renews its token: recover in seconds, not 60 s. */
  private watchCredentials(): () => void {
    if (this.host.mock) return () => {};
    return watchFileInDirs([this.location.dir], '.credentials.json', () => this.credentialsChanged());
  }

  /** Claude Code renewed, signed in or signed out this account. */
  private credentialsChanged(): void {
    this.signInEnded = false; // a new sign-in; if it is gone after all, the next renewal says so again
    this.service.credentialsChanged();
    this.host.credentialsChanged(); // `/login` rewrites it too
  }

  // --- Sign-in through Claude Code (Phase 8) ---------------------------------------------------------

  private claudeCodeView(): ClaudeCodeView {
    return {
      installed: this.host.claudeCodeInstalled(),
      renewing: this.renewing,
      signInEnded: this.signInEnded,
      signingIn: this.signInTimer !== null,
    };
  }

  /**
   * A sign-in terminal was opened for this account (`terminal`: the process that lasts as long as
   * its window, when the OS tells). The folder may not exist yet, so a file watch can't see the
   * result: its files are looked at every 2 s until the account shows numbers, the window is
   * closed, or 15 minutes have passed.
   */
  watchSignIn(terminal: ChildProcess | null): void {
    this.stopSignInWatch();
    this.signInEnded = false;
    const deadline = Date.now() + 15 * 60_000;
    let seen = this.signInStamp();
    const look = () => {
      const stamp = this.signInStamp();
      if (stamp === seen) return;
      seen = stamp;
      this.stopWatchingCredentials(); // the folder may exist only now
      this.stopWatchingCredentials = this.watchCredentials();
      this.credentialsChanged();
    };
    this.signInTimer = setInterval(() => {
      look();
      if (Date.now() > deadline) this.stopSignInWatch();
    }, 2000);
    terminal?.on('exit', () => {
      look();
      setTimeout(() => this.stopSignInWatch(), 3000); // Claude Code may still be writing
    });
    this.send();
    this.host.changed();
  }

  private stopSignInWatch(): void {
    if (!this.signInTimer) return;
    clearInterval(this.signInTimer);
    this.signInTimer = null;
    if (!this.disposed) {
      this.send();
      this.host.changed();
    }
  }

  /** Changes whenever Claude Code writes the account's sign-in or account file (the Keychain has no file: `.claude.json` changes too). */
  private signInStamp(): string {
    const mtime = (file: string) => {
      try {
        return String(statSync(file).mtimeMs);
      } catch {
        return '-';
      }
    };
    return `${mtime(join(this.location.dir, '.credentials.json'))}|${mtime(this.location.accountFile)}`;
  }

  /**
   * Claude Code's sign-in for this account has expired (also behind Claude Desktop's numbers in
   * Auto): let Claude Code renew it in the background, when the schedule allows.
   */
  maybeRenew(): void {
    const { service } = this;
    const claudeCode = service.status.kind === 'token-expired' ? service.status : service.unavailable['claude-code'];
    const renewable = claudeCode?.kind === 'token-expired' && (claudeCode.reason === 'expired' || claudeCode.reason === 'rejected');
    if (!renewable || this.renewCall || this.signInEnded || this.disposed || !this.renewal.due(Date.now())) return;
    if (!this.host.settings.get().autoRenew) return;
    const schedule = this.renewal; // replaced when the window switches to another account
    const current = () => schedule === this.renewal && !this.disposed;
    const call: Promise<void> = this.host
      .renewSignIn(this, () => {
        if (!current()) return;
        this.renewing = true;
        this.send();
        this.host.changed();
      })
      .catch((err: unknown) => {
        this.host.log.warn(`[${this.logName}] Renewal failed: ${describeError(err)}`);
        return null;
      })
      .then((result) => {
        if (this.renewCall === call) this.renewCall = null;
        if (current()) this.renewed(result); // else: about another account, or the window is gone
      });
    this.renewCall = call;
  }

  private renewed(result: RenewalResult | null): void {
    const wasRenewing = this.renewing;
    this.renewing = false;
    if (!result && !wasRenewing) return; // skipped: nothing changed on the card
    if (result) this.renewal.attempted(Date.now());
    // Twice (an hour apart) no plan usage although online: the sign-in is gone, not the network.
    this.noUsageRuns = result?.kind === 'no-usage' ? this.noUsageRuns + 1 : result ? 0 : this.noUsageRuns;
    if (result?.kind === 'signed-out' || this.noUsageRuns >= 2) this.signInEnded = true;
    // Claude Code rewrote the sign-in (the file watch sees it too; the macOS Keychain has no file).
    if (result?.kind === 'renewed') this.service.signInRenewed();
    this.send();
    this.host.changed();
  }

  // Every fresh snapshot: history, forecast, notifications, cache. Stale data (status not ok) is
  // left alone.
  private onUsageChange(): void {
    const snapshot = this.service.snapshot;
    if (this.service.status.kind === 'ok' && snapshot && snapshot.fetchedAt !== this.lastSeenAt) {
      this.lastSeenAt = snapshot.fetchedAt;
      this.history.add(snapshot);
      this.forecast = this.history.forecasts(snapshot.meters);
      if (!this.host.screenshot) {
        const { notifyAt, notifyReset } = this.host.settings.get();
        this.notifier.check(snapshot, { thresholds: notifyAt, reset: notifyReset }, this.forecast, this.host.notificationLabel(this.account));
      }
      const cache = this.host.accountFile(this.account, 'last-usage.json');
      if (cache) saveSnapshot(cache, snapshot);
    }
    if (this.service.status.kind === 'ok' && snapshot?.source === 'claude-code') {
      // Claude Code's sign-in works (again): a renewal, if any, did its job.
      this.renewal.succeeded();
      this.signInEnded = false;
      this.noUsageRuns = 0;
      this.stopSignInWatch();
    }
    this.maybeRenew();
    this.send();
    this.host.changed();
  }

  // --- The window ----------------------------------------------------------------------------------

  /** Shown — possibly on another virtual desktop (isVisibleHere). */
  isVisible(): boolean {
    return !this.win.isDestroyed() && this.win.isVisible();
  }

  /** Shown on the desktop the user is on: show / hide treats a window on another desktop as hidden (Phase 10). */
  isVisibleHere(): boolean {
    return this.isVisible() && this.isOnThisDesktop();
  }

  /** False only while the window is on another virtual desktop (Windows; elsewhere it can't be told). */
  isOnThisDesktop(): boolean {
    return this.host.desktops.isOnCurrentDesktop(this.win);
  }

  /** Shows the window and makes sure it can be seen: on a display, on its desktop, back on top, repainted. */
  show(): void {
    if (!this.shown) {
      this.showWhenFitted = true; // the first fit shows it
      return;
    }
    ensureOnScreen(this.win, this.host.otherBounds(this));
    this.win.showInactive();
    this.placeOnDesktop(); // a hidden window has lost its desktop (Windows)
    applyAlwaysOnTop(this.win, this.host.settings.get().alwaysOnTop); // a fresh HWND_TOPMOST: above windows that came later
    this.win.webContents.invalidate();
  }

  hide(): void {
    if (!this.shown) this.showWhenFitted = false;
    this.syncDesktop(); // once hidden, Windows no longer says which desktop it was on
    this.win.hide();
  }

  /**
   * Brings the shown window to the front and gives it the focus. On Windows the system switches to
   * the virtual desktop of a window that becomes the foreground window — the user asked to see it
   * (tray click, shortcut, a notification, *Show overlay*). Never called on the app's own initiative.
   */
  activate(): void {
    if (!this.isVisible()) return;
    const { viaTaskbar, refused } = this.host.desktops.activate(this.win);
    applyAlwaysOnTop(this.win, this.host.settings.get().alwaysOnTop);
    const how = viaTaskbar ? ' (it was the foreground window already: via the taskbar)' : '';
    if (refused) {
      // Windows keeps the foreground where the user just was: nothing changes on this desktop.
      this.host.log.info(`[${this.logName}] Overlay on another desktop: Windows refused it the foreground${how}; it stays there`);
      return;
    }
    this.host.log.info(`[${this.logName}] Overlay on another desktop: activated it${how}`);
    // Whether Windows switched desktops, for the log (the owner's manual test, Phase 10).
    if (this.activateCheckTimer) clearTimeout(this.activateCheckTimer);
    this.activateCheckTimer = setTimeout(() => {
      this.activateCheckTimer = null;
      if (this.disposed || !this.isVisible()) return;
      this.host.log.info(`[${this.logName}] ${this.isOnThisDesktop() ? "Windows switched to the overlay's desktop" : 'Windows stayed on this desktop'}`);
    }, 1000);
  }

  // --- Virtual desktops (Phase 10) -------------------------------------------------------------------

  /** Menu → *Show on desktop*: all desktops (null) or some (Phase 11); the window goes there now. */
  setDesktops(set: DesktopSet): void {
    this.updateView({ desktops: set });
    this.host.log.info(`[${this.logName}] Show on desktop → ${desktopLogName(set)}`);
    this.placeOnDesktop();
  }

  /** On several desktops: it follows the user among them (Phase 11), so the desktop switches are watched. */
  get onSeveralDesktops(): boolean {
    return (this.view.desktops?.length ?? 0) > 1;
  }

  /**
   * A desktop switch (or a change of the desktop list): a shown window of several desktops goes to the
   * new current desktop when that is one of its own, and stays where it is otherwise (Phase 11).
   */
  followDesktop(): void {
    if (this.host.screenshot || this.disposed || !this.isVisible() || !this.onSeveralDesktops) return;
    this.syncDesktop(); // first adopt a Task View drag or a removed desktop
    this.placeOnDesktop();
  }

  /**
   * Puts the window on its desktops — all desktops, or some (a taskbar button, then moved to the one it
   * belongs on now). The one place that does it: at creation (also a rebuilt window), after every show,
   * after a desktop switch (several desktops) and when the setting changes. Screenshot runs never move
   * windows.
   */
  private placeOnDesktop(): void {
    if (this.host.screenshot || this.disposed || this.win.isDestroyed()) return;
    const save = this.host.desktops.place(this.win, this.view.desktops);
    if (save === undefined) return;
    if (save === null) this.host.log.info(`[${this.logName}] Its desktops are gone: the overlay is on all desktops again`);
    this.updateView({ desktops: save });
  }

  /**
   * Where the window really is wins: after the user dragged it to another desktop in Task View, or
   * removed its desktop (Windows moves its windows to a neighbour), the setting follows. Called before
   * a menu is built, before hiding, rebuilding and quitting.
   */
  syncDesktop(): void {
    if (this.host.screenshot || this.disposed || !this.isVisible()) return;
    const actual = this.host.desktops.actualDesktop(this.win, this.view.desktops);
    if (!actual) return;
    this.host.log.info(`[${this.logName}] The overlay is on ${desktopLogName(actual)} now (moved in Task View, or its desktop was removed)`);
    this.updateView({ desktops: actual });
  }

  setCompact(compact: boolean): void {
    this.updateView({ compact });
    this.send();
  }

  applyLocked(locked: boolean): void {
    applyLocked(this.win, locked);
    this.updateHover();
  }

  applyAlwaysOnTop(on: boolean): void {
    applyAlwaysOnTop(this.win, on);
  }

  applyScale(scale: number): void {
    this.win.webContents.setZoomFactor(scale);
    this.fit(true);
  }

  /** A new Opacity value: shown right away, although the menu opened over the overlay. */
  holdHover(): void {
    this.hover.holdUntilLeave();
    this.updateHover();
  }

  /** Watches the cursor only while it matters: see-through, visible, clickable (locked stays as set); never in screenshots. */
  updateHover(): void {
    const { opacity, locked } = this.host.settings.get();
    this.hover.setActive(!this.host.screenshot && !this.disposed && this.isVisible() && !locked && opacity < 1);
  }

  moveToDisplay(display: Display): void {
    moveToDisplay(this.win, display, this.host.otherBounds(this));
  }

  resetPosition(): void {
    resetPosition(this.win, this.host.otherBounds(this));
  }

  /** Brings the window back if its display was unplugged or rearranged. */
  ensureOnScreen(): void {
    ensureOnScreen(this.win, this.host.otherBounds(this));
  }

  /** The renderer reported its content size (CSS pixels). */
  resized(width: number, height: number): void {
    this.contentSize = { width, height };
    // Before the first show, a restored position keeps its top-left corner (see fitToContent).
    this.fit(this.shown || !this.restoredPosition);
    if (!this.shown) this.showFirstTime();
  }

  /** Fits the window to the content at the current size setting (CSS pixels × zoom factor = DIPs). */
  private fit(keepNearestEdge: boolean): void {
    if (!this.contentSize || this.dragging) return;
    const { scale } = this.host.settings.get();
    fitToContent(this.win, this.contentSize.width * scale, this.contentSize.height * scale, keepNearestEdge);
  }

  private showFirstTime(): void {
    this.shown = true;
    if (this.showWhenFitted) {
      this.win.showInactive();
      this.placeOnDesktop();
    }
    this.host.shownFirstTime(this);
  }

  /** Wires up the current window; called again for a rebuilt one (recreateWindow). */
  private attachWindowHandlers(): void {
    const { win, host } = this;
    const target = win; // events of a window that was replaced meanwhile are ignored

    // Chromium remembers a zoom level per page (userData/Preferences) and prefers it to
    // webPreferences.zoomFactor, so apply the Size setting again as soon as the page is committed.
    win.webContents.on('did-navigate', () => win.webContents.setZoomFactor(host.settings.get().scale));
    win.on('show', () => this.updateHover());
    win.on('hide', () => this.updateHover());

    // Ctrl/Cmd + plus / minus / 0 and Ctrl + mouse wheel step through the Size options, so the
    // window always fits (plain page zoom would leave it cropped or with empty space).
    win.webContents.on('before-input-event', (event, input) => {
      const primary = process.platform === 'darwin' ? input.meta : input.control; // not Win+plus (Magnifier)
      if (input.type !== 'keyDown' || !primary || input.alt) return;
      const step = input.key === '+' || input.key === '=' ? 1 : input.key === '-' ? -1 : input.key === '0' ? 0 : null;
      if (step === null) return;
      event.preventDefault();
      host.setScale(step === 0 ? 1 : stepScale(host.settings.get().scale, step));
    });
    win.webContents.on('zoom-changed', (_event, direction) => {
      host.setScale(stepScale(host.settings.get().scale, direction === 'in' ? 1 : -1));
    });

    // Fallback in case the renderer never reports a size.
    if (this.firstShowTimer) clearTimeout(this.firstShowTimer);
    this.firstShowTimer = setTimeout(() => {
      if (!this.shown && this.win === target) this.showFirstTime();
    }, 2500);

    // No resizing while the user drags the overlay. Crossing onto a display with another scale factor
    // makes the renderer report a slightly different size mid-drag, and a setBounds then made the
    // overlay jump back to where it crossed once it was dropped (D44). Fit after the drop instead.
    // Windows sends 'will-move' throughout the drag and 'moved' once at its end; on macOS 'moved' is an
    // alias of 'move', so there the flag only lasts one step; Linux sends neither.
    win.on('will-move', () => {
      this.dragging = true;
    });
    win.on('moved', () => {
      this.dragging = false;
      this.fit(true);
    });
    win.on('move', () => {
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        if (win.isDestroyed() || this.disposed) return;
        const [x, y] = win.getPosition();
        if (x !== undefined && y !== undefined) this.updateView({ position: { x, y } });
      }, 400);
    });

    // Right-clicking the drag area on Windows opens the native system menu; show ours instead.
    win.on('system-context-menu', (event) => {
      event.preventDefault();
      host.showMenu(this);
    });

    // Alt+F4 & co.: main.ts closes this window while another one is open, else hides it (a
    // window-less tray app would have nothing to show).
    win.on('close', (event) => {
      if (host.isQuitting()) return;
      event.preventDefault();
      host.requestClose(this);
    });

    // The page's renderer process died (crash, out of memory, killed): a transparent window then
    // shows nothing at all, and Electron doesn't reload by itself.
    win.webContents.on('render-process-gone', (_event, details) => {
      if (this.win !== target || host.isQuitting() || isCleanExit(details)) return;
      host.log.error(describeProcessGone(`Overlay renderer [${this.logName}]`, details));
      if (!this.reloadBudget.take()) {
        host.log.error('The overlay page keeps crashing; not reloading it again (quit and start the app)');
        return;
      }
      host.log.info('Reloading the overlay page');
      win.webContents.reload();
    });
    win.webContents.on('unresponsive', () => host.log.warn(`[${this.logName}] The overlay page stopped responding`));
    win.webContents.on('responsive', () => host.log.info(`[${this.logName}] The overlay page responds again`));
  }

  /**
   * Replaces the window with a new one at the same place, shown if the old one was: after the GPU
   * process died (a transparent window can stay blank afterwards; hide/show doesn't repaint it) and
   * from the blank-overlay watchdog. For the window this is what a restart does, without restarting
   * the app (D60).
   */
  recreateWindow(reason: string): void {
    if (this.host.isQuitting() || this.host.screenshot || this.disposed || this.win.isDestroyed()) return;
    this.host.log.warn(`[${this.logName}] Rebuilding the overlay window: ${reason}`);
    this.syncDesktop(); // the new window goes to the desktop the old one is on
    const old = this.win;
    const bounds = old.getBounds();
    this.showWhenFitted = old.isVisible();
    this.hover.setActive(false);
    old.removeAllListeners(); // destroy() skips 'close' anyway; nothing else of the old window matters now
    old.destroy();
    const created = createOverlayWindow(this.host.settings.get(), this.view.position, [], bounds);
    this.win = created.win;
    this.restoredPosition = created.restoredPosition;
    this.host.desktops.carryOver(old, this.win);
    this.placeOnDesktop();
    this.shown = false;
    this.contentSize = null; // the new page reports its size, then the window is fitted and shown
    this.attachWindowHandlers();
    this.host.changed();
  }

  // --- Blank-overlay watchdog (D60, Windows only) ----------------------------------------------------
  // The page reports "hidden" although the window is shown and on top: Chromium has stopped drawing
  // the overlay (its occlusion tracker believes the window is covered). With the tracker off this
  // shouldn't happen; if it does, a new window gets a fresh calculation, and when that one is hidden
  // too the state is process-wide — then the app restarts itself (main.ts, at most once per 30 min).
  // macOS hides the page of a covered window by design and shows it again reliably: no watchdog there.
  pageVisibility(hidden: boolean): void {
    if (this.blankTimer) clearTimeout(this.blankTimer);
    this.blankTimer = null;
    this.blankGrace = false;
    if (!hidden || process.platform !== 'win32') return;
    this.blankTimer = setTimeout(() => this.blankCheck(), 5000);
  }

  private blankCheck(): void {
    this.blankTimer = null;
    const { host } = this;
    if (host.isQuitting() || host.screenshot || this.disposed || !this.isVisible() || !host.settings.get().alwaysOnTop || host.isScreenLocked()) return;
    // On another virtual desktop the window is cloaked, and with the occlusion tracker on
    // (--keep-occlusion) Chromium hides its page there by design (Phase 10). Look again later; once the
    // user is on its desktop the page has one more round to show before it counts as blank.
    const here = this.isOnThisDesktop();
    if (!here || this.blankGrace) {
      this.blankGrace = !here;
      this.blankTimer = setTimeout(() => this.blankCheck(), 5000);
      return;
    }
    host.log.error(`[${this.logName}] The overlay page is hidden while its window is shown: Chromium stopped drawing the overlay`);
    if (Date.now() - this.lastBlankRebuild < 60_000) {
      host.blankAfterRebuild();
      return;
    }
    this.lastBlankRebuild = Date.now();
    this.recreateWindow('the page is hidden while the window is shown');
  }

  // --- Ending ----------------------------------------------------------------------------------------

  /** Stops polling and watching (quit, close). */
  stop(): void {
    this.stopWatchingCredentials();
    if (this.signInTimer) clearInterval(this.signInTimer);
    this.signInTimer = null;
    this.hover.setActive(false);
    this.service.stop();
  }

  /** Closes the window for good and stops its account's polling (the user closed it, Phase 7). */
  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const timer of [this.firstShowTimer, this.moveTimer, this.blankTimer, this.activateCheckTimer]) if (timer) clearTimeout(timer);
    this.service.removeAllListeners(); // a request still running ends unseen
    if (!this.win.isDestroyed()) {
      this.win.removeAllListeners();
      this.win.destroy();
    }
  }
}
