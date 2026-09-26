# Claude Usage — project guide for Claude

Always-on-top desktop overlay (Electron + TypeScript, Windows/macOS/Linux) that shows the user's
Claude plan usage limits — current session, weekly, per-model weekly, weekly split by app — i.e. the
same numbers as Claude → Settings → Usage, refreshed automatically.

## Every session

1. **Start:** read `docs/PROGRESS.md` (status, decisions, known issues, session log) and
   `docs/BACKLOG.md` (phase index, general prompts, ideas). When working on a phase, read its plan
   in `docs/phases/phase-N-*.md`. Don't re-decide what is recorded there without telling the user why.
2. **Language:** talk to the user in **Persian (Farsi)**. Code, comments, commit messages and
   everything in `docs/` stay in English. (Only exception: the Electron book below is Persian.)
3. **Finish:** run `npm run check`; for UI changes also run `npm run screenshot` and *look* at the
   PNGs. **README images:** if the change alters anything the README screenshots show (card,
   compact pill, banners, colours, fonts, spacing, mock data of their scenarios — see
   `README_IMAGES` in `scripts/screenshots.mjs`), run `npm run screenshot:readme`, look at
   `docs/images/*.png` and ship them with the change (D43); README text that describes the UI and
   the images' `width` attributes (the overlay's CSS width) must match too. Then update `docs/PROGRESS.md` (status, session-log entry, new decisions as D-numbers,
   known issues), the phase file (tick Scope items, set Status, fill in **Result**) and the phase
   table in `docs/BACKLOG.md`, and update the **Electron book** (next section). Commit only when the
   user asks — but whenever work is left for the user to commit, give them a ready-to-paste commit
   message (Conventional Commits, English).
4. **New larger features** get their own plan file created from `docs/phases/_TEMPLATE.md` and a
   row in `docs/BACKLOG.md` before implementation starts.

## Electron book (the owner is learning Electron with this project)

`D:\Clade usage\electron-book.html` — outside the repo, one self-contained HTML file, **Persian (RTL)**,
teacher-style for someone who knows no Electron. After every phase (and any notable change), add or
extend chapters so nothing that was built goes unexplained: why → Electron concept → real code from
the repo → pitfalls/OS differences → recap → quiz → exercise. Then update its changelog chapter
(`c-changelog`), the phase list and `data-version`/`data-updated` on `#home`. Authoring conventions are
in the comment at the top of the file (code in `<pre><code>` must be HTML-escaped).

