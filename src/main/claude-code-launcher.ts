// Running the user's own Claude Code — never a login of our own (D28), never a token of our own (D3):
//
// - "Open Claude Code" (banner button / menu): opens Claude Code so that it renews its sign-in — it
//   refreshes an expired token when a session starts in a trusted folder, and it coordinates
//   refreshes between its own processes with a lock. It only runs on the user's click and sends no
//   prompt. For an added config folder (another account) Claude Code must run with CLAUDE_CONFIG_DIR
//   set, so the VS Code route (which opens the default profile's account) is skipped for it (D34, D53).
// - "Sign in" / "Install Claude Code" (Phase 8): a visible terminal runs `claude auth login` (after
//   Anthropic's own installer, for Install). Claude Code opens the system browser and stores the
//   sign-in where the overlay already reads it; its fallback (a URL, a pasted code) stays visible in
//   that terminal. The terminal runs a small script written to the temp folder.
//
// Claude Code is looked up on every use (a running app doesn't see PATH changes) and resolved to a
// binary that can be started directly: npm's `claude.cmd` shim needs a shell, so its real
// `bin/claude.exe` is used instead (the hidden `/usage` run must never go through a shell, where
// MSYS / Git Bash would turn `/usage` into a path — claude-code-renewal.ts).
// Pure module (Node only): the Electron part (shell.openExternal) is passed in.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { LogFn } from './log';

export const CLAUDE_CODE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
/** Anthropic's native installers (setup page, 2026-09-28). */
export const INSTALL_COMMANDS = {
  windows: 'irm https://claude.ai/install.ps1 | iex',
  unix: 'curl -fsSL https://claude.ai/install.sh | bash',
} as const;
/** VS Code extension id; its URI handler `/open` opens a new Claude Code tab. */
const VSCODE_EXTENSION_PREFIX = 'anthropic.claude-code-';
/** Linux terminal emulators, most generic first, with how each takes a command. */
const LINUX_TERMINALS: ReadonlyArray<[string, string]> = [
  ['x-terminal-emulator', '-e'],
  ['gnome-terminal', '--'],
  ['konsole', '-e'],
  ['xfce4-terminal', '-e'],
  ['xterm', '-e'],
];
/** Environment variables that pass values to our terminal scripts (never inherited from elsewhere). */
const SCRIPT_ENV_PREFIX = 'CLAUDE_USAGE_';

export type LaunchPlan =
  | { kind: 'url'; via: 'vscode' | 'docs'; url: string }
  | {
      kind: 'spawn';
      via: 'terminal';
      command: string;
      args: string[];
      verbatim: boolean;
      /** Extra environment for the terminal (CLAUDE_CONFIG_DIR of an added folder, script values). */
      env?: Record<string, string>;
      /** A script to write first (macOS: Terminal doesn't inherit our environment; sign-in and install). */
      script?: { path: string; text: string };
      /** The spawned process lasts as long as the terminal window (Windows `start /wait`): its exit means the window was closed. */
      waits?: boolean;
    };

export interface LaunchFacts {
  platform: NodeJS.Platform;
  home: string;
  /** The added config folder whose account is shown, or null for the default account. */
  configDir: string | null;
  /** Where a launch script may be written. */
  tempDir: string;
  /** URL scheme of a VS Code with the Claude Code extension ('vscode' / 'vscode-insiders'), or null. */
  vscodeScheme: string | null;
  /** Absolute path of a Claude Code binary (findClaudeBinary), or null. */
  claudePath: string | null;
  /** Linux: first terminal emulator found, or null. */
  linuxTerminal: string | null;
}

