// Builds the app, then renders every mock scenario (expanded + compact) to PNG files.
// Usage: npm run screenshot -- [outDir] [scenario ...]
// Default outDir: ./screenshots (git-ignored). Use it to review UI changes without clicking around.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALL = ['normal', 'warning', 'critical', 'expired', 'no-credentials', 'rate-limited', 'offline', 'loading'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, ...scenarioArgs] = process.argv.slice(2);
const outDir = resolve(outArg ?? join(root, 'screenshots'));
const scenarios = scenarioArgs.length > 0 ? scenarioArgs : ALL;

const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(outDir, { recursive: true });
const electronPath = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

for (const scenario of scenarios) {
  for (const view of ['expanded', 'compact']) {
    const file = join(outDir, `${scenario}-${view}.png`);
    const run = spawnSync(electronPath, [root, `--mock=${scenario}`, `--${view}`, `--screenshot=${file}`], {
      stdio: 'inherit',
      env,
      timeout: 30_000,
    });
    if (run.status !== 0) console.error(`✗ ${scenario}/${view} failed (exit ${run.status})`);
  }
}
console.log(`Screenshots in ${outDir}`);