The book is local only: do **not** publish or republish it to claude.ai (owner's decision, 2026-09-25).

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Build and run the real app |
| `npm run start:mock` | Run with fake data (`node scripts/start.mjs --mock=<scenario>` for others) |
| `npm run screenshot -- [outDir] [scenario…]` | Render mock scenarios (expanded + compact) to PNGs (default `./screenshots/`) |
| `npm run screenshot:readme` | Re-render the README images in `docs/images/` (committed) |
| `npm run check` | Typecheck (main + renderer configs) and unit tests |
| `npm run build` / `npm run watch` | esbuild bundle to `dist/` |
| `npm run dist` / `dist:win` / `dist:mac` / `dist:linux` | Build + electron-builder installers into `release/` (never publishes) |
| `npm run make-icon` | Regenerate `build/icon.png` (committed) |

Mock scenarios: `normal`, `warning`, `critical`, `expired`, `no-credentials`, `rate-limited`,
`offline`, `loading`, `via-desktop`, `desktop-unavailable`, `forecast`, `locked`, `other-account`, `update-ready` (defined in `src/main/mock.ts`).
Extra flags: `--compact`, `--expanded`, `--theme=<system|dark|light>`, `--scale=<0.9|1|1.15|1.3|1.5>`,
`--screenshot=<file>` (render, save PNG, quit). Mock runs use a separate userData dir and keep
notification records and usage history in memory; screenshot runs never notify or grab shortcuts.

## Architecture

```
src/
  shared/types.ts        Type-only contracts between main, preload, renderer (no runtime values)
  shared/format.ts       Time/text formatting for the renderer and notification text          [pure]
  main/                  Electron main process
    main.ts              Wiring: settings, service, window, tray, IPC, power/display events, CLI flags
    credentials.ts       READ-ONLY access to Claude Code's OAuth token (file / macOS Keychain)   [pure]
    claude-accounts.ts   Several accounts: config folder → sign-in / .claude.json / Keychain name, menu, --claude-config-dir [pure]
    usage-api.ts         net.fetch GET api.anthropic.com/api/oauth/usage
    usage-errors.ts      UsageHttpError, Retry-After parsing                                       [pure]
    usage-parse.ts       Raw JSON → UsageSnapshot (tolerant; limits[] first, legacy keys fallback) [pure]
    usage-source.ts      UsageSource contract, SourceUnavailableError, ClaudeCodeSource           [pure]
    desktop-source.ts    Claude Desktop's plan-usage-history.json: read, parse, watch (no network) [pure]
    file-watch.ts        Debounced folder watch for one file name (survives atomic renames)       [pure]
    hover.ts             Opaque on hover: polls cursor vs window bounds while see-through (D57)   [pure]
    claude-code-launcher.ts  "Open Claude Code": VS Code URI → terminal `claude` → docs (D34, D53) [pure]
    usage-service.ts     Source selection (Auto/single), polling, backoff, status, emits 'change' [pure]
    notifications-core.ts  75/90/100 % + reset notices: once per limit/threshold/window (D35)   [pure]
    notifications.ts     Shows them (Electron Notification), records in notifications.json
    pace.ts              24 h snapshot history (usage-history.json) + "at this pace" forecast   [pure]
    shortcuts-core.ts    Global shortcut defaults, validation, labels                           [pure]
    shortcuts.ts         globalShortcut registration (show/hide, lock/unlock)
    update-core.ts       Update mode per build, check schedule, menu label, notification texts   [pure]
    updater.ts           electron-updater: check GitHub Releases, download, install on quit/menu
    log.ts               Rotating log in app.getPath('logs'); every line goes through redact()     [pure]
    settings.ts          settings.json in userData (sanitized, atomic writes)                     [pure]
    login-item.ts        Launch at login per OS (Electron API on Win/macOS, XDG autostart on Linux)
    login-item-core.ts   Reconcile setting ↔ OS, Task Manager flag parsing, Linux .desktop entry  [pure]
    snapshot-cache.ts    last-usage.json — last good snapshot, shown as stale on startup
    window.ts            Frameless transparent always-on-top window, fit-to-content, multi-monitor, lock
    window-core.ts       Where a resized window goes (edge anchoring, stays on its display)       [pure]
    tray.ts / tray-icon.ts  Tray with a live progress ring drawn into a PNG at runtime  [tray-icon pure]
    menu.ts              Context menu shared by tray, ⋯ button and right-click
    mock.ts              Fake data sources for dev and screenshots                                [pure]
    fixtures/            Real API responses used by tests
  preload/preload.ts     contextBridge → window.overlay (OverlayApi)
  renderer/              Sandboxed UI: index.html, styles.css (dark + light theme vars), renderer.ts (DOM)
scripts/                 build.mjs, test.mjs, start.mjs, screenshots.mjs, make-icon.mjs
build/                   icon.png (generated, committed), installer.nsh (NSIS uninstall hook)
.github/workflows/       release.yml — tag v* → build on 3 OSes → draft GitHub Release
docs/                    PROGRESS.md, BACKLOG.md (phase index), phases/ (one plan per phase),
                         images/ (README screenshots, from `npm run screenshot:readme`)
```

Data flow: `UsageService` (main) asks the sources in order — Auto: Claude Code (credentials → fetch
→ parse), then Claude Desktop's history — → emits `change` → main sends `AppState` to the renderer
(`state:changed`) and updates the tray; while Opacity < 100 % it also pushes `hover:changed` (D57). Each fresh `ok` snapshot first goes into the history (pace
forecast in `AppState.forecast`) and through the notification check. A source throws `SourceUnavailableError` to hand over to the
next one; other errors are reported as they are (no fallback on network errors). The renderer sends back
`usage:refresh`, `view:set-compact`, `window:resize` (content size), `menu:show`.
One Claude Code account (config folder, `settings.claudeCodeDir`) is read at a time; switching moves
the credentials watch, cached snapshot, pace history and notification records to that account
(`userData/accounts/<key>/` for added folders) and discards a request still running for the old one.
Claude Desktop's samples count only for the shown account's org (D51).

`[pure]` modules must not import `electron`, so `npm test` can run them under plain Node.

## Hard rules

1. **Claude Code credentials are read-only.** Never write, refresh or rotate the OAuth token: refresh
   tokens are single-use, so refreshing would log Claude Code out (decision D3). Never log or print
   the token, never send it anywhere except the `Authorization` header to `api.anthropic.com`,
   never pass it to the renderer. When inspecting the credentials file, print key names only.
2. **The usage endpoint is unofficial and changes.** Keep `usage-parse.ts` tolerant. For any new
   response shape, add a fixture in `src/main/fixtures/` and a test. Poll politely: default 180 s,
   minimum 60 s, honour `Retry-After`, back off on errors; don't add request-heavy features.
3. **Renderer security:** `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP without
   `unsafe-inline`. Build DOM with the `h()`/`s()` helpers and `textContent` — never `innerHTML`
   with data. Styles from script only via CSSOM (`el.style.x = …`).
4. **Network goes through Electron `net.fetch`** so system proxy/VPN settings apply
   (electron-updater's update checks use Electron's `net` too).
5. **Cross-platform by default.** Consider Windows, macOS and Linux for every feature (tray click
   behaviour, Keychain, autostart, transparency, Wayland). Record gaps in `docs/PROGRESS.md`.
6. **Dependencies:** no new runtime dependencies without asking the user; dev deps only if justified.
   The only runtime dependency is `electron-updater` (D45); runtime deps stay `external` in
   `scripts/build.mjs` and electron-builder packs them into `app.asar`.
7. **No claude.ai sign-in in the app** (D28): Anthropic does not permit third-party apps to offer
   Claude.ai login or to collect/store claude.ai session tokens — no embedded login window, no
   browser-cookie reading, no pasted `sessionKey`. From Claude Desktop's folder read only
   `plan-usage-history.json`; never its sign-in (D26).
8. **Severity colours live in three places** — keep them in sync: CSS vars in
   `renderer/styles.css`, SVG gradients in `renderer/index.html`, `SEVERITY_RGB` in
   `main/tray-icon.ts`.

## Gotchas

- VS Code / Claude Code terminals set `ELECTRON_RUN_AS_NODE=1`; plain `npx electron .` then runs as
  Node (`app` is undefined). Always use `npm start` / the scripts — they unset it.
- Windows drag regions (`-webkit-app-region: drag`) swallow mouse events: no `:hover` or
  `contextmenu` on the card; interactive elements need `no-drag`. Right-click on the drag area
  arrives as the window's `system-context-menu` event (handled in `main.ts`).
- The window is sized by the renderer (`fitWindow()` in `renderer.ts` → `window:resize`); `fitToContent` keeps
  the edge nearest the screen border fixed, so a corner-parked overlay grows away from the corner.
  The renderer reports exact (fractional) CSS pixels; the window gets them × the Size zoom factor,
  rounded up once (a zoom change doesn't fire the `ResizeObserver`, so `main.ts` re-fits from the
  last reported size). The window *is* the card — no transparent margin, hence no drop shadow — so
  the card can touch any screen edge (D42); `fitWindow()` stretches the card over the ≤ 2 px left
  by rounding to whole DIPs. Don't add padding to `#app` or an outer `box-shadow` to `.card`.
- Chromium stores a zoom level per page in `userData/Preferences` and prefers it to
  `webPreferences.zoomFactor`; `main.ts` re-applies the Size setting on `did-navigate` (D38).
- Screenshots are in physical pixels (125 % scaling → 1.25× the CSS size).
- TypeScript 7 (native `tsc`) is used only for type-checking; esbuild does the bundling.
- To stop a test run of the app, kill its own PID tree — not every `electron.exe`.
- All mock runs share `userData/mock-data` and therefore one single-instance lock: while a mock or
  screenshot run is open (e.g. from a parallel session), another one quits at once. The screenshot
  script reports that as "no image written".
- The installed app and `npm start` share userData (`%APPDATA%\Claude Usage`) and therefore
  the single-instance lock: `npm start` exits at once while the installed app runs. Quit it first.
  Mock runs use their own userData and are not affected.
- The packaged exe also runs as plain Node when `ELECTRON_RUN_AS_NODE=1` is inherited; start it via
  `explorer.exe <exe or .lnk>` from these terminals.
- `APP_ID` in `main.ts` = `build.appId` in `package.json` = the Run-key value name that
  `build/installer.nsh` removes (`${APP_ID}`). Change all three together.
- Windows login items: Electron 44's `launchItems` / `executableWillLaunchAtLogin` ignore paths
  with spaces; `login-item.ts` uses `openAtLogin` + the StartupApproved flag instead (D18).
- `npm run dist:win` builds Windows only; the dmg needs macOS and the Linux packages Linux — CI
  (`release.yml`) builds all three.
- Updates (D45–D48): release file names must not contain spaces (electron-updater maps them to
  dashes, GitHub to dots → 404); every release needs its `latest*.yml` attached and must be a
  normal release, not a pre-release (the updater reads `releases/latest`). The updater is off in
  dev, mock and screenshot runs. To test it locally, build two versions under another identity
  (own `appId` / `productName` / `extraMetadata`, `publish` = generic `http://127.0.0.1:<port>/`)
  and serve the newer one's output folder — never test on the owner's installed app.
