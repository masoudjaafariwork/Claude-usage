import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CODE_SETUP_URL,
  INSTALL_COMMANDS,
  claudeExtraDirs,
  findClaudeBinary,
  findExecutable,
  findExtensionClaude,
  findVsCodeScheme,
  planClaudeCodeLaunch,
  planTerminalJob,
  scriptSafeEmail,
  shJobScript,
  windowsJobScript,
  type LaunchFacts,
  type TerminalFacts,
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
    'C:\\Users\\j\\AppData\\Local\\Microsoft\\WinGet\\Links',
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

// --- Phase 8: a Claude Code to run directly, sign-in and install terminals ---------------------------

test('findClaudeBinary: claude.exe on PATH, else the real binary behind npm’s claude.cmd shim — never the shim', () => {
  const npm = 'C:\\Users\\j\\AppData\\Roaming\\npm';
  const real = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const env = { PATH: `C:\\Windows;${npm}`, APPDATA: 'C:\\Users\\j\\AppData\\Roaming' };
  const lookup = (files: string[]) =>
    findClaudeBinary({ platform: 'win32', env, home: 'C:\\Users\\j', exists: (f) => files.includes(f), listDir: () => [] });
  assert.equal(lookup([`${npm}\\claude.cmd`, real]), real);
  assert.equal(lookup([`${npm}\\claude.cmd`]), null, 'an old npm package (node cli.js) is skipped');
  assert.equal(lookup([`${npm}\\claude.cmd`, real, 'C:\\Windows\\claude.exe']), 'C:\\Windows\\claude.exe', 'PATH order');
  // Not on PATH (the app started before the install): the native installer's folder.
  assert.equal(lookup(['C:\\Users\\j\\.local\\bin\\claude.exe']), 'C:\\Users\\j\\.local\\bin\\claude.exe');
});

test('findExtensionClaude also finds the extension in Cursor, Windsurf and VSCodium — VS Code first (D72)', () => {
  const home = 'C:\\Users\\j';
  const entry = 'anthropic.claude-code-2.1.283-win32-x64';
  const binary = (folder: string) => `${home}\\${folder}\\extensions\\${entry}\\resources\\native-binary\\claude.exe`;
  const lookup = (folders: string[]) =>
    findExtensionClaude(
      'win32',
      home,
      (dir) => (folders.some((f) => dir === `${home}\\${f}\\extensions`) ? [entry] : []),
      (file) => folders.some((f) => file === binary(f)),
    );
  assert.equal(lookup(['.cursor']), binary('.cursor'));
  assert.equal(lookup(['.windsurf']), binary('.windsurf'));
  assert.equal(lookup(['.vscode-oss']), binary('.vscode-oss'));
  assert.equal(lookup(['.cursor', '.vscode']), binary('.vscode'), 'VS Code first');
  // Open Claude Code's editor route stays VS Code's: Cursor alone gives no URL scheme.
  assert.equal(findVsCodeScheme(home, (dir) => (dir === `${home}\\.cursor\\extensions` ? [entry] : [])), null);
});

