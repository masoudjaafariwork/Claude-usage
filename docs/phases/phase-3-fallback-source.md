# Phase 3 — Fallback data sources (claude.ai sign-in, Claude Desktop) & diagnostics

| | |
| --- | --- |
| **Status** | ⏭️ Next |
| **Depends on** | Phase 1 (Phase 2 recommended first) |
| **Size** | One Claude Code session |

## Goal

Keep the numbers fresh even when Claude Code's token has expired (e.g. the user only chatted in the
Claude app for a day), without ever touching Claude Code's credentials — and make the app usable for
people who don't use Claude Code at all (Claude desktop app or web only). Add a log file that makes
problems diagnosable.

## Background

- Claude Code's access token lasts ~8 h and is only renewed when Claude Code runs. Until then the
  overlay shows "sign-in expired" with stale data (Known issue in `docs/PROGRESS.md`).
- Decision D3: the app must never refresh or write Claude Code's token (refresh tokens are
  single-use; refreshing would log Claude Code out).
- "Option B" from the original discussion: sign in to claude.ai inside the app and read usage the
  same way the Settings → Usage page does. It is an independent credential, so it can't interfere
  with Claude Code.
- Claude Desktop alone gives us no usable sign-in (checked 2026-09-24, see "Claude Desktop" in
  `docs/PROGRESS.md`): it never writes `~/.claude/.credentials.json`, and its own token is
  encrypted app-private data we must not read (D26). But it records plan usage every ~15 min in
  `plan-usage-history.json` — non-secret, read-only, no network. That is the third source.

## Scope

- [ ] **Research first** and record findings under "Usage API notes" in `docs/PROGRESS.md`:
  - the endpoint claude.ai's Settings → Usage page calls (expected
    `GET https://claude.ai/api/organizations/{orgUuid}/usage`)
  - how to get the org UUID (e.g. `GET /api/organizations` or `/api/bootstrap`)
  - how the response compares with `/api/oauth/usage`; save a sanitized sample as a fixture and
    extend `usage-parse.ts` + tests if the shape differs
- [ ] **Sign-in window** — menu item "Sign in to claude.ai…" opens a normal framed `BrowserWindow`
      on `https://claude.ai/login` in a dedicated persistent partition (`persist:claude-web`);
      detect success (session cookie present and org resolved) and close it.
      "Sign out of claude.ai" clears that partition.
- [ ] **Claude Desktop source (read-only, no sign-in)** — read the newest sample from Claude
      Desktop's `plan-usage-history.json` (paths in Technical notes). Map `fh` → session, `sd` →
      weekly, `so` → weekly Opus, `xu` → extra usage when present; ignore unknown keys. It has no
      reset times: show "as of HH:MM" instead of countdowns. Newer than ~20 min = usable; older =
      unavailable (Desktop is probably closed). Watch the file (`fs.watch` + debounce) instead of
      polling. Never write to Claude Desktop's folder or read any other file there.
- [ ] **Source selection** submenu: *Auto* (default — Claude Code token; if missing, expired or
      401, claude.ai when signed in; otherwise a recent Claude Desktop sample), *Claude Code
      only*, *claude.ai only*, *Claude Desktop only*. Show the active source subtly in the footer
      ("via Claude Code" / "via claude.ai" / "via Claude Desktop") and in the tray tooltip.
- [ ] **`UsageSource` abstraction** (id, availability check, fetch) so both sources share the
      polling, backoff and status logic; `usage-service.ts` stays free of Electron imports.
- [ ] **Diagnostics** — small rotating log in `userData/logs` (status changes, HTTP statuses,
      errors, source switches) with a redaction step for anything token- or cookie-like;
      menu item "Open logs folder".
- [ ] **UI states** — banner copy and mock scenarios for "claude.ai signed out" and
      "claude.ai session expired"; Auto mode falling back is *not* an error state.

## Out of scope

Multiple accounts, refreshing Claude Code's token (forbidden by D3), storing the claude.ai cookie
anywhere outside Electron's partition, reading Claude Desktop's own sign-in (`config.json` →
`oauth:tokenCache*`, safeStorage-encrypted — forbidden by D26).

## Technical notes

- Use `session.fromPartition('persist:claude-web').fetch(...)` so Chromium handles cookies, the
  real browser User-Agent and Cloudflare challenges. The cookie never leaves that session and is
  never logged or sent to the renderer.
- **Google sign-in may refuse embedded browsers** ("This browser or app may not be secure"). The
  email-code login works. Tell the user in the sign-in window (small hint) and test it.
- Cloudflare may answer non-browser-looking requests with 403 + HTML; treat an HTML body as
  "session expired / challenge" rather than a parse error.
- Keep polling polite for both sources (same interval, never poll both at once in Auto mode).
- Unit-test the fallback decisions: token expired → web; web signed out → banner; Claude Code
  token renewed → back to Claude Code; 401 on web → web session expired.
- Log redaction must be unit-tested (Bearer tokens, `sk-ant-…`, `sessionKey=…`, cookies).
- **Claude Desktop history** (observed in Claude Desktop 2.110.1, an internal file — parse
  tolerantly, add a sanitized fixture with the org id replaced, and test v1 + v2):
  - Paths: Windows (MSIX, Microsoft Store / new installer)
    `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\plan-usage-history.json`;
    Windows (older Squirrel installer) `%APPDATA%\Claude\…`; macOS
    `~/Library/Application Support/Claude/…`. No official Linux Desktop app.
  - Shape v2: `{ version: 2, samples: [{ t: epochMs, org: uuid, u: { fh, sd, xu, … } }] }`; v1:
    `{ version: 1, samples: [{ t, fh, sd }] }`. Values are 0–100 percentages.
  - Key map from Desktop's code: `five_hour`→`fh`, `seven_day`→`sd`, `seven_day_opus`→`so`,
    `seven_day_oauth_apps`→`oa`, `seven_day_cowork`→`cw`, plus codenamed keys (ignore them).
  - Desktop samples roughly every 15 min while it runs (min gap ~4.5 min) and keeps 30 days — this
    history could also feed the "weekly usage history sparkline" idea later.
  - Several orgs can appear; prefer the org of the Claude Code / claude.ai account when known,
    otherwise the org of the newest sample.

## Acceptance criteria

- With an expired Claude Code token (mock scenario) and a claude.ai sign-in, the overlay shows
  fresh data "via claude.ai"; when Claude Code's token becomes valid again, Auto switches back.
- With no Claude Code sign-in and no claude.ai sign-in but Claude Desktop running, the overlay
  shows session and weekly "via Claude Desktop · as of HH:MM"; with Desktop closed for >20 min it
  shows the "not signed in" banner with all three ways to fix it.
- Tests cover source selection and log redaction; `npm run check` passes; screenshots reviewed.
- `docs/PROGRESS.md` (API notes, decisions), `docs/BACKLOG.md` and this file's **Result** updated.

## Manual test checklist (for the user)

- [ ] Menu → **Sign in to claude.ai…**, log in with the email code; the window closes by itself.
- [ ] Footer says "via Claude Code" normally.
- [ ] Menu → Source → **claude.ai only**: footer says "via claude.ai" and numbers match.
- [ ] Menu → **Sign out of claude.ai**: in Auto mode nothing breaks; in claude.ai-only mode a
      banner asks to sign in.
- [ ] Menu → **Open logs folder**: the log has no tokens or cookies in it.
- [ ] Menu → Source → **Claude Desktop only** with Claude Desktop open: numbers match Claude
      Desktop's own usage view, footer says "via Claude Desktop · as of …".

## Prompt

Paste into a new Claude Code session opened in this repository:

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

_Not started._
