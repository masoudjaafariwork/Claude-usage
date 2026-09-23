// Polls the usage endpoint and owns the usage state (last snapshot + status).
// Pure module: all I/O is injected, so it runs under plain Node in tests.
import { EventEmitter } from 'node:events';
import type { Status, UsageSnapshot } from '../shared/types';
import { CredentialsNotFoundError, type ClaudeCredentials } from './credentials';
import { UsageHttpError } from './usage-errors';
import { UsageParseError, formatPlan, parseUsage } from './usage-parse';

export interface UsageServiceDeps {
  readCredentials(): Promise<ClaudeCredentials>;
  fetchUsage(accessToken: string): Promise<unknown>;
  /** Current polling interval from settings, in seconds. */
  intervalSec(): number;
  now?(): number;
}

/** How often to re-read the credentials file while signed out / expired (local read, no network). */
export const RECHECK_CREDENTIALS_SEC = 60;
/** Never schedule two automatic requests closer than this. */
export const MIN_GAP_SEC = 30;
export const MAX_BACKOFF_SEC = 30 * 60;
/** Manual refreshes closer together than this are ignored. */
const MANUAL_MIN_GAP_MS = 5_000;
/** Treat tokens this close to expiry as already expired. */
const EXPIRY_SKEW_MS = 60_000;

export function backoffSec(baseSec: number, failures: number): number {
  return Math.min(MAX_BACKOFF_SEC, baseSec * 2 ** Math.max(0, failures - 1));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class UsageService extends EventEmitter<{ change: [] }> {
  snapshot: UsageSnapshot | null;
  status: Status = { kind: 'loading' };
  refreshing = false;

  private readonly deps: UsageServiceDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failures = 0;
  private lastRequestAt = 0;
  /** A token the API rejected; not retried until Claude Code writes a new one. Memory only. */
  private rejectedToken: string | null = null;

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

  /** Re-plan the next automatic poll, e.g. after the interval setting changed. */
  reschedule(): void {
    if (this.running && !this.refreshing && this.status.kind === 'ok') this.schedule(this.nextOkDelaySec());
  }

  async poll(): Promise<void> {
    this.clearTimer();
    this.refreshing = true;
    this.emit('change');
    const delaySec = await this.attempt();
    this.refreshing = false;
    if (this.running) this.schedule(delaySec);
    this.emit('change');
  }

  /** One fetch attempt: updates snapshot/status and returns seconds until the next attempt. */
  async attempt(): Promise<number> {
    let credentials: ClaudeCredentials;
    try {
      credentials = await this.deps.readCredentials();
    } catch (err) {
      this.status =
        err instanceof CredentialsNotFoundError
          ? { kind: 'no-credentials', message: 'Sign in to Claude Code on this computer to see your usage.' }
          : { kind: 'error', message: `Could not read Claude Code credentials: ${errorMessage(err)}` };
      return RECHECK_CREDENTIALS_SEC;
    }

    const expired = credentials.expiresAt !== null && credentials.expiresAt <= this.now() + EXPIRY_SKEW_MS;
    if (expired || credentials.accessToken === this.rejectedToken) {
      this.status = { kind: 'token-expired', message: 'Claude Code sign-in has expired. Open Claude Code to renew it.' };
      return RECHECK_CREDENTIALS_SEC;
    }

    this.lastRequestAt = this.now();
    try {
      const raw = await this.deps.fetchUsage(credentials.accessToken);
      const plan = formatPlan(credentials.subscriptionType, credentials.rateLimitTier);
      this.snapshot = parseUsage(raw, plan, new Date(this.now()));
      this.status = { kind: 'ok' };
      this.failures = 0;
      this.rejectedToken = null;
      return this.nextOkDelaySec();
    } catch (err) {
      this.failures++;
      return this.handleFetchError(err, credentials.accessToken);
    }
  }

  private handleFetchError(err: unknown, accessToken: string): number {
    const interval = this.deps.intervalSec();
    if (err instanceof UsageHttpError) {
      if (err.status === 401 || err.status === 403) {
        this.rejectedToken = accessToken;
        this.status = { kind: 'token-expired', message: 'Claude Code sign-in is no longer valid. Open Claude Code to renew it.' };
        return RECHECK_CREDENTIALS_SEC;
      }
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
