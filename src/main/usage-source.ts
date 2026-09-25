// A usage source: somewhere the overlay can get a UsageSnapshot from. The service tries sources
// in order (Auto mode) or uses one (single-source modes); every source shares its polling, backoff
// and status logic. Pure module — Electron-specific I/O is injected.
//
// Contract for fetch():
//   - resolves with a snapshot on success;
//   - throws SourceUnavailableError when the source can't be used right now (not signed in,
//     expired, no recent data, …) — Auto mode then falls back to the next source;
//   - throws anything else (UsageHttpError, UsageParseError, network errors) for transient
//     failures, which the service reports and backs off from.
import type { SourceId, Status, UsageSnapshot } from '../shared/types';
import { CredentialsNotFoundError, type ClaudeCredentials } from './credentials';
import { UsageHttpError } from './usage-errors';
import { formatPlan, parseUsage } from './usage-parse';

export interface FetchContext {
  /** fetchedAt (epoch ms) of the snapshot currently shown, when it came from another source. */
  shownFetchedAt: number | null;
}

export interface UsageSource {
  readonly id: SourceId;
  fetch(context: FetchContext): Promise<UsageSnapshot>;
}

export class SourceUnavailableError extends Error {
  override name = 'SourceUnavailableError';
  readonly status: Status;

  constructor(status: Status) {
    super(status.message ?? status.kind);
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Treat tokens this close to expiry as already expired. */
const EXPIRY_SKEW_MS = 60_000;

export interface ClaudeCodeSourceDeps {
  readCredentials(): Promise<ClaudeCredentials>;
  fetchUsage(accessToken: string): Promise<unknown>;
  now(): number;
}

/** Claude Code's OAuth token → api.anthropic.com/api/oauth/usage. Read-only (D3). */
export class ClaudeCodeSource implements UsageSource {
  readonly id = 'claude-code' as const;
  private readonly deps: ClaudeCodeSourceDeps;
  /** A token the API rejected; not retried until Claude Code writes a new one. Memory only. */
  private rejectedToken: string | null = null;

  constructor(deps: ClaudeCodeSourceDeps) {
    this.deps = deps;
  }

  async fetch(): Promise<UsageSnapshot> {
    let credentials: ClaudeCredentials;
    try {
      credentials = await this.deps.readCredentials();
    } catch (err) {
      throw new SourceUnavailableError(
        err instanceof CredentialsNotFoundError
          ? { kind: 'no-credentials', message: 'Sign in to Claude Code on this computer to see your usage.' }
          : { kind: 'error', message: `Could not read Claude Code credentials: ${errorMessage(err)}` },
      );
    }

    const now = this.deps.now();
    const expired = credentials.expiresAt !== null && credentials.expiresAt <= now + EXPIRY_SKEW_MS;
    if (expired || credentials.accessToken === this.rejectedToken) {
      throw new SourceUnavailableError({
        kind: 'token-expired',
        message: 'Claude Code sign-in has expired. Open Claude Code to renew it.',
      });
    }

    try {
      const raw = await this.deps.fetchUsage(credentials.accessToken);
      const plan = formatPlan(credentials.subscriptionType, credentials.rateLimitTier);
      const snapshot = parseUsage(raw, plan, new Date(this.deps.now()), 'claude-code');
      this.rejectedToken = null;
      return snapshot;
    } catch (err) {
      if (err instanceof UsageHttpError && (err.status === 401 || err.status === 403)) {
        this.rejectedToken = credentials.accessToken;
        throw new SourceUnavailableError({
          kind: 'token-expired',
          message: 'Claude Code sign-in is no longer valid. Open Claude Code to renew it.',
        });
      }
      throw err;
    }
  }
}
