'use strict';
// What the menu-bar picture should show, worked out from the service state.
// Pure, so it is unit-tested without Electron. Main owns every decision here;
// the renderer (src/renderer/tray-picture.js) only paints the result:
//
//   state ──trayModel──▶ model ──drawMessage──▶ tray:draw ──▶ painter
//                                                  tray:image ◀──┘
//
// kind 'picture': the active account's 5h and 7d values for a canvas style.
// kind 'classic': nothing to paint (setup screens, loading, no active
// account); main draws src/tray-icon.js and trayInfo()'s title as today.

const { effectiveUsage, resetPassed, WARN, CRIT } = require('./shared/usage');

// Styles the renderer paints. 'classic' is drawn by main alone.
const PICTURE_STYLES = Object.freeze(['ring', 'bars', 'rings', 'ringsText']);

const CLASSIC = Object.freeze({ kind: 'classic', five: null, seven: null, doubtful: false, busy: false });

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Level of a percentage: amber from `warn`, red from `danger`.
function hotLevel(pct, warn, danger) {
  if (!finite(pct)) return null;
  if (pct >= danger) return 'danger';
  if (pct >= warn) return 'warn';
  return null;
}

// One window as the picture shows it: a whole number 0…100, or null when
// cswap gave none or the window has rolled over since it was measured (the
// old pct no longer applies until the next refresh). The colour follows the
// number shown: 74.9 reads "75", so it is amber, and 89.9 reads "90", red.
function windowValue(w, now, warn, danger) {
  const p = w && w.pct;
  if (!finite(p) || resetPassed(w, now)) return { pct: null, hot: null };
  const pct = Math.round(Math.min(Math.max(p, 0), 100));
  return { pct, hot: hotLevel(pct, warn, danger) };
}

// state: the service state (src/service.js). busy: a deliberate refresh is
// out (Refresh Now, the popover's refresh button); a switch in flight counts
// too. The timer and refresh-on-open never set it.
function trayModel(state, now = Date.now(), { busy = false, warn = WARN, danger = CRIT } = {}) {
  if (!state || state.phase !== 'ok') return { ...CLASSIC, reason: (state && state.phase) || 'loading' };
  const active = (state.accounts || []).find((a) => a && a.active);
  if (!active) return { ...CLASSIC, reason: 'no-active' };
  const { usage, stale } = effectiveUsage(active);
  return {
    kind: 'picture',
    five: windowValue(usage && usage.fiveHour, now, warn, danger),
    seven: windowValue(usage && usage.sevenDay, now, warn, danger),
    // Same meaning as the classic title's "?": the last refresh failed (the
    // list is older than it looks), or only last-good data is left.
    doubtful: Boolean(state.error) || stale,
    busy: Boolean(busy) || Boolean(state.switching),
  };
}

// Equal signatures draw the same picture; main redraws only on a change
// (or a change of style / menu-bar appearance, which it tracks itself).
function modelSignature(model) {
  if (!model || model.kind !== 'picture') return 'classic';
  const v = (w) => (w ? `${w.pct === null ? '-' : w.pct}${w.hot ? `/${w.hot}` : ''}` : '-');
  return `picture|${v(model.five)}|${v(model.seven)}|${model.doubtful ? 1 : 0}|${model.busy ? 1 : 0}`;
}

// The tray:draw payload (PLAN §4.2). The thresholds travel along so the
// painter never reads a global; `hot` is already decided here.
function drawMessage(model, { seq, style, dark, warn = WARN, danger = CRIT }) {
  return {
    seq,
    style: PICTURE_STYLES.includes(style) ? style : 'ring',
    dark: Boolean(dark),
    warn,
    danger,
    five: model.five,
    seven: model.seven,
    doubtful: Boolean(model.doubtful),
    busy: Boolean(model.busy),
  };
}

// The native title next to a canvas picture: the account name when
// showName is on, and for 'rings' (a picture without digits) the "?" that the
// other styles paint themselves.
function pictureTitle(model, style, name = '') {
  const mark = style === 'rings' && model && model.kind === 'picture' && model.doubtful ? '?' : '';
  return [name, mark].filter(Boolean).join(' ');
}

module.exports = { PICTURE_STYLES, trayModel, hotLevel, modelSignature, drawMessage, pictureTitle };
