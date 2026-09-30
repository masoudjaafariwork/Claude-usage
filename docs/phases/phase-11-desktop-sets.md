# Phase 11 — Several desktops per window, and a desktop picker

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-30) — planned and built in session 35; released as 1.6.0 |
| **Depends on** | Phase 10 (show the overlay on one virtual desktop, D78–D82) |
| **Size** | One Claude Code session |

## Goal

Each overlay window can be shown on any set of Windows virtual desktops — for example one account's
window on desktops 1 and 2 and the other account's only on desktop 3 — chosen in a small picker that
stays open while the user ticks, instead of one desktop from a menu.

## Background

- Owner's request (2026-09-30), after Phase 10 shipped in 1.5.0: checkboxes instead of radio items,
  so a window can be on desktops 1 and 2, another one only on desktop 3, and so on. After trying it:
  "nothing may close — neither the menu nor the submenu — while I tick".
- **Windows has no "some desktops".** A window belongs to exactly one desktop (with a taskbar button)
  or to none, which means all of them (session 31, experiment 1). Only the undocumented pinning
  interface knows "all" as a state of its own, and D78 rules it out anyway. So a window on a set of
  desktops has to **follow the user** among them: it stays on one desktop of its set, and when the
  user switches to another desktop of its set, the app moves it there.
- **Native menus close on every click** (Win32 `TrackPopupMenu`; Electron has no option against it).
  Ticking three desktops would mean opening the menu three times.
- **Measured (session 35, Windows 11 23H2, four desktops):**
  - A window moved onto the current desktop is shown 2 ms after the call (20 rounds, off-screen test
    window: median 2.2 ms, max 2.8 ms; the call itself ~2 ms).
  - During 6 of the owner's normal switches (an invisible logger of the registry notification and of
    the cloak / uncloak WinEvents): the change notification of `CurrentVirtualDesktop` came 0–12 ms
    after the first window of the switch was cloaked / uncloaked — at the start of Windows' switch,
    together with the new desktop's own windows.
  - With the built follower (mock run, desktops 1, 3 and 4, the owner switching freely): the overlay
    was shown on the new desktop 20–35 ms after the notification, every time it was one of its
    desktops, and never on desktop 2.
- Phase 10's rules stay: taskbar button while not on all desktops (D78), placement after every show
  and "where the window really is wins" (D79), "visible means visible here" and activation (D80),
  macOS / Linux all-or-this-one (D81), koffi loading (D82).

## Scope

- [x] **Setting:** `WindowSettings.desktops` (a list of `{ id, number }`; null = all desktops)
      replaces `desktop`; the old value becomes a one-entry list (`null` stays null). Sanitized:
      deduplicated, at most 50 entries, an empty list = all. macOS / Linux keep their one
      "only this desktop" entry (`{ id: null, number: null }`). Going back to 1.5.0 forgets the
      choice (all desktops) — nothing breaks.
