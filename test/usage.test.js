'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const U = require('../src/shared/usage');
const I18n = require('../src/shared/i18n');
const { sanitize, loadSettings, saveSettings, DEFAULTS, MAX_REFRESH_S } = require('../src/settings');
const { ringBitmap, trayImage, SIZE_PT } = require('../src/tray-icon');

const fresh = { fiveHour: { pct: 20, resetsAt: '2026-09-29T12:50:00.603140+00:00' }, sevenDay: { pct: 34 } };

test('level thresholds: amber at 75, red at 90', () => {
  assert.equal(U.level(0), 'ok');
  assert.equal(U.level(74.4), 'ok');
  assert.equal(U.level(74.5), 'warn', 'shows as 75%');
  assert.equal(U.level(75), 'warn');
  assert.equal(U.level(89.4), 'warn');
  assert.equal(U.level(89.5), 'crit', 'shows as 90%');
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

test('modelBadges: a model near its limit with no ring or line of its own, not after its reset', () => {
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const ahead = '2026-11-03T12:00:00Z';
  const win = (pct, resetsAt = ahead) => ({ pct, resetsAt });
  const keys = (usage) => U.modelBadges(usage, 'en', NOW).map((b) => [b.key, b.tone, b.label]);
  const normal = (...scoped) => ({ fiveHour: win(20), sevenDay: win(34), scoped });
  assert.deepEqual(keys(normal({ ...win(74), name: 'Fable' })), [], 'under the warn line');
  assert.deepEqual(keys(normal({ ...win(76), name: 'Fable' })), [['model:Fable', 'warn', 'Fable 76%']]);
  assert.deepEqual(keys(normal({ ...win(100), name: 'Fable' })), [['model:Fable', 'crit', 'Fable 100%']]);
  assert.deepEqual(keys(normal({ ...win(40), name: 'Opus' }, { ...win(95), name: 'Fable' }, { ...win(76), name: 'Haiku' })).map((k) => k[0]), ['model:Fable', 'model:Haiku'], 'in cswap\'s order');
  // With a ring or a line of its own it needs no pill; the one left without does.
  assert.deepEqual(keys({ sevenDay: win(71), scoped: [{ ...win(95), name: 'Fable' }] }), []);
  assert.deepEqual(keys({ sevenDay: win(71), scoped: [{ ...win(95), name: 'Fable' }, { ...win(80), name: 'Opus' }] }).map((k) => k[0]), ['model:Opus']);
  assert.deepEqual(keys(normal({ ...win(95, '2026-11-01T11:59:00Z'), name: 'Fable' })), [], 'its value no longer applies after the reset');
  assert.deepEqual(keys(normal({ pct: 95 })), [['model:?', 'crit', '? 95%']], 'no name, no reset');
  for (const none of [null, undefined, {}, { scoped: 'x' }, { scoped: [null, {}, { name: 'Fable' }] }]) assert.deepEqual(U.modelBadges(none, 'en', NOW), [], JSON.stringify(none));
  const [ru] = U.modelBadges(normal({ ...win(95), name: 'Fable' }), 'ru', NOW);
  assert.deepEqual([ru.label, ru.title], ['Fable 95%', 'Fable · неделя']);
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
  assert.deepEqual(sanitize({ theme: 'dark', refreshSeconds: 90, cswapPath: '/x/cswap', showName: true, titleMode: 'both' }), {
    ...DEFAULTS,
    cswapPath: '/x/cswap',
    theme: 'dark',
    refreshSeconds: 90,
    showName: true,
    titleMode: 'both',
  });
  assert.deepEqual(sanitize({ showName: 'yes', titleMode: 'everything' }), DEFAULTS);
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

test('trayInfo title modes and the account name', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const later = '2026-09-29T15:00:00Z';
  const state = {
    phase: 'ok',
    accounts: [{ active: true, email: 'alice@example.com', usage: { fiveHour: { pct: 20, resetsAt: later }, sevenDay: { pct: 81, resetsAt: later } } }],
  };
  const t = (opts) => U.trayInfo(state, now, opts);
  assert.equal(t({ mode: '5h' }).title, '20%');
  assert.equal(t({ mode: '5h' }).level, 'ok');
  assert.equal(t({ mode: '7d' }).title, '81%');
  assert.equal(t({ mode: '7d' }).pct, 81);
  assert.equal(t({ mode: 'both' }).title, '20% · 81%');
  assert.equal(t({ mode: 'both' }).pct, 20, 'the ring shows 5h');
  assert.equal(t({ mode: 'both' }).level, 'warn', 'coloured by the highest shown');
  assert.equal(t({ mode: 'max' }).title, '81%');
  assert.equal(t({ mode: 'off' }).title, '');
  assert.equal(t({ mode: '5h', showName: true }).title, 'alice 20%');
  assert.equal(t({ mode: 'off', showName: true }).title, 'alice');
  const aliased = { ...state, accounts: [{ ...state.accounts[0], alias: 'work' }] };
  assert.equal(U.trayInfo(aliased, now, { showName: true }).title, 'work 20%');
  // "?" once, at the end, when the data is doubtful
  assert.equal(U.trayInfo({ ...state, error: { message: 'x' }, fetchedAt: '2026-09-29T11:00:00Z' }, now, { mode: 'both' }).title, '20% · 81%?');
});

test('pace: "7d ahead of pace" badge and menu labels', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const row = {
    number: 1,
    email: 'contact@example.com',
    active: true,
    usageStatus: 'ok',
    usage: {
      fiveHour: { pct: 100, resetsAt: '2026-09-29T14:47:00+00:00' },
      sevenDay: { pct: 62, resetsAt: '2026-10-04T15:00:00+00:00', expectedPct: 48.2, aheadOfPace: true },
      scoped: [{ name: 'Fable', pct: 76, resetsAt: '2026-10-04T15:00:00+00:00', aheadOfPace: true }],
    },
  };
  const pace = U.badges(row).find((b) => b.key === 'pace');
  assert.equal(pace.label, '7d ahead of pace');
  assert.equal(pace.title, 'Used 62%; an even pace would be 48% by now');
  assert.equal(U.badges({ ...row, usage: { ...row.usage, sevenDay: { pct: 30, aheadOfPace: false } } }).find((b) => b.key === 'pace'), undefined);
  assert.equal(U.menuLabel(row, now), '1  contact@example.com  5h 100% (2h 47m) · 7d 62% (ahead) (5d 3h) · Fable 76% (ahead) (5d 3h)');
  const off = { number: 5, email: 'e@x', disabled: true, usageStatus: 'token_expired', usage: null, lastGoodUsage: { fiveHour: { pct: 5, resetsAt: '2026-09-29T11:00:00Z' } } };
  assert.equal(U.menuLabel(off, now), '5  e@x  5h reset  — disabled, token expired, stale');
  assert.equal(U.shortName({ email: 'contact@example.com' }), 'contact');
});

// --- through a translator (PLAN §6.2): English by default, ru/uk/de on request

const ru = I18n.translator('ru');
const de = I18n.translator('de');
// ICU puts no-break spaces into formatted times and dates; compare with plain ones.
const plain = (s) => s.replace(/[\u00a0\u2009\u202f]/g, ' ');
const NOW = Date.parse('2026-09-29T12:00:00Z');
const STATUSES = ['token_expired', 'relogin_required', 'keychain_unavailable', 'foreign_credential', 'no_credentials', 'api_key', 'unavailable'];
const paceRow = {
  number: 1,
  email: 'contact@example.com',
  active: true,
  usageStatus: 'ok',
  usage: {
    fiveHour: { pct: 100, resetsAt: '2026-09-29T14:47:00+00:00' },
    sevenDay: { pct: 62, resetsAt: '2026-10-04T15:00:00+00:00', expectedPct: 48.2, aheadOfPace: true },
    scoped: [{ name: 'Fable', pct: 76, resetsAt: '2026-10-04T15:00:00+00:00', aheadOfPace: true }],
  },
};
const offRow = { number: 5, email: 'e@x', disabled: true, usageStatus: 'token_expired', usage: null, lastGoodUsage: { fiveHour: { pct: 5, resetsAt: '2026-09-29T11:00:00Z' } } };

test('STATUS_BADGES: a tone and two i18n keys per status, and a menu line key', () => {
  assert.deepEqual(Object.keys(U.STATUS_BADGES), STATUSES);
  assert.ok(Object.isFrozen(U.STATUS_BADGES));
  for (const st of STATUSES) {
    const b = U.STATUS_BADGES[st];
    assert.ok(Object.isFrozen(b), st);
    assert.deepEqual(b, { tone: b.tone, labelKey: `badge.${st}`, tipKey: `badge.tip.${st}` });
    assert.ok(['warn', 'crit', 'info', 'muted'].includes(b.tone), st);
    for (const key of [b.labelKey, b.tipKey, `menuLine.${st}`]) assert.ok(key in I18n.STRINGS.en, key);
  }
  // the tones are today's
  assert.deepEqual(
    STATUSES.map((st) => U.STATUS_BADGES[st].tone),
    ['warn', 'crit', 'warn', 'warn', 'crit', 'info', 'muted'],
  );
  // an inherited property is not a status
  assert.deepEqual(U.badges({ usageStatus: 'constructor', usage: null }), [{ key: 'constructor', label: 'constructor', tone: 'muted' }]);
  assert.equal(U.menuLabel({ number: 2, email: 'a@b.c', usageStatus: 'toString', usage: null }, NOW), '2  a@b.c  — toString');
});

test('badges speak the translator’s language; German keeps its capitals', () => {
  const t = (row, tr) => U.badges(row, tr).map((b) => [b.key, b.label, b.tone, b.title]);
  assert.deepEqual(t(offRow, de), [
    ['disabled', 'Deaktiviert', 'muted', 'Vom automatischen Wechsel ausgenommen'],
    ['token_expired', 'Token abgelaufen', 'warn', 'Claude Code erneuert es bei der nächsten Nutzung; cswap versucht es selbst erneut'],
    ['stale', 'Veraltet', 'muted', 'Letzte gültige Messung wird angezeigt'],
  ]);
  assert.deepEqual(t({ ...offRow, lastGoodAgeSeconds: 5400 }, ru)[2], ['stale', 'Устарело · 1 ч 30 мин назад', 'muted', 'Показаны последние удачные данные']);
  assert.deepEqual(t({ usageStatus: 'ok', usage: fresh, usageAgeSeconds: 540 }, de), [
    ['aged', 'vor 9 Min.', 'muted', 'Vor 9 Min. gemessen; cswap misst jedes Konto nach eigenem Zeitplan neu'],
  ]);
  assert.deepEqual(t(paceRow, ru), [
    ['active', 'Активный', 'accent', 'Этот аккаунт сейчас использует Claude Code'],
    ['pace', 'Неделя: опережает график', 'warn', 'Израсходовано 62%, а при равномерном расходе было бы 48%'],
  ]);
  assert.equal(U.paceNote({ pct: 81.6, aheadOfPace: true }, de), '82 % verbraucht – schneller als bei gleichmäßiger Nutzung bis zum Wochen-Reset');
  for (const st of STATUSES) {
    const [b] = U.badges({ usageStatus: st, usage: null }, de);
    assert.equal(b.label, I18n.STRINGS.de[`badge.${st}`], st);
    assert.equal(b.title, I18n.STRINGS.de[`badge.tip.${st}`], st);
  }
  // cswap's own word for a status we do not know stays as it is
  assert.deepEqual(U.badges({ usageStatus: 'rate_limited_by_moon', usage: null }, ru)[0], { key: 'rate_limited_by_moon', label: 'rate limited by moon', tone: 'muted' });
  // the English default now titles the Active badge too
  assert.deepEqual(U.badges({ active: true, usageStatus: 'ok', usage: fresh })[0], { key: 'active', label: 'Active', tone: 'accent', title: 'The account Claude Code uses now' });
});

test('formatDuration, label and shortName through a translator', () => {
  assert.deepEqual([45, 720, 5400, 7200, 3 * 86400 + 4 * 3600, 86400].map((s) => U.formatDuration(s, ru)), ['45 с', '12 мин', '1 ч 30 мин', '2 ч', '3 д 4 ч', '1 д']);
  assert.equal(U.formatDuration(5400, de), '1 Std. 30 Min.');
  assert.equal(U.formatDuration(5400, 'uk'), '1 год 30 хв', 'a language code works too');
  assert.equal(U.formatDuration(5400, 'xx'), '1h 30m', 'an unknown code is English');
  assert.equal(U.formatDuration(Infinity), '', 'no "Infinityd"');
  for (const s of [0, 59, 60, 3599, 3600, 86399, 86400, 1e6]) assert.equal(U.formatDuration(s, ru), I18n.formatDuration(ru, s), `s = ${s}`);
  assert.equal(U.label({ number: 7 }, de), 'Konto 7');
  assert.equal(U.label({ number: 7 }, ru), 'Аккаунт 7');
  assert.equal(U.label({ alias: 'work', number: 7 }, ru), 'work');
  assert.equal(U.shortName({ number: 3 }, de), 'Konto 3');
});

test('menuLabel in ru and de: localised windows and notes, German capitals kept', () => {
  assert.equal(U.menuLabel(paceRow, NOW, ru), '1  contact@example.com  5 ч 100% (2 ч 47 мин) · 7 дн 62% (опережает) (5 д 3 ч) · Fable 76% (опережает) (5 д 3 ч)');
  assert.equal(U.menuLabel(paceRow, NOW, de), '1  contact@example.com  5 Std. 100 % (2 Std. 47 Min.) · 7 T 62 % (über Plan) (5 T 3 Std.) · Fable 76 % (über Plan) (5 T 3 Std.)');
  assert.equal(U.menuLabel(offRow, NOW, ru), '5  e@x  5 ч: обновлён  — отключён, токен истёк, устарело');
  assert.equal(U.menuLabel(offRow, NOW, de), '5  e@x  5 Std.: zurückgesetzt  — deaktiviert, Token abgelaufen, veraltet');
  for (const st of STATUSES) {
    assert.equal(U.menuLabel({ number: 2, email: 'a@b.c', usageStatus: st, usage: null }, NOW, de), `2  a@b.c  — ${I18n.STRINGS.de[`menuLine.${st}`]}`, st);
  }
  // English is today's, with "API key" no longer lowercased
  assert.equal(U.menuLabel({ number: 2, email: 'a@b.c', usageStatus: 'relogin_required', usage: null }, NOW), '2  a@b.c  — re-login');
  assert.equal(U.menuLabel({ number: 2, email: 'a@b.c', usageStatus: 'api_key', usage: null }, NOW), '2  a@b.c  — API key');
  assert.equal(U.menuLabel({ number: 4, usage: null }, NOW, de), '4  Konto 4');
});

test('trayInfo in ru and de: title, tooltip and every phase', () => {
  const state = { phase: 'ok', accounts: [paceRow] };
  const info = U.trayInfo(state, NOW, { mode: 'both' }, de);
  assert.equal(info.title, '100 % · 62 %');
  assert.equal(info.level, 'crit');
  assert.equal(info.tooltip, 'contact@example.com · 5 Std. 100 % · 7 T 62 % (über Plan)');
  assert.equal(U.trayInfo(state, NOW, { mode: 'both' }, ru).tooltip, 'contact@example.com · 5 ч 100% · 7 дн 62% (опережает график)');
  const failing = { ...state, error: { kind: 'timeout', message: 'cswap did not answer in time' }, fetchedAt: '2026-09-29T09:00:00Z' };
  assert.equal(U.trayInfo(failing, NOW, { mode: '7d' }, de).title, '62 %?');
  assert.match(U.trayInfo(failing, NOW, {}, de).tooltip, / · seit 3 Std\. nicht aktualisiert$/);
  assert.match(U.trayInfo({ ...state, accounts: [{ ...offRow, active: true }] }, NOW, {}, ru).tooltip, /^e@x · 5 ч: лимит обновился, ждём свежих данных · устарело$/);
  const aged = { phase: 'ok', accounts: [{ active: true, email: 'a@b.c', usageStatus: 'ok', usage: fresh, usageAgeSeconds: 540 }] };
  assert.equal(U.trayInfo(aged, Date.parse('2026-09-29T12:00:00Z'), {}, ru).tooltip, 'a@b.c · 5 ч 20% · 7 дн 34% · замер 9 мин назад');
  assert.equal(U.trayInfo({ phase: 'ok', accounts: [{ active: true, number: 3, usage: fresh }] }, NOW, { showName: true, mode: 'off' }, de).title, 'Konto 3');
  const phases = (tr) => [
    U.trayInfo(null, NOW, {}, tr).tooltip,
    U.trayInfo({ phase: 'missing' }, NOW, {}, tr).tooltip,
    U.trayInfo({ phase: 'no-accounts' }, NOW, {}, tr).tooltip,
    U.trayInfo({ phase: 'error', error: { message: 'boom' } }, NOW, {}, tr).tooltip,
    U.trayInfo({ phase: 'error' }, NOW, {}, tr).tooltip,
    U.trayInfo({ phase: 'ok', accounts: [] }, NOW, {}, tr).tooltip,
  ];
  assert.deepEqual(phases(ru), [
    'Аккаунты Claude — загрузка…',
    'claude-swap нужно настроить',
    'В claude-swap пока нет аккаунтов',
    'claude-swap: boom',
    'claude-swap: Неизвестная ошибка',
    'Нет активного аккаунта',
  ]);
  assert.deepEqual(phases(undefined), [
    'Claude accounts — loading…',
    'claude-swap needs setup',
    'No accounts in claude-swap yet',
    'claude-swap: boom',
    'claude-swap: Unknown error',
    'No active account',
  ]);
  // the translator may also come in opts, as main's ctx.t (no .lang)
  const ctxT = (key, vars) => de(key, vars);
  assert.equal(U.trayInfo(state, NOW, { mode: 'both', t: ctxT }).title, '100 % · 62 %');
  assert.equal(U.trayInfo(state, NOW, { t: ru }, de).tooltip, info.tooltip.replace(/ · 7 T.*/, ' · 7 T 62 % (über Plan)'), 'the argument wins over opts.t');
});

// Built from local fields, so these hold in any time zone.
const local = (d, h, m) => new Date(2026, 9, d, h, m); // October 2026; the 2nd is a Friday
const cswapIso = (d) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1140+00:00');
const lineState = (five, seven) => ({
  phase: 'ok',
  accounts: [{ active: true, email: 'a@b.c', usageStatus: 'ok', usage: { fiveHour: five, sevenDay: seven } }],
});

test('trayInfo tooltipLines: reset times under the first line (PLAN §4.3)', () => {
  const now = local(2, 12, 0).getTime();
  const state = lineState({ pct: 20.4, resetsAt: cswapIso(local(2, 15, 59)) }, { pct: 34, resetsAt: cswapIso(local(6, 9, 5)) });
  const lines = (opts, tr) => U.trayInfo(state, now, opts, tr).tooltipLines.map(plain);
  assert.deepEqual(lines({ locale: 'en-US' }), ['Session: 20% · resets at 3:59 PM', 'Week: 34% · resets Oct 6']);
  assert.deepEqual(lines({}), ['Session: 20% · resets at 3:59 PM', 'Week: 34% · resets Oct 6'], 'English defaults to en-US');
  assert.deepEqual(lines({ locale: 'en-GB' }), ['Session: 20% · resets at 15:59', 'Week: 34% · resets 6 Oct']);
  assert.deepEqual(lines({ locale: 'en-US', hour12: false, weeklyDateFormat: 'date-day' }), ['Session: 20% · resets at 15:59', 'Week: 34% · resets Tue, Oct 6']);
  assert.deepEqual(lines({ locale: 'en-US', hour12: true, weeklyDateFormat: 'date-day-time' }), ['Session: 20% · resets at 3:59 PM', 'Week: 34% · resets Tue, Oct 6, 9:05 AM']);
  assert.deepEqual(lines({ locale: 'ru-RU' }, ru), ['Сессия: 20% · обновится в 15:59', 'Неделя: 34% · обновится 6 окт.']);
  assert.deepEqual(lines({}, ru), ['Сессия: 20% · обновится в 15:59', 'Неделя: 34% · обновится 6 окт.'], 'the translator’s language picks the locale');
  assert.deepEqual(lines({ locale: 'de-DE', weeklyDateFormat: 'date-day-time' }, de), ['Sitzung: 20 % · Reset um 15:59', 'Woche: 34 % · Reset Di., 6. Okt., 09:05']);
  assert.deepEqual(lines({ locale: 'de-DE' }, (k, v) => de(k, v)), ['Sitzung: 20 % · Reset um 15:59', 'Woche: 34 % · Reset 6. Okt.'], 'a wrapper without .lang');
  // line 1 is unchanged
  assert.equal(U.trayInfo(state, now).tooltip, 'a@b.c · 5h 20% · 7d 34%');
  assert.equal(U.trayInfo(state, now).title, '20%');
});

test('trayInfo tooltipLines: only windows with a reset still ahead, absent when there is none', () => {
  const now = local(2, 12, 0).getTime();
  const later = cswapIso(local(2, 15, 59));
  const week = cswapIso(local(6, 9, 5));
  const lines = (five, seven) => U.trayInfo(lineState(five, seven), now, { locale: 'en-US' }).tooltipLines;
  // the 5h window rolled over: the first line already says so
  assert.deepEqual(lines({ pct: 96, resetsAt: cswapIso(local(2, 11, 0)) }, { pct: 34, resetsAt: week }).map(plain), ['Week: 34% · resets Oct 6']);
  // no reset time (a window that has not started), no pct, or an unreadable time
  assert.deepEqual(lines({ pct: 0, resetsAt: null }, { pct: 34, resetsAt: week }).map(plain), ['Week: 34% · resets Oct 6']);
  assert.deepEqual(lines({ resetsAt: later }, { pct: 34, resetsAt: 'soon' }), undefined);
  assert.equal('tooltipLines' in U.trayInfo(lineState(null, null), now), false);
  assert.equal('tooltipLines' in U.trayInfo({ phase: 'loading' }, now), false);
  // stale last-good data still tells its reset times; line 1 says it is stale
  const stale = { phase: 'ok', accounts: [{ active: true, email: 'a@b.c', usage: null, lastGoodUsage: { fiveHour: { pct: 42, resetsAt: later } } }] };
  const info = U.trayInfo(stale, now, { locale: 'en-US' });
  assert.equal(info.tooltip, 'a@b.c · 5h 42% · stale');
  assert.deepEqual(info.tooltipLines.map(plain), ['Session: 42% · resets at 3:59 PM']);
  // the whole tooltip, as main sets it
  assert.equal(plain([info.tooltip, ...(info.tooltipLines || [])].join('\n')), 'a@b.c · 5h 42% · stale\nSession: 42% · resets at 3:59 PM');
});

// --- accounts without a 5-hour window, Team seats (claude-swap #476), login expiry

const SOON = '2026-09-29T15:00:00.603140+00:00'; // 3 h after NOW
const WEEK_END = '2026-10-01T18:00:00.603140+00:00'; // Oct 1, 54 h after NOW
const PAST = '2026-09-29T11:00:00.603140+00:00';
const win = (pct, resetsAt = WEEK_END, extra = {}) => ({ pct, resetsAt, ...extra });
const model = (name, pct, resetsAt = WEEK_END, extra = {}) => ({ name, pct, resetsAt, ...extra });
const SHAPES = {
  noFive: { sevenDay: win(71), scoped: [model('Fable', 82)] },
  weekOnly: { sevenDay: win(34) },
  team: { fiveHour: win(41, SOON), scoped: [model('Fable', 10)] },
  normal: { fiveHour: win(20, SOON), sevenDay: win(81), scoped: [model('Fable', 95)] },
};
const accountRow = (usage, extra = {}) => ({ number: 1, active: true, email: 'a@b.c', alias: 'work', usageStatus: 'ok', usage, ...extra });
const trayOf = (usage, opts = {}, extra = {}, stateExtra = {}, tr) => U.trayInfo({ phase: 'ok', accounts: [accountRow(usage, extra)], ...stateExtra }, NOW, opts, tr);
const hoursFromNow = (h) => new Date(NOW + h * 3_600_000).toISOString();
const MODES = ['5h', '7d', 'both', 'max', 'off'];
// [title, ring, level] for every mode, in MODES order.
const modes = (usage, extra) => MODES.map((mode) => {
  const info = trayOf(usage, { mode }, extra);
  return [info.title, info.pct, info.level];
});

test('hasPct: a window with a finite number; 0 counts, nothing else does', () => {
  for (const w of [{ pct: 0 }, { pct: 71 }, { pct: 100.5 }]) assert.equal(U.hasPct(w), true, JSON.stringify(w));
  for (const w of [null, undefined, {}, { pct: null }, { pct: '71' }, { pct: NaN }, { pct: Infinity }, 'x', 7]) assert.equal(U.hasPct(w), false, String(w));
});

test('modelWindows: only numbers, fullest first, ties in cswap’s order, the input untouched', () => {
  const a = model('A', 10);
  const b = model('B', 82);
  const c = model('C', 10);
  const zero = model('Zero', 0);
  const scoped = [a, null, b, { name: 'NoPct' }, c, 'junk', { name: 'Text', pct: '90' }, zero];
  assert.deepEqual(U.modelWindows({ scoped }), [b, a, c, zero]);
  assert.equal(scoped[0], a, 'the list cswap sent keeps its order');
  for (const usage of [null, undefined, {}, { scoped: null }, { scoped: 'x' }, { scoped: {} }]) assert.deepEqual(U.modelWindows(usage), []);
});

test('mainWindows: every row of the table', () => {
  const five = win(20, SOON);
  const seven = win(34);
  const fable = model('Fable', 82);
  const opus = model('Opus', 30);
  const third = model('Third', 5);
  const shape = (usage) => {
    const { shown, rest } = U.mainWindows(usage);
    return { shown: shown.map((s) => (s.kind === 'model' ? `model:${s.name}` : s.kind)), rest: rest.map((w) => w.name) };
  };
  // 5h + 7d: as ever, the models stay in rest
  assert.deepEqual(shape({ fiveHour: five, sevenDay: seven }), { shown: ['5h', '7d'], rest: [] });
  assert.deepEqual(shape({ fiveHour: five, sevenDay: seven, scoped: [opus, fable] }), { shown: ['5h', '7d'], rest: ['Fable', 'Opus'] });
  // 5h, no 7d, model: a Team seat
  assert.deepEqual(shape({ fiveHour: five, scoped: [opus, fable] }), { shown: ['5h', 'model:Fable'], rest: ['Opus'] });
  // 5h only
  assert.deepEqual(shape({ fiveHour: five }), { shown: ['5h'], rest: [] });
  // 7d + model, no 5h: the week keeps its place on the right
  assert.deepEqual(shape({ sevenDay: seven, scoped: [fable] }), { shown: ['model:Fable', '7d'], rest: [] });
  assert.deepEqual(shape({ sevenDay: seven, scoped: [opus, third, fable] }), { shown: ['model:Fable', '7d'], rest: ['Opus', 'Third'] });
  // 7d only
  assert.deepEqual(shape({ sevenDay: seven }), { shown: ['7d'], rest: [] });
  // models only
  assert.deepEqual(shape({ scoped: [opus, third, fable] }), { shown: ['model:Fable', 'model:Opus'], rest: ['Third'] });
  assert.deepEqual(shape({ scoped: [fable] }), { shown: ['model:Fable'], rest: [] });
  // nothing
  for (const usage of [null, undefined, {}, { spend: { pct: 5 } }, { scoped: [] }]) assert.deepEqual(shape(usage), { shown: [], rest: [] });
  // A window with no number is missing, whatever else it has
  assert.deepEqual(shape({ fiveHour: { resetsAt: SOON }, sevenDay: seven }), { shown: ['7d'], rest: [] });
  assert.deepEqual(shape({ fiveHour: five, sevenDay: { pct: null }, scoped: [{ name: 'NoPct' }] }), { shown: ['5h'], rest: [] });
  // An idle 5-hour window is a window: 0 % without a reset time
  assert.deepEqual(shape({ fiveHour: { pct: 0 }, sevenDay: seven, scoped: [fable] }), { shown: ['5h', '7d'], rest: ['Fable'] });
});

test('mainWindows: slots carry the window itself, and a name only for a model', () => {
  const seven = win(34);
  const fable = model('Fable', 82);
  assert.deepEqual(U.mainWindows({ sevenDay: seven, scoped: [fable] }).shown, [
    { kind: 'model', win: fable, name: 'Fable' },
    { kind: '7d', win: seven },
  ]);
  assert.equal(U.mainWindows({ scoped: [{ pct: 5 }] }).shown[0].name, '?', 'a window without a name');
  assert.deepEqual(U.mainWindows({ fiveHour: { pct: 0 } }).shown, [{ kind: '5h', win: { pct: 0 } }]);
});

test('noSessionLimit: only fresh data that has limits and no 5-hour window claims it', () => {
  assert.equal(U.noSessionLimit({ usage: SHAPES.noFive }), true);
  assert.equal(U.noSessionLimit({ usage: SHAPES.weekOnly }), true);
  assert.equal(U.noSessionLimit({ usage: { scoped: [model('Fable', 0)] } }), true);
  assert.equal(U.noSessionLimit({ usage: { fiveHour: null, sevenDay: win(1) } }), true);
  // stale data shows what it has and claims nothing
  assert.equal(U.noSessionLimit({ usage: null, lastGoodUsage: SHAPES.noFive, lastGoodAgeSeconds: 216000 }), false);
  // an idle 5-hour window is a 5-hour window
  assert.equal(U.noSessionLimit({ usage: { fiveHour: { pct: 0 }, sevenDay: win(1) } }), false);
  assert.equal(U.noSessionLimit({ usage: SHAPES.team }), false);
  assert.equal(U.noSessionLimit({ usage: SHAPES.normal }), false);
  // cswap sent a window, only without a number: not ours to deny
  assert.equal(U.noSessionLimit({ usage: { fiveHour: { resetsAt: SOON }, sevenDay: win(1) } }), false);
  // nothing to go on
  for (const row of [null, undefined, {}, { usage: null }, { usage: {} }, { usage: { spend: { pct: 5 } } }, { usage: { sevenDay: { resetsAt: SOON } } }]) {
    assert.equal(U.noSessionLimit(row), false, JSON.stringify(row));
  }
});

test('loginExpiry: from 3 days ahead, urgent under 24 h, expired from the moment itself', () => {
  const at = (seconds) => new Date(NOW + seconds * 1000).toISOString();
  const read = (seconds) => U.loginExpiry({ loginExpiresAt: at(seconds) }, NOW);
  assert.equal(U.LOGIN_WARN_S, 3 * 86400);
  assert.equal(U.LOGIN_URGENT_S, 86400);
  assert.equal(read(3 * 86400 + 1), null, 'just outside 3 days');
  assert.equal(read(3 * 86400), null, 'exactly 3 days is not less than 3 days');
  assert.deepEqual(read(3 * 86400 - 1), { at: NOW + (3 * 86400 - 1) * 1000, seconds: 3 * 86400 - 1, expired: false, urgent: false }, 'just inside');
  assert.deepEqual(read(86400), { at: NOW + 86400 * 1000, seconds: 86400, expired: false, urgent: false }, 'exactly 24 h is not urgent yet');
  assert.deepEqual(read(86399), { at: NOW + 86399 * 1000, seconds: 86399, expired: false, urgent: true }, 'just under 24 h');
  assert.deepEqual(read(1), { at: NOW + 1000, seconds: 1, expired: false, urgent: true });
  assert.deepEqual(read(0), { at: NOW, seconds: 0, expired: true, urgent: true }, 'the moment itself');
  assert.deepEqual(read(-172800), { at: NOW - 172800000, seconds: 0, expired: true, urgent: true }, 'seconds never go negative');
  // cswap writes whole seconds with Z
  assert.equal(U.loginExpiry({ loginExpiresAt: '2026-09-30T12:00:00Z' }, NOW).seconds, 86400);
  for (const raw of [undefined, null, '', 'soon', 'not a date', 1790000000000, {}, true]) {
    assert.equal(U.loginExpiry({ loginExpiresAt: raw }, NOW), null, String(raw));
  }
  assert.equal(U.loginExpiry(null, NOW), null);
  assert.equal(U.loginExpiry({}, NOW), null);
});

test('badges: the login pill follows the status, in amber then red', () => {
  const login = (h, extra = {}) => U.badges({ number: 3, usageStatus: 'ok', usage: fresh, loginExpiresAt: hoursFromNow(h), ...extra }, undefined, NOW).find((b) => b.key === 'login');
  const title = 'Log in to this account again in Claude Code, then run: cswap add --slot 3';
  assert.equal(login(72), undefined, 'not yet');
  assert.deepEqual(login(60), { key: 'login', label: 'Login expires in 2d 12h', tone: 'warn', title });
  assert.deepEqual(login(24), { key: 'login', label: 'Login expires in 1d', tone: 'warn', title });
  assert.deepEqual(login(10), { key: 'login', label: 'Login expires in 10h', tone: 'crit', title }, 'red under 24 h');
  assert.deepEqual(login(-48), { key: 'login', label: 'Login expired', tone: 'crit', title });
  // Those statuses already say it, there is no login to lapse, or the date is another account's
  for (const usageStatus of ['relogin_required', 'no_credentials', 'api_key', 'foreign_credential']) {
    assert.equal(login(10, { usageStatus }), undefined, usageStatus);
    assert.equal(login(-48, { usageStatus }), undefined, usageStatus);
  }
  for (const usageStatus of ['token_expired', 'keychain_unavailable', 'unavailable', 'rate_limited_by_moon']) {
    assert.ok(login(10, { usageStatus }), usageStatus);
  }
  // Right after the status badge
  const keys = U.badges({ number: 3, active: true, usageStatus: 'token_expired', usage: null, lastGoodUsage: fresh, loginExpiresAt: hoursFromNow(60) }, undefined, NOW).map((b) => b.key);
  assert.deepEqual(keys, ['active', 'token_expired', 'login', 'stale']);
  // Two arguments: the real clock
  assert.equal(U.badges({ number: 3, usage: fresh, loginExpiresAt: new Date(Date.now() + 10 * 3_600_000).toISOString() }).find((b) => b.key === 'login').tone, 'crit');
  assert.equal(U.badges({ number: 3, usage: fresh, loginExpiresAt: '2020-01-01T00:00:00Z' })[0].label, 'Login expired');
  // In the translator's language
  const tip = U.badges({ number: 3, usage: fresh, loginExpiresAt: hoursFromNow(60) }, ru, NOW)[0];
  assert.equal(tip.label, 'Срок действия входа истекает через 2 д 12 ч');
  assert.equal(tip.title, 'Войдите в этот аккаунт заново в Claude Code, затем выполните: cswap add --slot 3');
  assert.equal(U.badges({ number: 3, usage: fresh, loginExpiresAt: hoursFromNow(-1) }, de, NOW)[0].label, 'Anmeldung abgelaufen');
});

test('menuLabel: the login note after the status, before stale; disabled rows keep it', () => {
  const line = (extra, tr) => U.menuLabel({ number: 2, email: 'b@x', usageStatus: 'ok', usage: null, ...extra }, NOW, tr);
  assert.equal(line({ loginExpiresAt: hoursFromNow(60) }), '2  b@x  — login expires in 2d 12h');
  assert.equal(line({ loginExpiresAt: hoursFromNow(-1) }), '2  b@x  — login expired');
  assert.equal(line({ loginExpiresAt: hoursFromNow(100) }), '2  b@x');
  assert.equal(line({ disabled: true, usageStatus: 'token_expired', lastGoodUsage: { sevenDay: win(33) }, loginExpiresAt: hoursFromNow(10) }), '2  b@x  7d 33% (2d 6h)  — disabled, token expired, login expires in 10h, stale');
  for (const usageStatus of ['relogin_required', 'no_credentials', 'api_key', 'foreign_credential']) {
    assert.doesNotMatch(line({ usageStatus, loginExpiresAt: hoursFromNow(-1) }), /login expire/, usageStatus);
  }
  assert.equal(line({ loginExpiresAt: hoursFromNow(10) }, ru), '2  b@x  — срок действия входа истекает через 10 ч');
  assert.equal(line({ loginExpiresAt: hoursFromNow(-1) }, de), '2  b@x  — Anmeldung abgelaufen');
});

test('trayInfo, no 5-hour window: every mode reads the week; max the fullest; the colour follows the fullest', () => {
  assert.deepEqual(modes(SHAPES.noFive), [
    ['71%', 71, 'warn'], // 5h: never "–"
    ['71%', 71, 'warn'],
    ['71%', 71, 'warn'], // both: never "– · 71%"
    ['82%', 82, 'warn'], // max: the highest of the week and every model
    ['', 71, 'warn'], // off: no text, the ring is the week
  ]);
  assert.equal(trayOf(SHAPES.noFive).tooltip, 'work · 7d 71% · Fable 82% · no 5-hour limit');
  // the name stays in front
  assert.equal(trayOf(SHAPES.noFive, { showName: true }).title, 'work 71%');
  assert.equal(trayOf(SHAPES.noFive, { mode: 'off', showName: true }).title, 'work');
  // a 5-hour window without a number counts as missing here too
  assert.deepEqual(modes({ ...SHAPES.noFive, fiveHour: { resetsAt: SOON } })[0], ['71%', 71, 'warn']);
});

test('trayInfo, week only: no dash, no model, the plain level', () => {
  assert.deepEqual(modes(SHAPES.weekOnly), [
    ['34%', 34, 'ok'],
    ['34%', 34, 'ok'],
    ['34%', 34, 'ok'],
    ['34%', 34, 'ok'],
    ['', 34, 'ok'],
  ]);
  assert.equal(trayOf(SHAPES.weekOnly).tooltip, 'work · 7d 34% · no 5-hour limit');
  assert.equal(trayOf({ sevenDay: win(95) }).level, 'crit');
});

test('trayInfo, models only: the fullest stands in for the week', () => {
  const usage = { scoped: [model('Opus', 30), model('Fable', 82), model('Sonnet', 12)] };
  assert.deepEqual(modes(usage), [
    ['82%', 82, 'warn'],
    ['82%', 82, 'warn'],
    ['82%', 82, 'warn'],
    ['82%', 82, 'warn'],
    ['', 82, 'warn'],
  ]);
  assert.equal(trayOf(usage).tooltip, 'work · Fable 82% · Opus 30% · Sonnet 12% · no 5-hour limit');
});

test('trayInfo, Team seat (5h, no 7d): 7d, both and max read the model; 5h and off stay on the 5h', () => {
  assert.deepEqual(modes(SHAPES.team), [
    ['41%', 41, 'ok'],
    ['10%', 10, 'ok'],
    ['41% · 10%', 41, 'ok'],
    ['41%', 41, 'ok'],
    ['', 41, 'ok'],
  ]);
  assert.equal(trayOf(SHAPES.team).tooltip, 'work · 5h 41% · Fable 10%', 'it has a 5-hour window: nothing about one missing');
  const hot = { fiveHour: win(41, SOON), scoped: [model('Fable', 80), model('Opus', 5)] };
  assert.deepEqual(modes(hot), [
    ['41%', 41, 'ok'],
    ['80%', 80, 'warn'],
    ['41% · 80%', 41, 'warn'],
    ['80%', 80, 'warn'],
    ['', 41, 'ok'],
  ]);
  assert.equal(trayOf({ fiveHour: win(41, SOON), scoped: [model('Fable', 0)] }, { mode: 'both' }).title, '41% · 0%', 'a 0 is a number');
});

test('trayInfo, the default shape: models stay out of the title, the level and the tooltip', () => {
  assert.deepEqual(modes(SHAPES.normal), [
    ['20%', 20, 'ok'],
    ['81%', 81, 'warn'],
    ['20% · 81%', 20, 'warn'],
    ['81%', 81, 'warn'],
    ['', 20, 'ok'],
  ]);
  const info = trayOf(SHAPES.normal, { locale: 'en-US' });
  assert.equal(info.tooltip, 'work · 5h 20% · 7d 81%');
  assert.equal(info.tooltipLines.length, 2, 'the session and the week, no model line');
  assert.match(plain(info.tooltipLines[1]), /^Week: 81% · resets /);
  // 5h only stays what it was, "–" for the missing week
  assert.deepEqual(modes({ fiveHour: win(41, SOON) })[2], ['41% · –', 41, 'ok']);
  // no windows at all: as ever
  for (const usage of [null, {}, { spend: { pct: 5 } }, { sevenDay: { resetsAt: SOON } }]) {
    assert.deepEqual(modes(usage), MODES.map((mode) => [mode === 'off' ? '' : mode === 'both' ? '– · –' : '–', null, 'none']), JSON.stringify(usage));
    assert.equal(trayOf(usage).tooltip, 'work', JSON.stringify(usage));
  }
});

test('trayInfo: a rolled-over window keeps its text and stops counting', () => {
  // The model has rolled over: it does not colour, and max does not read it
  const fableGone = { sevenDay: win(40), scoped: [model('Fable', 95, PAST)] };
  assert.deepEqual(modes(fableGone), [
    ['40%', 40, 'ok'],
    ['40%', 40, 'ok'],
    ['40%', 40, 'ok'],
    ['40%', 40, 'ok'],
    ['', 40, 'ok'],
  ]);
  assert.equal(trayOf(fableGone).tooltip, 'work · 7d 40% · Fable window has reset, waiting for new data · no 5-hour limit');
  // The week has rolled over, the model has not
  const weekGone = { sevenDay: win(95, PAST), scoped: [model('Fable', 80)] };
  assert.deepEqual(modes(weekGone), [
    ['–', null, 'warn'],
    ['–', null, 'warn'],
    ['–', null, 'warn'],
    ['80%', 80, 'warn'],
    ['', null, 'warn'],
  ]);
  assert.equal(trayOf(weekGone).tooltip, 'work · 7d window has reset, waiting for new data · Fable 80% · no 5-hour limit');
  // Everything has rolled over
  const allGone = { sevenDay: win(95, PAST), scoped: [model('Fable', 95, PAST)] };
  assert.deepEqual(modes(allGone)[3], ['–', null, 'none']);
  // Team seat whose model has rolled over
  assert.deepEqual(trayOf({ fiveHour: win(41, SOON), scoped: [model('Fable', 95, PAST)] }, { mode: 'both' }).title, '41% · –');
  assert.equal(trayOf({ fiveHour: win(41, SOON), scoped: [model('Fable', 95, PAST)] }).tooltip, 'work · 5h 41% · Fable window has reset, waiting for new data');
});

test('trayInfo: the level is the highest of the week and the live models, whichever mode', () => {
  assert.equal(trayOf({ sevenDay: win(20), scoped: [model('Fable', 90)] }).level, 'crit');
  assert.equal(trayOf({ sevenDay: win(20), scoped: [model('Fable', 74.5)] }).level, 'warn', 'reads 75');
  assert.equal(trayOf({ sevenDay: win(95), scoped: [model('Fable', 20)] }).level, 'crit');
  assert.equal(trayOf({ sevenDay: win(20), scoped: [model('Fable', 74.4)] }).level, 'ok', 'reads 74');
  assert.equal(trayOf({ sevenDay: win(20), scoped: [model('Fable', 95, PAST), model('Opus', 80)] }).level, 'warn', 'not from the rolled-over one');
});

test('trayInfo: doubt marker, stale and aged as ever on the new shapes; stale claims nothing', () => {
  const failing = { error: { kind: 'timeout', message: 'x' }, fetchedAt: '2026-09-29T09:00:00Z' };
  const info = trayOf(SHAPES.noFive, {}, {}, failing);
  assert.equal(info.title, '71%?');
  assert.equal(info.tooltip, 'work · 7d 71% · Fable 82% · no 5-hour limit · not updated for 3h');
  assert.equal(trayOf(SHAPES.noFive, { mode: 'off' }, {}, failing).title, '', 'off has no text to mark');
  const stale = trayOf(null, {}, { lastGoodUsage: SHAPES.noFive, lastGoodAgeSeconds: 216000, usageStatus: 'token_expired' });
  assert.equal(stale.title, '71%?');
  assert.equal(stale.pct, 71);
  assert.equal(stale.level, 'warn');
  assert.equal(stale.tooltip, 'work · 7d 71% · Fable 82% · stale');
  assert.equal(trayOf(SHAPES.weekOnly, {}, { usageAgeSeconds: 540 }).tooltip, 'work · 7d 34% · no 5-hour limit · 9m old');
  // the pace mark goes on any window that has one
  assert.equal(trayOf({ sevenDay: win(71, WEEK_END, { aheadOfPace: true }), scoped: [model('Fable', 82, WEEK_END, { aheadOfPace: true })] }).tooltip, 'work · 7d 71% (ahead of pace) · Fable 82% (ahead of pace) · no 5-hour limit');
});

test('trayInfo: the first line ends with the login, under the conditions of the badge', () => {
  const tip = (h, extra, usage = SHAPES.noFive) => trayOf(usage, {}, { loginExpiresAt: hoursFromNow(h), ...extra }).tooltip;
  assert.equal(tip(60), 'work · 7d 71% · Fable 82% · no 5-hour limit · login expires in 2d 12h');
  assert.equal(tip(-1), 'work · 7d 71% · Fable 82% · no 5-hour limit · login expired');
  assert.equal(tip(100), 'work · 7d 71% · Fable 82% · no 5-hour limit');
  assert.equal(tip(60, {}, SHAPES.normal), 'work · 5h 20% · 7d 81% · login expires in 2d 12h');
  assert.equal(tip(60, { usageAgeSeconds: 540 }), 'work · 7d 71% · Fable 82% · no 5-hour limit · 9m old · login expires in 2d 12h');
  for (const usageStatus of ['relogin_required', 'no_credentials', 'api_key', 'foreign_credential']) {
    assert.doesNotMatch(tip(-1, { usageStatus }), /login expire/, usageStatus);
  }
  assert.equal(trayOf(SHAPES.normal, {}, { loginExpiresAt: hoursFromNow(60) }, {}, ru).tooltip, 'work · 5 ч 20% · 7 дн 81% · срок действия входа истекает через 2 д 12 ч');
  assert.equal(trayOf(SHAPES.normal, {}, { loginExpiresAt: hoursFromNow(-1) }, {}, de).tooltip, 'work · 5 Std. 20 % · 7 T 81 % · Anmeldung abgelaufen');
  // only the active account is on this line
  const other = accountRow(SHAPES.normal, { active: false, loginExpiresAt: hoursFromNow(-1) });
  assert.equal(U.trayInfo({ phase: 'ok', accounts: [other, accountRow(SHAPES.normal)] }, NOW).tooltip, 'work · 5h 20% · 7d 81%');
});

test('trayInfo: a login that is gone is still on the first line, as re-login', () => {
  const walk = (extra, usage = SHAPES.normal, tr) => trayOf(usage, {}, extra, {}, tr).tooltip;
  const gone = { usageStatus: 'relogin_required', loginExpiresAt: hoursFromNow(-3) };
  const lastGood = { ...gone, lastGoodUsage: SHAPES.normal, lastGoodAgeSeconds: 300 };
  // The lapse from start to end: it never stops being said.
  assert.equal(walk({ loginExpiresAt: hoursFromNow(1) }), 'work · 5h 20% · 7d 81% · login expires in 1h');
  assert.equal(walk({ loginExpiresAt: hoursFromNow(-1) }), 'work · 5h 20% · 7d 81% · login expired');
  assert.equal(walk(lastGood, null), 'work · 5h 20% · 7d 81% · stale · re-login');
  // With nothing left to show it is all the tooltip has to say.
  assert.equal(walk(gone, null), 'work · re-login');
  assert.equal(walk(lastGood, null, ru), 'work · 5 ч 20% · 7 дн 81% · устарело · нужен вход');
  assert.equal(walk(lastGood, null, de), 'work · 5 Std. 20 % · 7 T 81 % · veraltet · Anmeldung nötig');
  // Other statuses keep their tooltip.
  assert.equal(walk({ usageStatus: 'token_expired' }), 'work · 5h 20% · 7d 81%');
});

test('trayInfo tooltipLines: one line per model with its reset ahead, only where a model stands in', () => {
  const lines = (usage, opts = {}, tr) => (trayOf(usage, { locale: 'en-US', ...opts }, {}, {}, tr).tooltipLines || []).map(plain);
  const [week, fable, ...more] = lines(SHAPES.noFive);
  assert.match(week, /^Week: 71% · resets [A-Z][a-z]{2} \d{1,2}$/);
  assert.match(fable, /^Fable: 82% · resets [A-Z][a-z]{2} \d{1,2}$/);
  assert.deepEqual(more, []);
  // several, fullest first; a rolled-over one is already in the first line, one with no date has none
  const many = lines({ sevenDay: win(10), scoped: [model('Opus', 30), model('Gone', 99, PAST), model('Fable', 82), model('NoReset', 5, null)] });
  assert.deepEqual(many.map((l) => l.split(' · ')[0]), ['Week: 10%', 'Fable: 82%', 'Opus: 30%']);
  // Team seat: under the session line
  const team = lines(SHAPES.team);
  assert.equal(team.length, 2);
  assert.match(team[0], /^Session: 41% · resets at /);
  assert.match(team[1], /^Fable: 10% · resets /);
  // the week's date format applies, in the language of the rest
  assert.match(lines(SHAPES.noFive, { weeklyDateFormat: 'date-day' })[1], /^Fable: 82% · resets [A-Z][a-z]{2}, /);
  assert.match(lines(SHAPES.noFive, { locale: 'de-DE' }, de)[1], /^Fable: 82 % · Reset /);
  assert.match(lines(SHAPES.noFive, { locale: 'ru-RU' }, ru)[1], /^Fable: 82% · обновится /);
  // a window without a date has no line
  assert.deepEqual(lines({ sevenDay: { pct: 10 }, scoped: [{ name: 'Fable', pct: 20 }] }), []);
  // the same for stale data: its first line says so
  const stale = trayOf(null, { locale: 'en-US' }, { lastGoodUsage: SHAPES.noFive });
  assert.equal(stale.tooltipLines.length, 2);
});

// --- the same English without i18n.js (today's index.html loads usage.js alone)

const USAGE_SRC = fs.readFileSync(path.join(__dirname, '../src/shared/usage.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(__dirname, '../src/shared/i18n.js'), 'utf8');

// Rows and states that reach every string usage.js has.
function scenarios() {
  const now = NOW;
  const rows = [
    paceRow,
    offRow,
    { ...offRow, lastGoodAgeSeconds: 5400 },
    { number: 7, usageStatus: 'ok', usage: fresh, usageAgeSeconds: 540 },
    { number: 8, alias: 'work', active: true, usageStatus: 'ok', usage: { sevenDay: { pct: 90, aheadOfPace: true } } },
    { number: 9, email: 'z@z', usageStatus: 'rate_limited_by_moon', usage: null },
    ...STATUSES.map((st, i) => ({ number: 10 + i, email: `${st}@x`, usageStatus: st, usage: null })),
    accountRow(SHAPES.noFive, { number: 20, loginExpiresAt: hoursFromNow(60) }),
    accountRow(SHAPES.weekOnly, { number: 21, loginExpiresAt: hoursFromNow(10) }),
    accountRow(SHAPES.team, { number: 22, loginExpiresAt: hoursFromNow(-1) }),
    accountRow(SHAPES.normal, { number: 23 }),
  ];
  const states = [
    null,
    { phase: 'loading' },
    { phase: 'missing' },
    { phase: 'too-old' },
    { phase: 'no-accounts' },
    { phase: 'error', error: { message: 'x' } },
    { phase: 'error' },
    { phase: 'ok', accounts: [] },
    { phase: 'ok', accounts: [paceRow] },
    { phase: 'ok', accounts: [{ ...offRow, active: true }] },
    { phase: 'ok', accounts: [{ ...rows[3], active: true }], error: { message: 'x' }, fetchedAt: '2026-09-29T09:00:00Z' },
    { phase: 'ok', accounts: [{ ...rows[3], active: true }], error: { message: 'x' } },
    { phase: 'ok', accounts: [accountRow(SHAPES.noFive, { loginExpiresAt: hoursFromNow(60) })] },
    { phase: 'ok', accounts: [accountRow(SHAPES.weekOnly, { loginExpiresAt: hoursFromNow(-1) })] },
    { phase: 'ok', accounts: [accountRow(SHAPES.team)] },
  ];
  return { now, rows, states };
}

function everything(Usage, tr) {
  const { now, rows, states } = scenarios();
  const out = [];
  for (const row of rows) {
    out.push(Usage.badges(row, tr, now), Usage.menuLabel(row, now, tr), Usage.label(row, tr), Usage.shortName(row, tr));
    out.push(Usage.paceNote(row.usage && row.usage.sevenDay, tr));
  }
  for (const s of [0, 45, 720, 5400, 7200, 3 * 86400 + 4 * 3600, 86400]) out.push(Usage.formatDuration(s, tr));
  for (const state of states) {
    for (const mode of ['5h', '7d', 'both', 'max', 'off']) {
      const { tooltipLines, ...info } = Usage.trayInfo(state, now, { mode, showName: true }, tr);
      out.push(info);
    }
  }
  return JSON.parse(JSON.stringify(out));
}

test('every key usage.js asks for is in the dictionary', () => {
  const asked = new Set();
  const recorder = (key, vars) => {
    asked.add(key);
    return I18n.translator('en')(key, vars);
  };
  everything(U, recorder);
  const later = local(2, 15, 59);
  U.trayInfo(lineState({ pct: 1, resetsAt: cswapIso(later) }, { pct: 2, resetsAt: cswapIso(later) }), local(2, 12, 0).getTime(), {}, recorder);
  const missing = [...asked].filter((key) => !(key in I18n.STRINGS.en));
  assert.deepEqual(missing, []);
  assert.ok(asked.size >= 60, `asked for ${asked.size} keys`);
  for (const key of ['trayTip.session', 'trayTip.week', 'reset.at', 'reset.on', 'menuLine.api_key', 'badge.tip.paceExpected']) assert.ok(asked.has(key), key);
});

test('as a classic script without i18n.js: one global, and the same English', () => {
  const alone = {};
  vm.runInNewContext(USAGE_SRC, alone);
  assert.deepEqual(Object.keys(alone), ['Usage']);
  assert.deepEqual(everything(alone.Usage), everything(U), 'the built-in English equals I18n.STRINGS.en');
  assert.equal(alone.Usage.WARN, 75);
  assert.equal(alone.Usage.CRIT, 90);
  // an explicit translator still works; only the reset lines need i18n.js
  assert.equal(alone.Usage.menuLabel(offRow, NOW, de), '5  e@x  5 Std.: zurückgesetzt  — deaktiviert, Token abgelaufen, veraltet');
  const later = cswapIso(local(2, 15, 59));
  const state = lineState({ pct: 20, resetsAt: later }, { pct: 34, resetsAt: later });
  assert.equal('tooltipLines' in alone.Usage.trayInfo(state, local(2, 12, 0).getTime()), false);
});

test('as a classic script after i18n.js: it uses window.I18n', () => {
  const page = {};
  vm.runInNewContext(I18N_SRC, page);
  vm.runInNewContext(USAGE_SRC, page);
  assert.deepEqual(Object.keys(page), ['I18n', 'Usage']);
  assert.equal(page.Usage.menuLabel(offRow, NOW, 'de'), '5  e@x  5 Std.: zurückgesetzt  — deaktiviert, Token abgelaufen, veraltet');
  assert.deepEqual(everything(page.Usage), everything(U));
  const later = cswapIso(local(2, 15, 59));
  const state = lineState({ pct: 20, resetsAt: later }, { pct: 34, resetsAt: cswapIso(local(6, 9, 5)) });
  assert.deepEqual(Array.from(page.Usage.trayInfo(state, local(2, 12, 0).getTime(), { locale: 'en-US' }).tooltipLines, plain), ['Session: 20% · resets at 3:59 PM', 'Week: 34% · resets Oct 6']);
});

test('the English of the new keys, with i18n.js and without', () => {
  const alone = {};
  vm.runInNewContext(USAGE_SRC, alone);
  const row = accountRow(SHAPES.noFive, { loginExpiresAt: hoursFromNow(10) });
  const expired = accountRow(SHAPES.noFive, { loginExpiresAt: hoursFromNow(-1) });
  for (const r of [row, expired]) {
    assert.deepEqual(JSON.parse(JSON.stringify(alone.Usage.badges(r, undefined, NOW))), U.badges(r, undefined, NOW));
    assert.equal(alone.Usage.menuLabel(r, NOW), U.menuLabel(r, NOW));
    assert.equal(alone.Usage.trayInfo({ phase: 'ok', accounts: [r] }, NOW).tooltip, U.trayInfo({ phase: 'ok', accounts: [r] }, NOW).tooltip);
  }
  assert.equal(alone.Usage.trayInfo({ phase: 'ok', accounts: [row] }, NOW).tooltip, 'work · 7d 71% · Fable 82% · no 5-hour limit · login expires in 10h');
});
