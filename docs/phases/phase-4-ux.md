# Phase 4 — UX: notifications, click-through, shortcut, size, pace forecast

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-26) |
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

- [x] **Threshold notifications** — native `Notification` when a limit crosses 75 %, 90 % and
      100 %, once per limit per window (key = limit id + `resetsAt`); optional "limit has reset"
      notice. Submenu to toggle each; persisted in settings; pure de-dup module with tests.
- [x] **Lock (click-through) mode** — toggle in menu and tray;
      `win.setIgnoreMouseEvents(true, { forward: true })`; subtle lock indicator on the overlay;
      unlock via tray, menu or shortcut (the overlay itself can't be clicked while locked).
- [x] **Global shortcut** to show/hide — default `Ctrl+Alt+U` (`Cmd+Option+U` on macOS); handle
      registration failure gracefully; show the active shortcut in the menu.
- [x] **Size scale** — 90 / 100 / 115 / 130 / 150 % via `webContents.setZoomFactor`, persisted.
- [x] **Pace forecast** — keep a snapshot history (in memory + last ~24 h persisted in userData);
      when the projected time to 100 % is before the reset, show "At this pace: limit in ~1h 20m"
      under the session (and weekly if relevant). Pure module with tests; hidden when data is too
      sparse.
- [x] **Theme** (optional) — System / Dark / Light using the existing CSS variables; dark stays
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
Implement Phase 4 of Claude Usage as specified in docs/phases/phase-4-ux.md
(threshold notifications, lock/click-through mode, global shortcut, size scale, pace forecast,
optional light theme). Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Do not add any
API requests — everything must work from the existing polling. Follow the phase file's Scope,
Out of scope, Technical notes and Acceptance criteria; if the session gets long, finish and verify
notifications, lock mode and shortcut first, then ask me before continuing. When done: fill in the
phase file's Result section, set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give
me the manual test steps in Persian.
```

## Result

Done 2026-09-26 in one session (decisions D35–D40 in [PROGRESS.md](../PROGRESS.md)). No new API
requests: everything is computed from the snapshots the regular polling already fetches.

**Notifications** — `notifications-core.ts` (pure, 14 tests) decides, `notifications.ts` shows them.
Menu → *Notifications*: *At 75%*, *At 90%*, *When a limit is reached (100%)*, *When a limit resets
(after 75%+)* — all on by default — and *Send a test notification*. One notification per limit,
threshold and window; if one poll jumps over several thresholds only the highest is shown. Windows
are matched loosely instead of by the exact `resetsAt` string (D35): `resets_at` differs by
fractions of a second between responses and Claude Desktop samples have none. The records live in
`userData/notifications.json`, so a restart doesn't repeat anything. Clicking a notification shows
the overlay; the text adds "At this pace: limit in ~…" when there is a forecast. Screenshot runs
never notify; mock runs keep their records in memory.

**Lock (click-through)** — menu → *Lock (click-through)* (same menu in the tray),
`setIgnoreMouseEvents(true, { forward: true })`, persisted. While locked the header / pill buttons
are replaced by a small lock icon. Unlock from the tray menu or the lock shortcut; toggling the lock
also shows a hidden overlay.

**Global shortcuts** — `Ctrl+Alt+U` shows/hides, `Ctrl+Alt+Shift+U` locks/unlocks (`⌘⌥U` / `⌘⌥⇧U`
on macOS). A second shortcut was added because a locked overlay can't be clicked (D37). Menu →
*Keyboard shortcuts*: one switch for both plus their status ("— in use by another app" when
registration fails, which is also logged); the working ones appear next to *Hide overlay* / *Lock*.
The accelerators can be changed in `settings.json` (`toggleShortcut`, `lockShortcut`; a modifier is
required). Unregistered on quit; never registered by screenshot runs.

**Size** — menu → *Size*: 90 / 100 / 115 / 130 / 150 %, persisted, via `setZoomFactor`; the window is
the renderer's CSS size × zoom factor. Chromium stores a zoom level per page in
`userData/Preferences` and prefers it to `webPreferences.zoomFactor`, so the setting is applied
again on `did-navigate` (found when a 150 % run leaked into the next one). `Ctrl` `+` / `-` / `0`
and `Ctrl`+wheel step through the same options instead of plain page zoom, which would have cropped
the window. `fitToContent` now keeps the top-left visible when the card is bigger than the display.

**Pace forecast** — `pace.ts` (pure, 11 tests): history of fresh snapshots (last 24 h,
`userData/usage-history.json`), least-squares slope over the current window's points (same reset
time ± 1 h) in the last hour (session) or day (weekly limits), ≥ 3 points over ≥ 15 min, rising
only, projected from the latest point, shown only if 100 % comes before the reset and the data is
fresh (D39). Rendered as "At this pace: limit in **~1h 15m**" under the session and under each
weekly bar it applies to (rounded to 5 min). Not available with Claude Desktop data (no reset
times).

**Theme** — menu → *Theme*: *System* / *Dark* (default) / *Light* via `nativeTheme.themeSource`
and `prefers-color-scheme` (D40). Hard-coded colours became CSS variables with the same dark values;
the dark screenshots are pixel-identical to before except the clock times. The light theme changes
neutrals and text colours only (new `--warn-text`, `--crit-text`, `--brand-text`); severity colours
are unchanged.

**Also** — `format.ts` moved to `src/shared/` (main needs it for notification text; `formatApprox`
added); new mock scenarios `forecast` and `locked`; `--theme=` and `--scale=` flags; the screenshot
script adds light-theme and 90 % / 150 % variants. Tests 71 → 102.

**Verified on Windows 11** (mock runs): both warning notifications delivered (read back from
Windows' notification database, under the app's AppUserModelId); lock sets `WS_EX_TRANSPARENT` and
the window under the overlay's position becomes the app behind it; the shortcuts hide/show and
lock/unlock (synthesized key presses); a shortcut held by another program is reported and the other
one still works; the `locked` scenario starts click-through; `Ctrl` `+`/`-`/`0` through the inspector
walk 100 → 115 → 130 → 150 → 130 → 100 % with the window resized and nothing cut off; theme switch
at runtime; menu shows the shortcuts.

**Not verified / caveats:** macOS and Linux untested (Linux ignores `forward`; Wayland has no global
shortcuts without the portal; macOS asks for notification permission first). Windows notifications
in dev worked because an installed build left its Start-menu shortcut (AppUserModelId); without it
they may not appear in dev. On keyboard layouts where AltGr = Ctrl+Alt, `Ctrl+Alt+U` can swallow an
AltGr character (change it in `settings.json`). Details in PROGRESS.md → Known issues.
