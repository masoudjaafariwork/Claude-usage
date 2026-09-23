# Claude Usage Overlay

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
- Node.js 22+ to run from source.

## Run from source

```bash
npm install
npm start
```

- **Move:** drag the card.
- **Menu:** the ⋯ button, right-click, or the tray icon. The menu has compact mode, always on top,
  opacity, refresh interval, move to display, reset position and quit.
- **Tray:** on Windows/Linux, left-click toggles the overlay. On macOS, click the menu-bar icon.

Installers and launch-at-login are planned — see [Phase 2](docs/phases/phase-2-packaging.md) and the [roadmap](docs/BACKLOG.md).

## Development

| Command | Purpose |
| --- | --- |
| `npm start` | Build and run with real data |
| `npm run start:mock` | Run with fake data |
| `node scripts/start.mjs --mock=critical` | Other scenarios: `normal`, `warning`, `critical`, `expired`, `no-credentials`, `rate-limited`, `offline`, `loading` |
| `npm run screenshot` | Render every mock scenario to `screenshots/` |
| `npm run check` | Type-check and run unit tests |

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
