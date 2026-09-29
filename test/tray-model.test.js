'use strict';
// The menu-bar picture: src/tray-model.js (main decides) and the glue and
// geometry of src/renderer/tray-picture.js (the renderer paints), the latter
// run in a vm with a fake canvas. The real painting is reviewed by eye with
// scripts/tray-sheet.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { PICTURE_STYLES, trayModel, hotLevel, modelSignature, drawMessage, pictureTitle } = require('../src/tray-model');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const inH = (h) => new Date(NOW + h * 3_600_000).toISOString();

function row(five, seven, extra = {}) {
  return {
    number: 1,
    email: 'alice@example.com',
    alias: 'work',
    active: true,
    usageStatus: 'ok',
    usage: { fiveHour: { pct: five, resetsAt: inH(2) }, sevenDay: { pct: seven, resetsAt: inH(76) } },
    ...extra,
  };
}

function ok(account, extra = {}) {
  return { phase: 'ok', accounts: [account], activeAccountNumber: 1, fetchedAt: new Date(NOW).toISOString(), error: null, refreshing: false, switching: false, ...extra };
}

// ── tray-model ──────────────────────────────────────────────────────────────

test('every phase but ok falls back to the classic ring', () => {
  for (const phase of ['loading', 'missing', 'too-old', 'no-accounts', 'error']) {
    const m = trayModel({ ...ok(row(20, 34)), phase }, NOW, { busy: true });
    assert.equal(m.kind, 'classic', phase);
    assert.equal(m.reason, phase);
    assert.equal(m.five, null);
    assert.equal(m.seven, null);
    assert.equal(m.busy, false, 'classic has no busy frame');
  }
  assert.equal(trayModel(null, NOW).kind, 'classic');
  assert.equal(trayModel(undefined, NOW).reason, 'loading');
  assert.equal(trayModel({}, NOW).kind, 'classic');
});

test('no active account falls back to the classic ring', () => {
  const m = trayModel(ok(row(20, 34, { active: false })), NOW);
  assert.deepEqual([m.kind, m.reason], ['classic', 'no-active']);
  assert.equal(trayModel({ ...ok(row(20, 34)), accounts: [] }, NOW).reason, 'no-active');
  assert.equal(trayModel({ ...ok(row(20, 34)), accounts: undefined }, NOW).reason, 'no-active');
});

test('the active account gives a picture with both windows', () => {
  const other = { ...row(95, 99), number: 2, email: 'bob@example.com', active: false };
  const m = trayModel({ ...ok(row(20, 34)), accounts: [other, row(20, 34)] }, NOW);
  assert.deepEqual(m, { kind: 'picture', five: { pct: 20, hot: null }, seven: { pct: 34, hot: null }, doubtful: false, busy: false });
});

test('values are rounded and clamped; the level follows the number shown', () => {
  const m = trayModel(ok(row(20.5, 120)), NOW);
  assert.deepEqual(m.five, { pct: 21, hot: null });
  assert.deepEqual(m.seven, { pct: 100, hot: 'danger' });
  assert.deepEqual(trayModel(ok(row(-3, 0)), NOW).five, { pct: 0, hot: null });
  // 74.9 reads "75", so it is amber; 74.4 reads "74" and is not
  assert.deepEqual(trayModel(ok(row(74.9, 34)), NOW).five, { pct: 75, hot: 'warn' });
  assert.deepEqual(trayModel(ok(row(74.4, 34)), NOW).five, { pct: 74, hot: null });
});

test('levels: amber at 75, red at 90', () => {
  const hot = (p) => trayModel(ok(row(p, 10)), NOW).five.hot;
  assert.equal(hot(74.4), null);
  assert.equal(hot(74.5), 'warn'); // shown as 75
  assert.equal(hot(75), 'warn');
  assert.equal(hot(89.4), 'warn');
  assert.equal(hot(89.9), 'danger'); // shown as 90
  assert.equal(hot(90), 'danger');
  assert.equal(hotLevel(74.9, 75, 90), null);
  assert.equal(hotLevel(75, 75, 90), 'warn');
  assert.equal(hotLevel(89.9, 75, 90), 'warn');
  assert.equal(hotLevel(90, 75, 90), 'danger');
  assert.equal(hotLevel(null, 75, 90), null);
  assert.equal(hotLevel(NaN, 75, 90), null);
});

