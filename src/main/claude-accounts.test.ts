import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  MAX_FOLDERS,
  accountMenuEntries,
  accountStateKey,
  chooseFolder,
  claudeCodeLocation,
  configDirArg,
  folderLabel,
  normalizeFolder,
  sameFolder,
} from './claude-accounts';

const WIN_HOME = 'C:\\Users\\ada';

test('the default account: ~/.claude, ~/.claude.json and the plain Keychain name', () => {
  assert.deepEqual(claudeCodeLocation(null, 'win32', {}, WIN_HOME), {
    dir: 'C:\\Users\\ada\\.claude',
    accountFile: 'C:\\Users\\ada\\.claude.json',
    keychainService: 'Claude Code-credentials',
  });
  assert.deepEqual(claudeCodeLocation(null, 'darwin', { CLAUDE_CONFIG_DIR: '  ' }, '/Users/ada'), {
    dir: '/Users/ada/.claude',
    accountFile: '/Users/ada/.claude.json',
    keychainService: 'Claude Code-credentials',
  });
});

test('a config folder keeps both files inside it and hashes its name into the Keychain service', () => {
  const hash = createHash('sha256').update('/Users/ada/work-claude').digest('hex').slice(0, 8);
  const expected = {
    dir: '/Users/ada/work-claude',
    accountFile: '/Users/ada/work-claude/.claude.json',
    keychainService: `Claude Code-credentials-${hash}`,
  };
  assert.deepEqual(claudeCodeLocation('/Users/ada/work-claude', 'darwin', {}, '/Users/ada'), expected);
  // The app's own CLAUDE_CONFIG_DIR is the default account…
  assert.deepEqual(claudeCodeLocation(null, 'darwin', { CLAUDE_CONFIG_DIR: '/Users/ada/work-claude' }, '/Users/ada'), expected);
  // …and an added folder wins over it.
  assert.equal(claudeCodeLocation('D:\\Revaal\\claude-config', 'win32', { CLAUDE_CONFIG_DIR: 'E:\\x' }, WIN_HOME).dir, 'D:\\Revaal\\claude-config');
});

test('folders compare resolved, without trailing separators, ignoring case on Windows and macOS', () => {
  assert.equal(normalizeFolder('D:\\Revaal\\claude-config\\', 'win32'), 'D:\\Revaal\\claude-config');
  assert.equal(normalizeFolder('D:\\', 'win32'), 'D:\\');
  assert.equal(normalizeFolder('/', 'linux'), '/');
  assert.equal(normalizeFolder('cfg', 'linux', '/home/ada'), '/home/ada/cfg');
  assert.ok(sameFolder('d:\\revaal\\Claude-Config', 'D:\\Revaal\\claude-config\\', 'win32'));
  assert.ok(sameFolder('D:/Revaal/claude-config', 'D:\\Revaal\\claude-config', 'win32'));
  assert.ok(!sameFolder('/home/ada/Cfg', '/home/ada/cfg', 'linux'));
  assert.equal(accountStateKey('D:\\Revaal\\claude-config', 'win32'), accountStateKey('d:\\revaal\\claude-config\\', 'win32'));
  assert.notEqual(accountStateKey('D:\\A', 'win32'), accountStateKey('D:\\B', 'win32'));
  assert.match(accountStateKey('D:\\A', 'win32'), /^[0-9a-f]{12}$/);
});

