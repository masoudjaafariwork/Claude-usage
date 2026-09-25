import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CODE_SETUP_URL,
  claudeExtraDirs,
  findExecutable,
  findVsCodeScheme,
  planClaudeCodeLaunch,
  type LaunchFacts,
} from './claude-code-launcher';

const facts = (overrides: Partial<LaunchFacts>): LaunchFacts => ({
  platform: 'win32',
  home: 'C:\\Users\\Jane Doe',
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
