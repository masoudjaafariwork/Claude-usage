// Release checks for the /release skill (.claude/skills/release/SKILL.md) and README → Releasing a new version.
// Usage:
//   npm run release:check -- pre [version]         → before tagging: branch, clean tree, in sync with origin, tag free,
//                                                     SemVer suggestion from the commits since the last tag, release config
//   npm run release:check -- ci <version> [--wait] → the release workflow's run for tag v<version> (--wait: until it ends)
//   npm run release:check -- post <version>        → after publishing: releases/latest, its files, latest*.yml, website
//
// Only Node built-ins and git. GitHub is read without a token (60 API requests an hour per IP; `ci --wait` asks every
// 90 s); GITHUB_TOKEN or GH_TOKEN is used when set. Exit code: 0 = fine, 1 = something to fix first, 2 = (ci) still running.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = readJson('package.json');
const { owner, repo } = pkg.build.publish;
const REPO = `${owner}/${repo}`;
const SITE_URL = `https://${owner}.github.io/${repo}/`;

/** Release file names (D46) — the same as FALLBACK_NAMES in site.mjs and README → Releasing a new version. */
const installers = (v) => [
  `Claude-Usage-Setup-${v}.exe`,
  `Claude-Usage-${v}-Portable.exe`,
  `Claude-Usage-${v}-arm64.dmg`,
  `Claude-Usage-${v}-x64.dmg`,
  `claude-usage-${v}-x86_64.AppImage`,
  `claude-usage_${v}_amd64.deb`,
];
/** What installed copies read to find and verify an update (electron-updater, D45). */
const UPDATE_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

/** electron-builder settings the names above come from; changing one means D46, site.mjs ASSETS and README too. */
const ARTIFACT_NAMES = {
  nsis: 'Claude-Usage-Setup-${version}.${ext}',
  portable: 'Claude-Usage-${version}-Portable.${ext}',
  dmg: 'Claude-Usage-${version}-${arch}.${ext}',
  appImage: '${name}-${version}-${arch}.${ext}',
};

/** Conventional Commits subject: type, optional scope, optional "!" for a breaking change. */
const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?: \S/;
const PATCH_TYPES = new Set(['fix', 'perf', 'refactor', 'build', 'revert']);
/** Scopes outside the app: such commits don't change what installed copies run. */
const NON_APP_SCOPES = new Set(['site', 'docs', 'readme', 'ci']);
const RANK = { patch: 1, minor: 2, major: 3 };

/** Files the installers are built from (tests and fixtures aren't shipped). */
const isAppFile = (f) =>
  (f.startsWith('src/') && !f.endsWith('.test.ts') && !f.startsWith('src/main/fixtures/')) ||
  f.startsWith('build/') ||
  f === 'package-lock.json' ||
  f === 'scripts/build.mjs';
/** package.json keys that change the installers (a version bump alone doesn't count). */
const PACKAGE_APP_KEYS = ['main', 'build', 'dependencies', 'devDependencies'];

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`  info  ${m}`);
const warn = (m) => {
  warnings++;
  console.log(`  WARN  ${m}`);
};
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const indent = (text) =>
  text
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n');
const clip = (s, n = 96) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const [mode, ...rest] = process.argv.slice(2);
const wait = rest.includes('--wait');
const versionArg = rest.find((a) => !a.startsWith('--'));

