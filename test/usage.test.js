'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../src/shared/usage');
const { sanitize, loadSettings, saveSettings, DEFAULTS, MAX_REFRESH_S } = require('../src/settings');
const { ringBitmap, trayImage, SIZE_PT } = require('../src/tray-icon');

const fresh = { fiveHour: { pct: 20, resetsAt: '2026-09-29T12:50:00.603140+00:00' }, sevenDay: { pct: 34 } };

test('level thresholds: amber at 75, red at 90', () => {
  assert.equal(U.level(0), 'ok');
  assert.equal(U.level(74.9), 'ok');
  assert.equal(U.level(75), 'warn');
  assert.equal(U.level(89.9), 'warn');
  assert.equal(U.level(90), 'crit');
  assert.equal(U.level(120), 'crit');
  assert.equal(U.level(null), 'none');
  assert.equal(U.level(NaN), 'none');
});

test('effectiveUsage falls back to lastGoodUsage as stale', () => {
  assert.deepEqual(U.effectiveUsage({ usage: fresh, usageAgeSeconds: 30 }), { usage: fresh, stale: false, ageSeconds: 30 });
  assert.deepEqual(U.effectiveUsage({ usage: null, lastGoodUsage: fresh, lastGoodAgeSeconds: 5400 }), { usage: fresh, stale: true, ageSeconds: 5400 });
  assert.deepEqual(U.effectiveUsage({ usage: null }), { usage: null, stale: false, ageSeconds: null });
});

test('formatDuration', () => {
  assert.equal(U.formatDuration(0), '0s');
  assert.equal(U.formatDuration(59.4), '59s');
  assert.equal(U.formatDuration(60), '1m');
  assert.equal(U.formatDuration(3600), '1h');
  assert.equal(U.formatDuration(2 * 3600 + 13 * 60), '2h 13m');
  assert.equal(U.formatDuration(3 * 86400 + 4 * 3600 + 59), '3d 4h');
  assert.equal(U.formatDuration(86400), '1d');
  assert.equal(U.formatDuration(-1), '');
  assert.equal(U.formatDuration(null), '');
});

test('secondsUntil parses cswap timestamps (microseconds, +00:00) and clamps at 0', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(Math.round(U.secondsUntil('2026-09-29T12:50:00.603140+00:00', now)), 3001);
  assert.equal(U.secondsUntil('2026-09-29T11:00:00Z', now), 0);
  assert.equal(U.secondsUntil(undefined, now), null);
  assert.equal(U.secondsUntil('soon', now), null);
});

test('badges', () => {
  const keys = (row) => U.badges(row).map((b) => b.key);
  assert.deepEqual(keys({ active: true, usageStatus: 'ok', usage: fresh }), ['active']);
  assert.deepEqual(keys({ disabled: true, usageStatus: 'ok', usage: fresh }), ['disabled']);
  assert.deepEqual(keys({ usageStatus: 'token_expired', usage: null, lastGoodUsage: fresh, lastGoodAgeSeconds: 90 }), ['token_expired', 'stale']);
  const stale = U.badges({ usage: null, lastGoodUsage: fresh, lastGoodAgeSeconds: 5400 }).find((b) => b.key === 'stale');
  assert.equal(stale.label, 'Stale · 1h 30m ago');
  const relogin = U.badges({ usageStatus: 'relogin_required', usage: null })[0];
  assert.equal(relogin.tone, 'crit');
  // unknown future statuses still get a readable badge
  assert.deepEqual(U.badges({ usageStatus: 'rate_limited_by_moon', usage: null })[0], { key: 'rate_limited_by_moon', label: 'rate limited by moon', tone: 'muted' });
});

test('measurements cswap still serves as current get their age once past 180 s', () => {
  const row = (age) => ({ usageStatus: 'ok', usage: fresh, usageAgeSeconds: age });
  assert.equal(U.agedSeconds(row(30)), null);
  assert.equal(U.agedSeconds(row(180)), null);
  assert.equal(U.agedSeconds(row(540)), 540);
  assert.equal(U.agedSeconds(row(undefined)), null);
  // stale last-good data has its own badge, not this one
  assert.equal(U.agedSeconds({ usage: null, lastGoodUsage: fresh, lastGoodAgeSeconds: 5400 }), null);
  const b = U.badges(row(540)).find((x) => x.key === 'aged');
  assert.equal(b.label, '9m ago');
  assert.equal(U.badges(row(150)).find((x) => x.key === 'aged'), undefined);
  assert.equal(U.effectiveUsage(row(540)).stale, false, 'cswap trusts it: rings stay undimmed');
  const before = Date.parse('2026-09-29T12:00:00Z'); // before fresh.fiveHour.resetsAt
  const tip = U.trayInfo({ phase: 'ok', accounts: [{ ...row(540), active: true, email: 'a@b.c' }] }, before).tooltip;
  assert.equal(tip, 'a@b.c · 5h 20% · 7d 34% · 9m old');
});

