# Phase 5 — App auto-update

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-26) — tested end to end with local builds; the test with two real GitHub releases is the owner's (checklist below) |
| **Depends on** | Phase 2 (installers + GitHub release workflow) |
| **Size** | One Claude Code session |

## Goal

When a new version is released on GitHub, installed copies update themselves quietly — the user
never has to download and reinstall by hand.

## Background

Phase 2 produces installers and draft GitHub Releases in `masoudjaafariwork/Claude-usage`.
Auto-update needs a runtime dependency (`electron-updater`), which CLAUDE.md says must be approved
by the user first.

## Scope

- [x] Ask the user to approve `electron-updater` as a runtime dependency before adding it.
- [x] `publish` config for the GitHub provider (owner `masoudjaafariwork`, repo `Claude-usage`);
      CI uploads `latest*.yml` update metadata together with the installers.
- [x] Check 30 s after startup and every 6 h; download in the background; when ready, the menu
      shows "Restart to update to vX.Y.Z". No modal dialogs.
- [x] Windows (NSIS) and Linux (AppImage) auto-update. macOS: signed auto-update only if the user
      has an Apple Developer ID; otherwise the menu shows "Update available — open download page".
- [x] "Check for updates" menu item with visible feedback (up to date / downloading / ready / error).
- [x] README: release procedure (bump version, tag, push, publish the draft release).

## Out of scope

Code-signing purchase/setup, delta updates, beta channels.

## Technical notes

- **Private repo:** if the repository is private, `electron-updater` needs a token to read
  releases — that must not be shipped inside the app. Ask the user whether the repo will be public;
  if not, propose an alternative (e.g. a public releases-only repo).
- The **portable exe** and the **deb** package cannot auto-update; show "download" instead.
- Updates install on quit (`autoInstallOnAppQuit`) or immediately via the menu item
  (`quitAndInstall`); make sure settings are flushed first.
- Log updater events to the Phase 3 log (`log.ts`, `app.getPath('logs')`).
- Test with two real versions (e.g. 0.3.0 → 0.3.1) published as releases; the user publishes them.

## Acceptance criteria

- On Windows, an installed older version detects, downloads and installs a newer published release.
- "Check for updates" reports each state correctly.
- `npm run check` passes; docs updated (`docs/PROGRESS.md`, `docs/BACKLOG.md`, this file's
  **Result**, README release steps).

## Manual test checklist (for the user)

- [ ] Install version A; publish version B on GitHub.
- [ ] Within a minute of starting A (or via **Check for updates**) the menu shows
      "Restart to update to B".