test('thresholds are parameters', () => {
  const m = trayModel(ok(row(55, 65)), NOW, { warn: 50, danger: 60 });
  assert.equal(m.five.hot, 'warn');
  assert.equal(m.seven.hot, 'danger');
});

test('a window that rolled over has no value until the next refresh', () => {
  const rolled = row(20, 34);
  rolled.usage.fiveHour.resetsAt = new Date(NOW - 60_000).toISOString();
  const m = trayModel(ok(rolled), NOW);
  assert.deepEqual(m.five, { pct: null, hot: null });
  assert.deepEqual(m.seven, { pct: 34, hot: null });
  // a hot value that rolled over is not hot any more
  const hot = row(95, 34);
  hot.usage.fiveHour.resetsAt = new Date(NOW).toISOString();
  assert.deepEqual(trayModel(ok(hot), NOW).five, { pct: null, hot: null });
});

test('missing values are null, never 0', () => {
  const partial = row(20, 34);
  delete partial.usage.sevenDay;
  assert.deepEqual(trayModel(ok(partial), NOW).seven, { pct: null, hot: null });
  const junk = row('20', 34);
  assert.deepEqual(trayModel(ok(junk), NOW).five, { pct: null, hot: null });
  const none = trayModel(ok(row(20, 34, { usage: null, usageStatus: 'unavailable' })), NOW);
  assert.equal(none.kind, 'picture');
  assert.deepEqual([none.five.pct, none.seven.pct, none.doubtful], [null, null, false]);
});

test('doubtful: a failed refresh or last-good data', () => {
  assert.equal(trayModel(ok(row(20, 34), { error: { kind: 'cli', message: 'x' } }), NOW).doubtful, true);
  const stale = row(0, 0, { usage: null, usageStatus: 'token_expired', lastGoodUsage: row(80, 61).usage, lastGoodAgeSeconds: 5400 });
  const m = trayModel(ok(stale), NOW);
  assert.equal(m.doubtful, true);
  assert.deepEqual(m.five, { pct: 80, hot: 'warn' });
  assert.equal(trayModel(ok(row(20, 34)), NOW).doubtful, false);
});

test('busy: passed through, and on while switching', () => {
  assert.equal(trayModel(ok(row(20, 34)), NOW, { busy: true }).busy, true);
  assert.equal(trayModel(ok(row(20, 34), { switching: true }), NOW).busy, true);
  assert.equal(trayModel(ok(row(20, 34), { refreshing: true }), NOW).busy, false, 'a timer refresh is quiet');
  assert.equal(trayModel(ok(row(20, 34)), NOW, { busy: 0 }).busy, false);
});

test('modelSignature changes with anything the picture shows', () => {
  const base = trayModel(ok(row(20, 34)), NOW);
  assert.equal(modelSignature(base), modelSignature(trayModel(ok(row(20.2, 34)), NOW)));
  const variants = [
    trayModel(ok(row(21, 34)), NOW),
    trayModel(ok(row(20, 35)), NOW),
    trayModel(ok(row(20, 34), { error: { kind: 'cli', message: 'x' } }), NOW),
    trayModel(ok(row(20, 34)), NOW, { busy: true }),
    trayModel(ok(row(20, 34)), NOW, { warn: 10, danger: 90 }),
  ];
  for (const v of variants) assert.notEqual(modelSignature(v), modelSignature(base));
  assert.equal(modelSignature(trayModel(null, NOW)), 'classic');
  assert.equal(modelSignature(null), 'classic');
});