test('findClaudeBinary falls back to the VS Code extension’s binary; Unix looks for claude', () => {
  const ext = '/home/j/.vscode/extensions';
  const bundled = `${ext}/anthropic.claude-code-2.1.283-linux-x64/resources/native-binary/claude`;
  assert.equal(
    findClaudeBinary({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      home: '/home/j',
      exists: (f) => f === bundled,
      listDir: (d) => (d === ext ? ['anthropic.claude-code-2.1.283-linux-x64'] : []),
    }),
    bundled,
  );
  assert.equal(
    findClaudeBinary({ platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/j', exists: (f) => f === '/opt/homebrew/bin/claude', listDir: () => [] }),
    '/opt/homebrew/bin/claude',
  );
});

const terminal = (overrides: Partial<TerminalFacts>): TerminalFacts => ({
  platform: 'win32',
  home: 'C:\\Users\\Jane Doe',
  configDir: null,
  tempDir: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp',
  linuxTerminal: null,
  ...overrides,
});

test('Windows sign-in: a waited-for console window runs an ASCII script; values only through the environment', () => {
  const claude = 'C:\\Users\\Jane Doe\\.local\\bin\\claude.exe';
  const plan = planTerminalJob(terminal({ configDir: 'D:\\Ärger & Co\\claude' }), { kind: 'sign-in', claude, email: 'jane@example.com' });
  assert.ok(plan && plan.kind === 'spawn');
  if (!plan || plan.kind !== 'spawn') return;
  assert.equal(plan.waits, true, 'start /wait: the launcher exits when the window is closed');
  assert.equal(plan.verbatim, true);
  assert.equal(
    [plan.command, ...plan.args].join(' '),
    'cmd.exe /d /v:on /c start "Claude Code sign-in" /wait cmd.exe /d /c call "!CLAUDE_USAGE_SCRIPT!"',
    'nothing from the user in the command line',
  );
  assert.deepEqual(plan.env, {
    CLAUDE_USAGE_SCRIPT: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\claude-usage-sign-in.cmd',
    CLAUDE_USAGE_CLAUDE: claude,
    CLAUDE_USAGE_EMAIL: 'jane@example.com',
    CLAUDE_CONFIG_DIR: 'D:\\Ärger & Co\\claude',
  });
  const script = plan.script?.text ?? '';
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(script), 'plain ASCII (cmd reads it in the console code page)');
  assert.ok(script.includes('"!CLAUDE_USAGE_CLAUDE!" auth login --email "!CLAUDE_USAGE_EMAIL!"'));
  assert.ok(script.includes('setlocal EnableDelayedExpansion'));
  assert.ok(script.includes('\r\n'), 'CRLF line ends');
});

test('Windows install: Anthropic’s installer, then the installed binary signs in', () => {
  const plan = planTerminalJob(terminal({}), { kind: 'install' });
  assert.ok(plan && plan.kind === 'spawn');
  if (!plan || plan.kind !== 'spawn') return;
  assert.deepEqual(plan.env, { CLAUDE_USAGE_SCRIPT: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\claude-usage-install-claude-code.cmd' });
  const script = windowsJobScript({ kind: 'install' });
  assert.ok(script.includes(`powershell.exe -NoProfile -Command "${INSTALL_COMMANDS.windows}"`));
  assert.ok(script.includes('set "CLAUDE_USAGE_CLAUDE=!USERPROFILE!\\.local\\bin\\claude.exe"'));
  assert.ok(script.indexOf('install.ps1 | iex"') < script.indexOf('auth login'), 'installer first, then the sign-in');
  assert.ok(!script.includes('ExecutionPolicy'), 'the official command as it is');
});

test('macOS / Linux: a script sets the folder, prefills the e-mail and waits for Enter', () => {
  const mac = planTerminalJob(terminal({ platform: 'darwin', home: '/Users/j', tempDir: '/tmp', configDir: "/Users/j/Jane's" }), {
    kind: 'sign-in',
    claude: '/Users/j/.local/bin/claude',
    email: 'j@example.com',
  });
  assert.ok(mac && mac.kind === 'spawn');
  if (!mac || mac.kind !== 'spawn') return;
  assert.deepEqual([mac.command, ...mac.args], ['open', '-a', 'Terminal', '/tmp/claude-usage-sign-in.command']);
  const text = mac.script?.text ?? '';
  assert.ok(text.includes("CLAUDE_CONFIG_DIR='/Users/j/Jane'\\''s'\nexport CLAUDE_CONFIG_DIR"));
  assert.ok(text.includes("'/Users/j/.local/bin/claude' auth login --email 'j@example.com'"));
  assert.ok(text.includes('read -r _'));
  assert.ok(!mac.waits);

  const linux = planTerminalJob(terminal({ platform: 'linux', home: '/home/j', tempDir: '/tmp', linuxTerminal: 'gnome-terminal' }), { kind: 'install' });
  assert.ok(linux && linux.kind === 'spawn');
  if (!linux || linux.kind !== 'spawn') return;
  assert.deepEqual([linux.command, ...linux.args], ['gnome-terminal', '--', '/tmp/claude-usage-install-claude-code.sh']);
  assert.ok(shJobScript({ kind: 'install' }, null).includes(`if ${INSTALL_COMMANDS.unix} && [ -x "$HOME/.local/bin/claude" ]; then`));
  assert.ok(shJobScript({ kind: 'install' }, null).includes('"$HOME/.local/bin/claude" auth login'));
  assert.equal(planTerminalJob(terminal({ platform: 'linux', home: '/home/j', tempDir: '/tmp' }), { kind: 'install' }), null, 'no terminal found');
});

test('scriptSafeEmail passes plain addresses only', () => {
  assert.equal(scriptSafeEmail('ada.lovelace+work@analytical-engines.example'), 'ada.lovelace+work@analytical-engines.example');
  for (const bad of ['a"b@x.com', 'a&b@x.com', 'a b@x.com', "a'b@x.com", 'no-at-sign', '%PATH%@x.com']) assert.equal(scriptSafeEmail(bad), null, bad);
  assert.equal(scriptSafeEmail(null), null);
});

