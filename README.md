# Claude Usage

A small always-on-top desktop overlay that shows your **Claude plan usage limits**: current
session, weekly limits, per-model weekly limits and this week's split by app. It shows the same
numbers as *Claude → Settings → Usage* and refreshes them automatically. Put it anywhere on any monitor.

Windows · macOS · Linux — Electron + TypeScript.

<p>
  <img src="docs/images/overlay-expanded.png" alt="Expanded overlay" width="300">
  <img src="docs/images/overlay-stale.png" alt="Overlay showing stale data with a sign-in banner" width="300">
</p>
<p><img src="docs/images/overlay-compact.png" alt="Compact overlay" width="330"></p>

<sub>Screenshots use mock data.</sub>

## Features

- Frameless, transparent, always-on-top card. Drag it anywhere; its position is remembered, and
  **Move to display** sends it to another monitor.
- Session ring with reset countdown, weekly bars, per-model limits, weekly split by app
  (Claude Code / Chats / Cowork …), and extra-usage credits when enabled.
- Compact pill mode for a minimal footprint.
- Tray / menu-bar icon that shows a live ring for your most-constrained limit.
- Refreshes every 3 minutes (1–10 min configurable), plus right after a limit resets.
- Optional **Launch at login**.
- Keeps showing the last known data (clearly marked) when you're offline or the sign-in has expired.

## How it works

The overlay reads the sign-in that **Claude Code** already stores on your computer. On Windows and
Linux that's `~/.claude/.credentials.json`; on macOS it's the Keychain item `Claude Code-credentials`.
It uses that token to ask Anthropic's servers for your usage, the same way the Settings → Usage page
does.

- The token is **only read, never modified or refreshed**. Refreshing would log Claude Code out.
- The token goes only to `api.anthropic.com`. There is no telemetry and no third-party server.
- If Claude Code's sign-in expires (after ~8 h without use), the overlay says so and recovers
  automatically once Claude Code renews it.

> The usage endpoint is not an official public API. It can change without notice. This project is
> not affiliated with Anthropic.

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude`,
  then `/login`) with a Claude Pro/Max/Team account.
- Node.js 22+ only if you run from source.

## Install

Download the file for your system from the
[Releases page](https://github.com/masoudjaafariwork/Claude-usage/releases). The builds are not
code-signed, so every OS shows a warning the first time.

> **Coming from 0.1.0?** That prerelease was called *Claude Usage Overlay*. From 0.2.0 the app is
> called *Claude Usage* and installs as a separate app: uninstall *Claude Usage Overlay* first
> (Settings → Apps; this also removes its launch-at-login entry). Settings are not carried over.

### Windows 10 / 11

- **Installer** — `Claude Usage Setup <version>.exe`. Installs for your user only (no admin
  rights), adds a Start menu shortcut and starts the overlay. Uninstall from *Settings → Apps*.
- **Portable** — `Claude Usage <version> Portable.exe`. One file, no installation; keep it
  anywhere (e.g. Desktop). It starts a little slower because it unpacks itself on every start.
- SmartScreen may say *"Windows protected your PC"*: click **More info → Run anyway**.

Both versions keep their settings in `%APPDATA%\Claude Usage` (menu → *Open settings
folder*), so they share them. Only one copy runs at a time.

### macOS (Apple Silicon and Intel)

- `Claude Usage-<version>-arm64.dmg` for Apple Silicon (M1 and later),
  `…-x64.dmg` for Intel Macs. Open it and drag the app to *Applications*.
- The app is ad-hoc signed but not notarized by Apple. On first launch macOS blocks it: open
  **System Settings → Privacy & Security** and click **Open Anyway** (macOS 14 and older: right-click
  the app → *Open*). Or run once in Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Claude Usage.app"`
- The app lives in the menu bar (no Dock icon). When macOS asks for Keychain access, choose
  **Always Allow**.

### Linux (x64)

- **AppImage** — `chmod +x claude-usage-<version>-x86_64.AppImage`, then run it. It needs
  FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu 24.04+, `libfuse2` on older releases). If it
  exits with a sandbox error (Ubuntu 24.04+), start it with `--no-sandbox`.
- **deb** (Debian / Ubuntu) — `sudo apt install ./claude-usage_<version>_amd64.deb`.
- On GNOME the tray icon needs the AppIndicator extension.

### Launch at login

Tick **Launch at login** in the menu. You can also see or switch it off in the OS: *Task Manager →
Startup apps* (Windows), *System Settings → General → Login Items* (macOS), or
`~/.config/autostart/claude-usage.desktop` (Linux). The overlay respects it when you switch
it off there. The option only works in the installed app, not with `npm start`.

## Run from source

```bash
npm install
npm start
```

- **Move:** drag the card.
- **Menu:** the ⋯ button, right-click, or the tray icon. The menu has compact mode, always on top,
  opacity, refresh interval, move to display, reset position and quit.
- **Tray:** on Windows/Linux, left-click toggles the overlay. On macOS, click the menu-bar icon.

## Development

| Command | Purpose |
| --- | --- |
| `npm start` | Build and run with real data |
| `npm run start:mock` | Run with fake data |
| `node scripts/start.mjs --mock=critical` | Other scenarios: `normal`, `warning`, `critical`, `expired`, `no-credentials`, `rate-limited`, `offline`, `loading` |
| `npm run screenshot` | Render every mock scenario to `screenshots/` |
| `npm run check` | Type-check and run unit tests |
| `npm run dist` | Build installers for the current OS into `release/` (`dist:win`, `dist:mac`, `dist:linux` for one OS) |
| `npm run make-icon` | Regenerate the app icon `build/icon.png` |

Installers are built with [electron-builder](https://www.electron.build/). A dmg must be built on a
Mac and the Linux packages on Linux; the release workflow does all three. To release: bump
`version` in `package.json`, commit, tag `v<version>` and push the tag. GitHub Actions
([release.yml](.github/workflows/release.yml)) builds everything and attaches it to a **draft**
release, which you publish by hand.

Project guide for AI-assisted development: [CLAUDE.md](CLAUDE.md). Status and decisions:
[docs/PROGRESS.md](docs/PROGRESS.md). Roadmap: [docs/BACKLOG.md](docs/BACKLOG.md).

## Troubleshooting

- **"Not signed in to Claude Code"**: run `claude` in a terminal and use `/login`.
- **"Claude Code sign-in expired"**: open Claude Code (any session renews the token). The overlay
  picks up the new token within a minute.
- **"Can't reach Anthropic"**: requests use your system proxy settings. Check your connection or VPN.
- **macOS Keychain prompt**: choose *Always Allow* so the overlay can read Claude Code's sign-in.
- **Linux (GNOME)**: the tray icon needs the AppIndicator extension. On Wayland, always-on-top and
  window positioning depend on the compositor.

## License

[GPL-3.0](LICENSE)
