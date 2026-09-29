'use strict';
// Electron entry for one e2e flow; scripts/e2e.js starts one process per flow.
//
// It wraps the real app instead of copying it. Before main.js loads, userData
// moves to the flow's temp folder, and the native surfaces a test cannot see
// or must not touch are patched to record their calls instead: context menus,
// the tray, notifications, dialogs, the clipboard, shell, app.hide, login
// items and the About panel. Every cswap call is recorded; any cswap other
// than the fake is refused. The flow then drives the popover through
// executeJavaScript and checks what main, the tray and the page show.
//
// Env (set by scripts/e2e.js): E2E_FLOW (the flow file), E2E_OUT (this flow's
// artifact folder), E2E_APP (the folder whose main.js runs), E2E_FAKE (the
// fake cswap), CSW_USER_DATA, CSWAP_PATH, FAKE_CSWAP_STATE, FAKE_CSWAP_SCENARIO.

const electron = require('electron');
const { app, Menu, Tray, Notification, dialog, clipboard, shell } = electron;
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const makeUi = require('./ui');

const FLOW_FILE = process.env.E2E_FLOW;
const OUT = process.env.E2E_OUT;
const APP_DIR = process.env.E2E_APP;
const FAKE = process.env.E2E_FAKE;
const USER_DATA = process.env.CSW_USER_DATA;
const START_TIMEOUT_MS = 20_000;
const DEFAULT_FLOW_TIMEOUT_MS = 60_000;

if (!FLOW_FILE || !OUT || !APP_DIR || !FAKE || !USER_DATA) {
  console.error('test/e2e/runner.js is started by scripts/e2e.js (npm run e2e)');
  process.exit(2);
}

const flow = require(FLOW_FILE);
const rec = {
  checks: [],
  problems: [],
  transcript: [],
  cswap: [], // { args, scenario }
  tray: { titles: [], images: [], tooltips: [] },
  notifications: [],
  dialogs: [],
  clipboard: [],
  shell: [],
  app: [],
};
const allowed = []; // { kind, re } problems the flow expects

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : util.inspect(v, { depth: 4, breakLength: Infinity });
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
};

// The transcript is compared between runs (e.g. before and after a refactor),
// so what changes from run to run is masked: temp paths, timestamps, and the
// countdowns and ages cswap rows carry.
function normalize(s) {
  return String(s)
    .split(OUT)
    .join('<out>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, '<time>')
    .replace(/(\d%|\)) \(\d+[dhms](?: \d+[dhms])?\)/g, '$1 (<dur>)') // "20% (2h 11m)", not "Session (5h)"
    .replace(/\b\d+[dhms](?: \d+[dhms])? (ago|old)\b/g, '<dur> $1')
    .replace(/\b(for|in) \d+[dhms](?: \d+[dhms])?\b/g, '$1 <dur>');
}

function transcript(line) {
  const text = normalize(line);
  rec.transcript.push(text);
  console.log(`[e2e] ${text}`);
}

function check(ok, msg, detail) {
  rec.checks.push({ ok: Boolean(ok), msg, ...(ok ? {} : { detail }) });
  transcript(`${ok ? '✓' : '✗'} ${msg}${ok || !detail ? '' : ` — ${detail}`}`);
  return Boolean(ok);
}

function problem(kind, message) {
  rec.problems.push({ kind, message: String(message) });
  console.log(`[e2e] problem ${kind}: ${message}`);
}

process.on('uncaughtException', (err) => problem('main-exception', (err && err.stack) || err));
process.on('unhandledRejection', (err) => problem('main-rejection', (err && err.stack) || err));

// ── patches (before main.js loads) ──────────────────────────────────────────

app.setPath('userData', USER_DATA);

function patch(obj, name, fn, where) {
  try {
    obj[name] = fn;
    if (obj[name] !== fn) throw new Error('not writable');
  } catch (err) {
    problem('patch', `${where}.${name}: ${err.message}`);
  }
}

// Context menus are recorded, never shown: a native menu would block the flow.
let lastMenu = null;
patch(Menu.prototype, 'popup', function () {
  lastMenu = this;
}, 'Menu.prototype');

