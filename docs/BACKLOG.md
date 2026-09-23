# Backlog

Index of the roadmap. Every phase has its own plan file in [`phases/`](phases/) with goal, scope,
technical notes, acceptance criteria, a manual test checklist, a ready-to-paste **Prompt** and a
**Result** section that is filled in when the phase is done.

## Phases

| # | Phase | Status | Plan |
| --- | --- | --- | --- |
| 1 | MVP overlay | ✅ Done (2026-09-24) | [phase-1-mvp-overlay.md](phases/phase-1-mvp-overlay.md) |
| 2 | Packaging, app icon, launch at login | ⏭️ Next | [phase-2-packaging.md](phases/phase-2-packaging.md) |
| 3 | Fallback data source (claude.ai sign-in) & diagnostics | Planned | [phase-3-fallback-source.md](phases/phase-3-fallback-source.md) |
| 4 | UX: notifications, click-through, shortcut, size, pace forecast | Planned | [phase-4-ux.md](phases/phase-4-ux.md) |
| 5 | App auto-update | Planned | [phase-5-auto-update.md](phases/phase-5-auto-update.md) |

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
for UI changes run `npm run screenshot` and review the PNGs. Finally update docs/PROGRESS.md
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

- Multiple accounts (several `CLAUDE_CONFIG_DIR`s / claude.ai accounts) with a switcher.
- Weekly usage history sparkline.
- Other providers (e.g. Codex) side by side.
- Persian (fa) UI with RTL layout and a language setting.
- "Hide from screen capture" option (`win.setContentProtection`) for screen sharing.
- Tray-only / menu-bar-only mode (no overlay).
- Extract the pure window-position math from `window.ts` and unit-test it.
- Show which limit is binding (`is_active`) once its meaning is confirmed.
