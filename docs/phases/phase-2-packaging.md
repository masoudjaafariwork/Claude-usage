# Phase 2 — Packaging, app icon, launch at login

| | |
| --- | --- |
| **Status** | ⏭️ Next |
| **Depends on** | Phase 1 |
| **Size** | One Claude Code session |

## Goal

Install the overlay like a normal app on Windows, macOS and Linux (no terminal, no `npm start`),
and have it start automatically when the computer starts.

## Background

Phase 1 runs only from source. The user is on Windows 11 and wants something they can simply run
and keep on a second monitor. Unsigned builds are acceptable for now (no code-signing certificates).

## Scope

- [ ] **App icon** — `scripts/make-icon.mjs` renders `build/icon.png` (1024×1024): dark rounded
      square with the progress-ring motif (coral brand + mint ring), reusing the approach in
      `src/main/tray-icon.ts` (supersampled ring + PNG encoder). Commit the generated PNG. Use it as
      the window icon on Linux.
- [ ] **electron-builder** (dev dependency), configured in `package.json` → `build`:
  - `appId: com.masoudjaafari.claude-usage-overlay` (must match `setAppUserModelId` in `main.ts`),
    `productName: Claude Usage Overlay`, output directory `release/`
  - `files`: `dist/**` (without source maps) and `package.json` only
  - Windows: NSIS installer (per-user, no admin rights) + portable exe
  - macOS: dmg for x64 and arm64, unsigned (`identity: null`), `LSUIElement: true` (no Dock icon)
  - Linux: AppImage + deb (category `Utility`)
  - Scripts: `dist` (current OS), `dist:win`, `dist:mac`, `dist:linux`
- [ ] **Launch at login** — checkbox in the context menu, persisted in settings, re-synced with the
      OS state on startup:
  - Windows / macOS: `app.setLoginItemSettings` (packaged builds only; in dev show the item
    disabled with a hint such as "available in the installed app")
  - Linux: write/remove `~/.config/autostart/claude-usage-overlay.desktop` pointing at
    `process.env.APPIMAGE` or the installed binary
- [ ] **Menu items** — "About Claude Usage Overlay vX.Y.Z" and "Open settings folder"
- [ ] **CI** — `.github/workflows/release.yml`: on tags `v*`, build on `windows-latest`,
      `macos-latest` and `ubuntu-latest` and attach the artifacts to a **draft** GitHub Release
      (repo `masoudjaafariwork/Claude-usage`)
- [ ] **README** — installation per OS

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
- [ ] Enable **Launch at login** in the menu, restart Windows — the overlay comes back by itself.
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

_Not started._
