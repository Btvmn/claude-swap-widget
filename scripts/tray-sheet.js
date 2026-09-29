'use strict';
// Contact sheet of every menu-bar picture: each tray style × a set of states
// × a dark and a light menu bar, saved as one PNG for review by eye.
//
//   node scripts/tray-sheet.js [out.png] [--zoom 2]
//
// The canvas styles go the real way: src/tray-model.js turns a service state
// into a tray:draw message, the unmodified src/renderer/tray-picture.js paints
// it in a hidden sandboxed window under the popover's exact CSP (read from
// src/renderer/index.html), and its tray:image answer is checked the way main
// checks it (PNG magic, 18 pt high, at most 80 pt wide). 'classic' is drawn by
// main's src/tray-icon.js with trayInfo()'s title. Template pictures are
// tinted on the sheet the way macOS tints them (white on a dark menu bar).
// The page counts securitypolicyviolation events; three deliberate control
// violations at the end prove the CSP was in force.
//
// Exit code 1 when a picture fails a check or the CSP reported anything
// before the controls. Touches nothing outside a temp folder and the output.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const electron = require('electron'); // the binary path in Node, the API in Electron

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  let out = null;
  let zoom = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zoom') zoom = Number(argv[++i]);
    else if (!argv[i].startsWith('-')) out = argv[i];
  }
  if (!(zoom >= 1 && zoom <= 4)) zoom = 1;
  return { out: path.resolve(out || path.join(os.tmpdir(), 'tray-sheet.png')), zoom };
}

// ── The states on the sheet ─────────────────────────────────────────────────

const NOW = Date.parse('2026-09-29T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const inH = (h) => iso(NOW + h * 3_600_000);

function account(five, seven, extra = {}) {
  return {
    number: 1,
    email: 'alice@example.com',
    alias: 'work',
    organizationName: 'Acme Corp',
    organizationUuid: 'org-acme',
    active: true,
    usageStatus: 'ok',
    usage: { fiveHour: { pct: five, resetsAt: inH(2.2) }, sevenDay: { pct: seven, resetsAt: inH(76) } },
    usageAgeSeconds: 30,
    ...extra,
  };
}

function okState(row, extra = {}) {
  return { phase: 'ok', accounts: [row], activeAccountNumber: 1, fetchedAt: iso(NOW), error: null, refreshing: false, switching: false, ...extra };
}

const FAILED = { kind: 'cli', message: 'refresh failed' };

// The first six are PLAN §10 P1.5; the rest cover the edges worth a look.
const CASES = [
  { label: '20 · 34', state: okState(account(20, 34)) },
  { label: '80 · 61', state: okState(account(80, 61)) },
  { label: '95 · 88', state: okState(account(95, 88)) },
  {
    label: '5h reset · 34',
    state: okState(account(20, 34, { usage: { fiveHour: { pct: 20, resetsAt: iso(NOW - 60_000) }, sevenDay: { pct: 34, resetsAt: inH(76) } } })),
  },
  { label: 'refresh failed', state: okState(account(20, 34), { error: FAILED }) },
  { label: 'busy', state: okState(account(20, 34)), busy: true },
  { label: 'busy 95 · 88', state: okState(account(95, 88), { switching: true }) },
  {
    label: 'stale 80 · 61',
    state: okState(account(0, 0, { usage: null, usageStatus: 'token_expired', lastGoodUsage: account(80, 61).usage, lastGoodAgeSeconds: 5400 })),
  },
  { label: '100 · 100 failed', state: okState(account(100, 100), { error: FAILED }) },
  { label: 'no usage', state: okState(account(0, 0, { usage: null, usageStatus: 'unavailable' })) },
];

const STYLES = ['classic', 'ring', 'bars', 'rings', 'ringsText'];
const THEMES = ['dark', 'light'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFIX = 'data:image/png;base64,';

// ── Electron main ───────────────────────────────────────────────────────────

function electronMain({ app, BrowserWindow, ipcMain, nativeImage }) {
  const { out, zoom } = parseArgs(
    process.env.TRAY_SHEET_OUT ? [process.env.TRAY_SHEET_OUT, '--zoom', process.env.TRAY_SHEET_ZOOM || '1'] : process.argv.slice(2),
  );
  // Chromium keeps writing to userData while it shuts down, so the launcher,
  // which outlives Electron, owns the folder and removes it afterwards.
  const owned = !process.env.TRAY_SHEET_TMP;
  const tmp = process.env.TRAY_SHEET_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'tray-sheet-'));
  app.setPath('userData', path.join(tmp, 'userData'));
  if (owned) app.on('quit', () => fs.rmSync(tmp, { recursive: true, force: true }));

  app.whenReady()
    .then(() => run({ BrowserWindow, ipcMain, nativeImage, tmp, out, zoom }))
    .then((code) => app.exit(code))
    .catch((e) => {
      console.error('tray-sheet:', e);
      app.exit(1);
    });
}

