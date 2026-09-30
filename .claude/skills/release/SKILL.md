---
name: release
description: Release a new version of Claude Usage the way this project releases — pick the version by SemVer from the commits since the last tag, run every check, bump package.json, record the release in docs/PROGRESS.md / BACKLOG / phase files, commit, push main and an annotated v<version> tag (CI builds the draft on 3 OSes), watch CI, draft the release notes, hand the owner the publish checklist, and verify the published release, its latest*.yml and the website afterwards. Use when the owner asks to release, publish or ship a new version (e.g. "نسخهٔ جدید منتشر کن", "release 1.5.0", "/release"), or says the draft is published ("منتشر کردم") so the release can be verified. Not for ordinary commits or pushes.
argument-hint: "[x.y.z — optional; picked by SemVer when omitted]"
---

# Release a new version

Owner's request: `$ARGUMENTS` (a version, or empty → pick it in step 2).

## How releasing works here

`v*` tag pushed → [release.yml](../../../.github/workflows/release.yml) checks tag = `package.json`
version, runs `npm run check`, builds on Windows / macOS / Linux, attaches the installers and
`latest*.yml` to a **draft** GitHub Release → **the owner publishes the draft by hand** as a normal
release → installed copies find it through `releases/latest` + `latest*.yml` (electron-updater,
D45–D48) → publishing also rebuilds the website's download links (`pages.yml`, D75).
Human version of the procedure: README → *Releasing a new version*. Past runs: PROGRESS sessions
24 (1.3.0), 27 (1.4.0), 29 (1.4.1); decisions D49, D55, D65, D71, D73.

You do steps 1–8 and 10–11; the owner does step 9 (publishing). Talk to the owner in Persian;
everything written to the repo and the release notes is English.

## Rules — each one exists because of something that went wrong or could

- **SemVer** (D49 / D55 / D65 / D71 / D73): new user-visible feature → minor; only fixes → patch;
  breaking (the new version can't read old settings, a removed feature or OS, a changed data
  location) → major, and only after asking the owner. Plain `x.y.z` — no `-beta`: the updater
  ignores pre-releases (D45). Never reuse a version or a tag that was pushed.
- **Tag exactly what was tested:** release from `main`, clean tree, not behind `origin/main`;
  `npm run check` passes on that tree; the tag points at the release commit.
