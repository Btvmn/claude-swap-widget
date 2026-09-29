'use strict';
// Dev switch CSW_CAPTURE=out.png: once the first real state is in, show the
// popover without focus, save a screenshot of it and of the menu-bar picture
// (out-tray.png, at 2x), and quit. Used for the README screenshots and for
// checking the look of a change by eye.
//
// out-tray.png is the image the menu-bar item really shows (tray.js): the
// canvas picture the page painted, or the classic ring when that is what is
// on it. A picture still due is waited for first (at most its 1 s timeout).

const fs = require('fs');
const trayUi = require('./tray');

const SETTLE_MS = 700; // after the last state change, before showing
const PAINT_MS = 400; // after showing, before the screenshot

let ctx = null;
let captureTimer = null;

function attach(context) {
  ctx = context;
}

function onState(state) {
  if (ctx && ctx.dev.capture && state.phase !== 'loading' && !state.refreshing) schedule();
}

function schedule() {
  const file = ctx.dev.capture;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    const win = ctx.getWin();
    ctx.positionUi();
    win.showInactive();
    await new Promise((r) => setTimeout(r, PAINT_MS));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    await trayUi.settled();
    const tray = trayUi.appliedImage();
    const trayFile = file.replace(/\.png$/i, '') + '-tray.png';
    if (tray) fs.writeFileSync(trayFile, tray.toPNG({ scaleFactor: 2 }));
    const size = tray ? tray.getSize() : null;
    const what = tray ? `${trayUi.appliedKind()}, ${size.width}×${size.height} pt, ${tray.isTemplateImage() ? 'template' : 'colour'}` : 'none';
    console.log(`captured ${file} (menu bar: ${what})`);
    ctx.app.quit();
  }, SETTLE_MS);
}

module.exports = { attach, onState };
