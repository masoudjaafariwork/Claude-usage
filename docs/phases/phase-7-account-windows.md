# Phase 7 — A window per Claude Code account

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-28) — released as 1.3.0 |
| **Depends on** | Phase 6 (several Claude Code accounts) |
| **Size** | One Claude Code session |

## Goal

Someone with several Claude Code accounts can give each account its own overlay window, see them
all at once, and close any one of them on its own — while the single switchable overlay of Phase 6
keeps working as before for everyone who opens no second window.

## Background

- Phase 6 (D50) shows one account at a time and switches between them; "several accounts shown at
  the same time" stayed an idea in `BACKLOG.md`. The owner asked for it on 2026-09-28: "a separate,
  dedicated window for each account, and each one can be closed separately".
- Polling (hard rule 2): every open window polls its own account with that account's own token —
  one request per account per interval, the same rate each account had when it was the one shown.
  An account without a window costs nothing.
- Rules that stay: read-only credentials (D3), no claude.ai sign-in (D28), Claude Desktop counts
  only for its own org (D51), per-account state files (D52).

## Scope

- [x] Settings: `windows` — one entry per open window: its account (default or an added folder),
      its position, its view (expanded / compact). The first entry is the main window. Old settings
      (`position`, `compact`, `claudeCodeDir`) become the first entry; one window per account.
- [x] Each window owns its account's usage service, cached snapshot, pace history, notification
      records and credentials watch (`overlay.ts`); everything else stays global (look, lock,
      always-on-top, size, opacity, theme, source, interval, notifications, shortcuts).
- [x] Menu of a window (⋯, right-click): *Claude Code account* switches **this** window (an account
      shown in another window is greyed out), *Open in its own window ▸* opens a new window for an
      account that has none, *Close this window*. Compact mode, Move to display and Reset position
      act on that window; Refresh on its account.
- [x] Tray menu with several windows: *Claude Code account* lists every account with a checkbox
      (window open / closed); Compact mode, Refresh, Move to display and Reset position act on all
      windows (placed side by side). With one window the tray menu is the same as before.
- [x] A close button (×) on the card and the compact pill while more than one window is open;
      Alt+F4 closes that window too. The last window can't be closed, only hidden (as before).
- [x] Show / hide (tray click, shortcut, menu) and lock act on all windows together.
- [x] A new window without a saved position opens next to the others along the top of the display
      (right to left), not on top of them.
- [x] Tray icon: the most constrained limit of all windows; tooltip one line per account.
      Notifications name the account while several windows are open.
- [x] `--claude-config-dir`: shows that account's window if it has one, otherwise switches the main
      window (as in Phase 6).
- [x] Mock scenario `several-accounts` (two windows); screenshot runs capture every window.
- [x] Tests for the pure parts (settings migration, placement, menu entries, notification text).
- [x] README, docs, Electron book.

## Out of scope

- Several windows for the same account (no extra requests for the same numbers).
- Per-window look (size, opacity, theme, always-on-top, lock) — global, as before.
- Claude Desktop per account: unchanged (D51).
- One combined card with all accounts (another layout; an idea, not this phase).

## Technical notes

- One window per account keeps one request per account: a second window for the same account would
  double its requests for nothing. The account a window shows is also its key in `settings.windows`.
- Phase 6's switch (`UsageService.accountChanged` with its generation guard) stays: each window
  switches like the single overlay did.
- IPC: messages are routed to the window whose `webContents` sent them.
- The blank-overlay watchdog (D60), hover (D57), drag guard (D44) and rebuild after a GPU death work
  per window; the app restart stays global.
- Windows toasts and the tray tooltip (127 characters) are short: the account label is the e-mail
  (or the folder while *Show account* is off, e.g. screen sharing).

## Acceptance criteria

- With two accounts, *Open in its own window* shows a second overlay for the other account next to
  the first; each shows its own numbers, e-mail and banners; each closes on its own (×, menu,
  Alt+F4); after a restart the same windows come back where they were.
