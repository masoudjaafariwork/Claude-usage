import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CODE_SETUP_URL,
  claudeExtraDirs,
  findExecutable,
  findExtensionClaude,
  findVsCodeScheme,
  planClaudeCodeLaunch,
  type LaunchFacts,
} from './claude-code-launcher';

const facts = (overrides: Partial<LaunchFacts>): LaunchFacts => ({
  platform: 'win32',
  home: 'C:\\Users\\Jane Doe',
  configDir: null,
  tempDir: 'C:\\Temp',
  vscodeScheme: null,
  claudePath: null,
  linuxTerminal: null,
  ...overrides,
});

test('VS Code with the Claude Code extension wins: its /open URI starts a Claude Code tab', () => {
  assert.deepEqual(planClaudeCodeLaunch(facts({ vscodeScheme: 'vscode', claudePath: 'C:\\x\\claude.exe' })), {
    kind: 'url',
    via: 'vscode',
    url: 'vscode://anthropic.claude-code/open',
  });
  assert.equal(
    (planClaudeCodeLaunch(facts({ vscodeScheme: 'vscode-insiders' })) as { url: string }).url,
    'vscode-insiders://anthropic.claude-code/open',
  );
});

test('Windows: a new console window runs claude in the home folder (cmd.exe quoting, verbatim)', () => {
  const plan = planClaudeCodeLaunch(facts({ claudePath: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd' }));
  assert.equal(plan.kind, 'spawn');
  if (plan.kind !== 'spawn') return;
  assert.equal(plan.verbatim, true);
  assert.equal(
    [plan.command, ...plan.args].join(' '),
    'cmd.exe /d /c start "Claude Code" /d "C:\\Users\\Jane Doe" cmd.exe /k "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd"',
  );
});

test('macOS: Terminal opens the claude file; Linux: the first terminal emulator with its own flag', () => {
  assert.deepEqual(planClaudeCodeLaunch(facts({ platform: 'darwin', home: '/Users/j', claudePath: '/opt/homebrew/bin/claude' })), {
    kind: 'spawn',
    via: 'terminal',
    command: 'open',
    args: ['-a', 'Terminal', '/opt/homebrew/bin/claude'],
    verbatim: false,
  });
  const linux = (terminal: string) =>
    planClaudeCodeLaunch(facts({ platform: 'linux', home: '/home/j', claudePath: '/home/j/.local/bin/claude', linuxTerminal: terminal }));
  assert.deepEqual((linux('gnome-terminal') as { args: string[] }).args, ['--', '/home/j/.local/bin/claude']);
  assert.deepEqual((linux('x-terminal-emulator') as { args: string[] }).args, ['-e', '/home/j/.local/bin/claude']);
});

test('an added config folder skips VS Code (its default account) and runs claude with CLAUDE_CONFIG_DIR', () => {
  const win = planClaudeCodeLaunch(facts({ vscodeScheme: 'vscode', claudePath: 'C:\\npm\\claude.cmd', configDir: 'D:\\Revaal\\claude-config' }));
  assert.equal(win.kind, 'spawn');
  if (win.kind !== 'spawn') return;
  assert.equal(win.command, 'cmd.exe');
  assert.deepEqual(win.env, { CLAUDE_CONFIG_DIR: 'D:\\Revaal\\claude-config' });

  const linux = planClaudeCodeLaunch(
    facts({ platform: 'linux', home: '/home/j', claudePath: '/usr/bin/claude', linuxTerminal: 'konsole', configDir: '/home/j/work' }),
  );
  assert.deepEqual(linux.kind === 'spawn' && [linux.command, linux.args, linux.env], ['konsole', ['-e', '/usr/bin/claude'], { CLAUDE_CONFIG_DIR: '/home/j/work' }]);

  // macOS: Terminal doesn't inherit the environment, so a .command script sets it.
  const mac = planClaudeCodeLaunch(facts({ platform: 'darwin', home: '/Users/j', tempDir: '/tmp', claudePath: '/opt/homebrew/bin/claude', configDir: "/Users/j/Jane's claude" }));
  assert.equal(mac.kind, 'spawn');
  if (mac.kind !== 'spawn') return;
  assert.deepEqual(mac.args, ['-a', 'Terminal', '/tmp/claude-usage-open-claude-code.command']);
  assert.equal(mac.script?.path, '/tmp/claude-usage-open-claude-code.command');
  assert.ok(mac.script?.text.startsWith('#!/bin/sh\n'));
  assert.ok(mac.script?.text.includes(`CLAUDE_CONFIG_DIR='/Users/j/Jane'\\''s claude' exec '/opt/homebrew/bin/claude'`));
  assert.equal(mac.env, undefined);

  // No claude to run: the setup page, never the VS Code route of the wrong account.
  assert.equal(planClaudeCodeLaunch(facts({ vscodeScheme: 'vscode', configDir: 'D:\\x' })).kind, 'url');
  assert.equal((planClaudeCodeLaunch(facts({ vscodeScheme: 'vscode', configDir: 'D:\\x' })) as { via: string }).via, 'docs');
});

test('findExtensionClaude picks the newest extension that ships a claude binary', () => {
  const ext = 'C:\\Users\\j\\.vscode\\extensions';
  const entries = ['anthropic.claude-code-2.1.99-win32-x64', 'anthropic.claude-code-2.1.282-win32-x64', 'anthropic.claude-code-2.1.300-win32-x64', 'ms-python.python-1.0.0'];
  const present = new Set([`${ext}\\anthropic.claude-code-2.1.282-win32-x64\\resources\\native-binary\\claude.exe`, `${ext}\\anthropic.claude-code-2.1.99-win32-x64\\resources\\native-binary\\claude.exe`]);
  assert.equal(
    findExtensionClaude('win32', 'C:\\Users\\j', (dir) => (dir === ext ? entries : []), (file) => present.has(file)),
    `${ext}\\anthropic.claude-code-2.1.282-win32-x64\\resources\\native-binary\\claude.exe`,
    '2.1.300 has no binary; 2.1.282 is newer than 2.1.99',
  );
  assert.equal(findExtensionClaude('linux', '/home/j', () => []), null);
});

test('nothing found (or Linux without a terminal) → the Claude Code setup page', () => {
  assert.deepEqual(planClaudeCodeLaunch(facts({})), { kind: 'url', via: 'docs', url: CLAUDE_CODE_SETUP_URL });
  assert.equal(planClaudeCodeLaunch(facts({ platform: 'linux', claudePath: '/usr/bin/claude' })).kind, 'url');
});

test('findExecutable walks PATH, then the extra folders, and tries PATHEXT on Windows', () => {
  const files = new Set(['C:\\tools\\claude.CMD'.toLowerCase(), '/home/j/.local/bin/claude']);
  const exists = (file: string) => files.has(file.toLowerCase()) || files.has(file);
  assert.equal(
    findExecutable('claude', { platform: 'win32', pathEnv: 'C:\\Windows;"C:\\tools"', pathExt: '.EXE;.CMD' }, exists),
    'C:\\tools\\claude.cmd',
  );
  assert.equal(findExecutable('claude', { platform: 'linux', pathEnv: '/usr/bin:/bin' }, exists), null);
  assert.equal(
    findExecutable('claude', { platform: 'linux', pathEnv: '/usr/bin', extraDirs: claudeExtraDirs('linux', {}, '/home/j') }, exists),
    '/home/j/.local/bin/claude',
  );
});

test('claudeExtraDirs knows the native installer and npm folders', () => {
  assert.deepEqual(claudeExtraDirs('win32', { APPDATA: 'C:\\Users\\j\\AppData\\Roaming' }, 'C:\\Users\\j'), [
    'C:\\Users\\j\\.local\\bin',
    'C:\\Users\\j\\AppData\\Roaming\\npm',
  ]);
  assert.ok(claudeExtraDirs('darwin', {}, '/Users/j').includes('/opt/homebrew/bin'));
});

test('findVsCodeScheme looks for the anthropic.claude-code extension folder', () => {
  const dirs: Record<string, string[]> = {
    'C:\\Users\\j\\.vscode\\extensions': ['ms-python.python-2026.1.0', 'anthropic.claude-code-2.1.282-win32-x64'],
  };
  assert.equal(findVsCodeScheme('C:\\Users\\j', (dir) => dirs[dir] ?? []), 'vscode');
  assert.equal(findVsCodeScheme('/home/j', () => []), null);
  assert.equal(
    findVsCodeScheme('/home/j', (dir) => (dir === '/home/j/.vscode-insiders/extensions' ? ['anthropic.claude-code-2.1.0'] : [])),
    'vscode-insiders',
  );
});
