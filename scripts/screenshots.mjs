// Builds the app, then renders every mock scenario (expanded + compact) to PNG files, plus a few
// variants (light theme, 150 % size) when no scenarios are named.
// Usage: npm run screenshot -- [outDir] [scenario ...]
// Default outDir: ./screenshots (git-ignored). Use it to review UI changes without clicking around.
// `--readme` (npm run screenshot:readme) instead re-renders the README images in docs/images.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALL = [
  'normal',
  'warning',
  'critical',
  'expired',
  'no-credentials',
  'rate-limited',
  'offline',
  'loading',
  'via-desktop',
  'desktop-unavailable',
  'forecast',
  'locked',
  'other-account',
  'update-ready',
];

/** Extra renders: file-name suffix → scenario + flags. */
const VARIANTS = [
  { name: 'forecast-light', scenario: 'forecast', flags: ['--theme=light'] },
  { name: 'critical-light', scenario: 'critical', flags: ['--theme=light'] },
  { name: 'expired-light', scenario: 'expired', flags: ['--theme=light'] },
  { name: 'normal-150', scenario: 'normal', flags: ['--scale=1.5'] },
  { name: 'forecast-90', scenario: 'forecast', flags: ['--scale=0.9'] },
];

/**
 * The images README.md shows (`--readme`). Re-render them whenever a change alters what they show
 * (CLAUDE.md → Finish); rename or add one here and in README.md together. README.md sizes them at
 * the overlay's CSS width (PNG width ÷ display scale, e.g. 390 px at 125 % → width="312").
 */
const README_IMAGES = [
  { file: 'overlay-expanded.png', scenario: 'forecast', view: 'expanded', flags: [] },
  { file: 'overlay-stale.png', scenario: 'expired', view: 'expanded', flags: [] },
  { file: 'overlay-compact.png', scenario: 'normal', view: 'compact', flags: [] },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let outDir;
let shots;
if (args[0] === '--readme') {
  outDir = join(root, 'docs/images');
  shots = README_IMAGES.map((shot) => ({ ...shot, label: shot.file, file: join(outDir, shot.file) }));
} else {
  const [outArg, ...scenarioArgs] = args;
  outDir = resolve(outArg ?? join(root, 'screenshots'));
  const runs = (scenarioArgs.length > 0 ? scenarioArgs : ALL).map((scenario) => ({ name: scenario, scenario, flags: [] }));
  if (scenarioArgs.length === 0) runs.push(...VARIANTS);
  shots = runs.flatMap(({ name, scenario, flags }) =>
    ['expanded', 'compact'].map((view) => ({
      scenario,
      view,
      flags,
      label: `${name}/${view}`,
      file: join(outDir, `${name}-${view}.png`),
    })),
  );
}

const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(outDir, { recursive: true });
const electronPath = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/** Modification time of `file`, or 0 when it doesn't exist. */
const mtime = (file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;

for (const { scenario, view, flags, label, file } of shots) {
  const before = mtime(file);
  const run = spawnSync(electronPath, [root, `--mock=${scenario}`, `--${view}`, ...flags, `--screenshot=${file}`], {
    stdio: 'inherit',
    env,
    timeout: 30_000,
  });
  if (run.status !== 0) {
    console.error(`✗ ${label} failed (exit ${run.status})`);
    process.exitCode = 1;
  } else if (mtime(file) === before) {
    // Mock runs share one userData folder and so one single-instance lock: a second one quits at once.
    console.error(`✗ ${label}: no image written (is another mock or screenshot run open?)`);
    process.exitCode = 1;
  }
}
console.log(`Screenshots in ${outDir}`);
