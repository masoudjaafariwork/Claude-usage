import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttemptBudget, describeProcessGone, isCleanExit, relaunchOptions } from './recovery-core';

test('AttemptBudget allows the budget within the window and refuses the rest', () => {
  const budget = new AttemptBudget(2, 60_000);
  assert.equal(budget.take(0), true);
  assert.equal(budget.take(1_000), true);
  assert.equal(budget.take(2_000), false);
  assert.equal(budget.take(59_999), false);
});

test('AttemptBudget forgets attempts once they fall out of the window', () => {
  const budget = new AttemptBudget(2, 60_000);
  budget.take(0);
  budget.take(30_000);
  assert.equal(budget.take(60_000), true); // the first attempt is 60 s old
  assert.equal(budget.take(60_001), false); // the 30 s and 60 s ones still count
  assert.equal(budget.take(90_000), true);
});

test('describeProcessGone names the process, the reason, the exit code and a service name', () => {
  assert.equal(describeProcessGone('GPU', { reason: 'crashed', exitCode: 5 }), 'GPU process gone: crashed (exit code 5)');
  assert.equal(describeProcessGone('Overlay renderer', { reason: 'oom' }), 'Overlay renderer process gone: oom');
  assert.equal(
    describeProcessGone('Utility', { reason: 'killed', exitCode: 1, name: 'network.mojom.NetworkService' }),
    'Utility process gone: killed (exit code 1) — network.mojom.NetworkService',
  );
});

test('isCleanExit is true only for a deliberate exit', () => {
  assert.equal(isCleanExit({ reason: 'clean-exit', exitCode: 0 }), true);
  assert.equal(isCleanExit({ reason: 'crashed', exitCode: 0 }), false);
});

test('relaunchOptions names the outer file for the portable exe and the AppImage, nothing otherwise', () => {
  const portable = 'D:/Tools/Claude-Usage-1.1.0-Portable.exe';
  assert.deepEqual(relaunchOptions({ PORTABLE_EXECUTABLE_FILE: portable }, 'win32'), { execPath: portable });
  assert.deepEqual(relaunchOptions({ APPIMAGE: '/home/u/Claude-Usage.AppImage' }, 'linux'), { execPath: '/home/u/Claude-Usage.AppImage' });
  assert.equal(relaunchOptions({ APPIMAGE: '/x' }, 'win32'), undefined);
  assert.equal(relaunchOptions({}, 'darwin'), undefined);
});
