'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I = require('../src/shared/i18n');
const U = require('../src/shared/usage');

const { STRINGS } = I;
const LANGS = ['en', 'ru', 'uk', 'de'];
const EN_KEYS = Object.keys(STRINGS.en);
// ICU puts no-break spaces into formatted dates and money (and U+202F before
// AM/PM in some versions); compare with plain spaces.
const plain = (s) => s.replace(/\s/g, ' ');
const placeholders = (s) => [...new Set((s.match(/\{\w+\}/g) || []).sort())];
const each = (fn) => {
  for (const lang of LANGS) for (const [key, text] of Object.entries(STRINGS[lang])) fn(lang, key, text);
};

// --- dictionaries ------------------------------------------------------------

test('every language has exactly the keys of en', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LANGS].sort());
  assert.ok(EN_KEYS.length > 250, `only ${EN_KEYS.length} keys`);
  for (const lang of LANGS) {
    const keys = Object.keys(STRINGS[lang]);
    assert.deepEqual(keys.filter((k) => !(k in STRINGS.en)), [], `${lang} has keys en lacks`);
    assert.deepEqual(EN_KEYS.filter((k) => !keys.includes(k)), [], `${lang} lacks keys`);
  }
});

test('every key has the same {placeholders} in every language', () => {
  for (const key of EN_KEYS) {
    const want = placeholders(STRINGS.en[key]);
    for (const lang of LANGS) assert.deepEqual(placeholders(STRINGS[lang][key]), want, `${lang} ${key}`);
  }
});

test('no string contains < or > (strings are text, never HTML)', () => {
  each((lang, key, text) => assert.doesNotMatch(text, /[<>]/, `${lang} ${key}`));
});

test('strings are well formed: non-empty, trimmed, braces only as {name}, real ellipses', () => {
  each((lang, key, text) => {
    const where = `${lang} ${key}: ${JSON.stringify(text)}`;
    assert.equal(typeof text, 'string', where);
    assert.ok(text.length > 0 && text === text.trim(), where);
    assert.doesNotMatch(text, /[^\n] {2}/, where);
    assert.doesNotMatch(text.replace(/\{\w+\}/g, ''), /[{}]/, where);
    assert.doesNotMatch(text, /\.\.\./, where);
  });
});

