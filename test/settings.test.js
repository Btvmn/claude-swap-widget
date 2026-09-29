'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../src/settings');
const { sanitize, loadSettings, saveSettings, publicSettings, rendererPatch, DEFAULTS, RENDERER_KEYS } = S;

const DARWIN_DEFAULTS = { ...DEFAULTS, trayStyle: 'ring' };
const OTHER_DEFAULTS = { ...DEFAULTS, trayStyle: 'classic' };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Valid values survive unchanged; invalid ones give the default and leave every
// other key alone. Checked on darwin, where every tray style is allowed.
const CASES = {
  language: {
    valid: ['system', 'en', 'ru', 'uk', 'de'],
    invalid: ['fr', 'EN', 'en-US', '', null, 1, ['en'], {}],
  },
  trayStyle: {
    valid: ['classic', 'ring', 'bars', 'rings', 'ringsText'],
    invalid: ['Ring', 'rings-text', 'ringstext', '', null, 0, true],
  },
  gaugeStyle: {
    valid: ['rings', 'concentric'],
    invalid: ['ring', 'B', 'compact', '', true, null],
  },
  timeFormat: {
    valid: ['system', '12h', '24h'],
    invalid: ['12', 12, 24, '24H', 'am/pm', '', null],
  },
  weeklyDateFormat: {
    valid: ['date', 'date-day', 'date-day-time'],
    invalid: ['day', 'date-time', 'Date', '', null, 1],
  },
  notifications: {
    valid: [true, false],
    invalid: ['true', 'false', 1, 0, null, {}],
  },
  recordHistory: {
    valid: [true, false],
    invalid: ['yes', 1, 0, null, []],
  },
  statsStyle: {
    valid: ['line', 'bars', 'summary'],
    invalid: ['pie', 'Line', 'bar', '', null],
  },
  statsPeriod: {
    valid: ['day', 'week', 'month'],
    invalid: ['year', 'Day', 'today', 7, '', null],
  },
  statsAccount: {
    valid: [null, '0123456789ab', 'ffffffffffff', '000000000000'],
    invalid: [
      'ABCDEF012345', // upper case
      '0123456789a', // 11
      '0123456789abc', // 13
      '0123456789ag',
      ' 0123456789ab',
      '0123456789ab\n',
      'zzz',
      '',
      123456789012,
      false,
      ['0123456789ab'],
    ],
  },
  heroExpanded: {
    valid: [true, false],
    invalid: ['true', 1, null],
  },
  windowMode: {
    valid: ['popover', 'widget'],
    invalid: ['compact', 'Widget', 'window', '', null, true],
  },
  widgetOnTop: {
    valid: [true, false],
    invalid: ['false', 0, null],
  },
  widgetPosition: {
    valid: [null, { x: 0, y: 0 }, { x: -1440, y: 25 }, { x: 100_000, y: -100_000 }],
    invalid: [
      { x: 1.5, y: 2 },
      { x: '10', y: 2 },
      { x: 1 },
      { y: 1 },
      { x: NaN, y: 0 },
      { x: Infinity, y: 0 },
      { x: 100_001, y: 0 },
      { x: 0, y: -100_001 },
      [1, 2],
      'x',
      0,
      true,
    ],
  },
  // existing keys, behaviour kept
  theme: {
    valid: ['system', 'light', 'dark'],
    invalid: ['neon', 'Dark', '', null],
  },
  titleMode: {
    valid: ['5h', '7d', 'both', 'max', 'off'],
    invalid: ['everything', '5H', '', null],
  },
  showName: {
    valid: [true, false],
    invalid: ['yes', 1, null],
  },
  cswapPath: {
    valid: [null, '/x/cswap', ' /padded/cswap '],
    invalid: ['', '   ', 42, {}, false],
  },
};

test('every key has a case, and every case is a key', () => {
  assert.deepEqual(Object.keys(CASES).sort(), Object.keys(DEFAULTS).filter((k) => k !== 'refreshSeconds').sort());
});

