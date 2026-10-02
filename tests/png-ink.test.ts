import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { pngLeavesNoMark } from "../lib/png-ink";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit RGBA PNG, `size` square, each pixel from `pixel(x, y)`, every row with filter 0. */
function rgba(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (1 + size * 4) + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("pngLeavesNoMark", () => {
  test("white, transparent, and white-on-transparent leave no mark", () => {
    expect(pngLeavesNoMark(rgba(32, () => [255, 255, 255, 255]))).toBe(true);
    expect(pngLeavesNoMark(rgba(32, () => [0, 0, 0, 0]))).toBe(true);
    expect(pngLeavesNoMark(rgba(32, (x) => (x < 16 ? [255, 255, 255, 255] : [0, 0, 0, 0])))).toBe(true);
  });
  test("a dark mark on white shows, even a small one", () => {
    expect(pngLeavesNoMark(rgba(32, (x, y) => (x > 12 && x < 20 && y > 12 && y < 20 ? [20, 20, 20, 255] : [255, 255, 255, 255])))).toBe(
      false,
    );
    expect(pngLeavesNoMark(rgba(32, () => [250, 93, 25, 255]))).toBe(false);
  });
  test("what it cannot read is unknown, never blank", () => {
    expect(pngLeavesNoMark(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