test('Ukrainian writes the apostrophe as ʼ (U+02BC), as Maestro does', () => {
  for (const [key, text] of Object.entries(STRINGS.uk)) {
    assert.doesNotMatch(text, /[а-щьюяґєії]['’`][а-щьюяґєії]/i, `uk ${key}`);
  }
  assert.match(STRINGS.uk['card.noUsageHint'], /зʼявляться/);
});

test('the dictionaries cannot be changed at run time', () => {
  assert.ok(Object.isFrozen(STRINGS));
  for (const lang of LANGS) assert.ok(Object.isFrozen(STRINGS[lang]), lang);
});

test('keys the shared code maps to exist: statuses, reasons, windows, durations', () => {
  // Every usageStatus cswap 0.26–0.27 emits besides "ok" (usage.js STATUS_BADGES).
  for (const st of ['token_expired', 'relogin_required', 'keychain_unavailable', 'foreign_credential', 'no_credentials', 'api_key', 'unavailable']) {
    for (const key of [`badge.${st}`, `badge.tip.${st}`, `menuLine.${st}`]) assert.ok(key in STRINGS.en, key);
  }
  for (const reason of ['already-active', 'activated', 'already-best', 'candidates-exhausted', 'no-valid-target', 'only-one-account', 'unmanaged-account', 'usage-unavailable']) {
    assert.ok(`reason.${reason}` in STRINGS.en, reason);
  }
  for (const key of ['win.5h', 'win.7d', 'cd.seconds', 'cd.minutes', 'cd.hours', 'cd.hoursOnly', 'cd.days', 'cd.daysOnly', 'app.title', 'lang.system']) {
    assert.ok(key in STRINGS.en, key);
  }
  // German nouns keep their capital in the menu line notes (usage.js lowercased them).
  assert.equal(STRINGS.de['menuLine.token_expired'], 'Token abgelaufen');
});

test('LANGUAGES, CODES and LOCALES cover the same four languages', () => {
  assert.deepEqual(I.CODES, LANGS);
  assert.deepEqual(I.LANGUAGES.map((l) => l.code), LANGS);
  assert.deepEqual(I.LANGUAGES.map((l) => l.name), ['English', 'Русский', 'Українська', 'Deutsch']);
  assert.deepEqual(I.LOCALES, { en: 'en-US', ru: 'ru-RU', uk: 'uk-UA', de: 'de-DE' });
});

// --- translator --------------------------------------------------------------

test('translator: fills {placeholders}, falls back to English, then to the key', () => {
  const en = I.translator('en');
  const ru = I.translator('ru');
  assert.equal(ru('toast.switchedTo', { name: 'work' }), 'Переключено на work');
  assert.equal(I.translator('de')('ring.aria.value', { name: 'Wochenlimit', pct: 34 }), 'Wochenlimit: 34 %');
  assert.equal(en('hdr.checkedAgo', { age: '0s', extra: 1 }), 'checked 0s ago');
  assert.equal(en('card.accountN', { n: 0 }), 'Account 0', '0 is a value, not a missing one');
  assert.equal(en('hdr.checkedAgo', {}), 'checked  ago', 'a missing value is empty, as in Maestro');
  assert.equal(en('hdr.checkedAgo'), 'checked {age} ago', 'no vars: the template as is');
  assert.equal(en('banner.refreshFailed', { message: 'a $& b {age}' }), 'Could not refresh: a $& b {age}', 'values are inserted literally');
  assert.equal(ru('no.such.key'), 'no.such.key');
  assert.equal(ru('__proto__'), '__proto__');
  assert.equal(ru(undefined), '');
  assert.equal(I.translator('fr')('app.title'), 'Claude accounts');
  assert.equal(I.translator(undefined)('app.title'), 'Claude accounts');
});

test('translator: one function per language, which knows its language', () => {
  assert.equal(I.translator('uk'), I.translator('uk'));
  assert.equal(I.translator('uk').lang, 'uk');
  assert.equal(I.translator('xx').lang, 'en');
  assert.equal(I.translator('xx'), I.translator('en'));
});

// --- language and locale -----------------------------------------------------

test('resolveLanguage: an explicit choice wins, system takes the first language we have', () => {
  assert.equal(I.resolveLanguage('system', ['uk-UA', 'en']), 'uk');
  assert.equal(I.resolveLanguage('system', ['fr-FR']), 'en');
  assert.equal(I.resolveLanguage('de', ['ru-RU']), 'de');
  assert.equal(I.resolveLanguage('de', []), 'de');
  assert.equal(I.resolveLanguage('system', ['fr-CH', 'de-CH', 'ru-CH']), 'de');
  assert.equal(I.resolveLanguage('system', ['de_CH@rg=chzzzz']), 'de');
  assert.equal(I.resolveLanguage('system', 'RU-ru'), 'ru', 'one tag (app.getLocale()) will do');
  assert.equal(I.resolveLanguage('system', ['uk']), 'uk');
  assert.equal(I.resolveLanguage('klingon', ['ru-RU']), 'ru', 'an unknown choice counts as system');
  assert.equal(I.resolveLanguage('system', undefined), 'en');
  assert.equal(I.resolveLanguage('system', [null, 42, '', 'ru']), 'ru');
  assert.equal(I.resolveLanguage(undefined, ['zh-Hans-CN']), 'en');
});

test('resolveLocale: the system tag when it is in the UI language, else the default', () => {
  assert.equal(I.resolveLocale('en', ['en-GB', 'de-CH']), 'en-GB');
  assert.equal(I.resolveLocale('en', ['de-CH']), 'en-US');
  assert.equal(I.resolveLocale('de', ['en-US', 'de-CH']), 'de-CH');
  assert.equal(I.resolveLocale('ru', ['ru_RU']), 'ru-RU');
  assert.equal(I.resolveLocale('de', ['de_CH@rg=chzzzz']), 'de-CH');
  assert.equal(I.resolveLocale('uk', []), 'uk-UA');
  assert.equal(I.resolveLocale('en', ['en-!!']), 'en-US', 'a malformed tag is skipped');
  assert.equal(I.resolveLocale('xx', ['xx-YY']), 'en-US');
});

test('hour12For: the locale decides unless the user chose', () => {
  assert.equal(I.hour12For('en-US'), true);
  assert.equal(I.hour12For('de-DE'), false);
  assert.equal(I.hour12For('en-GB'), false);
  assert.equal(I.hour12For('ru-RU'), false);
  assert.equal(I.hour12For('uk-UA'), false);
  assert.equal(I.hour12For('en-US', 'system'), true);
  assert.equal(I.hour12For('de-DE', '12h'), true);
  assert.equal(I.hour12For('en-US', '24h'), false);
  assert.equal(I.hour12For('en-!!'), true, 'a malformed locale is read as en-US');
});

// --- formatters --------------------------------------------------------------

test('formatDuration speaks every language: 5400 s', () => {
  const got = LANGS.map((lang) => I.formatDuration(I.translator(lang), 5400));
  assert.deepEqual(got, ['1h 30m', '1 ч 30 мин', '1 год 30 хв', '1 Std. 30 Min.']);
  assert.equal(I.formatDuration('de', 5400), '1 Std. 30 Min.', 'a language code works too');
  assert.equal(I.formatDuration(undefined, 5400), '1h 30m');
});

test('formatDuration: every unit in every language', () => {
  const cases = [45, 12 * 60, 2 * 3600 + 13 * 60, 2 * 3600, 3 * 86400 + 4 * 3600, 3 * 86400];
  const want = {
    en: ['45s', '12m', '2h 13m', '2h', '3d 4h', '3d'],
    ru: ['45 с', '12 мин', '2 ч 13 мин', '2 ч', '3 д 4 ч', '3 д'],
    uk: ['45 с', '12 хв', '2 год 13 хв', '2 год', '3 д 4 год', '3 д'],
    de: ['45 Sek.', '12 Min.', '2 Std. 13 Min.', '2 Std.', '3 T 4 Std.', '3 T'],
  };
  for (const lang of LANGS) assert.deepEqual(cases.map((s) => I.formatDuration(lang, s)), want[lang], lang);
});

test('formatDuration in English equals Usage.formatDuration', () => {
  const table = [
    0, 0.4, 1, 45, 59.4, 59.5, 60, 61, 119, 754, 3599, 3599.6, 3600, 3660, 7980, 7200,
    86399, 86400, 90000, 3 * 86400 + 4 * 3600 + 59, 30 * 86400, 400 * 86400 + 1,
    -1, -0.1, null, undefined, NaN, '60', {},
  ];
  const en = I.translator('en');
  for (const s of table) assert.equal(I.formatDuration(en, s), U.formatDuration(s), `seconds = ${String(s)}`);
  assert.equal(I.formatDuration(en, Infinity), '', 'no "Infinityd"');
});

// Built from local fields, so these hold in any time zone.
const AFTERNOON = new Date(2026, 9, 2, 15, 59); // Fri 2 Oct 2026, 15:59 local
const PAST_MIDNIGHT = new Date(2026, 9, 2, 0, 5);
// cswap's style: microseconds and an explicit offset.
const cswapIso = (d) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1140+00:00');

test('formatClock: 12 or 24 hours, zero-padded in 24-hour time', () => {
  const iso = cswapIso(AFTERNOON);
  assert.equal(plain(I.formatClock('en-US', iso)), '3:59 PM');
  assert.equal(plain(I.formatClock('en-US', iso, false)), '15:59');
  assert.equal(plain(I.formatClock('de-DE', iso)), '15:59');
  assert.equal(plain(I.formatClock('ru-RU', AFTERNOON.getTime())), '15:59');
  assert.equal(plain(I.formatClock('en-US', PAST_MIDNIGHT, true)), '12:05 AM');
  assert.equal(plain(I.formatClock('en-US', PAST_MIDNIGHT, false)), '00:05', 'never "24:05"');
  assert.equal(plain(I.formatClock('ru-RU', PAST_MIDNIGHT)), '00:05');
  assert.equal(plain(I.formatClock('en-!!', AFTERNOON)), '3:59 PM', 'a malformed locale is read as en-US');
  assert.equal(I.formatClock('en-US', 'soon'), '');
  assert.equal(I.formatClock('en-US', undefined), '');
  assert.equal(I.formatClock('en-US', NaN), '');
});

test('formatDay: the three weekly date formats, as each language writes them', () => {
  const iso = cswapIso(AFTERNOON);
  assert.equal(plain(I.formatDay('en-US', iso, 'date')), 'Oct 2');
  assert.equal(plain(I.formatDay('en-US', iso, 'date-day')), 'Fri, Oct 2');
  assert.equal(plain(I.formatDay('en-US', iso, 'date-day-time')), 'Fri, Oct 2, 3:59 PM');
  assert.equal(plain(I.formatDay('en-US', iso, 'date-day-time', false)), 'Fri, Oct 2, 15:59');
  assert.equal(plain(I.formatDay('ru-RU', iso, 'date-day')), 'пт, 2 окт.');
  assert.equal(plain(I.formatDay('ru-RU', iso, 'date-day-time')), 'пт, 2 окт., 15:59');
  assert.equal(plain(I.formatDay('uk-UA', iso, 'date')), '2 жовт.');
  assert.equal(plain(I.formatDay('de-DE', iso, 'date-day')), 'Fr., 2. Okt.');
  assert.equal(plain(I.formatDay('en-US', iso)), 'Oct 2', "'date' is the default");
  assert.equal(plain(I.formatDay('en-US', iso, 'bogus')), 'Oct 2');
  assert.equal(I.formatDay('en-US', '', 'date'), '');
});

test('formatMoney: currency units in the UI locale, whole amounts without decimals', () => {
  assert.equal(I.formatMoney('en-US', 12.4, 'USD'), '$12.40');
  assert.equal(I.formatMoney('en-US', 50, 'USD'), '$50');
  assert.equal(plain(I.formatMoney('de-DE', 12.4, 'EUR')), '12,40 €');
  assert.equal(plain(I.formatMoney('ru-RU', 12.4, 'USD')), '12,40 $');
  assert.equal(I.formatMoney('en-US', 12.4), '$12.40', 'USD when cswap gives no currency');
  assert.equal(I.formatMoney('en-US', 12.4, 'usd'), '$12.40');
  assert.equal(I.formatMoney('en-!!', 12.4, 'USD'), '$12.40', 'a malformed locale is read as en-US');
  assert.equal(I.formatMoney('en-US', 12.4, 'US'), '12.40 US', 'a code Intl rejects goes after the amount');
  assert.equal(I.formatMoney('en-US', 50, 'US'), '50 US');
  assert.equal(I.formatMoney('en-US', NaN, 'USD'), '');
  assert.equal(I.formatMoney('en-US', '12.4', 'USD'), '');
});

// --- packaging ---------------------------------------------------------------

test('as a classic script it defines one global, I18n, and nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/shared/i18n.js'), 'utf8');
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  assert.deepEqual(Object.keys(sandbox), ['I18n']);
  assert.equal(sandbox.I18n.translator('uk')('menu.quit'), 'Вийти');
  assert.equal(sandbox.I18n.formatDuration('ru', 90), '1 мин');
});
