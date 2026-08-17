// Generates the app icon PNGs (solid green with a white calorie "flame" dot pattern).
// Pure Node: hand-rolled PNG encoder via zlib — no image dependencies.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Icon: green rounded square + white plate circle + green "serving" notch
function icon(size) {
  const r = Math.round(size * 0.22); // corner radius
  const cx = size / 2, cy = size / 2;
  const plateR = size * 0.30;
  return png(size, (x, y) => {
    // rounded-rect alpha
    const dx = Math.max(r - x, x - (size - 1 - r), 0);
    const dy = Math.max(r - y, y - (size - 1 - r), 0);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const alpha = dist > r ? 0 : 255;
    if (alpha === 0) return [0, 0, 0, 0];
    // white plate (circle) with green notch at bottom
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (d <= plateR) {
      const notch = y > cy + plateR * 0.2 && Math.abs(x - cx) < plateR * 0.28 && d > plateR * 0.45;
      return notch ? [22, 163, 74, 255] : [255, 255, 255, 255];
    }
    return [22, 163, 74, 255]; // #16a34a
  });
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const jobs = [
  ['icon.png', 1024, icon],
  ['adaptive-icon.png', 1024, (s) => icon(s)], // same motif; Android masks it
  ['splash-icon.png', 512, (s) => icon(s)],
  ['icon-192.png', 192, (s) => icon(s)],
  ['icon-512.png', 512, (s) => icon(s)],
  ['favicon.png', 48, (s) => icon(s)],
];
for (const [name, size, fn] of jobs) {
  fs.writeFileSync(path.join(outDir, name), png(size, fn));
  console.log('wrote', name);
}