try {
  if (mode === 'pre') pre(versionArg);
  else if ((mode === 'ci' || mode === 'post') && parseVersion(versionArg)) {
    const v = parseVersion(versionArg).join('.');
    if (mode === 'ci') await ci(v);
    else await post(v);
  } else {
    console.log('Usage: npm run release:check -- pre [x.y.z] | ci x.y.z [--wait] | post x.y.z');
    process.exit(1);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
console.log(
  `\n${failures ? `${failures} problem(s) to fix first` : 'All checks passed'}` +
    `${warnings ? `, ${warnings} warning(s) to look at` : ''}.`,
);
process.exit(failures ? 1 : 0);

// ── pre ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function pre(requested) {
  console.log('Release preflight\n\nRepository:');
  const wanted = requested === undefined ? null : parseVersion(requested);
  if (requested !== undefined && !wanted) {
    fail(`"${requested}" isn't a plain x.y.z version (no pre-release suffix: the updater ignores pre-releases, D45)`);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'main') ok('on main');
  else fail(`on "${branch}" — releases are tagged on main`);

  const dirty = git(['status', '--porcelain']);
  if (dirty) fail(`the working tree isn't clean (another session's work?) — the tag must be what was tested:\n${indent(dirty)}`);
  else ok('working tree clean');

  if (git(['fetch', '--quiet', '--tags', 'origin', 'main'], true) === null) {
    fail("git fetch origin failed — can't compare with GitHub");
  } else {
    const behind = Number(git(['rev-list', '--count', 'HEAD..origin/main']));
    if (behind) fail(`${behind} commit(s) on origin/main aren't here — git pull --ff-only, then check again`);
    else ok('not behind origin/main');
    const ahead = git(['log', '--format=%h %s', 'origin/main..HEAD']);
    if (ahead) info(`not pushed yet (goes out with the release):\n${indent(ahead.split('\n').map((l) => clip(l)).join('\n'))}`);
  }

  const lastTag = git(['tag', '--list', 'v*', '--sort=-v:refname'])
    .split('\n')
    .find((t) => parseVersion(t));
  if (!lastTag) {
    fail('no v<x.y.z> tag found');
    return;
  }
  const last = parseVersion(lastTag);
  if (spawnSync('git', ['merge-base', '--is-ancestor', lastTag, 'HEAD'], { cwd: root }).status === 0) {
    ok(`last release: ${lastTag}`);
  } else {
    fail(`${lastTag} isn't an ancestor of HEAD — this branch doesn't contain the last release`);
  }

  // What changed, and what SemVer says about it.
  console.log(`\nCommits since ${lastTag}:`);
  const commits = git(['log', '--format=%h%x1f%s%x1f%b%x1e', `${lastTag}..HEAD`])
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [hash, subject, body = ''] = s.split('\x1f');
      return { hash, subject, body };
    });
  let kind = null;
  const raise = (k) => {
    if (k && (!kind || RANK[k] > RANK[kind])) kind = k;
  };
  const odd = [];
  for (const c of commits) {
    const m = CONVENTIONAL.exec(c.subject);
    let effect = null;
    if (!m) odd.push(c);
    else if (m[3] || /^BREAKING[ -]CHANGE:/m.test(c.body)) effect = 'major';
    else if (NON_APP_SCOPES.has(m[2])) effect = null;
    else if (m[1] === 'feat') effect = 'minor';
    else if (PATCH_TYPES.has(m[1])) effect = 'patch';
    raise(effect);
    console.log(`  ${c.hash}  ${(m ? effect ?? '—' : '?').padEnd(5)}  ${clip(c.subject)}`);
  }
  if (!commits.length) console.log('  (none)');
  if (odd.length) {
    warn(
      `${odd.length} commit(s) aren't Conventional Commits (marked ?) — read them; pushed history is only rewritten with the owner's OK`,
    );
  }

  const changed = git(['diff', '--name-only', `${lastTag}..HEAD`]).split('\n').filter(Boolean);
  const appFiles = changed.filter(isAppFile);
  const oldPkg = JSON.parse(git(['show', `${lastTag}:package.json`]));
  const pkgKeys = PACKAGE_APP_KEYS.filter((k) => JSON.stringify(oldPkg[k]) !== JSON.stringify(pkg[k]));
  console.log('\nApp:');
  if (!appFiles.length && !pkgKeys.length) {
    warn(`nothing the app is built from changed since ${lastTag} — a release would ship the same program (the website deploys by itself)`);
  } else {
    info(`${appFiles.length} app file(s) changed${pkgKeys.length ? `; package.json: ${pkgKeys.join(', ')}` : ''}`);
    if (!kind) {
      info('app files changed under commit types that bump nothing — at least a patch');
      kind = 'patch';
    }
  }
  const packaging = [
    ...pkgKeys.filter((k) => k !== 'main'),
    ...changed.filter((f) => f.startsWith('build/') || f === 'scripts/build.mjs'),
  ];
  if (packaging.length) {
    warn(`packaging inputs changed (${packaging.join(', ')}) — build the Windows installer locally before tagging (npm run dist:win)`);
  }
  if (changed.includes('src/main/settings.ts')) {
    info('settings.ts changed — the new version must read the old settings; say in the notes if going back loses something (as 1.3.0 did)');
  }

  const suggested = kind ? bump(last, kind).join('.') : null;
  console.log(`\nSuggested version: ${suggested ? `${suggested} (${kind})` : `none — nothing to release since ${lastTag}`}`);

  if (wanted) {
    const v = wanted.join('.');
    console.log(`\nVersion ${v}:`);
    const next = ['major', 'minor', 'patch'].map((k) => bump(last, k).join('.'));
    const wantedKind = ['major', 'minor', 'patch'][next.indexOf(v)];
    if (compare(wanted, last) <= 0) fail(`${v} isn't newer than ${lastTag}`);
    else if (!wantedKind) warn(`${v} skips versions — the next ones after ${lastTag} are ${next.join(', ')}`);
    else ok(`a ${wantedKind} release after ${lastTag}`);
    if (wantedKind && kind && RANK[wantedKind] < RANK[kind]) {
      warn(`the commits call for a ${kind} release (SemVer), ${v} is a ${wantedKind} one`);
    }
    if (wantedKind === 'major') warn('a major version is only for a breaking change — the owner decides');

    const tag = `v${v}`;
    if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], true)) fail(`tag ${tag} already exists here`);
    const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], true);
    if (remote === null) fail(`git ls-remote failed — can't tell whether ${tag} is on GitHub`);
    else if (remote) fail(`tag ${tag} is already on GitHub — never reuse a pushed tag, take the next version`);
    else ok(`tag ${tag} is free`);

    const lock = readJson('package-lock.json');
    if (pkg.version === v) ok(`package.json is at ${v}`);
    else if (pkg.version === last.join('.')) info(`package.json is still at ${pkg.version} → npm version ${v} --no-git-tag-version`);
    else fail(`package.json is at ${pkg.version}, neither ${last.join('.')} nor ${v}`);
    if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
      fail("package-lock.json's version differs from package.json — bump with npm version, which writes both");
    }
  }

  console.log('\nRelease configuration:');
  const pub = pkg.build.publish;
  if (pub.provider === 'github' && pub.releaseType === 'draft') ok(`publish: GitHub ${REPO}, draft`);
  else fail('build.publish is no longer the GitHub provider with releaseType "draft" (D14, D45)');
  const renamed = Object.entries(ARTIFACT_NAMES).filter(([k, name]) => pkg.build[k]?.artifactName !== name);
  if (pkg.name !== 'claude-usage') renamed.push(['name', 'claude-usage']);
  if (renamed.length) {
    warn(`release file names changed (${renamed.map(([k]) => k).join(', ')}) — check D46 (no spaces), ASSETS in site.mjs, README → Releasing a new version and this script`);
  } else {
    ok('release file names as in D46');
  }
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  if (workflow.includes('release/latest*.yml')) ok('release.yml uploads latest*.yml');
  else fail("release.yml no longer uploads release/latest*.yml — installed copies wouldn't find the update (D45)");
  if (workflow.includes('--draft')) ok('release.yml creates a draft');
  else fail('release.yml no longer creates a draft — the owner publishes by hand');
  const appId = /const APP_ID = '([^']+)'/.exec(readFileSync(join(root, 'src/main/main.ts'), 'utf8'))?.[1];
  if (appId === pkg.build.appId) ok(`APP_ID = build.appId (${appId})`);
  else fail(`APP_ID in main.ts (${appId}) ≠ build.appId (${pkg.build.appId}) — see CLAUDE.md → Gotchas`);

  const ls = spawnSync('npm', ['ls', '--depth=0'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (ls.status === 0) ok('node_modules match package.json');
  else warn('npm ls reports problems — run npm ci before testing');

  console.log('\nDocs that wait for a version:');
  const docs = ['docs/PROGRESS.md', 'docs/BACKLOG.md', ...readdirSync(join(root, 'docs/phases')).map((f) => `docs/phases/${f}`)];
  const pending = [];
  for (const file of docs.filter((f) => f.endsWith('.md'))) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/not released yet|the next release/i.test(line)) pending.push(`${file}:${i + 1}  ${clip(line.trim(), 80)}`);
      });
  }
  if (pending.length) info(`name the version here:\n${indent(pending.join('\n'))}`);
  else info('none marked "not released yet"');
}

