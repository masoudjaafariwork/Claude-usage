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
  subscriptionType: string | null;
  rateLimitTier: string | null;
  source: 'file' | 'keychain';
}

export class CredentialsNotFoundError extends Error {
  override name = 'CredentialsNotFoundError';
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

async function readFromFile(dir: string): Promise<ClaudeCredentials | null> {
  try {
    const text = await readFile(join(dir, '.credentials.json'), 'utf8');
    return parseCredentials(text, 'file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function readFromKeychain(service: string): Promise<ClaudeCredentials | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 10_000 },
      (err, stdout) => resolve(err ? null : parseCredentials(stdout.trim(), 'keychain')),
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
  const found: ClaudeCredentials[] = [];
  if (process.platform === 'darwin') {
    const fromKeychain = await readFromKeychain(location.keychainService);
    if (fromKeychain) found.push(fromKeychain);
  }
  const fromFile = await readFromFile(location.dir);
  if (fromFile) found.push(fromFile);

  // On macOS the Keychain and the file can diverge; the one expiring last is the freshest.
  found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const best = found[0];
  if (!best) {
    throw new CredentialsNotFoundError('No Claude Code sign-in found on this computer');
  }
  return best;
}
