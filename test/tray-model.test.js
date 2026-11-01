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
const { badges, loginExpiry, noSessionLimit } = require('../src/shared/usage');

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

// ── no 5-hour window (solo), Team seats (claude-swap #476) ──────────────────

// cswap's shape: no fiveHour key at all.
function usageRow(usage, extra = {}) {
  return { number: 1, email: 'alice@example.com', alias: 'work', active: true, usageStatus: 'ok', usage, ...extra };
}
const week = (pct, resetsAt = inH(76)) => ({ pct, resetsAt });
const named = (name, pct, resetsAt = inH(76)) => ({ name, pct, resetsAt });
const soloOf = (usage, options) => trayModel(ok(usageRow(usage)), NOW, options);

test('no 5-hour window: solo, the week alone, coloured by the fullest of it and the models', () => {
  assert.deepEqual(soloOf({ sevenDay: week(71), scoped: [named('Fable', 82)] }), {
    kind: 'picture',
    five: { pct: null, hot: null },
    seven: { pct: 71, hot: 'warn' }, // amber from Fable, while the number shown is the week's
    doubtful: false,
    busy: false,
    solo: true,
  });
  assert.deepEqual(soloOf({ sevenDay: week(34) }).seven, { pct: 34, hot: null });
  assert.equal(soloOf({ sevenDay: week(34) }).solo, true);
  assert.deepEqual(soloOf({ sevenDay: week(92), scoped: [named('Fable', 80)] }).seven, { pct: 92, hot: 'danger' });
  assert.deepEqual(soloOf({ sevenDay: week(80), scoped: [named('Fable', 95)] }).seven, { pct: 80, hot: 'danger' });
  assert.deepEqual(soloOf({ sevenDay: week(10), scoped: [named('Opus', 30), named('Fable', 95), named('Sonnet', 76)] }).seven, { pct: 10, hot: 'danger' }, 'all models count');
  // A window without a number for the 5h is missing too
  assert.equal(soloOf({ fiveHour: { resetsAt: inH(2) }, sevenDay: week(34) }).solo, true);
  // The thresholds still apply
  assert.deepEqual(soloOf({ sevenDay: week(10), scoped: [named('Fable', 55)] }, { warn: 50, danger: 60 }).seven, { pct: 10, hot: 'warn' });
});

test('solo: a rolled-over model does not colour; a rolled-over week has no number but the models still do', () => {
  const past = new Date(NOW - 60_000).toISOString();
  assert.deepEqual(soloOf({ sevenDay: week(40), scoped: [named('Fable', 95, past)] }).seven, { pct: 40, hot: null });
  assert.deepEqual(soloOf({ sevenDay: week(40), scoped: [named('Fable', 95, past), named('Opus', 80)] }).seven, { pct: 40, hot: 'warn' });
  const gone = soloOf({ sevenDay: week(95, past), scoped: [named('Fable', 80)] });
  assert.deepEqual([gone.solo, gone.seven], [true, { pct: null, hot: 'warn' }]);
  assert.deepEqual(soloOf({ sevenDay: week(95, past) }).seven, { pct: null, hot: null });
});

test('solo: models only, the fullest is the one shown', () => {
  const m = soloOf({ scoped: [named('Opus', 30), named('Fable', 82)] });
  assert.equal(m.solo, true);
  assert.deepEqual(m.seven, { pct: 82, hot: 'warn' });
  assert.deepEqual(soloOf({ scoped: [named('Fable', 0)] }).seven, { pct: 0, hot: null });
});

test('Team seat: the fullest model in the second place, not solo', () => {
  const m = soloOf({ fiveHour: { pct: 41, resetsAt: inH(2) }, scoped: [named('Opus', 5), named('Fable', 80)] });
  assert.deepEqual([m.five, m.seven], [{ pct: 41, hot: null }, { pct: 80, hot: 'warn' }]);
  assert.equal('solo' in m, false);
  // its own level: only solo takes the others' colour
  assert.deepEqual(soloOf({ fiveHour: { pct: 41, resetsAt: inH(2) }, scoped: [named('Fable', 0)] }).seven, { pct: 0, hot: null });
  assert.deepEqual(soloOf({ fiveHour: { pct: 0 }, scoped: [named('Fable', 0)] }).five, { pct: 0, hot: null }, 'an idle window is a window');
});

