'use strict';
// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, main.js:1233-1263,1814-1824).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// The menu-bar item (PLAN §4). A left click toggles the popover, a right
// click opens the same menu as the popover's "⋯".
//
// Main decides what it shows (src/tray-model.js). For the canvas styles
// (ring, bars, rings, ringsText) the popover's page paints the picture, also
// while it is hidden (src/renderer/tray-picture.js):
//
//   state ─▶ trayModel ─▶ tray:draw {seq, …} ─▶ page ─▶ tray:image (seq, dataUrl, template)
//
// Only the answer to the latest seq counts, and only after a strict check
// (PLAN §8 item 10). The classic ring (src/tray-icon.js, drawn here alone)
// with the titleMode title is the 'classic' style and also the fallback: for
// loading and setup screens, for no active account, and whenever the page
// cannot paint (still loading, reloading, crashed, or no valid answer within
// a second).

const { Tray, ipcMain, nativeImage, systemPreferences } = require('electron');
const { trayInfo, shortName } = require('../shared/usage');
const { trayImage } = require('../tray-icon');
const { PICTURE_STYLES, trayModel, modelSignature, drawMessage, pictureTitle } = require('../tray-model');

const ANSWER_MS = 1000; // no valid picture by then: the classic ring
// A manual refresh's busy frame ends when the service stops refreshing; this
// only caps it should that never be seen (cswap's own read cap is 120 s).
const BUSY_MAX_MS = 200_000;
// macOS writes AppleInterfaceStyle a moment after it posts the notification.
const APPEARANCE_DELAY_MS = 150;
const DATA_URL_PREFIX = 'data:image/png;base64,';
const MAX_DATA_URL = 100_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIGHT_PX = 36; // 18 pt at 2x
const MAX_WIDTH_PX = 160; // 80 pt at 2x

let ctx = null;
let tray = null;
let current = null; // what update() last worked out: { info, model, style, name }
let shown = null; // 'classic' | 'picture': what the item shows now
let classicKey = null; // the classic ring on show, as `${pct}|${level}`
let picture = null; // the last picture applied: { image, bytes, template }
let applied = null; // the NativeImage on the item now (CSW_CAPTURE saves it)
let seq = 0; // the last tray:draw sent
let waiting = 0; // the seq whose answer is due; 0 when none is
let askedSig = null; // what that frame shows (model, style, menu-bar appearance)
let answerTimer = null;
let pageReady = false;
let warned = false;
const busy = { on: false, sawRefresh: false, timer: null };
const watched = new WeakSet();

function attach(context) {
  ctx = context;
  tray = new Tray(trayImage(nativeImage, null, 'none'));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => ctx.toggleUi());
  tray.on('right-click', () => tray.popUpContextMenu(ctx.buildMenu()));
  ipcMain.on('tray:image', onImage);
  ctx.bus.on('refresh:manual', startBusy);
  if (process.platform === 'darwin') {
    systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
      setTimeout(() => update(), APPEARANCE_DELAY_MS);
    });
  }
  update(ctx.service.state);
}

function getTray() {
  return tray;
}

// When the active account's 5h or 7d window rolls over, what the menu bar
// shows (and what the notifier knows) is outdated at that moment, not at the
// next refresh: re-run everything that listens to the state then.
let resetTimer = null;
function scheduleReset(state, now) {
  clearTimeout(resetTimer);
  const active = state && state.phase === 'ok' ? (state.accounts || []).find((a) => a && a.active) : null;
  const usage = active && (active.usage || active.lastGoodUsage);
  const next = [usage && usage.fiveHour, usage && usage.sevenDay]
    .map((w) => (w && w.resetsAt ? Date.parse(w.resetsAt) : NaN))
    .filter((ms) => Number.isFinite(ms) && ms > now)
    .sort((a, b) => a - b)[0];
  if (!next) return;
  resetTimer = setTimeout(() => {
    if (!ctx.isQuitting()) ctx.service.emit('state', ctx.service.state);
  }, Math.min(next - now + 1000, 2 ** 31 - 1));
}

