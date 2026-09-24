// Renders the app icon — a dark rounded square with two progress rings (mint session ring, coral
// brand ring) — to build/icon.png. electron-builder turns that PNG into .ico / .icns / Linux icons,
// and scripts/build.mjs copies it to dist/ for the Linux window icon and the About dialog.
// Usage: node scripts/make-icon.mjs [outFile] [size]   (default: build/icon.png, 1024)
// The PNG is committed; re-run only when the design changes.
import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(process.argv[2] ?? join(root, 'build/icon.png'));
const size = Number(process.argv[3] ?? 1024);

// Reuse the PNG encoder from the tray icon (TypeScript, so bundle it on the fly).
const bundle = await esbuild.build({
  entryPoints: [join(root, 'src/main/tray-icon.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'warning',
});
const { encodePng } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Colors — same palette as renderer/styles.css (--card-*, --ok*, --brand*).
const BG_TOP = [52, 48, 45];
const BG_BOTTOM = [22, 21, 21];
const BRAND = [217, 119, 87];
const BRAND_HI = [240, 164, 136];
const OK = [69, 209, 158];
const OK_HI = [139, 240, 200];
const WHITE = [255, 255, 255];

// Geometry in units of the icon size (0–1), centered at 0.5 / 0.5.
const RECT_INSET = 0.05;
const RECT_RADIUS = 0.2;
const RINGS = [
  { mid: 0.285, width: 0.105, sweep: 0.72, from: OK, to: OK_HI, trackAlpha: 0.1 },
  { mid: 0.16, width: 0.085, sweep: 0.45, from: BRAND, to: BRAND_HI, trackAlpha: 0.08 },
];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Signed distance to the rounded square (negative inside). */
function rectDistance(x, y) {
  const half = 0.5 - RECT_INSET;
  const qx = Math.abs(x - 0.5) - (half - RECT_RADIUS);
  const qy = Math.abs(y - 0.5) - (half - RECT_RADIUS);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RECT_RADIUS;
}

/** Position along an arc with round caps: 0–1 inside the arc, null outside. Clockwise from 12 o'clock. */
function arcPosition(x, y, { mid, width, sweep }) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const r = Math.hypot(dx, dy);
  const halfWidth = width / 2;
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += Math.PI * 2;
  const end = sweep * Math.PI * 2;
  if (Math.abs(r - mid) <= halfWidth && angle <= end) return angle / end;
  if (Math.hypot(dx, dy + mid) <= halfWidth) return 0;
  if (Math.hypot(dx - mid * Math.sin(end), dy + mid * Math.cos(end)) <= halfWidth) return 1;
  return null;
}

/** Straight RGBA of one sample point, or null when outside the icon. */
function sample(x, y) {
  const d = rectDistance(x, y);
  if (d > 0) return null;

  let rgb = mix(BG_TOP, BG_BOTTOM, clamp01((y - RECT_INSET) / (1 - 2 * RECT_INSET)));
  // Soft brand glow in the top-left corner, like the overlay card.
  const glow = clamp01(1 - Math.hypot(x - 0.22, y - 0.18) / 0.62);
  rgb = mix(rgb, BRAND, 0.3 * glow * glow);
  // Faint glass edge.
  if (d > -0.008) rgb = mix(rgb, WHITE, 0.09);

  for (const ring of RINGS) {
    const dx = x - 0.5;
    const dy = y - 0.5;
    if (Math.abs(Math.hypot(dx, dy) - ring.mid) <= ring.width / 2) rgb = mix(rgb, WHITE, ring.trackAlpha);
    const t = arcPosition(x, y, ring);
    if (t !== null) rgb = mix(ring.from, ring.to, t);
  }
  return rgb;
}

function render(px) {
  const out = new Uint8Array(px * px * 4);
  const n = 4; // supersampling per axis
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const acc = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const rgb = sample((x + (sx + 0.5) / n) / px, (y + (sy + 0.5) / n) / px);
          if (!rgb) continue;
          covered++;
          for (let c = 0; c < 3; c++) acc[c] += rgb[c];
        }
      }
      if (covered === 0) continue;
      const i = (y * px + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(acc[c] / covered);
      out[i + 3] = Math.round((covered / (n * n)) * 255);
    }
  }
  return out;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, encodePng(size, size, render(size)));
console.log(`Icon written to ${outFile} (${size}×${size})`);
