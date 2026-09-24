# Claude Usage Overlay — project guide for Claude

Always-on-top desktop overlay (Electron + TypeScript, Windows/macOS/Linux) that shows the user's
Claude plan usage limits — current session, weekly, per-model weekly, weekly split by app — i.e. the
same numbers as Claude → Settings → Usage, refreshed automatically.

## Every session

1. **Start:** read `docs/PROGRESS.md` (status, decisions, known issues, session log) and
   `docs/BACKLOG.md` (phase index, general prompts, ideas). When working on a phase, read its plan
   in `docs/phases/phase-N-*.md`. Don't re-decide what is recorded there without telling the user why.
2. **Language:** talk to the user in **Persian (Farsi)**. Code, comments, commit messages and
   everything in `docs/` stay in English.
3. **Finish:** run `npm run check`; for UI changes also run `npm run screenshot` and *look* at the
   PNGs. Then update `docs/PROGRESS.md` (status, session-log entry, new decisions as D-numbers,
   known issues), the phase file (tick Scope items, set Status, fill in **Result**) and the phase
   table in `docs/BACKLOG.md`. Commit only when the user asks.
4. **New larger features** get their own plan file created from `docs/phases/_TEMPLATE.md` and a
   row in `docs/BACKLOG.md` before implementation starts.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Build and run the real app |
| `npm run start:mock` | Run with fake data (`node scripts/start.mjs --mock=<scenario>` for others) |
| `npm run screenshot -- [outDir] [scenario…]` | Render mock scenarios (expanded + compact) to PNGs (default `./screenshots/`) |
| `npm run check` | Typecheck (main + renderer configs) and unit tests |
| `npm run build` / `npm run watch` | esbuild bundle to `dist/` |
| `npm run dist` / `dist:win` / `dist:mac` / `dist:linux` | Build + electron-builder installers into `release/` (never publishes) |
| `npm run make-icon` | Regenerate `build/icon.png` (committed) |

Mock scenarios: `normal`, `warning`, `critical`, `expired`, `no-credentials`, `rate-limited`,
`offline`, `loading` (defined in `src/main/mock.ts`). Extra flags: `--compact`, `--expanded`,
`--screenshot=<file>` (render, save PNG, quit). Mock runs use a separate userData dir.

## Architecture

```
src/
  shared/types.ts        Type-only contracts between main, preload, renderer (no runtime values)
  main/                  Electron main process
    main.ts              Wiring: settings, service, window, tray, IPC, power/display events, CLI flags
    credentials.ts       READ-ONLY access to Claude Code's OAuth token (file / macOS Keychain)   [pure]
    usage-api.ts         net.fetch GET api.anthropic.com/api/oauth/usage
    usage-errors.ts      UsageHttpError, Retry-After parsing                                       [pure]
    usage-parse.ts       Raw JSON → UsageSnapshot (tolerant; limits[] first, legacy keys fallback) [pure]
    usage-service.ts     Polling, backoff, status state machine, emits 'change'                   [pure]
    settings.ts          settings.json in userData (sanitized, atomic writes)                     [pure]
    login-item.ts        Launch at login per OS (Electron API on Win/macOS, XDG autostart on Linux)
    login-item-core.ts   Reconcile setting ↔ OS, Task Manager flag parsing, Linux .desktop entry  [pure]
    snapshot-cache.ts    last-usage.json — last good snapshot, shown as stale on startup
    window.ts            Frameless transparent always-on-top window, fit-to-content, multi-monitor
    tray.ts / tray-icon.ts  Tray with a live progress ring drawn into a PNG at runtime  [tray-icon pure]
    menu.ts              Context menu shared by tray, ⋯ button and right-click
    mock.ts              Fake data sources for dev and screenshots                                [pure]
    fixtures/            Real API responses used by tests
  preload/preload.ts     contextBridge → window.overlay (OverlayApi)
  renderer/              Sandboxed UI: index.html, styles.css, renderer.ts (DOM), format.ts [pure]
scripts/                 build.mjs, test.mjs, start.mjs, screenshots.mjs, make-icon.mjs
build/                   icon.png (generated, committed), installer.nsh (NSIS uninstall hook)
.github/workflows/       release.yml — tag v* → build on 3 OSes → draft GitHub Release
docs/                    PROGRESS.md, BACKLOG.md (phase index), phases/ (one plan per phase), images/
```

Data flow: `UsageService` (main) reads credentials → fetches → parses → emits `change` → main sends
`AppState` to the renderer (`state:changed`) and updates the tray. The renderer sends back
`usage:refresh`, `view:set-compact`, `window:resize` (content size), `menu:show`.

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
4. **Network goes through Electron `net.fetch`** so system proxy/VPN settings apply.
5. **Cross-platform by default.** Consider Windows, macOS and Linux for every feature (tray click
   behaviour, Keychain, autostart, transparency, Wayland). Record gaps in `docs/PROGRESS.md`.
6. **Dependencies:** no new runtime dependencies without asking the user; dev deps only if justified.
7. **Severity colours live in three places** — keep them in sync: CSS vars in
   `renderer/styles.css`, SVG gradients in `renderer/index.html`, `SEVERITY_RGB` in
   `main/tray-icon.ts`.

## Gotchas

- VS Code / Claude Code terminals set `ELECTRON_RUN_AS_NODE=1`; plain `npx electron .` then runs as
  Node (`app` is undefined). Always use `npm start` / the scripts — they unset it.
- Windows drag regions (`-webkit-app-region: drag`) swallow mouse events: no `:hover` or
  `contextmenu` on the card; interactive elements need `no-drag`. Right-click on the drag area
  arrives as the window's `system-context-menu` event (handled in `main.ts`).
- The window is sized by the renderer (`ResizeObserver` → `window:resize`); `fitToContent` keeps
  the edge nearest the screen border fixed, so a corner-parked overlay grows away from the corner.
- Screenshots are in physical pixels (125 % scaling → 1.25× the CSS size).
- TypeScript 7 (native `tsc`) is used only for type-checking; esbuild does the bundling.
- To stop a test run of the app, kill its own PID tree — not every `electron.exe`.
- The installed app and `npm start` share userData (`%APPDATA%\Claude Usage Overlay`) and therefore
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
