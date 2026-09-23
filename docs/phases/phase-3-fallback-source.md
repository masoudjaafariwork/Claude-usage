# Phase 3 — Fallback data source (claude.ai sign-in) & diagnostics

| | |
| --- | --- |
| **Status** | Planned |
| **Depends on** | Phase 1 (Phase 2 recommended first) |
| **Size** | One Claude Code session |

## Goal

Keep the numbers fresh even when Claude Code's token has expired (e.g. the user only chatted in the
Claude app for a day), without ever touching Claude Code's credentials. Add a log file that makes
problems diagnosable.

## Background

- Claude Code's access token lasts ~8 h and is only renewed when Claude Code runs. Until then the
  overlay shows "sign-in expired" with stale data (Known issue in `docs/PROGRESS.md`).
- Decision D3: the app must never refresh or write Claude Code's token (refresh tokens are
  single-use; refreshing would log Claude Code out).
- "Option B" from the original discussion: sign in to claude.ai inside the app and read usage the
  same way the Settings → Usage page does. It is an independent credential, so it can't interfere
  with Claude Code.

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
- [ ] **Source selection** submenu: *Auto* (default — Claude Code token; if missing, expired or
      401, use claude.ai when signed in), *Claude Code only*, *claude.ai only*. Show the active
      source subtly in the footer ("via Claude Code" / "via claude.ai") and in the tray tooltip.
- [ ] **`UsageSource` abstraction** (id, availability check, fetch) so both sources share the
      polling, backoff and status logic; `usage-service.ts` stays free of Electron imports.
- [ ] **Diagnostics** — small rotating log in `userData/logs` (status changes, HTTP statuses,
      errors, source switches) with a redaction step for anything token- or cookie-like;
      menu item "Open logs folder".
- [ ] **UI states** — banner copy and mock scenarios for "claude.ai signed out" and
      "claude.ai session expired"; Auto mode falling back is *not* an error state.

## Out of scope

Multiple accounts, refreshing Claude Code's token (forbidden by D3), storing the claude.ai cookie
anywhere outside Electron's partition.

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

## Acceptance criteria

- With an expired Claude Code token (mock scenario) and a claude.ai sign-in, the overlay shows
  fresh data "via claude.ai"; when Claude Code's token becomes valid again, Auto switches back.
- Tests cover source selection and log redaction; `npm run check` passes; screenshots reviewed.
- `docs/PROGRESS.md` (API notes, decisions), `docs/BACKLOG.md` and this file's **Result** updated.

## Manual test checklist (for the user)

- [ ] Menu → **Sign in to claude.ai…**, log in with the email code; the window closes by itself.
- [ ] Footer says "via Claude Code" normally.
- [ ] Menu → Source → **claude.ai only**: footer says "via claude.ai" and numbers match.
- [ ] Menu → **Sign out of claude.ai**: in Auto mode nothing breaks; in claude.ai-only mode a
      banner asks to sign in.
- [ ] Menu → **Open logs folder**: the log has no tokens or cookies in it.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 3 of Claude Usage Overlay as specified in docs/phases/phase-3-fallback-source.md
(claude.ai sign-in as a fallback data source, source selection, redacted logs).
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Decision D3 still holds: never refresh,
rotate or write Claude Code's credentials. Start with the research step and show me what you found
(endpoints, response shape) before building on it. Follow the phase file's Scope, Out of scope,
Technical notes and Acceptance criteria; if something turns out to be wrong or risky, stop and ask.
When done: fill in the phase file's Result section, set its status, update docs/PROGRESS.md and
docs/BACKLOG.md, and give me the manual test steps in Persian.
```

## Result

_Not started._
