// Tests for launch-at-login reconciliation and the Linux autostart entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  execLine,
  isStartupApprovedDisabled,
  linuxAutostartFile,
  linuxDesktopEntry,
  parseLinuxAutostart,
  quoteExecArg,
  reconcileLoginItem,
} from './login-item-core';

test('reconcileLoginItem: the OS wins when it is on or was switched off there', () => {
  assert.deepEqual(reconcileLoginItem(false, 'on'), { launchAtLogin: true, register: false });
  assert.deepEqual(reconcileLoginItem(true, 'on'), { launchAtLogin: true, register: false });
  assert.deepEqual(reconcileLoginItem(true, 'disabled'), { launchAtLogin: false, register: false });
  assert.deepEqual(reconcileLoginItem(false, 'disabled'), { launchAtLogin: false, register: false });
});

test('reconcileLoginItem: a missing or stale item is re-registered only when wanted', () => {
  assert.deepEqual(reconcileLoginItem(true, 'off'), { launchAtLogin: true, register: true });
  assert.deepEqual(reconcileLoginItem(false, 'off'), { launchAtLogin: false, register: false });
});

test('isStartupApprovedDisabled reads the Task Manager on/off flag', () => {
  const out = (hex: string) =>
    `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\r\n` +
    `    com.masoudjaafari.claude-usage-overlay    REG_BINARY    ${hex}\r\n\r\n`;
  assert.equal(isStartupApprovedDisabled(out('03000000D02E1ACDB84BDD01')), true);
  assert.equal(isStartupApprovedDisabled(out('070000000000000000000000')), true);
  assert.equal(isStartupApprovedDisabled(out('020000000000000000000000')), false);
  assert.equal(isStartupApprovedDisabled(out('060000000000000000000000')), false);
  assert.equal(isStartupApprovedDisabled(''), false);
});

test('linuxAutostartFile honours an absolute XDG_CONFIG_HOME only', () => {
  const file = (p: string) => p.replace(/\\/g, '/');
  assert.equal(file(linuxAutostartFile({}, '/home/u')), '/home/u/.config/autostart/claude-usage-overlay.desktop');
  assert.equal(file(linuxAutostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/u')), '/cfg/autostart/claude-usage-overlay.desktop');
  assert.equal(file(linuxAutostartFile({ XDG_CONFIG_HOME: 'rel' }, '/home/u')), '/home/u/.config/autostart/claude-usage-overlay.desktop');
});

test('quoteExecArg follows the Desktop Entry quoting rules', () => {
  assert.equal(quoteExecArg('/opt/Claude Usage Overlay/claude-usage-overlay'), '"/opt/Claude Usage Overlay/claude-usage-overlay"');
  assert.equal(quoteExecArg('/a/100%/b'), '"/a/100%%/b"');
  // Reserved characters get a backslash, and every backslash is then escaped once more.
  assert.equal(quoteExecArg('/a/$x`"y'), '"/a/\\\\$x\\\\`\\\\"y"');
  assert.equal(quoteExecArg('/a\\b'), '"/a\\\\\\\\b"');
  assert.equal(execLine('/x/app.AppImage', ['--no-sandbox']), '"/x/app.AppImage" "--no-sandbox"');
});

test('parseLinuxAutostart detects on / disabled / stale / missing entries', () => {
  const exec = execLine('/home/u/Apps/claude.AppImage');
  const entry = linuxDesktopEntry('Claude Usage Overlay', exec);
  assert.equal(parseLinuxAutostart(entry, exec), 'on');
  assert.equal(parseLinuxAutostart(null, exec), 'off');
  assert.equal(parseLinuxAutostart(entry, execLine('/moved/claude.AppImage')), 'off');
  assert.equal(parseLinuxAutostart(entry.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'), exec), 'disabled');
  assert.equal(parseLinuxAutostart(`${entry}Hidden=true\n`, exec), 'disabled');
  // Keys in other groups (desktop actions) are ignored; CRLF files still parse.
  const withAction = `${entry}\n[Desktop Action x]\nExec=/other\nHidden=true\n`.replace(/\n/g, '\r\n');
  assert.equal(parseLinuxAutostart(withAction, exec), 'on');
});
