'use strict';
// Accounts without a 5-hour window, a Team seat without a week, and logins
// about to lapse, on the real app (FAKE_CSWAP_SCENARIO=ultra): the rings, the
// note under them, the rows, "more limits", the menu-bar title and picture, the
// login notifications, ring-in-ring and the statistics. A snap per state, for
// review by eye.
//
//   1 alice (work)  no 5h, week 71, Fable 82, login in 16 days
//   2 bob           5h 3, week 85, Fable 34, login in 2 days (amber pill)
//   3 carol         week 12 only, no login date
//   4 dave          re-login, last-good week 33 and Fable 12
//   5 erin          5h 41, no week, Fable 0, login in hours (red pill)

const I18n = require('../../src/shared/i18n');

const ru = I18n.translator('ru');
const SESSION = 'Session · 5 h';
const WEEK = 'Week · all models';
const FABLE = 'Fable · week';
const NO_SESSION = 'No 5-hour limit';
const TOOLTIP_ALICE = 'work · 7d 71% · Fable 82% · no 5-hour limit';
const NO_NOTE = { text: '', tip: '' };
// A ring in flight lands on the next full turn, several seconds in the worst case.
const LAND = { timeout: 10_000 };

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const isPicture = (d) => Boolean(d && d.height === 18 && d.scaleFactors && d.scaleFactors.join() === '2');
const collide = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
const middle = (a) => (a.top + a.bottom) / 2;

// Label and number of the rings on screen, once they have landed.
const rings = async (t) => (await t.ui.gauges()).map((g) => [g.side, g.label, g.pct]);

async function hero(t, expected, msg) {
  await t.expect(() => rings(t), expected, msg, LAND);
  await t.expect(() => t.ui.recharging(), false, 'no ring is left in flight', LAND);
}

async function switchTo(t, n) {
  await t.ui.clearToast();
  t.ok(await t.ui.clickSwitch(n), `account ${n} has a Switch button`);
  await t.waitFor(async () => (await t.state()).activeAccountNumber === n, `account ${n} active`, { timeout: 10_000 });
  await t.idle();
}

// tray:draw messages as the page receives them.
function trayDraws(t) {
  return {
    start: () =>
      t.js(() => {
        if (!window.__trayDraws) {
          window.__trayDraws = [];
          window.api.onTrayDraw((m) => window.__trayDraws.push(m));
        }
        return true;
      }),
    async last() {
      const list = await t.js(() => window.__trayDraws.slice());
      return list[list.length - 1];
    },
  };
}

// Ring-in-ring: nothing overlaps its neighbours or leaves the hero.
function checkNoCollisions(t, layout, who) {
  t.equal(layout.overflows, false, `${who}: nothing overflows the hero sideways`);
  const { gauges } = layout;
  t.ok(gauges.every((g) => inside(g.ring, layout.hero) && inside(g.meta, layout.hero)), `${who}: rings and texts stay inside the hero`);
  t.ok(gauges.every((g) => gauges.every((o) => !collide(g.ring, o.meta))), `${who}: no text runs into a ring`);
  t.ok(gauges.every((g) => gauges.every((o) => g === o || !collide(g.meta, o.meta))), `${who}: the text rows do not overlap`);
  for (const g of gauges) t.ok(g.texts.every((a, i) => g.texts.every((b, j) => i === j || !collide(a, b))), `${who}: the parts of a text row do not overlap`);
  t.equal(gauges.flatMap((g) => g.cut), [], `${who}: no text is cut`);
}

