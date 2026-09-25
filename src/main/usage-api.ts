// HTTP client for the usage endpoint that backs Claude → Settings → Usage.
// Uses Electron's `net.fetch` (Chromium network stack) so system proxy / VPN settings apply.
import { net } from 'electron';
import type { LogFn } from './log';
import { UsageHttpError, parseRetryAfter } from './usage-errors';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 20_000;

export async function fetchUsageJson(accessToken: string, userAgent: string, log: LogFn): Promise<unknown> {
  const started = Date.now();
  const response = await net.fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': userAgent,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  log(response.ok ? 'info' : 'warn', `GET api.anthropic.com/api/oauth/usage → ${response.status} in ${Date.now() - started} ms`);
  if (!response.ok) {
    throw new UsageHttpError(response.status, parseRetryAfter(response.headers.get('retry-after')));
  }
  return response.json();
}
