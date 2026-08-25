#!/usr/bin/env node
// Generates the Chalk action icons (16/32/48/128) as PNGs.
// Pure Node — no dependencies. Renders a supersampled SDF scene:
// a dark rounded-square "board" with a tapered white chalk swoosh.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- scene ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function roundedRectSDF(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Chalk swoosh: quadratic bezier sampled to a polyline (unit coords).
function buildSwoosh(W) {
  const p0 = [0.23 * W, 0.77 * W];
  const c = [0.44 * W, 0.68 * W];
  const p1 = [0.78 * W, 0.25 * W];
  const pts = [];
  const N = 72;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0];
    const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1];
    pts.push([x, y, t]);
  }
  return pts;
}

// Distance to polyline; also returns curve parameter t of nearest point (for taper).
function strokeDist(x, y, pts) {
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay, at] = pts[i];
    const [bx, by, bt] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const h = clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
    const d = Math.hypot(x - (ax + dx * h), y - (ay + dy * h));
    if (d < best) { best = d; bestT = at + (bt - at) * h; }
  }
  return [best, bestT];
}

function render(size) {
  const S = 4; // supersample
  const W = size * S;
  const big = new Float64Array(W * W * 4);
  const pad = Math.max(1, 0.02 * W);
  const half = W / 2 - pad;
  const radius = 0.235 * W;
  const swoosh = buildSwoosh(W);
  const aa = 1.0;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dBoard = roundedRectSDF(px, py, W / 2, W / 2, half, half, radius);
      const coverage = 1 - smoothstep(-aa, aa, dBoard);
      const i = (y * W + x) * 4;
      if (coverage <= 0) continue;

      // board: soft vertical gradient, faint top-left sheen
      const t = py / W;
      let r = lerp(0x2b, 0x17, t);
      let g = lerp(0x2b, 0x17, t);
      let b = lerp(0x33, 0x1c, t);
      const sheen = Math.exp(-(((px - 0.3 * W) ** 2 + (py - 0.18 * W) ** 2) / (0.16 * W * W)));
      r += 10 * sheen; g += 10 * sheen; b += 13 * sheen;

      // inner hairline border
      const edge = 1 - smoothstep(1.2 * S * 0.35, 2.6 * S * 0.35, Math.abs(dBoard));
      r = lerp(r, 0x4a, edge * 0.5);
      g = lerp(g, 0x4a, edge * 0.5);
      b = lerp(b, 0x55, edge * 0.5);

      // chalk swoosh with taper (thin tail -> full body)
      const [sd, st] = strokeDist(px, py, swoosh);
      const hwStroke = 0.062 * W * (0.45 + 0.75 * st);
      const ink = 1 - smoothstep(hwStroke - aa, hwStroke + aa, sd);
      if (ink > 0) {
        // faint chalk dust halo
        const halo = (1 - smoothstep(hwStroke, hwStroke * 2.2, sd)) * 0.10;
        r = lerp(r, 0xfa, Math.min(1, ink + halo));
        g = lerp(g, 0xfa, Math.min(1, ink + halo));
        b = lerp(b, 0xf6, Math.min(1, ink + halo));
      } else {
        const halo = (1 - smoothstep(hwStroke, hwStroke * 2.2, sd)) * 0.10;
        r = lerp(r, 0xfa, halo);
        g = lerp(g, 0xfa, halo);
        b = lerp(b, 0xf6, halo);
      }

      big[i] = r * coverage;
      big[i + 1] = g * coverage;
      big[i + 2] = b * coverage;
      big[i + 3] = 255 * coverage;
    }
  }

  // box-filter downsample (premultiplied, then un-premultiply)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          r += big[i]; g += big[i + 1]; b += big[i + 2]; a += big[i + 3];
        }
      }
      const n = S * S;
      const alpha = a / n;
      const o = (y * size + x) * 4;
      if (alpha > 0) {
        out[o] = clamp(Math.round((r / n) / (alpha / 255), 0, 255), 0, 255);
        out[o + 1] = clamp(Math.round((g / n) / (alpha / 255)), 0, 255);
        out[o + 2] = clamp(Math.round((b / n) / (alpha / 255)), 0, 255);
      }
      out[o + 3] = clamp(Math.round(alpha), 0, 255);
    }
  }
  return encodePNG(size, size, out);
}

for (const size of [16, 32, 48, 128]) {
  const png = render(size);
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