let tray = null;
function describeImage(img) {
  if (!img || typeof img.getSize !== 'function') return { kind: typeof img };
  const { width, height } = img.getSize();
  return {
    width,
    height,
    template: img.isTemplateImage(),
    empty: img.isEmpty(),
    scaleFactors: typeof img.getScaleFactors === 'function' ? img.getScaleFactors() : null,
    hash: img.isEmpty() ? null : crypto.createHash('sha1').update(img.toPNG()).digest('hex').slice(0, 12),
  };
}
function recordTray(name, list, map = (v) => v) {
  const orig = Tray.prototype[name];
  if (typeof orig !== 'function') return; // setTitle is macOS only
  patch(Tray.prototype, name, function (value, ...rest) {
    tray = this;
    list.push(map(value));
    return orig.call(this, value, ...rest);
  }, 'Tray.prototype');
}
recordTray('setTitle', rec.tray.titles);
recordTray('setImage', rec.tray.images, describeImage);
recordTray('setToolTip', rec.tray.tooltips);
patch(Tray.prototype, 'popUpContextMenu', function (menu) {
  tray = this;
  lastMenu = menu || null;
}, 'Tray.prototype');

patch(Notification.prototype, 'show', function () {
  rec.notifications.push({ title: this.title, subtitle: this.subtitle, body: this.body, silent: this.silent });
}, 'Notification.prototype');

// Dialogs answer at once: the next queued answer, else Cancel (cancelId, or
// the last button). File panels are cancelled unless the flow queued paths.
const answers = [];
const openAnswers = [];
const isWindow = (x) => Boolean(x && typeof x === 'object' && typeof x.isDestroyed === 'function');
const boxOptions = (a, b) => (isWindow(a) ? b : a) || {};
function messageBox(a, b) {
  const o = boxOptions(a, b);
  const buttons = Array.isArray(o.buttons) ? o.buttons : [];
  let response = answers.length ? answers.shift() : Number.isInteger(o.cancelId) ? o.cancelId : Math.max(0, buttons.length - 1);
  if (typeof response === 'string') response = Math.max(0, buttons.indexOf(response));
  rec.dialogs.push({ kind: 'message', type: o.type || 'none', message: o.message || '', detail: o.detail || '', buttons, response });
  return response;
}
function openPanel(a, b) {
  const o = boxOptions(a, b);
  const filePaths = openAnswers.length ? openAnswers.shift() : null;
  rec.dialogs.push({ kind: 'open', message: o.title || '', detail: o.message || '', response: filePaths });
  return filePaths;
}
patch(dialog, 'showMessageBox', async (a, b) => ({ response: messageBox(a, b), checkboxChecked: false }), 'dialog');
patch(dialog, 'showMessageBoxSync', (a, b) => messageBox(a, b), 'dialog');
patch(dialog, 'showErrorBox', (title, content) => rec.dialogs.push({ kind: 'error', message: title, detail: content }), 'dialog');
patch(dialog, 'showOpenDialog', async (a, b) => {
  const filePaths = openPanel(a, b);
  return filePaths ? { canceled: false, filePaths } : { canceled: true, filePaths: [] };
}, 'dialog');
patch(dialog, 'showOpenDialogSync', (a, b) => openPanel(a, b) || undefined, 'dialog');
patch(dialog, 'showSaveDialog', async () => ({ canceled: true, filePath: '' }), 'dialog');

// The user's clipboard stays untouched.
patch(clipboard, 'writeText', (text) => rec.clipboard.push(String(text)), 'clipboard');
patch(clipboard, 'readText', () => (rec.clipboard.length ? rec.clipboard[rec.clipboard.length - 1] : ''), 'clipboard');

for (const fn of ['openExternal', 'openPath', 'showItemInFolder', 'trashItem']) {
  patch(shell, fn, (arg) => {
    rec.shell.push({ fn, arg: String(arg) });
    return fn === 'openPath' ? Promise.resolve('') : fn === 'showItemInFolder' ? undefined : Promise.resolve();
  }, 'shell');
}
for (const fn of ['hide', 'setLoginItemSettings', 'showAboutPanel']) {
  patch(app, fn, (...args) => rec.app.push({ fn, args }), 'app');
}

