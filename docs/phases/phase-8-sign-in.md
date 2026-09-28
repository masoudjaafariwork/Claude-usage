# Phase 8 — Sign in through Claude Code, and keep the sign-in fresh

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-28), released as 1.4.0 — real install, browser sign-in and renewal of a really expired token are the owner's manual tests |
| **Depends on** | Phase 6 (accounts), Phase 7 (a window per account), D34 / D53 (Open Claude Code) |
| **Size** | One Claude Code session |

## Goal

A new user gets from "nothing installed" to live numbers with one button and a sign-in in their own
browser; an expired Claude Code sign-in renews itself in the background without the user opening
Claude Code; a new account is added by signing in, not by hunting for a config folder. All of it
through the user's own, unmodified Claude Code: the app still never offers a login of its own,
never sees a password or session, and never refreshes or writes a token (D3, D28).

## Background

- Owner's question (2026-09-28): should the app sign in "by opening the browser and logging in to
  Claude", as some competitors do? Research that day (competitors' source code, Anthropic's docs,
  Claude Code 2.1.283's own code; summary in `docs/PROGRESS.md`, session 24):
  - Competitors sign in five ways: (a) read Claude Code's token — like us (CodexBar, ClaudeBar,
    CodeZeno, ai-token-monitor); (b) claude.ai `sessionKey` from an embedded login window, browser
    cookies or a paste (claude-usage-widget, Claude-Usage-Tracker, ClaudeMeter, UsagePeek) —
    Cloudflare and Google-popup breakage, one README admits it "may violate Anthropic's Terms";
    (c) system-browser OAuth PKCE reusing Claude Code's client id `9d1c250a-…` and keeping their
    own tokens (claude-usage-bar, Usage4Claude, ai-usage-limits on iOS) — exactly the requested
    experience, but it is "offer Claude.ai login into their own applications" and "store …
    credentials", which the legal page forbids; (d) CodexBar's login button runs
    `claude auth login`, so Claude Code itself signs in through the browser; (e) CodeZeno decrypts
    Claude Desktop's token (our D26 forbids it).
  - Legal page (re-read 2026-09-28, unchanged): "Anthropic does not permit third-party developers
    to offer Claude.ai login into their own applications … developers may not collect, store, or
    intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must
    complete through Anthropic's own flow." No official "Sign in with Claude" for third parties.
  - Route (d) fits that rule: the sign-in completes in Claude Code's own flow, and the result lands
    where the overlay already reads it.
- Today (1.2 + Phase 7), for a user with **neither Claude Code nor Claude Desktop**: status
  `no-credentials`, banner "Not signed in … sign in to Claude Code … or open the Claude desktop
  app", and *Open Claude Code* only opens the setup docs in the browser. The user must install
  Claude Code, run it in a terminal and `/login` on their own; the overlay then picks it up (60 s
  recheck).
- Today, for **Claude Code not used for longer than the ~8 h token life**: greyed last numbers,
  banner "Claude Code sign-in expired" + *Open Claude Code*; recovery only once the user opens
  Claude Code (D34), or Claude Desktop's numbers for the default account if Desktop runs (D51).
- Facts read in Claude Code 2.1.283's code and tried on this machine:
  - `claude auth login [--claudeai (default) | --console] [--email <e-mail>] [--sso]` runs the same
    OAuth flow as `/login` (`startOAuthFlow`), prints "Opening browser to sign in…", "If the
    browser didn't open, visit: <url>", "Paste code here if prompted >", then stores the token
    (`.credentials.json` / Keychain) and writes `oauthAccount` (e-mail, org) to `.claude.json` —
    so the data after it is identical to today's. It honours `CLAUDE_CONFIG_DIR`.
  - `/usage` exists as a `type: "local"` command with `supportsNonInteractive: true`:
    `claude -p "/usage" --no-session-persistence` ran in 6 s on the owner's account, printed
    session / weekly / per-model lines, sent no model request and left the (still valid) token
    alone. Its fetch uses `refreshOAuth: true` ("401→refresh→retry"), i.e. **Claude Code renews its
    own expired token** during that call. Not yet tried with a really expired token.
  - Its `isEnabled` depends on an internal check not identified; on a disabled command the text
    could go to the model as a prompt. **Git Bash rewrote `/usage` into a path once during the
    research, and Claude Code sent it as a real prompt** — spawn the binary directly, never through
    a shell.
  - This revises D34's reason for rejecting `claude -p` ("would send real prompts"): true for
    prompts, not for the local `/usage` command.