- **Parallel sessions share this working tree** (owner's preference): never stash, reset, discard
  or commit someone else's changes. Stage the release files **by name** — never `git add -A`,
  `git add .` or `git commit -a`. A dirty tree from another session → stop and tell the owner.
- **Push by name:** `git push origin main`, then `git push origin v<x.y.z>` — never
  `git push --tags` (it pushes every stray local tag) and never `--force` (session 29: a public
  commit message was only replaced with the owner's explicit approval).
- **Never publish the release yourself**, and never delete, replace or re-upload files of a
  published release: running copies may be downloading them and a changed file no longer matches
  the sha512 in `latest.yml` (D46). A bad release is fixed by the next version.
- **Draft → normal release**, *Release label: None*, never *Pre-release* — a pre-release is
  invisible to `releases/latest` (D46). The `latest*.yml` files must stay attached (D45).
- **Release notes say only what is true and public:** what the README says, nothing more; "Tested
  on Windows 11", unsigned builds (D77); no secrets, tokens, e-mail addresses, local paths.

## 1. Preflight

1. Read `docs/PROGRESS.md` (status table, *Known issues*, the latest session entries, the highest
   `D` number) and the phase table in `docs/BACKLOG.md`. Check for other live sessions
   (`git status`, ListAgents) — a release waits until their work is committed.
2. Run `npm run release:check -- pre [version]` ([scripts/release-check.mjs](../../../scripts/release-check.mjs)).
   It checks branch, clean tree, `origin/main`, last tag, tag free here and on GitHub, `package.json`
   / lock versions, release config (publish = draft, D46 file names, `latest*.yml` upload, `APP_ID`
   = `build.appId`), `node_modules`; lists the commits since the last tag with their SemVer effect,
   suggests a version, and lists docs lines that wait for a version ("not released yet",
   "the next release").
3. **FAIL** → stop, explain in Persian, suggest the fix; don't work around it. Behind `origin/main`
   with a clean tree → `git pull --ff-only` is safe; then run the check again. Diverged → ask.
4. **WARN** → read it and act:
   - *commits aren't Conventional Commits* → read them (`git show --stat <hash>`); mention them to
     the owner; never rewrite pushed history on your own.
   - *nothing the app is built from changed* → ask the owner whether a release is wanted at all
     (the website deploys by itself on push).
   - *packaging inputs changed* → the local installer build in step 3 is required.
5. Understand what is being released: `git log --stat <last-tag>..HEAD`, the decisions and session
   entries for those commits, and the phase files they finish. You need this for the version, the
   docs and the notes.

## 2. Decide the version

- Owner gave one → use it if the check agrees; if it warns (skips versions, smaller than SemVer
  calls for, not newer), tell the owner why and recommend the right one.
- Otherwise take the suggestion after a sanity check against the real changes (`feat(site)` and
  `docs` don't change the app; a `fix` is still a patch even if it is large).
- Ask the owner (AskUserQuestion, recommended option first, one short Persian line each) **only**
  for: a major version, nothing app-related changed, or a WARN only they can decide. Otherwise go
  on — asking for a release is the approval, as in releases 1.3.0–1.4.1.
- Owner's manual tests still pending (status table) don't block — D71 released before them; say so
  in the report.

## 3. Verify locally

1. `npm run check` — must pass; note the test count for the session log.
2. `npm run build` — `check` doesn't run esbuild on the app.
3. Packaging inputs changed (step 1 WARN) → after the bump in step 4, `npm run dist:win`, then check
   `release/`: `Claude-Usage-Setup-<v>.exe`, `Claude-Usage-<v>-Portable.exe`, `latest.yml` with
   `version: <v>`; for a native runtime dependency its files are unpacked (e.g.
   `release/win-unpacked/resources/app.asar.unpacked/node_modules/koffi`). **Don't start** the
   packaged app: it shares userData and the single-instance lock with the owner's installed copy
   (CLAUDE.md → Gotchas). dmg / AppImage / deb are only built by CI.
4. Everything the release ships is documented: every new feature in the README and on the site
   (`site/index.html`, D76); if `src/renderer/` changed, `docs/images/` and `site/images/` were
   re-rendered after it (`git log -1 --format=%ci -- docs/images site/images` vs the renderer
   commits). A gap → fix it in a separate `docs:` commit **before** the release commit (the
   CLAUDE.md Finish rule), or ask the owner if it is more than a few lines.

## 4. Bump and record

Re-read each file right before editing it (another session may have changed it); small Edit-tool
changes only.

1. `npm version <v> --no-git-tag-version` — writes `package.json` and `package-lock.json`, no tag.
2. `docs/PROGRESS.md`:
   - A decision row after the last one, with the next free D-number (take it only when writing):
     `| D<n> | **Version <v>** for <what, in user words> | Semantic Versioning: <why minor/patch>
     (as D49 / D55 / D65 / D71 / D73). <settings compatibility, anything special> |`
   - Status table: the released phases → "released as <v>" (replace "not released yet"); known
     issues that wait for "the next release" → name the version.
   - Session log entry `### <YYYY-MM-DD> — Session <next>: release <v>`: what is in it (phases,
     decisions), `npm run check` result with the test count, the local installer build if done, the
     commands (`npm version`, commit, `main` pushed, tag pushed), "the owner publishes it by hand".
     Add the CI outcome after step 6.
3. `docs/BACKLOG.md` phase table and each finished phase file's **Status**: "released as <v>"
   (patch release of an earlier phase: "fix in <v>", as 1.4.1 did).

## 5. Commit, tag, push

1. `git add package.json package-lock.json docs/PROGRESS.md docs/BACKLOG.md docs/phases/<file>.md`
   (only files you changed), then commit, same style as `1a5bd84`:

   ```text
   chore: release v<v>

   <One or two sentences on what is in it, in user words.> Decision D<n>;
   <phase N> marked "released as <v>" in PROGRESS, BACKLOG and the phase file.
   ```

2. `npm run release:check -- pre <v>` again — must pass with no FAIL (clean tree, tag free, not behind).
3. `git push origin main`
4. `git tag -a v<v> -m "Claude Usage <v>"` and check `git rev-parse v<v>^{commit}` = `git rev-parse HEAD`.
5. `git push origin v<v>`
6. Push of `main` rejected (someone pushed meanwhile) → `git pull --rebase origin main` (only your
   unpushed release commit moves), `npm run check` again, back to 2. Never force.

## 6. Watch CI

Start `npm run release:check -- ci <v> --wait` in the background (Bash `run_in_background`); it
asks GitHub every 90 s and ends with the run's result (~10–15 min; exit 0 = success). Do steps 7
and 10 meanwhile.

- **Success** → all three builds and *Draft GitHub Release* passed; the draft exists with the files.
- **Failure** → which job failed. Known flake: macOS `watchDesktopHistory` (FSEvents, sessions 16
  and 24) → the owner re-runs the failed jobs (run page → *Re-run failed jobs*; logs need a
  GitHub sign-in, none here). A real failure → don't move the tag: fix on `main`, release the next
  patch version; the orphan tag and the unpublished draft are deleted only with the owner's OK.

Then add the CI outcome to the session entry (left uncommitted — step 11).

## 7. Release notes

English Markdown for **users**, pasted by the owner into the draft. Match the published ones
(`curl -s https://api.github.com/repos/masoudjaafariwork/Claude-usage/releases?per_page=3`):

- `## <Headline of the main change>` or `## Fixes` / `## What's new`; one bullet per change —
  **bold name**, what the user sees and where (*menu → …*), limits (OS, "Windows only").
- When they apply: a settings note (going back to an older version loses …, as 1.3.0), a
  requirement (e.g. Claude Code version), an "unsigned build" / SmartScreen hint for a new OS.
- Always: *Upgrading* — updates itself on Windows (installer) and Linux (AppImage); macOS, the
  Windows portable and the deb show a notification with a download link; or menu →
  *Check for updates*. And "Tested on Windows 11; the macOS and Linux builds are made by the same
  workflow but not tried on a real machine yet" while that is true (README).
- Last line: **Full changelog:** `https://github.com/masoudjaafariwork/Claude-usage/blob/v<v>/docs/PROGRESS.md`
  (decisions D<a>–D<b>). No D-numbers or internals elsewhere.

## 8. Hand the draft to the owner

In Persian, once CI passed (or with a "wait for CI" note):

1. GitHub → *Releases* → draft **Claude Usage <v>** → check the 9 files:
   `Claude-Usage-Setup-<v>.exe`, `Claude-Usage-<v>-Portable.exe`, `Claude-Usage-<v>-arm64.dmg`,
   `Claude-Usage-<v>-x64.dmg`, `claude-usage-<v>-x86_64.AppImage`, `claude-usage_<v>_amd64.deb`,
   `latest.yml`, `latest-mac.yml`, `latest-linux.yml`.
2. Replace the generated notes with the notes from step 7 (in a code block, ready to paste).
3. *Release label* **None** (not *Pre-release*), keep *Set as the latest release*, **Publish release**.
4. Tell me when it's published — I'll verify it.

## 9. The owner publishes

Wait. Don't poll GitHub for it.

## 10. Electron book

`D:\Clade usage\electron-book.html` (local only — never publish it, D24): a changelog entry in
`c-changelog` (newest first; heading `نسخهٔ <book version + 0.1> · <Persian date> (<YYYY-MM-DD>)`,
bullet `<strong>انتشار <v></strong> (تصمیم D<n>): … ; <why minor/patch in semver>`), the phase list
/ roadmap entry → "منتشرشده با <v>", `data-version` / `data-updated` on `#home`. Persian date:
`node -e "console.log(new Intl.DateTimeFormat('fa-IR-u-ca-persian',{day:'numeric',month:'long',year:'numeric'}).format(new Date()))"`.
Anything new learned about releasing (a CI failure, a new check) extends `c-release-updates`.
Follow the maintainer notes at the top of the file (escape HTML in `<pre><code>`).

## 11. After publishing, and the report

When the owner says it is published:

1. `npm run release:check -- post <v>` — `releases/latest` is `v<v>` and not a pre-release, all 9
   files attached, every `latest*.yml` names `<v>` and points at attached files with matching
   sizes and a sha512, the website links to `v<v>`. Only the website missing → the *Website*
   workflow needs a few minutes; check again later. Anything else → tell the owner exactly what and
   how to fix it (never by replacing files — D46).
2. Suggest the real-world test: the owner's installed copy → menu → *Check for updates*.
3. Add "published, post-check passed" to the session entry.

Final report in Persian: version and why, what is in it, check / test results, what was pushed
(commit + tag), CI result, what the owner does next, pending manual tests, known issues this
release will show (e.g. first CI builds with a new native dependency). Changes left uncommitted
(session entry after CI / publishing) → give a ready commit message, e.g.
`docs: record the v<v> release` — commit only if the owner asks.