// Every cswap call is counted (idle() waits for them) and recorded. Only the
// fake may run: the real cswap switches real accounts. Any other cswap looks
// missing to the app (ENOENT) and fails the flow unless it allows
// 'blocked-spawn' (a flow that wants the "install claude-swap" screen on a
// Mac where cswap is installed).
const realSpawn = childProcess.spawn;
const samePath = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(String(a)) === path.resolve(String(b));
  }
};
let running = 0;
childProcess.spawn = function (file, args, ...rest) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (!samePath(file, FAKE)) {
    if (/cswap|claude-swap/i.test(path.basename(String(file)))) {
      problem('blocked-spawn', `refused to run ${file} ${argv.join(' ')}: e2e flows only run the fake cswap`);
      throw Object.assign(new Error(`e2e: refused to run ${file}`), { code: 'ENOENT' });
    }
    return realSpawn.call(this, file, args, ...rest);
  }
  rec.cswap.push({ args: argv, scenario: process.env.FAKE_CSWAP_SCENARIO || 'default' });
  const child = realSpawn.call(this, file, args, ...rest);
  running++;
  let done = false;
  const end = () => {
    if (!done) {
      done = true;
      running--;
    }
  };
  child.once('close', end);
  child.once('error', end);
  return child;
};

// The service is main's source of truth; catch the instance main creates.
let service = null;
try {
  const { AccountService } = require(path.join(APP_DIR, 'src', 'service.js'));
  const update = AccountService.prototype.update;
  AccountService.prototype.update = function (...args) {
    service = this;
    return update.apply(this, args);
  };
} catch (err) {
  problem('patch', `AccountService: ${err.message}`);
}

// The popover is the window that loads the renderer page.
let win = null;
const popoverLoaded = new Promise((resolve) => {
  app.on('browser-window-created', (_e, w) => {
    w.webContents.on('did-finish-load', () => {
      let page = '';
      try {
        page = decodeURIComponent(new URL(w.webContents.getURL()).pathname);
      } catch {}
      if (win || !page.endsWith('/src/renderer/index.html')) return;
      win = w;
      watchRenderer(w);
      resolve(w);
    });
  });
});

function watchRenderer(w) {
  w.webContents.on('console-message', (...a) => {
    // Electron ≥ 35 passes one details object; older versions positional args.
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] };
    if (d.level === 'error' || d.level === 3) {
      problem('renderer-error', `${d.message} (${path.basename(d.sourceId || '')}:${d.lineNumber})`);
    }
  });
  w.webContents.on('render-process-gone', (_e, details) => problem('renderer-gone', details && details.reason));
}

// ── helpers for the flows ───────────────────────────────────────────────────

let snaps = 0;

async function js(code, ...args) {
  if (!win || win.isDestroyed()) throw new Error('js(): the popover is gone');
  const src = typeof code === 'function' ? `(${code})(...${JSON.stringify(args)})` : `(${code})`;
  const wrapped = `(async () => { try { return { ok: true, value: await ${src} }; } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; } })()`;
  const r = await win.webContents.executeJavaScript(wrapped);
  if (!r || !r.ok) throw new Error(`in the page: ${r ? r.error : 'no result'}`);
  return r.value;
}