test('defaults', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.deepEqual(sanitize(undefined), DEFAULTS);
  assert.deepEqual(sanitize('settings'), DEFAULTS);
  assert.deepEqual(sanitize(null, 'darwin'), DARWIN_DEFAULTS);
  assert.deepEqual(sanitize(null, 'linux'), OTHER_DEFAULTS);
  assert.deepEqual(sanitize(null, 'win32'), OTHER_DEFAULTS);
  assert.equal(DEFAULTS.trayStyle, process.platform === 'darwin' ? 'ring' : 'classic');
  assert.equal(S.defaultTrayStyle('darwin'), 'ring');
  assert.equal(S.defaultTrayStyle('linux'), 'classic');
  // the decided defaults (PLAN §6.1, §11)
  assert.equal(DEFAULTS.language, 'system');
  assert.equal(DEFAULTS.gaugeStyle, 'rings');
  assert.equal(DEFAULTS.timeFormat, 'system');
  assert.equal(DEFAULTS.weeklyDateFormat, 'date');
  assert.equal(DEFAULTS.notifications, true);
  assert.equal(DEFAULTS.recordHistory, true);
  assert.equal(DEFAULTS.statsStyle, 'line');
  assert.equal(DEFAULTS.statsPeriod, 'day');
  assert.equal(DEFAULTS.statsAccount, null);
  assert.equal(DEFAULTS.heroExpanded, false);
  assert.equal(DEFAULTS.windowMode, 'popover');
  assert.equal(DEFAULTS.widgetOnTop, true);
  assert.equal(DEFAULTS.widgetPosition, null);
  assert.ok(Object.isFrozen(DEFAULTS));
  // sanitize hands out a copy, never DEFAULTS itself
  assert.notEqual(sanitize(null), DEFAULTS);
});

for (const [key, { valid, invalid }] of Object.entries(CASES)) {
  test(`${key}: valid values kept, invalid ones reset to the default`, () => {
    for (const v of valid) {
      assert.deepEqual(sanitize({ [key]: v }, 'darwin'), { ...DARWIN_DEFAULTS, [key]: v }, `valid ${JSON.stringify(v)}`);
    }
    for (const v of invalid) {
      assert.deepEqual(sanitize({ [key]: v }, 'darwin'), DARWIN_DEFAULTS, `invalid ${String(JSON.stringify(v))}`);
    }
    // an invalid value next to valid ones only drops itself
    const others = { theme: 'dark', statsPeriod: 'month', widgetOnTop: false };
    delete others[key];
    assert.deepEqual(sanitize({ ...others, [key]: invalid[0] }, 'darwin'), { ...DARWIN_DEFAULTS, ...others });
  });
}

test('refreshSeconds keeps its floor, ceiling and choices', () => {
  for (const sec of S.REFRESH_CHOICES) assert.equal(sanitize({ refreshSeconds: sec }).refreshSeconds, sec);
  assert.deepEqual(S.REFRESH_CHOICES, [30, 60, 120, 300]);
  assert.equal(S.MIN_REFRESH_S, 30);
  assert.equal(S.MAX_REFRESH_S, 86_400);
  assert.equal(sanitize({ refreshSeconds: 5 }).refreshSeconds, 30);
  assert.equal(sanitize({ refreshSeconds: 90.4 }).refreshSeconds, 90);
  assert.equal(sanitize({ refreshSeconds: 1e9 }).refreshSeconds, S.MAX_REFRESH_S);
  assert.equal(sanitize({ refreshSeconds: '120' }).refreshSeconds, DEFAULTS.refreshSeconds);
  assert.equal(sanitize({ refreshSeconds: NaN }).refreshSeconds, DEFAULTS.refreshSeconds);
  assert.equal(sanitize({ refreshSeconds: null }).refreshSeconds, DEFAULTS.refreshSeconds);
});

