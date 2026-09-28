# Phase 8 — Sign in through Claude Code, and keep the sign-in fresh

| | |
| --- | --- |
| **Status** | ⏭️ Next |
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

- [ ] **Find a Claude Code to run directly** (extend `claude-code-launcher.ts`, pure, tested): the
      native binary (`~/.local/bin/claude[.exe]`), the npm package's real `bin/claude.exe` behind a
      `claude.cmd` shim, Homebrew / `/usr/local/bin`, the VS Code extension's bundled binary (D53).
      Looked up on every use (a running app doesn't see PATH changes). Never via a shell.
- [ ] **Sign in** — banner button and menu item while an account is not signed in or can't be
      renewed: a visible terminal runs `claude auth login` (with `CLAUDE_CONFIG_DIR` for an added
      folder, `--email` prefilled when the account is known). Claude Code opens the system browser;
      its fallback (URL, paste code) stays visible in that terminal. The overlay loads as soon as
      the credentials appear (watch + 60 s recheck; a folder that doesn't exist yet is covered).
      For the default account while it is signed in, a confirm dialog first (it would switch Claude
      Code's own account).
- [ ] **Install Claude Code** — when none is found: a dialog shows the official command from
      Anthropic's setup page and what it does; on OK a visible terminal runs the native installer
      and then `claude auth login` in the same window (the installed binary by its full path). No
      silent install, nothing bundled.
- [ ] **Add account (sign in)…** in menu → *Claude Code account*: creates a new config folder (the
      default location is to be decided — user-visible, e.g. under the home folder — ask the owner
      if unclear), runs `claude auth login` with it, adds it and opens it in its own window once
      signed in (Phase 7). A folder left without a sign-in (cancelled) is removed again.
- [ ] **Renew in the background** — when an account's status is `token-expired` and a Claude Code
      is found: run it hidden, `claude -p "/usage" --no-session-persistence`, with that account's
      `CLAUDE_CONFIG_DIR`, in a neutral working folder, 60 s timeout (kill the tree). Claude Code
      renews its own token; the credentials watch then loads fresh numbers. At most once per
      30 min per account, backing off after failures (1 h, 2 h … 12 h); not while offline or
      rate-limited. Menu switch *Renew sign-in automatically* (default on). Card: "Renewing
      sign-in…" meanwhile.
- [ ] **Never a prompt** — renewal only for claude.ai subscription credentials (`claudeAiOauth`),
      never for API-key or gateway setups; the output must look like `/usage` output ("Current
      session … used", "Not logged in"); anything else stops renewal for that account (logged,
      shown in the menu). Settle the `isEnabled` question in Claude Code's code before shipping; if
      it can't be ruled out that the text reaches the model, stop and ask the owner.
- [ ] **When renewal can't help** (the sign-in itself is gone: refresh token expired or revoked,
      logged out): banner "Sign in again" with the *Sign in* button.
- [ ] Banner and menu texts for: not signed in (Install / Sign in), renewing, sign in again; the
      Free-plan case ("Claude Code needs a Pro, Max, Team or Enterprise plan") where Claude Code
      says so.
- [ ] Mock scenarios `first-run` (nothing installed) and `renewing`; screenshots.
- [ ] Tests: binary lookup, launch plans per OS (terminal commands, env, the `.command` script on
      macOS), output classification, renewal schedule / backoff.
- [ ] README (first run, how sign-in works and what the app never does, background renewal,
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

_Filled in when the phase is done._