async function waitFor(fn, label, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > end) {
      throw new Error(`timed out after ${timeout} ms waiting for ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
    }
    await wait(interval);
  }
}

// Main is idle when no cswap runs and the service is neither refreshing nor
// switching, for `quiet` ms in a row. The page then gets a moment to render.
async function idle({ quiet = 250, timeout = 20_000 } = {}) {
  await wait(100);
  const end = Date.now() + timeout;
  let since = Date.now();
  for (;;) {
    const s = service && service.state;
    const busy = running > 0 || Boolean(service && service.pending) || Boolean(s && (s.refreshing || s.switching));
    if (busy) since = Date.now();
    else if (Date.now() - since >= quiet) break;
    if (Date.now() > end) throw new Error(`main did not become idle within ${timeout} ms`);
    await wait(25);
  }
  if (win && !win.isDestroyed()) await js('new Promise((r) => setTimeout(r, 60))');
}

function label(spec) {
  return Array.isArray(spec) ? spec.map(label).join(' › ') : spec instanceof RegExp ? String(spec) : JSON.stringify(spec);
}

function matches(item, spec) {
  if (spec instanceof RegExp) return spec.test(item.label || '');
  if (typeof spec === 'function') return Boolean(spec(item));
  return item.label === spec;
}

// A label (string / RegExp / predicate) is searched depth-first through the
// submenus; an array is a strict path from the top.
function find(menu, spec) {
  if (!menu) return null;
  if (Array.isArray(spec)) {
    let items = menu.items;
    let item = null;
    for (const part of spec) {
      item = (items || []).find((i) => i.type !== 'separator' && matches(i, part)) || null;
      if (!item) return null;
      items = item.submenu ? item.submenu.items : null;
    }
    return item;
  }
  for (const item of menu.items) {
    if (item.type !== 'separator' && matches(item, spec)) return item;
    if (item.submenu) {
      const hit = find(item.submenu, spec);
      if (hit) return hit;
    }
  }
  return null;
}

function click(menu, spec, { allowDisabled = false } = {}) {
  const item = find(menu, spec);
  if (!item) throw new Error(`no menu item ${label(spec)}; the menu has:\n${dumpMenu(menu)}`);
  if (!item.visible) throw new Error(`menu item ${label(spec)} is hidden`);
  if (!item.enabled && !allowDisabled) throw new Error(`menu item ${label(spec)} is disabled`);
  if (item.role) throw new Error(`menu item ${label(spec)} has role ${item.role}; flows do not click roles`);
  item.click();
  return item;
}

function dumpMenu(menu, depth = 0) {
  const pad = '  '.repeat(depth);
  return menu.items
    .map((i) => {
      if (i.type === 'separator') return `${pad}──`;
      const mark = i.checked ? '✓ ' : '  ';
      const flags = `${i.enabled ? '' : ' [disabled]'}${i.visible ? '' : ' [hidden]'}${i.role ? ` [role ${i.role}]` : ''}`;
      const line = `${pad}${mark}${i.label}${i.submenu ? ' ▸' : ''}${flags}`;
      return i.submenu ? `${line}\n${dumpMenu(i.submenu, depth + 1)}` : line;
    })
    .join('\n');
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const last = (list) => (list.length ? list[list.length - 1] : undefined);

const t = {
  electron,
  out: OUT,
  userData: USER_DATA,
  fake: FAKE,
  get win() {
    return win;
  },
  get service() {
    return service;
  },
  get tray() {
    return tray;
  },
  wait,
  waitFor,
  idle,
  js,
  normalize,

  // What main knows (a copy); falls back to asking through the page.
  async state() {
    return service ? JSON.parse(JSON.stringify(service.state)) : js('window.api.getState()');
  },
  // Calls window.api.<method>(…args) from the page, as the renderer would.
  api(method, ...args) {
    return js((m, a) => window.api[m](...a), method, args);
  },

  // The popover's "⋯" menu and the tray's right-click menu, as built by main.
  async menu() {
    lastMenu = null;
    await t.ui.clickMenu();
    return waitFor(() => lastMenu, 'the ⋯ menu', { timeout: 3000 });
  },
  async trayMenu() {
    if (!tray) throw new Error('no tray yet');
    lastMenu = null;
    tray.emit('right-click', { preventDefault() {} }, tray.getBounds());
    return waitFor(() => lastMenu, 'the tray menu', { timeout: 3000 });
  },
  trayClick() {
    if (!tray) throw new Error('no tray yet');
    tray.emit('click', { preventDefault() {} }, tray.getBounds(), { x: 0, y: 0 });
  },
  find,
  click,
  dumpMenu,

  // Menu-bar item as last set by main.
  trayTitle: () => last(rec.tray.titles),
  trayImage: () => last(rec.tray.images),
  trayTooltip: () => last(rec.tray.tooltips),
  trayTitles: rec.tray.titles,
  trayImages: rec.tray.images,

  // cswap calls as "switch 2 --json"; mark() + calls(mark) gives the new ones.
  mark: () => rec.cswap.length,
  calls: (since = 0) => rec.cswap.slice(since).map((c) => c.args.join(' ')),
  notifications: rec.notifications,
  dialogs: rec.dialogs,
  clipboard: rec.clipboard,
  shellCalls: rec.shell,
  appCalls: rec.app,
  // Answers for the next message boxes (index or button text), and paths for
  // the next open panels.
  answer: (...responses) => answers.push(...responses),
  answerOpen: (filePaths) => openAnswers.push(filePaths),

  settings: () => readJson(path.join(USER_DATA, 'settings.json')),
  fakeState: () => readJson(process.env.FAKE_CSWAP_STATE),
  setFakeState: (state) => fs.writeFileSync(process.env.FAKE_CSWAP_STATE, JSON.stringify(state)),
  // Later cswap calls use this scenario (they inherit main's env).
  scenario(name) {
    process.env.FAKE_CSWAP_SCENARIO = name;
  },
  // A refresh through the page's API, then idle.
  async refresh() {
    await t.api('refresh');
    await idle();
    return t.state();
  },

  // Screenshot of the popover (shown without focus if hidden, painted opaque).
  async snap(name) {
    if (!win || win.isDestroyed()) throw new Error('snap(): the popover is gone');
    const visible = win.isVisible();
    if (!visible) win.showInactive();
    const opaque = await js(() => document.documentElement.classList.contains('opaque'));
    if (!opaque) await js(() => document.documentElement.classList.add('opaque'));
    await wait(250);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `${String(++snaps).padStart(2, '0')}-${String(name).replace(/[^\w.-]+/g, '-')}.png`);
    fs.writeFileSync(file, img.toPNG());
    if (!opaque) await js(() => document.documentElement.classList.remove('opaque'));
    if (!visible) win.hide();
    return file;
  },

  log: (...parts) => transcript(parts.map((p) => (typeof p === 'string' ? p : show(p))).join(' ')),
  section: (title) => transcript(`── ${title}`),

  // Checks record and carry on; waitFor / click throw and stop the flow.
  ok: (value, msg) => check(Boolean(value), msg, `got ${show(value)}`),
  equal: (actual, expected, msg) => check(util.isDeepStrictEqual(actual, expected), msg, `expected ${show(expected)}, got ${show(actual)}`),
  match: (actual, re, msg) => check(typeof actual === 'string' && re.test(actual), msg, `expected ${re}, got ${show(actual)}`),
  includes: (haystack, needle, msg) =>
    check(Boolean(haystack && haystack.includes && haystack.includes(needle)), msg, `${show(needle)} not in ${show(haystack)}`),
  fail: (msg, detail) => check(false, msg, detail),
  // Polls fn() until it deep-equals `expected` (or the timeout passes), then
  // checks the last value: for what the page or the tray shows a moment
  // after main is idle.
  async expect(fn, expected, msg, { timeout = 3000, interval = 50 } = {}) {
    const end = Date.now() + timeout;
    let value;
    for (;;) {
      try {
        value = await fn();
      } catch (err) {
        value = `<threw: ${err.message}>`;
      }
      if (util.isDeepStrictEqual(value, expected) || Date.now() > end) break;
      await wait(interval);
    }
    return t.equal(value, expected, msg);
  },
  // Problems the flow provokes on purpose (e.g. a renderer crash).
  allow: (kind, re = /.*/) => allowed.push({ kind, re }),
};
t.ui = makeUi(t);

// ── run ──────────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(what)), ms)))]).finally(() => clearTimeout(timer));
}

async function run() {
  const started = Date.now();
  let error = null;
  try {
    const w = await withTimeout(popoverLoaded, START_TIMEOUT_MS, `the popover did not load within ${START_TIMEOUT_MS / 1000} s`);
    await waitFor(() => service && service.state.phase !== 'loading' && !service.state.refreshing, 'the first refresh', { timeout: START_TIMEOUT_MS });
    await idle();
    // Visible (so the page lays out and animates) but never focused, so
    // blur-to-hide does not fire and no other app loses focus.
    if (flow.show !== false) {
      w.showInactive();
      await wait(150);
    }
    const timeout = flow.timeout || DEFAULT_FLOW_TIMEOUT_MS;
    await withTimeout(Promise.resolve().then(() => flow.run(t)), timeout, `the flow did not finish within ${timeout / 1000} s`);
  } catch (err) {
    error = err;
  }
  if (error) {
    // The message and where in the flow it happened; the full stack is in electron.log.
    const lines = String((error && error.stack) || error).split('\n');
    const where = lines.find((l) => l.includes('.flow.js'));
    console.log(lines.join('\n'));
    check(false, 'the flow ran to the end', [lines[0], where && where.trim()].filter(Boolean).join(' '));
  }
  for (const p of rec.problems) {
    if (!allowed.some((a) => a.kind === p.kind && a.re.test(p.message))) check(false, `no unexpected ${p.kind}`, p.message);
  }
  if (!rec.checks.length) check(false, 'the flow made at least one check');
  const result = {
    flow: path.basename(FLOW_FILE, '.flow.js'),
    ok: rec.checks.every((c) => c.ok),
    checks: rec.checks,
    problems: rec.problems,
    ms: Date.now() - started,
    cswapCalls: rec.cswap.map((c) => `${c.scenario}: ${c.args.join(' ')}`),
    notifications: rec.notifications,
    dialogs: rec.dialogs,
  };
  fs.writeFileSync(path.join(OUT, 'transcript.txt'), `${rec.transcript.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

require(path.join(APP_DIR, 'main.js'));
app.whenReady().then(run);