const quoteWin = (value: string) => `"${value}"`;
/** Single-quoted for sh: every ' becomes '\'' */
const quoteSh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * VS Code first (where the owner's Claude Code lives), then a terminal with `claude`, else the setup
 * docs. An added config folder goes straight to the terminal, with CLAUDE_CONFIG_DIR set.
 */
export function planClaudeCodeLaunch(facts: LaunchFacts): LaunchPlan {
  const { configDir } = facts;
  if (facts.vscodeScheme && configDir === null) {
    return { kind: 'url', via: 'vscode', url: `${facts.vscodeScheme}://anthropic.claude-code/open` };
  }
  const claude = facts.claudePath;
  const env = configDir === null ? {} : { env: { CLAUDE_CONFIG_DIR: configDir } };
  if (claude && facts.platform === 'win32') {
    // `start` opens a new console window; the outer cmd only launches it. Verbatim arguments,
    // because Node's own quoting (\" escapes) is not what cmd.exe expects.
    return {
      kind: 'spawn',
      via: 'terminal',
      command: 'cmd.exe',
      args: ['/d', '/c', 'start', quoteWin('Claude Code'), '/d', quoteWin(facts.home), 'cmd.exe', '/k', quoteWin(claude)],
      verbatim: true,
      ...env,
    };
  }
  if (claude && facts.platform === 'darwin') {
    // Terminal runs the file in a new window (home folder); no Automation permission needed.
    if (configDir === null) return { kind: 'spawn', via: 'terminal', command: 'open', args: ['-a', 'Terminal', claude], verbatim: false };
    // Terminal starts its shells with its own environment, so a script sets the folder.
    const path = posix.join(facts.tempDir, 'claude-usage-open-claude-code.command');
    const text = [
      '#!/bin/sh',
      '# Written by Claude Usage: Claude Code for the account in another config folder.',
      'cd ~ || exit 1',
      `CLAUDE_CONFIG_DIR=${quoteSh(configDir)} exec ${quoteSh(claude)}`,
      '',
    ].join('\n');
    return { kind: 'spawn', via: 'terminal', command: 'open', args: ['-a', 'Terminal', path], verbatim: false, script: { path, text } };
  }
  const terminal = LINUX_TERMINALS.find(([name]) => name === facts.linuxTerminal);
  if (claude && terminal) {
    return { kind: 'spawn', via: 'terminal', command: terminal[0], args: [terminal[1], claude], verbatim: false, ...env };
  }
  return { kind: 'url', via: 'docs', url: CLAUDE_CODE_SETUP_URL };
}

// --- Sign in and install (Phase 8) -----------------------------------------------------------------

/** What a terminal window runs for the user. */
export type TerminalJob =
  /** `claude auth login` with a found Claude Code; `--email` prefilled when the account is known. */
  | { kind: 'sign-in'; claude: string; email: string | null }
  /** Anthropic's installer, then `claude auth login` with the installed binary (by its full path). */
  | { kind: 'install' };

export type TerminalFacts = Pick<LaunchFacts, 'platform' | 'home' | 'configDir' | 'tempDir' | 'linuxTerminal'>;

const JOB_TITLES: Record<TerminalJob['kind'], string> = { 'sign-in': 'Claude Code sign-in', install: 'Install Claude Code' };
const JOB_FILES: Record<TerminalJob['kind'], string> = { 'sign-in': 'claude-usage-sign-in', install: 'claude-usage-install-claude-code' };

/** An e-mail that is safe to hand to a script (no quotes, spaces or shell / cmd specials); else null. */
export function scriptSafeEmail(email: string | null): string | null {
  return email !== null && /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(email) ? email : null;
}

/**
 * The script for a Windows console window. Plain ASCII and nothing but references to environment
 * variables: batch files are read in the console's code page, and a folder or e-mail with `&`, `%`
 * or non-ASCII letters would break a command line built here. Delayed expansion (`!VAR!`) inserts
 * the values after cmd has parsed the line, so their characters are never interpreted.
 */
export function windowsJobScript(job: TerminalJob): string {
  const lines = [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    `rem Written by Claude Usage: ${job.kind === 'install' ? "installs Claude Code with Anthropic's installer, then signs in" : 'signs Claude Code in to your Claude account'}.`,
    `title ${JOB_TITLES[job.kind]}`,
    'cd /d "!USERPROFILE!"',
  ];
  if (job.kind === 'install') {
    lines.push(
      "echo Installing Claude Code with Anthropic's installer:",
      `echo   ${INSTALL_COMMANDS.windows.replace('|', '^|')}`,
      'echo.',
      `powershell.exe -NoProfile -Command "${INSTALL_COMMANDS.windows}"`,
      'set "CLAUDE_USAGE_CLAUDE=!USERPROFILE!\\.local\\bin\\claude.exe"',
      'if not exist "!CLAUDE_USAGE_CLAUDE!" (',
      '  echo.',
      `  echo Claude Code was not installed. Setup page: ${CLAUDE_CODE_SETUP_URL}`,
      '  echo.',
      '  pause',
      '  exit /b 1',
      ')',
      'echo.',
      'echo Claude Code is installed. Now sign in to your Claude account.',
    );
  }
  lines.push(
    'echo Claude Code opens your browser to sign in. If it asks for a code, paste it here.',
    'echo.',
    'if defined CLAUDE_USAGE_EMAIL (',
    '  "!CLAUDE_USAGE_CLAUDE!" auth login --email "!CLAUDE_USAGE_EMAIL!"',
    ') else (',
    '  "!CLAUDE_USAGE_CLAUDE!" auth login',
    ')',
    'echo.',
    'echo You can close this window.',
    'pause',
    '',
  );
  return lines.join('\r\n');
}

/** The script for a macOS / Linux terminal: sh, values single-quoted. */
export function shJobScript(job: TerminalJob, configDir: string | null): string {
  const lines = [
    '#!/bin/sh',
    `# Written by Claude Usage: ${job.kind === 'install' ? "installs Claude Code with Anthropic's installer, then signs in" : 'signs Claude Code in to your Claude account'}.`,
    'cd ~ || exit 1',
  ];
  if (configDir !== null) lines.push(`CLAUDE_CONFIG_DIR=${quoteSh(configDir)}`, 'export CLAUDE_CONFIG_DIR');
  const login = (claude: string) => {
    const email = job.kind === 'sign-in' ? scriptSafeEmail(job.email) : null;
    return `${claude} auth login${email ? ` --email ${quoteSh(email)}` : ''}`;
  };
  const signInNote = "echo 'Claude Code opens your browser to sign in. If it asks for a code, paste it here.'";
  if (job.kind === 'install') {
    lines.push(
      `echo ${quoteSh("Installing Claude Code with Anthropic's installer:")}`,
      `echo ${quoteSh(`  ${INSTALL_COMMANDS.unix}`)}`,
      'echo',
      `if ${INSTALL_COMMANDS.unix} && [ -x "$HOME/.local/bin/claude" ]; then`,
      "  echo; echo 'Claude Code is installed. Now sign in to your Claude account.'",
      `  ${signInNote}; echo`,
      `  ${login('"$HOME/.local/bin/claude"')}`,
      'else',
      `  echo; echo ${quoteSh(`Claude Code was not installed. Setup page: ${CLAUDE_CODE_SETUP_URL}`)}`,
      'fi',
    );
  } else {
    lines.push(signInNote, 'echo', login(quoteSh(job.claude)));
  }
  lines.push('echo', "printf 'Press Enter to close this window. '", 'read -r _', '');
  return lines.join('\n');
}

/**
 * A visible terminal that runs `job` for the account in `configDir` (null = the default account),
 * or null when there is no terminal to run it in (Linux without a known terminal emulator).
 */
export function planTerminalJob(facts: TerminalFacts, job: TerminalJob): LaunchPlan | null {
  const { configDir } = facts;
  if (facts.platform === 'win32') {
    const path = win32.join(facts.tempDir, `${JOB_FILES[job.kind]}.cmd`);
    const email = job.kind === 'sign-in' ? scriptSafeEmail(job.email) : null;
    const env: Record<string, string> = {
      CLAUDE_USAGE_SCRIPT: path,
      ...(job.kind === 'sign-in' ? { CLAUDE_USAGE_CLAUDE: job.claude } : {}),
      ...(email ? { CLAUDE_USAGE_EMAIL: email } : {}),
      ...(configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir }),
    };
    // The launcher cmd only starts the window and then waits for it (`start /wait`), so its exit
    // tells when the window was closed. `/v:on` inserts the script's path after parsing (`!…!`).
    return {
      kind: 'spawn',
      via: 'terminal',
      command: 'cmd.exe',
      args: ['/d', '/v:on', '/c', 'start', quoteWin(JOB_TITLES[job.kind]), '/wait', 'cmd.exe', '/d', '/c', 'call', '"!CLAUDE_USAGE_SCRIPT!"'],
      verbatim: true,
      env,
      script: { path, text: windowsJobScript(job) },
      waits: true,
    };
  }
  if (facts.platform === 'darwin') {
    const path = posix.join(facts.tempDir, `${JOB_FILES[job.kind]}.command`);
    return { kind: 'spawn', via: 'terminal', command: 'open', args: ['-a', 'Terminal', path], verbatim: false, script: { path, text: shJobScript(job, configDir) } };
  }
  const terminal = LINUX_TERMINALS.find(([name]) => name === facts.linuxTerminal);
  if (!terminal) return null;
  const path = posix.join(facts.tempDir, `${JOB_FILES[job.kind]}.sh`);
  return { kind: 'spawn', via: 'terminal', command: terminal[0], args: [terminal[1], path], verbatim: false, script: { path, text: shJobScript(job, configDir) } };
}