function update(state = ctx.service.state) {
  if (!tray || tray.isDestroyed()) return;
  scheduleReset(state, Date.now());
  watchPage();
  const settings = ctx.getSettings();
  const now = Date.now();
  trackBusy(state);
  const style = pictureStyle(settings);
  const ui = typeof ctx.getLanguage === 'function' ? ctx.getLanguage() : {};
  const info = trayInfo(
    state,
    now,
    { mode: settings.titleMode, showName: settings.showName, locale: ui.locale, hour12: ui.hour12, weeklyDateFormat: settings.weeklyDateFormat },
    ctx.t,
  );
  const model = style ? trayModel(state, now, { busy: busy.on }) : null;
  const active = model && model.kind === 'picture' ? (state.accounts || []).find((a) => a && a.active) : null;
  current = { info, model, style, name: settings.showName && active ? shortName(active, ctx.t) : '' };
  tray.setToolTip(tooltip(info, style));

  if (!model || model.kind !== 'picture' || !pageAlive()) return showClassic();
  const dark = isMenuBarDark();
  const sig = `${modelSignature(model)}|${style}|${dark ? 'dark' : 'light'}`;
  if (sig !== askedSig) askForPicture(model, style, dark, sig);
  else if (shown === 'picture') setTitle(pictureTitle(model, style, current.name));
}

// A canvas style, or null for 'classic' (the only style off macOS: template
// images are a macOS idea).
function pictureStyle(settings) {
  return process.platform === 'darwin' && PICTURE_STYLES.includes(settings.trayStyle) ? settings.trayStyle : null;
}

// Line 1 names the account and its doubts; the canvas styles add the reset
// times under it (PLAN §4.3). 'classic' keeps its one line.
function tooltip(info, style) {
  const lines = style && Array.isArray(info.tooltipLines) ? info.tooltipLines : [];
  return [info.tooltip, ...lines].join('\n');
}

// ── The picture from the page ────────────────────────────────────────────────

function askForPicture(model, style, dark, sig) {
  seq += 1;
  waiting = seq;
  askedSig = sig;
  clearTimeout(answerTimer);
  answerTimer = setTimeout(noAnswer, ANSWER_MS);
  ctx.send('tray:draw', drawMessage(model, { seq, style, dark }));
}

function noAnswer() {
  answerTimer = null;
  if (!waiting) return;
  note(`no menu-bar picture from the page within ${ANSWER_MS} ms; showing the classic ring`);
  showClassic();
}

// tray:image (seq, dataUrl, template). The page answers every tray:draw, also
// with a picture it sent before, so equal bytes do not touch the item.
function onImage(e, answerSeq, dataUrl, template) {
  if (!ctx.fromUi(e) || !waiting || answerSeq !== waiting) return; // a stranger, or a late answer
  if (!tray || tray.isDestroyed()) return;
  const pic = checkPicture(dataUrl, template);
  if (!pic) {
    note('refused a menu-bar picture from the page; showing the classic ring');
    showClassic();
    return;
  }
  clearTimeout(answerTimer);
  answerTimer = null;
  waiting = 0;
  warned = false;
  const same = shown === 'picture' && picture && picture.template === pic.template && picture.bytes.equals(pic.bytes);
  if (!same) {
    setImage(pic.image);
    picture = pic;
  }
  shown = 'picture';
  classicKey = null;
  setTitle(pictureTitle(current.model, current.style, current.name));
}

// PLAN §8 item 10, and the PNG header is read before anything is decoded:
// a 36 px high picture at most 160 px wide (18 × 80 pt at 2x), nothing else.
function checkPicture(dataUrl, template) {
  if (typeof template !== 'boolean') return null;
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL || !dataUrl.startsWith(DATA_URL_PREFIX)) return null;
  const b64 = dataUrl.slice(DATA_URL_PREFIX.length);
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  if (bytes.readUInt32BE(20) !== HEIGHT_PX || width < 1 || width > MAX_WIDTH_PX) return null;
  let image;
  try {
    image = nativeImage.createFromBuffer(bytes, { scaleFactor: 2 });
  } catch {
    return null;
  }
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.height !== HEIGHT_PX / 2 || size.width > MAX_WIDTH_PX / 2) return null;
  image.setTemplateImage(template);
  return { image, bytes, template };
}