test('drawMessage is the tray:draw payload', () => {
  const m = trayModel(ok(row(95, 88), { switching: true }), NOW);
  assert.deepEqual(drawMessage(m, { seq: 7, style: 'bars', dark: 1 }), {
    seq: 7,
    style: 'bars',
    dark: true,
    warn: 75,
    danger: 90,
    five: { pct: 95, hot: 'danger' },
    seven: { pct: 88, hot: 'warn' },
    doubtful: false,
    busy: true,
  });
  assert.equal(drawMessage(m, { seq: 1, style: 'classic', dark: false }).style, 'ring');
  assert.deepEqual(PICTURE_STYLES, ['ring', 'bars', 'rings', 'ringsText']);
});

test('pictureTitle: the name, and the "?" only for the digit-less rings style', () => {
  const doubtful = trayModel(ok(row(20, 34), { error: { kind: 'cli', message: 'x' } }), NOW);
  assert.equal(pictureTitle(doubtful, 'rings'), '?');
  assert.equal(pictureTitle(doubtful, 'rings', 'work'), 'work ?');
  assert.equal(pictureTitle(doubtful, 'ring', 'work'), 'work');
  assert.equal(pictureTitle(trayModel(ok(row(20, 34)), NOW), 'rings'), '');
  assert.equal(pictureTitle(trayModel(null, NOW), 'rings'), '');
});

test('the fake cswap rows go through the model (default, carol, dave, rolled)', () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-cswap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-model-'));
  try {
    const list = (active, scenario = 'default') => {
      const statePath = path.join(dir, `state-${active}-${scenario}.json`);
      fs.writeFileSync(statePath, JSON.stringify({ active }));
      const env = { ...process.env, FAKE_CSWAP_STATE: statePath, FAKE_CSWAP_SCENARIO: scenario };
      const out = JSON.parse(execFileSync(process.execPath, [fake, 'list', '--json'], { env, encoding: 'utf8' }));
      return { phase: 'ok', accounts: out.accounts, activeAccountNumber: out.activeAccountNumber, error: null, switching: false };
    };
    const alice = trayModel(list(1));
    assert.deepEqual([alice.five, alice.seven, alice.doubtful], [{ pct: 20, hot: null }, { pct: 34, hot: null }, false]);
    const carol = trayModel(list(3));
    assert.deepEqual([carol.five, carol.seven], [{ pct: 95, hot: 'danger' }, { pct: 88, hot: 'warn' }]);
    const dave = trayModel(list(4));
    assert.deepEqual([dave.five.pct, dave.seven.pct, dave.doubtful], [42, 50, true]);
    const rolled = trayModel(list(1, 'rolled'));
    assert.deepEqual([rolled.five, rolled.seven.pct], [{ pct: null, hot: null }, 34]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── tray-picture.js in a vm ─────────────────────────────────────────────────

const PICTURE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'tray-picture.js'), 'utf8');

// Glyph widths as a share of the font size, close to SF Pro (measured in
// Electron 44 on macOS: digits ≤ 0.64 em at 26 px, "·" 0.24, "?" 0.51, "–" 0.56).
function fakeCanvas({ widthScale = 1, throwOnDraw = false } = {}) {
  const calls = [];
  const ctx = {
    font: '10px sans-serif',
    measureText(text) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
      const share = /^\d$/.test(text) ? 0.64 : text === '·' ? 0.24 : text === '?' ? 0.51 : text === '–' ? 0.56 : 0.6;
      return { width: size * share * widthScale, actualBoundingBoxAscent: size * 0.72, actualBoundingBoxDescent: 0 };
    },
    fillText(text, x, y) {
      if (throwOnDraw) throw new Error('draw failed');
      calls.push(['fillText', text, x, y, this.fillStyle, this.globalAlpha]);
    },
    setTransform(...args) {
      calls.push(['setTransform', ...args]);
    },
  };
  for (const name of ['beginPath', 'arc', 'stroke', 'fill', 'roundRect', 'fillRect']) ctx[name] = (...args) => calls.push([name, ...args]);
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => ctx,
    toDataURL: (type) => `data:${type};base64,iVBORw0KGgo=`,
  };
  return { canvas, ctx, calls };
}

