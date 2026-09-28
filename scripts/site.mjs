// Builds the project website (GitHub Pages, Phase 9) from site/ into _site/ (git-ignored).
// Usage:
//   npm run site:build            → _site/ (what .github/workflows/pages.yml deploys)
//   npm run site                  → build, serve at http://localhost:4173/Claude-usage/, rebuild on changes in site/
//   npm run site:images           → re-render site/images: overlay renders (mock data, 2× pixel density) and icons
//   npm run site:shot [-- outDir] → build and capture the page at 1280 / 1024 / 390 px, dark and light (./screenshots)
//
// Templates: in site/*.html, *.xml and *.txt every {{name}} is replaced — the latest published release (version,
// date, and per file: url / name / size), the site URL and the build date. {{dims:images/x.png}} becomes that PNG's
// width="…" height="…" in CSS pixels (every image in site/images is rendered at 2× density). An unknown name fails.
// The release comes from the GitHub API (GITHUB_TOKEN when set, as in CI). Without it a local build links to the
// Releases page instead; in CI that is an error, so a broken page is never deployed.
//
// With --shot the file runs twice: under Node it builds and serves the site, then starts Electron on itself, which
// loads the page in an offscreen window and saves the captures.
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'masoudjaafariwork/Claude-usage';
const SITE_URL = 'https://masoudjaafariwork.github.io/Claude-usage/';
/** Where GitHub Pages serves the site; the local server uses the same path, so root-relative links (404.html) work. */
const BASE_PATH = new URL(SITE_URL).pathname;
const PORT = 4173;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'site');
const outDir = join(root, '_site');

/** Release files the page links to: key → file name pattern (D46 names). */
const ASSETS = {
  winSetup: /^Claude-Usage-Setup-.+\.exe$/,
  winPortable: /^Claude-Usage-.+-Portable\.exe$/,
  macArm: /^Claude-Usage-.+-arm64\.dmg$/,
  macIntel: /^Claude-Usage-.+-x64\.dmg$/,
  appImage: /^claude-usage-.+-x86_64\.AppImage$/,
  deb: /^claude-usage_.+_amd64\.deb$/,
};

/** File names as the release workflow makes them — only for a local build without the release data. */
const FALLBACK_NAMES = {
  winSetup: (v) => `Claude-Usage-Setup-${v}.exe`,
  winPortable: (v) => `Claude-Usage-${v}-Portable.exe`,
  macArm: (v) => `Claude-Usage-${v}-arm64.dmg`,
  macIntel: (v) => `Claude-Usage-${v}-x64.dmg`,
  appImage: (v) => `claude-usage-${v}-x86_64.AppImage`,
  deb: (v) => `claude-usage_${v}_amd64.deb`,
};

/**
 * Overlay images the page shows (`--images`): mock scenario + view + look → site/images/<file>. Rendered at 2×
 * density; the page shows them at half their pixel size ({{dims:…}}). Re-render when a change alters what they show
 * (CLAUDE.md → Finish). A scenario with several windows also writes <name>-2.png ….
 */
const SITE_IMAGES = [
  { file: 'hero-card-dark.png', scenario: 'forecast', view: 'expanded', theme: 'dark', scale: 1.15 },
  { file: 'hero-card-light.png', scenario: 'forecast', view: 'expanded', theme: 'light', scale: 1.15 },
  { file: 'hero-pill-dark.png', scenario: 'forecast', view: 'compact', theme: 'dark', scale: 1.15 },
  { file: 'hero-pill-light.png', scenario: 'forecast', view: 'compact', theme: 'light', scale: 1.15 },
  { file: 'card-normal.png', scenario: 'normal', view: 'expanded', theme: 'dark' },
  { file: 'card-warning.png', scenario: 'warning', view: 'expanded', theme: 'dark' },
  { file: 'card-critical.png', scenario: 'critical', view: 'expanded', theme: 'dark' },
  { file: 'card-normal-light.png', scenario: 'normal', view: 'expanded', theme: 'light' },
  { file: 'card-expired.png', scenario: 'expired', view: 'expanded', theme: 'dark' },
  { file: 'card-renewing.png', scenario: 'renewing', view: 'expanded', theme: 'dark' },
  { file: 'card-first-run.png', scenario: 'first-run', view: 'expanded', theme: 'dark' },
  { file: 'card-via-desktop.png', scenario: 'via-desktop', view: 'expanded', theme: 'dark' },
  { file: 'pill-normal.png', scenario: 'normal', view: 'compact', theme: 'dark' },
  { file: 'pill-several.png', scenario: 'several-accounts', view: 'compact', theme: 'dark' },
  { file: 'pill-locked.png', scenario: 'locked', view: 'compact', theme: 'dark' },
];

