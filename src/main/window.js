'use strict';
// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, main.js:275-310, 350-357, 815-821).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// The one window: frameless, sandboxed, created once and hidden instead of
// closed. It carries all of the window hardening: close → hide, Escape, crash
// reload with a cap, zoom lock, no navigation, no new windows. Two modes
// (settings.windowMode, PLAN §2.2); only main's behaviour changes, the page
// learns the mode through settings:
//   popover  under the tray icon, hides on blur, not movable, always on top;
//   widget   a desktop widget: movable, stays when it loses focus, on top only
//            with widgetOnTop, and back where the user left it (widgetPosition,
//            saved 300 ms after a move, as Maestro does), or centred on the
//            tray's display when that spot is on no display any more.

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { WINDOW_MODES } = require('../settings');
const { WIDTH, MIN_HEIGHT, placePopover, popoverAnchor, placeWidget, isPositionOnScreen, widgetPosition } = require('./placement');

const ROOT = path.join(__dirname, '..', '..');
const REFRESH_ON_OPEN_AFTER_S = 20;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3; // per CRASH_WINDOW_MS; beyond that show() retries lazily
const SAVE_POSITION_MS = 300; // after the last move of the widget
// macOS moves windows itself when a display goes away; those moves are not
// the user's choice and must not overwrite the saved position.
const DISPLAY_SETTLE_MS = 1000;

let ctx = null;
let win = null;
let keepOpen = false; // set while a native dialog is up, so blur does not hide the popover
let hiddenAt = 0;
let wantedHeight = MIN_HEIGHT; // the renderer's natural height; clamped to the display when placed
let crashTimes = [];
let shownAt = 0; // when show() last ran; see the blur handler
let graceTimer = null;
const SHOW_GRACE_MS = 400;
let forcedMode = null; // CSW_WINDOW=widget (dev only; ctx.dev.window)
let appliedMode = null; // the mode the window's movable / on-top state was last set for
let widgetAnchor = null; // widget mode: the top-left corner the user chose ({x, y} or null)
let widgetPlaced = false; // widget mode: placed since it entered the mode, so its position is ours
let lastPlaced = null; // the position we last gave the window; a move elsewhere is the user's
let displayChangedAt = 0;
let saveTimer = null;

function attach(context) {
  ctx = context;
  // CSW_WINDOW, read by main.js (dev only).
  forcedMode = ctx.dev && WINDOW_MODES.includes(ctx.dev.window) ? ctx.dev.window : null;
  create();
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(ev, () => {
      displayChangedAt = Date.now();
      if (alive() && win.isVisible()) position();
    });
  }
  ctx.bus.on('setting:windowMode', () => switchMode());
  ctx.bus.on('setting:widgetOnTop', () => {
    if (win && !win.isDestroyed()) applyOnTop();
  });
}

