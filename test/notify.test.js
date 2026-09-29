'use strict';
// Threshold notifications (src/main/notify.js, PLAN P2.5): the pure Notifier
// rule by rule, then attach() with a stub electron, bus and service.
process.env.TZ = 'UTC'; // reset times are printed in local time
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// notify.js takes Notification from electron; in plain Node there is none.
const posted = [];
class FakeNotification extends EventEmitter {
  static isSupported() {
    return FakeNotification.supported;
  }
  constructor(options) {
    super();
    this.options = options;
  }
  show() {
    posted.push(this);
  }
}
FakeNotification.supported = true;
require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: { Notification: FakeNotification } };

const { Notifier, attach, languageOf, formatting } = require('../src/main/notify');
const I18n = require('../src/shared/i18n');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const inH = (h) => new Date(NOW + h * 3_600_000).toISOString().replace('Z', '417+00:00');
const FIVE_END = inH(2.2); // 14:12 UTC
const SEVEN_END = inH(76); // Fri, Oct 2, 16:00 UTC

function acct(n, five, seven, extra = {}) {
  const email = ['', 'alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com'][n];
  const w = (pct, resetsAt) => (pct === undefined ? undefined : { pct, resetsAt });
  return {
    number: n,
    email,
    organizationUuid: `org-${n}`,
    active: false,
    usageStatus: 'ok',
    usage: { fiveHour: w(five, FIVE_END), sevenDay: w(seven, SEVEN_END) },
    ...extra,
  };
}

// The service state with `rows`; the one numbered `active` is active.
function state(rows, active = 1, extra = {}) {
  const accounts = rows.map((r) => ({ ...r, active: r.number === active }));
  return { phase: 'ok', accounts, activeAccountNumber: active, fetchedAt: new Date(NOW).toISOString(), error: null, refreshing: false, switching: false, ...extra };
}

// A lone active alice with this 5h / 7d.
const alice = (five, seven = 10, extra) => state([acct(1, five, seven, { alias: 'work', ...extra })]);

// The same on the real clock, for attach(), whose Notifier reads Date.now.
const LIVE_FIVE_END = new Date(Date.now() + 2.2 * 3_600_000).toISOString();
function live(five, seven) {
  const row = acct(1, five, seven, { alias: 'work' });
  row.usage = { fiveHour: { pct: five, resetsAt: LIVE_FIVE_END }, sevenDay: { pct: seven, resetsAt: new Date(Date.now() + 76 * 3_600_000).toISOString() } };
  return state([row]);
}

function notifier(options = {}) {
  const shown = [];
  let clock = NOW;
  const n = new Notifier({
    show: (note) => shown.push(note),
    t: I18n.translator('en'),
    formatting: () => ({ locale: 'en-US', hour12: false }),
    now: () => clock,
    ...options,
  });
  const feed = (...states) => {
    const before = shown.length;
    for (const s of states) n.update(s);
    return shown.slice(before).map((x) => [x.title, x.body]);
  };
  return { n, shown, feed, tick: (ms) => (clock += ms) };
}

const TITLE = 'Claude accounts';

test('a launch on a hot account says nothing: every threshold it is past counts as seen', () => {
  for (const [five, seven] of [[95, 88], [80, 20], [100, 50], [20, 100], [100, 100]]) {
    const { feed } = notifier();
    assert.deepEqual(feed({ phase: 'loading', accounts: [] }, alice(five, seven), alice(five, seven)), [], `${five}/${seven}`);
  }
  // …and only the next crossing speaks.
  const { feed } = notifier();
  feed(alice(80, 20));
  assert.deepEqual(feed(alice(85, 20)), [], 'still in the warn band');
  assert.deepEqual(feed(alice(91, 20)), [[TITLE, 'work: session at 91% — almost out']]);
});

test('warn and danger fire once per window; danger alone when it jumps straight there', () => {
  const { feed } = notifier();
  feed(alice(20, 34));
  assert.deepEqual(feed(alice(74.4, 34)), [], '74.4 reads 74: under warn');
  assert.deepEqual(feed(alice(74.6, 34)), [[TITLE, 'work: session at 75% — running low']], '74.6 reads 75, as the menu bar shows it');
  assert.deepEqual(feed(alice(80, 34), alice(89.4, 34)), [], 'warn once');
  assert.deepEqual(feed(alice(89.5, 34)), [[TITLE, 'work: session at 90% — almost out']]);
  assert.deepEqual(feed(alice(95, 34), alice(99.4, 34)), [], 'danger once');
  assert.deepEqual(feed(alice(99.5, 34)), [['work: session limit reached', 'Resets at 14:12.']], '99.5 reads 100');

  const b = notifier();
  b.feed(alice(50, 50));
  assert.deepEqual(b.feed(alice(50, 93)), [[TITLE, 'work: week at 93% — almost out']], 'no warn on the way');
  assert.deepEqual(b.feed(alice(50, 80)), [], 'and none after it either');
  assert.deepEqual(b.feed(alice(76, 94)), [[TITLE, 'work: session at 76% — running low']], 'the windows are separate');
});

