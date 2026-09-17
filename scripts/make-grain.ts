/**
 * make-grain.ts
 *
 * Generates assets/grain.png — the 128x128 tileable paper grain used by
 * PaperGrain. Deterministic and idempotent: run `npm run build:grain` to
 * regenerate byte-identical output (checked in, like data/foods.json).
 *
 * The tile is sparse ink speckles on a fully transparent field, so the layer
 * only darkens where a speck sits: at 5% opacity the paper shifts by ~1 RGB
 * unit overall while the grain stays visible. Per-pixel noise has no structure
 * to align at the tile edges, which is what makes the repeat seamless.
 */
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as path from 'node:path';

const SIZE = 128;
/** Ink colour of the speckles (matches colors.text). */
const INK = [0x1a, 0x2e, 0x22] as const;
const OUT = path.join(__dirname, '..', 'assets', 'grain.png');

/** Seeded PRNG (mulberry32) — a fixed seed is what makes the asset reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Raw RGBA scanlines, sparsely populated with ink speckles. */
function grainPixels(): Buffer {
  const rand = mulberry32(0x5eed0a17);
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // PNG filter: none
    for (let x = 0; x < SIZE; x++) {
      const roll = rand();
      // Mostly fine grain, a little heavier weight to break up the regularity.
      const alpha = roll < 0.22 ? 90 + Math.floor(rand() * 100) : roll < 0.26 ? 200 + Math.floor(rand() * 56) : 0;
      const p = rowStart + 1 + x * 4;
      raw[p] = INK[0];
      raw[p + 1] = INK[1];
      raw[p + 2] = INK[2];
      raw[p + 3] = alpha;
    }
  }
  return raw;
}

function png(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(grainPixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const bytes = png();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bytes);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${SIZE}x${SIZE}, ${bytes.length} bytes)`);
