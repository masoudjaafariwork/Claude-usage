// Renders the GitHub social preview — the 1280×640 image link cards show when the repository is
// shared — to docs/images/social-preview.png: name, tagline and features next to real renders of
// the overlay (mock data, dark theme). GitHub has no API for it: upload the PNG by hand in the
// repository's Settings → General → Social preview. Re-render and re-upload when the card changes.
// Usage: npm run social-preview [-- outFile]
// The file runs twice: under Node it renders the overlay shots and then starts Electron on itself,
// which lays the page out in an offscreen window and saves the capture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WIDTH = 1280;
const HEIGHT = 640;
/** GitHub rejects larger uploads. */
const MAX_BYTES = 1024 * 1024;
/** Overlay size setting for the renders (one of the Size menu steps). */
const OVERLAY_SCALE = 1.15;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// No top-level await on the Electron side: Electron emits 'ready' only after its entry module has run.
if (process.versions.electron) void compose(process.argv.at(-2), process.argv.at(-1));
else await main();

async function main() {
  const outFile = resolve(process.argv[2] ?? join(root, 'docs/images/social-preview.png'));
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const electronPath = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const work = mkdtempSync(join(tmpdir(), 'claude-usage-social-'));
  try {
    // Scale factor 1: the PNGs are CSS pixels × OVERLAY_SCALE on any display, so the page shows them 1:1.
    const shots = [
      { file: 'card.png', args: ['--mock=forecast', '--expanded'] },
      { file: 'pill.png', args: ['--mock=forecast', '--compact'] },
    ];
    for (const { file, args } of shots) {
      const target = join(work, file);
      spawnSync(
        electronPath,
        [root, ...args, '--theme=dark', `--scale=${OVERLAY_SCALE}`, '--force-device-scale-factor=1', `--screenshot=${target}`],
        { stdio: 'inherit', env, timeout: 30_000 },
      );
      if (!statSync(target, { throwIfNoEntry: false })) {
        // Mock runs share one userData folder and so one single-instance lock: a second one quits at once.
        console.error(`✗ ${file}: no image written (is another mock or screenshot run open?)`);
        process.exit(1);
      }
    }

    mkdirSync(dirname(outFile), { recursive: true });
    const composer = [fileURLToPath(import.meta.url), '--force-device-scale-factor=1', work, outFile];
    const run = spawnSync(electronPath, composer, { stdio: 'inherit', env, timeout: 30_000 });
    if (run.status !== 0) process.exit(run.status ?? 1);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const bytes = statSync(outFile).size;
  console.log(`Social preview saved to ${outFile} (${Math.round(bytes / 1024)} KB)`);
  if (bytes > MAX_BYTES) {
    console.error('✗ Larger than 1 MB: GitHub will not accept it.');
    process.exitCode = 1;
  }
}

/** Electron side: lays out the page with the shots in `work` and saves a WIDTH×HEIGHT PNG. */
async function compose(work, outFile) {
  const { app, BrowserWindow } = await import('electron');
  app.setPath('userData', join(work, 'electron'));
  await app.whenReady();

  const page = join(work, 'social-preview.html');
  writeFileSync(page, html(work));
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadFile(page);
    await win.webContents.executeJavaScript(
      'Promise.all([...document.images].map((img) => img.decode())).then(() => document.fonts.ready).then(() => true)',
    );
    await new Promise((r) => setTimeout(r, 300)); // let the offscreen frame paint
    let image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    if (width !== WIDTH || height !== HEIGHT) image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
    writeFileSync(outFile, image.toPNG());
  } catch (err) {
    console.error('Social preview failed:', err);
    app.exit(1);
    return;
  }
  app.exit(0);
}

function html(work) {
  const url = (file) => pathToFileURL(file).href;
  const features = [
    ['ok', 'Session, weekly and per-model limits with reset countdowns'],
    ['warn', 'Pace forecast and alerts at 75 / 90 / 100 %'],
    ['brand', 'Compact pill, tray ring, several Claude Code accounts'],
    ['muted', 'Reads Claude Code’s sign-in — read-only, no telemetry'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'">
<style>
  /* Palette of renderer/styles.css (dark theme). */
  :root {
    --text: #f4f0eb;
    --soft: #d6cfc8;
    --muted: #a39d97;
    --faint: #6f6a65;
    --brand: #d97757;
    --brand-hi: #f0a488;
    --ok: #45d19e;
    --warn: #f5b544;
    --font: 'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, Ubuntu,
      Cantarell, 'Noto Sans', system-ui, sans-serif;
    --display: 'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter,
      Ubuntu, Cantarell, 'Noto Sans', system-ui, sans-serif;
  }
  html, body { margin: 0; }
  body {
    position: relative;
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    overflow: hidden;
    font-family: var(--font);
    color: var(--text);
    background:
      radial-gradient(760px 520px at 6% 0%, rgba(217, 119, 87, 0.3), transparent 70%),
      radial-gradient(620px 520px at 80% 52%, rgba(69, 209, 158, 0.1), transparent 70%),
      linear-gradient(160deg, #2b2826 0%, #171616 62%, #121111 100%);
  }
  .left {
    position: absolute;
    inset: 0 auto 0 84px;
    width: 640px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .brand { display: flex; align-items: center; gap: 22px; }
  .brand img { width: 84px; height: 84px; }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 66px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .tagline {
    margin: 26px 0 0;
    max-width: 600px;
    font-family: var(--display);
    font-size: 31px;
    line-height: 1.28;
    color: var(--soft);
  }
  .tagline b { color: var(--brand-hi); font-weight: 600; }
  ul { margin: 34px 0 0; padding: 0; list-style: none; }
  li {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 12px;
    font-size: 21px;
    color: var(--muted);
  }
  li::before {
    content: '';
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--dot);
  }
  .ok { --dot: var(--ok); }
  .warn { --dot: var(--warn); }
  .brand-dot { --dot: var(--brand); }
  .muted { --dot: var(--faint); }
  .footer { display: flex; align-items: center; gap: 10px; margin-top: 38px; }
  .chip {
    padding: 6px 15px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    font-size: 18px;
    font-weight: 600;
    color: var(--soft);
  }
  .oss { margin-left: 10px; font-size: 18px; color: var(--muted); }
  .right {
    position: absolute;
    inset: 0 0 0 770px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
  }
  .right img { display: block; filter: drop-shadow(0 22px 40px rgba(0, 0, 0, 0.55)); }
</style>
</head>
<body>
  <div class="left">
    <div class="brand">
      <img src="${url(join(root, 'build/icon.png'))}" alt="">
      <h1>Claude Usage</h1>
    </div>
    <p class="tagline">Your Claude plan limits at a glance — <b>always on top</b>, on any screen.</p>
    <ul>
      ${features.map(([tone, text]) => `<li class="${tone === 'brand' ? 'brand-dot' : tone}">${text}</li>`).join('\n      ')}
    </ul>
    <div class="footer">
      <span class="chip">Windows</span>
      <span class="chip">macOS</span>
      <span class="chip">Linux</span>
      <span class="oss">Free &amp; open source · MIT</span>
    </div>
  </div>
  <div class="right">
    <img src="${url(join(work, 'card.png'))}" alt="">
    <img src="${url(join(work, 'pill.png'))}" alt="">
  </div>
</body>
</html>
`;
}
