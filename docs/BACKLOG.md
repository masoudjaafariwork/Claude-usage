# Backlog

Index of the roadmap. Every phase has its own plan file in [`phases/`](phases/) with goal, scope,
technical notes, acceptance criteria, a manual test checklist, a ready-to-paste **Prompt** and a
**Result** section that is filled in when the phase is done.

## Phases

| # | Phase | Status | Plan |
| --- | --- | --- | --- |
| 1 | MVP overlay | ✅ Done (2026-09-24) | [phase-1-mvp-overlay.md](phases/phase-1-mvp-overlay.md) |
| 2 | Packaging, app icon, launch at login | ✅ Done (2026-09-24) | [phase-2-packaging.md](phases/phase-2-packaging.md) |
| 3 | Fallback data source (Claude Desktop), source selection & diagnostics — claude.ai sign-in dropped (D28) | ✅ Done (2026-09-25) | [phase-3-fallback-source.md](phases/phase-3-fallback-source.md) |
| 4 | UX: notifications, click-through, shortcut, size, pace forecast, theme | ✅ Done (2026-09-26) | [phase-4-ux.md](phases/phase-4-ux.md) |
| 5 | App auto-update | ✅ Done (2026-09-26) — real-release test (0.3.0 → 0.3.1) by the owner | [phase-5-auto-update.md](phases/phase-5-auto-update.md) |

**Running a phase:** open a new Claude Code session in this repo, open the phase file, copy the
text in its **Prompt** block, paste it, send. Run phases in order, one per session.

## General prompts

**Resume / orient** — start of any new session:

```text
Read CLAUDE.md, docs/PROGRESS.md and docs/BACKLOG.md. Summarize (in Persian) where the project
stands, what was decided, and what the next step is. Then wait for my instructions.
```

**Change or bug** — anything small that doesn't need its own phase:

```text
<Describe the change or bug here, with screenshots or exact steps if possible.>

Follow CLAUDE.md. Check the decisions in docs/PROGRESS.md before changing behaviour and tell me if
the request conflicts with one. Add or update tests where logic changes, run `npm run check`, and
for UI changes run `npm run screenshot` and review the PNGs; if the README images are affected,
also run `npm run screenshot:readme` and review docs/images. Finally update docs/PROGRESS.md
(session log, decisions, known issues) and docs/BACKLOG.md if an item is affected.
```

**Plan a new phase** — for a bigger feature; creates a new plan file, doesn't implement it:

```text
I want to add: <describe the feature>.
Read CLAUDE.md, docs/PROGRESS.md and docs/BACKLOG.md. Research what's needed, then create
docs/phases/phase-<next number>-<slug>.md from docs/phases/_TEMPLATE.md (goal, background, scope,
out of scope, technical notes, acceptance criteria, manual test checklist, prompt). Add it to the
Phases table in docs/BACKLOG.md. Don't implement anything yet — show me the plan in Persian first.
```

## Ideas (unscheduled)

Move an idea into a phase file (with the "Plan a new phase" prompt) when it's time to build it.

- Multiple accounts (several `CLAUDE_CONFIG_DIR`s) with a switcher. (No claude.ai sign-ins — D28.)
- Weekly usage history sparkline (Claude Desktop's `plan-usage-history.json` keeps 30 days of
  samples; `desktop-source.ts` already parses it).
- Other providers (e.g. Codex) side by side.
- Persian (fa) UI with RTL layout and a language setting.
- "Hide from screen capture" option (`win.setContentProtection`) for screen sharing.
- Tray-only / menu-bar-only mode (no overlay).
- Extract the rest of the pure window-position math from `window.ts` (reachability, default corner)
  into `window-core.ts` and unit-test it (the resize placement is there since D44).
- Show which limit is binding (`is_active`) once its meaning is confirmed.
- Code signing: a Windows certificate (no SmartScreen warning) and an Apple Developer ID with
  notarization (no "Open Anyway" step).
- arm64 builds for Windows and Linux.
- Pace forecast in the compact pill and the tray tooltip (today only in the expanded card).
- Change the global shortcuts from the menu (today only in `settings.json`, D37); on Wayland,
  global shortcuts through the GlobalShortcuts portal.
- A manual "build only" trigger (`workflow_dispatch`) for the release workflow, to test CI without a tag.
- Updates: a menu switch to turn automatic checks off; a small "update ready" dot on the overlay's
  ⋯ button; delta downloads (upload `*.blockmap`, drop `disableDifferentialDownload`); real macOS
  auto-update once there is an Apple Developer ID (zip target + signing + notarization in CI);
  deb auto-update through electron-updater's `DebUpdater` (asks for the admin password).
- Report the Electron login-item bug (paths with spaces) upstream; drop the `reg.exe` workaround
  once it is fixed (D18).