test('the texts go through t: Russian, and German with its "80 %"', () => {
  for (const [lang, want] of [
    ['ru', ['Аккаунты Claude', 'work: сессия 80% — лимит подходит к концу']],
    ['de', ['Claude-Konten', 'work: Sitzung bei 80 % – wird knapp']],
  ]) {
    const { feed } = notifier({ t: I18n.translator(lang) });
    feed(alice(20, 20));
    assert.deepEqual(feed(alice(80, 20)), [want], lang);
  }
  // An account without alias or email is named by its slot, in the language.
  const { feed } = notifier({ t: I18n.translator('de') });
  const row = (pct) => state([{ ...acct(1, pct, 10), email: undefined }]);
  feed(row(20));
  assert.deepEqual(feed(row(80)), [['Claude-Konten', 'Konto 1: Sitzung bei 80 % – wird knapp']]);
});

test('limit reached at 100 %, with the reset time; the week wins when both are out', () => {
  const { feed } = notifier();
  feed(alice(50, 50));
  assert.deepEqual(feed(alice(100, 50)), [['work: session limit reached', 'Resets at 14:12.']], 'no warn or danger on the way');
  assert.deepEqual(feed(alice(100, 50), alice(100, 100)), [], 'once, even when the week follows');

  const w = notifier();
  w.feed(alice(50, 50));
  assert.deepEqual(w.feed(alice(100, 100)), [['work: weekly limit reached', 'Resets Fri, Oct 2 at 16:00.']]);

  const h12 = notifier({ formatting: () => ({ locale: 'en-US', hour12: true }) });
  h12.feed(alice(50, 50));
  assert.deepEqual(h12.feed(alice(50, 100)), [['work: weekly limit reached', 'Resets Fri, Oct 2 at 4:00 PM.']], 'a 12-hour clock');

  const ru = notifier({ t: I18n.translator('ru'), formatting: () => ({ locale: 'ru-RU', hour12: false }) });
  ru.feed(alice(50, 50));
  assert.deepEqual(ru.feed(alice(50, 100)), [['work: недельный лимит исчерпан', 'Обновится пт, 2 окт. в 16:00.']]);

  const none = notifier();
  none.feed(alice(50, 50));
  const noReset = state([{ ...acct(1, 100, 50, { alias: 'work' }), usage: { fiveHour: { pct: 100 }, sevenDay: { pct: 50, resetsAt: SEVEN_END } } }]);
  assert.deepEqual(none.feed(noReset), [['work: session limit reached', '']], 'no reset time, no body');
});

test('available again once every window is readable and under 100 %, not on a session reset while the week is out', () => {
  const { feed, tick } = notifier();
  feed(alice(50, 50));
  feed(alice(100, 50));
  assert.deepEqual(feed(alice(100, 50)), [], 'still out');
  tick(3 * 3_600_000); // past the 5h reset: the old 100 no longer applies
  assert.deepEqual(feed(alice(100, 50)), [], 'a rolled-over window is not a reading');
  const next = state([acct(1, 3, 51, { alias: 'work', usage: { fiveHour: { pct: 3, resetsAt: inH(7.2) }, sevenDay: { pct: 51, resetsAt: SEVEN_END } } })]);
  assert.deepEqual(feed(next), [[TITLE, 'work is available again']]);
  assert.deepEqual(feed(next), [], 'once');

  // Maestro's single flag: the week still at 100 % keeps it quiet.
  const b = notifier();
  b.feed(alice(50, 99));
  assert.deepEqual(b.feed(alice(100, 100)), [['work: weekly limit reached', 'Resets Fri, Oct 2 at 16:00.']]);
  assert.deepEqual(b.feed(alice(4, 100)), [], 'session reset, week still out');
  assert.deepEqual(b.feed(alice(4, 2)), [[TITLE, 'work is available again']], 'the week reset too');

  // Seeded as out at launch, it still says so when it frees up.
  const c = notifier();
  c.feed(alice(100, 60));
  assert.deepEqual(c.feed(alice(0, 60)), [[TITLE, 'work is available again']]);
});

