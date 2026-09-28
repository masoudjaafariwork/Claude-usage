# Phase 9 — Project website (GitHub Pages)

| | |
| --- | --- |
| **Status** | ✅ Done (2026-09-29) — live once Pages is switched to *GitHub Actions* (owner) |
| **Depends on** | — (uses the released app, v1.4.1) |
| **Size** | One Claude Code session |

## Goal

A complete introduction page for Claude Usage at `https://masoudjaafariwork.github.io/Claude-usage/`:
what it shows, why it is safe, every feature, how to install on each OS (one-click download of the
latest release for the visitor's system), FAQ. It is meant to be the page people land on from
search engines and shared links, instead of the README.

## Background

- BACKLOG → Ideas → *Findability* (D59) lists "a GitHub Pages landing page (title, meta description,
  Open Graph, JSON-LD `SoftwareApplication`, Google Search Console)". The competitor analysis
  (session 21) ranks discoverability as the top gap (P0).
- The repository is public; Pages was not enabled yet (checked 2026-09-29).
- README text and the D-decisions are the source for every claim on the page (read-only token,
  no claude.ai login D28, no telemetry, only Windows 11 tested D49, unsigned builds D15/D16).
- README / social-preview images are generated from mock scenarios (D43, D58); the site follows
  the same rule.

## Scope

- [x] `site/`: hand-written static site — `index.html`, `404.html`, `styles.css`, `app.js`,
      `sitemap.xml` (no `robots.txt`, see Result); English; dark and light theme (follows the
      system, see Result); works at phone width; no framework, no new dependencies.
- [x] Sections: hero with OS-aware download button, what the card shows, features, gallery of
      states, privacy / how it works, getting started + shortcuts, downloads per OS (with the
      first-run warnings), FAQ, footer with the "not affiliated with Anthropic" notice.
- [x] SEO: title, meta description, canonical, Open Graph + Twitter card (the social preview
      image), JSON-LD `SoftwareApplication`, sitemap.
- [x] `scripts/site.mjs`: build `site/` → `_site/` with the latest published release's version,
      date, file names, sizes and download URLs filled in; `--serve` for a local preview;
      `--images` renders the overlay images (2× pixel density) and the icons into `site/images/`;
      `--shot` captures the built page (desktop + phone, dark + light) into `screenshots/`.
- [x] `.github/workflows/pages.yml`: build and deploy on pushes to `main` that touch the site, on
      a published release (re-run on `main`) and by hand.
- [x] README links to the website; CLAUDE.md (commands, architecture, Finish rule for the site
      images); docs.

## Out of scope

- Custom domain, analytics, a blog, a Persian version of the site (Persian UI is a separate idea).
- Google Search Console verification and the repo's *Website* field — the owner's steps (listed in
  the Result).
- An animated demo (GIF / video) — BACKLOG idea.

## Technical notes

- **Hosting:** GitHub Pages with *Source: GitHub Actions* (`actions/upload-pages-artifact` +
  `actions/deploy-pages`), not the `/docs` folder: `docs/` holds PROGRESS / phase files that Jekyll
  would publish as pages.
- **Release data at build time:** `releases/latest` from the GitHub API (token in CI) → direct
  links to the six installers. The page itself makes no request to any other site (no CDN fonts,
  no analytics, no API calls from the visitor's browser) — the same "no telemetry" promise as the
  app. A local build without network falls back to links to the Releases page.
- **Release trigger:** a `release` event runs on the tag, and the `github-pages` environment only
  allows the default branch; the release job therefore starts the workflow again on `main`
  (`workflow_dispatch` from `GITHUB_TOKEN` is allowed to start a run).
- **CSP** in a meta tag (Pages can't set headers): `default-src 'self'`, no inline script/style.
- **Images:** real renders from mock scenarios with `--force-device-scale-factor=2`; `site.mjs`
  writes `width` / `height` from the PNG header at build time, so re-rendered images keep their
  natural size.
- Legal: independent project, "Claude" is Anthropic's trademark; no Anthropic logos.

## Acceptance criteria

- `npm run site` shows the page locally with working download links for v1.4.1.
- Captures at 1280 px and 390 px, dark and light, look right; no console errors, no failed requests.
- `npm run check` passes (no app code changes).
- `docs/PROGRESS.md`, `docs/BACKLOG.md` and this file's **Result** section updated.

## Manual test checklist (for the user)

- [ ] GitHub → *Settings → Pages* → *Source: GitHub Actions*; push; *Actions* → *Website* is green.
- [ ] Open the site on the computer and on a phone; the hero button offers your OS's file.
- [ ] Share the link in a chat app: the card shows the social preview image.
- [ ] Repo → *About* → *Website*: set to the site URL.

## Prompt

Paste into a new Claude Code session opened in this repository:

```text
Implement Phase 9 of Claude Usage as specified in docs/phases/phase-9-website.md.
Read CLAUDE.md, docs/PROGRESS.md and that phase file first. Follow its Scope, Out of scope,
Technical notes and Acceptance criteria. If something in the plan turns out to be wrong or
risky, stop and ask me before deviating. When done: fill in the phase file's Result section,
set its status, update docs/PROGRESS.md and docs/BACKLOG.md, and give me the manual test steps.
```

## Result

Delivered as planned (session 30, D74–D77):

- `site/`: `index.html` (hero with OS-aware download, what the card shows, alert levels, 12
  features, gallery of 8 states, privacy + request diagram, getting started + shortcuts, downloads
  per OS, 10 FAQ, closing, footer notice), `404.html`, `styles.css` (app palette, dark / light,
  breakpoints 980 / 760 / 420 px), `app.js` (OS detection, copy buttons), `sitemap.xml`,
  `images/` (16 renders at 2× + 4 icons, ~2.5 MB).
- `scripts/site.mjs` with `site`, `site:build`, `site:images`, `site:shot`;
  `.github/workflows/pages.yml` (push to `main` on site paths, published release → re-run on
  `main`, by hand).

Deviations: no `robots.txt` — on a project site (`/Claude-usage/`) crawlers only read the host's
root file, which this repository doesn't own; the sitemap is submitted in Search Console instead.
No theme toggle — the page follows the system like the overlay's *System* theme, which keeps the
hero's `<picture>` swap free of script.

Verified: captures at 1280 / 390 px in dark and light and 1024 px dark (no console errors, no 4xx), JSON-LD,
anchors, alt texts, the 404 page, the build's fallback without release data and its failure in CI.
Not verified: the workflow on GitHub (runs after the owner's setup), Safari / Firefox.

Owner's steps after pushing:
1. *Settings → Pages → Build and deployment → Source: GitHub Actions*; then *Actions → Website →
   Run workflow* (or push).
2. *About* (gear on the repo page) → *Website*: `https://masoudjaafariwork.github.io/Claude-usage/`.
3. Optional: Google Search Console → URL-prefix property for that address, verify (HTML file into
   `site/` or the meta tag into `site/index.html`), submit `sitemap.xml`.

Follow-ups (BACKLOG ideas): WebP images; a short demo video / GIF; a Persian page.