async function run({ BrowserWindow, ipcMain, nativeImage, tmp, out, zoom }) {
  const { trayModel, drawMessage, pictureTitle } = require('../src/tray-model');
  const { trayInfo } = require('../src/shared/usage');
  const { trayImage } = require('../src/tray-icon');
  if (electron.app.dock) electron.app.dock.hide();

  const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml);
  if (!m) throw new Error('no CSP meta in src/renderer/index.html');
  const csp = m[1];
  const painter = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'tray-picture.js')).href;
  fs.writeFileSync(path.join(tmp, 'preload.js'), PRELOAD);
  fs.writeFileSync(path.join(tmp, 'sheet.js'), `(${sheetPage.toString()})();\n`);
  fs.writeFileSync(
    path.join(tmp, 'sheet.html'),
    `<!doctype html>\n<html><head><meta charset="utf-8" />\n<meta http-equiv="Content-Security-Policy" content="${csp}" />\n` +
      `<title>tray sheet</title></head><body>\n<script src="${painter}"></script>\n<script src="sheet.js"></script>\n</body></html>\n`,
  );

  let phase = 'load';
  const violations = [];
  const pageErrors = [];
  const waiters = new Map();
  const wait = (key, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        reject(new Error(`timed out waiting for ${key}`));
      }, ms);
      waiters.set(key, (v) => {
        clearTimeout(timer);
        waiters.delete(key);
        resolve(v);
      });
    });
  const settle = (key, v) => waiters.has(key) && waiters.get(key)(v);
  ipcMain.on('sheet:violation', (_e, v) => violations.push({ ...v, phase }));
  ipcMain.on('sheet:error', (_e, msg) => pageErrors.push({ phase, text: String(msg) }));
  ipcMain.on('sheet:ready', (_e, info) => settle('ready', info));
  ipcMain.on('sheet:done', (_e, dataUrl) => settle('done', dataUrl));
  ipcMain.on('sheet:controls-done', (_e, info) => settle('controls', info));
  ipcMain.on('tray:image', (_e, seq, dataUrl, template) => settle(`image:${seq}`, { seq, dataUrl, template }));

  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      preload: path.join(tmp, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') pageErrors.push({ phase, text: `console ${e.level}: ${e.message}` });
  });
  const ready = wait('ready', 10_000);
  await win.loadFile(path.join(tmp, 'sheet.html'));
  const info = await ready;
  // Attaching is left to tray-picture.js itself: if it did not, no draw below is answered.
  if (!info.painter) throw new Error('tray-picture.js did not load');

  // main's check of a tray:image (PLAN §8 item 10)
  let latest = 0;
  function check(reply) {
    const errors = [];
    if (reply.seq !== latest) errors.push('stale seq');
    if (typeof reply.template !== 'boolean') errors.push('template not boolean');
    if (typeof reply.dataUrl !== 'string' || !reply.dataUrl.startsWith(PREFIX) || reply.dataUrl.length > 100_000) {
      return { errors: [...errors, 'bad data URL'] };
    }
    const buf = Buffer.from(reply.dataUrl.slice(PREFIX.length), 'base64');
    if (!buf.subarray(0, 8).equals(PNG_MAGIC)) errors.push('no PNG magic');
    const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
    const size = img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
    if (img.isEmpty()) errors.push('empty image');
    if (size.height !== 18) errors.push(`height ${size.height} pt`);
    if (size.width > 80) errors.push(`width ${size.width} pt`);
    return { errors, widthPt: size.width };
  }

  phase = 'draw';
  const rows = [];
  for (const theme of THEMES) {
    for (const style of STYLES) {
      const cells = [];
      for (const c of CASES) {
        if (style === 'classic') {
          const t = trayInfo(c.state, NOW, { mode: '5h', showName: false });
          const img = trayImage(nativeImage, t.pct, t.level);
          const png = img.toPNG({ scaleFactor: 2 });
          cells.push({ dataUrl: PREFIX + png.toString('base64'), template: img.isTemplateImage(), title: t.title, widthPt: img.getSize().width, errors: [] });
          continue;
        }
        const model = trayModel(c.state, NOW, { busy: Boolean(c.busy) });
        if (model.kind !== 'picture') {
          cells.push({ dataUrl: null, template: true, title: '', widthPt: 0, errors: [`model kind ${model.kind}`] });
          continue;
        }
        const msg = drawMessage(model, { seq: ++latest, style, dark: theme === 'dark' });
        const answer = wait(`image:${msg.seq}`, 3000);
        win.webContents.send('tray:draw', msg);
        const reply = await answer;
        const { errors, widthPt } = check(reply);
        cells.push({ dataUrl: reply.dataUrl, template: reply.template, title: pictureTitle(model, style), widthPt, errors });
      }
      rows.push({ label: style, theme, cells });
    }
  }

  // The same message again under a new seq must be answered too: main waits
  // for an answer to every seq before it gives up on the renderer.
  const again = drawMessage(trayModel(CASES[0].state, NOW), { seq: ++latest, style: 'ring', dark: true });
  const againAnswer = wait(`image:${again.seq}`, 3000);
  win.webContents.send('tray:draw', again);
  const repeatOk = check(await againAnswer).errors.length === 0;

  phase = 'compose';
  const composed = wait('done', 15_000);
  win.webContents.send('sheet:compose', {
    zoom,
    columns: CASES.map((c) => c.label),
    rows,
    note: `CSP: ${csp}`,
  });
  const sheet = await composed;
  if (typeof sheet !== 'string' || !sheet.startsWith(PREFIX)) throw new Error('the sheet page sent no PNG');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(sheet.slice(PREFIX.length), 'base64'));

  phase = 'controls';
  const controlsDone = wait('controls', 5000);
  win.webContents.send('sheet:controls');
  const controls = await controlsDone;
  await new Promise((r) => setTimeout(r, 300));

  // Report
  const bad = [];
  console.log(`widths in pt (T = template), ${STYLES.length} styles × ${CASES.length} states × ${THEMES.length} menu bars`);
  console.log(['style/bar'.padEnd(16), ...CASES.map((c) => c.label.slice(0, 11).padStart(12))].join(''));
  for (const r of rows) {
    const cells = r.cells.map((c) => `${c.widthPt}${c.template ? 'T' : ''}${c.errors.length ? '!' : ''}`.padStart(12));
    console.log([`${r.label}/${r.theme}`.padEnd(16), ...cells].join(''));
    r.cells.forEach((c, i) => c.errors.length && bad.push(`${r.label}/${r.theme}/${CASES[i].label}: ${c.errors.join(', ')}`));
  }
  const before = violations.filter((v) => v.phase !== 'controls');
  const during = violations.filter((v) => v.phase === 'controls');
  const directives = [...new Set(during.map((v) => v.directive))].sort();
  console.log(`CSP: ${csp}`);
  console.log(`violations before the controls: ${before.length}${before.length ? ` ${JSON.stringify(before)}` : ''}`);
  console.log(`control violations: ${during.length} (${directives.join(', ')}); inline script ran: ${controls.inlineRan}; style attribute applied: ${controls.styled || 'no'}`);
  console.log(`repeat message answered: ${repeatOk}`);
  // The controls log their own blocked actions; anything earlier is a real error.
  const errorsBefore = pageErrors.filter((e) => e.phase !== 'controls');
  if (errorsBefore.length) console.log(`page errors: ${JSON.stringify(errorsBefore)}`);
  console.log(`sheet: ${out}`);

  if (before.length) bad.push('CSP violations while drawing');
  if (during.length < 3 || controls.inlineRan || controls.styled) bad.push('the control violations did not fire: was the CSP in force?');
  if (!repeatOk) bad.push('a repeated message got no valid answer');
  if (errorsBefore.length) bad.push('errors in the page');
  if (bad.length) console.error(`FAILED:\n  ${bad.join('\n  ')}`);
  win.destroy();
  return bad.length ? 1 : 0;
}

