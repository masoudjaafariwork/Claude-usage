# Phase 3 — Fallback data source (Claude Desktop), source selection & diagnostics

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-25) — re-scoped: the planned claude.ai sign-in was dropped (D28) |
| **Depends on** | Phase 1 (Phase 2 recommended first) |
| **Size** | One Claude Code session |

## Goal

Keep the numbers fresh even when Claude Code's token has expired (e.g. the user only chatted in the
Claude app for a day), without ever touching Claude Code's credentials — and make the app usable for
people who don't use Claude Code at all (Claude desktop app only). Add a log file that makes
problems diagnosable.

## Background

- Claude Code's access token lasts ~8 h and is only renewed when Claude Code runs. Until then the
  overlay shows "sign-in expired" with stale data (Known issue in `docs/PROGRESS.md`).
- Decision D3: the app must never refresh or write Claude Code's token (refresh tokens are
  single-use; refreshing would log Claude Code out).
- The original plan had a second fallback, "Option B": sign in to claude.ai inside the app and read
  usage the way the Settings → Usage page does. **Dropped during this phase (D28):** Anthropic's
  Claude Code documentation (*Legal and compliance → Authentication and credential use*, read
  2026-09-25) says third-party developers may not offer Claude.ai login in their own applications
  and may not collect, store or intermediate claude.ai credentials or session tokens. The owner's
  alternative — sign in through the user's normal browser — cannot work either: a browser keeps its
  cookies to itself, and reading them is what credential stealers do.
- Claude Desktop alone gives us no usable sign-in (checked 2026-09-24, see "Claude Desktop" in
  `docs/PROGRESS.md`): it never writes `~/.claude/.credentials.json`, and its own token is
  encrypted app-private data we must not read (D26). But it records plan usage every ~15 min in
  `plan-usage-history.json` — non-secret, read-only, no network. That is the fallback source.

## Scope

- [x] **Research first** and record findings in `docs/PROGRESS.md` (claude.ai endpoints, response
  shape, Cloudflare behaviour, Claude Desktop's sampling) — done before the claude.ai part was
  dropped; kept for the record.
- [x] ~~**Sign-in window** for claude.ai in a `persist:claude-web` partition~~ — dropped (D28).
- [x] **Claude Desktop source (read-only, no sign-in)** — newest sample of `plan-usage-history.json`;
      `fh` → session, `sd` → weekly, `so` → weekly Opus, `sn` → weekly Sonnet; unknown keys and
      `xu` ignored (D30). No reset times: "Reset time unknown" in the card, "via Claude Desktop · as
      of HH:MM" in the footer. ≤ 20 min old = usable. `fs.watch` on the folder (debounced) plus the
      normal polls. Only that one file is ever read.
- [x] **Source selection** submenu: *Auto* (default — Claude Code; if missing, expired or 401, a
      recent Claude Desktop sample), *Claude Code only*, *Claude Desktop only*. Active source in
      the footer ("via Claude Code" / "via Claude Desktop") and the tray tooltip.
- [x] **`UsageSource` abstraction** (`usage-source.ts`: id + `fetch()`, `SourceUnavailableError`
      to hand over) so both sources share the polling, backoff and status logic;
      `usage-service.ts` stays free of Electron imports.
- [x] **Diagnostics** — rotating log `claude-usage.log` in Electron's logs folder
      (`app.getPath('logs')`: `userData/logs` on Windows/Linux, `~/Library/Logs/Claude Usage` on
      macOS; 512 KB + one old file):
      start, HTTP statuses, status changes, source switches, errors; every line goes through
      `redact()` (Bearer tokens, `sk-ant-…`, cookies, `sessionKey=…`, JSON token fields, JWTs,
      e-mails; UUIDs shortened). Menu item "Open logs folder".
- [x] **UI states** — banner copy and mock scenarios for Auto "not signed in" (both ways to fix
      it), "no recent data from Claude Desktop", and the Auto fallback (`via-desktop`, which is
      *not* an error state).

## Out of scope

Multiple accounts, refreshing Claude Code's token (forbidden by D3), reading Claude Desktop's own
sign-in (`config.json` → `oauth:tokenCache*` — forbidden by D26), any claude.ai sign-in or
session token in the app (forbidden by D28).

## Technical notes

- **Claude Desktop history** (Claude Desktop 2.7032 / MSIX; an internal file — parsed tolerantly,
  sanitized fixture `src/main/fixtures/desktop-history-2026-09.json`, v1 + v2 tested):
  - Paths: Windows (MSIX, Microsoft Store / new installer)
    `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\plan-usage-history.json`;
    Windows (older Squirrel installer) `%APPDATA%\Claude\…`; macOS
    `~/Library/Application Support/Claude/…`; Linux community builds `~/.config/Claude/…`.
  - Shape v2: `{ version: 2, samples: [{ t: epochMs, org: uuid, u: { fh, sd, xu, … } }] }`; v1:
    `{ version: 1, samples: [{ t, fh, sd }] }`. Values are 0–100 percentages.
  - Key map from Desktop's code: `five_hour`→`fh`, `seven_day`→`sd`, `seven_day_opus`→`so`,
    `seven_day_oauth_apps`→`oa`, `seven_day_cowork`→`cw`, `seven_day_omelette`→`om`,
    `omelette_promotional`→`op`, `seven_day_sonnet`→`sn`; `xu` = `extra_usage.utilization`.
  - Desktop writes atomically (temp file + rename), so the watcher watches the folder.
  - Several orgs can appear; the org of Claude Code's account (`oauthAccount.organizationUuid` in
    `.claude.json`) wins, otherwise the newest sample.