test('a new window arms warn and danger again: under warn, or a reset time an hour or more later', () => {
  const { feed } = notifier();
  feed(alice(50, 10));
  feed(alice(80, 10));
  assert.deepEqual(feed(alice(10, 10)), [], 'the window reset');
  assert.deepEqual(feed(alice(80, 10)), [[TITLE, 'work: session at 80% — running low']], 'warn again');

  // The next window read for the first time already in the warn band.
  const b = notifier();
  const at = (pct, end) => state([acct(1, pct, 10, { alias: 'work', usage: { fiveHour: { pct, resetsAt: end }, sevenDay: { pct: 10, resetsAt: SEVEN_END } } })]);
  b.feed(at(50, FIVE_END));
  b.feed(at(92, FIVE_END));
  assert.deepEqual(b.feed(at(93, inH(2.25))), [], 'a reset time a few minutes off is the same window');
  assert.deepEqual(b.feed(at(80, inH(7.2))), [[TITLE, 'work: session at 80% — running low']], 'a later window');
  assert.deepEqual(b.feed(at(91, inH(7.2))), [[TITLE, 'work: session at 91% — almost out']]);
});

test('a change of active account seeds that account: no word about a hot account switched to', () => {
  const rows = (a, b) => [acct(1, a, 10, { alias: 'work' }), acct(2, b, 10)];
  const { feed } = notifier();
  feed(state(rows(20, 95), 1));
  assert.deepEqual(feed(state(rows(20, 95), 2)), [], 'switch to bob at 95 %');
  assert.deepEqual(feed(state(rows(20, 99), 2)), [], 'danger was seen');
  assert.deepEqual(feed(state(rows(20, 100), 2)), [['bob@example.com: session limit reached', 'Resets at 14:12.']]);
  // cswap auto moves to alice behind our back; her 80 % counts as seen.
  assert.deepEqual(feed(state(rows(80, 100), 1)), [], 'switch to alice');
  assert.deepEqual(feed(state(rows(91, 100), 1)), [[TITLE, 'work: session at 91% — almost out']]);
  // Back to bob: his old flags are gone, his state is seeded afresh.
  assert.deepEqual(feed(state(rows(91, 100), 2), state(rows(91, 3), 2)), [[TITLE, 'bob@example.com is available again']]);

  // Identity, not the slot: the same account under a new number is no switch.
  const b = notifier();
  b.feed(state([acct(1, 50, 10, { alias: 'work' })]));
  const moved = { ...acct(1, 80, 10, { alias: 'work' }), number: 7 };
  assert.deepEqual(b.feed(state([moved], 7)), [[TITLE, 'work: session at 80% — running low']]);

  // No active account in between (an unmanaged login): alice is seeded again.
  const c = notifier();
  c.feed(alice(50));
  c.feed(state([acct(1, 60, 10, { alias: 'work' })], null));
  assert.deepEqual(c.feed(alice(80)), [], 'seeded again after no active account');
});

test('doubtful, stale and rolled-over values neither fire nor re-arm', () => {
  const { feed } = notifier();
  feed(alice(50, 50));
  assert.deepEqual(feed(alice(95, 50), { ...alice(95, 50), error: { kind: 'cli', message: 'x' } }), [[TITLE, 'work: session at 95% — almost out']], 'danger once, from the good list');
  const b = notifier();
  b.feed(alice(50, 50));
  assert.deepEqual(b.feed({ ...alice(95, 95), error: { kind: 'timeout', message: 'refresh failed' } }), [], 'a failed refresh leaves an old list: nothing');
  for (const phase of ['loading', 'error', 'missing', 'too-old', 'no-accounts']) {
    assert.deepEqual(b.feed({ ...alice(95, 95), phase }), [], phase);
  }
  // Last-good data (token expired) is not a reading.
  const stale = (five) => state([{ ...acct(1, 0, 0, { alias: 'work' }), usage: null, usageStatus: 'token_expired', lastGoodUsage: { fiveHour: { pct: five, resetsAt: FIVE_END }, sevenDay: { pct: 50, resetsAt: SEVEN_END } } }]);
  assert.deepEqual(b.feed(stale(99)), [], 'stale 99 %');
  assert.deepEqual(b.feed(stale(10)), [], 'stale 10 % re-arms nothing…');
  assert.deepEqual(b.feed(alice(80, 50)), [[TITLE, 'work: session at 80% — running low']], '…so the real 80 % is the first crossing');
  assert.deepEqual(b.feed(stale(10), alice(81, 50)), [], 'and it is not repeated after stale data');

  // Unseeded by stale data at launch: the first real reading is seeded instead.
  const c = notifier();
  assert.deepEqual(c.feed(stale(40), stale(40)), []);
  assert.deepEqual(c.feed(alice(95, 50)), [], 'first real reading, taken as seen');
  assert.deepEqual(c.feed(alice(100, 50)), [['work: session limit reached', 'Resets at 14:12.']]);

  // A rolled-over window at launch is skipped; its next reading seeds it.
  const d = notifier();
  d.tick(3 * 3_600_000);
  assert.deepEqual(d.feed(alice(95, 50)), [], '5h window past its reset');
  const next = (pct) => state([acct(1, pct, 50, { alias: 'work', usage: { fiveHour: { pct, resetsAt: inH(8) }, sevenDay: { pct: 50, resetsAt: SEVEN_END } } })]);
  assert.deepEqual(d.feed(next(92)), [], 'seeded at 92');
  assert.deepEqual(d.feed(next(100)), [['work: session limit reached', 'Resets at 20:00.']]);
});