test('existing exports are unchanged', () => {
  assert.deepEqual(S.THEMES, ['system', 'light', 'dark']);
  assert.deepEqual(S.TITLE_MODES, ['5h', '7d', 'both', 'max', 'off']);
  for (const name of ['loadSettings', 'saveSettings', 'sanitize']) assert.equal(typeof S[name], 'function');
});

test('trayStyle falls back to classic off darwin', () => {
  assert.deepEqual(S.trayStylesFor('darwin'), ['classic', 'ring', 'bars', 'rings', 'ringsText']);
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.deepEqual(S.trayStylesFor(platform), ['classic']);
    for (const style of S.TRAY_STYLES) {
      assert.equal(sanitize({ trayStyle: style }, platform).trayStyle, 'classic', `${platform} ${style}`);
    }
    assert.equal(sanitize({ trayStyle: 'nonsense' }, platform).trayStyle, 'classic');
  }
  // the list handed out is a copy
  S.trayStylesFor('darwin').push('x');
  assert.equal(S.TRAY_STYLES.length, 5);
});

test('widgetPosition is a fresh object with x and y only', () => {
  const raw = { x: 12, y: 34, w: 360, h: 500 };
  const s = sanitize({ widgetPosition: raw });
  assert.deepEqual(s.widgetPosition, { x: 12, y: 34 });
  assert.notEqual(s.widgetPosition, raw);
  assert.equal(Object.getPrototypeOf(s.widgetPosition), Object.prototype);
});

test('an old settings.json loads unchanged, new keys take their defaults', (t) => {
  const dir = tmpDir(t);
  const old = { cswapPath: '/opt/tools/cswap', theme: 'dark', refreshSeconds: 120, showName: true, titleMode: 'both' };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(old, null, 2));
  assert.deepEqual(loadSettings(dir, 'darwin'), { ...DARWIN_DEFAULTS, ...old });
  assert.deepEqual(loadSettings(dir, 'linux'), { ...OTHER_DEFAULTS, ...old });
  assert.deepEqual(loadSettings(dir), { ...DEFAULTS, ...old });
  // the file is only read, not rewritten
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), old);

  // unknown keys are ignored; so is Maestro's shape for the same ideas
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...old, alwaysOnTop: false, usageAlerts: false, sessionKey: 'x' }));
  assert.deepEqual(loadSettings(dir, 'darwin'), { ...DARWIN_DEFAULTS, ...old });
});

test('save and load round-trip every key', (t) => {
  const dir = tmpDir(t);
  const all = {
    cswapPath: '/x/cswap',
    theme: 'light',
    refreshSeconds: 300,
    showName: true,
    titleMode: 'max',
    language: 'uk',
    trayStyle: 'ringsText',
    gaugeStyle: 'concentric',
    timeFormat: '24h',
    weeklyDateFormat: 'date-day-time',
    notifications: false,
    recordHistory: false,
    statsStyle: 'summary',
    statsPeriod: 'month',
    statsAccount: 'abcdef012345',
    heroExpanded: true,
    windowMode: 'widget',
    widgetOnTop: false,
    widgetPosition: { x: -800, y: 40 },
  };
  assert.deepEqual(Object.keys(all).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(saveSettings(dir, all, 'darwin'), all);
  assert.deepEqual(loadSettings(dir, 'darwin'), all);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(written), Object.keys(DEFAULTS));
  assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);

  // saving garbage writes defaults, never the garbage
  assert.deepEqual(saveSettings(dir, { ...all, windowMode: 'fullscreen', statsAccount: '../../etc' }, 'darwin'), {
    ...all,
    windowMode: 'popover',
    statsAccount: null,
  });
  // the same file read on another platform loses only the tray style
  assert.deepEqual(loadSettings(dir, 'linux'), { ...all, trayStyle: 'classic', windowMode: 'popover', statsAccount: null });
});

