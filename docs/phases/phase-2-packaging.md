# Phase 2 — Packaging, app icon, launch at login

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-24) |
| **Depends on** | Phase 1 |
| **Size** | One Claude Code session |

## Goal

Install the overlay like a normal app on Windows, macOS and Linux (no terminal, no `npm start`),
and have it start automatically when the computer starts.

## Background

Phase 1 runs only from source. The user is on Windows 11 and wants something they can simply run
and keep on a second monitor. Unsigned builds are acceptable for now (no code-signing certificates).

## Scope

- [x] **App icon** — `scripts/make-icon.mjs` renders `build/icon.png` (1024×1024): dark rounded
      square with the progress-ring motif (coral brand + mint ring), reusing the approach in
      `src/main/tray-icon.ts` (supersampled ring + PNG encoder). Commit the generated PNG. Use it as
      the window icon on Linux.
- [x] **electron-builder** (dev dependency), configured in `package.json` → `build`:
  - `appId: com.masoudjaafari.claude-usage-overlay` (must match `setAppUserModelId` in `main.ts`),
    `productName: Claude Usage Overlay`, output directory `release/`
  - `files`: `dist/**` (without source maps) and `package.json` only
  - Windows: NSIS installer (per-user, no admin rights) + portable exe
  - macOS: dmg for x64 and arm64, unsigned (`identity: null`), `LSUIElement: true` (no Dock icon)
    — *changed to ad-hoc signing, see Result*
  - Linux: AppImage + deb (category `Utility`)
  - Scripts: `dist` (current OS), `dist:win`, `dist:mac`, `dist:linux`
- [x] **Launch at login** — checkbox in the context menu, persisted in settings, re-synced with the
      OS state on startup:
  - Windows / macOS: `app.setLoginItemSettings` (packaged builds only; in dev show the item
    disabled with a hint such as "available in the installed app")
  - Linux: write/remove `~/.config/autostart/claude-usage-overlay.desktop` pointing at
    `process.env.APPIMAGE` or the installed binary
- [x] **Menu items** — "About Claude Usage Overlay vX.Y.Z" and "Open settings folder"
- [x] **CI** — `.github/workflows/release.yml`: on tags `v*`, build on `windows-latest`,
      `macos-latest` and `ubuntu-latest` and attach the artifacts to a **draft** GitHub Release
      (repo `masoudjaafariwork/Claude-usage`)
- [x] **README** — installation per OS

## Out of scope

Code signing / notarization, auto-update (Phase 5), Microsoft Store / Homebrew / Snap.

## Technical notes

- electron-builder converts `build/icon.png` into `.ico` / `.icns`; 1024 px covers every target.
- **Portable exe:** it unpacks to a temp folder on every start, so `process.execPath` changes. For
  launch at login use `process.env.PORTABLE_EXECUTABLE_FILE` as the path.
- **Windows SmartScreen** warns about unsigned installers ("More info → Run anyway"). Document it.
- **macOS unsigned apps:** first launch needs right-click → Open, or
  `xattr -dr com.apple.quarantine "/Applications/Claude Usage Overlay.app"`. Document it.
- **deb packages** need a maintainer with an email address — ask the user which one to use for
  `author`; don't guess.
- `LSUIElement` duplicates `app.dock.hide()` but avoids a Dock icon flash at startup.
- Keep `npm start` working exactly as before (dev flow must not depend on packaging).
- Don't create tags, push, or publish releases — the user does that.

## Acceptance criteria

- `npm run dist:win` produces `release/Claude Usage Overlay Setup <version>.exe` and a portable exe.
- The installed app starts from the Start menu, shows the overlay and the tray icon, and keeps its
  settings between restarts.
- "Launch at login" is reflected by `app.getLoginItemSettings()` and by Windows
  (Task Manager → Startup apps), and survives an app restart.
- `npm run check` passes; `npm run screenshot` output is unchanged.
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] Run the installer from `release/`; if SmartScreen appears, choose More info → Run anyway.
- [ ] Start "Claude Usage Overlay" from the Start menu — overlay and tray icon appear.
- [ ] Menu: **About** shows the version; **Open settings folder** opens `%APPDATA%\Claude Usage Overlay`.
- [ ] Enable **Launch at login** in the menu — Task Manager → Startup apps lists
      "Claude Usage Overlay" as Enabled. Restart Windows — the overlay comes back by itself.
- [ ] Disable it in Task Manager, restart the app — the menu checkbox is off. Tick it again — Task
      Manager shows Enabled again.