test('all accounts at their limit: one notification with the earliest reset', () => {
  const later = inH(30); // Sep 30, 18:00 UTC
  const rows = (a, b, c, extra = {}) => [
    acct(1, a, 10, { alias: 'work' }),
    acct(2, b, 10, { usage: { fiveHour: { pct: b, resetsAt: inH(1) }, sevenDay: { pct: 10, resetsAt: SEVEN_END } } }),
    acct(3, 10, c, { usage: { fiveHour: { pct: 10, resetsAt: FIVE_END }, sevenDay: { pct: c, resetsAt: later } } }),
    ...(extra.more || []),
  ];
  const { feed } = notifier();
  feed(state(rows(50, 100, 100)));
  assert.deepEqual(feed(state(rows(100, 100, 100))), [['All accounts are at their limit', 'Earliest reset: bob@example.com, 13:00']], 'instead of "limit reached"');
  assert.deepEqual(feed(state(rows(100, 100, 100))), [], 'once');
  // A switch onto another spent account says nothing.
  assert.deepEqual(feed(state(rows(100, 100, 100), 2)), [], 'switch while all are out');
  // Bob frees up (he is active now): one "available", not two.
  assert.deepEqual(feed(state(rows(100, 0, 100), 2)), [[TITLE, 'bob@example.com is available again']]);

  // Another account frees up while the active one is still out: it is named.
  const b = notifier();
  b.feed(state(rows(100, 100, 100)));
  assert.deepEqual(b.feed(state(rows(100, 100, 100))), [], 'a launch with all spent says nothing');
  assert.deepEqual(b.feed(state(rows(100, 100, 5))), [[TITLE, 'carol@example.com is available again']]);

  // The day is named when the earliest reset is not today.
  const c = notifier();
  c.feed(state([acct(1, 50, 10, { alias: 'work' }), acct(3, 10, 100, { usage: { fiveHour: { pct: 10, resetsAt: FIVE_END }, sevenDay: { pct: 100, resetsAt: later } } })]));
  assert.deepEqual(c.feed(state([acct(1, 50, 100, { alias: 'work' }), acct(3, 10, 100, { usage: { fiveHour: { pct: 10, resetsAt: FIVE_END }, sevenDay: { pct: 100, resetsAt: later } } })])), [
    ['All accounts are at their limit', 'Earliest reset: carol@example.com, Wed, Sep 30, 18:00'],
  ]);
});

test('all exhausted counts the accounts in rotation, needs two, and waits out unreadable ones', () => {
  const out = (n, extra) => acct(n, 100, 10, extra);
  // Erin is disabled: she does not keep the others from being "all".
  const { feed } = notifier();
  feed(state([acct(1, 50, 10, { alias: 'work' }), out(2), acct(3, 5, 5, { disabled: true })]));
  assert.deepEqual(feed(state([out(1, { alias: 'work' }), out(2), acct(3, 5, 5, { disabled: true })])).map((x) => x[0]), ['All accounts are at their limit']);

  // …but a disabled account that is active is in use, and counts.
  const b = notifier();
  b.feed(state([acct(1, 50, 10, { disabled: true, alias: 'work' }), out(2)]));
  assert.deepEqual(b.feed(state([out(1, { disabled: true, alias: 'work' }), out(2)])).map((x) => x[0]), ['All accounts are at their limit']);

  // One account: "limit reached" says it better.
  const c = notifier();
  c.feed(alice(50));
  assert.deepEqual(c.feed(alice(100)).map((x) => x[0]), ['work: session limit reached']);

  // Dave's data is last-good only: nobody can say all are out.
  const staleDave = { ...acct(4, 0, 0), usage: null, usageStatus: 'token_expired', lastGoodUsage: { fiveHour: { pct: 100, resetsAt: FIVE_END } } };
  const d = notifier();
  d.feed(state([acct(1, 50, 10, { alias: 'work' }), out(2), staleDave]));
  assert.deepEqual(d.feed(state([out(1, { alias: 'work' }), out(2), staleDave])).map((x) => x[0]), ['work: session limit reached']);
});

