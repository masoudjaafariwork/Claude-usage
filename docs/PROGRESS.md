# Progress

Living record of where the project stands. Update it at the end of every session (see `CLAUDE.md`).

## Current status

| Phase | Status |
| --- | --- |
| [1 — MVP overlay](phases/phase-1-mvp-overlay.md) | ✅ Done (2026-09-24) |
| [2 — Packaging, app icon, launch at login](phases/phase-2-packaging.md) | ⏭️ Next |
| [3 — Fallback data source (claude.ai sign-in) & diagnostics](phases/phase-3-fallback-source.md) | Planned |
| [4 — UX: notifications, click-through, shortcut, pace forecast](phases/phase-4-ux.md) | Planned |
| [5 — App auto-update](phases/phase-5-auto-update.md) | Planned |

Each phase has its own plan file in [`phases/`](phases/) (scope, notes, acceptance criteria,
ready-to-paste prompt, result). Index and general prompts: [`BACKLOG.md`](BACKLOG.md).

## What works today (Phase 1)

- Frameless, transparent, always-on-top overlay; drag anywhere; position remembered; stays reachable
  when monitors change; "Move to display" menu for multi-monitor setups.
- Expanded card: session ring with reset countdown, weekly limits (all models + per-model) as bars,
  "this week, by app" split, extra-usage row when enabled, status banner, footer freshness.
- Compact pill: session + weekly (+ any per-model weekly that is higher) mini rings.
- Tray icon: live ring of the most constrained limit, tooltip with all limits, same menu as the card
  (show/hide, refresh, compact, always-on-top, opacity, refresh interval, move to display, reset
  position, quit). macOS shows the percentage next to the menu-bar icon.
- Polling every 3 min (configurable 1–10 min), extra poll ~5 s after the earliest reset, backoff on
  errors, `Retry-After` on 429, refresh on wake/unlock, manual refresh.
- Stale data handling: last snapshot cached to disk and shown (desaturated, with banner) on startup,
  offline, rate-limited or expired sign-in.
- Dev tooling: mock scenarios, screenshot mode, 28 unit tests.
- Verified on Windows 11 with real data (Max 20× account). Idle memory ≈ 100 MB per Electron process.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Electron + TypeScript | User's preference; mature transparent/always-on-top windows on all 3 OSes; pure TS. Tauri was the lighter alternative (less RAM) but needs Rust and has transparency quirks on macOS/Linux. |
| D2 | Data source: Claude Code's OAuth token → `GET https://api.anthropic.com/api/oauth/usage` | Same numbers as Settings → Usage; no extra sign-in because Claude Code is already signed in on this machine. |
| D3 | **Never refresh or write Claude Code's credentials** | Refresh tokens are single-use and rotate; refreshing from this app would silently log Claude Code out (known bug in other tools, e.g. CodexBar #1161). Expired token ⇒ show a banner and re-read the file every 60 s. |
| D4 | esbuild bundling + `tsc --noEmit` (TypeScript 7); zero runtime dependencies | Simple, fast, few moving parts for future sessions. |
| D5 | Network via Electron `net.fetch` | Honours system proxy / VPN settings. |
| D6 | Honest User-Agent `ClaudeUsageOverlay/<version> (…)` | Returned 200 on 2026-09-24. Reports elsewhere say non-`claude-code` UAs can hit stricter rate limits; revisit only if persistent 429s appear. |
| D7 | Poll every 180 s by default (60–3600 s), poll again 5 s after the earliest reset, min gap 30 s, manual refresh throttled to 5 s | Fresh enough; polite to an unofficial, rate-limited endpoint shared with Claude Code. |
| D8 | Parse the `limits[]` array first; fall back to legacy `five_hour` / `seven_day*` keys; ignore unknown codenamed keys | The response contains many codenamed, mostly-null keys that change over time. |
| D9 | Severity = max(server `severity`, derived from %: ≥75 warning, ≥90 critical) | Server severity alone stayed "normal" at 52 %; thresholds give earlier colour cues without ever downgrading the server. |
| D10 | Dark glass design only; mint / amber / red severity colours; Claude-coral brand accents | Must be legible over any wallpaper or app. |
| D11 | Cache the last good snapshot in `userData/last-usage.json` | Shows something useful immediately on startup and while offline or expired. |
| D12 | Tray icon drawn at runtime (PNG encoder + supersampled ring) | Live percentage without shipping image assets. |
| D13 | Mock runs use `userData/mock-data`; screenshot runs don't persist settings | Dev runs never pollute real settings or cache. |

## Usage API notes (observed 2026-09-24)

- `GET https://api.anthropic.com/api/oauth/usage`, headers `Authorization: Bearer <accessToken>`,
  `anthropic-beta: oauth-2025-04-20`. Access tokens last ~8 h (`expiresAt` in the credentials).
- Credentials: `~/.claude/.credentials.json` (Windows/Linux, or `$CLAUDE_CONFIG_DIR`) →
  `claudeAiOauth.{accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes[],
  subscriptionType, rateLimitTier}`; on macOS the Keychain item `Claude Code-credentials`.
- Useful response parts: `limits[]` (`kind`, `group`, `percent`, `severity`, `resets_at`,
  `scope.model.display_name`, `is_active`), `seven_day_breakdown.rows[]`, `spend`, legacy
  `five_hour` / `seven_day` / `extra_usage`. Real sample: `src/main/fixtures/usage-2026-09.json`.
- `percent` / `utilization` are 0–100 (not 0–1). `resets_at` is ISO-8601 UTC. Session `resets_at`
  may be null when no session is active.

## Known issues / limitations

- **Sign-in expiry:** if Claude Code isn't used for ~8 h its token expires and the overlay shows
  "sign-in expired" (with the last data) until Claude Code renews it. Phase 3 adds a claude.ai
  fallback source.
- Only tested on Windows 11 so far; macOS (Keychain prompt → "Always Allow") and Linux (tray on
  GNOME needs the AppIndicator extension; Wayland may ignore always-on-top/positioning) untested.
- No installer, app icon or launch-at-login yet (Phase 2); run from source with `npm start`.
- `is_active` from the API is parsed but not shown (meaning unclear).
- Opacity and refresh interval are only adjustable from the menu (no settings window).

## Session log

### 2026-09-24 — Session 1: research, plan, Phase 1

- Researched existing tools (SlavomirDurej/claude-usage-widget is the closest ready-made option;
  others are single-platform or Python/Qt). User chose to build their own with Electron.
- Inspected the real credentials structure (keys only) and the usage response; discovered the
  modern `limits[]` array and the weekly split by app.
- Researched token refresh ⇒ decision D3 (read-only).
- Implemented Phase 1 end to end, 28 unit tests, mock/screenshot tooling, docs
  (`CLAUDE.md`, `README.md`, this file, `BACKLOG.md`, one plan file per phase in `docs/phases/`).
- Next: Phase 2 — `docs/phases/phase-2-packaging.md`.
