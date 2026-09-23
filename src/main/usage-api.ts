// HTTP client for the usage endpoint that backs Claude → Settings → Usage.
// Uses Electron's `net.fetch` (Chromium network stack) so system proxy / VPN settings apply.
import { net } from 'electron';
import { UsageHttpError, parseRetryAfter } from './usage-errors';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 20_000;

export async function fetchUsageJson(accessToken: string, userAgent: string): Promise<unknown> {
  const response = await net.fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': userAgent,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new UsageHttpError(response.status, parseRetryAfter(response.headers.get('retry-after')));
  }
  return response.json();
}