test('switched off, the rules keep running silently: switching on replays nothing', () => {
  const { n, feed, shown } = notifier({ enabled: false });
  feed(alice(20, 20));
  assert.deepEqual(feed(alice(80, 20), alice(95, 20), alice(100, 20)), [], 'off');
  n.setEnabled(true);
  assert.deepEqual(feed(alice(100, 20)), [], 'on again: nothing old');
  assert.deepEqual(feed(alice(100, 80)), [[TITLE, 'work: week at 80% — running low']], 'new crossings speak');
  n.setEnabled(false);
  assert.deepEqual(feed(alice(0, 80)), [], 'off: "available" is noted, not shown');
  assert.equal(shown.length, 1);
  n.setEnabled(true);
  assert.deepEqual(feed(alice(0, 80)), [], 'and not shown later');
});

test('reset times use main\'s resolved locale and clock; without it, the language ctx.t speaks', () => {
  for (const code of I18n.CODES) {
    const t = I18n.translator(code);
    assert.equal(languageOf((k, v) => t(k, v)), code, `a wrapper speaking ${code}`);
    assert.equal(languageOf(t), code);
  }
  assert.equal(languageOf(() => 'something else'), 'en');
  const t = I18n.translator('de');
  const wrapper = (k, v) => t(k, v);
  assert.deepEqual(formatting({ t: wrapper, getLanguage: () => ({ language: 'de', locale: 'de-AT', hour12: true }) }), { locale: 'de-AT', hour12: true });
  assert.deepEqual(formatting({ t: wrapper }), { locale: 'de-DE' }, 'no getLanguage: the language\'s default locale');
  assert.deepEqual(formatting({ t: wrapper, getLanguage: () => null }), { locale: 'de-DE' });
});

test('attach: posts through Notification, follows the setting on the bus, a click shows the UI and never switches', () => {
  posted.length = 0;
  const service = new EventEmitter();
  service.state = { phase: 'loading', accounts: [] };
  const calls = [];
  service.switchTo = () => calls.push('switchTo');
  service.refresh = () => calls.push('refresh');
  let settings = { notifications: true };
  const t = I18n.translator('en');
  const ctx = {
    getLanguage: () => ({ language: 'en', locale: 'en-GB', hour12: false }),
    bus: new EventEmitter(),
    service,
    t: (k, v) => t(k, v),
    getSettings: () => settings,
    showUi: () => calls.push('showUi'),
  };
  attach(ctx);
  service.emit('state', live(20, 20));
  service.emit('state', live(80, 20));
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].options, { title: TITLE, body: 'work: session at 80% — running low', silent: false });

  posted[0].emit('click');
  assert.deepEqual(calls, ['showUi'], 'a click shows the UI, nothing else');

  settings = { ...settings, notifications: false };
  ctx.bus.emit('setting:notifications', false, true);
  service.emit('state', live(95, 20));
  assert.equal(posted.length, 1, 'off: nothing posted');
  ctx.bus.emit('setting:notifications', true, false);
  service.emit('state', live(95, 20));
  assert.equal(posted.length, 1, 'on again: the crossing made while off is not replayed');
  service.emit('state', live(100, 20));
  assert.deepEqual(posted[1].options, { title: 'work: session limit reached', body: `Resets at ${I18n.formatClock('en-GB', LIVE_FIVE_END, false)}.`, silent: false }, 'en-GB, 24-hour clock');
  assert.match(posted[1].options.body, /^Resets at \d\d:\d\d\.$/);
  assert.ok(!calls.includes('switchTo'));

  // Nothing is posted where notifications are not supported.
  FakeNotification.supported = false;
  service.emit('state', live(0, 20));
  assert.equal(posted.length, 2);
  FakeNotification.supported = true;
});

test('attach: starts silent when the setting is off', () => {
  posted.length = 0;
  const service = new EventEmitter();
  service.state = live(20, 20);
  const bus = new EventEmitter();
  const t = I18n.translator('en');
  attach({ bus, service, t: (k, v) => t(k, v), getSettings: () => ({ notifications: false }), showUi() {} });
  service.emit('state', live(80, 20));
  assert.equal(posted.length, 0);
  bus.emit('setting:notifications', true, false);
  service.emit('state', live(91, 20));
  assert.deepEqual(posted.map((n) => n.options.body), ['work: session at 91% — almost out']);
});
