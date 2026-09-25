// Several Claude Code accounts, one config folder each (Claude Code's CLAUDE_CONFIG_DIR): where a
// folder keeps its sign-in and account file, how folders compare, the key of an account's own state
// files, the menu labels and the --claude-config-dir option. Claude Code's rules were read in its
// code (2.1.283). Pure module (Node only).
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { shortenEmail } from '../shared/format';

/** Where one Claude Code sign-in lives. Everything here is only ever read (D3). */
export interface ClaudeCodeLocation {
  /** Claude Code's config folder: holds `.credentials.json` (Windows / Linux). */
  dir: string;
  /** Claude Code's `.claude.json` (the account, no secrets). In the home folder without CLAUDE_CONFIG_DIR. */
  accountFile: string;
  /** macOS Keychain service that holds the sign-in. */
  keychainService: string;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Most folders kept in the settings (the oldest goes first). */
export const MAX_FOLDERS = 20;
/** Longest folder shown in a menu label; longer ones lose their middle. */
const MAX_FOLDER_LABEL = 60;
const MAX_EMAIL_LABEL = 40;
const ARG = '--claude-config-dir=';

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** CLAUDE_CONFIG_DIR of the app's own environment, or null. */
export function envConfigDir(env: NodeJS.ProcessEnv): string | null {
  return env.CLAUDE_CONFIG_DIR?.trim() || null;
}

/**
 * Where the sign-in of `chosen` (an added folder) lives, or of the default account when null: the
 * app's own CLAUDE_CONFIG_DIR, else `~/.claude` with `~/.claude.json`. With a config folder, Claude
 * Code names its Keychain item after a hash of the folder string exactly as it got it.
 */
export function claudeCodeLocation(chosen: string | null, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): ClaudeCodeLocation {
  const path = pathFor(platform);
  const configDir = chosen ?? envConfigDir(env);
  if (configDir === null) {
    return { dir: path.join(home, '.claude'), accountFile: path.join(home, '.claude.json'), keychainService: KEYCHAIN_SERVICE };
  }
  const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return { dir: configDir, accountFile: path.join(configDir, '.claude.json'), keychainService: `${KEYCHAIN_SERVICE}-${hash}` };
}

/** Absolute, without trailing separators (a root keeps its own). */
export function normalizeFolder(dir: string, platform: NodeJS.Platform, cwd?: string): string {
  const path = pathFor(platform);
  const resolved = cwd ? path.resolve(cwd, dir) : path.resolve(dir);
  const root = path.parse(resolved).root;
  let end = resolved.length;
  while (end > root.length && (resolved[end - 1] === path.sep || resolved[end - 1] === '/')) end--;
  return resolved.slice(0, end);
}

/** Folder names ignore case on Windows and (by default) on macOS. */
function comparable(dir: string, platform: NodeJS.Platform): string {
  const normal = normalizeFolder(dir, platform);
  return platform === 'win32' || platform === 'darwin' ? normal.toLowerCase() : normal;
}

export function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/**
 * Name of an added folder's own state folder (`userData/accounts/<key>`: cached snapshot, pace
 * history, notification records). The default account keeps the files in userData itself.
 */
export function accountStateKey(dir: string, platform: NodeJS.Platform): string {
  return createHash('sha256').update(comparable(dir, platform)).digest('hex').slice(0, 12);
}

/**
 * The folder settings after choosing `dir` (null = the default account): the default account's own
 * folder selects the default entry, a known folder is selected as stored, a new one is added.
 */
export function chooseFolder(
  dirs: readonly string[],
  dir: string | null,
  defaultDir: string,
  platform: NodeJS.Platform,
): { claudeCodeDirs: string[]; claudeCodeDir: string | null } {
  if (dir === null || sameFolder(dir, defaultDir, platform)) return { claudeCodeDirs: [...dirs], claudeCodeDir: null };
  const known = dirs.find((d) => sameFolder(d, dir, platform));
  if (known !== undefined) return { claudeCodeDirs: [...dirs], claudeCodeDir: known };
  return { claudeCodeDirs: [...dirs, dir].slice(-MAX_FOLDERS), claudeCodeDir: dir };
}

/** `~` for the home folder, and a middle cut for very long paths. */
export function folderLabel(dir: string, home: string, platform: NodeJS.Platform): string {
  const path = pathFor(platform);
  const inHome = sameFolder(dir, home, platform) || comparable(dir, platform).startsWith(comparable(home, platform) + path.sep.toLowerCase());
  const shown = inHome ? `~${normalizeFolder(dir, platform).slice(normalizeFolder(home, platform).length)}` : dir;
  const chars = Array.from(shown);
  if (chars.length <= MAX_FOLDER_LABEL) return shown;
  const half = Math.floor((MAX_FOLDER_LABEL - 1) / 2);
  return `${chars.slice(0, half).join('')}…${chars.slice(chars.length - (MAX_FOLDER_LABEL - 1 - half)).join('')}`;
}

export interface AccountMenuEntry {
  /** Added folder, or null for the default account. */
  dir: string | null;
  label: string;
  selected: boolean;
}

export interface AccountMenuInput {
  /** Folders the user added. */
  dirs: readonly string[];
  /** Selected folder, or null for the default account. */
  selected: string | null;
  /** The default account's folder (for its label). */
  defaultDir: string;
  /** E-mail per folder (`emailOf(null)` = the default account), when known. */
  emailOf(dir: string | null): string | null;
  /** False while *Show account* is off (e.g. screen sharing): folders only. */
  showEmail: boolean;
  home: string;
  platform: NodeJS.Platform;
}

/** The radio items of menu → *Claude Code account*: "ada@example.com — ~\.claude (default)". */
export function accountMenuEntries(input: AccountMenuInput): AccountMenuEntry[] {
  const label = (dir: string | null) => {
    const email = input.showEmail ? input.emailOf(dir) : null;
    const folder = folderLabel(dir ?? input.defaultDir, input.home, input.platform) + (dir === null ? ' (default)' : '');
    return email ? `${shortenEmail(email, MAX_EMAIL_LABEL)} — ${folder}` : folder;
  };
  return [null, ...input.dirs].map((dir) => ({ dir, label: label(dir), selected: dir === input.selected }));
}

/**
 * `--claude-config-dir=<folder>` among command-line arguments (Chromium may add its own switches):
 * undefined when absent or empty, null for `default`, else the folder, resolved against `cwd`.
 */
export function configDirArg(argv: readonly string[], cwd: string, platform: NodeJS.Platform): string | null | undefined {
  const arg = argv.findLast((a) => a.startsWith(ARG));
  const value = arg?.slice(ARG.length).trim().replace(/^"(.*)"$/, '$1');
  if (!value) return undefined;
  if (value.toLowerCase() === 'default') return null;
  return normalizeFolder(value, platform, cwd);
}
