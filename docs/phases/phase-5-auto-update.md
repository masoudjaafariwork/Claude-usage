# Phase 5 — App auto-update

| | |
| --- | --- |
| **Status** | Planned |
| **Depends on** | Phase 2 (installers + GitHub release workflow) |
| **Size** | One Claude Code session |

## Goal

When a new version is released on GitHub, installed copies update themselves quietly — the user
never has to download and reinstall by hand.

## Background

Phase 2 produces installers and draft GitHub Releases in `masoudjaafariwork/Claude-usage`.
Auto-update needs a runtime dependency (`electron-updater`), which CLAUDE.md says must be approved
by the user first.

## Scope

- [ ] Ask the user to approve `electron-updater` as a runtime dependency before adding it.
- [ ] `publish` config for the GitHub provider (owner `masoudjaafariwork`, repo `Claude-usage`);
      CI uploads `latest*.yml` update metadata together with the installers.
- [ ] Check 30 s after startup and every 6 h; download in the background; when ready, the menu
      shows "Restart to update to vX.Y.Z". No modal dialogs.
- [ ] Windows (NSIS) and Linux (AppImage) auto-update. macOS: signed auto-update only if the user
      has an Apple Developer ID; otherwise the menu shows "Update available — open download page".
- [ ] "Check for updates" menu item with visible feedback (up to date / downloading / ready / error).
- [ ] README: release procedure (bump version, tag, push, publish the draft release).

## Out of scope

Code-signing purchase/setup, delta updates, beta channels.

## Technical notes

- **Private repo:** if the repository is private, `electron-updater` needs a token to read
  releases — that must not be shipped inside the app. Ask the user whether the repo will be public;
  if not, propose an alternative (e.g. a public releases-only repo).
- The **portable exe** and the **deb** package cannot auto-update; show "download" instead.
- Updates install on quit (`autoInstallOnAppQuit`) or immediately via the menu item
  (`quitAndInstall`); make sure settings are flushed first.
- Log updater events to the Phase 3 log file (if it exists).
- Test with two real versions (e.g. 0.3.0 → 0.3.1) published as releases; the user publishes them.

## Acceptance criteria

- On Windows, an installed older version detects, downloads and installs a newer published release.
- "Check for updates" reports each state correctly.
- `npm run check` passes; docs updated (`docs/PROGRESS.md`, `docs/BACKLOG.md`, this file's
  **Result**, README release steps).

## Manual test checklist (for the user)

- [ ] Install version A; publish version B on GitHub.
- [ ] Within a minute of starting A (or via **Check for updates**) the menu shows
      "Restart to update to B".
- [ ] Click it — the app restarts as version B with the same settings and position.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 5 of Claude Usage as specified in docs/phases/phase-5-auto-update.md
(in-app auto-update from GitHub Releases). Read CLAUDE.md, docs/PROGRESS.md and that phase file
first. Ask me before adding electron-updater, and ask whether the GitHub repository is public before
designing the update source. Never push, tag or publish releases yourself — tell me exactly what to
run and when. Follow the phase file's Scope, Out of scope, Technical notes and Acceptance criteria.
When done: fill in the phase file's Result section, set its status, update docs/PROGRESS.md and
docs/BACKLOG.md, and give me the manual test steps in Persian.
```

## Result

_Not started._
