# Phase 10 — Show the overlay on one virtual desktop

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-30) — released as 1.5.0; owner's manual tests pending (a real tray click on another desktop, a Task View drag, removing a desktop) |
| **Depends on** | Phase 7 (a window per account: per-window settings, window vs. tray menu) |
| **Size** | One Claude Code session |

## Goal

Someone with a single monitor can park the overlay on a virtual desktop of its own (Windows Task
View desktops, macOS Spaces, Linux workspaces) and switch to that desktop to look at their usage,
instead of having it cover part of their work. By default it stays on every desktop, as today.

## Background

- Owner's request (2026-09-29): a menu that lists all desktops and shows the app on only the chosen
  one — useful with one monitor, where the overlay covers part of the screen; switching to its
  desktop shows the numbers. Default: all desktops.
- **Today:**
  - **Windows:** the overlay has no taskbar button (`skipTaskbar: true`), and a window without one
    belongs to no desktop, so Windows shows it on every desktop. Verified on the installed 1.4.1:
    `IVirtualDesktopManager::GetWindowDesktopId` returns `GUID_NULL` for both overlay windows and
    `IsWindowOnCurrentVirtualDesktop` is true, while VS Code windows report their own desktops.
  - **macOS:** `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` since Phase 1 — on
    every Space and over full-screen apps.
  - **Linux:** nothing is set: an X11 window manager keeps the overlay on the workspace it opened
    on; on Wayland the compositor decides.