// The page is there to paint: loaded, and not reloading or crashed. Its
// events are hooked the first time the window is seen (it is created after
// the tray).
function pageAlive() {
  const win = ctx.getWin();
  return Boolean(pageReady && win && !win.isDestroyed() && !win.webContents.isCrashed());
}

function watchPage() {
  const win = ctx.getWin();
  if (!win || win.isDestroyed() || watched.has(win.webContents)) return;
  const wc = win.webContents;
  watched.add(wc);
  pageReady = !wc.isLoading() && !wc.isCrashed() && Boolean(wc.getURL());
  // A new page has a new listener and paints nothing yet: ask it again.
  wc.on('did-finish-load', () => {
    pageReady = true;
    askedSig = null;
    update();
  });
  // A reload (after a crash, or Cmd+R in dev) or a dead renderer: the
  // classic ring right away, not after the answer timeout.
  for (const ev of ['did-start-loading', 'render-process-gone']) {
    wc.on(ev, () => {
      pageReady = false;
      update();
    });
  }
}

// ── What the item shows ──────────────────────────────────────────────────────

// The ring and title of trayInfo(), as the 'classic' style draws them. Any
// frame still due is dropped, and the next picture is asked for afresh.
function showClassic() {
  clearTimeout(answerTimer);
  answerTimer = null;
  waiting = 0;
  askedSig = null;
  if (!tray || tray.isDestroyed()) return; // quitting
  const { info } = current;
  const key = `${info.pct}|${info.level}`;
  if (shown !== 'classic' || classicKey !== key) {
    setImage(trayImage(nativeImage, info.pct, info.level));
    shown = 'classic';
    classicKey = key;
  }
  setTitle(info.title);
}

function setImage(image) {
  tray.setImage(image);
  applied = image;
}

function setTitle(title) {
  if (process.platform === 'darwin') tray.setTitle(title ? ` ${title}` : '', { fontType: 'monospacedDigit' });
}

// The menu bar's own appearance. Not nativeTheme: its themeSource follows
// the popover's Appearance setting, while the menu bar follows the system.
function isMenuBarDark() {
  if (process.platform !== 'darwin') return false;
  try {
    return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark';
  } catch {
    return false;
  }
}

// The busy frame of a deliberate refresh ('refresh:manual': Refresh Now or
// the page's refresh button, emitted before the refresh starts) lasts until
// the service has refreshed. The timer and refresh-on-open never set it; a
// switch in flight is busy by itself (tray-model).
function startBusy() {
  busy.on = true;
  busy.sawRefresh = false;
  clearTimeout(busy.timer);
  busy.timer = setTimeout(() => {
    busy.on = false;
    update();
  }, BUSY_MAX_MS);
  update();
}

function trackBusy(state) {
  if (!busy.on) return;
  if (state && state.refreshing) {
    busy.sawRefresh = true;
  } else if (busy.sawRefresh) {
    busy.on = false;
    clearTimeout(busy.timer);
  }
}

// Once until a picture comes through again, so a page that cannot paint
// does not fill the log every refresh.
function note(message) {
  if (warned) return;
  warned = true;
  console.warn(`tray: ${message}`);
}

// ── For CSW_CAPTURE ──────────────────────────────────────────────────────────

// The image on the item now, and what it is.
function appliedImage() {
  return applied;
}

function appliedKind() {
  return shown;
}

// Resolves once no picture is due (or after `timeout` ms).
function settled(timeout = ANSWER_MS + 500) {
  const end = Date.now() + timeout;
  return new Promise((resolve) => {
    const poll = () => (!waiting || Date.now() > end ? resolve(!waiting) : setTimeout(poll, 25));
    poll();
  });
}

module.exports = { attach, getTray, update, appliedImage, appliedKind, settled };