/** App icon sizes (scripts/make-icon.mjs): favicon, touch icon, and 2× logos for the page. */
const ICONS = [
  { file: 'favicon-32.png', size: 32 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'logo-64.png', size: 64 },
];

/** Page captures (`--shot`): CSS width × colour scheme. */
const SHOTS = [
  { width: 1280, theme: 'dark' },
  { width: 1280, theme: 'light' },
  { width: 1024, theme: 'dark' },
  { width: 390, theme: 'dark' },
  { width: 390, theme: 'light' },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};
const TEMPLATED = new Set(['.html', '.xml', '.txt']);

// No top-level await on the Electron side: Electron emits 'ready' only after its entry module has run.
if (process.versions.electron) {
  capture(...process.argv.slice(-3)).catch(async (err) => {
    console.error('Capture failed:', err);
    (await import('electron')).app.exit(1);
  });
} else {
  await main(process.argv.slice(2));
}

async function main(args) {
  const mode = args[0]?.startsWith('--') ? args[0] : '--build';
  if (!['--build', '--serve', '--images', '--shot'].includes(mode)) throw new Error(`Unknown option ${mode}`);
  if (mode === '--images') return renderImages();

  const values = await templateValues();
  build(values);
  if (mode === '--serve') return serve(values);
  if (mode === '--shot') return shoot(resolve(args[1] ?? join(root, 'screenshots')));
}

// ---------------------------------------------------------------------------------------------------------------
// Build

/** Everything {{name}} can stand for. */
async function templateValues() {
  const { version: pkgVersion } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const release = await latestRelease();
  const values = {
    siteUrl: SITE_URL,
    basePath: BASE_PATH,
    repoUrl: `https://github.com/${REPO}`,
    buildDate: new Date().toISOString().slice(0, 10),
    year: String(new Date().getUTCFullYear()),
  };
  if (release) {
    const date = new Date(release.published_at);
    Object.assign(values, {
      version: release.tag_name.replace(/^v/, ''),
      releaseUrl: release.html_url,
      releaseDate: date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
      releaseDateISO: date.toISOString().slice(0, 10),
    });
  } else {
    Object.assign(values, {
      version: pkgVersion,
      releaseUrl: `https://github.com/${REPO}/releases/latest`,
      releaseDate: 'unknown date (local build without release data)',
      releaseDateISO: values.buildDate,
    });
  }
  for (const [key, pattern] of Object.entries(ASSETS)) {
    const asset = release?.assets.find((a) => pattern.test(a.name));
    if (release && !asset) console.warn(`! ${release.tag_name} has no file for ${key}; linking to the release page`);
    values[`${key}.url`] = asset?.browser_download_url ?? values.releaseUrl;
    values[`${key}.name`] = asset?.name ?? FALLBACK_NAMES[key](values.version);
    values[`${key}.size`] = asset ? formatSize(asset.size) : '';
  }
  return values;
}

/**
 * The latest published (non-draft, non-pre-release) release, or null when it can't be read outside CI. Three tries:
 * a single failed request ("fetch failed") happened in practice.
 */
