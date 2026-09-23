// Draws the tray icon — a progress ring — straight into a PNG buffer, so the icon can show the
// live percentage without shipping image assets. Pure module (zlib only).
import { deflateSync } from 'node:zlib';
import type { Severity } from '../shared/types';

type Rgb = readonly [number, number, number];

/** Keep in sync with the --ok / --warn / --crit colors in renderer/styles.css. */
export const SEVERITY_RGB: Record<Severity, Rgb> = {
  normal: [69, 209, 158],
  warning: [245, 181, 68],
  critical: [242, 85, 90],
};
const TRACK_RGB: Rgb = [140, 140, 140];
const TRACK_ALPHA = 0.55;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes straight (non-premultiplied) RGBA pixels as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface RingOptions {
  /** 0–100, or null for "no data" (track only). */
  percent: number | null;
  severity: Severity;
  /** Draw the progress arc faded, for stale data. */
  dim?: boolean;
}

/** Renders an anti-aliased progress ring (clockwise from 12 o'clock) as RGBA pixels. */
export function renderRing(size: number, { percent, severity, dim = false }: RingOptions): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const center = size / 2;
  const outer = size / 2 - size * 0.05;
  const inner = outer - size * 0.22;
  const sweep = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100)) * Math.PI * 2;
  const arcRgb = SEVERITY_RGB[severity];
  const arcAlpha = dim ? 0.5 : 1;
  const samples = 4; // supersampling per axis

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let arc = 0;
      let track = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + (sx + 0.5) / samples - center;
          const dy = y + (sy + 0.5) / samples - center;
          const r = Math.hypot(dx, dy);
          if (r < inner || r > outer) continue;
          let angle = Math.atan2(dx, -dy);
          if (angle < 0) angle += Math.PI * 2;
          if (angle <= sweep) arc++;
          else track++;
        }
      }
      const n = samples * samples;
      const a1 = (arc / n) * arcAlpha;
      const a2 = (track / n) * TRACK_ALPHA;
      const alpha = a1 + a2;
      if (alpha === 0) continue;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round((arcRgb[c]! * a1 + TRACK_RGB[c]! * a2) / alpha);
      out[i + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return out;
}

export function ringPng(size: number, options: RingOptions): Buffer {
  return encodePng(size, size, renderRing(size, options));
}
