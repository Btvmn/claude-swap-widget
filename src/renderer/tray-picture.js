// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:2693-2886).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// The menu-bar picture for the canvas styles (ring, bars, rings, ringsText),
// painted on an off-DOM canvas at 2x (36 px = 18 pt) and handed to main as a
// PNG. Main decides everything (src/tray-model.js): which values, which is
// hot, doubtful, busy, the menu-bar appearance. This file only paints.
//
// Below the warn threshold the picture is a template image (black, dimmed
// parts by alpha) that macOS tints like its own icons. From the threshold on,
// the value that crossed it is drawn in colour for the menu-bar appearance
// and everything else in plain white or black.
//
// Protocol: main sends tray:draw {seq, style, dark, warn, danger, five, seven,
// doubtful, busy}; every message is answered with tray:image (seq, dataUrl,
// template), even when the PNG did not change, because main treats a missing
// answer as "renderer gone" and falls back to the classic ring after 1 s.
// Dormant while window.api has no onTrayDraw.
(function () {
  'use strict';

  const STYLES = Object.freeze(['ring', 'bars', 'rings', 'ringsText']);
  const HEIGHT = 36; // px at 2x: 18 pt
  const MAX_WIDTH = 160; // px at 2x: main refuses anything wider than 80 pt
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
  const BIG_FONT = `500 26px ${FONT}`;
  const SMALL_FONT = `600 18px ${FONT}`;
  const ACCENTS = Object.freeze({
    dark: Object.freeze({ warn: '#ffb340', danger: '#ff6259' }),
    light: Object.freeze({ warn: '#c26a00', danger: '#d70015' }),
  });
  const DASH = '–'; // a window without a current value (rolled over, or none)
  const MARK = '?'; // doubtful numbers, the same sign as the classic title
  const BUSY_ALPHA = 0.45;
  // Spacing of the 'ring' style. The tight set is used only when the normal
  // one would pass MAX_WIDTH (three digits on both sides plus the "?").
  const SPACING = Object.freeze({
    normal: { lead: 38, gap: 6, markGap: 2, pad: 2 },
    tight: { lead: 35, gap: 3, markGap: 1, pad: 1 },
  });

  let painter = null; // one canvas, never attached to the page
  let attached = false;

  function finite(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function trayLevel(value, { warn = 75, danger = 90 } = {}) {
    if (!finite(value)) return null;
    return value >= danger ? 'danger' : value >= warn ? 'warn' : null;
  }

  // Widest digit of the current font: every digit is drawn centred in a cell
  // this wide, which gives tabular figures.
  function digitCell(ctx) {
    let widest = 0;
    for (const d of '0123456789') widest = Math.max(widest, ctx.measureText(d).width);
    return widest;
  }

  // Baseline that puts the ink of `text` centred on centreY.
  function centredBaseline(ctx, text, centreY) {
    const m = ctx.measureText(text);
    return centreY + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  }

  function digitBaseline(ctx, centreY) {
    return centredBaseline(ctx, '0', centreY);
  }

  // The dash sits on the digits' middle, not on their baseline, so it gets
  // its own baseline; its cell is still the digit cell.
  function drawDigits(ctx, text, x, centreY, cell) {
    const baseline = digitBaseline(ctx, centreY);
    for (const ch of text) {
      const w = ctx.measureText(ch).width;
      ctx.fillText(ch, x + (cell - w) / 2, ch === DASH ? centredBaseline(ctx, DASH, centreY) : baseline);
      x += cell;
    }
    return x;
  }

  // share: 0…1, or null for a track without a value.
  function trayRing(ctx, cx, cy, r, lineWidth, share, colour, ink, comet) {
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colour;
    const top = -Math.PI / 2;
    if (comet !== undefined) {
      // Busy: a short comet, its tail in fading segments
      const length = 0.3;
      const parts = 6;
      for (let i = 0; i < parts; i++) {
        const from = comet - length + (length * i) / parts;
        const to = from + (length / parts) * (i === parts - 1 ? 1 : 0.8);
        ctx.globalAlpha = 0.14 + 0.86 * ((i + 1) / parts);
        ctx.lineCap = i === parts - 1 ? 'round' : 'butt';
        ctx.beginPath();
        ctx.arc(cx, cy, r, top + Math.PI * 2 * from, top + Math.PI * 2 * to);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (!(share > 0)) return;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, top, top + Math.PI * 2 * Math.min(share, 1));
    ctx.stroke();
  }

  function trayBar(ctx, x, cy, length, share, colour, ink, segment) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.roundRect(x, cy - 3, length, 6, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colour;
    let from = 0;
    let to = share;
    if (segment) [from, to] = segment; // busy: a short bright piece of the track
    else if (!(share > 0)) return;
    const w = Math.max(6, length * (to - from));
    ctx.beginPath();
    ctx.roundRect(x + length * from, cy - 3, Math.min(w, length - length * from), 6, 3);
    ctx.fill();
  }

  // o: { style, session, week (0…100 or null), sessionLevel, weekLevel
  //      ('warn' | 'danger' | null), refreshing, doubtful, template, ink, accents }
  // Returns the canvas width in px.
  function drawTrayPicture(canvas, o) {
    const ctx = canvas.getContext('2d');
    const style = STYLES.includes(o.style) ? o.style : 'ring';
    const value = (v) => (finite(v) ? Math.round(Math.min(Math.max(v, 0), 100)) : null);
    const session = value(o.session);
    const week = value(o.week);
    const colourOf = (level) => (o.template || !level ? o.ink : o.accents[level]);
    const sColour = colourOf(o.sessionLevel);
    const wColour = colourOf(o.weekLevel);
    const sText = session === null ? DASH : String(session);
    const wText = week === null ? DASH : String(week);
    const share = (v) => (v === null ? null : v / 100);
    const numbersAlpha = o.refreshing ? BUSY_ALPHA : 1;
    // 'rings' has no digits; its "?" is the native title (tray-model pictureTitle).
    const mark = Boolean(o.doubtful) && style !== 'rings';

    // Measure first: setting the canvas size resets the context
    ctx.font = BIG_FONT;
    const bigCell = digitCell(ctx);
    const dotWidth = ctx.measureText('·').width;
    const markWidth = ctx.measureText(MARK).width;
    ctx.font = SMALL_FONT;
    const smallCell = digitCell(ctx);
    const stackWidth = Math.max(sText.length, wText.length) * smallCell;
    const stackX = style === 'bars' ? 41 : 39;
    const stackMarkX = stackX + stackWidth + 4;
    const ringWidth = (s) =>
      s.lead + (sText.length + wText.length) * bigCell + s.gap * 2 + dotWidth + (mark ? s.markGap + markWidth : 0) + s.pad;
    let space = SPACING.normal;
    let width;
    if (style === 'rings') width = 32;
    else if (style !== 'ring') width = (mark ? stackMarkX + markWidth : stackX + stackWidth) + 2;
    else {
      width = ringWidth(space);
      if (width > MAX_WIDTH) {
        space = SPACING.tight;
        width = ringWidth(space);
      }
    }
    canvas.width = Math.min(MAX_WIDTH, Math.ceil(width / 2) * 2);
    canvas.height = HEIGHT;
    // Squeeze what still does not fit rather than be refused: only the
    // widest case ("100 · 100?") needs it, by about 1.5 % in SF.
    if (width > MAX_WIDTH) ctx.setTransform(MAX_WIDTH / width, 0, 0, 1, 0, 0);

    const stacked = () => {
      ctx.font = SMALL_FONT;
      ctx.globalAlpha = numbersAlpha;
      ctx.fillStyle = sColour;
      drawDigits(ctx, sText, stackX, 10.5, smallCell);
      ctx.fillStyle = wColour;
      drawDigits(ctx, wText, stackX, 26.5, smallCell);
      if (mark) {
        // One big "?" beside both lines: the doubt covers both numbers
        ctx.font = BIG_FONT;
        ctx.fillStyle = o.ink;
        ctx.fillText(MARK, stackMarkX, centredBaseline(ctx, MARK, 18));
      }
      ctx.globalAlpha = 1;
    };

    if (style === 'bars') {
      trayBar(ctx, 2, 10.5, 34, share(session), sColour, o.ink, o.refreshing ? [0.22, 0.5] : null);
      trayBar(ctx, 2, 26.5, 34, share(week), wColour, o.ink, o.refreshing ? [0.52, 0.8] : null);
      stacked();
    } else if (style === 'rings' || style === 'ringsText') {
      trayRing(ctx, 16, 18, 13, 3.4, share(session), sColour, o.ink, o.refreshing ? 0.36 : undefined);
      trayRing(ctx, 16, 18, 6.6, 3.4, share(week), wColour, o.ink, o.refreshing ? 0.86 : undefined);
      if (style === 'ringsText') stacked();
    } else {
      trayRing(ctx, 15, 18, 11.5, 3.6, share(session), sColour, o.ink, o.refreshing ? 0.36 : undefined);
      ctx.font = BIG_FONT;
      const baseline = digitBaseline(ctx, 18);
      ctx.globalAlpha = numbersAlpha;
      ctx.fillStyle = sColour;
      let x = drawDigits(ctx, sText, space.lead, 18, bigCell) + space.gap;
      ctx.globalAlpha = 0.5 * numbersAlpha;
      ctx.fillStyle = o.ink;
      ctx.fillText('·', x, baseline);
      x += dotWidth + space.gap;
      ctx.globalAlpha = numbersAlpha;
      ctx.fillStyle = wColour;
      x = drawDigits(ctx, wText, x, 18, bigCell);
      if (mark) {
        ctx.fillStyle = o.ink;
        ctx.fillText(MARK, x + space.markGap, baseline);
      }
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas.width;
  }

  // tray:draw message → painter options. `hot` comes decided from main; the
  // thresholds are only a fallback for a message without it.
  function optionsFor(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    const limits = { warn: finite(m.warn) ? m.warn : 75, danger: finite(m.danger) ? m.danger : 90 };
    const read = (w) => {
      const pct = w && finite(w.pct) ? w.pct : null;
      let hot = null;
      if (w && (w.hot === 'warn' || w.hot === 'danger')) hot = w.hot;
      else if (w && w.hot === undefined) hot = trayLevel(pct, limits);
      return { pct, hot };
    };
    const five = read(m.five);
    const seven = read(m.seven);
    const template = !five.hot && !seven.hot;
    const dark = m.dark === true;
    return {
      style: STYLES.includes(m.style) ? m.style : 'ring',
      session: five.pct,
      week: seven.pct,
      sessionLevel: five.hot,
      weekLevel: seven.hot,
      refreshing: m.busy === true,
      doubtful: m.doubtful === true,
      template,
      ink: template || !dark ? '#000000' : '#ffffff',
      accents: ACCENTS[dark ? 'dark' : 'light'],
    };
  }

  // Paints a tray:draw message. toDataURL is synchronous and needs no
  // painted frame, so it works in the hidden popover (PLAN R1).
  function render(msg, canvas) {
    const o = optionsFor(msg);
    const target = canvas || (painter = painter || document.createElement('canvas'));
    const width = drawTrayPicture(target, o);
    return { dataUrl: target.toDataURL('image/png'), template: o.template, width };
  }

  function attach(ipc) {
    if (attached) return true;
    if (!ipc || typeof ipc.onTrayDraw !== 'function' || typeof ipc.sendTrayImage !== 'function') return false;
    attached = true;
    ipc.onTrayDraw((msg) => {
      if (!msg || typeof msg !== 'object' || !Number.isSafeInteger(msg.seq) || !STYLES.includes(msg.style)) return;
      let out;
      try {
        out = render(msg);
      } catch (e) {
        console.error('tray picture:', e); // no answer: main keeps the classic ring
        return;
      }
      ipc.sendTrayImage(msg.seq, out.dataUrl, out.template);
    });
    return true;
  }

  window.TrayPicture = Object.freeze({
    STYLES,
    HEIGHT,
    MAX_WIDTH,
    ACCENTS,
    trayLevel,
    optionsFor,
    draw: drawTrayPicture,
    render,
    attach,
  });
  attach(window.api);
})();
