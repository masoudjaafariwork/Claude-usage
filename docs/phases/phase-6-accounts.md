# Phase 6 — Several Claude Code accounts (config folders) with a switcher

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-26) — released as 1.1.0 |
| **Depends on** | Phase 3 (sources), account indicator (D41) |
| **Size** | One Claude Code session |

## Goal

Someone who keeps several Claude Code accounts in separate config folders (`CLAUDE_CONFIG_DIR`,
e.g. one VS Code profile per account) can add those folders to the overlay and switch between the
accounts from the menu — or from the script that opens that account's VS Code — without quitting
the app or setting environment variables.

## Background

- The owner runs several Claude Code accounts, each with its own VS Code started from a `.bat`
  that sets `CLAUDE_CONFIG_DIR` (e.g. `D:\Revaal\claude-config`) and passes `--user-data-dir` /
  `--extensions-dir` to `code`.
- Today the overlay honours `CLAUDE_CONFIG_DIR` only from its own environment at startup: one
  account per run, the single-instance lock blocks a second copy, and launch at login always uses
  the default folder. Idea in `BACKLOG.md`: "Multiple accounts (several `CLAUDE_CONFIG_DIR`s) with
  a switcher".
- Claude Code (2.1.283, read in its code): with `CLAUDE_CONFIG_DIR` set, the sign-in is
  `<dir>/.credentials.json` (Windows/Linux) or the Keychain item
  `Claude Code-credentials-<first 8 hex of sha256(dir)>` (macOS), and the account file is
  `<dir>/.claude.json`; without it `~/.claude/.credentials.json`, `Claude Code-credentials` and
  `~/.claude.json`.
- Rules that stay: read-only credentials (D3), no claude.ai sign-in (D28), polite polling (hard
  rule 2) — one account is polled at a time.

## Scope

- [x] Pure `claude-accounts.ts`: where a folder's sign-in and account file live (incl. the macOS
      Keychain name), folder comparison, a per-account state key, menu labels; unit tests.
