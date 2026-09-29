'use strict';
// The menu-bar icon: a small progress ring drawn straight into a BGRA bitmap,
// so there are no image assets and it can show the active account's 5h usage.
// Below the amber threshold it is a macOS template image (black + alpha, the
// system tints it for light/dark menu bars); at amber/red it keeps its colour.

const SIZE_PT = 18;
const TRACK_ALPHA = 0.3;
const SUPERSAMPLE = 4;

const COLORS = {
  warn: [245, 165, 36], // amber
  crit: [240, 68, 56], // red
};

// Returns a premultiplied BGRA buffer of px × px.
function ringBitmap(px, pct, rgb = [0, 0, 0]) {
  const buf = Buffer.alloc(px * px * 4);
  const c = px / 2;
  const outer = px * 0.42;
  const inner = px * 0.27;
  const frac = typeof pct === 'number' && Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0;
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let fill = 0;
      let track = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const dx = x + (sx + 0.5) / SUPERSAMPLE - c;
          const dy = y + (sy + 0.5) / SUPERSAMPLE - c;
          const r = Math.hypot(dx, dy);
          if (r < inner || r > outer) continue;
          // 0 at 12 o'clock, growing clockwise.
          let a = Math.atan2(dx, -dy) / (2 * Math.PI);
          if (a < 0) a += 1;
          if (a < frac) fill++;
          else track++;
        }
      }
      const alpha = (fill + track * TRACK_ALPHA) / n;
      const i = (y * px + x) * 4;
      buf[i] = Math.round(rgb[2] * alpha);
      buf[i + 1] = Math.round(rgb[1] * alpha);
      buf[i + 2] = Math.round(rgb[0] * alpha);
      buf[i + 3] = Math.round(255 * alpha);
    }
  }
  return buf;
}

// Electron-dependent part, kept separate so ringBitmap stays testable in plain Node.
function trayImage(nativeImage, pct, level) {
  const rgb = COLORS[level] || [0, 0, 0];
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const px = SIZE_PT * scaleFactor;
    image.addRepresentation({ scaleFactor, width: px, height: px, buffer: ringBitmap(px, pct, rgb) });
  }
  image.setTemplateImage(!COLORS[level]);
  return image;
}

module.exports = { ringBitmap, trayImage, SIZE_PT };