async function latestRelease() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-usage-site-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const read = async () => {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { final: res.status < 500 });
    return res.json();
  };
  try {
    let release;
    for (let attempt = 1; !release; attempt++) {
      try {
        release = await read();
      } catch (err) {
        if (attempt === 3 || err.final) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    console.log(`Release data: ${release.tag_name} (${release.assets.length} files)`);
    return release;
  } catch (err) {
    if (process.env.CI) {
      console.error(`✗ Couldn't read the latest release: ${err.message}`);
      process.exit(1);
    }
    console.warn(`! Couldn't read the latest release (${err.message}); download links go to the Releases page`);
    return null;
  }
}

/** Bytes → "107 MB" (binary megabytes, as file managers show them). */
function formatSize(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** site/ → _site/ with templates filled in, plus the social preview image (docs/images, D58). */
function build(values) {
  rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const file of listFiles(srcDir)) {
    const target = join(outDir, relative(srcDir, file));
    mkdirSync(dirname(target), { recursive: true });
    if (TEMPLATED.has(extname(file))) writeFileSync(target, fill(readFileSync(file, 'utf8'), values, file));
    else copyFileSync(file, target);
  }
  mkdirSync(join(outDir, 'images'), { recursive: true });
  copyFileSync(join(root, 'docs/images/social-preview.png'), join(outDir, 'images/social-preview.png'));
  console.log(`Site built in ${relative(root, outDir)}${sep}`);
}

function fill(text, values, file) {
  return text.replace(/\{\{\s*([\w.:/-]+)\s*\}\}/g, (_, name) => {
    if (name.startsWith('dims:')) {
      const { width, height } = pngSize(join(srcDir, name.slice('dims:'.length)));
      return `width="${width / 2}" height="${height / 2}"`;
    }
    if (!(name in values)) throw new Error(`${relative(root, file)}: unknown template value {{${name}}}`);
    return escapeHtml(values[name]);
  });
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  if (head.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`${relative(root, file)} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Local preview

/** Serves _site/ like GitHub Pages does (404.html for unknown paths); rebuilds when site/ changes. */
function serve(values, port = PORT) {
  const server = startServer(port);
  server.on('listening', () => {
    console.log(`Serving the site at http://localhost:${server.address().port}${BASE_PATH} — Ctrl+C to stop`);
    let timer;
    watch(srcDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          build(values);
        } catch (err) {
          console.error(`✗ ${err.message}`);
        }
      }, 150);
    });
  });
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    serve(values, port + 1);
  });
}

function startServer(port) {
  const server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (path === '/' || path === BASE_PATH.slice(0, -1)) {
      res.writeHead(302, { Location: BASE_PATH });
      return res.end();
    }
    let file = path.startsWith(BASE_PATH) ? resolve(outDir, `./${path.slice(BASE_PATH.length)}`) : '';
    const inside = file === outDir || file.startsWith(outDir + sep);
    if (inside && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    const found = inside && existsSync(file);
    if (!found) console.warn(`404 ${path}`);
    if (!found) file = join(outDir, '404.html');
    res.writeHead(found ? 200 : 404, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// ---------------------------------------------------------------------------------------------------------------
// Images (overlay renders + icons)

function renderImages() {
  const bundle = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  if (bundle.status !== 0) process.exit(bundle.status ?? 1);

  const imagesDir = join(srcDir, 'images');
  mkdirSync(imagesDir, { recursive: true });
  const electronPath = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  for (const { file, scenario, view, theme, scale = 1 } of SITE_IMAGES) {
    const target = join(imagesDir, file);
    rmSync(target, { force: true });
    const args = [root, `--mock=${scenario}`, `--${view}`, `--theme=${theme}`, `--scale=${scale}`];
    args.push('--force-device-scale-factor=2', `--screenshot=${target}`);
    const run = spawnSync(electronPath, args, { stdio: 'inherit', env, timeout: 30_000 });
    if (run.status !== 0 || !existsSync(target)) {
      // Mock runs share one userData folder and so one single-instance lock: a second one quits at once.
      console.error(`✗ ${file}: no image written (is another mock or screenshot run open?)`);
      process.exitCode = 1;
    }
  }
  for (const { file, size } of ICONS) {
    const run = spawnSync(process.execPath, [join(root, 'scripts/make-icon.mjs'), join(imagesDir, file), String(size)], {
      stdio: 'inherit',
    });
    if (run.status !== 0) process.exitCode = 1;
  }
  console.log(`Site images in ${relative(root, imagesDir)}${sep}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Page captures

function shoot(shotDir) {
  const server = startServer(0);
  server.on('listening', () => {
    mkdirSync(shotDir, { recursive: true });
    const electronPath = createRequire(import.meta.url)('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const work = mkdtempSync(join(tmpdir(), 'claude-usage-site-'));
    // The port, not the URL: Electron quits at once when an http:// address is on its command line.
    const args = [fileURLToPath(import.meta.url), '--force-device-scale-factor=1', String(server.address().port), shotDir, work];
    // Asynchronous: this process has to keep serving the page while Electron loads it.
    const started = Date.now();
    const child = spawn(electronPath, args, { stdio: 'inherit', env });
    child.on('exit', (code) => {
      server.close();
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // Also check the files: Electron's exit code alone wasn't reliable after a failed load.
      const stale = SHOTS.map(({ width, theme }) => join(shotDir, `site-${width}-${theme}.png`)).filter(
        (file) => (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < started,
      );
      for (const file of stale) console.error(`✗ ${relative(root, file)} wasn't written`);
      process.exitCode = code || (stale.length ? 1 : 0);
    });
  });
}