- [x] **Desktop picker (Windows):** menu → *Show on desktops…* (the window's menu, and the tray menu)
      opens a small window in the overlay's look: a row per overlay window (its account), a column for
      *All desktops* and one per desktop (its name, *current* under the one the user is on). It stays
      open while the user ticks; Esc, ✕ or a click elsewhere closes it. The row of the window whose
      menu opened it is marked. While *All desktops* is ticked every desktop is too; ticking the last
      missing desktop = *All desktops*; the last ticked desktop is locked (still shown ticked);
      unticking *All desktops* = only the current desktop. With one desktop a hint: *Add a desktop
      with Win+Ctrl+D*.
- [x] **macOS / Linux:** unchanged (two radio items); in the tray menu with several windows a submenu
      per window.
- [x] **Placement of a set (Windows):** one entry = Phase 10. Two or more: the window goes to the
      current desktop when it is in the set, else it stays on (or goes back to) the desktop of the
      set it was last on, else the first of the set in Task View order. After every show, rebuild (the
      new window keeps the old one's desktop) and setting change, as in D79.
- [x] **Following (Windows):** while a window's set has two or more desktops, a watch of the registry
      key `…\Explorer\VirtualDesktops` (change notification, no polling) reports desktop switches; a
      shown window whose set contains the new current desktop is moved there. It never goes to a
      desktop outside its set. The watch runs only while such a window exists; its changes also
      refresh the tray menu and an open picker.
- [x] **Resolving a saved set:** entries whose GUID is in the list count; when none is (Windows 10
      may give every desktop a new GUID after a sign-out) the numbers count; when nothing is left,
      all desktops (saved as null). An unreadable list changes nothing (as D79).
- [x] **Where the window really is wins (D79, for sets):** found on a desktop outside its set (Task
      View drag, its desktop removed), that desktop replaces the one the window was on; on a desktop
      of its set, nothing changes.
- [x] Logs: "Show on desktop → desktops 1, 2" (numbers only), "following desktop switches" on / off;
      each follow move isn't logged, errors once.
- [x] Tests for the pure parts: sanitizer and migration, resolving, the target desktop, toggling,
      adoption, the picker's cells and state, a click by column, popup placement, log names.
- [x] README, site, `CLAUDE.md`, `docs/PROGRESS.md` (decisions), Electron book.

## Out of scope

- Sets on macOS and Linux (no list of Spaces / workspaces — D81).
- Making the window slide in with the desktop when the user enters another desktop of its set: it
  shows up once the switch is noticed (20–35 ms measured). Only the undocumented pinning could keep
  one window on several desktops, and only on all of them.
- Keeping the native menu open, or rebuilding the whole menu in HTML (a phase of its own; the owner
  chose the picker).

## Technical notes

**Following vs. the alternatives.**

| Way | On entering a desktop of the set | On leaving to a desktop outside it | Verdict |
| --- | --- | --- | --- |
| **Follow:** always on one desktop (taskbar button), moved on switches | shows up once the switch is noticed (the one it already is on: slides in with it) | slides away with its desktop — never seen outside its set | **Chosen** |
| All desktops, hidden while the current desktop is outside the set | smooth between desktops of the set | stays on screen until the switch is noticed, then vanishes — e.g. over the desktop used for screen sharing | Rejected: shows the overlay where the user doesn't want it |
| Undocumented pinning / `MoveViewToDesktop` | — | — | Rejected (D78) |

**Watch (koffi).** `RegOpenKeyExW(HKCU, VirtualDesktops, KEY_NOTIFY | KEY_QUERY_VALUE)`,
`CreateEventW` (auto-reset), `RegNotifyChangeKeyValue(key, FALSE, REG_NOTIFY_CHANGE_LAST_SET, event,
TRUE)` on the main thread (the registration belongs to the calling thread, which lives as long as
the app), then `WaitForSingleObject.async(event, INFINITE)`: koffi runs the wait on a worker thread
and calls back on the main thread. There: arm again first, then read (so a change between the signal
and the re-arm isn't lost), then move windows. Stopping: a flag and `SetEvent`; the callback closes
the key and the event. One libuv worker thread is blocked while the watch runs.

**Picker vs. the alternatives.**

| Way | Verdict |
| --- | --- |
| Checkboxes in the submenu (first build) | The menu closes on every click. |
| After a click, open only the desktop list again at the cursor (second build) | Tried by the owner: the main menu still closed — "nothing may close". |
| The whole menu rebuilt in HTML | Literally "nothing closes", but a big, risky change (30+ items, submenus, keyboard, monitors, DPI, tray, macOS / Linux). |
| **A picker window** for the desktops (like Task Manager's *Select columns*) | **Chosen by the owner.** Also sets every window from one place. |

The picker (`desktop-picker.ts`, `picker.html` / `picker.ts` / `picker.css`, `picker-preload.ts`) is
a second sandboxed page with its own four-call API (`onState`, `pick`, `resize`, `close`); main checks
that each message comes from the picker's `webContents`. It is frameless, transparent, always on top
(`applyAlwaysOnTop`), without a taskbar button (so on every desktop), at the Size setting, and opens
at the cursor (`popupBounds` in `window-core.ts`: above it when there is no room below, e.g. from the
tray). The checkboxes are drawn in CSS: Chromium greys out a disabled checkbox even when it is ticked,
which would read as "not on this desktop".

## Acceptance criteria

- Windows 11 with four desktops: *Show on desktops…* → untick desktops until one account is on 1
  and 2: the window is on 1 and 2 only — switching 1 → 2 brings it along, 2 → 3 leaves it behind,
  3 → 1 shows it again; after hide/show and a restart it still follows.
- Two windows: one on 1 and 2, the other only on 3 — set in the picker, also for a window that isn't
  on the current desktop. The picker stays open while ticking.
- The last ticked desktop is locked; ticking every desktop shows *All desktops* ticked, and the
  window has no taskbar button.
- Settings of 1.5.0 (`desktop`) are read as the same choice.
- `npm run check` passes; `npm run screenshot` shows no change to the overlay.

## Manual test checklist (for the user)

- [x] Right-click the overlay → *Show on desktops…*: the picker opens at the cursor and stays open
      while ticking; Esc closes it. (Owner, mock run with two accounts, 2026-09-30.)
- [x] Switch between desktops with `Win+Ctrl+←/→`: each window is only on its ticked desktops.
      (Owner, same run.)
- [ ] Tray icon → *Show on desktops…*: the picker opens above the tray.
- [ ] Quit and start the app: the windows come back on their desktops and follow again.
- [ ] Tick every desktop again: *All desktops* is ticked and the taskbar button is gone.

## Prompt

This phase was planned and built in the same session; the prompt is kept for reference.

```text
Implement Phase 11 of Claude Usage as specified in docs/phases/phase-11-desktop-sets.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

**Delivered (session 35, 2026-09-30).** Decisions D85 (sets that follow the user) and D86 (the
desktop picker) in `docs/PROGRESS.md`.

- `virtual-desktops-core.ts` [pure]: `DesktopSet`, `sanitizeDesktopSet` (with the 1.5.0 migration),
  `resolveDesktops`, `setToSave`, `targetDesktop`, `adoptDesktops`, `toggleDesktop`, `desktopCells`,
  `desktopPickerState`, `pickDesktop`, `desktopLogName` for sets; the radio entries stay for macOS /
  Linux. `window-core.ts`: `popupBounds`. Tests 190 → 195.
- `virtual-desktops.ts`: `place()` for sets (current desktop in the set, else the one it was on, else
  the first; no move when already there), `RegistryWatch` (`RegNotifyChangeKeyValue` + koffi
  `.async` wait) behind `watch(on, onChange)`, `carryOver()` for a rebuilt window.
- `overlay.ts`: `setDesktops()`, `onSeveralDesktops`, `followDesktop()` (adopt first, then place).
  `main.ts`: `watchDesktops()` with every tray update (the watch runs only while a window has two or
  more desktops), the picker's host (rows = windows, key = the account's folder or '' for the
  default), `setDesktops()`. `menu.ts`: *Show on desktops…* on Windows, radio submenus elsewhere
  (per window in the tray with several windows).
- `desktop-picker.ts`, `src/preload/picker-preload.ts`, `src/renderer/picker.{html,ts,css}`, two more
  esbuild entries and static files in `scripts/build.mjs`; `DesktopPickerState` / `DesktopPickerApi`
  in `shared/types.ts`.

**Deviations from the plan (and why).**

- The plan had checkboxes in the submenu. The owner found that the menu closes on every click; a
  second build that reopened only the list after each click was rejected too ("nothing may close").
  Offered the picker window or an HTML rebuild of the whole menu; the owner chose the picker (D86).
  The tray's per-window submenus remain only for macOS / Linux.
- A rebuilt window (D60) takes over the old window's desktop of its set (`carryOver`), which the
  plan hadn't mentioned.

**Verified on this machine** (Windows 11 23H2, four desktops, one monitor):

- Mock run through the main-process inspector: from *All desktops*, unticking 3 and 4 saved
  `[1, 2]`, the window stayed on desktop 2 (the current one) with a taskbar button; `[3, 4]` put it
  on desktop 3 (cloaked here); back to `[1, 2]` → desktop 2; tray click hide → show → desktop 2 again;
  the watch starts and stops with the sets (log).
- Following, with the owner switching desktops (invisible logger of the registry notification and
  the window's cloak / uncloak, see Background): on a desktop of its set 20–35 ms after the
  notification every time; never on a desktop outside it.
- The picker: rendered offscreen in dark, light and at 150 % (checked by eye); the owner's own test
  with two account windows — many clicks in a row on both rows with the picker open, then switching
  desktops: "everything was right".
- `npm run check` (195 tests); `npm run screenshot` (`normal`, `several-accounts`): the overlay is
  unchanged, so README images, social preview and site renders stay as they are.

**Not verified:** the picker opened from the tray (position above the taskbar is unit-tested), a
restart with a set of several desktops (the same placement code as after a show), a real Task View
drag or removed desktop with a set (the adoption rule is unit-tested), Windows 10, macOS and Linux.
