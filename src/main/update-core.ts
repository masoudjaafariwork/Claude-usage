// In-app updates from GitHub Releases: which kind of update this copy can do, when to check, and what
// the menu and notifications say. Pure module (unit-tested in update-core.test.ts); updater.ts
// drives electron-updater with it (D45).
//
// Modes:
//   auto   — downloads in the background, installs on quit or from the menu (Windows installer, AppImage)
//   notify — only says that a new version exists and opens its download page (macOS without an Apple
//            Developer ID (D16), the Windows portable exe, the deb package)
//   off    — dev, mock and screenshot runs

/** Where releases live; must match build.publish in package.json (update-core.test.ts checks it). */
export const UPDATE_REPO = { owner: 'masoudjaafariwork', repo: 'Claude-usage' } as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * HOUR;
/** A failed check (offline, GitHub down) is tried again sooner than the regular interval. */
export const RETRY_AFTER_ERROR_MS = HOUR;
/** How often the schedule is looked at. Timers drift across sleep, so the due time is re-checked. */
export const SCHEDULE_TICK_MS = 15 * MINUTE;

export type UpdateMode = 'auto' | 'notify' | 'off';

export interface UpdateEnvironment {
  /** app.isPackaged: installed or portable build. */
  packaged: boolean;
  /** Mock or screenshot run. */
  devRun: boolean;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
}

export function updateMode({ packaged, devRun, platform, env }: UpdateEnvironment): UpdateMode {
  if (!packaged || devRun) return 'off';
  switch (platform) {
    case 'win32':
      // Running the NSIS installer from the portable exe would install a second, separate copy.
      return env.PORTABLE_EXECUTABLE_FILE ? 'notify' : 'auto';
    case 'linux':
      // Only an AppImage can replace itself; a deb belongs to the package manager.
      return env.APPIMAGE ? 'auto' : 'notify';
    case 'darwin':
      // Squirrel.Mac installs only updates signed with an Apple Developer ID; builds are ad-hoc signed.
      return 'notify';
    default:
      return 'off';
  }
}

export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  /** Notify mode: a newer version exists; the menu opens its download page. */
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  /** Downloaded and verified; installs on quit or from the menu. */
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

export interface CheckHistory {
  /** When the last check started (ms); null = not yet in this run. */
  lastAttemptAt: number | null;
  lastFailed: boolean;
}

/** Whether a scheduled check is due. Never while busy or while a downloaded update waits. */
export function isCheckDue(phase: UpdatePhase, history: CheckHistory, now: number): boolean {
  if (phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'ready') return false;
  if (history.lastAttemptAt === null || now < history.lastAttemptAt) return true; // clock moved back
  return now - history.lastAttemptAt >= (history.lastFailed ? RETRY_AFTER_ERROR_MS : CHECK_INTERVAL_MS);
}

export type UpdateAction = 'check' | 'install' | 'open-download-page';

export interface UpdateMenuItem {
  label: string;
  enabled: boolean;
  action: UpdateAction | null;
  /** Something to act on: shown at the top of the menu instead of next to About. */
  prominent: boolean;
}

export function updateMenuItem(mode: UpdateMode, phase: UpdatePhase): UpdateMenuItem {
  const item = (label: string, action: UpdateAction | null, prominent = false): UpdateMenuItem => ({
    label,
    enabled: action !== null,
    action,
    prominent,
  });
  if (mode === 'off') return item('Check for updates (installed app only)', null);
  switch (phase.kind) {
    case 'idle':
      return item('Check for updates', 'check');
    case 'checking':
      return item('Checking for updates…', null);
    case 'up-to-date':
      return item('Check for updates — up to date', 'check');
    case 'available':
      return item(`Update available (v${phase.version}) — open download page`, 'open-download-page', true);
    case 'downloading':
      return item(`Downloading update v${phase.version}… ${phase.percent}%`, null);
    case 'ready':
      return item(`Restart to update to v${phase.version}`, 'install', true);
    case 'error':
      return item('Check for updates — last check failed', 'check');
  }
}

export interface UpdateNotice {
  title: string;
  body: string;
  /** Clicking the notification opens the release's download page (notify mode). */
  opensDownloadPage: boolean;
}

/**
 * The notification for a new phase, or null. Scheduled checks stay quiet except when an update is
 * ready to install or (notify mode) available; a check from the menu reports every outcome, since
 * the menu has closed by then.
 */
export function updateNotice(phase: UpdatePhase, manual: boolean, currentVersion: string): UpdateNotice | null {
  const notice = (title: string, body: string, opensDownloadPage = false): UpdateNotice => ({ title, body, opensDownloadPage });
  switch (phase.kind) {
    case 'ready':
      return notice(
        `Claude Usage ${phase.version} is ready`,
        'Choose “Restart to update” in the menu, or it installs the next time you quit.',
      );
    case 'available':
      return notice(`Claude Usage ${phase.version} is available`, 'Click to open the download page.', true);
    case 'downloading':
      return manual
        ? notice(`Downloading Claude Usage ${phase.version}`, 'You will be told when it is ready to install.')
        : null;
    case 'up-to-date':
      return manual ? notice('Claude Usage is up to date', `Version ${currentVersion} is the latest.`) : null;
    case 'error':
      return manual ? notice('Couldn’t check for updates', `${phase.message}. Details are in the log.`) : null;
    default:
      return null;
  }
}

/** A short reason for a failed check or download, for the menu and notifications (the log gets it all). */
export function describeUpdateError(text: string): string {
  if (/ERR_CHECKSUM_MISMATCH|checksum mismatch/i.test(text)) return 'The download was damaged';
  if (
    /ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|No published versions|HttpError: 404/i.test(
      text,
    )
  ) {
    return 'No update information on GitHub';
  }
  if (/HttpError: (403|429)|rate limit/i.test(text)) return 'GitHub is limiting requests';
  if (
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|PROXY_\w+|ADDRESS_UNREACHABLE)|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
      text,
    )
  ) {
    return 'No connection to GitHub';
  }
  return 'Unexpected error';
}

/** One line of at most `max` characters: electron-updater's errors carry whole HTTP responses. */
export function oneLine(text: string, max = 300): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The GitHub page a version is downloaded from (the latest release when the version looks odd). */
export function releasePageUrl(version: string | null): string {
  const base = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`;
  return version && /^\d+\.\d+\.\d+[\w.+-]*$/.test(version) ? `${base}/tag/v${version}` : `${base}/latest`;
}
