# Phase 4 — UX: notifications, click-through, shortcut, size, pace forecast

| | |
| --- | --- |
| **Status** | Planned |
| **Depends on** | Phase 1; Phase 2 recommended (Windows notifications work best from an installed app) |
| **Size** | One Claude Code session (split in two if it grows) |

## Goal

Make the overlay useful without looking at it: warn before a limit is hit, stay out of the way of
mouse clicks, toggle it with a shortcut, scale it, and predict when a limit will be reached at the
current pace.

## Background

All data needed is already fetched by the polling service. No additional API requests are allowed
in this phase (see CLAUDE.md hard rule 2).

## Scope

- [ ] **Threshold notifications** — native `Notification` when a limit crosses 75 %, 90 % and
      100 %, once per limit per window (key = limit id + `resetsAt`); optional "limit has reset"
      notice. Submenu to toggle each; persisted in settings; pure de-dup module with tests.
- [ ] **Lock (click-through) mode** — toggle in menu and tray;
      `win.setIgnoreMouseEvents(true, { forward: true })`; subtle lock indicator on the overlay;
      unlock via tray, menu or shortcut (the overlay itself can't be clicked while locked).
- [ ] **Global shortcut** to show/hide — default `Ctrl+Alt+U` (`Cmd+Option+U` on macOS); handle
      registration failure gracefully; show the active shortcut in the menu.
- [ ] **Size scale** — 90 / 100 / 115 / 130 / 150 % via `webContents.setZoomFactor`, persisted.
- [ ] **Pace forecast** — keep a snapshot history (in memory + last ~24 h persisted in userData);
      when the projected time to 100 % is before the reset, show "At this pace: limit in ~1h 20m"
      under the session (and weekly if relevant). Pure module with tests; hidden when data is too
      sparse.
- [ ] **Theme** (optional) — System / Dark / Light using the existing CSS variables; dark stays
      exactly as it is.

## Out of scope

Settings window (menus are enough for now), history charts (idea list), new data sources.

## Technical notes

- **Zoom and window size:** `getBoundingClientRect()` returns CSS pixels; with a zoom factor the
  window needs `cssSize × zoomFactor` DIPs. Fix the `window:resize` path accordingly and keep
  fit-to-content exact at every scale.
- **Notifications on Windows** need the AppUserModelId (already set) and show the app name
  properly only when installed (Start menu shortcut) — in dev they may say "Electron".
- `setIgnoreMouseEvents(…, { forward: true })` is supported on Windows and macOS; on Linux it may
  ignore `forward` — record the caveat.
- `globalShortcut` must be unregistered on quit; conflicts return `false` from `register`.
- **Pace forecast:** use points from the current window only (same `resetsAt`), require ≥ 3 points
  spanning ≥ 15 min, use a least-squares slope, ignore negative slopes, round output to 5 min.
- Add mock scenarios for new states (locked, forecast visible) so screenshots cover them.

## Acceptance criteria

- Crossing 75 / 90 / 100 % produces exactly one notification each per window (unit-tested).
- Locked overlay lets clicks through to windows underneath; unlock works from tray, menu and
  shortcut.
- Shortcut toggles the overlay; scale changes keep the card fully visible and correctly sized.
- Forecast appears only when meaningful (unit-tested with synthetic histories).
- `npm run check` passes; screenshots reviewed; macOS/Linux caveats recorded in PROGRESS.md.
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** updated.

## Manual test checklist (for the user)

- [ ] Run `node scripts/start.mjs --mock=warning` and confirm a notification appears for limits
      above 75 %.
- [ ] Menu → **Lock** — clicks go through the overlay; unlock from the tray.
- [ ] Press `Ctrl+Alt+U` twice — overlay hides and shows.
- [ ] Menu → **Size** → 130 % — card grows and nothing is cut off.
- [ ] During heavy use, "At this pace…" appears under the session.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 4 of Claude Usage Overlay as specified in docs/phases/phase-4-ux.md
(threshold notifications, lock/click-through mode, global shortcut, size scale, pace forecast,
optional light theme). Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Do not add any
API requests — everything must work from the existing polling. Follow the phase file's Scope,
Out of scope, Technical notes and Acceptance criteria; if the session gets long, finish and verify
notifications, lock mode and shortcut first, then ask me before continuing. When done: fill in the
phase file's Result section, set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give
me the manual test steps in Persian.
```

## Result

_Not started._
