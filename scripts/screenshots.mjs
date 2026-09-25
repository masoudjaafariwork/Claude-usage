// Builds the app, then renders every mock scenario (expanded + compact) to PNG files, plus a few
// variants (light theme, 150 % size) when no scenarios are named.
// Usage: npm run screenshot -- [outDir] [scenario ...]
// Default outDir: ./screenshots (git-ignored). Use it to review UI changes without clicking around.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
];

/** Extra renders: file-name suffix → scenario + flags. */
const VARIANTS = [
  { name: 'forecast-light', scenario: 'forecast', flags: ['--theme=light'] },
  { name: 'critical-light', scenario: 'critical', flags: ['--theme=light'] },
  { name: 'expired-light', scenario: 'expired', flags: ['--theme=light'] },
  { name: 'normal-150', scenario: 'normal', flags: ['--scale=1.5'] },
  { name: 'forecast-90', scenario: 'forecast', flags: ['--scale=0.9'] },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, ...scenarioArgs] = process.argv.slice(2);
const outDir = resolve(outArg ?? join(root, 'screenshots'));
const runs = (scenarioArgs.length > 0 ? scenarioArgs : ALL).map((scenario) => ({ name: scenario, scenario, flags: [] }));
if (scenarioArgs.length === 0) runs.push(...VARIANTS);

const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(outDir, { recursive: true });
const electronPath = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

for (const { name, scenario, flags } of runs) {
  for (const view of ['expanded', 'compact']) {
    const file = join(outDir, `${name}-${view}.png`);
    const run = spawnSync(electronPath, [root, `--mock=${scenario}`, `--${view}`, ...flags, `--screenshot=${file}`], {
      stdio: 'inherit',
      env,
      timeout: 30_000,
    });
    if (run.status !== 0) console.error(`✗ ${name}/${view} failed (exit ${run.status})`);
  }
}
console.log(`Screenshots in ${outDir}`);