test('resetPassed', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(U.resetPassed({ resetsAt: '2026-09-29T11:59:59.603140+00:00' }, now), true);
  assert.equal(U.resetPassed({ resetsAt: '2026-09-29T12:00:00Z' }, now), true);
  assert.equal(U.resetPassed({ resetsAt: '2026-09-29T12:00:01Z' }, now), false);
  assert.equal(U.resetPassed({}, now), false);
  assert.equal(U.resetPassed(null, now), false);
  assert.equal(U.resetPassed({ resetsAt: '' }, now), false);
});

test('label prefers the alias', () => {
  assert.equal(U.label({ alias: 'work', email: 'a@b.c', number: 1 }), 'work');
  assert.equal(U.label({ email: 'a@b.c', number: 1 }), 'a@b.c');
  assert.equal(U.label({ number: 7 }), 'Account 7');
});

test('orgLabel hides the auto-named personal org', () => {
  assert.equal(U.orgLabel({ email: 'a@b.c', organizationName: "a@b.c's Organization" }), '');
  assert.equal(U.orgLabel({ email: 'A@B.c', organizationName: 'a@b.c’s Organization' }), '');
  assert.equal(U.orgLabel({ email: 'a@b.c', organizationName: "x@y.z's Organization" }), "x@y.z's Organization");
  assert.equal(U.orgLabel({ email: 'a@b.c', organizationName: 'Acme Corp' }), 'Acme Corp');
  assert.equal(U.orgLabel({ email: 'a@b.c', organizationName: '' }), '');
  assert.equal(U.orgLabel({ email: 'a@b.c' }), '');
});

test('trayInfo', () => {
  const ok = (accounts) => U.trayInfo({ phase: 'ok', accounts });
  assert.deepEqual(ok([{ active: true, email: 'a@b.c', usage: { fiveHour: { pct: 96.4 }, sevenDay: { pct: 34 } } }]), {
    title: '96%',
    pct: 96.4,
    level: 'crit',
    tooltip: 'a@b.c · 5h 96% · 7d 34%',
  });
  const lastGood = ok([{ active: true, email: 'a@b.c', usage: null, lastGoodUsage: { fiveHour: { pct: 42 } } }]);
  assert.equal(lastGood.tooltip, 'a@b.c · 5h 42% · stale');
  assert.equal(lastGood.title, '42%?');
  assert.equal(ok([{ active: true, email: 'a@b.c', usage: null }]).title, '–');
  assert.equal(ok([{ active: false, email: 'a@b.c' }]).title, '–');
  assert.equal(U.trayInfo({ phase: 'missing' }).title, '!');
  assert.equal(U.trayInfo({ phase: 'loading' }).title, '');
  assert.equal(U.trayInfo(null).title, '');
});

test('trayInfo does not pass off outdated numbers as current', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const row = (fiveResetsAt) => ({ active: true, email: 'a@b.c', usage: { fiveHour: { pct: 96, resetsAt: fiveResetsAt }, sevenDay: { pct: 34 } } });
  // the 5h window rolled over: the old 96 % is known to be wrong
  const rolled = U.trayInfo({ phase: 'ok', accounts: [row('2026-09-29T11:59:00+00:00')] }, now);
  assert.deepEqual(rolled, { title: '–', pct: null, level: 'none', tooltip: 'a@b.c · 5h window has reset, waiting for new data · 7d 34%' });
  // refreshes keep failing: keep the number and its warning colour, but mark it
  const failing = U.trayInfo(
    { phase: 'ok', accounts: [row('2026-09-29T13:00:00+00:00')], error: { kind: 'timeout', message: 'x' }, fetchedAt: '2026-09-29T09:00:00Z' },
    now,
  );
  assert.equal(failing.title, '96%?');
  assert.equal(failing.level, 'crit');
  assert.equal(failing.tooltip, 'a@b.c · 5h 96% · 7d 34% · not updated for 3h');
});