- [ ] Try the portable exe from another folder (e.g. Desktop) and its Launch at login.
- [ ] Uninstall via Settings → Apps — the login item disappears too.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 2 of Claude Usage Overlay as specified in docs/phases/phase-2-packaging.md
(packaging, app icon, launch at login, release workflow).
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. Ask me before choosing the author/maintainer email for the
Linux package, and never push, tag or publish anything. If something in the plan turns out to be
wrong or risky, stop and ask me before deviating. When done: build the Windows installer and
portable exe and verify them on this machine, fill in the phase file's Result section, set its
status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps in Persian.
```

## Result

Delivered in session 2 (2026-09-24): everything in Scope.

- **Icon:** `scripts/make-icon.mjs` (reuses `encodePng` from `tray-icon.ts`, bundled on the fly with
  esbuild) → committed `build/icon.png`; `scripts/build.mjs` copies it to `dist/icon.png` for the
  Linux window icon and the About dialog.
- **Packaging:** electron-builder 26.15.3 (dev dependency), config in `package.json` → `build`,
  `publish: null` and `--publish never` in all `dist*` scripts. Artifacts: `Claude Usage Overlay
  Setup <v>.exe` (one-click, per-user NSIS), `Claude Usage Overlay <v> Portable.exe`,
  `Claude Usage Overlay-<v>-{x64,arm64}.dmg`, `claude-usage-overlay-<v>-x86_64.AppImage`,
  `claude-usage-overlay_<v>_amd64.deb`. Author/maintainer: Masoud Jaafari
  <masoudjaafariwork@gmail.com> (user's choice).
- **Launch at login:** `login-item.ts` (per-OS adapter) + `login-item-core.ts` (pure: reconcile rule,
  Task Manager flag parsing, Linux `.desktop` entry; 6 new tests → 34 total). Setting
  `launchAtLogin` is reconciled with the OS on startup (D17). Dev/mock/screenshot runs never touch
  the OS; the menu shows "Launch at login (installed app only)" disabled there.
- **Uninstall hook:** `build/installer.nsh` deletes the Run and StartupApproved values on a real
  uninstall (not during an update install).
- **Menu:** Launch at login, Open settings folder, About Claude Usage Overlay vX.Y.Z (message box).
- **CI:** `.github/workflows/release.yml` — tag `v*` → check tag = package.json version →
  `npm ci`, `npm run check`, `dist:<os>` on windows/macos/ubuntu → one job creates the **draft**
  release with `gh` (or adds files to it on re-runs).
- **README:** installation per OS, first-launch warnings, launch at login, building and releasing.

**Deviations (agreed with the user):**

- macOS uses **ad-hoc signing** (`identity: "-"`, `hardenedRuntime: false`) instead of
  `identity: null`. In electron-builder 26, `null` skips signing completely, and Apple Silicon then
  reports the app as "damaged" (only `xattr` helps). Ad-hoc gives the normal "Open Anyway" flow.
- Fixed a Phase 1 bug found while testing: the overlay moved up by (content height − 280) px on
  every start when parked in the lower half of a display (first `fitToContent` anchored the bottom
  edge). The first fit now keeps a restored position's top-left corner (D23).

**Extras:** `build.extraMetadata.description` = product name so Windows shows "Claude Usage
Overlay" (not the long description) in Task Manager → Startup apps for the portable exe; the .deb
keeps the long text via `build.linux.description`.

**Verified on Windows 11 (this machine):** `npm run dist:win` builds both exes (~111 MB each,
unsigned, correct version info); asar contains only `dist/` (no source maps) + `package.json`.
Silent install → per-user dir, Start menu + Desktop shortcuts, HKCU uninstall entry. Started from
the Start menu shortcut: overlay renders real data at the saved position, tray icon registered with
Windows, fresh data fetched and cached. Launch at login via the startup sync: registers the Run
value; OS "on" wins over a false setting; a Task Manager "Disabled" flag turns the setting off and
is respected on later starts; a removed entry is re-registered; re-enabling from the API clears the
Disabled flag (probe with the same call the menu makes). Update install over an existing one keeps
the login item. Portable from a folder with spaces: runs from `%TEMP%`, registers its own path.
Uninstall removes the Run + StartupApproved values, files, shortcuts and the uninstall entry.
Position no longer drifts across restarts. `npm run check` passes; screenshots unchanged.

**Not verified:** clicking the menu items by hand (checkbox, About, Open settings folder) and a real
Windows sign-in with launch at login — both in the manual checklist; macOS and Linux packages and
their login items (no machines here; CI builds them); the release workflow itself (runs only when
a tag is pushed).

**Found along the way:** Electron 44's `getLoginItemSettings()` never matches `launchItems` /
`executableWillLaunchAtLogin` when the exe path contains spaces; we use `openAtLogin` plus our own
read of the StartupApproved flag (`reg.exe`) instead (D18).
