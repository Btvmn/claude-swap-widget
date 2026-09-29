'use strict';
// Draws the app icon (build/icon.png, 1024×1024) with no dependencies: a
// dark rounded square with two usage rings, outer 7d in blue, inner 5h in
// amber. electron-builder turns it into the .icns. Run: npm run icon

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 3; // supersampling per axis
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

// Apple's icon grid: the body is 824 px inside the 1024 canvas.
const BODY = 824;
const INSET = (SIZE - BODY) / 2;
const RADIUS = BODY * 0.225;

const TOP = [38, 44, 60];
const BOTTOM = [16, 19, 27];
const TRACK = [255, 255, 255, 0.13];
const RINGS = [
  { r: 300, w: 64, frac: 0.72, rgb: [111, 155, 255] }, // 7d
  { r: 196, w: 64, frac: 0.38, rgb: [245, 165, 36] }, // 5h
];

function insideBody(x, y) {
  const lo = INSET + RADIUS;
  const hi = SIZE - INSET - RADIUS;
  const cx = Math.min(Math.max(x, lo), hi);
  const cy = Math.min(Math.max(y, lo), hi);
  if (x < INSET || x > SIZE - INSET || y < INSET || y > SIZE - INSET) return false;
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

// Colour of one sample, or null outside the icon body.
function sample(x, y) {
  if (!insideBody(x, y)) return null;
  const t = (y - INSET) / BODY;
  let c = TOP.map((v, i) => v + (BOTTOM[i] - v) * t);
  const dx = x - SIZE / 2;
  const dy = y - SIZE / 2;
  const d = Math.hypot(dx, dy);
  let a = Math.atan2(dx, -dy) / (2 * Math.PI); // 0 at 12 o'clock, clockwise
  if (a < 0) a += 1;
  for (const ring of RINGS) {
    if (Math.abs(d - ring.r) > ring.w / 2) continue;
    // round caps at both ends of the arc
    const capAt = (turn) => {
      const ang = turn * 2 * Math.PI;
      return Math.hypot(dx - ring.r * Math.sin(ang), dy + ring.r * Math.cos(ang)) <= ring.w / 2;
    };
    const onArc = a <= ring.frac || capAt(0) || capAt(ring.frac);
    const [r, g, b, alpha] = onArc ? [...ring.rgb, 1] : TRACK;
    c = c.map((v, i) => v + ([r, g, b][i] - v) * alpha);
  }
  return c;
}

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const n = SS * SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          cover++;
        }
      }
      const i = (y * SIZE + x) * 4;
      if (cover) {
        px[i] = Math.round(r / cover);
        px[i + 1] = Math.round(g / cover);
        px[i + 2] = Math.round(b / cover);
      }
      px[i + 3] = Math.round((255 * cover) / n);
    }
  }
  return px;
}

// Minimal PNG writer: 8-bit RGBA, no filtering.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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

function png(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png(render(), SIZE, SIZE));
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
