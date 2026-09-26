// Recovery without a restart: the overlay page is reloaded when its renderer process dies, and the
// window is rebuilt when the GPU process dies (a transparent window can stay blank afterwards). A
// budget keeps a crash loop from retrying forever. Pure module (no Electron), so it can be unit-tested.

/** Allows at most `max` attempts within any span of `windowMs`; further attempts are refused. */
export class AttemptBudget {
  private readonly times: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt at `now` when one is still allowed and says whether it is. */
  take(now: number = Date.now()): boolean {
    while (this.times.length > 0 && now - (this.times[0] ?? now) >= this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

export interface ProcessGone {
  /** Electron's reason: crashed, killed, oom, abnormal-exit, launch-failed, clean-exit, … */
  reason: string;
  exitCode?: number;
  /** Utility processes name their service. */
  name?: string;
}

/** One log line for a helper process that ended, e.g. "GPU process gone: crashed (exit code 5)". */
export function describeProcessGone(kind: string, details: ProcessGone): string {
  const code = details.exitCode === undefined ? '' : ` (exit code ${details.exitCode})`;
  const name = details.name ? ` — ${details.name}` : '';
  return `${kind} process gone: ${details.reason}${code}${name}`;
}

/** A process that ended on purpose (app quit, normal exit) needs no recovery and no log line. */
export function isCleanExit(details: ProcessGone): boolean {
  return details.reason === 'clean-exit';
}

/**
 * How to start the app again (`app.relaunch`): the Windows portable exe and the Linux AppImage must
 * be started by their outer file — the running binary is an unpacked copy that goes away on exit.
 */
export function relaunchOptions(env: Readonly<Record<string, string | undefined>>, platform: string): { execPath: string } | undefined {
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_FILE) return { execPath: env.PORTABLE_EXECUTABLE_FILE };
  if (platform === 'linux' && env.APPIMAGE) return { execPath: env.APPIMAGE };
  return undefined;
}