test('RENDERER_KEYS is the fixed whitelist', () => {
  assert.deepEqual([...RENDERER_KEYS], ['statsStyle', 'statsPeriod', 'statsAccount', 'heroExpanded']);
  assert.ok(Object.isFrozen(RENDERER_KEYS));
  for (const key of RENDERER_KEYS) assert.ok(Object.hasOwn(DEFAULTS, key), key);
  for (const key of ['cswapPath', 'theme', 'refreshSeconds', 'language', 'trayStyle', 'windowMode', 'widgetPosition']) {
    assert.ok(!RENDERER_KEYS.includes(key), key);
  }
});

test('rendererPatch accepts only whitelisted keys with valid values', () => {
  assert.deepEqual(rendererPatch({ statsPeriod: 'week' }), { statsPeriod: 'week' });
  assert.deepEqual(rendererPatch({ statsAccount: null }), { statsAccount: null });
  assert.deepEqual(rendererPatch({ heroExpanded: true, statsStyle: 'bars' }), { heroExpanded: true, statsStyle: 'bars' });
  const four = { statsStyle: 'summary', statsPeriod: 'month', statsAccount: '0123456789ab', heroExpanded: false };
  assert.deepEqual(rendererPatch(four), four);
  assert.notEqual(rendererPatch(four), four);
  assert.deepEqual(rendererPatch({}), {});
  const bare = Object.create(null);
  bare.statsPeriod = 'day';
  assert.deepEqual(rendererPatch(bare), { statsPeriod: 'day' });

  // a key main owns, alone or next to a valid one: rejected as a whole
  assert.equal(rendererPatch({ cswapPath: '/bin/sh' }), null);
  assert.equal(rendererPatch({ statsPeriod: 'week', cswapPath: '/bin/sh' }), null);
  for (const key of ['theme', 'refreshSeconds', 'language', 'trayStyle', 'notifications', 'recordHistory', 'windowMode', 'widgetPosition']) {
    assert.equal(rendererPatch({ [key]: DEFAULTS[key] }), null, key);
  }
  assert.equal(rendererPatch({ __proto__: { statsPeriod: 'week' } }), null);
  assert.equal(rendererPatch(JSON.parse('{"__proto__": {"cswapPath": "/bin/sh"}}')), null);
  // invalid values are rejected, not reset
  assert.equal(rendererPatch({ statsPeriod: 'year' }), null);
  assert.equal(rendererPatch({ statsAccount: 'ABCDEF012345' }), null);
  assert.equal(rendererPatch({ heroExpanded: 'true' }), null);
  assert.equal(rendererPatch({ statsStyle: 'line', statsPeriod: undefined }), null);
  // not a plain object
  for (const bad of [null, undefined, 'statsPeriod', 1, true, [], ['statsPeriod'], new Map([['statsPeriod', 'day']]), new Date()]) {
    assert.equal(rendererPatch(bad), null, String(bad));
  }
  class Patch {
    constructor() {
      this.statsPeriod = 'week';
    }
  }
  assert.equal(rendererPatch(new Patch()), null);
  assert.equal(rendererPatch(Object.create({ statsPeriod: 'week' })), null);
  // hidden keys count
  assert.equal(rendererPatch({ statsPeriod: 'week', [Symbol('x')]: 1 }), null);
  const hidden = { statsPeriod: 'week' };
  Object.defineProperty(hidden, 'cswapPath', { value: '/bin/sh', enumerable: false });
  assert.equal(rendererPatch(hidden), null);
});

const PUBLIC_SHAPE = [
  'language',
  'languagePref',
  'locale',
  'hour12',
  'theme',
  'trayStyle',
  'gaugeStyle',
  'timeFormat',
  'weeklyDateFormat',
  'notifications',
  'recordHistory',
  'statsStyle',
  'statsPeriod',
  'statsAccount',
  'heroExpanded',
  'windowMode',
  'widgetOnTop',
  'warn',
  'danger',
];

