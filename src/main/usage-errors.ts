// Error types shared by the HTTP client and the polling service. Pure module (no Electron),
// so the service can be unit-tested under plain Node.

export class UsageHttpError extends Error {
  override name = 'UsageHttpError';
  readonly status: number;
  /** Seconds to wait, from the Retry-After header, when present. */
  readonly retryAfterSec: number | null;

  constructor(status: number, retryAfterSec: number | null) {
    super(`Usage API responded with HTTP ${status}`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - now) / 1000));
}