function create() {
  const { app } = ctx;
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: WIDTH,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false, // popover; applyMode() makes the widget movable
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Native blurred material on macOS; elsewhere the page paints its own background.
    ...(mac ? { vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000' } : {}),
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  // Also hides the dock icon for good (Electron turns the app into a UI
  // element here); later changes skip that step, see applyOnTop().
  if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyMode();
  win.on('blur', () => {
    // A widget stays on the desktop when another app is used.
    const hideOnBlur = () => !ctx.dev.capture && !keepOpen && !isWidget() && !win.webContents.isDevToolsOpened();
    if (!hideOnBlur()) return;
    // Right after we show the popover, a closing menu (tray, mode switch) can
    // still take the focus for a moment. Decide when that moment is over:
    // hide only if the popover did not get the focus back.
    const early = SHOW_GRACE_MS - (Date.now() - shownAt);
    if (early > 0) {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        if (alive() && win.isVisible() && !win.isFocused() && hideOnBlur()) win.hide();
      }, early);
      return;
    }
    win.hide();
  });
  win.on('hide', () => (hiddenAt = Date.now()));
  win.on('move', onMove);
  // Closing (Cmd+W or any other path) would destroy the only window and
  // leave the tray pointing at nothing: hide it instead, except when quitting.
  win.on('close', (e) => {
    if (!ctx.isQuitting()) {
      e.preventDefault();
      hide();
    }
  });
  // Escape, and Cmd+W (Ctrl+W elsewhere): the reduced app menu has no Close
  // item that would bind it.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || win.webContents.isDevToolsOpened()) return;
    const closeKey = String(input.key || '').toLowerCase() === 'w' && (mac ? input.meta : input.control) && !input.alt;
    if (input.key === 'Escape' || closeKey) {
      e.preventDefault();
      hide();
    }
  });
  if (!app.isPackaged) {
    win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
      console.log(`[renderer:${level}] ${message} (${path.basename(sourceId || '')}:${lineNumber})`);
    });
  }
  // A dead renderer would leave a blank popover for weeks: reload it, unless it keeps crashing.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (ctx.isQuitting() || details.reason === 'clean-exit') return;
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (crashTimes.length >= MAX_CRASHES) return; // crash loop: show() retries lazily
    crashTimes.push(now);
    setTimeout(() => {
      if (!ctx.isQuitting() && alive() && win.webContents.isCrashed()) win.webContents.reload();
    }, 500);
  });
  win.webContents.on('unresponsive', () => {
    if (alive()) win.webContents.forcefullyCrashRenderer();
  });
  // Pinch zoom would make the page taller than the window the renderer asked for.
  win.webContents.on('did-finish-load', () => win.webContents.setVisualZoomLevelLimits(1, 1));
  // A widget lives on the desktop: it appears at launch, painted, without
  // taking focus (e.g. at login). The popover waits for the tray click.
  win.webContents.once('did-finish-load', () => {
    if (isWidget() && !ctx.dev.capture && !ctx.isQuitting() && alive() && !win.isVisible()) {
      position();
      win.showInactive();
    }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function getWin() {
  return win;
}

// 'popover' or 'widget': the setting, unless CSW_WINDOW forces one (dev only).
function mode() {
  if (forcedMode) return forcedMode;
  const s = ctx && ctx.getSettings();
  return s && s.windowMode === 'widget' ? 'widget' : 'popover';
}

// The dev-only forced mode (CSW_WINDOW), or null when the setting decides.
function forced() {
  return forcedMode;
}

function isWidget() {
  return mode() === 'widget';
}

// The window is usable only while both it and the tray that brings it back exist.
function alive() {
  const tray = ctx && ctx.getTray();
  return Boolean(win && !win.isDestroyed() && tray && !tray.isDestroyed());
}

// Movable and on-top state for the current mode. setMovable at runtime is the
// same call Electron makes for the `movable` option at creation (PLAN R11).
function applyMode() {
  const m = mode();
  if (m === appliedMode) return;
  appliedMode = m;
  win.setMovable(m === 'widget');
  if (m === 'widget') {
    widgetAnchor = widgetPosition(ctx.getSettings().widgetPosition);
    widgetPlaced = false;
  }
  applyOnTop();
}

// The popover is always on top and on every Space; the widget only with
// widgetOnTop. Their 5 s re-assert loop is not needed (it only worked around
// Maestro's hidden fetch windows). skipTransformProcessType: without it,
// turning all-workspaces off would give the menu-bar app a dock icon.
function applyOnTop() {
  const onTop = !isWidget() || ctx.getSettings().widgetOnTop !== false;
  win.setAlwaysOnTop(onTop, 'floating');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(onTop, { visibleOnFullScreen: onTop, skipTransformProcessType: true });
  }
}

// Settings ▸ Window: hide, apply, then show in the new place. The show waits a
// tick so the settings:changed that the same save sends reaches the page first.
function switchMode() {
  if (!win || win.isDestroyed() || mode() === appliedMode) return;
  win.hide();
  applyMode();
  setTimeout(() => {
    if (!ctx.isQuitting() && !ctx.dev.capture) show();
  }, 0);
}

function toggle() {
  if (!alive()) return;
  if (isWidget()) {
    // Visible but on no display (e.g. one was just unplugged) counts as hidden.
    if (win.isVisible() && isPositionOnScreen(win.getBounds(), workAreas())) hide();
    else show();
    return;
  }
  // macOS: the status-bar window cannot become key, so the click arrives with
  // the popover still visible. Windows/Linux: the click blurred it first and
  // that blur already hid it, so the click must not reopen it.
  if (win.isVisible()) hide();
  else if (Date.now() - hiddenAt > 250) show();
}

function show() {
  if (!alive()) return;
  if (win.webContents.isCrashed()) win.webContents.reload();
  position();
  shownAt = Date.now();
  win.show();
  win.focus();
  if (ctx.service.ageSeconds() > REFRESH_ON_OPEN_AFTER_S) ctx.service.refresh();
}

// Keyboard dismissal: the window was the key window of a dock-less app, so
// hand focus back to the app the user came from (blur-driven hides never need
// this). The widget too: the tray brings it back. Not while a file panel is
// open: app.hide() would hide that panel too.
function hide() {
  win.hide();
  if (process.platform === 'darwin' && !keepOpen) ctx.app.hide();
}

function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

// The work area of the display the tray icon is on.
function trayWorkArea() {
  const tb = ctx.getTray().getBounds();
  const cursor = tb.width ? null : screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(popoverAnchor(tb, cursor)).workArea;
}

// Popover: under the tray icon. Widget: at the user's corner, or centred when
// that is on no display (see placement.js). `keepCorner` (a height change)
// keeps the widget's current top-left instead, so it never jumps while shown.
function position({ keepCorner = false } = {}) {
  if (!isWidget()) {
    const tb = ctx.getTray().getBounds();
    const cursor = tb.width ? null : screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(popoverAnchor(tb, cursor)).workArea;
    setRect(placePopover(tb, cursor, wa, WIDTH, wantedHeight));
    return;
  }
  const anchor = keepCorner && widgetPlaced ? widgetPosition(win.getPosition()) : widgetAnchor;
  setRect(placeWidget(anchor, workAreas(), trayWorkArea(), WIDTH, wantedHeight));
  widgetPlaced = true;
}

// Only touches the window when the rect changed.
function setRect({ x, y, width, height }) {
  lastPlaced = { x, y };
  const b = win.getBounds();
  if (b.x !== x || b.y !== y || b.width !== width || b.height !== height) win.setBounds({ x, y, width, height }, false);
}

// A widget moved by someone other than us (the user dragging it) becomes the
// new anchor and is saved once it rests (Maestro, main.js:350-357). Our own
// placements and the moves macOS makes when displays change are not saved.
function onMove() {
  if (!isWidget() || win.isDestroyed() || !win.isVisible()) return;
  if (Date.now() - displayChangedAt < DISPLAY_SETTLE_MS) return;
  const pos = widgetPosition(win.getPosition());
  if (!pos) return;
  // Where we put it, unless a drag is under way (it may end where it began).
  const ours = lastPlaced && pos.x === lastPlaced.x && pos.y === lastPlaced.y;
  if (ours && !saveTimer) return;
  widgetAnchor = pos;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, SAVE_POSITION_MS);
}

function savePosition() {
  saveTimer = null;
  const pos = widgetPosition(widgetAnchor);
  const saved = ctx.getSettings().widgetPosition;
  if (!pos || (saved && saved.x === pos.x && saved.y === pos.y)) return;
  ctx.saveAndApply({ widgetPosition: pos });
}

// `height` is in CSS px; the window is sized in DIP.
function resize(height) {
  if (!Number.isFinite(height) || !alive()) return;
  wantedHeight = Math.ceil(height * win.webContents.getZoomFactor());
  position({ keepCorner: true });
}

// To the page, if there is one (it may be hidden or still loading).
function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Native dialogs and file panels take focus from the popover; while one is
// up, blur must not hide it and Escape must not hide the app.
function setKeepOpen(on) {
  keepOpen = Boolean(on);
}

function isKeepOpen() {
  return keepOpen;
}

module.exports = { attach, getWin, mode, forced, alive, toggle, show, hide, position, resize, send, setKeepOpen, isKeepOpen };