// ── ci ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function ci(v) {
  const tag = `v${v}`;
  const started = Date.now();
  for (;;) {
    try {
      const { workflow_runs: runs = [] } = await api(
        `/repos/${REPO}/actions/workflows/release.yml/runs?event=push&branch=${tag}&per_page=1`,
      );
      const run = runs[0];
      if (!run) {
        console.log(`${clock()}  no release run for ${tag} yet`);
        if (!wait || Date.now() - started > 5 * 60_000) process.exit(wait ? 1 : 2);
      } else {
        console.log(`${clock()}  ${run.status}${run.conclusion ? ` → ${run.conclusion}` : ''}  ${run.html_url}`);
        if (run.status === 'completed' || !wait) {
          const { jobs = [] } = await api(`/repos/${REPO}/actions/runs/${run.id}/jobs`);
          for (const j of jobs) console.log(`          ${(j.conclusion ?? j.status).padEnd(12)} ${j.name}`);
          if (run.status !== 'completed') process.exit(2);
          if (run.conclusion !== 'success') {
            console.log(
              '\nA failed job can be re-run on GitHub (run page → Re-run failed jobs; its log needs a sign-in). ' +
                'A real failure is fixed on main and released as the next version — the pushed tag is never moved.',
            );
          }
          process.exit(run.conclusion === 'success' ? 0 : 1);
        }
      }
    } catch (err) {
      if (!wait || !err.reset) throw err;
      console.log(`${clock()}  ${err.message}; waiting`);
      await sleep(Math.max(err.reset - Date.now(), 0) + 5_000);
      continue;
    }
    if (Date.now() - started > 60 * 60_000) {
      console.log('Still running after 60 minutes — check the Actions tab.');
      process.exit(2);
    }
    await sleep(90_000);
  }
}