function loadPicture(api, canvasOptions) {
  const made = [];
  const window = api === undefined ? {} : { api };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const c = fakeCanvas(canvasOptions);
      made.push(c);
      return c.canvas;
    },
  };
  const errors = [];
  vm.runInNewContext(PICTURE_SRC, { window, document, console: { error: (...a) => errors.push(a) } });
  return { TrayPicture: window.TrayPicture, made, errors };
}

test('tray-picture is dormant without onTrayDraw', () => {
  const none = loadPicture(undefined);
  assert.equal(typeof none.TrayPicture.render, 'function');
  assert.equal(none.TrayPicture.attach(undefined), false);
  const old = loadPicture({ getState() {} }); // today's preload
  assert.equal(old.TrayPicture.attach({ getState() {} }), false);
  assert.equal(old.made.length, 0, 'nothing painted');
});

test('tray-picture answers every tray:draw with its seq', () => {
  let handler = null;
  const sent = [];
  const api = { onTrayDraw: (cb) => (handler = cb), sendTrayImage: (...args) => sent.push(args) };
  const { TrayPicture } = loadPicture(api);
  assert.equal(typeof handler, 'function', 'subscribed at load');
  assert.equal(TrayPicture.attach(api), true, 'a second attach is a no-op');

  const cool = drawMessage(trayModel(ok(row(20, 34)), NOW), { seq: 1, style: 'ring', dark: true });
  handler(cool);
  handler({ ...cool, seq: 2 }); // same picture, new seq: still answered
  handler(drawMessage(trayModel(ok(row(95, 34)), NOW), { seq: 3, style: 'bars', dark: false }));
  assert.deepEqual(
    sent.map(([seq, url, template]) => [seq, url.startsWith('data:image/png;base64,'), template]),
    [
      [1, true, true],
      [2, true, true],
      [3, true, false],
    ],
  );

  // not a picture request: no answer, main keeps or falls back to classic
  for (const bad of [null, 'x', { ...cool, seq: 1.5 }, { ...cool, seq: '4' }, { ...cool, style: 'classic' }, { ...cool, style: 'nope' }]) handler(bad);
  assert.equal(sent.length, 3);
});

test('tray-picture sends nothing when painting throws', () => {
  let handler = null;
  const sent = [];
  const { errors } = loadPicture({ onTrayDraw: (cb) => (handler = cb), sendTrayImage: (...a) => sent.push(a) }, { throwOnDraw: true });
  handler(drawMessage(trayModel(ok(row(20, 34)), NOW), { seq: 1, style: 'ring', dark: false }));
  assert.equal(sent.length, 0);
  assert.equal(errors.length, 1);
});

test('optionsFor: template, ink and accents follow the hot values and the menu bar', () => {
  const { TrayPicture } = loadPicture(undefined);
  const msg = (five, seven, dark) => drawMessage(trayModel(ok(row(five, seven)), NOW), { seq: 1, style: 'ring', dark });
  const cool = TrayPicture.optionsFor(msg(20, 34, true));
  assert.deepEqual([cool.template, cool.ink, cool.sessionLevel, cool.weekLevel], [true, '#000000', null, null]);
  const hotDark = TrayPicture.optionsFor(msg(95, 34, true));
  assert.deepEqual([hotDark.template, hotDark.ink, hotDark.sessionLevel, hotDark.accents.danger], [false, '#ffffff', 'danger', '#ff6259']);
  const hotLight = TrayPicture.optionsFor(msg(20, 80, false));
  assert.deepEqual([hotLight.template, hotLight.ink, hotLight.weekLevel, hotLight.accents.warn], [false, '#000000', 'warn', '#c26a00']);
  // without `hot` the thresholds in the message decide
  const bare = TrayPicture.optionsFor({ style: 'ring', warn: 50, danger: 60, five: { pct: 55 }, seven: { pct: 65 } });
  assert.deepEqual([bare.sessionLevel, bare.weekLevel], ['warn', 'danger']);
  // an explicit null `hot` is main's decision and stays
  assert.equal(TrayPicture.optionsFor({ style: 'ring', five: { pct: 95, hot: null } }).sessionLevel, null);
  assert.equal(TrayPicture.trayLevel(89.9, { warn: 75, danger: 90 }), 'warn');
});