test('publicSettings has the PLAN §7 shape and hides main-only keys', () => {
  const settings = {
    ...DARWIN_DEFAULTS,
    cswapPath: '/secret/path/cswap',
    widgetPosition: { x: 10, y: 20 },
    language: 'system',
    statsPeriod: 'week',
    windowMode: 'widget',
  };
  const before = JSON.stringify(settings);
  const p = publicSettings(settings, { language: 'ru', locale: 'ru-RU', hour12: false }, 'darwin');
  assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_SHAPE].sort());
  assert.ok(!('cswapPath' in p));
  assert.ok(!('widgetPosition' in p));
  assert.ok(!JSON.stringify(p).includes('/secret/path'));
  assert.deepEqual(p, {
    language: 'ru',
    languagePref: 'system',
    locale: 'ru-RU',
    hour12: false,
    theme: 'system',
    trayStyle: 'ring',
    gaugeStyle: 'rings',
    timeFormat: 'system',
    weeklyDateFormat: 'date',
    notifications: true,
    recordHistory: true,
    statsStyle: 'line',
    statsPeriod: 'week',
    statsAccount: null,
    heroExpanded: false,
    windowMode: 'widget',
    widgetOnTop: true,
    warn: 75,
    danger: 90,
  });
  assert.equal(JSON.stringify(settings), before, 'input not mutated');
  // it survives a structured-clone style copy (plain JSON values only)
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test('publicSettings sanitises its input and follows the platform', () => {
  const p = publicSettings({ trayStyle: 'bars', statsStyle: 'pie', theme: 'dark' }, { language: 'de', locale: 'de-DE', hour12: false }, 'linux');
  assert.equal(p.trayStyle, 'classic');
  assert.equal(p.statsStyle, 'line');
  assert.equal(p.theme, 'dark');
  assert.equal(publicSettings({ trayStyle: 'bars' }, null, 'darwin').trayStyle, 'bars');
  assert.equal(publicSettings(null, null, 'darwin').trayStyle, 'ring');
});

test('publicSettings: language, locale and hour12', () => {
  const r = { language: 'en', locale: 'en-GB', hour12: false };
  // main's resolution is used as given
  assert.deepEqual(pick(publicSettings({ language: 'system' }, r)), { language: 'en', languagePref: 'system', locale: 'en-GB', hour12: false });
  // the locale is canonicalised; a malformed one falls back to the language
  assert.equal(publicSettings({}, { language: 'uk', locale: 'uk-ua' }).locale, 'uk-UA');
  assert.equal(publicSettings({}, { language: 'uk', locale: 'uk_UA' }).locale, 'uk');
  assert.equal(publicSettings({}, { language: 'uk', locale: 42 }).locale, 'uk');
  assert.equal(publicSettings({}, { language: 'uk', locale: 'x'.repeat(100) }).locale, 'uk');
  // without a usable resolution: the explicit preference, else English
  assert.equal(publicSettings({ language: 'de' }).language, 'de');
  assert.equal(publicSettings({ language: 'de' }, { language: 'fr' }).language, 'de');
  assert.equal(publicSettings({ language: 'system' }).language, 'en');
  assert.equal(publicSettings({ language: 'system' }, 'ru').language, 'en');
  assert.equal(publicSettings({ language: 'system' }).locale, 'en');
  // an explicit 12h / 24h choice wins over main's answer
  assert.equal(publicSettings({ timeFormat: '12h' }, r).hour12, true);
  assert.equal(publicSettings({ timeFormat: '24h' }, { ...r, hour12: true }).hour12, false);
  // 'system' takes main's answer, else the locale's own clock
  assert.equal(publicSettings({ timeFormat: 'system' }, { ...r, hour12: true }).hour12, true);
  assert.equal(publicSettings({ timeFormat: 'system' }, { language: 'en', locale: 'en-US' }).hour12, true);
  assert.equal(publicSettings({ timeFormat: 'system' }, { language: 'de', locale: 'de-DE', hour12: 'no' }).hour12, false);
  assert.equal(typeof publicSettings(null).hour12, 'boolean');
});

function pick(p) {
  return { language: p.language, languagePref: p.languagePref, locale: p.locale, hour12: p.hour12 };
}