// ── post ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function post(v) {
  const tag = `v${v}`;
  console.log(`Published release ${tag}\n`);
  const release = await api(`/repos/${REPO}/releases/latest`);
  if (release.tag_name !== tag) {
    fail(`releases/latest is ${release.tag_name} — ${tag} isn't published yet, is a pre-release, or isn't marked Latest`);
    return;
  }
  ok(`${tag} is releases/latest ("${release.name}", ${release.published_at})`);
  if (release.prerelease) fail('it is a pre-release — installed copies ignore it (D45)');

  const assets = new Map(release.assets.map((a) => [a.name, a]));
  const expected = [...installers(v), ...UPDATE_FILES];
  const missing = expected.filter((n) => !assets.has(n));
  if (missing.length) fail(`missing files: ${missing.join(', ')}`);
  else ok(`all ${expected.length} files attached`);
  const other = [...assets.keys()].filter((n) => !expected.includes(n));
  if (other.length) info(`other files: ${other.join(', ')}`);

  for (const name of UPDATE_FILES) {
    const asset = assets.get(name);
    if (!asset) continue;
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'claude-usage-release-check' } });
    if (!res.ok) {
      fail(`${name}: download failed (HTTP ${res.status})`);
      continue;
    }
    const update = parseUpdateInfo(await res.text());
    const problems = [];
    if (update.version !== v) problems.push(`says version ${update.version}`);
    if (!update.files.length) problems.push('lists no files');
    for (const f of update.files) {
      const target = assets.get(f.url);
      if (!target) problems.push(`points at ${f.url}, which isn't attached (a 404 for installed copies, D46)`);
      else if (f.size !== undefined && f.size !== target.size) problems.push(`${f.url}: size ${f.size} ≠ attached ${target.size} (replaced file? D46)`);
      if (!f.sha512) problems.push(`${f.url}: no sha512`);
    }
    if (problems.length) fail(`${name}: ${problems.join('; ')}`);
    else ok(`${name}: ${v} → ${update.files.map((f) => f.url).join(', ')}`);
  }

  const site = await fetch(SITE_URL, { headers: { 'User-Agent': 'claude-usage-release-check' }, cache: 'no-store' });
  const html = site.ok ? await site.text() : '';
  if (html.includes(`/releases/download/${tag}/`)) ok(`the website links to ${tag}`);
  else warn(`the website doesn't link to ${tag} yet (${SITE_URL}) — the Website workflow rebuilds it a few minutes after publishing; check again later`);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), 'utf8'));
}

/** Runs git; returns trimmed stdout, or null on failure when `allowFail` (throws otherwise). */
function git(args, allowFail = false) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim();
  if (allowFail) return null;
  throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
}

function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s ?? '');
  return m ? m.slice(1).map(Number) : null;
}

function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function bump([major, minor, patch], kind) {
  if (kind === 'major') return [major + 1, 0, 0];
  if (kind === 'minor') return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

/** The parts of electron-updater's latest*.yml this check needs: version and files (url, size, sha512). */
function parseUpdateInfo(text) {
  const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const out = { version: null, files: [] };
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^version:\s*(.+)$/.exec(line))) out.version = unquote(m[1]);
    else if ((m = /^\s+-\s+url:\s*(.+)$/.exec(line))) out.files.push({ url: unquote(m[1]) });
    else if ((m = /^\s+size:\s*(\d+)\s*$/.exec(line)) && out.files.length) out.files.at(-1).size = Number(m[1]);
    else if ((m = /^\s+sha512:\s*(\S+)/.exec(line)) && out.files.length) out.files.at(-1).sha512 = m[1];
  }
  return out;
}

/** GitHub REST API GET; a rate-limit error carries `reset` (ms). */
async function api(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'claude-usage-release-check',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const err = new Error(`GitHub API rate limit reached (60 an hour without a token), resets at ${new Date(reset).toLocaleTimeString()}`);
    err.reset = reset;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clock() {
  return new Date().toTimeString().slice(0, 8);
}