module.exports = {
  description: 'accounts without a 5-hour window: rings, note, rows, more limits, tray, login notes, ring-in-ring, statistics',
  scenario: 'ultra',
  settings: { heroExpanded: true },
  timeout: 150_000,
  async run(t) {
    const draws = trayDraws(t);
    const logins = () => t.notifications.filter((n) => /login expires/.test(n.title));

    t.section('the first state: logins about to lapse are told, once');
    t.equal(logins().map((n) => n.title.split(':')[0]), ['bob@example.com', 'erin@example.com'], 'one login note each for bob and erin: none for alice, carol or dave');
    t.match(logins()[0].title, /^bob@example\.com: login expires in 2d/, 'bob’s names the time left');
    t.equal(logins().map((n) => n.body), [2, 5].map((n) => `Log in to this account again in Claude Code, then run: cswap add --slot ${n}`), 'and what to do, with the slot');
    t.equal(t.notifications.length, 2, 'nothing else: Fable at 82 % at launch is taken as seen');
    await t.refresh();
    t.equal(t.notifications.length, 2, 'a refresh says nothing again');

    t.section('alice, no 5-hour window: Fable and the week');
    await hero(t, [['left', FABLE, '82%'], ['right', WEEK, '71%']], 'Fable on the left, the week on the right');
    t.equal(await t.ui.oneRing(), false, 'two rings');
    t.equal(await t.ui.heroNote(), { text: NO_SESSION, tip: 'Anthropic reports no 5-hour window for this account (verified Ultra plans have none)' }, 'the note says so, the tip says why');
    let g = await t.ui.gauges();
    t.equal(g.map((x) => x.stale), [false, false], 'fresh data: neither is dimmed');
    t.equal(g.map((x) => x.tip), [FABLE, ''], 'the model’s label has a tooltip');
    t.equal(g.map((x) => x.paceTick), [true, true], 'both weekly windows have a pace tick');
    t.equal(g.map((x) => x.pace), ['', ''], 'neither is ahead of its pace');
    t.ok(g.every((x) => /^\d+d \d+h$/.test(x.countdown) && /^resets [A-Z][a-z]{2} \d{1,2}$/.test(x.reset)), 'both count in days, to a date');
    t.equal(await t.ui.moreLimits(), { toggle: false, labels: [] }, 'Fable is not repeated under "more limits"');
    t.equal((await t.ui.cards())[0].badges, [], 'no pills: her login is 16 days away');

    t.section('the rows');
    let rows = await t.ui.rows();
    const row = (n) => rows.find((r) => r.number === n);
    const labels = (n) => row(n).lines.map((l) => l.label);
    const keys = (n) => row(n).pills.map((p) => p.key);
    t.equal(labels(2), ['5h', '7d'], 'bob: 5h and 7d lines');
    t.equal(keys(2), ['login', 'pace'], 'bob: a login pill and his pace; Fable at 34 % has no pill');
    t.equal(row(2).pills[0].tone, 'warn', 'bob’s login pill is amber');
    t.match(row(2).pills[0].text, /^Login expires in 2d/, 'and says when');
    t.equal(labels(3), ['7d'], 'carol: one line, the week');
    t.equal(row(3).lines[0].weekly, true, 'in the week’s colour');
    t.equal(keys(3), [], 'carol: no pills');
    t.equal(labels(4), ['Fable', '7d'], 'dave: what his last-good data has, the week last');
    t.equal([row(4).stale, row(4).lines.every((l) => l.old)], [true, true], 'dave: stale, his bars dimmed');
    t.equal(keys(4), ['relogin_required', 'stale'], 'dave: re-login and stale, no login pill');
    t.equal(row(4).pills[0].text, 'Re-login', 'dave’s status pill reads Re-login');
    t.equal(labels(5), ['5h', 'Fable'], 'erin: 5h and Fable lines');
    t.equal(row(5).lines.map((l) => l.pct), ['41%', '0%'], 'erin: her Fable at 0 % is a number, not missing');
    t.equal(row(5).lines[1].tip, FABLE, 'the model’s name has a tooltip');
    t.match(row(5).lines[1].resetTip, /^Fable · week: resets /, 'and its reset says whose it is');
    t.match(row(5).lines[0].resetTip, /^5-hour usage: resets /, 'as the 5h line’s does');
    t.equal(keys(5), ['login'], 'erin: a login pill');
    t.equal(row(5).pills[0].tone, 'crit', 'hers is red, within a day');
    await t.snap('alice-active');

    t.section('the classic title in every mode');
    for (const [label, title] of [['Session (5h)', ' 71%'], ['Both (5h · 7d)', ' 71%'], ['Weekly (7d)', ' 71%'], ['Highest', ' 82%'], ['None', '']]) {
      t.click(await t.menu(), ['Settings', 'Menu Bar', 'Percentage', label]);
      await t.expect(t.trayTitle, title, `${label}: ${JSON.stringify(title)}`);
      await t.expect(() => t.trayImage().template, false, `${label}: the ring is amber, for Fable at 82 %`);
    }
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Percentage', 'Session (5h)']);
    await t.expect(t.trayTitle, ' 71%', 'back to the default mode');
    await t.expect(t.trayTooltip, TOOLTIP_ALICE, 'the one-line tooltip names the week, Fable and the missing limit');

    t.section('the picture: one window');
    await draws.start();
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Style', 'Ring and Numbers']);
    await t.idle();
    await t.expect(() => isPicture(t.trayImage()), true, 'the page paints the menu bar');
    let d = await draws.last();
    t.equal(d && pick(d, ['solo', 'five', 'seven', 'doubtful']), { solo: true, five: { pct: null, hot: null }, seven: { pct: 71, hot: 'warn' }, doubtful: false }, 'solo: the week’s 71, amber for Fable');
    t.equal(t.trayImage().template, false, 'a hot picture is not a template');
    t.equal(t.trayTitle(), '', 'no title next to it');
    t.match(
      t.trayTooltip(),
      /^work · 7d 71% · Fable 82% · no 5-hour limit\nWeek: 71% · resets [A-Z][a-z]{2} \d{1,2}\nFable: 82% · resets [A-Z][a-z]{2} \d{1,2}$/,
      'the tooltip adds a reset line for the week and for Fable',
    );

    t.section('the language reaches the labels and the note');
    t.click(await t.menu(), ['Settings', 'Language', 'Русский']);
    await t.expect(() => rings(t), [['left', ru('model.week', { name: 'Fable' }), '82%'], ['right', ru('gauge.weekly'), '71%']], 'the labels are Russian', LAND);
    t.equal((await t.ui.heroNote()).text, ru('hero.noSession'), 'and the note');
    t.click(await t.menu(), [ru('settings.title'), ru('settings.language'), 'English']);
    await t.expect(() => rings(t), [['left', FABLE, '82%'], ['right', WEEK, '71%']], 'and back', LAND);

    t.section('carol, the week alone: one ring, on the right');
    await switchTo(t, 3);
    t.equal(await t.ui.hiddenGaugesAtRest(), true, 'the left ring went away in flight: it has landed already');
    await hero(t, [['right', WEEK, '12%']], 'one ring, the week’s');
    t.equal(await t.ui.oneRing(), true, 'the layout knows');
    let layout = await t.ui.heroLayout();
    const heroMiddle = (layout.hero.left + layout.hero.right) / 2;
    t.ok(Math.abs((layout.gauges[0].ring.left + layout.gauges[0].ring.right) / 2 - heroMiddle) < 1, 'centred in the hero');
    t.equal((await t.ui.heroNote()).text, NO_SESSION, 'the note is shown');
    t.equal(await t.ui.moreLimits(), { toggle: false, labels: [] }, 'no "more limits"');
    d = await draws.last();
    t.equal(d && pick(d, ['solo', 'seven', 'doubtful']), { solo: true, seven: { pct: 12, hot: null }, doubtful: false }, 'the menu-bar picture is solo too');
    await t.expect(() => t.trayImage().template, true, 'and a template: nothing is hot');
    t.equal(t.trayTooltip().split('\n')[0], 'carol@example.com · 7d 12% · no 5-hour limit', 'her tooltip');
    rows = await t.ui.rows();
    t.equal(labels(1), ['Fable', '7d'], 'alice’s row: Fable, then the week');
    t.equal(keys(1), [], 'and no "Fable 82%" pill: the window has its own line');
    await t.snap('carol-active');
    await t.ui.clickRefresh();
    t.equal(await t.ui.hiddenGaugesAtRest(), true, 'a refresh flies the ring on screen only');
    await t.idle();
    await hero(t, [['right', WEEK, '12%']], 'and it lands where it was');

    t.section('dave, stale: what he has, dimmed, and no claim');
    await switchTo(t, 4);
    await hero(t, [['left', FABLE, '12%'], ['right', WEEK, '33%']], 'Fable and the week from the last good data');
    t.equal((await t.ui.gauges()).map((x) => x.stale), [true, true], 'both rings dimmed');
    t.equal(await t.ui.heroNote(), NO_NOTE, 'stale data claims nothing about a 5-hour limit');
    const badges = (await t.ui.cards())[0].badges;
    t.equal(badges[0], 'Re-login', 'the hero says Re-login');
    t.match(badges[1], /^Stale · /, 'and how old the numbers are');
    d = await draws.last();
    t.equal(d && pick(d, ['solo', 'seven', 'doubtful']), { solo: true, seven: { pct: 33, hot: null }, doubtful: true }, 'the picture is solo, doubtful');
    t.match(t.trayTooltip(), /^dave@example\.com · 7d 33% · Fable 12% · stale\nWeek: 33%/, 'the tooltip says stale and no more');
    await t.snap('dave-active');

    t.section('erin, a seat with no week: the session and Fable');
    await switchTo(t, 5);
    await hero(t, [['left', SESSION, '41%'], ['right', FABLE, '0%']], 'the session on the left, Fable on the right');
    t.equal(await t.ui.heroNote(), NO_NOTE, 'no note: she has a 5-hour window');
    g = await t.ui.gauges();
    t.equal(g.map((x) => x.paceTick), [false, true], 'the pace tick is for the weekly window only');
    t.match(g[0].countdown, /^\d:\d\d:\d\d$/, 'the session counts to the second');
    t.match(g[1].countdown, /^\d+d \d+h$/, 'Fable in days');
    t.equal(await t.ui.moreLimits(), { toggle: false, labels: [] }, 'Fable is not repeated under "more limits"');
    t.match((await t.ui.cards())[0].badges[0], /^Login expires in /, 'the hero has her login pill');
    d = await draws.last();
    t.equal(d && [d.five, d.seven, d.solo], [{ pct: 41, hot: null }, { pct: 0, hot: null }, undefined], 'the picture reads 41 · 0, not solo');
    await t.snap('erin-active');

    t.section('bob, the normal shape');
    await switchTo(t, 2);
    await hero(t, [['left', SESSION, '3%'], ['right', WEEK, '85%']], 'two rings as ever');
    t.equal(await t.ui.heroNote(), NO_NOTE, 'no note');
    t.equal(await t.ui.moreLimits(), { toggle: true, labels: [FABLE] }, 'Fable is under "more limits"');
    g = await t.ui.gauges();
    t.equal(g[1].pace, 'ahead · 76% expected', 'his pace under the week');
    t.equal(g[0].pace, '', 'and none under the session');
    d = await draws.last();
    t.equal(d && [d.five, d.seven, d.solo], [{ pct: 3, hot: null }, { pct: 85, hot: 'warn' }, undefined], 'the picture reads 3 · 85, not solo');
    t.match(t.trayTooltip(), /^bob@example\.com · 5h 3% · 7d 85% \(ahead of pace\) · login expires in 2d[^\n]*\nSession: 3% · resets at [^\n]+\nWeek: 85% · resets [A-Z][a-z]{2} \d{1,2}$/, 'his tooltip keeps its two lines and adds the login');
    await t.snap('bob-active');

    t.section('ring-in-ring: alice');
    t.click(await t.menu(), ['Settings', 'Rings', 'Ring in Ring']);
    await t.expect(() => t.ui.ringInRing(), true, 'the setting applies');
    await switchTo(t, 1);
    await hero(t, [['left', FABLE, '82%'], ['right', WEEK, '71%']], 'outer Fable, inner week');
    layout = await t.ui.heroLayout();
    t.equal(layout.gauges.map((x) => x.ring.right - x.ring.left), [108, 78], 'the outer and the inner ring');
    t.ok(Math.abs(middle(layout.gauges[0].ring) - middle(layout.gauges[1].ring)) < 1, 'around one centre');
    t.equal(layout.gauges.map((x) => x.hairline), [true, false], 'a hairline between the two rows');
    checkNoCollisions(t, layout, 'alice');
    t.equal((await t.ui.heroNote()).text, NO_SESSION, 'the note is under them');
    t.equal((await t.ui.gauges()).map((x) => x.metaPct), ['82%', '71%'], 'the numbers beside them');
    await t.snap('alice-ring-in-ring');

    t.section('ring-in-ring: carol');
    await switchTo(t, 3);
    await hero(t, [['right', WEEK, '12%']], 'the week alone');
    layout = await t.ui.heroLayout();
    const [solo] = layout.gauges;
    t.equal([solo.ring.right - solo.ring.left, solo.ring.bottom - solo.ring.top], [108, 108], 'at the outer size');
    t.equal(solo.stroke, '7.2px', 'with the outer stroke');
    t.equal(solo.hairline, false, 'no hairline under a single row');
    const textMiddle = (Math.min(...solo.texts.map((x) => x.top)) + Math.max(...solo.texts.map((x) => x.bottom))) / 2;
    t.ok(Math.abs(textMiddle - middle(solo.ring)) < 3, `its text row is centred next to it (${Math.round(textMiddle - middle(solo.ring))} px off)`);
    checkNoCollisions(t, layout, 'carol');
    await t.snap('carol-ring-in-ring');

    t.section('back side by side: the second ring comes back');
    await switchTo(t, 2);
    t.click(await t.menu(), ['Settings', 'Rings', 'Side by Side']);
    await t.expect(() => t.ui.ringInRing(), false, 'the setting applies');
    await hero(t, [['left', SESSION, '3%'], ['right', WEEK, '85%']], 'both rings, the right numbers');
    t.equal(await t.ui.oneRing(), false, 'and the two-ring layout');
    t.equal(t.notifications.filter((n) => !/login expires/.test(n.title)), [], 'no switch onto a hot window notified');

    // Every list above went into the history, for every account.
    t.section('statistics: a stand-in is never read as a session');
    await t.ui.openStats();
    await t.waitFor(() => t.js(() => Boolean(window.Chart)), 'Chart.js', { timeout: 5000 });
    const statsOf = async (name, look, read, expected, msg) => {
      await t.waitFor(() => t.ui.statsAccount(name), `${name} in the picker`, { timeout: 5000 });
      await t.ui.statsLook(look);
      await t.expect(async () => read(await t.ui.stats()), expected, msg, { timeout: 5000 });
    };
    const lines = (s) => s.lines.map((l) => [l.label, l.last, l.endDot]);
    const pillOf = (s) => (s.pills[s.pills.length - 1] || '').split(' · ').slice(1).join(' · ');
    const stripOf = (s) => (s.cells[s.cells.length - 1] || '').split(' · ').slice(1).join(' · ');
    const nearTip = (s) => s.items.find((i) => i.label === 'Near limit').tip;
    const ANY_TIP = 'Time with the limit at 90% or more';
    const SESSION_TIP = 'Time with the session limit at 90% or more';

    await statsOf('work', 'line', lines, [['Fable', 82, true], ['Week', 71, false]], 'alice’s first line is Fable, under its name, and the week follows');
    let s = await t.ui.stats();
    t.equal(s.items.slice(0, 2).map((i) => i.value), ['82%', '82%'], 'her peak and average read her fullest limit, Fable');
    t.equal(nearTip(s), ANY_TIP, 'her Near limit does not speak of a session');
    await statsOf('work', 'bars', pillOf, 'Fable 82%', 'her bars name the limit the value is from');
    await statsOf('work', 'summary', stripOf, 'Fable 82%', 'and so does the strip');

    await statsOf('carol', 'line', lines, [['Week', 12, true]], 'carol has the week alone, and it carries the end dot');
    s = await t.ui.stats();
    t.equal(nearTip(s), ANY_TIP, 'her Near limit does not speak of a session either');

    await statsOf('erin', 'line', lines, [['Session', 41, true], ['Week', null, false]], 'erin’s first line is her real session');
    s = await t.ui.stats();
    t.equal(nearTip(s), SESSION_TIP, 'and her Near limit does speak of it');
    await statsOf('erin', 'bars', pillOf, '41%', 'a session peak is a plain number');

    await statsOf('bob', 'line', lines, [['Session', 3, true], ['Week', 85, false]], 'bob’s chart is the session and the week, as ever');
    s = await t.ui.stats();
    t.equal(s.items[0].value, '3%', 'his peak reads the session');
    t.equal(nearTip(s), SESSION_TIP, 'and so does his Near limit');
    await statsOf('bob', 'bars', pillOf, '3%', 'his bars are plain numbers');
    await statsOf('bob', 'summary', stripOf, '3%', 'and his strip');
    await t.snap('bob-statistics');
  },
};