test('not solo: the default shape, 5h only, an idle 5h, no windows at all', () => {
  assert.equal('solo' in trayModel(ok(row(20, 34)), NOW), false);
  assert.equal('solo' in soloOf({ fiveHour: { pct: 41, resetsAt: inH(2) } }), false);
  const idle = soloOf({ fiveHour: { pct: 0 }, sevenDay: week(71), scoped: [named('Fable', 95)] });
  assert.equal('solo' in idle, false);
  assert.deepEqual([idle.five, idle.seven], [{ pct: 0, hot: null }, { pct: 71, hot: null }], 'the models colour nothing here');
  for (const usage of [null, {}, { spend: { pct: 5 } }, { scoped: [] }, { scoped: [{ name: 'NoPct' }] }]) {
    const m = soloOf(usage);
    assert.equal('solo' in m, false, JSON.stringify(usage));
    assert.deepEqual([m.five, m.seven], [{ pct: null, hot: null }, { pct: null, hot: null }], '– · –');
  }
});

test('solo: stale data shows what it has, with its doubt', () => {
  const m = trayModel(ok(usageRow(null, { usageStatus: 'relogin_required', lastGoodUsage: { sevenDay: week(33), scoped: [named('Fable', 12)] }, lastGoodAgeSeconds: 216000 })), NOW);
  assert.deepEqual([m.solo, m.seven, m.doubtful], [true, { pct: 33, hot: null }, true]);
});

test('modelSignature: solo changes it, and pictures that are not solo keep their string', () => {
  assert.equal(modelSignature(trayModel(ok(row(20, 34)), NOW)), 'picture|20|34|0|0');
  assert.equal(modelSignature(trayModel(ok(row(95, 88), { switching: true }), NOW)), 'picture|95/danger|88/warn|0|1');
  const solo = soloOf({ sevenDay: week(34) });
  assert.equal(modelSignature(solo), 'picture|-|34|0|0|solo');
  // The same numbers, one with a 5-hour window that has rolled over: another picture.
  const rolled = soloOf({ fiveHour: { pct: 20, resetsAt: new Date(NOW - 1000).toISOString() }, sevenDay: week(34) });
  assert.deepEqual([rolled.five, rolled.seven], [solo.five, solo.seven]);
  assert.notEqual(modelSignature(rolled), modelSignature(solo));
  // The colour from a model is part of it
  assert.notEqual(modelSignature(soloOf({ sevenDay: week(34), scoped: [named('Fable', 80)] })), modelSignature(solo));
});

test('drawMessage: solo only when solo', () => {
  const m = soloOf({ sevenDay: week(71), scoped: [named('Fable', 82)] });
  assert.deepEqual(drawMessage(m, { seq: 2, style: 'rings', dark: false }), {
    seq: 2,
    style: 'rings',
    dark: false,
    warn: 75,
    danger: 90,
    five: { pct: null, hot: null },
    seven: { pct: 71, hot: 'warn' },
    doubtful: false,
    busy: false,
    solo: true,
  });
  assert.equal('solo' in drawMessage(trayModel(ok(row(20, 34)), NOW), { seq: 1, style: 'ring', dark: true }), false);
  assert.equal('solo' in drawMessage(soloOf({ fiveHour: { pct: 41 }, scoped: [named('Fable', 0)] }), { seq: 1, style: 'ring', dark: true }), false);
});

