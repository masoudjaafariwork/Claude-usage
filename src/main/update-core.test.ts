import assert from 'node:assert/strict';
import { test } from 'node:test';
import pkg from '../../package.json';
import {
  CHECK_INTERVAL_MS,
  RETRY_AFTER_ERROR_MS,
  UPDATE_REPO,
  describeUpdateError,
  isCheckDue,
  oneLine,
  releasePageUrl,
  updateMenuItem,
  updateMode,
  updateNotice,
  type UpdatePhase,
} from './update-core';

const installed = { packaged: true, devRun: false, env: {} };

test('updateMode: installer and AppImage update themselves, the rest only notifies', () => {
  assert.equal(updateMode({ ...installed, platform: 'win32' }), 'auto');
  assert.equal(updateMode({ ...installed, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\Claude.exe' } }), 'notify');
  assert.equal(updateMode({ ...installed, platform: 'linux', env: { APPIMAGE: '/home/a/claude-usage.AppImage' } }), 'auto');
  assert.equal(updateMode({ ...installed, platform: 'linux' }), 'notify'); // deb
  assert.equal(updateMode({ ...installed, platform: 'darwin' }), 'notify');
  assert.equal(updateMode({ ...installed, platform: 'freebsd' }), 'off');
});

test('updateMode: dev, mock and screenshot runs never update', () => {
  assert.equal(updateMode({ ...installed, packaged: false, platform: 'win32' }), 'off');
  assert.equal(updateMode({ ...installed, devRun: true, platform: 'win32' }), 'off');
});

test('isCheckDue: first check, regular interval, sooner retry after an error, never while busy', () => {
  const now = 1_000_000_000_000;
  const idle: UpdatePhase = { kind: 'idle' };
  assert.equal(isCheckDue(idle, { lastAttemptAt: null, lastFailed: false }, now), true);
  assert.equal(isCheckDue(idle, { lastAttemptAt: now - CHECK_INTERVAL_MS + 1, lastFailed: false }, now), false);
  assert.equal(isCheckDue(idle, { lastAttemptAt: now - CHECK_INTERVAL_MS, lastFailed: false }, now), true);
  assert.equal(isCheckDue({ kind: 'error', message: 'x' }, { lastAttemptAt: now - RETRY_AFTER_ERROR_MS, lastFailed: true }, now), true);
  assert.equal(isCheckDue({ kind: 'error', message: 'x' }, { lastAttemptAt: now - RETRY_AFTER_ERROR_MS + 1, lastFailed: true }, now), false);
  assert.equal(isCheckDue(idle, { lastAttemptAt: now + 60_000, lastFailed: false }, now), true); // clock moved back
  for (const busy of [
    { kind: 'checking' },
    { kind: 'downloading', version: '0.3.1', percent: 10 },
    { kind: 'ready', version: '0.3.1' },
  ] satisfies UpdatePhase[]) {
    assert.equal(isCheckDue(busy, { lastAttemptAt: null, lastFailed: false }, now), false, busy.kind);
  }
  // Notify mode keeps looking for even newer versions.
  assert.equal(isCheckDue({ kind: 'available', version: '0.3.1' }, { lastAttemptAt: now - CHECK_INTERVAL_MS, lastFailed: false }, now), true);
});

test('updateMenuItem: label, action and placement per phase', () => {
  const item = (phase: UpdatePhase) => updateMenuItem('auto', phase);
  assert.deepEqual(item({ kind: 'idle' }), { label: 'Check for updates', enabled: true, action: 'check', prominent: false });
  assert.deepEqual(item({ kind: 'checking' }), { label: 'Checking for updates…', enabled: false, action: null, prominent: false });
  assert.equal(item({ kind: 'up-to-date' }).label, 'Check for updates — up to date');
  assert.equal(item({ kind: 'error', message: 'No connection to GitHub' }).action, 'check');
  assert.deepEqual(item({ kind: 'downloading', version: '0.3.1', percent: 45 }), {
    label: 'Downloading update v0.3.1… 45%',
    enabled: false,
    action: null,
    prominent: false,
  });
  assert.deepEqual(item({ kind: 'ready', version: '0.3.1' }), {
    label: 'Restart to update to v0.3.1',
    enabled: true,
    action: 'install',
    prominent: true,
  });
  assert.deepEqual(updateMenuItem('notify', { kind: 'available', version: '0.3.1' }), {
    label: 'Update available (v0.3.1) — open download page',
    enabled: true,
    action: 'open-download-page',
    prominent: true,
  });
  assert.deepEqual(updateMenuItem('off', { kind: 'idle' }), {
    label: 'Check for updates (installed app only)',
    enabled: false,
    action: null,
    prominent: false,
  });
});

test('updateNotice: scheduled checks only announce something to act on', () => {
  assert.equal(updateNotice({ kind: 'up-to-date' }, false, '0.3.0'), null);
  assert.equal(updateNotice({ kind: 'error', message: 'No connection to GitHub' }, false, '0.3.0'), null);
  assert.equal(updateNotice({ kind: 'downloading', version: '0.3.1', percent: 0 }, false, '0.3.0'), null);
  assert.equal(updateNotice({ kind: 'checking' }, true, '0.3.0'), null);
  assert.equal(updateNotice({ kind: 'ready', version: '0.3.1' }, false, '0.3.0')?.title, 'Claude Usage 0.3.1 is ready');
  const available = updateNotice({ kind: 'available', version: '0.3.1' }, false, '0.3.0');
  assert.equal(available?.title, 'Claude Usage 0.3.1 is available');
  assert.equal(available?.opensDownloadPage, true);
});

test('updateNotice: a check from the menu reports every outcome', () => {
  assert.deepEqual(updateNotice({ kind: 'up-to-date' }, true, '0.3.0'), {
    title: 'Claude Usage is up to date',
    body: 'Version 0.3.0 is the latest.',
    opensDownloadPage: false,
  });
  assert.equal(updateNotice({ kind: 'downloading', version: '0.3.1', percent: 0 }, true, '0.3.0')?.title, 'Downloading Claude Usage 0.3.1');
  assert.equal(
    updateNotice({ kind: 'error', message: 'No connection to GitHub' }, true, '0.3.0')?.body,
    'No connection to GitHub. Details are in the log.',
  );
});

test('describeUpdateError: short reasons for electron-updater errors', () => {
  assert.equal(describeUpdateError('Error: net::ERR_INTERNET_DISCONNECTED'), 'No connection to GitHub');
  assert.equal(describeUpdateError('Error: getaddrinfo ENOTFOUND github.com'), 'No connection to GitHub');
  assert.equal(describeUpdateError('net::ERR_PROXY_CONNECTION_FAILED'), 'No connection to GitHub');
  assert.equal(
    describeUpdateError('ERR_UPDATER_LATEST_VERSION_NOT_FOUND Unable to find latest version on GitHub (…), please ensure a production release exists'),
    'No update information on GitHub',
  );
  assert.equal(
    describeUpdateError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND Cannot find latest.yml in the latest release artifacts (…): HttpError: 404'),
    'No update information on GitHub',
  );
  assert.equal(describeUpdateError('ERR_CHECKSUM_MISMATCH sha512 checksum mismatch, expected a, got b'), 'The download was damaged');
  assert.equal(describeUpdateError('HttpError: 429 Too Many Requests'), 'GitHub is limiting requests');
  assert.equal(describeUpdateError('Something else'), 'Unexpected error');
});

test('oneLine flattens and shortens long errors', () => {
  assert.equal(oneLine('HttpError: 404\n  "method: GET"\n\n  Headers: {}'), 'HttpError: 404 "method: GET" Headers: {}');
  const long = oneLine('x'.repeat(400));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test('releasePageUrl links the version tag, or the latest release for odd versions', () => {
  assert.equal(releasePageUrl('0.3.1'), 'https://github.com/masoudjaafariwork/Claude-usage/releases/tag/v0.3.1');
  assert.equal(releasePageUrl(null), 'https://github.com/masoudjaafariwork/Claude-usage/releases/latest');
  assert.equal(releasePageUrl('../../evil'), 'https://github.com/masoudjaafariwork/Claude-usage/releases/latest');
});

test('package.json publishes to the repository the app updates from', () => {
  assert.deepEqual(
    { provider: pkg.build.publish.provider, owner: pkg.build.publish.owner, repo: pkg.build.publish.repo },
    { provider: 'github', ...UPDATE_REPO },
  );
});

test('release file names have no spaces (GitHub turns them into dots, electron-updater into dashes)', () => {
  const names = [pkg.build.nsis.artifactName, pkg.build.portable.artifactName, pkg.build.dmg.artifactName, pkg.build.appImage.artifactName];
  for (const name of names) assert.doesNotMatch(name, / /, name);
});