test('choosing a folder: the default one selects the default entry, a known one is reused, a new one added', () => {
  const dirs = ['D:\\Revaal\\claude-config'];
  const def = 'C:\\Users\\ada\\.claude';
  assert.deepEqual(chooseFolder(dirs, null, def, 'win32'), { claudeCodeDirs: dirs, claudeCodeDir: null });
  assert.deepEqual(chooseFolder(dirs, 'c:\\users\\ada\\.claude\\', def, 'win32'), { claudeCodeDirs: dirs, claudeCodeDir: null });
  assert.deepEqual(chooseFolder(dirs, 'd:\\revaal\\claude-config', def, 'win32'), { claudeCodeDirs: dirs, claudeCodeDir: 'D:\\Revaal\\claude-config' });
  assert.deepEqual(chooseFolder(dirs, 'E:\\work', def, 'win32'), { claudeCodeDirs: [...dirs, 'E:\\work'], claudeCodeDir: 'E:\\work' });
  const full = Array.from({ length: MAX_FOLDERS }, (_, i) => `D:\\a${i}`);
  const added = chooseFolder(full, 'E:\\new', def, 'win32');
  assert.equal(added.claudeCodeDirs.length, MAX_FOLDERS);
  assert.equal(added.claudeCodeDirs.at(-1), 'E:\\new', 'the oldest folder makes room');
});

test('folder labels use ~ for the home folder and cut very long paths in the middle', () => {
  assert.equal(folderLabel('C:\\Users\\ada\\.claude', WIN_HOME, 'win32'), '~\\.claude');
  assert.equal(folderLabel('c:\\users\\ADA', WIN_HOME, 'win32'), '~');
  assert.equal(folderLabel('C:\\Users\\adam\\.claude', WIN_HOME, 'win32'), 'C:\\Users\\adam\\.claude');
  assert.equal(folderLabel('/home/ada/cfg', '/home/ada', 'linux'), '~/cfg');
  const long = `D:\\${'very-long-folder-name\\'.repeat(5)}claude-config`;
  const label = folderLabel(long, WIN_HOME, 'win32');
  assert.equal(Array.from(label).length, 60);
  assert.ok(label.startsWith('D:\\very') && label.endsWith('claude-config') && label.includes('…'));
});

test('account menu entries: default first, e-mails only when known and shown', () => {
  const input = {
    dirs: ['D:\\Revaal\\claude-config', 'E:\\other'],
    selected: 'D:\\Revaal\\claude-config',
    defaultDir: 'C:\\Users\\ada\\.claude',
    emailOf: (dir: string | null) => (dir === null ? 'ada@example.com' : dir.startsWith('D:') ? 'ops@revaal.example' : null),
    showEmail: true,
    home: WIN_HOME,
    platform: 'win32' as const,
  };
  assert.deepEqual(accountMenuEntries(input), [
    { dir: null, label: 'ada@example.com — ~\\.claude (default)', selected: false },
    { dir: 'D:\\Revaal\\claude-config', label: 'ops@revaal.example — D:\\Revaal\\claude-config', selected: true },
    { dir: 'E:\\other', label: 'E:\\other', selected: false },
  ]);
  assert.deepEqual(
    accountMenuEntries({ ...input, selected: null, showEmail: false }).map((e) => [e.label, e.selected]),
    [
      ['~\\.claude (default)', true],
      ['D:\\Revaal\\claude-config', false],
      ['E:\\other', false],
    ],
  );
});

test('--claude-config-dir: a folder (resolved), default, or nothing', () => {
  assert.equal(configDirArg(['C:\\app\\Claude Usage.exe', '--claude-config-dir=D:\\Revaal\\claude-config\\'], 'C:\\', 'win32'), 'D:\\Revaal\\claude-config');
  assert.equal(configDirArg(['app', '--allow-file-access', '--claude-config-dir="cfg"'], '/home/ada', 'linux'), '/home/ada/cfg');
  assert.equal(configDirArg(['app', '--claude-config-dir=Default'], '/', 'linux'), null);
  assert.equal(configDirArg(['app', '--claude-config-dir='], '/', 'linux'), undefined);
  assert.equal(configDirArg(['app', '--mock'], '/', 'linux'), undefined);
  assert.equal(configDirArg(['app', '--claude-config-dir=/a', '--claude-config-dir=/b'], '/', 'linux'), '/b', 'the last one wins');
});
