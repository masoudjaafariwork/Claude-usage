// "Open Claude Code" (banner button / menu): opens the user's own Claude Code so that Claude Code
// itself renews its sign-in — it refreshes an expired token when a session starts in a trusted
// folder, and it coordinates refreshes between its own processes with a lock. This app still never
// refreshes or writes the token (D3); it only runs on the user's click and sends no prompt.
// For an added config folder (another account) Claude Code must run with CLAUDE_CONFIG_DIR set, so
// the VS Code route (which opens the default profile's account) is skipped for it.
// Pure module (Node only): the Electron part (shell.openExternal) is passed in.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { LogFn } from './log';

export const CLAUDE_CODE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
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

export type LaunchPlan =
  | { kind: 'url'; via: 'vscode' | 'docs'; url: string }
  | {
      kind: 'spawn';
      via: 'terminal';
      command: string;
      args: string[];
      verbatim: boolean;
      /** Extra environment for the terminal (CLAUDE_CONFIG_DIR of an added folder). */
      env?: Record<string, string>;
      /** A shell script to write first (macOS: Terminal doesn't inherit our environment). */
      script?: { path: string; text: string };
    };

export interface LaunchFacts {
  platform: NodeJS.Platform;
  home: string;
  /** The added config folder whose account is shown, or null for the default account. */
  configDir: string | null;
  /** Where a macOS launch script may be written. */
  tempDir: string;
  /** URL scheme of a VS Code with the Claude Code extension ('vscode' / 'vscode-insiders'), or null. */
  vscodeScheme: string | null;
  /** Absolute path of the `claude` command, or null. */
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
  const dirs = [...options.pathEnv.split(win ? ';' : ':'), ...(options.extraDirs ?? [])].filter((d) => d.trim() !== '');
  const exts = win ? (options.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      if (exists(file)) return file;
    }
  }
  return null;
}

/** Where installers put `claude` when it may not be on a GUI app's PATH. */
export function claudeExtraDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    return [win32.join(home, '.local', 'bin'), win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'npm')];
  }
  return [posix.join(home, '.local', 'bin'), posix.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
}

const VSCODE_FOLDERS = [
  ['.vscode', 'vscode'],
  ['.vscode-insiders', 'vscode-insiders'],
] as const;

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
 * The `claude` binary inside the newest Claude Code extension for VS Code, for a terminal when the
 * command-line tool isn't installed (the extension ships its own copy of Claude Code).
 */
export function findExtensionClaude(
  platform: NodeJS.Platform,
  home: string,
  listDir: (dir: string) => string[] = safeReadDir,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const path = platform === 'win32' ? win32 : posix;
  const byVersion = (a: number[], b: number[]) => a.map((n, i) => n - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;
  for (const [folder] of VSCODE_FOLDERS) {
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

export function gatherLaunchFacts(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  configDir: string | null,
  tempDir: string,
): LaunchFacts {
  const pathEnv = env.PATH ?? env.Path ?? '';
  const claudePath =
    findExecutable('claude', { platform, pathEnv, pathExt: env.PATHEXT, extraDirs: claudeExtraDirs(platform, env, home) }) ??
    findExtensionClaude(platform, home);
  const linuxTerminal =
    platform === 'linux' ? (LINUX_TERMINALS.find(([name]) => findExecutable(name, { platform, pathEnv }) !== null)?.[0] ?? null) : null;
  return { platform, home, configDir, tempDir, vscodeScheme: findVsCodeScheme(home), claudePath, linuxTerminal };
}

/** Carries out a plan. `openExternal` is Electron's shell.openExternal. */
export async function launchClaudeCode(plan: LaunchPlan, openExternal: (url: string) => Promise<void>, log: LogFn): Promise<void> {
  log('info', `Open Claude Code → ${plan.via}${plan.kind === 'spawn' ? ` (${plan.command})` : ''}`);
  if (plan.kind === 'url') {
    await openExternal(plan.url);
    return;
  }
  if (plan.script) {
    writeFileSync(plan.script.path, plan.script.text, { mode: 0o700 });
    chmodSync(plan.script.path, 0o700); // an older copy would keep its mode
  }
  const env = { ...process.env, ...plan.env };
  delete env.ELECTRON_RUN_AS_NODE; // never hand this Electron-only switch to another program
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: 'ignore',
    env,
    windowsVerbatimArguments: plan.verbatim,
    windowsHide: true, // hides only the launcher cmd.exe; `start` opens its own visible window
  });
  child.on('error', (err) => log('warn', `Open Claude Code failed: ${err.message}`));
  child.unref();
}
