import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SHORTCUTS, isValidShortcut, shortcutLabel } from './shortcuts-core';

test('isValidShortcut needs at least one modifier and a key', () => {
  assert.ok(isValidShortcut(DEFAULT_SHORTCUTS.toggle));
  assert.ok(isValidShortcut(DEFAULT_SHORTCUTS.lock));
  assert.ok(isValidShortcut('Ctrl+Shift+F12'));
  assert.ok(isValidShortcut('Super+Space'));
  assert.equal(isValidShortcut('U'), false);
  assert.equal(isValidShortcut('Ctrl+'), false);
  assert.equal(isValidShortcut('Ctrl+Alt'), false);
  assert.equal(isValidShortcut('Banana+U'), false);
  assert.equal(isValidShortcut(''), false);
  assert.equal(isValidShortcut(42), false);
  assert.equal(isValidShortcut(`Ctrl+${'x'.repeat(60)}`), false);
});

test('shortcutLabel per platform', () => {
  assert.equal(shortcutLabel(DEFAULT_SHORTCUTS.toggle, 'win32'), 'Ctrl+Alt+U');
  assert.equal(shortcutLabel(DEFAULT_SHORTCUTS.lock, 'linux'), 'Ctrl+Alt+Shift+U');
  assert.equal(shortcutLabel(DEFAULT_SHORTCUTS.toggle, 'darwin'), '⌘⌥U');
  assert.equal(shortcutLabel(DEFAULT_SHORTCUTS.lock, 'darwin'), '⌘⌥⇧U');
  assert.equal(shortcutLabel('Super+Space', 'win32'), 'Win+Space');
  assert.equal(shortcutLabel('Super+Space', 'linux'), 'Super+Space');
});
