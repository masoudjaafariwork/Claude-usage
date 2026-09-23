# Phase 1 — MVP overlay

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-24) |
| **Depends on** | — |
| **Size** | One Claude Code session |

## Goal

See the Claude plan usage limits (the numbers from Claude → Settings → Usage) in an always-on-top
overlay that refreshes itself, instead of opening the Claude app's settings every time.

## Background

- Existing tools were researched first. SlavomirDurej/claude-usage-widget (Electron, cross-platform)
  is the closest ready-made alternative; the user chose to build their own.
- Data source: Claude Code's stored OAuth token → `GET https://api.anthropic.com/api/oauth/usage`
  (decision D2). The token is read-only (D3) because refresh tokens are single-use.
- Stack: Electron + TypeScript (D1), esbuild + TypeScript 7 type-checking, no runtime dependencies (D4).

## Scope

- [x] Project scaffold: esbuild build, `tsc --noEmit` for main and renderer, `node:test` unit tests
- [x] Read credentials: `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`), macOS Keychain
      `Claude Code-credentials`; prefer the freshest token
- [x] Fetch via `net.fetch`; tolerant parser (`limits[]` first, legacy keys fallback, weekly
      breakdown, extra-usage spend)
- [x] Polling service: 180 s default, extra poll after the earliest reset, backoff, `Retry-After`,
      expired / 401 handling without retrying a rejected token, refresh on wake / unlock
- [x] Overlay window: transparent, frameless, always-on-top, draggable, fit-to-content with
      corner anchoring, position memory, recovery when a display disappears
- [x] Expanded card and compact pill; animated rings and bars; stale, error and loading states
- [x] Tray icon with a live ring of the most constrained limit; tooltip; shared context menu
      (show/hide, refresh, compact, always on top, opacity, refresh interval, move to display,
      reset position, quit)
- [x] Settings file and last-snapshot cache in userData
- [x] Mock scenarios, screenshot mode, `npm run screenshot`
- [x] Docs: `CLAUDE.md`, `README.md`, `docs/PROGRESS.md`, `docs/BACKLOG.md`, phase files

## Out of scope

Installers, app icon and launch at login (Phase 2); claude.ai fallback source (Phase 3);
notifications and other UX extras (Phase 4); app auto-update (Phase 5).

## Technical notes

- `ELECTRON_RUN_AS_NODE` is set in VS Code / Claude Code terminals; `scripts/start.mjs` and
  `scripts/screenshots.mjs` remove it before launching Electron.
- On Windows, drag regions swallow mouse events: controls are `no-drag`, and right-click on the card
  is handled through the window's `system-context-menu` event.

## Acceptance criteria

- Real data shown on Windows ✅ — session 8 %, weekly 52 %, Fable 37 %, local reset times correct.
- 28 unit tests pass, both type-check configs clean ✅
- All mock scenarios render correctly in expanded and compact views ✅

## Manual test checklist (for the user)

- [ ] `npm start` shows the overlay top-right and a ring icon in the tray (Windows 11 may hide it
      behind the **^** arrow; drag it onto the taskbar).
- [ ] Drag the card, quit, start again — it reopens at the same place.
- [ ] Drag it to the second monitor; also try menu → **Move to display**.
- [ ] **⋯** button and right-click on the card open the menu.
- [ ] The arrows button switches to the compact pill and back.
- [ ] Tray: left-click hides/shows the overlay; right-click opens the menu.
- [ ] **Opacity**, **Refresh every** and **Always on top** take effect.

## Prompt

_Not needed — this phase is done. To continue, use the Phase 2 prompt in
[phase-2-packaging.md](phase-2-packaging.md)._

## Result

Delivered everything in Scope in session 1 (2026-09-24). Verified: startup, real-data rendering,
window sizing, settings persistence, all mock scenarios via screenshots, unit tests.
Not verified: mouse dragging, tray clicks and menus by hand (needs the user), macOS and Linux.
Known limitation: Claude Code's token expires after ~8 h without use → "sign-in expired" banner
until Claude Code renews it (Phase 3 adds a fallback).