// The harness preload: the tray part of the planned window.api (PLAN §7) plus
// the sheet's own channels. The violation listener sits here so it is in
// place before any page script runs.
const PRELOAD = `'use strict';
const { contextBridge, ipcRenderer } = require('electron');
document.addEventListener('securitypolicyviolation', (e) =>
  ipcRenderer.send('sheet:violation', { directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber }));
window.addEventListener('error', (e) => ipcRenderer.send('sheet:error', String(e.message)));
contextBridge.exposeInMainWorld('api', {
  onTrayDraw: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('tray:draw', listener);
    return () => ipcRenderer.removeListener('tray:draw', listener);
  },
  sendTrayImage: (seq, dataUrl, template) => ipcRenderer.send('tray:image', seq, dataUrl, template),
});
contextBridge.exposeInMainWorld('sheet', {
  ready: (info) => ipcRenderer.send('sheet:ready', info),
  onCompose: (cb) => ipcRenderer.on('sheet:compose', (_e, spec) => cb(spec)),
  done: (dataUrl) => ipcRenderer.send('sheet:done', dataUrl),
  onControls: (cb) => ipcRenderer.on('sheet:controls', () => cb()),
  controlsDone: (info) => ipcRenderer.send('sheet:controls-done', info),
});
`;

// Runs in the page (written to a file and loaded by <script src>, as the CSP
// demands). Draws the sheet on one canvas and hands back its PNG.
function sheetPage() {
  'use strict';
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
  const BAR = { dark: '#1e1e21', light: '#e6e6e9' }; // menu-bar strips
  const TEXT = { dark: '#ffffff', light: '#000000' }; // what macOS tints template images and titles with

  function load(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image did not load'));
      img.src = src;
    });
  }

  // A template image keeps only its alpha; macOS fills it with the bar's ink.
  function tinted(img, colour) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  async function compose(spec) {
    const z = spec.zoom;
    const images = await Promise.all(spec.rows.map((r) => Promise.all(r.cells.map((c) => (c.dataUrl ? load(c.dataUrl) : null)))));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const titleFont = `400 ${28 * z}px ${FONT}`;
    const labelFont = `600 ${20 * z}px ${FONT}`;
    const smallFont = `400 ${16 * z}px ${FONT}`;
    ctx.font = titleFont;
    const titleWidth = (t) => (t ? 8 * z + ctx.measureText(t).width : 0);
    const cellWidth = (ri, ci) => (images[ri][ci] ? images[ri][ci].naturalWidth * z : 0) + titleWidth(spec.rows[ri].cells[ci].title);
    const pad = 16 * z;
    const labelW = 150 * z;
    const colW = spec.columns.map((_, ci) => Math.max(120 * z, ...spec.rows.map((_, ri) => cellWidth(ri, ci))) + 2 * pad);
    const headH = 92 * z;
    const stripH = 48 * z;
    const rowH = stripH + 34 * z;
    const themeGap = 24 * z;
    canvas.width = Math.ceil(labelW + colW.reduce((a, b) => a + b, 0) + pad);
    canvas.height = Math.ceil(headH + spec.rows.length * rowH + themeGap + pad);

    ctx.fillStyle = '#f7f7f8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1d1d1f';
    ctx.font = labelFont;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Menu-bar pictures: rows = style / menu bar, columns = state; 1 sheet px = 1 Retina px' + (z > 1 ? ` × ${z}` : ''), pad, 28 * z);
    ctx.font = smallFont;
    ctx.fillStyle = '#6e6e73';
    ctx.fillText(spec.note, pad, 50 * z);
    let x = labelW;
    ctx.font = labelFont;
    ctx.fillStyle = '#1d1d1f';
    spec.columns.forEach((label, ci) => {
      ctx.fillText(label, x + pad, headH - 10 * z);
      x += colW[ci];
    });

    let y = headH;
    spec.rows.forEach((row, ri) => {
      if (ri > 0 && row.theme !== spec.rows[ri - 1].theme) y += themeGap;
      ctx.font = labelFont;
      ctx.fillStyle = '#1d1d1f';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.label, pad, y + stripH / 2 - 9 * z);
      ctx.font = smallFont;
      ctx.fillStyle = '#6e6e73';
      ctx.fillText(`${row.theme} bar`, pad, y + stripH / 2 + 13 * z);
      let cx = labelW;
      row.cells.forEach((cell, ci) => {
        ctx.fillStyle = BAR[row.theme];
        ctx.fillRect(cx, y, colW[ci] - 6 * z, stripH);
        const img = images[ri][ci];
        let px = cx + pad;
        if (img) {
          const src = cell.template ? tinted(img, TEXT[row.theme]) : img;
          const w = img.naturalWidth * z;
          const h = img.naturalHeight * z;
          ctx.imageSmoothingEnabled = z === 1;
          ctx.drawImage(src, px, y + (stripH - h) / 2, w, h);
          px += w;
        }
        if (cell.title) {
          ctx.font = titleFont;
          ctx.fillStyle = TEXT[row.theme];
          ctx.fillText(cell.title, px + 8 * z, y + stripH / 2);
        }
        ctx.font = smallFont;
        ctx.fillStyle = cell.errors.length ? '#d70015' : '#6e6e73';
        const caption = cell.errors.length ? cell.errors.join(', ') : `${cell.widthPt} pt · ${cell.template ? 'template' : 'colour'}`;
        ctx.fillText(caption, cx + 2 * z, y + stripH + 14 * z);
        cx += colW[ci];
      });
      y += rowH;
    });
    return canvas.toDataURL('image/png');
  }

  // Three things the CSP must block; main expects a violation for each.
  function controls() {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.setAttribute('style', 'color: red');
    const inline = document.createElement('script');
    inline.textContent = 'window.inlineRan = true;';
    document.body.appendChild(inline);
    const remote = new Image();
    remote.src = 'https://example.invalid/control.png';
    setTimeout(() => window.sheet.controlsDone({ inlineRan: window.inlineRan === true, styled: probe.style.color }), 300);
  }

  window.sheet.onCompose((spec) =>
    compose(spec).then(
      (png) => window.sheet.done(png),
      (e) => {
        console.error(String(e));
        window.sheet.done(null);
      },
    ),
  );
  window.sheet.onControls(controls);
  window.sheet.ready({ painter: typeof window.TrayPicture === 'object' });
}

// ── Entry: plain Node relaunches under Electron (like scripts/start.js) ─────

if (typeof electron === 'string') {
  const { spawn } = require('child_process');
  const { out, zoom } = parseArgs(process.argv.slice(2));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-sheet-'));
  const env = { ...process.env, TRAY_SHEET_OUT: out, TRAY_SHEET_ZOOM: String(zoom), TRAY_SHEET_TMP: tmp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename], { env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(signal ? 1 : code ?? 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
} else {
  electronMain(electron);
}
