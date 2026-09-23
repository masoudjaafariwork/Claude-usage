// Reads the OAuth access token that Claude Code stores after `/login`.
//
// READ-ONLY by design: Anthropic's refresh tokens are single-use and rotate, so if this app ever
// refreshed the token it would silently log Claude Code out. We only read, re-read on every poll
// (to pick up tokens Claude Code renewed), and never write, refresh or log the token.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeCredentials {
  accessToken: string;
  /** Expiry as epoch milliseconds, or null when not recorded. */
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  source: 'file' | 'keychain';
}

export class CredentialsNotFoundError extends Error {
  override name = 'CredentialsNotFoundError';
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Claude Code's config directory (honours CLAUDE_CONFIG_DIR like Claude Code itself does). */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? override : join(homedir(), '.claude');
}

export function parseCredentials(text: string, source: ClaudeCredentials['source']): ClaudeCredentials | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const oauth = (data as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) return null;
  const o = oauth as Record<string, unknown>;
  if (typeof o.accessToken !== 'string' || o.accessToken === '') return null;
  return {
    accessToken: o.accessToken,
    expiresAt: typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : null,
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
    rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : null,
    source,
  };
}

async function readFromFile(): Promise<ClaudeCredentials | null> {
  try {
    const text = await readFile(join(claudeConfigDir(), '.credentials.json'), 'utf8');
    return parseCredentials(text, 'file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function readFromKeychain(): Promise<ClaudeCredentials | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 10_000 },
      (err, stdout) => resolve(err ? null : parseCredentials(stdout.trim(), 'keychain')),
    );
  });
}

export async function readCredentials(): Promise<ClaudeCredentials> {
  const found: ClaudeCredentials[] = [];
  if (process.platform === 'darwin') {
    const fromKeychain = await readFromKeychain();
    if (fromKeychain) found.push(fromKeychain);
  }
  const fromFile = await readFromFile();
  if (fromFile) found.push(fromFile);

  // On macOS the Keychain and the file can diverge; the one expiring last is the freshest.
  found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const best = found[0];
  if (!best) {
    throw new CredentialsNotFoundError('No Claude Code sign-in found on this computer');
  }
  return best;
}
