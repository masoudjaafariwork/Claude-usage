// Polls the selected usage source(s) and owns the usage state (last snapshot + status).
// Auto mode tries Claude Code first, then Claude Desktop's history (local file, no network) — one
// source at a time — and falling back is not an error. Pure module: all I/O lives in the sources.
import { EventEmitter } from 'node:events';
import type { SourceId, SourceMode, Status, StatusKind, UsageSnapshot } from '../shared/types';
import type { LogFn } from './log';
import { UsageHttpError } from './usage-errors';
import { UsageParseError } from './usage-parse';
import { SourceUnavailableError, errorMessage, type UsageSource } from './usage-source';

export interface UsageServiceDeps {
  sources: Readonly<Record<SourceId, UsageSource>>;
  /** Current source mode from settings. */
  mode(): SourceMode;
  /** Current polling interval from settings, in seconds. */
  intervalSec(): number;
  now?(): number;
  log?: LogFn;
}

export const AUTO_ORDER: readonly SourceId[] = ['claude-code', 'claude-desktop'];
/** How often to look again while no source is usable (local file reads only). */
export const RECHECK_CREDENTIALS_SEC = 60;
/** Never schedule two automatic requests closer than this. */
export const MIN_GAP_SEC = 30;
export const MAX_BACKOFF_SEC = 30 * 60;
/** Manual refreshes closer together than this are ignored. */
const MANUAL_MIN_GAP_MS = 5_000;

/**
 * Auto mode with no usable source: which problem to show. An expired Claude Code token (or an
 * unreadable credentials file) is the actionable one; with nothing set up at all, a "not signed
 * in" banner lists every way to fix it.
 */
const AUTO_STATUS_PRIORITY: readonly StatusKind[] = ['token-expired', 'error'];

/** States in which a poll makes no network request (only local file reads). */
const UNAVAILABLE_KINDS: ReadonlySet<StatusKind> = new Set(['no-credentials', 'token-expired', 'desktop-unavailable']);

export const SOURCE_LABELS: Readonly<Record<SourceId, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
};

export function backoffSec(baseSec: number, failures: number): number {
  return Math.min(MAX_BACKOFF_SEC, baseSec * 2 ** Math.max(0, failures - 1));
}

export function autoStatus(unavailable: readonly Status[]): Status {
  for (const kind of AUTO_STATUS_PRIORITY) {
    const hit = unavailable.find((status) => status.kind === kind);
    if (hit) return hit;
  }
  return { kind: 'no-credentials', message: 'Sign in to Claude Code, or open the Claude desktop app.' };
}

export class UsageService extends EventEmitter<{ change: [] }> {
  snapshot: UsageSnapshot | null;
  status: Status = { kind: 'loading' };
  refreshing = false;

  private readonly deps: UsageServiceDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private repollAfterCurrent = false;
  private failures = 0;
  private lastRequestAt = 0;
  private lastLogged = '';

  constructor(deps: UsageServiceDeps, initialSnapshot: UsageSnapshot | null = null) {
    super();
    this.deps = deps;
    this.snapshot = initialSnapshot;
  }