test('settings sanitize, load and save', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.deepEqual(sanitize({ theme: 'neon', refreshSeconds: 5, cswapPath: '  ', extra: 1 }), { ...DEFAULTS, refreshSeconds: 30 });
  assert.deepEqual(sanitize({ theme: 'dark', refreshSeconds: 90, cswapPath: '/x/cswap' }), { cswapPath: '/x/cswap', theme: 'dark', refreshSeconds: 90 });
  // above setInterval's 32-bit limit the delay would collapse to 1 ms
  assert.equal(sanitize({ refreshSeconds: 3_600_000 }).refreshSeconds, MAX_REFRESH_S);
  assert.equal(sanitize({ refreshSeconds: 1e300 }).refreshSeconds, MAX_REFRESH_S);
  assert.ok(MAX_REFRESH_S * 1000 <= 2 ** 31 - 1);
  assert.equal(sanitize({ refreshSeconds: Infinity }).refreshSeconds, DEFAULTS.refreshSeconds);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  try {
    assert.deepEqual(loadSettings(dir), DEFAULTS);
    saveSettings(dir, { ...DEFAULTS, theme: 'light' });
    assert.equal(loadSettings(dir).theme, 'light');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
    assert.deepEqual(loadSettings(dir), DEFAULTS);
    // an unwritable location: the choice is returned, nothing throws
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const errors = [];
    const orig = console.error;
    console.error = (m) => errors.push(m);
    try {
      assert.deepEqual(saveSettings(path.join(blocker, 'sub'), { ...DEFAULTS, theme: 'dark' }), { ...DEFAULTS, theme: 'dark' });
    } finally {
      console.error = orig;
    }
    assert.equal(errors.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ringBitmap draws a clockwise arc from 12 o’clock', () => {
  const px = 36;
  const alphaAt = (buf, x, y) => buf[(y * px + x) * 4 + 3];
  const quarter = ringBitmap(px, 25);
  // right side (3 o'clock edge of the first quarter) is filled, left side is track only
  const ringMid = Math.round(px / 2 + px * 0.345);
  const ringMidLeft = Math.round(px / 2 - px * 0.345);
  const topRight = alphaAt(quarter, Math.round(px * 0.7), Math.round(px * 0.2));
  const left = alphaAt(quarter, ringMidLeft, px / 2);
  assert.ok(topRight > 200, `filled arc should be opaque, got ${topRight}`);
  assert.ok(left > 40 && left < 120, `track should be translucent, got ${left}`);
  assert.equal(alphaAt(quarter, px / 2, px / 2), 0, 'centre is empty');
  assert.equal(alphaAt(quarter, 0, 0), 0, 'corner is empty');
  // unknown pct draws only the track
  const none = ringBitmap(px, null);
  assert.ok(alphaAt(none, ringMid, px / 2) < 120);
  // colour is premultiplied BGRA
  const red = ringBitmap(px, 100, [240, 68, 56]);
  const i = (Math.round(px * 0.2) * px + Math.round(px * 0.7)) * 4;
  assert.ok(red[i + 2] > red[i], 'red channel (index 2) dominates blue (index 0)');
});

test('trayImage: template image only below amber; 1x and 2x representations', () => {
  const stub = {
    createEmpty: () => ({
      reps: [],
      addRepresentation(r) {
        this.reps.push(r);
      },
      setTemplateImage(v) {
        this.template = v;
      },
    }),
  };
  for (const [level, pct, template] of [['ok', 20, true], ['none', null, true], ['warn', 80, false], ['crit', 95, false]]) {
    const img = trayImage(stub, pct, level);
    // a template image is tinted monochrome by macOS: amber/red would be lost
    assert.equal(img.template, template, `level=${level}`);
    assert.deepEqual(img.reps.map((r) => [r.scaleFactor, r.width, r.height]), [[1, SIZE_PT, SIZE_PT], [2, 2 * SIZE_PT, 2 * SIZE_PT]]);
    for (const r of img.reps) assert.equal(r.buffer.length, r.width * r.height * 4);
  }
  // …and the colour really reaches the pixels (BGRA, a filled-arc pixel)
  const at = (img, scale) => {
    const r = img.reps.find((x) => x.scaleFactor === scale);
    const i = (Math.round(r.width * 0.2) * r.width + Math.round(r.width * 0.7)) * 4;
    return r.buffer.subarray(i, i + 4);
  };
  for (const scale of [1, 2]) {
    const warn = at(trayImage(stub, 80, 'warn'), scale);
    const crit = at(trayImage(stub, 95, 'crit'), scale);
    const plain = at(trayImage(stub, 80, 'ok'), scale);
    assert.ok(warn[3] > 200 && crit[3] > 200 && plain[3] > 200, `filled pixel opaque @${scale}x`);
    assert.ok(warn[2] > warn[0] && warn[1] > warn[2] / 2, `warn is amber @${scale}x: ${[...warn]}`);
    assert.ok(crit[2] > crit[0] && crit[1] < crit[2] / 2, `crit is red @${scale}x: ${[...crit]}`);
    assert.deepEqual([plain[0], plain[1], plain[2]], [0, 0, 0], `template ring stays black @${scale}x`);
  }
});
