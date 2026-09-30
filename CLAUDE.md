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
   the images' `width` attributes (the overlay's CSS width) must match too. The GitHub social
   preview shows the same card and pill: re-render it too (`npm run social-preview`), look at
   `docs/images/social-preview.png` and tell the owner to upload it again (D58). **Website:** the
   site (`site/`) shows overlay renders too (`SITE_IMAGES` in `scripts/site.mjs`) — when they change,
   run `npm run site:images`, then `npm run site:shot` and look at the captures; a new or changed
   feature also gets its line on the site (`site/index.html`), which must stay as true as the README
   (D76). Then update `docs/PROGRESS.md` (status, session-log entry, new decisions as D-numbers,
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
| `npm run social-preview` | Render the 1280×640 GitHub social preview to `docs/images/social-preview.png` (committed; uploaded by hand in the repo's Settings) |
| `npm run site` | Build the website into `_site/` and serve it at `http://localhost:4173/Claude-usage/` (rebuilds on changes in `site/`) |
| `npm run site:build` | Only build `_site/` (what `.github/workflows/pages.yml` deploys to GitHub Pages) |
| `npm run site:images` | Re-render the site's overlay images (2× density) and icons into `site/images/` (committed) |
| `npm run site:shot -- [outDir]` | Capture the built site at 1280 / 390 px dark and light, plus 1024 px dark (default `./screenshots/site-*.png`); fails on console errors or 4xx |
| `npm run check` | Typecheck (main + renderer configs) and unit tests |
| `npm run build` / `npm run watch` | esbuild bundle to `dist/` |
| `npm run dist` / `dist:win` / `dist:mac` / `dist:linux` | Build + electron-builder installers into `release/` (never publishes) |
| `npm run make-icon` | Regenerate `build/icon.png` (committed) |
| `npm run release:check -- pre [x.y.z]` / `ci x.y.z [--wait]` / `post x.y.z` | Release checks: before tagging (git state, tag free, SemVer suggestion, release config), the tag's CI run, the published release (files, `latest*.yml`, website) |

**Releasing:** always through the `/release` skill ([.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md), D83) —
SemVer, checks, docs, commit, annotated tag, CI, release notes; the owner publishes the draft by hand.

Mock scenarios: `normal`, `warning`, `critical`, `expired`, `no-credentials`, `rate-limited`,
`offline`, `loading`, `via-desktop`, `desktop-unavailable`, `forecast`, `locked`, `other-account`, `update-ready`,
`several-accounts` (two windows), `first-run` (no Claude Code installed), `renewing`, `sign-in-again`, `leftover-sign-in` (expired sign-in, no Claude Code)
(defined in `src/main/mock.ts`). Mock runs never start Claude Code (sign-in, install, renewal only log).
Extra flags: `--compact`, `--expanded`, `--theme=<system|dark|light>`, `--scale=<0.9|1|1.15|1.3|1.5>`,
`--screenshot=<file>` (render, save PNG, quit; more windows → `<file>-2.png` …), `--keep-occlusion` (Windows: leave Chromium's window
occlusion tracker on, to test the blank-overlay watchdog, D60). Mock runs use a separate userData dir and keep
notification records and usage history in memory; screenshot runs never notify or grab shortcuts.

## Architecture

```
src/
  shared/types.ts        Type-only contracts between main, preload, renderer (no runtime values)
  shared/format.ts       Time/text formatting for the renderer and notification text          [pure]
  main/                  Electron main process
    main.ts              Wiring: settings, the window list, tray, menu, IPC (routed per window), power/display events, CLI flags
    overlay.ts           One window + its account: usage service, cache, history, notifier, credentials watch, fit/drag/hover/rebuild/watchdog (Phase 7)
    credentials.ts       READ-ONLY access to Claude Code's OAuth token (file / macOS Keychain)   [pure]
    claude-accounts.ts   Several accounts: config folder → sign-in / .claude.json / Keychain name, menu, --claude-config-dir [pure]
    usage-api.ts         net.fetch GET api.anthropic.com/api/oauth/usage
    usage-errors.ts      UsageHttpError, Retry-After parsing                                       [pure]
    usage-parse.ts       Raw JSON → UsageSnapshot (tolerant; limits[] first, legacy keys fallback) [pure]
    usage-source.ts      UsageSource contract, SourceUnavailableError, ClaudeCodeSource           [pure]
    desktop-source.ts    Claude Desktop's plan-usage-history.json: read, parse, watch (no network) [pure]
    file-watch.ts        Debounced folder watch for one file name (survives atomic renames)       [pure]
    hover.ts             Opaque on hover: polls cursor vs window bounds while see-through (D57)   [pure]
    recovery-core.ts     Crash-loop budget, relaunch target (portable exe / AppImage), process-gone text (D60) [pure]
    claude-code-launcher.ts  Finds a directly runnable Claude Code; "Open Claude Code" (D34, D53); sign-in / install terminals (Phase 8) [pure]
    claude-code-renewal.ts   Background renewal: hidden `claude -p /usage`, output check, schedule (Phase 8) [pure]
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
    window-core.ts       Where a resized window goes (edge anchoring, stays on its display); free spot for a new one; a popup at the cursor [pure]
    virtual-desktops-core.ts  Desktop list from the registry values, GUID bytes, saved set ↔ list, target desktop, adoption, checkbox menu entries (Phases 10, 11) [pure]
    virtual-desktops.ts  Windows: koffi → registry (read-only, plus a change watch) + IVirtualDesktopManager + user32 foreground; macOS / Linux: setVisibleOnAllWorkspaces
    desktop-picker.ts    Windows: the "Show on desktops…" window — a checkbox grid (windows × desktops) that stays open (Phase 11)
    tray.ts / tray-icon.ts  Tray with a live progress ring drawn into a PNG at runtime  [tray-icon pure]
    menu.ts              Context menu: one window's (⋯, right-click) or all windows' (tray with several)
    mock.ts              Fake data sources for dev and screenshots                                [pure]
    fixtures/            Real API responses used by tests
  preload/preload.ts     contextBridge → window.overlay (OverlayApi); picker-preload.ts → window.picker (DesktopPickerApi)
  renderer/              Sandboxed UI: index.html, styles.css (dark + light theme vars), renderer.ts (DOM);
                         picker.html / picker.css / picker.ts — the desktop picker's page
scripts/                 build.mjs, test.mjs, start.mjs, screenshots.mjs, social-preview.mjs, make-icon.mjs,
                         site.mjs (website: build with release data, serve, images, captures),
                         release-check.mjs (release checks before tagging / CI / after publishing)
.claude/skills/release/  The /release skill: the whole release procedure (D83)
site/                    Website (GitHub Pages, Phase 9): index.html, 404.html, styles.css, app.js, sitemap.xml,
                         images/ (overlay renders + icons from `npm run site:images`, committed); {{…}} filled by site.mjs
build/                   icon.png (generated, committed), installer.nsh (NSIS uninstall hook)
.github/workflows/       release.yml — tag v* → build on 3 OSes → draft GitHub Release;
                         pages.yml — site/ changes on main or a published release → build → GitHub Pages
docs/                    PROGRESS.md, BACKLOG.md (phase index), phases/ (one plan per phase),
                         images/ (README screenshots, from `npm run screenshot:readme`; social
                         preview, from `npm run social-preview`)
```

Data flow (per overlay window, `overlay.ts`): its `UsageService` asks the sources in order — Auto: Claude Code (credentials → fetch
→ parse), then Claude Desktop's history — → emits `change` → the window gets its `AppState`
(`state:changed`) and main updates the tray; while Opacity < 100 % it also pushes `hover:changed` (D57). Each fresh `ok` snapshot first goes into the history (pace
forecast in `AppState.forecast`) and through the notification check. A source throws `SourceUnavailableError` to hand over to the
next one; other errors are reported as they are (no fallback on network errors). The renderer sends back
`usage:refresh`, `view:set-compact`, `window:resize` (content size), `menu:show`, `window:close`,
`page:visibility` (blank-overlay watchdog, D60); main routes each to the window whose `webContents`
sent it.
Sign-in is always the user's own Claude Code (Phase 8, D66–D70): *Sign in* / *Install Claude Code* /
*Add account (sign in)…* open a terminal that runs `claude auth login` (after Anthropic's installer);
an expired sign-in makes the window's `Overlay` ask main to run Claude Code hidden with its local
`/usage` command, which renews Claude Code's own token; the credentials watch then loads fresh numbers.
Every window shows one Claude Code account (config folder), never one another window shows
(`settings.windows`: account, position, compact, virtual desktops; the first is the main window, D62). Switching a
window moves its credentials watch, cached snapshot, pace history and notification records to that
account (`userData/accounts/<key>/` for added folders) and discards a request still running for the
old one. Look, lock, source, interval and notifications settings are global. Claude Desktop's
samples count only for the shown account's org (D51).

`[pure]` modules must not import `electron`, so `npm test` can run them under plain Node.

## Hard rules

1. **Claude Code credentials are read-only.** Never write, refresh or rotate the OAuth token: refresh
   tokens are single-use, so refreshing would log Claude Code out (decision D3). Never log or print
   the token, never send it anywhere except the `Authorization` header to `api.anthropic.com`,
   never pass it to the renderer. When inspecting the credentials file, print key names only.
   Letting the user's own Claude Code renew its own token (Open Claude Code, the hidden `/usage`
   run, D34 / D67) is allowed — the app itself never touches the refresh token.
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
   The runtime dependencies are `electron-updater` (D45) and `koffi` (D78, exact version, native;
   `require`d lazily on Windows only, D82); runtime deps stay `external` in `scripts/build.mjs` and
   electron-builder packs them into `app.asar` (koffi's `.node` file into `app.asar.unpacked`).
   Through koffi only public, documented Windows APIs — never `IVirtualDesktopManagerInternal`.
7. **No claude.ai sign-in in the app** (D28): Anthropic does not permit third-party apps to offer
   Claude.ai login or to collect/store claude.ai session tokens — no embedded login window, no
   browser-cookie reading, no pasted `sessionKey`, no OAuth flow of our own (not even with Claude
   Code's client id). Signing in = the user's own Claude Code running `claude auth login` in a
   visible terminal (D66). From Claude Desktop's folder read only `plan-usage-history.json`; never
   its sign-in (D26).
8. **Severity colours live in three places** — keep them in sync: CSS vars in
   `renderer/styles.css`, SVG gradients in `renderer/index.html`, `SEVERITY_RGB` in
   `main/tray-icon.ts`.

## Gotchas

- VS Code / Claude Code terminals set `ELECTRON_RUN_AS_NODE=1`; plain `npx electron .` then runs as
  Node (`app` is undefined). Always use `npm start` / the scripts — they unset it.
- **Never run `claude -p "/usage"` through a shell** (Git Bash / MSYS rewrites a leading `/` into a
  Windows path, and Claude Code then sends it to the model as a real prompt — it happened once in
  the Phase 8 research). The app spawns the binary directly (`runHidden`); to try it by hand, use a
  Node script, not Bash. Only one real `/usage` run on the owner's default account per session, and
  never on an account the owner didn't ask about — use an empty or fake config folder instead.
- Each hidden `/usage` run leaves an empty `projects/<…claude-code-runs>/memory` folder in that
  account's Claude Code config (no session file, thanks to `--no-session-persistence`).
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
- Windows: `setAlwaysOnTop(true, 'floating' … 'status')` puts the window behind the taskbar, and it
  loses topmost whenever the taskbar isn't topmost. Always go through `applyAlwaysOnTop()`
  (`'pop-up-menu'` on Windows, D61); check the real state with `GetWindowLongPtr(GWL_EXSTYLE)`
  (`WS_EX_TOPMOST`), not `win.isAlwaysOnTop()`, which only echoes the last call.
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
- Website (Phase 9, D74–D77): the page makes no request to any other site (CSP in a meta tag, no
  inline script / style, no web fonts, no analytics) — keep it that way. Download links come from
  `releases/latest` at build time, so file names must keep matching `ASSETS` in `site.mjs` (D46
  names). `site/index.html` isn't viewable as is (`{{…}}` placeholders): use `npm run site`. The
  site lives under `/Claude-usage/`; `404.html` uses root-relative links for that. Electron quits at
  once when an `http://` URL is on its command line (why `--shot` passes a port), and `img.decode()`
  never settles for off-screen `loading="lazy"` images.
- Virtual desktops (Phase 10, D79–D82): on Windows a window belongs to a desktop only through its
  taskbar button (`skipTaskbar` = on all desktops), and a hidden window loses its desktop — every show
  must go through `Overlay.placeOnDesktop()`, and the real desktop (`syncDesktop()`) must be read
  *before* hiding. `win.isVisible()` is true on another desktop (the window is cloaked): decide
  show / hide with `isVisibleHere()`. `MoveWindowToDesktop` works only inside the app's own process
  (`E_ACCESSDENIED` from a helper; reading the desktop from outside works). Activating a window
  (`focus()`) switches the user's desktop: only on the user's request, and never in a test without the
  owner's OK. Mock runs keep a chosen desktop in `mock-data/settings.json`, so a mock window may open
  on another desktop. Windows knows only "one desktop" or "all": a window on several desktops (Phase
  11, D85) follows the user — a registry watch (`RegNotifyChangeKeyValue`, waited for with a koffi
  `.async` call) runs while such a window exists and moves it on every switch into its set.
- Native menus close on every click (Win32; Electron can't keep them open). Anything the user ticks
  several times in a row belongs in a window of its own, like the desktop picker (D86) — not in a
  menu, and not in a menu that reopens itself (the owner rejected that). The portable exe doesn't pass its stderr on: read a test run's inspector URL
  from `http://127.0.0.1:<port>/json`.