test('pictureTitle: the "?" of the digit-less rings also in solo', () => {
  const doubtful = trayModel(ok(usageRow({ sevenDay: week(34) }), { error: { kind: 'cli', message: 'x' } }), NOW);
  assert.equal(pictureTitle(doubtful, 'rings'), '?');
  assert.equal(pictureTitle(doubtful, 'ring'), '');
  assert.equal(pictureTitle(soloOf({ sevenDay: week(34) }), 'rings', 'work'), 'work');
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

test('the fake cswap, scenario ultra: the roster through the model and the shared helpers', () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-cswap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-model-'));
  try {
    const list = (active) => {
      const statePath = path.join(dir, `state-${active}.json`);
      fs.writeFileSync(statePath, JSON.stringify({ active }));
      const env = { ...process.env, FAKE_CSWAP_STATE: statePath, FAKE_CSWAP_SCENARIO: 'ultra' };
      const out = JSON.parse(execFileSync(process.execPath, [fake, 'list', '--json'], { env, encoding: 'utf8' }));
      return { phase: 'ok', accounts: out.accounts, activeAccountNumber: out.activeAccountNumber, error: null, switching: false };
    };
    const state = list(1);
    const [alice, bob, carol, dave, erin] = state.accounts;

    assert.equal('fiveHour' in alice.usage, false, 'no key at all, as cswap sends it');
    assert.deepEqual([alice.alias, alice.organizationName], ['work', 'Acme Corp']);
    assert.deepEqual([alice.usage.sevenDay.pct, alice.usage.scoped[0].pct, alice.usage.scoped[0].name], [71, 82, 'Fable']);
    assert.equal(alice.usage.scoped[0].resetsAt, alice.usage.sevenDay.resetsAt, 'the same reset');
    assert.equal(typeof alice.usage.sevenDay.expectedPct, 'number', 'with its pace fields');
    assert.equal(typeof alice.usage.sevenDay.aheadOfPace, 'boolean');
    assert.deepEqual([bob.usage.fiveHour.pct, bob.usage.sevenDay.pct, bob.usage.scoped[0].pct], [3, 85, 34]);
    assert.deepEqual(Object.keys(carol.usage), ['sevenDay']);
    assert.equal('loginExpiresAt' in carol, false, 'absent when unknown');
    assert.deepEqual([dave.usage, dave.usageStatus, dave.lastGoodAgeSeconds], [null, 'relogin_required', 216000]);
    assert.deepEqual([dave.lastGoodUsage.sevenDay.pct, dave.lastGoodUsage.scoped[0].pct], [33, 12]);
    assert.equal('sevenDay' in erin.usage, false);
    assert.deepEqual([erin.usage.fiveHour.pct, erin.usage.scoped[0].pct, erin.organizationName], [41, 0, 'Initech']);

    // The login pills and the claim
    const NOW_REAL = Date.now();
    const pill = (r) => {
      const b = badges(r, undefined, NOW_REAL).find((x) => x.key === 'login');
      return b ? b.tone : null;
    };
    assert.deepEqual(state.accounts.map(pill), [null, 'warn', null, null, 'crit']);
    assert.deepEqual(state.accounts.map(noSessionLimit), [true, false, true, false, false]);
    assert.match(alice.loginExpiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'whole seconds and Z, as cswap writes it');
    assert.ok(loginExpiry(dave, NOW_REAL).expired);

    // A login's date does not move between two lists (the notifier tells once per date)
    const dates = (s) => s.accounts.map((a) => a.loginExpiresAt);
    assert.deepEqual(dates(list(2)), dates(state));

    // The pictures of the e2e flow
    const value = (m) => [m.five.pct, m.seven.pct, m.seven.hot, m.solo === true, m.doubtful];
    assert.deepEqual(value(trayModel(list(1))), [null, 71, 'warn', true, false]);
    assert.deepEqual(value(trayModel(list(2))), [3, 85, 'warn', false, false]);
    assert.deepEqual(value(trayModel(list(3))), [null, 12, null, true, false]);
    assert.deepEqual(value(trayModel(list(4))), [null, 33, null, true, true]);
    assert.deepEqual(value(trayModel(list(5))), [41, 0, null, false, false]);
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
      calls.push(['fillText', text, x, y, this.fillStyle, this.globalAlpha, this.font]);
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

// ── solo in the painter: one ring or bar, the digits at the big size ─────────

const BIG = /^500 26px /;
// Fake glyph widths at 26 px: a digit cell is 16.64, "?" 13.26. An even width in
// px: the canvas rounds up to the next even number.
const even = (px) => Math.ceil(px / 2) * 2;
const CELL = 26 * 0.64;
const QUESTION = 26 * 0.51;

function paintSolo(usage, style, { error = null, busy = false, dark = true, canvasOptions } = {}) {
  const { TrayPicture } = loadPicture(undefined);
  const c = fakeCanvas(canvasOptions);
  const model = trayModel(ok(usageRow(usage), { error }), NOW, { busy });
  const msg = drawMessage(model, { seq: 1, style, dark });
  const out = TrayPicture.render(msg, c.canvas);
  const of = (name) => c.calls.filter((x) => x[0] === name);
  return { ...c, out, arcs: of('arc'), bars: of('roundRect'), texts: of('fillText'), options: TrayPicture.optionsFor(msg), TrayPicture };
}
const text = (p) => p.texts.map((x) => x[1]).join('');
const FAILED = { kind: 'cli', message: 'x' };
const USAGE_34 = { sevenDay: week(34) };
const USAGE_71 = { sevenDay: week(71), scoped: [named('Fable', 82)] };

test('optionsFor reads solo strictly; template and colours follow the hot week', () => {
  const { TrayPicture } = loadPicture(undefined);
  assert.equal(TrayPicture.optionsFor({ style: 'ring', solo: true }).solo, true);
  for (const solo of [undefined, false, 1, 'true']) assert.equal(TrayPicture.optionsFor({ style: 'ring', solo }).solo, false, String(solo));
  const cool = paintSolo(USAGE_34, 'ring');
  assert.deepEqual([cool.options.template, cool.options.ink, cool.options.week, cool.options.session], [true, '#000000', 34, null]);
  assert.equal(cool.out.template, true);
  const hot = paintSolo(USAGE_71, 'ring', { dark: true });
  assert.deepEqual([hot.options.template, hot.options.ink, hot.options.weekLevel], [false, '#ffffff', 'warn']);
  assert.equal(hot.out.template, false);
  assert.ok(hot.texts.every((x) => x[4] === '#ffb340'), 'the digits amber on a dark bar');
  assert.equal(paintSolo(USAGE_71, 'ring', { dark: false }).texts[0][4], '#c26a00', 'and for a light one');
});

test('solo ring: the ring and the week digits, no dot, no second number', () => {
  const p = paintSolo(USAGE_34, 'ring');
  assert.equal(text(p), '34');
  assert.ok(p.texts.every((x) => BIG.test(x[6])));
  assert.equal(p.canvas.width, even(38 + 2 * CELL + 2));
  assert.equal(p.canvas.height, 36);
  // track and value, on the same ring as the default picture
  assert.deepEqual(p.arcs.map((a) => a.slice(1, 4)), [[15, 18, 11.5], [15, 18, 11.5]]);
  assert.ok(Math.abs(p.arcs[1][5] - p.arcs[1][4] - 2 * Math.PI * 0.34) < 1e-9, 'its value is the week');
  assert.equal(p.texts[0][2], 38, 'the digits start where the first number does');

  const doubtful = paintSolo(USAGE_34, 'ring', { error: FAILED });
  assert.equal(text(doubtful), '34?');
  assert.equal(doubtful.canvas.width, even(38 + 2 * CELL + 2 + QUESTION + 2));
  assert.equal(paintSolo({ sevenDay: week(100) }, 'ring').canvas.width, even(38 + 3 * CELL + 2));
  // a rolled-over week: the dash, and a track without a value
  const rolled = paintSolo({ sevenDay: week(34, new Date(NOW - 1000).toISOString()) }, 'ring');
  assert.equal(text(rolled), '–');
  assert.equal(rolled.arcs.length, 1);
});

test('solo bars: one bar on the vertical centre, the digits big and centred on it, the "?" after them', () => {
  const p = paintSolo(USAGE_34, 'bars');
  assert.equal(text(p), '34');
  assert.ok(p.texts.every((x) => BIG.test(x[6])));
  // Track and value, both 6 px high around y = 18
  assert.equal(p.bars.length, 2);
  for (const b of p.bars) assert.deepEqual([b[1], b[2], b[4], b[5]], [2, 15, 6, 3]);
  assert.equal(p.bars[0][3], 34, 'the track');
  assert.ok(Math.abs(p.bars[1][3] - 34 * 0.34) < 1e-9, 'the value');
  // Ink centred on 18: ascent .72 em, no descent in the fake font
  const y = p.texts[0][3];
  assert.ok(Math.abs(y - (18 + (26 * 0.72) / 2)) < 1e-9, `baseline ${y}`);
  assert.equal(p.canvas.width, even(41 + 2 * CELL + 2));

  const doubtful = paintSolo(USAGE_34, 'bars', { error: FAILED });
  assert.equal(text(doubtful), '34?');
  const mark = doubtful.texts[2];
  assert.ok(mark[2] >= 41 + 2 * CELL, 'after the digits');
  assert.equal(doubtful.canvas.width, even(41 + 2 * CELL + 4 + QUESTION + 2));
});

test('solo rings: one ring with the outer geometry and the same line, width 32, no text', () => {
  const p = paintSolo(USAGE_34, 'rings');
  assert.deepEqual(p.arcs.map((a) => a.slice(1, 4)), [[16, 18, 13], [16, 18, 13]]);
  assert.equal(p.ctx.lineWidth, 3.4);
  assert.equal(p.canvas.width, 32);
  assert.equal(text(p), '');
  const doubtful = paintSolo(USAGE_34, 'rings', { error: FAILED });
  assert.equal(doubtful.canvas.width, 32);
  assert.equal(text(doubtful), '', 'its "?" is the native title');
});

test('solo ringsText: one ring and the digits big, the "?" after them', () => {
  const p = paintSolo(USAGE_34, 'ringsText');
  assert.deepEqual(p.arcs.map((a) => a.slice(1, 4)), [[16, 18, 13], [16, 18, 13]]);
  assert.equal(text(p), '34');
  assert.ok(p.texts.every((x) => BIG.test(x[6])));
  assert.equal(p.canvas.width, even(39 + 2 * CELL + 2));
  const doubtful = paintSolo(USAGE_34, 'ringsText', { error: FAILED });
  assert.equal(text(doubtful), '34?');
  assert.equal(doubtful.canvas.width, even(39 + 2 * CELL + 4 + QUESTION + 2));
});

test('solo busy frames: the comet on the one ring, the segment on the one bar, dimmed digits', () => {
  for (const style of ['ring', 'rings', 'ringsText']) {
    const p = paintSolo(USAGE_34, style, { busy: true });
    const centre = new Set(p.arcs.map((a) => a.slice(1, 4).join()));
    assert.equal(centre.size, 1, `${style}: one ring`);
    assert.equal(p.arcs.length, 7, `${style}: the track and six comet parts`);
    assert.ok(p.texts.filter((x) => /\d/.test(x[1])).every((x) => x[5] === 0.45), style);
  }
  const bars = paintSolo(USAGE_34, 'bars', { busy: true });
  assert.equal(bars.bars.length, 2);
  assert.deepEqual([bars.bars[1][2], bars.bars[1][4]], [15, 6]);
  assert.ok(bars.bars[1][1] > 2 && bars.bars[1][1] + bars.bars[1][3] < 36, 'a piece inside the track');
  assert.ok(bars.texts.every((x) => x[5] === 0.45));
});

test('solo stays inside the limits, also with a far wider font', () => {
  for (const style of PICTURE_STYLES) {
    for (const usage of [USAGE_34, { sevenDay: week(100) }]) {
      for (const error of [null, FAILED]) {
        for (const widthScale of [1, 2.5]) {
          const p = paintSolo(usage, style, { error, canvasOptions: { widthScale } });
          assert.equal(p.canvas.height, 36, style);
          assert.equal(p.canvas.width % 2, 0, `${style} width ${p.canvas.width}`);
          assert.ok(p.canvas.width <= p.TrayPicture.MAX_WIDTH, `${style} width ${p.canvas.width}`);
          assert.equal(p.out.width, p.canvas.width);
        }
      }
    }
  }
  const wide = paintSolo({ sevenDay: week(100) }, 'ring', { error: FAILED, canvasOptions: { widthScale: 2.5 } });
  assert.equal(wide.canvas.width, 160);
  assert.ok(wide.calls.find((x) => x[0] === 'setTransform' && x[1] < 1), 'squeezed, not refused');
});

test('the default picture is not touched: both values, its place and its width', () => {
  const { TrayPicture } = loadPicture(undefined);
  const paint = (style) => {
    const c = fakeCanvas();
    TrayPicture.render(drawMessage(trayModel(ok(row(20, 34)), NOW), { seq: 1, style, dark: true }), c.canvas);
    const of = (name) => c.calls.filter((x) => x[0] === name);
    return { width: c.canvas.width, arcs: of('arc').map((a) => a.slice(1, 4).join()), bars: of('roundRect').map((b) => b.slice(1, 3).join()), text: of('fillText').map((x) => x[1]).join('') };
  };
  assert.deepEqual(paint('ring'), { width: 126, arcs: ['15,18,11.5', '15,18,11.5'], bars: [], text: '20·34' });
  assert.deepEqual(paint('bars'), { width: 68, arcs: [], bars: ['2,7.5', '2,7.5', '2,23.5', '2,23.5'], text: '2034' });
  assert.deepEqual(paint('rings'), { width: 32, arcs: ['16,18,13', '16,18,13', '16,18,6.6', '16,18,6.6'], bars: [], text: '' });
  assert.deepEqual(paint('ringsText'), { width: 66, arcs: ['16,18,13', '16,18,13', '16,18,6.6', '16,18,6.6'], bars: [], text: '2034' });
});
