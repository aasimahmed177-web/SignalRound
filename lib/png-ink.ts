// Whether a PNG leaves a visible mark on a white tile. The logo route draws every tile on white, and
// some logos are white or empty there: a white wordmark for a dark header, a favicon that is a white
// square (braendz.com's). The browser used to find these with a canvas probe per logo, which cost a
// CORS error for every host that sends no CORS headers; this reads the pixels once, on the server.
// A small decoder over node:zlib: 8-bit truecolour and grey (with or without alpha), and palette or
// grey at 1, 2, 4, or 8 bits. Anything else (16-bit, interlaced) is "unknown", and the logo is kept.

import { inflateSync } from "node:zlib";

/** Composited on white, a pixel counts as ink when it is at least this dark: alpha times darkness. */
const INK = 0.12;
/** Under this share of inked pixels the tile reads as blank. */
const BLANK_SHARE = 0.01;

interface Header {
  width: number;
  height: number;
  depth: number;
  type: number;
  interlace: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The raw scanlines, unfiltered: one Uint8Array per row, `stride` bytes each. */
function unfilter(data: Uint8Array, h: Header, stride: number, bpp: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0, at = 0; y < h.height; y++) {
    const filter = data[at++];
    const row = data.slice(at, at + stride);
    at += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) row[x] = (row[x] + a) & 255;
      else if (filter === 2) row[x] = (row[x] + b) & 255;
      else if (filter === 3) row[x] = (row[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(a, b, c)) & 255;
    }
    rows.push(row);
    prev = row;
  }
  return rows;
}

/**
 * True when the PNG would leave no visible mark on white (fully transparent, all white, or white on
 * transparent); false when it shows; null when this decoder cannot read it, so the caller keeps it.
 */
export function pngLeavesNoMark(bytes: Uint8Array): boolean | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47) return null;
    let header: Header | null = null;
    let palette: Uint8Array | null = null;
    let alphas: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    for (let at = 8; at + 8 <= bytes.length; ) {
      const len = view.getUint32(at);
      const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
      const body = bytes.subarray(at + 8, at + 8 + len);
      if (type === "IHDR") {
        const b = new DataView(body.buffer, body.byteOffset, body.byteLength);
        header = { width: b.getUint32(0), height: b.getUint32(4), depth: body[8], type: body[9], interlace: body[12] };
      } else if (type === "PLTE") palette = body;
      else if (type === "tRNS") alphas = body;
      else if (type === "IDAT") idat.push(body);
      else if (type === "IEND") break;
      at += 12 + len;
    }
    if (!header || header.interlace !== 0 || !(header.type in CHANNELS)) return null;
    const { width, height, depth, type } = header;
    const channels = CHANNELS[type];
    const sub = depth < 8;
    if (depth === 16 || (sub && type !== 0 && type !== 3) || width * height > 4_000_000) return null;
    const data = inflateSync(Buffer.concat(idat));
    const stride = Math.ceil((width * channels * depth) / 8);
    const rows = unfilter(new Uint8Array(data), header, stride, Math.max(1, (channels * depth) >> 3));

    // Sample at most a 64 x 64 grid; a logo's ink is never thinner than that at tile size.
    const step = Math.max(1, Math.floor(Math.max(width, height) / 64));
    let seen = 0;
    let ink = 0;
    for (let y = 0; y < height; y += step) {
      const row = rows[y];
      for (let x = 0; x < width; x += step) {
        let r: number;
        let g: number;
        let b: number;
        let a = 255;
        if (sub) {
          const bit = x * depth;
          const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
          if (type === 3) {
            if (!palette) return null;
            [r, g, b] = [palette[v * 3], palette[v * 3 + 1], palette[v * 3 + 2]];
            a = alphas && v < alphas.length ? alphas[v] : 255;
          } else {
            r = g = b = Math.round((v * 255) / ((1 << depth) - 1));
          }
        } else if (type === 3) {
          const v = row[x];
          if (!palette) return null;
          [r, g, b] = [palette[v * 3], palette[v * 3 + 1], palette[v * 3 + 2]];
          a = alphas && v < alphas.length ? alphas[v] : 255;
        } else {
          const i = x * channels;
          if (type === 0 || type === 4) r = g = b = row[i];
          else [r, g, b] = [row[i], row[i + 1], row[i + 2]];
          if (type === 4) a = row[i + 1];
          if (type === 6) a = row[i + 3];
        }
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if ((a / 255) * (1 - luminance) > INK) ink++;
        seen++;
      }
    }
    return seen > 0 && ink < seen * BLANK_SHARE;
  } catch {
    return null;
  }
}