// --- Finding Claude Code ---------------------------------------------------------------------------

/**
 * First existing `name` in the PATH folders (then the extra folders), trying PATHEXT on Windows.
 * PATH is split by the given platform's separator (not path.delimiter) so tests can pass any OS's PATH.
 */
export function findExecutable(
  name: string,
  options: { platform: NodeJS.Platform; pathEnv: string; pathExt?: string; extraDirs?: readonly string[] },
  exists: (file: string) => boolean = existsSync,
): string | null {
  const win = options.platform === 'win32';
  const path = win ? win32 : posix;
  const exts = win ? (options.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of searchDirs(options.platform, options.pathEnv, options.extraDirs)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (exists(file)) return file;
    }
  }
  return null;
}

function searchDirs(platform: NodeJS.Platform, pathEnv: string, extraDirs: readonly string[] = []): string[] {
  const dirs = [...pathEnv.split(platform === 'win32' ? ';' : ':'), ...extraDirs];
  return dirs.filter((d) => d.trim() !== '').map((d) => d.replace(/^"|"$/g, ''));
}

/** Where installers put `claude` when it may not be on a GUI app's PATH (or the app started before the install). */
export function claudeExtraDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
    return [
      win32.join(home, '.local', 'bin'), // native installer
      win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'npm'), // npm install -g
      win32.join(localAppData, 'Microsoft', 'WinGet', 'Links'), // winget
    ];
  }
  return [posix.join(home, '.local', 'bin'), posix.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
}