  start(): void {
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /** Manual refresh (button / menu / wake from sleep). Ignored when it would just hammer the API. */
  refreshNow(): void {
    if (!this.running || this.refreshing) return;
    const { kind, nextAttemptAt } = this.status;
    if (kind === 'rate-limited' && nextAttemptAt && Date.parse(nextAttemptAt) > this.now()) return;
    if (this.now() - this.lastRequestAt < MANUAL_MIN_GAP_MS) return;
    void this.poll();
  }

  /** The source mode changed: poll right away. */
  sourcesChanged(): void {
    if (!this.running) return;
    if (this.refreshing) this.repollAfterCurrent = true;
    else void this.poll();
  }

  /**
   * Claude Desktop wrote a new sample. Re-read it when Desktop is (or may become) the source;
   * in those states a poll costs no network request.
   */
  desktopHistoryChanged(): void {
    const mode = this.deps.mode();
    const onDesktop = this.status.kind === 'ok' && this.snapshot?.source === 'claude-desktop';
    if (mode === 'claude-desktop' || (mode === 'auto' && (onDesktop || UNAVAILABLE_KINDS.has(this.status.kind)))) {
      this.sourcesChanged();
    }
  }

  /** Re-plan the next automatic poll, e.g. after the interval setting changed. */
  reschedule(): void {
    if (this.running && !this.refreshing && this.status.kind === 'ok') this.schedule(this.nextOkDelaySec());
  }

  async poll(): Promise<void> {
    this.clearTimer();
    this.refreshing = true;
    this.emit('change');
    let delaySec: number;
    do {
      this.repollAfterCurrent = false;
      delaySec = await this.attempt();
    } while (this.repollAfterCurrent && this.running);
    this.refreshing = false;
    if (this.running) this.schedule(delaySec);
    this.emit('change');
  }

  /** One round over the sources: updates snapshot/status and returns seconds until the next attempt. */
  async attempt(): Promise<number> {
    this.lastRequestAt = this.now();
    const mode = this.deps.mode();
    const order = mode === 'auto' ? AUTO_ORDER : [mode];
    const unavailable: Status[] = [];
    for (const id of order) {
      const shown = this.snapshot;
      const shownFetchedAt = mode === 'auto' && shown && shown.source !== id ? Date.parse(shown.fetchedAt) : null;
      try {
        const snapshot = await this.deps.sources[id].fetch({ shownFetchedAt });
        this.snapshot = snapshot;
        this.status = { kind: 'ok' };
        this.failures = 0;
        this.logState(`ok via ${SOURCE_LABELS[id]}`);
        return this.nextOkDelaySec();
      } catch (err) {
        if (err instanceof SourceUnavailableError) {
          unavailable.push(err.status);
          continue;
        }
        this.failures++;
        const delay = this.handleFetchError(err);
        this.logState(`${SOURCE_LABELS[id]}: ${this.status.kind} — ${this.status.message ?? ''}`, 'warn');
        return delay;
      }
    }
    this.status = mode === 'auto' ? autoStatus(unavailable) : (unavailable[0] ?? { kind: 'error' });
    this.logState(`no usable source (${mode}): ${unavailable.map((s) => s.kind).join(', ')}`);
    return RECHECK_CREDENTIALS_SEC;
  }

  private handleFetchError(err: unknown): number {
    const interval = this.deps.intervalSec();
    if (err instanceof UsageHttpError) {
      if (err.status === 429) {
        this.status = { kind: 'rate-limited', message: 'The usage API is rate-limiting requests. Retrying automatically.' };
        const wait = err.retryAfterSec ?? backoffSec(interval, this.failures);
        return Math.min(MAX_BACKOFF_SEC, Math.max(MIN_GAP_SEC, wait));
      }
      this.status = { kind: 'error', message: `The usage API returned an error (HTTP ${err.status}).` };
      return backoffSec(60, this.failures);
    }
    if (err instanceof UsageParseError) {
      this.status = { kind: 'error', message: 'Unrecognized response from the usage API. The app may need an update.' };
      return interval;
    }
    this.status = { kind: 'network-error', message: `Can't reach Anthropic (${errorMessage(err)}).` };
    return backoffSec(30, this.failures);
  }

  /** Normal interval, shortened so we poll again just after the earliest reset. */
  private nextOkDelaySec(): number {
    const now = this.now();
    let delay = this.deps.intervalSec();
    for (const meter of this.snapshot?.meters ?? []) {
      if (!meter.resetsAt) continue;
      const untilReset = (Date.parse(meter.resetsAt) - now) / 1000 + 5;
      if (untilReset > 0 && untilReset < delay) delay = untilReset;
    }
    return Math.max(MIN_GAP_SEC, Math.round(delay));
  }

  /** Logs status changes and source switches (not every identical poll). */
  private logState(line: string, level: 'info' | 'warn' = 'info'): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.deps.log?.(level, line);
  }

  private schedule(delaySec: number): void {
    this.clearTimer();
    if (this.status.kind !== 'ok') {
      this.status = { ...this.status, nextAttemptAt: new Date(this.now() + delaySec * 1000).toISOString() };
    }
    this.timer = setTimeout(() => void this.poll(), delaySec * 1000);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
