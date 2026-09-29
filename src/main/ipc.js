'use strict';
// The renderer's account and app calls (PLAN §7). Every handler first checks
// that the call comes from our own page, then validates its payload: the page
// is sandboxed, but whatever it sends is still treated as untrusted input.
// Settings, history, tray-picture and per-account-menu channels live in their
// own modules and use the same fromUi(). Our own error messages are in the UI
// language; cswap's (err.message) stay as cswap wrote them, with `kind` for
// the page to map.

const { ipcMain, clipboard, shell } = require('electron');
const pkg = require('../../package.json');

const DOCS_URL = 'https://github.com/realiti4/claude-swap#installation';
const MAX_COPY_CHARS = 200;
// From package.json, not app.getVersion(): when a test harness is the entry
// point, Electron reports its own version.
const VERSION = pkg.version;

let ctx = null;

// Only the main frame of the popover's own page may call in: not another
// window, and not a subframe (the CSP allows none, this makes sure). Frames
// are compared by ids, which stay stable across Electron versions where
// object identity may not.
function fromUi(e) {
  const win = ctx && ctx.getWin();
  if (!win || win.isDestroyed() || !e || e.sender !== win.webContents) return false;
  const frame = e.senderFrame;
  const main = win.webContents.mainFrame;
  return Boolean(frame && main && frame.processId === main.processId && frame.routingId === main.routingId);
}

// A strategy, or the identity of a listed account (the service looks its
// current slot number up again right before switching).
function switchTarget(t) {
  if (!t || typeof t !== 'object') return null;
  if (['rotate', 'best', 'next-available'].includes(t.strategy)) return { strategy: t.strategy };
  if (typeof t.email === 'string' && t.email && (t.organizationUuid == null || typeof t.organizationUuid === 'string')) {
    return { email: t.email, organizationUuid: t.organizationUuid || '' };
  }
  return null;
}

function plainError(err) {
  return { kind: err.kind || 'unknown', message: err.message, errorType: err.errorType };
}

function attach(context) {
  ctx = context;
  const { service } = ctx;

  ipcMain.handle('app:info', (e) => {
    if (!fromUi(e)) return null;
    const info = { platform: process.platform, capture: Boolean(ctx.dev.capture), version: VERSION };
    if (ctx.dev.captureView) info.captureView = ctx.dev.captureView;
    return info;
  });
  ipcMain.handle('accounts:get', (e) => (fromUi(e) ? service.state : null));
  // A deliberate refresh (the page's refresh button or Cmd+R), unlike the timer's.
  ipcMain.handle('accounts:refresh', (e) => {
    if (!fromUi(e)) return null;
    ctx.bus.emit('refresh:manual');
    return service.refresh();
  });
  ipcMain.handle('accounts:switch', async (e, target) => {
    if (!fromUi(e)) return null;
    const t = switchTarget(target);
    if (!t) return { ok: false, error: { kind: 'invalid', message: ctx.t('err.invalidTarget') } };
    try {
      const result = await service.switchTo(t);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: plainError(err) };
    }
  });
  ipcMain.handle('accounts:set-disabled', async (e, target, disabled) => {
    if (!fromUi(e)) return null;
    const t = switchTarget(target);
    if (!t || t.strategy || typeof disabled !== 'boolean') return { ok: false, error: { kind: 'invalid', message: ctx.t('err.invalidAccount') } };
    try {
      await service.setDisabled(t, disabled);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: plainError(err) };
    }
  });
  ipcMain.handle('app:recheck', (e) => (fromUi(e) ? service.reconnect() : null));
  ipcMain.handle('app:choose-binary', (e) => (fromUi(e) ? ctx.chooseBinary() : null));
  ipcMain.handle('app:use-path', (e) => (fromUi(e) ? ctx.setCswapPath(null) : null));
  // Setup screens copy install commands; keep it to short plain text.
  ipcMain.handle('app:copy', (e, text) => {
    if (fromUi(e) && typeof text === 'string' && text.length <= MAX_COPY_CHARS) clipboard.writeText(text);
  });
  ipcMain.on('app:open-docs', (e) => {
    if (fromUi(e)) shell.openExternal(DOCS_URL);
  });
  ipcMain.on('app:menu', (e) => {
    if (fromUi(e)) ctx.buildMenu().popup({ window: ctx.getWin() });
  });
  // The header's pin button. The page may flip only this one window setting;
  // everything else about the window stays in main's hands.
  ipcMain.on('ui:set-window-mode', (e, mode) => {
    if (fromUi(e) && (mode === 'popover' || mode === 'widget')) ctx.saveAndApply({ windowMode: mode });
  });
  ipcMain.on('ui:resize', (e, height) => {
    if (fromUi(e)) ctx.resizeUi(Number(height));
  });
}

module.exports = { attach, fromUi, switchTarget, DOCS_URL };