- **Experiments on this machine (Windows 11 23H2, build 22631, session 31)** — throw-away test
  windows, off-screen and never activated; the owner's desktop was never switched:
  1. A window's desktop comes from its **taskbar button**. `ITaskbarList::DeleteTab` (what
     Electron's `skipTaskbar` does) → the window leaves its desktop (`GUID_NULL`, shown on all);
     `AddTab` (`setSkipTaskbar(false)`) → it joins the *current* desktop. `MoveWindowToDesktop` on
     a window without a button returns `S_OK` and does nothing. So **"only on desktop N" needs a
     taskbar button**; with the public API there is no way around it (Windows shows that button
     only on desktop N's taskbar with its default setting).
  2. `MoveWindowToDesktop` works **only for the calling process's own windows**: from another
     process it returns `E_ACCESSDENIED` (0x80070005). A PowerShell / `reg.exe`-style helper can't
     do it — the call must run inside the app's main process.
  3. **Hiding loses the desktop:** after `hide()` the window has no desktop
     (`TYPE_E_ELEMENTNOTFOUND`); the next `show()` puts it on the *current* desktop. Calling
     `MoveWindowToDesktop` right after `showInactive()` puts it back (it is cloaked at once:
     `DWMWA_CLOAKED` = 2, "cloaked by the shell").
  4. HWND_TOPMOST doesn't change any of this: a topmost window on another desktop is cloaked too.
  5. **Spike in Electron 44.4.5 with koffi 3.3.2** (scratch folder, not the repo): a
     BrowserWindow like the overlay (frameless, transparent, `skipTaskbar`, `'pop-up-menu'` level).
     `require('koffi')` 9 ms; `RegGetValueW` read the desktop list in 1 ms; `CoCreateInstance` of
     the public `VirtualDesktopManager` succeeded on Electron's main thread without
     `CoInitializeEx`; `setSkipTaskbar(false)` + an immediate `MoveWindowToDesktop` (HWND from
     `getNativeWindowHandle()`) put the window on desktop 2 (cloaked here); hide → show → Move again
     worked; `setSkipTaskbar(true)` → back on all desktops.
  6. The registry is live: `CurrentVirtualDesktop` followed the owner's switches during the session,
     and a desktop the owner added showed up in `VirtualDesktopIDs` at once. The `Desktops\` subkey
     also held a stale GUID that is in no list — list desktops from `VirtualDesktopIDs` only.
- Web research (session 31, sources in **Technical notes → Research**): Microsoft documents only
  the three methods of `IVirtualDesktopManager` and says there is no API to list desktops; moving
  "will not work for windows that your process doesn't own". Electron has no workspace API on
  Windows (`setVisibleOnAllWorkspaces` is macOS / Linux only; issue #5362 open since 2016, #34676
  closed "as intended"). Apps that solved the same problem did it with a taskbar-level window:
  Notezilla's notes were on every desktop until a setting made each note "a separate top level
  window", which users can then move to one desktop; Task View's own *Show this window on all
  desktops* exists only for windows with a taskbar button.
- The owner chose real placement with `koffi` over the dependency-free "mimic" on 2026-09-29, accepting
  the taskbar button on the chosen desktop (D78).
- Rules that apply: hard rule 6 (`koffi` approved, D78), hard rule 5
  (cross-platform, gaps recorded), D60 (blank-overlay watchdog), D61 (always-on-top level), D62–D64
  (windows, menus).

## Scope

- [x] **Setting per window** (`WindowSettings.desktop`, like `position` — D62): absent / `null` =
      all desktops (default; old settings migrate to it). Windows: the chosen desktop's GUID plus
      its 1-based number (fallback when the GUID is gone). macOS / Linux X11: "only one desktop"
      (no id — see Technical notes). Sanitizer and tests.
- [x] **`virtual-desktops-core.ts`** `[pure]`: parse `VirtualDesktopIDs` (16-byte GUIDs in order),
      `CurrentVirtualDesktop` and `Desktops\{GUID}\Name` into `{ id, number, name, current }[]`
      (default name `Desktop N`); resolve a saved choice against the list (GUID → else the same
      number → else all desktops); the menu entries. Unit tests with byte fixtures shaped like this
      machine's values (three desktops, one stale `Desktops\` key, no names, a named one, an empty
      list).
- [x] **`virtual-desktops.ts`** (Windows): loads `koffi` lazily on Windows only; reads the registry
      values (`RegGetValueW`, read-only) and calls the public, documented `IVirtualDesktopManager`
      (`IsWindowOnCurrentVirtualDesktop`, `GetWindowDesktopId`, `MoveWindowToDesktop`) for the
      app's own windows. Any failure (koffi missing, COM error, Windows without virtual desktops)
      → one log line, the feature reports "not available", and the overlay stays on all desktops.
      Never the undocumented interfaces.
- [x] **Placing a window:** one desktop → `setSkipTaskbar(false)` + `MoveWindowToDesktop`; all
      desktops → `setSkipTaskbar(true)`. Applied at the first show, after every show (tray click,
      shortcut, notification click, menu), after a rebuild (D60) and when the setting changes — one
      helper in `overlay.ts`, not scattered calls.
- [x] **Menu → *Show on desktop* ▸** (next to *Move to display* / *Reset position*): ◉ *All
      desktops* (default), a separator, one radio per desktop in Windows' order with its name
      (*Desktop 2*, or the name the user gave it) and *(current)* on the one the user is on. With a
      single desktop: that desktop plus a disabled hint *Add a desktop: Win+Ctrl+D*. A window's
      menu acts on that window; the tray menu with several windows on all of them (D63). The list
      is read fresh whenever a menu is built (1 ms) and the tray menu is refreshed when the cursor
      reaches the tray icon (`mouse-move`), so added / renamed desktops show up.
- [x] **Where the window really is wins:** when the user drags the overlay to another desktop in
      Task View, or removes its desktop (Windows moves its windows to a neighbour), the app adopts
      the window's actual desktop (`GetWindowDesktopId`) the next time it builds a menu or shows
      the window, and saves it.
- [x] **"Visible" means visible here:** show / hide (tray click, `Ctrl+Alt+U`, the menu's
      *Show / Hide overlay*) treats an overlay on another desktop as not visible, so a click never
      hides a window the user can't see. What a click does then — switch to the overlay's desktop by
      activating it, or only show it there — is decided by the experiment in Technical notes.
- [x] **Blank-overlay watchdog (D60)** and **hover polling (D57)** skip a window that is on another
      desktop (with the occlusion tracker on, `--keep-occlusion`, such a page may be hidden and
      must not trigger a rebuild).
- [x] **macOS:** *Show on desktop* ▸ *All desktops* / *Only this desktop* (the Space the user is
      on), through `setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true, visibleOnFullScreen:
      true })`; no list.
- [x] **Linux X11:** the same two items (*All workspaces* / *Only this workspace*) through
      `setVisibleOnAllWorkspaces`; the default *All* now applies on Linux too (today the overlay
      stays on its first workspace). **Wayland:** the submenu shows a disabled *Not available on
      Wayland* line.
- [x] **Packaging:** `koffi` in `dependencies`, `external` in `scripts/build.mjs` (like
      `electron-updater`, D45); its native `.node` file must load from the packaged app
      (`app.asar.unpacked`) — checked with `npm run dist:win` and the installed / portable exe.
- [x] **Mock and screenshots:** mock runs use the real desktops (it only moves the mock's own
      window); screenshot runs never move windows. Card and pill are unchanged, so README images,
      social preview and site renders are unaffected (check).
- [x] **Docs:** README (feature, FAQ "the overlay covers my work on one monitor", the taskbar button
      on one desktop), site feature line (D76), `CLAUDE.md` (modules, hard rule 6: second runtime
      dependency, gotchas below), `docs/PROGRESS.md` decisions, Electron book chapter (virtual
      desktops, calling Win32/COM with koffi, why the taskbar button matters, pitfalls).

## Out of scope

- Creating, removing, renaming or switching desktops, and a *Go to desktop N* item: only the
  undocumented `IVirtualDesktopManagerInternal` can, and its IIDs change with Windows builds.
- Pinning through the undocumented `IVirtualDesktopPinnedApps`; "all desktops" stays the
  no-taskbar-button state it is today.
- Hiding the taskbar button while the overlay is on one desktop (impossible with the public API;
  the "mimic" that hides the overlay on other desktops instead was rejected — D78, Technical notes).
- A list of Spaces on macOS or of workspaces on Linux (no public API; see Technical notes), and
  anything on Wayland.
- Different content per desktop.

## Technical notes

**Windows — calling the API.** `IVirtualDesktopManager` (CLSID
`aa509086-5ca9-4c25-8f95-589d3c07b48a`, IID `a5cd92ff-29be-454c-8d04-d82879fb3f1b`; vtable after
`IUnknown`: 3 `IsWindowOnCurrentVirtualDesktop(HWND, BOOL*)`, 4 `GetWindowDesktopId(HWND, GUID*)`,
5 `MoveWindowToDesktop(HWND, REFGUID)`). With koffi: `CoCreateInstance` → `ppv[0]`; vtable =
`koffi.decode(obj, 'void *')`; method *i* = `koffi.decode(vtbl, i * 8, 'void *')`; call with
`koffi.call(fn, koffi.proto('long __stdcall …(void *self, intptr_t hwnd, …)'), obj, hwnd, …)`. HWND
= `win.getNativeWindowHandle().readBigUInt64LE(0)`. HRESULTs come back signed (`hr >>> 0` to print).
Keep one COM object per app; release it on quit. Registry: `RegGetValueW(HKCU, key, value,
RRF_RT_REG_BINARY, …)` twice (size, then data); HKCU as `intptr_t` is `-2147483647`. That is all the
spike needed (results: experiment 5 and session 31's log entry).

**Why koffi.** Electron has no virtual-desktop API on Windows (`setVisibleOnAllWorkspaces` is macOS /
Linux only) and Node has no usable built-in FFI (Electron 44 ships Node 24.21: `node:ffi` is
unknown there; it is experimental from Node 26.1 and not in GN builds such as Electron's); the move
must run in-process (experiment 2). Options:

| Option | Verdict |
| --- | --- |
| **koffi** (MIT, Node-API so no rebuild per Electron version, prebuilt per platform as optional packages — only `@koromix/koffi-win32-x64`, ~1 MB, is installed on Windows) | **Chosen; approved by the owner 2026-09-29 (hard rule 6, D78).** Verified in Electron 44. Pin the exact version. |
| Own Node-API addon in C++ | No npm dependency, but a C++ toolchain locally and in CI, and more code to own. |
| No native code: `setSkipTaskbar(false)` only ("only the desktop you are on now") | Loses the desktop after every hide/show, rebuild and restart (experiment 3) — not reliable. |
| Undocumented `IVirtualDesktopManagerInternal` from a helper process | Works across processes, but its IID changed five times since 2021 (twice in monthly cumulative updates: 22621.2215, 22631.3085) and 24H2 inserted a vtable slot without a new IID, so a wrong slot calls the wrong method silently. Rejected. |
| **"Mimic"** — no taskbar button, stay on all desktops, hide the overlay while the current desktop (registry) isn't the chosen one | The only way **without a new dependency**, and no taskbar button. But it needs a live watcher of `CurrentVirtualDesktop`: polling `reg.exe` (a process start every ~0.5 s for as long as the app runs) or a hidden long-running PowerShell helper (tens of MB, `Add-Type`); the overlay would appear / vanish after Windows' slide animation instead of moving with it; every show path must ask "is the chosen desktop current?". Offered to the owner; **rejected** in favour of koffi (D78). |

**Desktop list (read-only).** `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops`:
`VirtualDesktopIDs` (REG_BINARY, 16 bytes per desktop in Task View order), `CurrentVirtualDesktop`
(16 bytes), `Desktops\{GUID}\Name` (REG_SZ, only for desktops the user renamed). The GUID bytes are
in Windows' `GUID` layout (first three fields little-endian). Only `VirtualDesktopIDs` counts; the
`Desktops\` subkeys may hold leftovers. `CurrentVirtualDesktop` can be missing before the first
switch of a session; read it like PowerToys (FancyZones) does: this key, else
`…\Explorer\SessionInfo\<session id>\VirtualDesktops` (Windows 10 keeps it there;
`ProcessIdToSessionId`), else the first ID. With a single desktop `VirtualDesktopIDs` may be missing
too: then there is one desktop and nothing to choose.

**Taskbar button while on one desktop.** Unavoidable (experiment 1). It carries the app icon and the
title; clicking it activates the overlay; its *Close window* closes that overlay window (Phase 7
rules: the last one only hides). The overlay also shows in Alt+Tab and Task View on that desktop —
which also lets the user drag it to another desktop there (the app then adopts it). Check what
clicking the button of the already active overlay does (the window isn't minimizable).

**After every show.** Call `MoveWindowToDesktop` right after `showInactive()` (verified to work
immediately). Watch for a one-frame flash on the current desktop; if there is one, show at opacity 0
and restore it after the move.

**Tray click while the overlay is on another desktop.** Raymond Chen: "When a window becomes
foreground, the system switches to the virtual desktop that the window belongs to"; when the
foreground rules refuse, the taskbar button flashes instead. Right after a tray click the app may
take the foreground, so activating the overlay (`win.show()` + `focus()`) should switch to its
desktop — the same as choosing it in Alt+Tab. Try it once in the implementing session
**with the owner's OK** (it switches their desktop). If it switches: tray click / shortcut on
another desktop = "take me to the overlay". If not: show it there and do nothing else. The app never
activates windows on its own (start, rebuild, updates use `showInactive`), so it never pulls the
user to another desktop uninvited.

**macOS.** Leaving *All desktops* must pass `{ skipTransformProcessType: true, visibleOnFullScreen:
true }`: without it Electron calls `DockShow()` (a Dock icon appears, the window hides for a
moment). Without `canJoinAllSpaces` the window stays on the Space it is on (shown by the workaround
in Electron #5362, not by Apple's docs). There is no public API to list Spaces or move a window to
one (Apple DTS, 2026); the private CGS calls still work for an app's own windows on some versions
but are undocumented — not used. So after a restart the overlay opens on the Space that is active
then. The Dock's *Assign To* needs a Dock icon, which the `LSUIElement` app doesn't have. Untested
(no Mac), like the rest of the macOS build.

**Linux.** X11 (Chromium's `X11Window`): `setVisibleOnAllWorkspaces(true)` sets
`_NET_WM_STATE_STICKY` and `_NET_WM_DESKTOP` = 0xFFFFFFFF; `false` sends the *current* desktop, which
pins the window there — exactly *Only this workspace*. Listing workspaces or moving to workspace N
would need `xprop` / `wmctrl` / `xdotool` (not installed by default) or native code — out of scope.
Wayland: Chromium's `SetVisibleOnAllWorkspaces` is a no-op and Electron 38+ runs natively on
Wayland; `ext-workspace-v1` is for taskbars and can't place a window. Detect Wayland
(`XDG_SESSION_TYPE=wayland` and Electron not forced to X11) and show the disabled line; the README
points to the desktop's own option (GNOME: Alt+Space → *Always on Visible Workspace*; KDE: a window
rule). GNOME's X11 session is gone in Ubuntu 25.10 and Fedora 43, so most Linux users are on
Wayland. Untested (no Linux machine).

**Windows 10.** Same public API and the same `VirtualDesktopIDs`; the current desktop may be only
under `SessionInfo` (handled above); whether renamed desktops (Windows 10 2004+) use the same
`Desktops\{GUID}\Name` is unverified, and Windows 10 may give desktops new GUIDs after a sign-out —
the number fallback covers that. Only Windows 11 is tested (D49); record what isn't verified.

**Risks.** A new runtime dependency with native code (one maintainer): pin the exact version, lazy
load, feature off when it fails to load. `MoveWindowToDesktop` returning errors on odd setups
(Windows Server without Task View, Remote Desktop sessions, Explorer restarting): log once, keep the
window where it is, try again at the next show. Explorer restart recreates the taskbar: a window
with a taskbar button gets it back from the shell (`TaskbarCreated`) — check the overlay keeps its
desktop.

**Research (session 31).**

- `IVirtualDesktopManager`: <https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ivirtualdesktopmanager> ·
  "doesn't own" / no enumeration API: <https://learn.microsoft.com/en-us/archive/blogs/winsdk/virtual-desktop-switching-in-windows-10> ·
  Raymond Chen on desktops and foreground: <https://devblogs.microsoft.com/oldnewthing/20171002-00/?p=97116> and
  <https://devblogs.microsoft.com/oldnewthing/20201123-00/?p=104476>
- Windows without a taskbar button on all desktops: <https://resource.dopus.com/t/unattended-errors-dialog-present-on-all-virtual-desktops/22966> ·
  Notezilla: <https://www.conceptworld.com/qa/466/sticky-notes-on-all-virtual-desktops>
- Registry reading order: PowerToys `src/modules/fancyzones/FancyZonesLib/VirtualDesktop.cpp`.
  Undocumented IID history: VD.ahk, MScholtes/VirtualDesktop, Ciantic/VirtualDesktopAccessor releases.
- Electron: <https://www.electronjs.org/docs/latest/api/browser-window> (`setVisibleOnAllWorkspaces`) ·
  <https://github.com/electron/electron/issues/5362> · <https://github.com/electron/electron/issues/34676> ·
  `shell/browser/native_window_views.cc` (`skipTaskbar` = `DeleteTab`, `type: 'toolbar'` =
  `WS_EX_TOOLWINDOW`, also on all desktops) · `native_window_mac.mm` (`DockShow()`).
- Node FFI: <https://nodejs.org/api/ffi.html> · koffi: <https://koffi.dev/> (packaging with
  electron-builder "should work as-is"; the app keeps it `external`, so esbuild never bundles the
  `.node` file).
- macOS: <https://developer.apple.com/forums/thread/830748> (no public Spaces API) ·
  <https://github.com/Hammerspoon/hammerspoon/issues/3636> (14.5 broke moving other apps' windows) ·
  <https://support.apple.com/guide/mac-help/mh14112/mac> (Dock *Assign To*).
- Linux: Chromium `ui/ozone/platform/x11/x11_window.cc`; GNOME's lost *Always on Visible
  Workspace*: <https://gitlab.gnome.org/GNOME/mutter/-/issues/3076>.

## Acceptance criteria

- Fresh install or old settings: the overlay is on every desktop, no taskbar button — exactly as
  1.4.1.
- Windows 11 with three desktops: menu → *Show on desktop* lists *All desktops* and *Desktop 1–3*
  (with *(current)* on the right one and a renamed desktop under its name); choosing *Desktop 3*
  from Desktop 1 makes the overlay disappear here and appear on Desktop 3 (Win+Ctrl+→); it stays
  there after hide/show, the watchdog's rebuild and a restart of the app; *All desktops* brings it
  back everywhere and removes the taskbar button.
- Two windows (Phase 7): each window's own menu places only that window; the tray menu places both.
- Removing the overlay's desktop or dragging it in Task View: the menu then shows where it really
  is.
- A tray click while the overlay is on another desktop never hides it unseen.
- If koffi can't load, the menu says the feature isn't available and everything else works.
- `npm run check` passes (new pure-module tests); `npm run screenshot` reviewed (no change
  expected); packaged Windows build checked (installer and portable exe load koffi).
- `docs/PROGRESS.md`, `docs/BACKLOG.md`, README, site, `CLAUDE.md`, the Electron book and this
  file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] With several desktops (Win+Ctrl+D adds one): right-click the overlay → *Show on desktop*: all
      desktops are listed, the current one marked; a desktop you renamed in Task View shows its name.
- [ ] Pick another desktop: the overlay disappears here; Win+Ctrl+→ to that desktop: it is there,
      with a taskbar button on that desktop only.
- [ ] On that desktop: `Ctrl+Alt+U` twice (hide, show) — it stays on that desktop; on another
      desktop, a tray click: note what happens (switches to the overlay's desktop, or nothing).
- [ ] Quit and start the app (or restart Windows with *Launch at login*): the overlay comes back on
      its desktop.
- [ ] Task View (Win+Tab): drag the overlay to another desktop, then open its menu: the new desktop
      is checked.
- [ ] *All desktops*: the overlay is on every desktop again and the taskbar button is gone.
- [ ] With two account windows: put each on a different desktop.
- [ ] Pick another desktop from the overlay's **own** menu (⋯), then press `Ctrl+Alt+U` at once: it
      takes you to the overlay (the case the experiment found). Menu → *Open logs folder* →
      `claude-usage.log` says each time "Windows switched to the overlay's desktop", "stayed", or
      "Windows refused it the foreground".
- [ ] On the overlay's desktop, click its taskbar button (once while it is active, once after
      clicking another window): note what happens.
- [ ] Remove the overlay's desktop in Task View (its ×): Windows moves the overlay to a neighbour;
      the menu then checks that one.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 10 of Claude Usage as specified in docs/phases/phase-10-virtual-desktops.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

**Delivered (session 32, 2026-09-29/30).** Menu → *Show on desktop* ▸ (next to *Move to display*):
Windows lists *All desktops* and every Task View desktop with its name and *(current)*, a single
desktop gets the *Add a desktop: Win+Ctrl+D* hint; macOS *All desktops* / *Only this desktop*;
Linux X11 *All workspaces* / *Only this workspace*; Wayland and a failed Windows setup one disabled
line. Setting per window (`WindowSettings.desktop`: GUID + number, null = all), a window's menu moves
that window, the tray menu with several windows all of them (nothing checked while they differ).

- `virtual-desktops-core.ts` [pure] + 16 tests: GUID bytes ↔ text, `VirtualDesktopIDs` /
  `CurrentVirtualDesktop` / names → list (stale `Desktops\` key ignored, missing current → first,
  no IDs → the current one alone), GUID → number → all, `choiceToSave` (a desktop is dropped only
  when the list could be read and has neither its GUID nor its number), `adoptDesktop`, sanitizer,
  Wayland detection, menu entries (`&` → `&&` on Windows), the tray's common selection, log names
  (numbers only, never desktop names).
- `virtual-desktops.ts`: koffi 3.3.2 (exact version, `external` in esbuild) loaded on first use on
  Windows only — `RegGetValueW` (read-only), `ProcessIdToSessionId` (Windows 10's `SessionInfo`
  fallback), `CoCreateInstance` of the public `VirtualDesktopManager` (vtable slots 3–5, released on
  quit), plus `GetForegroundWindow` / `FindWindowW` / `SetForegroundWindow` / `FlashWindowEx` (see
  below). Any failure → one log line, the submenu says *Not available on this computer*, the overlay
  stays on all desktops. macOS / Linux: `setVisibleOnAllWorkspaces` (macOS with
  `skipTransformProcessType`), applied once per window; Linux X11 waits for the first show.
- `overlay.ts`: one helper, `placeOnDesktop()`, at creation (also a rebuilt window), after every
  show and on a setting change; `syncDesktop()` adopts where the window really is before a menu is
  built, before hiding, rebuilding and quitting; `isVisibleHere()`; `activate()`; the watchdog
  re-checks later while the window is on another desktop (one grace round once back); hover asks
  `onThisDesktop` only while the cursor is within the bounds.
- `main.ts`: `toggleAll` hides only windows visible on this desktop; `revealAll` (tray click,
  shortcut, *Show overlay*, a notification, a second start) shows hidden ones and, when none can be
  seen here, activates one; the first menu item says *Show* when nothing is here; the tray menu is
  rebuilt when the cursor reaches the icon (`mouse-move`, at most once a second).
- README (feature, *Virtual desktops* section, three Troubleshooting entries), site (feature card
  line, FAQ "I have one monitor"), CLAUDE.md, PROGRESS (D79–D82), Electron book 3.5 (two chapters).

**Deviations from the plan (and why).**

- *Where the window really is* is read **before hiding** (and before menus, rebuilds, quitting),
  not "the next time it shows the window": a hidden window has no desktop any more (experiment 3),
  so at show time there is nothing to read.
- **Tray click / shortcut on another desktop — the experiment** (with the owner's OK, a mock run and
  a test accelerator pressed with `keybd_event`): run 1 switched to the overlay's desktop; the way
  back did nothing, because the overlay was still the foreground window (it had just been activated,
  then moved by its menu) and activating the foreground window changes nothing — the same happens in
  the real app when a desktop is picked from the overlay's own menu and the shortcut pressed right
  after. A fresh run switched again. After the fix, one run was refused by Windows (the owner had just
  clicked in another app). So activation is kept ("take me to the overlay", the plan's first branch)
  with two additions: a window that already is the foreground window first hands the foreground to
  the taskbar (`Shell_TrayWnd`, on every desktop), and a refused activation stops the flashing
  taskbar button Windows starts on the other desktop (`FlashWindowEx(FLASHW_STOP)`), so nothing
  changes then. Four more user32 functions, all public and documented. The log says each time
  whether Windows switched. No focus-stealing tricks (Alt-key simulation, `AttachThreadInput`).
- **No opacity-0 trick:** a poller in another process (~1 million samples/s) saw the window visible,
  uncloaked and not yet on its target desktop 0 times in 15 hide → show cycles — a hidden window
  keeps its shell cloak until it is moved.
- koffi is loaded when the tray menu is first built, i.e. **at startup** on Windows (~10 ms), not
  only at the first user action: the tray menu needs the desktop list.
- With `--keep-occlusion` a page on another desktop really is `hidden` (measured), so the watchdog
  change was necessary; with the default (tracker off) it stays `visible` there.

**Verified on this machine** (Windows 11 23H2, four desktops; mock runs driven through the
main-process inspector, the window probed read-only from another process): the default is on all
desktops without a button (`GUID_NULL`); the menu lists the four desktops with *(current)* matching
the registry; choosing one moves the window there (cloaked, `onCurrent=0`) and saves it; restart →
back on its desktop; hide → show → back; a GPU-process kill → the rebuilt window goes back; a move
behind the app's back (in-process `MoveWindowToDesktop`, standing in for a Task View drag) is
adopted and saved when the menu opens; *All desktops* → `GUID_NULL` again; two windows: each
window's menu moves only it, the tray menu both, *Show overlays* when none is here; koffi missing
(folder renamed for a moment) → *Not available*, one log line, the rest works; `--keep-occlusion` on
another desktop → no rebuild for 20 s; the packaged app (`release/win-unpacked`, i.e. what the
installer installs — not installed over the owner's copy) and the portable exe load koffi and move
the window. `npm run check` (190 tests), `npm run screenshot` (no visual change, so the README
images, social preview and site renders stay as they are).

**Not verified:** a real tray click and the physical shortcut on another desktop (foreground rules
may differ from the injected key), a real Task View drag and removing a desktop (both covered by the
same adoption), Explorer restarting (taskbar recreated), clicking the taskbar button of the active
(non-minimizable) overlay, the refused-activation flash stop in practice, the tray menu refresh on
`mouse-move`, a renamed desktop in the real menu (unit-tested; the owner's desktops have no names),
Windows 10, the very first show after start (the window is uncloaked for < 1 ms before the move; not
measured), macOS and Linux (no machines), and CI builds on macOS / Linux with koffi.

**Follow-ups:** the owner's manual tests below; released as 1.5.0 (D84); macOS can't tell a window on another Space, so the shortcut there may hide an
overlay the user can't see (no public API).