- Anthropic's setup page (read 2026-09-28): native installer `irm https://claude.ai/install.ps1 |
  iex` (Windows PowerShell), `curl -fsSL https://claude.ai/install.sh | bash` (macOS / Linux /
  WSL); binary in `~/.local/bin/claude[.exe]`; "open a new terminal window" afterwards (PATH);
  also Homebrew, WinGet (`Anthropic.ClaudeCode`), apt / dnf / apk, npm. "Claude Code requires a
  Pro, Max, Team, Enterprise, or Console account. The free claude.ai plan does not include Claude
  Code access."

## Scope

- [x] **Find a Claude Code to run directly** (extend `claude-code-launcher.ts`, pure, tested): the
      native binary (`~/.local/bin/claude[.exe]`), the npm package's real `bin/claude.exe` behind a
      `claude.cmd` shim, Homebrew / `/usr/local/bin`, the VS Code extension's bundled binary (D53).
      Looked up on every use (a running app doesn't see PATH changes). Never via a shell.
- [x] **Sign in** — banner button and menu item while an account is not signed in or can't be
      renewed: a visible terminal runs `claude auth login` (with `CLAUDE_CONFIG_DIR` for an added
      folder, `--email` prefilled when the account is known). Claude Code opens the system browser;
      its fallback (URL, paste code) stays visible in that terminal. The overlay loads as soon as
      the credentials appear (watch + 60 s recheck; a folder that doesn't exist yet is covered).
      For the default account while it is signed in, a confirm dialog first (it would switch Claude
      Code's own account).
- [x] **Install Claude Code** — when none is found: a dialog shows the official command from
      Anthropic's setup page and what it does; on OK a visible terminal runs the native installer
      and then `claude auth login` in the same window (the installed binary by its full path). No
      silent install, nothing bundled.
- [x] **Add account (sign in)…** in menu → *Claude Code account*: creates a new config folder (the
      default location is to be decided — user-visible, e.g. under the home folder — ask the owner
      if unclear), runs `claude auth login` with it, adds it and opens it in its own window once
      signed in (Phase 7). A folder left without a sign-in (cancelled) is removed again.
- [x] **Renew in the background** — when an account's status is `token-expired` and a Claude Code
      is found: run it hidden, `claude -p "/usage" --no-session-persistence`, with that account's
      `CLAUDE_CONFIG_DIR`, in a neutral working folder, 60 s timeout (kill the tree). Claude Code
      renews its own token; the credentials watch then loads fresh numbers. At most once per
      30 min per account, backing off after failures (1 h, 2 h … 12 h); not while offline or
      rate-limited. Menu switch *Renew sign-in automatically* (default on). Card: "Renewing
      sign-in…" meanwhile.
- [x] **Never a prompt** — renewal only for claude.ai subscription credentials (`claudeAiOauth`),
      never for API-key or gateway setups; the output must look like `/usage` output ("Current
      session … used", "Not logged in"); anything else stops renewal for that account (logged,
      shown in the menu). Settle the `isEnabled` question in Claude Code's code before shipping; if
      it can't be ruled out that the text reaches the model, stop and ask the owner.
- [x] **When renewal can't help** (the sign-in itself is gone: refresh token expired or revoked,
      logged out): banner "Sign in again" with the *Sign in* button.
- [x] Banner and menu texts for: not signed in (Install / Sign in), renewing, sign in again; the
      Free-plan case ("Claude Code needs a Pro, Max, Team or Enterprise plan") where Claude Code
      says so.
- [x] Mock scenarios `first-run` (nothing installed) and `renewing`; screenshots.
- [x] Tests: binary lookup, launch plans per OS (terminal commands, env, the `.command` script on
      macOS), output classification, renewal schedule / backoff.
- [x] README (first run, how sign-in works and what the app never does, background renewal,
      troubleshooting), `docs/`, Electron book (child processes without a shell, MSYS path
      conversion, a local CLI command as a refresh trigger).

## Out of scope

- A login of our own in any form: OAuth PKCE (with Claude Code's client id or any other),
  claude.ai cookies or session keys, an embedded login window (D28).
- Refreshing or writing a token ourselves (D3); reading Claude Desktop's sign-in (D26).
- Using `/usage`'s text as a data source (it lacks the by-app split and extra usage; the endpoint
  stays the source).
- Installing Claude Code silently or bundling it.
- Claude Code's status line as a source (separate idea).
- Free-plan users: Claude Code doesn't sign them in; they keep Claude Desktop's samples at best.

## Technical notes

- `claude auth login` stays interactive (it may ask for a pasted code), so it runs in a visible
  terminal like *Open Claude Code* (D34: Windows `cmd /c start …`, macOS a `.command` script
  (D53), Linux the first terminal found). Background renewal runs hidden with `windowsHide`.
- Windows: `spawn` of a `.cmd` needs a shell; resolve the npm shim to
  `node_modules/@anthropic-ai/claude-code/bin/claude.exe` instead. MSYS / Git Bash turns an
  argument starting with `/` into a Windows path — the research's one accidental prompt.
- Claude Code coordinates token refreshes between its own processes with a lock (D34), so a
  background `/usage` next to the user's open sessions is safe.
- Cost: one usage-endpoint request per renewal (Claude Code's), only while expired; ~6 s of CPU.
- The legal page's "preinstalling or running Claude Code in your products or services (e.g. in
  hosted sandboxes or other agent infrastructure)" is about products that run Claude Code for
  their users; here the user's own installation runs on the user's machine for their own account,
  unmodified, on the user's click or for their own sign-in — as *Open Claude Code* does since D34.
  Record that reading in PROGRESS as a decision; the owner confirms.
- The refresh token's lifetime isn't documented (one competitor measured ~29 days, absolute, not
  verified): after that, renewal fails and the card asks to sign in again.
- macOS: Claude Code's renewal writes the Keychain item; our read of it may prompt again ("Always
  Allow") — untested, no Mac.

## Acceptance criteria

- Nothing installed: the card offers Install / Sign in; after installing and signing in in the
  browser, the numbers appear without restarting the overlay.
- An account whose token expired hours ago shows fresh numbers again without the user opening
  Claude Code, and no model request is made (Claude Code's own `/usage` "requests" count and the
  session list unchanged).
- *Add account (sign in)…* ends with a new window for the new account.
- Without any of this (Claude Code signed in and used), the app behaves as in Phase 7.
- `npm run check` passes; `npm run screenshot` reviewed; README images re-rendered if affected.
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] On a Windows user account (or VM) without Claude Code and Claude Desktop: install the
      overlay → *Install Claude Code* → sign in in the browser → numbers appear.
- [ ] Leave one account unused for more than 8 hours (e.g. Revaal), then look at its window: a
      short "Renewing sign-in…", then fresh numbers; `claude-usage.log` records the renewal.
- [ ] *Add account (sign in)…* with another Claude account → a new window with its e-mail.
- [ ] In an added folder, `claude auth logout` (with its `CLAUDE_CONFIG_DIR`) → the card asks to
      sign in again; *Sign in* fixes it.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 8 of Claude Usage as specified in docs/phases/phase-8-sign-in.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

Done on 2026-09-28 (session 26). Decisions D66–D70 in `docs/PROGRESS.md`.

**Settled first — `isEnabled` of `/usage`** (Claude Code 2.1.283's code): the non-interactive
`/usage` (type `local`, `supportsNonInteractive`) has `isEnabled: () => !launchOptions.isInteractive()`,
and `-p` / `--print` (or a stdout that isn't a TTY) makes the session non-interactive — so it is
enabled exactly in our run and handled inside Claude Code. The dispatch also showed the one way the
text *could* reach the model: an unknown slash command falls back to the model by default in `-p`
mode — but a built-in name like `usage` is answered "isn't available in this environment" instead,
unless a file `/usage` exists at the root of the working folder's drive (then the text is treated
as a prompt). That case is ruled out before every run. Not asked again: nothing left open. (One
attempt to extract the `/usage` module's own source was blocked by the session's safety classifier;
its output format was taken from real runs instead.)

**Built**

- `claude-code-launcher.ts`: `findClaudeBinary()` — PATH (with `claude.exe`, never `claude.cmd`:
  npm's shim is resolved to `node_modules/@anthropic-ai/claude-code/bin/claude.exe`), then
  `~/.local/bin`, npm's folder, WinGet's `Links` (Windows) / `~/.local/bin`, `~/.claude/local`,
  Homebrew, `/usr/local/bin`, then the VS Code extension's binary; looked up on every use.
  `planTerminalJob()` for *Sign in* (`claude auth login [--email]`) and *Install* (Anthropic's
  installer, then `claude auth login` with `~/.local/bin/claude[.exe]`): Windows a plain-ASCII
  `.cmd` in `%TEMP%` that gets every value through the environment (`!VAR!`, delayed expansion) and
  runs via `cmd /d /v:on /c start "…" /wait cmd /d /c call "!CLAUDE_USAGE_SCRIPT!"` — the launcher's
  exit is the window's; macOS a `.command` in Terminal; Linux a `.sh` in the first terminal found.
  `runLaunchPlan()` (was `launchClaudeCode`) returns the process.
- `claude-code-renewal.ts` (new): `claude -p /usage --no-session-persistence --strict-mcp-config
  --settings {"disableAllHooks":true}` run hidden and directly (`shell: false`), 60 s timeout with a
  tree kill, environment without API keys / gateway / tokens / parent-session variables and with the
  account's `CLAUDE_CONFIG_DIR`, working folder `userData/claude-code-runs`; version gate ≥ 2.1.283
  (`claude --version`, cached per binary); output classes `usage` (renewed), `no-usage` (the local
  cost block: the command ran but had no plan usage), `signed-out`, `empty`, `unexpected` — and any
  non-zero model-token count in the output is `unexpected`; `RenewalSchedule` (30 min gap, 1 h … 12 h
  after failures).
- `Overlay`: `maybeRenew()` on every usage change while Claude Code's sign-in is expired or refused —
  also behind Claude Desktop's numbers in Auto (`UsageService.unavailable`); "Renewing sign-in…"
  only while Claude Code really runs; `watchSignIn()` looks at the account's two files every 2 s for
  15 min after a sign-in terminal opened (the folder may not exist yet, so a watch can't) and re-arms
  the credentials watch. After a renewal the source forgets a rejected token (`signInRenewed`).
- `main.ts`: *Sign in* (a confirm first for the default account when Claude Code has an account on
  record), *Install Claude Code* (dialog with the official command), *Add account (sign in)…*
  (`~/.claude-account-N`, removed again when the terminal closes / 15 min pass / the app quits
  without a sign-in), `renewSignIn()` with its checks and log lines, the stop record per account and
  Claude Code version (`settings.renewStopped`), *Renew sign-in automatically* (`settings.autoRenew`,
  default on; turning it on clears the stops).
- Statuses: `Status.reason` — `expired`, `rejected`, `sign-in-ended` (refresh token's expiry passed,
  or Claude Code emptied its tokens — `CredentialsNotFoundError.signedOut`), `free-plan` (401/403 with
  `subscriptionType: "free"`). `claudeCodeAction()` (shared) picks Install / Sign in / Open Claude
  Code / nothing for the banner and the menus; `AppState.claudeCode` carries installed / renewing /
  signInEnded / signingIn.
- UI: banners *Claude Code isn't installed* (Install Claude Code), *Not signed in* (Sign in),
  *Renewing sign-in…*, *Sign in again* (Sign in), *No Claude Code on this plan*; the expired banner
  (Open Claude Code) is unchanged. Compact texts and tray tooltip likewise. Menu: *Sign in to Claude
  Code…* / *Install Claude Code…* next to *Open Claude Code*; in *Claude Code account*: *Add account
  (sign in)…*, *Renew sign-in automatically*, "Renewal stopped for … — see the log".
- Mock scenarios `first-run`, `renewing`, `sign-in-again` (mock runs never start Claude Code).
- Tests 151 → 173 (launcher: binary lookup, terminal plans / scripts per OS, e-mail filter; renewal:
  args, env, version gate, `/usage` clash, output classes from real outputs, results, schedule;
  statuses and reasons; settings; `nextAccountFolder`; `claudeCodeAction`).

**Deviations from the plan, with reasons**

- Two more flags on the hidden run (`--strict-mcp-config`, `--settings {"disableAllHooks":true}`) so
  it starts no MCP servers and runs none of the user's hooks, and a cleaned environment; plus the
  version gate and the `/usage` root-file check (from the code reading above).
- A third outcome besides "usage" and "not logged in": with an expired sign-in that can't be
  renewed, Claude Code 2.1.283 prints only its local cost block ("Usage: 0 input, 0 output") **and
  empties both tokens in `.credentials.json`** — seen with a fake expired sign-in in a scratch folder.
  So an emptied sign-in block now counts as "sign-in ended" (card: *Sign in again*), and two
  `no-usage` runs in a row do too. "Not logged in" never appeared.
- The folder of *Add account (sign in)…*: the owner chose "the app decides, simplest for the user"
  → `~/.claude-account-2`, `-3`, … (D69).
- The stop after an unexpected answer is remembered per account **and Claude Code version** in the
  settings, so a restart doesn't try again with the same Claude Code, but an update does.
- Free plan: Claude Code's code has no free-plan message to detect, so the card says so when the API
  refuses a token whose `subscriptionType` is `free` — unverified (no free account to try).
- Extra mock scenario `sign-in-again` to review that banner.

**Verified on Windows 11 (this machine)**

- Terminal mechanism with a harmless script in a folder named `a & b (test)`: values with `&` and
  `Ä` arrived through the environment, the launcher exited when the window closed (2.3 s).
- Hidden `/usage`: an empty config folder → cost block, 0 tokens, `no-usage`, no session file; the
  owner's default account (valid token) → `Current session: 34% used · …` in 4.2 s, `renewed`, no
  session file (an empty `projects/…-runs/memory` folder only; removed again); a fake expired sign-in
  → `no-usage`, Claude Code emptied the fake tokens.
- The real app (own `--user-data-dir`, installed app untouched) on that fake folder: *expired* →
  "letting Claude Code 2.1.283 renew it" → watch saw the emptied sign-in within 4 s → the card read
  (DevTools) "Sign in again … Sign in"; the ⋯ menu (captured through the main-process inspector) had
  *Sign in to Claude Code…*, *Add account (sign in)…*, *Add folder…*, *Renew sign-in automatically*.
- `npm run check`: 173 tests pass. Screenshots of all scenarios reviewed (new: `first-run`,
  `renewing`, `sign-in-again`, light variants); the others unchanged. README images and the social
  preview are unaffected (their scenarios' cards didn't change).

**Not verified here (owner's manual tests below):** a real `claude auth login` through the browser
(it would have opened the owner's browser), the Install flow on a machine without Claude Code, *Add
account (sign in)…* end to end, and the renewal of a really expired token (Revaal). macOS and Linux
untested (terminals, `.command` / `.sh` scripts, Keychain prompt after Claude Code rewrites its item).