- Without a second window, everything looks and behaves as in 1.2.
- `npm run check` passes; `npm run screenshot` reviewed; README images unaffected (their scenarios
  have one window) — checked.
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] Right-click the overlay → *Claude Code account* → *Open in its own window* → pick the other
      account: a second overlay opens beside the first with that account's e-mail and numbers.
- [ ] Both windows show × ; click × on one: it closes, the other stays (and loses its ×).
- [ ] Open it again, then quit and start the app: both windows come back at their places.
- [ ] Tray click / `Ctrl+Alt+U` hides and shows both; *Lock* locks both.
- [ ] Tray menu → *Claude Code account*: checkboxes show which accounts have a window; unticking
      one closes it.
- [ ] Compact mode on one window only (its own button): the other stays expanded.
- [ ] A notification at 75 % names the account.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 7 of Claude Usage as specified in docs/phases/phase-7-account-windows.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

Done 2026-09-28 (session 23), in the same session as the plan. Decisions D62–D64 in
`docs/PROGRESS.md`. Released as 1.3.0 (a new feature: a minor version by SemVer, D65).

### What was built

- `src/main/overlay.ts` (new, class `Overlay`): one window and its account — usage service, pace
  history and forecast, notifier with the account's records, credentials watch, snapshot cache;
  fit, drag guard (D44), hover (D57), rebuild and blank watchdog (D60), Phase 6's switch
  (`switchAccount`, with `UsageService.accountChanged`'s generation guard).
- `main.ts`: the global wiring and a list of windows; `openWindow` / `closeWindow` (last one only
  hides) / `switchAccount` (an account shown elsewhere just shows) / `showAll` / `toggleAll`; IPC
  routed by `event.sender`; `menuFor(window | null)`; GPU death rebuilds every window; screenshot
  runs capture every window.
- `settings.ts`: `windows: { account, position, compact }[]` with the old keys migrated in the
  sanitizer; one per account, at least one.
- `menu.ts`: scope `'window'` / `'all'`, *Close this window*, *Open in its own window ▸*, greyed-out
  accounts shown elsewhere, tray checkboxes, *Open Claude Code — (account)* per account.
- `window-core.ts` `freeSpot()` and `window.ts` `arrangeOnDisplay()`: side by side along the top.
- `tray.ts`: ring over all windows, tooltip one line per account. `notifications-core.ts`: the
  account at the start of the body. `claude-accounts.ts`: `chooseFolder` returns `account`,
  menu entries know `hasWindow`, `accountShortLabel`, `accountLogName`.
- Renderer: `canClose` in `AppState`, × button (header and compact pill), `closeWindow()` in the
  preload API (`window:close`).
- Mock scenario `several-accounts`; tests 147 → 151 plus updated settings / accounts tests.

### Deviations

- None from the scope. Mock runs reset their windows to the scenario on every start (as they already
  did with the account folder), so the restart check was done in a real run.

### Verification

Windows 11, 4 monitors:

1. Mock run (`other-account`, own `--user-data-dir`) driven through the main-process inspector
   (menus captured by patching `Menu.prototype.popup` / `Tray.prototype.setContextMenu`, items
   clicked with `MenuItem.click()`): open in its own window, both windows' menus, the tray menu,
   compact per window, ×, Alt+F4 (second window closes, the last only hides), show / hide all.
2. Real run (own `--user-data-dir`, installed app untouched): Revaal folder + default account in two
   windows, each with its own e-mail and numbers; after a restart both came back at the same
   places and polled once each; the folder's files in `accounts/<key>/`.
3. `npm run check` (151 tests); all 42 mock screenshots reviewed (single-window ones unchanged);
   README / social-preview images unaffected.

**Not verified:** clicks with a real mouse on the native menu and the × button, a threshold
notification naming the account, three or more accounts, macOS and Linux.