export interface BinaryLookup {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists?: (file: string) => boolean;
  listDir?: (dir: string) => string[];
}

/**
 * A Claude Code that can be started directly, without a shell: `claude.exe` (native installer,
 * WinGet) or the real binary behind npm's `claude.cmd` shim on Windows; `claude` elsewhere; else the
 * binary bundled in the newest Claude Code extension for VS Code (D53). Null when none is found.
 */
export function findClaudeBinary(lookup: BinaryLookup): string | null {
  const { platform, env, home } = lookup;
  const exists = lookup.exists ?? existsSync;
  const win = platform === 'win32';
  const path = win ? win32 : posix;
  for (const dir of searchDirs(platform, env.PATH ?? env.Path ?? '', claudeExtraDirs(platform, env, home))) {
    if (!win) {
      const file = path.join(dir, 'claude');
      if (exists(file)) return file;
      continue;
    }
    const exe = path.join(dir, 'claude.exe');
    if (exists(exe)) return exe;
    // npm's shim `claude.cmd` runs this binary (packages since the native build); older packages
    // run `node cli.js` and are skipped.
    if (exists(path.join(dir, 'claude.cmd'))) {
      const real = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(real)) return real;
    }
  }
  return findExtensionClaude(platform, home, lookup.listDir, exists);
}

const VSCODE_FOLDERS = [
  ['.vscode', 'vscode'],
  ['.vscode-insiders', 'vscode-insiders'],
] as const;

/**
 * Editors whose Claude Code extension ships its own Claude Code binary: VS Code first, then the VS
 * Code-based editors Cursor, Windsurf and VSCodium (D72). Only their binary is used (in a terminal,
 * for sign-in and renewal) — *Open Claude Code*'s editor route stays VS Code's.
 */