/** Electron side of --shot: loads the page per SHOTS entry, saves full-page PNGs, reports console errors. */
async function capture(port, shotDir, work) {
  const { app, BrowserWindow, nativeImage, nativeTheme, session } = await import('electron');
  const VIEW = 900;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  app.setPath('userData', work);
  await app.whenReady();

  let problems = 0;
  session.defaultSession.webRequest.onCompleted(({ url, statusCode }) => {
    if (statusCode >= 400) {
      problems++;
      console.error(`✗ ${statusCode} ${url}`);
    }
  });
  // One window for every shot: loading the page in a second offscreen window failed with ERR_FAILED.
  const win = new BrowserWindow({
    width: SHOTS[0].width,
    height: VIEW,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'warning' || level === 'error') {
      problems++;
      console.error(`✗ console ${level}: ${message}`);
    }
  });
  try {
    for (const [index, { width, theme }] of SHOTS.entries()) {
      nativeTheme.themeSource = theme;
      win.setContentSize(width, VIEW);
      await win.loadURL(`http://127.0.0.1:${port}${BASE_PATH}?shot=${index}`);
      // Lazy images off screen never load (their decode() never settles), so load them all first. The sticky top
      // bar goes static: the page is captured one window height at a time (one capture of the whole page fails
      // with UnknownVizError beyond the GPU's texture size) and the raw rows are joined.
      const height = await win.webContents.executeJavaScript(`
        for (const img of document.images) img.loading = 'eager';
        document.querySelector('.topbar').style.position = 'static';
        document.documentElement.style.scrollBehavior = 'auto';
        const loaded = Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
        Promise.race([loaded, new Promise((r) => setTimeout(r, 10000))])
          .then(() => document.fonts.ready)
          .then(() => document.documentElement.scrollHeight);
      `);
      const rows = [];
      let captured = 0;
      while (captured < height) {
        const top = Math.max(0, Math.min(captured, height - VIEW));
        await win.webContents.executeJavaScript(`window.scrollTo(0, ${top})`);
        await delay(250); // let the offscreen frame paint
        let slice = await win.webContents.capturePage();
        const size = slice.getSize();
        if (size.width !== width) throw new Error(`capture is ${size.width} px wide, expected ${width}`);
        const skip = captured - top; // rows the previous slice already has (last slice only)
        const take = Math.min(size.height - skip, height - captured);
        if (skip > 0 || take < size.height) slice = slice.crop({ x: 0, y: skip, width, height: take });
        rows.push(slice.toBitmap());
        captured += take;
      }
      const file = join(shotDir, `site-${width}-${theme}.png`);
      writeFileSync(file, nativeImage.createFromBitmap(Buffer.concat(rows), { width, height }).toPNG());
      console.log(`${relative(root, file)} (${width}×${height})`);
    }
  } catch (err) {
    console.error('Capture failed:', err);
    problems++;
  }
  app.exit(problems ? 1 : 0);
}