test('tray-picture sizes: 18 pt high, even widths, never over 80 pt', () => {
  const { TrayPicture } = loadPicture(undefined);
  const msgs = [
    ok(row(20, 34)),
    ok(row(100, 100), { error: { kind: 'cli', message: 'x' } }),
    ok(row(20, 34, { usage: null })),
  ].map((s) => trayModel(s, NOW));
  for (const style of PICTURE_STYLES) {
    for (const m of msgs) {
      const { canvas } = fakeCanvas();
      const out = TrayPicture.render(drawMessage(m, { seq: 1, style, dark: true }), canvas);
      assert.equal(canvas.height, TrayPicture.HEIGHT, style);
      assert.equal(canvas.width % 2, 0, `${style} width ${canvas.width} is even`);
      assert.ok(canvas.width <= TrayPicture.MAX_WIDTH, `${style} width ${canvas.width}`);
      assert.equal(out.width, canvas.width);
    }
  }
  const { canvas } = fakeCanvas();
  TrayPicture.render(drawMessage(msgs[0], { seq: 1, style: 'rings', dark: true }), canvas);
  assert.equal(canvas.width, 32);
});

test('tray-picture: "–" for a missing value, "?" when doubtful, squeezed rather than too wide', () => {
  const { TrayPicture } = loadPicture(undefined);
  const texts = (c) => c.calls.filter((x) => x[0] === 'fillText').map((x) => x[1]).join('');
  const rolled = row(20, 34);
  rolled.usage.fiveHour.resetsAt = new Date(NOW - 1000).toISOString();
  const a = fakeCanvas();
  TrayPicture.render(drawMessage(trayModel(ok(rolled), NOW), { seq: 1, style: 'ring', dark: true }), a.canvas);
  assert.equal(texts(a), '–·34');
  const b = fakeCanvas();
  TrayPicture.render(drawMessage(trayModel(ok(row(20, 34), { error: { kind: 'cli', message: 'x' } }), NOW), { seq: 1, style: 'bars', dark: true }), b.canvas);
  assert.equal(texts(b), '2034?');
  const c = fakeCanvas();
  TrayPicture.render(drawMessage(trayModel(ok(row(20, 34), { error: { kind: 'cli', message: 'x' } }), NOW), { seq: 1, style: 'rings', dark: true }), c.canvas);
  assert.equal(texts(c), '', 'rings: the "?" is the native title');
  // busy: the numbers are drawn at .45
  const d = fakeCanvas();
  TrayPicture.render(drawMessage(trayModel(ok(row(20, 34)), NOW, { busy: true }), { seq: 1, style: 'ring', dark: true }), d.canvas);
  assert.ok(d.calls.filter((x) => x[0] === 'fillText' && /\d/.test(x[1])).every((x) => x[5] === 0.45));
  // a font far wider than SF: squeezed to the limit instead of refused
  const wide = fakeCanvas({ widthScale: 1.3 });
  TrayPicture.render(drawMessage(trayModel(ok(row(100, 100), { error: { kind: 'cli', message: 'x' } }), NOW), { seq: 1, style: 'ring', dark: true }), wide.canvas);
  assert.equal(wide.canvas.width, TrayPicture.MAX_WIDTH);
  const squeeze = wide.calls.find((x) => x[0] === 'setTransform' && x[1] < 1);
  assert.ok(squeeze, 'drawn with a horizontal squeeze');
});
