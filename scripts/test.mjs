// Bundles every src/**/*.test.ts file with esbuild and runs them with Node's built-in test runner.
// Tests must only exercise pure modules (no `electron` import at runtime).
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, '.test-dist');

const entryPoints = readdirSync(join(root, 'src'), { recursive: true })
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(root, 'src', f));

if (entryPoints.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints,
  outdir,
  outbase: join(root, 'src'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  external: ['electron'],
  logLevel: 'warning',
});

const files = entryPoints.map((f) => join(outdir, relative(join(root, 'src'), f)).replace(/\.ts$/, '.js'));
const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