- In Auto mode a Desktop sample older than the data already shown is not used (no going back in
  time); single-source modes always show the newest sample.
- Transient errors from Claude Code (network, 429, 5xx, parse) are reported as they are — Auto only
  falls back when Claude Code is *unavailable* (no sign-in, expired, rejected).

## Acceptance criteria

- With an expired Claude Code token (mock scenario `via-desktop`) and a recent Claude Desktop
  sample, the overlay shows session and weekly "via Claude Desktop · as of HH:MM"; when Claude
  Code's token becomes valid again, Auto switches back (the mock does this after one minute). ✅
- With no Claude Code sign-in and Claude Desktop closed for >20 min, it shows the "not signed in"
  banner with both ways to fix it. ✅
- Tests cover source selection and log redaction; `npm run check` passes; screenshots reviewed. ✅
- `docs/PROGRESS.md` (API notes, decisions), `docs/BACKLOG.md` and this file's **Result** updated. ✅

## Manual test checklist (for the user)

- [ ] Footer says "Updated … · via Claude Code" normally; the tray tooltip's first line says "via Claude Code".
- [ ] Menu → Source → **Claude Desktop only** with Claude Desktop open and in use: numbers match
      Claude Desktop's own usage view, footer says "via Claude Desktop · as of …".
- [ ] Close Claude Desktop, wait > 20 min (Desktop-only mode): banner "No recent data from Claude
      Desktop". Open it again: the numbers come back within ~15 min, or right after its next sample.
- [ ] Menu → Source → **Auto**: back to "via Claude Code".
- [ ] Menu → **Open logs folder**: `claude-usage.log` has no tokens, cookies or e-mail addresses.

## Prompt

Paste into a new Claude Code session opened in this repository (the original prompt; the claude.ai
part is now forbidden by D28):

```text
Implement Phase 3 of Claude Usage as specified in docs/phases/phase-3-fallback-source.md
(claude.ai sign-in and Claude Desktop's usage history as fallback data sources, source
selection, redacted logs).
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Decision D3 still holds: never refresh,
rotate or write Claude Code's credentials; D26: never read Claude Desktop's own sign-in. Start with the research step and show me what you found
(endpoints, response shape) before building on it. Follow the phase file's Scope, Out of scope,
Technical notes and Acceptance criteria; if something turns out to be wrong or risky, stop and ask.
When done: fill in the phase file's Result section, set its status, update docs/PROGRESS.md and
docs/BACKLOG.md, and give me the manual test steps in Persian.
```

## Result

Done 2026-09-25 (session 6), re-scoped with the owner mid-phase.

- **Research** (recorded in `docs/PROGRESS.md` → "claude.ai web API notes" and "Claude Desktop
  notes"): Claude Desktop's own code calls `GET https://claude.ai/api/organizations/{org}/usage`
  (same response shape as `/api/oauth/usage`), finds the org via the `lastActiveOrg` cookie, and
  appends to `plan-usage-history.json`. From this machine claude.ai answered signed-out requests
  with 403 JSON (`account_session_invalid`) and, intermittently, Cloudflare 403 challenges. A probe
  sign-in window was opened once in a scratch profile; the owner did not sign in and its data was
  deleted.
- **claude.ai sign-in dropped (D28)** after reading Anthropic's credential-use rule; the owner
  chose "continue without claude.ai". The cookie-encryption fuse planned for it was not added.
- **Built:** `usage-source.ts` (source contract + `ClaudeCodeSource`), `desktop-source.ts` (paths,
  parser, sample choice, snapshot, atomic-write-safe watcher), a source-orchestrating
  `usage-service.ts`, `log.ts` (rotating, redacted), menu *Source* submenu and *Open logs folder*,
  footer/tray "via …", Desktop "Reset time unknown" lines, Auto-aware banners, mock scenarios
  `via-desktop` and `desktop-unavailable`, `source` in settings and in the cached snapshot.
- **Tests:** 61 (27 new): Desktop parsing v1/v2 + real fixture, freshness, org preference,
  never-older rule, paths, file read, watcher; Auto fallback and switch-back, Desktop-only and
  Claude-Code-only modes, no fallback on network errors; redaction of every secret kind; log
  rotation; settings/cache defaults.
- **Verified live on Windows 11** (dev build, scratch userData): Auto → "ok via Claude Code"
  (200 in ~0.9 s); Claude Desktop only → session 16 % / weekly 85 %, identical to the API at the
  same minute; log contains no secrets.
- Not verified: macOS Desktop path (`~/Library/Application Support/Claude`) and the Linux
  community-build path; the Auto fallback with a *really* expired token (covered by unit tests and
  the `via-desktop` mock).
