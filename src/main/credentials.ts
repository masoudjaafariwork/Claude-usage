// Reads the OAuth access token that Claude Code stores after `/login`.
//
// READ-ONLY by design: Anthropic's refresh tokens are single-use and rotate, so if this app ever
// refreshed the token it would silently log Claude Code out. We only read, re-read on every poll
// (to pick up tokens Claude Code renewed), and never write, refresh or log the token.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountInfo } from '../shared/types';
import type { ClaudeCodeLocation } from './claude-accounts';

export interface ClaudeCredentials {
  accessToken: string;
  /** Expiry as epoch milliseconds, or null when not recorded. */
  expiresAt: number | null;
  /**
   * When the sign-in itself ends (the refresh token's expiry), epoch milliseconds, or null when not
   * recorded. After it, Claude Code can't renew the access token: only signing in again helps. The
   * refresh token itself is never read into memory here.
   */
  refreshTokenExpiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  source: 'file' | 'keychain';
}

export class CredentialsNotFoundError extends Error {
  override name = 'CredentialsNotFoundError';
  /**
   * Claude Code's sign-in block is there but its tokens are empty: Claude Code signed the account
   * out (it does so when its sign-in can't be renewed any more, seen with 2.1.283). Only signing in
   * again helps.
   */
  readonly signedOut: boolean;

  constructor(message: string, signedOut = false) {
    super(message);
    this.signedOut = signedOut;
  }
}

/** A `claudeAiOauth` block whose access token Claude Code emptied (signed out), as opposed to none at all. */
export function isSignedOutCredentials(text: string): boolean {
  try {
    const oauth = (JSON.parse(text) as Record<string, unknown> | null)?.claudeAiOauth as Record<string, unknown> | undefined;
    return typeof oauth === 'object' && oauth !== null && oauth.accessToken === '';
  } catch {
    return false;
  }
}

/** A timestamp in milliseconds; one small enough to be seconds is taken as seconds. */
function epochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
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
    refreshTokenExpiresAt: epochMs(o.refreshTokenExpiresAt),
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
    rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : null,
    source,
  };
}

/** What one place holds: a sign-in, a signed-out block (see CredentialsNotFoundError), or nothing. */
interface Stored {
  credentials: ClaudeCredentials | null;
  signedOut: boolean;
}

const stored = (text: string, source: ClaudeCredentials['source']): Stored => ({
  credentials: parseCredentials(text, source),
  signedOut: isSignedOutCredentials(text),
});

async function readFromFile(dir: string): Promise<Stored> {
  try {
    return stored(await readFile(join(dir, '.credentials.json'), 'utf8'), 'file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { credentials: null, signedOut: false };
    throw err;
  }
}

function readFromKeychain(service: string): Promise<Stored> {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? { credentials: null, signedOut: false } : stored(stdout.trim(), 'keychain')),
    );
  });
}

/** The account Claude Code is signed in to (`oauthAccount` in `.claude.json`; no secrets in it). */
export interface ClaudeCodeAccount {
  email: string | null;
  name: string | null;
  orgName: string | null;
  orgUuid: string | null;
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function parseClaudeCodeAccount(text: string): ClaudeCodeAccount | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const account = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).oauthAccount : null;
  if (typeof account !== 'object' || account === null) return null;
  const a = account as Record<string, unknown>;
  const parsed: ClaudeCodeAccount = {
    email: nonEmpty(a.emailAddress),
    name: nonEmpty(a.displayName),
    orgName: nonEmpty(a.organizationName),
    orgUuid: nonEmpty(a.organizationUuid),
  };
  return Object.values(parsed).some((v) => v !== null) ? parsed : null;
}

/**
 * Claude Code's account from its config file (`.claude.json` in the config folder, or in the home
 * folder for the default one) — non-secret. Labels the data and picks Claude Desktop samples of the
 * same org.
 */
export async function readClaudeCodeAccount(location: ClaudeCodeLocation): Promise<ClaudeCodeAccount | null> {
  try {
    return parseClaudeCodeAccount(await readFile(location.accountFile, 'utf8'));
  } catch {
    return null;
  }
}

/** What the overlay shows. A personal org's name ("<email>'s Organization") adds nothing, so it is left out. */
export function accountInfo(account: ClaudeCodeAccount | null): AccountInfo | null {
  if (!account || (account.email === null && account.name === null)) return null;
  const { email, name, orgName } = account;
  const personal = [email, name].some((who) => who !== null && orgName === `${who}'s Organization`);
  return { email, name, organization: personal ? null : orgName };
}

/** The sign-in stored at `location` (claude-accounts.ts: the default account or an added folder). */
export async function readCredentials(location: ClaudeCodeLocation): Promise<ClaudeCredentials> {
  const places: Stored[] = [];
  if (process.platform === 'darwin') places.push(await readFromKeychain(location.keychainService));
  places.push(await readFromFile(location.dir));
  const found = places.flatMap((place) => (place.credentials ? [place.credentials] : []));

  // On macOS the Keychain and the file can diverge; the one expiring last is the freshest.
  found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const best = found[0];
  if (!best) {
    const signedOut = places.some((place) => place.signedOut);
    throw new CredentialsNotFoundError(signedOut ? 'Claude Code signed this account out' : 'No Claude Code sign-in found on this computer', signedOut);
  }
  return best;
}