const EXTENSION_FOLDERS: readonly string[] = [...VSCODE_FOLDERS.map(([folder]) => folder), '.cursor', '.windsurf', '.vscode-oss'];

/** 'vscode' / 'vscode-insiders' when that VS Code has the Claude Code extension installed. */
export function findVsCodeScheme(home: string, listDir: (dir: string) => string[] = safeReadDir): string | null {
  for (const [folder, scheme] of VSCODE_FOLDERS) {
    const dir = (home.includes('\\') ? win32 : posix).join(home, folder, 'extensions');
    if (listDir(dir).some((entry) => entry.startsWith(VSCODE_EXTENSION_PREFIX))) return scheme;
  }
  return null;
}

/** "anthropic.claude-code-2.1.282-win32-x64" → [2, 1, 282]; null for anything else. */
function extensionVersion(entry: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(entry.slice(VSCODE_EXTENSION_PREFIX.length));
  return entry.startsWith(VSCODE_EXTENSION_PREFIX) && match ? match.slice(1).map(Number) : null;
}

/**
 * The `claude` binary inside the newest Claude Code extension for VS Code (or Cursor, Windsurf,
 * VSCodium), for a terminal when the command-line tool isn't installed (the extension ships its own
 * copy of Claude Code).
 */
export function findExtensionClaude(
  platform: NodeJS.Platform,
  home: string,
  listDir: (dir: string) => string[] = safeReadDir,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const path = platform === 'win32' ? win32 : posix;
  const byVersion = (a: number[], b: number[]) => a.map((n, i) => n - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;
  for (const folder of EXTENSION_FOLDERS) {
    const extensions = path.join(home, folder, 'extensions');
    const newestFirst = listDir(extensions)
      .flatMap((entry) => {
        const version = extensionVersion(entry);
        return version ? [{ entry, version }] : [];
      })
      .sort((a, b) => byVersion(b.version, a.version));
    for (const { entry } of newestFirst) {
      const file = path.join(extensions, entry, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude');
      if (exists(file)) return file;
    }
  }
  return null;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Linux: the first terminal emulator on PATH; null elsewhere or when none is found. */
export function findLinuxTerminal(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (platform !== 'linux') return null;
  const pathEnv = env.PATH ?? '';
  return LINUX_TERMINALS.find(([name]) => findExecutable(name, { platform, pathEnv }) !== null)?.[0] ?? null;
}

export function gatherLaunchFacts(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  configDir: string | null,
  tempDir: string,
): LaunchFacts {
  return {
    platform,
    home,
    configDir,
    tempDir,
    vscodeScheme: findVsCodeScheme(home),
    claudePath: findClaudeBinary({ platform, env, home }),
    linuxTerminal: findLinuxTerminal(platform, env),
  };
}

/**
 * Carries out a plan; `what` names it in the log. `openExternal` is Electron's shell.openExternal.
 * Returns the spawned process (its exit is the terminal window's when `plan.waits`), or null for a URL.
 */
export async function runLaunchPlan(
  plan: LaunchPlan,
  what: string,
  openExternal: (url: string) => Promise<void>,
  log: LogFn,
): Promise<ChildProcess | null> {
  log('info', `${what} → ${plan.via}${plan.kind === 'spawn' ? ` (${plan.command})` : ''}`);
  if (plan.kind === 'url') {
    await openExternal(plan.url);
    return null;
  }
  if (plan.script) {
    writeFileSync(plan.script.path, plan.script.text, { mode: 0o700 });
    chmodSync(plan.script.path, 0o700); // an older copy would keep its mode
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // never hand this Electron-only switch to another program
  for (const name of Object.keys(env)) if (name.startsWith(SCRIPT_ENV_PREFIX)) delete env[name];
  Object.assign(env, plan.env);
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: 'ignore',
    env,
    windowsVerbatimArguments: plan.verbatim,
    windowsHide: true, // hides only the launcher cmd.exe; `start` opens its own visible window
  });
  child.on('error', (err) => log('warn', `${what} failed: ${err.message}`));
  child.unref();
  return child;
}