- [ ] Click it — the app restarts as version B with the same settings and position.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 5 of Claude Usage as specified in docs/phases/phase-5-auto-update.md
(in-app auto-update from GitHub Releases). Read CLAUDE.md, docs/PROGRESS.md and that phase file
first. Ask me before adding electron-updater, and ask whether the GitHub repository is public before
designing the update source. Never push, tag or publish releases yourself — tell me exactly what to
run and when. Follow the phase file's Scope, Out of scope, Technical notes and Acceptance criteria.
When done: fill in the phase file's Result section, set its status, update docs/PROGRESS.md and
docs/BACKLOG.md, and give me the manual test steps in Persian.
```

## Result

Done 2026-09-26 (session 15). Decisions D45–D48 in `docs/PROGRESS.md`.

**Owner's answers:** `electron-updater` approved (after an explanation: it is the standard
updater for electron-builder apps); the repository stays **public**, so the app reads releases
without any token; **no Apple Developer ID**, so macOS only notifies.

### What was built

- `src/main/update-core.ts` (pure, 11 tests): update mode per build (`auto` = Windows installer and
  AppImage; `notify` = macOS, Windows portable exe, deb; `off` = dev / mock / screenshot runs),
  check schedule (30 s after start, then every 6 h; 1 h after a failed check; looked at every
  15 min so sleep doesn't stretch it), menu label per phase, notification texts, short error
  reasons, the release page URL. A test checks that `build.publish` in `package.json` names the
  same repository and that no release file name contains a space.
- `src/main/updater.ts`: drives electron-updater 6.8.9 — `autoDownload` / `autoInstallOnAppQuit`
  only in `auto` mode, full downloads (`disableDifferentialDownload`, no blockmaps published),
  `disableWebInstaller`; warnings and errors go to the Phase 3 log (one line each), plus own
  lines for check / available / not available / downloaded / restarting. On Linux, a renamed
  AppImage (`appimage-filename-updated`) re-points launch at login (`login-item.ts` now reads
  `APPIMAGE` when used).
- Menu: one updates item next to *About* — *Check for updates*, *Checking for updates…*,
  *Check for updates — up to date*, *Downloading update vX… 45%*, *Check for updates — last check
  failed*; when there is something to do it moves to the **top**: *Restart to update to vX* (auto)
  or *Update available (vX) — open download page* (notify). Dev runs: *Check for updates
  (installed app only)*, disabled.
- Notifications (no dialogs): a scheduled check stays quiet except "vX is ready" / "vX is
  available" (once per version per run); a check from the menu reports every outcome (up to date,
  downloading, error), because the menu is closed by then (D47).
- *Restart to update*: flushes settings, then `quitAndInstall(silent, run after)`; the normal quit
  path (`before-quit`) runs as well. Without a click the update installs silently at the next quit.
- `package.json`: `build.publish` = GitHub `masoudjaafariwork/Claude-usage` (`releaseType: draft`;
  the scripts still pass `--publish never`), release files renamed without spaces:
  `Claude-Usage-Setup-<v>.exe`, `Claude-Usage-<v>-Portable.exe`, `Claude-Usage-<v>-<arch>.dmg`
  (D46). `electron-updater` is the first runtime dependency; esbuild keeps it external and
  electron-builder packs it with its 15 dependencies into `app.asar` (+≈ 2 MB unpacked, the installer
  grew ≈ 0.3 MB).
- `release.yml`: uploads `release/latest*.yml` with the installers; header says to publish the draft
  as a normal release.
- README: *Updates* section, new file names, release procedure, troubleshooting.

### Verification

**Windows 11**, with two local builds of a separate test identity ("Claude Usage
UpdTest", own appId / install folder / userData) that update from a local HTTP server (generic
provider, same NSIS updater code path; menu clicks through the main-process inspector):

1. Installed 0.3.0 → 30 s after start: check, download, sha512 verified, "ready" notification,
   menu top item *Restart to update to v0.3.1*, nothing next to About.
2. Moved the window, clicked *Restart to update* 450 ms later → the app quit, installed silently
   and started again as 0.3.1 within 13 s; the new position was in `settings.json` (flush works).
3. 0.3.1's scheduled check: "No update"; menu → *Check for updates* → notification "up to date";
   with the server stopped → `net::ERR_CONNECTION_REFUSED` → notification "Couldn't check for
   updates — No connection to GitHub", menu *Check for updates — last check failed*.
4. Reinstalled 0.3.0, let it download, quit normally → the silent install ran on quit, the
   installed exe became 0.3.1, no restart (as intended).
5. Portable 0.3.0 → notify mode: only `latest.yml` fetched (no download), notification
   "0.3.1 is available", top item *Update available (v0.3.1) — open download page*; quitting
   installed nothing.
6. The test app was uninstalled and its data, updater cache and shortcuts removed; the owner's
   installed app and its launch-at-login entry were not touched.

Also checked in electron-builder / electron-updater code: `latest.yml` names
`Claude-Usage-Setup-<v>.exe` exactly (the GitHub provider would turn spaces into dashes while a
`gh` upload turns them into dots); `app-update.yml` is written into the resources of both Windows
builds; the dmg writes `latest-mac.yml`; the AppImage and deb entries are merged into one
`latest-linux.yml` and the AppImage updater picks the `.AppImage`.

**Not verified:** the GitHub provider against a real release (v0.2.0 is a pre-release without
`latest.yml`, so it is invisible to the updater) — that is the owner's test with 1.0.0 → 1.0.1
(the first release with the updater is 1.0.0, D49; the test builds above were numbered 0.3.x).
macOS and Linux untested (see Known issues). Existing 0.2.0 installs have no updater: 1.0.0 must be
installed by hand once.