- [x] Settings `claudeCodeDirs` (added folders) and `claudeCodeDir` (selected; `null` = default:
      `CLAUDE_CONFIG_DIR` of the app's environment, else `~/.claude`).
- [x] `credentials.ts` reads from a given location instead of the environment.
- [x] Menu → *Claude Code account*: default + added folders as radio items (e-mail when known and
      *Show account* is on), *Add folder…* (folder picker, warns when the folder has no Claude Code
      files), *Remove folder*.
- [x] Switching: poll the new account at once, show its own cached snapshot meanwhile, never let a
      poll that was running for the old account land on the new one; the credentials watch follows
      the folder.
- [x] Per-account state: last snapshot, pace history and notification records live in
      `userData/accounts/<key>/` (the default account keeps the existing files).
- [x] Command-line switch `--claude-config-dir=<folder>` (or `default`), also to a running copy
      (single-instance `second-instance` event), so an account's `.bat` can switch the overlay.
- [x] *Open Claude Code* for an added folder: a terminal running `claude` with
      `CLAUDE_CONFIG_DIR` set (the VS Code URI would open the default profile's account); the
      Claude Code binary bundled in the VS Code extension counts when the CLI isn't installed.
- [x] README (features, how it works, troubleshooting), docs, Electron book.

## Out of scope

- Showing several accounts at the same time (one request per account per interval, a bigger card)
  — stays an idea.
- Detecting config folders automatically, or reading VS Code profiles.
- Per-account launch scripts ("Open Claude Code" running the user's own `.bat`).
- Claude Desktop per account: Desktop has one sign-in; its samples keep D29/D41 (labelled with the
  selected account only when the org matches). *(Changed during the phase — see Result, D51.)*

## Technical notes

- The macOS Keychain name hashes the folder string exactly as Claude Code got it (`normalize('NFC')`,
  no path resolution): a folder picked in the dialog matches when the environment variable held the
  same absolute path without a trailing slash.
- Folder comparison: `path.resolve`, trailing separators removed, case-insensitive on Windows and
  macOS. Adding the default folder selects the default entry instead.
- The state key hashes the resolved folder (not the e-mail): a `/login` to another account in the
  same folder behaves as today for the default folder.
- `UsageService` needs a generation counter: a switch while a request is in flight must discard that
  request's result (it would otherwise flash the old account and enter the new account's history).
- `second-instance` passes the other copy's argv and working directory; relative paths resolve
  against it. The option parser must tolerate extra Chromium switches.
- macOS: `open -a Terminal <file>` doesn't pass environment variables, so the terminal route for an
  added folder writes a small `.command` script to the temp folder (untested, no Mac available).

## Acceptance criteria

- With an added folder selected, the overlay shows that folder's account (e-mail line, numbers);
  switching back shows the default account again, each with its own forecast history.
- A switch never shows or records the previous account's data as the new one's.
- `"Claude Usage.exe" --claude-config-dir=<folder>` switches a running overlay and adds the folder
  when needed; `--claude-config-dir=default` switches back.
- `npm run check` passes; `npm run screenshot` reviewed.
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] Menu → *Claude Code account* → *Add folder…* → pick `D:\Revaal\claude-config`: the card
      shows that account's e-mail at once. Its token had expired (2026-09-24), so it says
      "Claude Code sign-in expired" — not Claude Desktop's numbers of the other account.
- [ ] Click **Open Claude Code**: a console opens running `claude` for that folder (not VS Code);
      once Claude Code has renewed the token the overlay shows Revaal's numbers within seconds.
      (Or just use Claude Code in the Revaal VS Code — the overlay notices the renewed file too.)
- [ ] Switch back to the default entry: the first account's numbers come back.
- [ ] Add `start "" "%LOCALAPPDATA%\Programs\claude-usage\Claude Usage.exe" --claude-config-dir="D:\Revaal\claude-config"`
      to the account's `.bat`: running it switches the overlay (also when it is already running).
- [ ] Quit and start the app: it starts on the account selected last.
- [ ] *Remove folder* removes it; if it was selected, the overlay goes back to the default account.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 6 of Claude Usage as specified in docs/phases/phase-6-accounts.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

Done 2026-09-26 (session 16), released as **1.1.0**. Decisions D50–D55 in `docs/PROGRESS.md`.

### What was built

- `src/main/claude-accounts.ts` (pure, 7 tests): `claudeCodeLocation()` (config folder,
  `.claude.json`, macOS Keychain name `Claude Code-credentials-<sha256(dir)[:8]>`),
  `normalizeFolder` / `sameFolder`, `chooseFolder()` (default folder → default entry, known folder
  reused, new one added, ≤ 20), `accountStateKey()`, `folderLabel()` / `accountMenuEntries()`,
  `configDirArg()` for `--claude-config-dir=<folder|default>`.
- `credentials.ts`: `readCredentials(location)` / `readClaudeCodeAccount(location)` instead of
  reading `CLAUDE_CONFIG_DIR` from the environment.
- Settings `claudeCodeDirs` / `claudeCodeDir` (sanitized; a selection must be in the list).
- Menu → *Claude Code account*: radio items "e-mail — folder" (the default one marked
  "(default)"; folders only while *Show account* is off), *Add folder…* (folder picker; warns when
  the folder has neither `.claude.json` nor `.credentials.json`), *Remove folder* (deletes that
  account's state).
- Switching (`main.ts` → `switchAccount`): location, credentials watch, pace history, notification
  records and cached snapshot follow the account; `UsageService.accountChanged()` shows the cached
  snapshot (or none), polls at once and drops a still-running request of the old account (generation
  counter, tested). `--claude-config-dir` at start and in `second-instance` (a running copy
  switches, then shows itself).
- *Open Claude Code* for an added folder: terminal with `CLAUDE_CONFIG_DIR` (VS Code URI skipped);
  `claude` from PATH or the newest VS Code extension's bundled binary; macOS `.command` script.
- **Deviation — Claude Desktop (D51):** the plan kept Desktop's D29/D41 behaviour. The first real
  run showed why it can't stay: the Revaal token had expired, Auto fell back to Desktop, and
  Desktop is signed in to another account. Now a Desktop sample counts only when its org is the
  shown account's org (strict for added folders; in Auto for the default account when its account
  is known). The owner raised the same issue during the session and proposed "always Claude Code";
  the org match keeps the default account's gap-filler (Desktop's history on this machine has only
  that org).
- **Addition (D54):** before any data the card shows the selected account (from its
  `.claude.json`), and an added folder's banners drop the Claude Desktop hint. New mock scenario
  `other-account`.

### Verification

Windows 11, real data, separate `--user-data-dir` (installed app untouched):

1. Start with `--claude-config-dir=D:\Revaal\claude-config` → log `account=added folder`,
   `no usable source (auto): token-expired, desktop-unavailable`; screenshot: Revaal's e-mail,
   "Claude Code sign-in expired" without the Desktop hint.
2. Second launch with `--claude-config-dir=default` → the running copy logged
   `Claude Code account → default`, fetched (HTTP 200), cached to `userData/last-usage.json`.
3. Second launch with `d:\revaal\CLAUDE-config\` → switched back to the stored
   `D:\Revaal\claude-config` (no duplicate in `settings.json`).
4. `cmd /c start …` passes `CLAUDE_CONFIG_DIR` to the new program (hidden run).
5. `npm run check` (137 tests), all 36 mock screenshots reviewed; README images unaffected.

**Not verified:** the real *Open Claude Code* click for Revaal (it starts an interactive Claude Code
session — the owner's test), the menu itself (clicks, folder dialog), macOS and Linux.
