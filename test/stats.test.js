'use strict';
// Bucket edges are local time: pin the zone before any Date is made, so the
// results do not depend on the machine (Node applies a runtime TZ change).
process.env.TZ = 'Europe/Zurich';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const S = require('../src/shared/stats');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Local wall-clock time → epoch ms (month is 1-based here).
function at(y, mo, d, h = 0, mi = 0, s = 0) {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}
// A history line at epoch ms (the store writes epoch seconds).
function sample(ms, fields = {}) {
  return { t: ms / 1000, ...fields };
}
function hours(ms) {
  return ms / HOUR;
}

const NOW = at(2026, 9, 29, 15, 30);

test('runs as a classic script and exposes only window.Stats', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/shared/stats.js'), 'utf8');
  const ctx = {};
  ctx.self = ctx;
  vm.runInNewContext(src, ctx);
  assert.deepEqual(Object.keys(ctx).sort(), ['Stats', 'self']);
  assert.equal(typeof ctx.Stats.computeStats, 'function');
  assert.deepEqual(Object.keys(ctx.Stats).sort(), Object.keys(S).sort());
});

test('the zone is pinned for this file', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Zurich');
  assert.equal(new Date(at(2026, 7, 1)).getTimezoneOffset(), -120);
  assert.equal(new Date(at(2026, 12, 1)).getTimezoneOffset(), -60);
});

test('statsWindow day: 24 hourly buckets from local midnight', () => {
  const w = S.statsWindow('day', NOW);
  assert.equal(w.buckets.length, 24);
  assert.equal(w.start, at(2026, 9, 29));
  assert.equal(w.end, at(2026, 9, 30));
  w.buckets.forEach((b, h) => {
    assert.equal(b.hour, h);
    assert.equal(b.start, at(2026, 9, 29, h));
    assert.equal(b.end - b.start, HOUR);
    if (h) assert.equal(b.start, w.buckets[h - 1].end, 'contiguous');
  });
});

test('statsWindow week and month: one bucket per local day, today last', () => {
  const week = S.statsWindow('week', NOW);
  assert.equal(week.buckets.length, 7);
  assert.equal(week.start, at(2026, 9, 23));
  assert.equal(week.end, at(2026, 9, 30));
  assert.equal(week.buckets[6].start, at(2026, 9, 29));
  week.buckets.forEach((b, i) => {
    assert.equal(b.end - b.start, 24 * HOUR);
    assert.equal(b.hour, undefined);
    if (i) assert.equal(b.start, week.buckets[i - 1].end);
  });

  const month = S.statsWindow('month', NOW);
  assert.equal(month.buckets.length, 30);
  assert.equal(month.start, at(2026, 8, 31));
  assert.equal(month.end, at(2026, 9, 30));
  month.buckets.forEach((b, i) => {
    if (i) assert.equal(b.start, month.buckets[i - 1].end);
  });

  // A month that crosses the end of summer time has one 25 h day.
  const nov = S.statsWindow('month', at(2026, 11, 10, 9));
  const lengths = nov.buckets.map((b) => hours(b.end - b.start));
  assert.deepEqual(lengths.filter((h) => h !== 24), [25]);
  assert.equal(nov.buckets[lengths.indexOf(25)].start, at(2026, 10, 25));
});

test('statsWindow: an unknown period is Today', () => {
  assert.deepEqual(S.statsWindow('year', NOW), S.statsWindow('day', NOW));
  assert.equal(S.computeStats([], 'year', NOW).period, 'day');
});

test('DST fall-back, Europe/Zurich 2026-10-25: 25 h in 24 buckets, 02:00 lasts 2 h', () => {
  const now = at(2026, 10, 25, 12);
  const w = S.statsWindow('day', now);
  assert.equal(w.buckets.length, 24);
  assert.equal(hours(w.end - w.start), 25);
  const lengths = w.buckets.map((b) => hours(b.end - b.start));
  assert.deepEqual(lengths, lengths.map((_, h) => (h === 2 ? 2 : 1)));
  // 02:00 CEST (UTC 00:00) to 03:00 CET (UTC 02:00)
  assert.equal(w.buckets[2].start, Date.UTC(2026, 9, 25, 0));
  assert.equal(w.buckets[2].end, Date.UTC(2026, 9, 25, 2));

  // 02:30 happens twice; both readings land in the 02:00 bucket.
  const first = Date.UTC(2026, 9, 25, 0, 30); // 02:30 CEST
  const second = Date.UTC(2026, 9, 25, 1, 30); // 02:30 CET
  const st = S.computeStats([sample(first, { h: 10 }), sample(second, { h: 30 })], 'day', now);
  assert.equal(st.buckets[2].n, 2);
  assert.equal(st.buckets[2].peak, 30);
  assert.equal(st.buckets.filter((b) => b.n).length, 1);

  const labels = w.buckets.map((b) => S.bucketLabel(b, 'day', false, { hour12: false }));
  assert.deepEqual(labels, Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`));
});

test('DST spring-forward, Europe/Zurich 2026-03-29: 23 h, the missing hour is an empty bucket', () => {
  const now = at(2026, 3, 29, 12);
  const w = S.statsWindow('day', now);
  assert.equal(w.buckets.length, 24);
  assert.equal(hours(w.end - w.start), 23);
  const lengths = w.buckets.map((b) => hours(b.end - b.start));
  assert.deepEqual(lengths, lengths.map((_, h) => (h === 2 ? 0 : 1)));

  // A pair across the jump (01:55 CET → 03:05 CEST, 10 real minutes) is observed.
  const st = S.computeStats([sample(at(2026, 3, 29, 1, 55), { h: 40 }), sample(at(2026, 3, 29, 3, 5), { h: 40 })], 'day', now);
  assert.equal(st.observedMs, 10 * MIN);
  assert.equal(st.buckets[1].observedMs, 5 * MIN);
  assert.equal(st.buckets[2].observedMs, 0);
  assert.equal(st.buckets[2].none, true);
  assert.equal(st.buckets[3].observedMs, 5 * MIN);
  // Labels stay 00…23 instead of "03:00" twice.
  assert.equal(S.bucketLabel(w.buckets[2], 'day', false, { hour12: false }), '02:00');
  assert.equal(S.bucketLabel(w.buckets[3], 'day', false, { hour12: false }), '03:00');
});

test('bucket flags: current, future and currentIndex', () => {
  const st = S.computeStats([], 'day', NOW);
  assert.equal(st.currentIndex, 15);
  assert.deepEqual(st.buckets.map((b) => b.current).filter(Boolean).length, 1);
  assert.equal(st.buckets[15].future, false);
  assert.equal(st.buckets[16].future, true);
  assert.equal(st.buckets[14].future, false);
  assert.equal(S.computeStats([], 'week', NOW).currentIndex, 6);
  assert.equal(S.computeStats([], 'month', NOW).currentIndex, 29);
});

test('empty history: nothing to show, every bucket is none', () => {
  const st = S.computeStats([], 'day', NOW);
  assert.equal(st.count, 0);
  assert.equal(st.peak, null);
  assert.equal(st.avg, null);
  assert.equal(st.spend, null);
  assert.equal(st.busiest, null);
  assert.equal(st.observedMs, 0);
  assert.equal(st.coverage, 0);
  assert.ok(st.buckets.every((b) => b.none && b.avg === null && b.peak === null));
  assert.equal(S.computeStats(null, 'day', NOW).count, 0);
});

test('input is sorted, invalid lines are skipped, samples outside the window are left out', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(10, 10), { h: 30 }),
    null,
    { h: 99 },
    { t: 'x', h: 99 },
    sample(day(10, 0), { h: 20 }),
    sample(at(2026, 9, 30, 0, 0), { h: 99 }), // tomorrow: after the window
  ], 'day', NOW);
  assert.equal(st.count, 2);
  assert.deepEqual(st.samples.map((e) => e.h), [20, 30]);
  assert.equal(st.peak, 30);
});

test('sessionPeak and weekLast per bucket; a missing h is skipped, not a 0; peak falls back to w', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { h: 40, w: 10 }),
    sample(day(9, 10), { w: 11 }),
    sample(day(9, 20), { h: 35, w: 12 }),
    sample(day(10, 0), { w: 13 }),
  ], 'day', NOW);
  assert.equal(st.buckets[9].sessionPeak, 40);
  assert.equal(st.buckets[9].peak, 40);
  assert.equal(st.buckets[9].weekLast, 12);
  assert.equal(st.buckets[10].sessionPeak, null, 'no h in the bucket');
  assert.equal(st.buckets[10].peak, 13, 'a reading with w only: its level is w');
  assert.equal(st.buckets[10].weekLast, 13);
  assert.equal(st.buckets[10].none, false, 'it has data, just no 5h value');
  assert.equal(st.peak, 40);
});

test('a reading\'s level: the 5h, else the fullest weekly limit; nothing else is one', () => {
  const peak = (fields) => S.computeStats([sample(at(2026, 9, 29, 9), fields)], 'day', NOW).buckets[9].peak;
  assert.equal(peak({ h: 10, w: 99, m: { Fable: 100 } }), 10);
  assert.equal(peak({ h: 0, w: 99 }), 0, 'an idle 5h is a 5h');
  assert.equal(peak({ w: 71, m: { Fable: 82 } }), 82, 'the model stands above the week');
  assert.equal(peak({ w: 95, m: { Fable: 82 } }), 95, 'the week stands above the model');
  assert.equal(peak({ w: 0, m: { Fable: 0 } }), 0, 'a 0 % week is a week');
  assert.equal(peak({ m: { Fable: 82, Opus: 90, Haiku: 3 } }), 90);
  assert.equal(peak({ m: { Fable: 0 } }), 0);
  for (const none of [{}, { u: 5, l: 50 }, { m: {} }, { m: { Fable: 'x', Opus: null } }, { m: 'x' }, { h: '5', w: null }, { h: NaN, w: Infinity }]) {
    assert.equal(peak(none), null, JSON.stringify(none));
  }
});

test('with an h in every reading the figures are the 5h ones, whatever else the readings carry', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const plain = [[9, 0, 20], [9, 10, 91], [9, 20, 95], [10, 5, 30], [10, 15, 30], [14, 0, 0]].map(([h, mi, v]) => sample(day(h, mi), { h: v }));
  const rich = plain.map((e) => ({ ...e, w: 97, m: { Fable: 100 } }));
  const a = S.computeStats(plain, 'day', NOW);
  const b = S.computeStats(rich, 'day', NOW);
  for (const k of ['peak', 'avg', 'nearMs', 'inUseMs', 'observedMs', 'hasSession']) assert.equal(b[k], a[k], k);
  assert.equal(b.busiest.start, a.busiest.start);
  assert.equal(b.peak, 95);
  b.buckets.forEach((x, i) => {
    for (const k of ['peak', 'sessionPeak', 'avg', 'nearMs', 'peakWindow']) assert.equal(x[k], a.buckets[i][k], `${k} of bucket ${i}`);
    assert.equal(x.sessionPeak, x.peak);
    assert.equal(x.peakWindow, null);
  });
});

test('no 5-hour window: peak, average, near limit and busiest read the fullest weekly limit', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { w: 88, m: { Fable: 20 } }),
    sample(day(9, 10), { w: 90, m: { Fable: 21 } }),
    sample(day(9, 20), { w: 92, m: { Fable: 22 } }),
    sample(day(12, 0), { w: 92, m: { Fable: 22 } }), // after a gap, the same peak
    sample(day(12, 10), { w: 92, m: { Fable: 22 } }),
  ], 'day', NOW);
  assert.equal(st.peak, 92, 'the week, which stands above Fable here');
  assert.equal(st.avg, (88 * 10 + 90 * 10 + 92 * 10) / 30);
  assert.equal(st.buckets[9].avg, 89);
  assert.equal(st.buckets[12].avg, 92);
  assert.equal(st.nearMs, 20 * MIN, '90 % for 10 min and 92 % for 10 min');
  assert.equal(st.buckets[9].nearMs, 10 * MIN);
  assert.equal(st.buckets[12].nearMs, 10 * MIN);
  assert.equal(st.busiest.start, day(9, 0), 'the bucket with time in use, not the later one at the same peak');
  assert.equal(st.inUseMs, 20 * MIN);
  assert.equal(st.observedMs, 30 * MIN);
  assert.equal(st.hasSession, false);
  // A lone reading counts as its own value here too.
  const lone = S.computeStats([sample(day(9, 0), { w: 42 })], 'day', NOW);
  assert.equal(lone.avg, 42);
  assert.equal(lone.buckets[9].avg, 42);
});

test('only model windows: the fullest one at each reading is the level', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { m: { Fable: 92, Opus: 10 } }),
    sample(day(9, 10), { m: { Fable: 50, Opus: 60 } }),
    sample(day(9, 20), { m: { Fable: 50, Opus: 60 } }),
  ], 'day', NOW);
  assert.equal(st.peak, 92);
  assert.equal(st.avg, (92 * 10 + 60 * 10) / 20);
  assert.equal(st.nearMs, 10 * MIN);
  assert.equal(st.busiest.start, day(9, 0));
  assert.equal(st.buckets[9].sessionPeak, null);
  assert.equal(st.buckets[9].peakWindow, 'Fable');
  assert.equal(st.buckets[9].weekLast, null);
});

test('the pair from before the window holds that reading\'s level', () => {
  const before = at(2026, 9, 28, 23, 55);
  const inside = at(2026, 9, 29, 0, 5);
  const st = S.computeStats([sample(before, { w: 95 }), sample(inside, { w: 50 })], 'day', NOW);
  assert.equal(st.peak, 50, 'the reading before the window is no peak of it');
  assert.equal(st.nearMs, 5 * MIN);
  assert.equal(st.buckets[0].avg, 95);
});

test('a model above the week is the level: the cards agree with the chart, and the bucket names it', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { w: 70, m: { Fable: 88, Opus: 10 } }),
    sample(day(9, 10), { w: 71, m: { Fable: 90, Opus: 10 } }),
    sample(day(9, 20), { w: 95, m: { Fable: 90, Opus: 10 } }), // the week passes it
    sample(day(9, 30), { w: 95, m: { Fable: 90, Opus: 10 } }),
  ], 'day', NOW);
  assert.equal(st.peak, 95);
  assert.equal(st.buckets[9].peak, 95);
  assert.equal(st.buckets[9].peakWindow, '7d');
  assert.equal(st.avg, (88 * 10 + 90 * 10 + 95 * 10) / 30);
  assert.equal(st.nearMs, 20 * MIN, 'Fable at 90 % for 10 min, then the week at 95 % for 10 min');
  const fable = S.computeStats([sample(day(9, 0), { w: 71, m: { Fable: 82 } })], 'day', NOW);
  assert.deepEqual([fable.peak, fable.buckets[9].peak, fable.buckets[9].peakWindow], [82, 82, 'Fable']);
  const tie = S.computeStats([sample(day(9, 0), { w: 82, m: { Fable: 82 } })], 'day', NOW);
  assert.equal(tie.buckets[9].peakWindow, '7d', 'the week wins a tie');
});

test('sessionPeak is the strict 5h peak; peakWindow names a bucket\'s peak when it is not one', () => {
  const bucket = (...fields) => S.computeStats(fields.map((f, i) => sample(at(2026, 9, 29, 9, i), f)), 'day', NOW).buckets[9];
  const read = (b) => [b.peak, b.sessionPeak, b.peakWindow];
  assert.deepEqual(read(S.computeStats([], 'day', NOW).buckets[9]), [null, null, null], 'nothing measured');
  assert.deepEqual(read(bucket({ u: 3 })), [null, null, null], 'a reading with no level');
  assert.deepEqual(read(bucket({ h: 40 }, { h: 35 })), [40, 40, null]);
  assert.deepEqual(read(bucket({ h: 0 })), [0, 0, null], 'an idle 5h is a session peak of 0');
  assert.deepEqual(read(bucket({ w: 71 }, { w: 72 })), [72, null, '7d']);
  assert.deepEqual(read(bucket({ w: 0 })), [0, null, '7d'], 'a week at 0 % is still a week value');
  assert.deepEqual(read(bucket({ m: { Fable: 82 } })), [82, null, 'Fable'], 'so is a model window');
  // A bucket that mixes both: what the bar shows decides.
  assert.deepEqual(read(bucket({ h: 40, w: 10 }, { w: 11 })), [40, 40, null], 'the 5h is higher');
  assert.deepEqual(read(bucket({ h: 20, w: 50 }, { w: 55 })), [55, 20, '7d'], 'the week is higher: never read as a session peak');
  assert.deepEqual(read(bucket({ h: 20 }, { w: 30, m: { Fable: 55 } })), [55, 20, 'Fable'], 'a model is higher');
  assert.deepEqual(read(bucket({ h: 55 }, { w: 55 })), [55, 55, null], 'a tie is the session peak');
  assert.deepEqual(read(bucket({ w: 55 }, { h: 55 })), [55, 55, null], 'in either order');
});

test('weekPeak and modelPeak: the highest each stood in the bucket, own names only', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { h: 1, w: 92, m: { Fable: 15, Opus: 40 } }),
    sample(day(9, 30), { h: 1, w: 3, m: { Fable: 12 } }), // after a reset; Opus is not in it: its 40 stands
    sample(day(9, 40), { h: 1, m: { Fable: 18 } }),
    sample(day(10, 0), { h: 1 }),
    sample(day(11, 0), { h: 1, m: { Fable: 'x', Opus: null } }),
  ], 'day', NOW);
  assert.deepEqual(st.buckets[9].modelPeak, { Fable: 18, Opus: 40 });
  assert.equal(st.buckets[9].weekPeak, 92);
  assert.equal(st.buckets[9].weekLast, 3, 'the end of the bucket is another figure');
  assert.equal(st.buckets[8].modelPeak, null, 'nothing measured');
  assert.equal(st.buckets[8].weekPeak, null);
  assert.equal(st.buckets[10].modelPeak, null, 'no models in the reading');
  assert.equal(st.buckets[10].weekPeak, null);
  assert.equal(st.buckets[11].modelPeak, null, 'no numbers in them');

  // JSON.parse makes `__proto__` an own property: it must not count, or end up as a prototype.
  const inherited = Object.create({ Ghost: 99 });
  inherited.Fable = 2;
  const edited = S.computeStats([
    sample(day(9, 0), { m: JSON.parse('{"__proto__": 99, "constructor": 7, "Fable": 1}') }),
    sample(day(10, 0), { m: inherited }),
  ], 'day', NOW);
  const peaks = edited.buckets[9].modelPeak;
  assert.deepEqual(Object.keys(peaks).sort(), ['Fable', 'constructor']);
  assert.equal(peaks.constructor, 7, 'a name that is on every object starts from its own reading');
  assert.equal(Object.getPrototypeOf(peaks), Object.prototype);
  assert.equal(edited.buckets[9].peak, 7);
  assert.deepEqual(edited.buckets[10].modelPeak, { Fable: 2 }, 'an inherited name is not a window');
  assert.equal(edited.buckets[10].peak, 2);
  assert.equal(edited.topModel, 'constructor');
});

test('allSession: no reading in the window stands in for a 5h', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const all = (...fields) => S.computeStats(fields.map((f, i) => sample(day(9, i), f)), 'day', NOW).allSession;
  assert.equal(all(), true, 'nothing measured');
  assert.equal(all({ h: 20 }, { h: 0, w: 50 }), true);
  assert.equal(all({ h: 20 }, { u: 3 }), true, 'a reading with no level stands in for nothing');
  assert.equal(all({ h: 20 }, { w: 50 }), false, 'a mixed period');
  assert.equal(all({ w: 50 }), false);
  assert.equal(all({ m: { Fable: 50 } }), false);
});

test('hasSession and topModel read the window only', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const yesterday = at(2026, 9, 28, 12);
  const empty = S.computeStats([], 'day', NOW);
  assert.deepEqual([empty.hasSession, empty.topModel], [false, null]);
  assert.equal(S.computeStats([sample(day(9, 0), { h: 0 })], 'day', NOW).hasSession, true, 'an idle 5h is a session');
  assert.equal(S.computeStats([sample(day(9, 0), { w: 5 })], 'day', NOW).hasSession, false);

  // A reading from before the window opens the first pair, nothing more.
  const old = [sample(yesterday, { h: 50, m: { Fable: 9 } }), sample(day(9, 0), { w: 5 })];
  const today = S.computeStats(old, 'day', NOW);
  assert.deepEqual([today.hasSession, today.topModel], [false, null]);
  const week = S.computeStats(old, 'week', NOW);
  assert.deepEqual([week.hasSession, week.topModel], [true, 'Fable']);

  // The highest latest reading, not the highest ever: Opus reset and is low now.
  const top = (...ms) => S.computeStats(ms.map((m, i) => sample(day(9, i), { m })), 'day', NOW).topModel;
  assert.equal(top({ Opus: 90, Fable: 50 }, { Opus: 10 }), 'Fable');
  assert.equal(top({ Fable: 50 }, { Fable: 60, Opus: 55 }), 'Fable');
  assert.equal(top({ Opus: 55 }, { Fable: 80 }), 'Fable');
  assert.equal(top({ Opus: 70, Fable: 70 }), 'Opus', 'a tie keeps the one seen first');
  assert.equal(top({ Fable: 0 }), 'Fable', 'a model at 0 % is a model');
  assert.equal(top({ Fable: 'x' }), null);
});

test('a mixed week: older days with h, recent days without', () => {
  const st = S.computeStats([
    sample(at(2026, 9, 24, 10), { h: 60, w: 30, m: { Fable: 20 } }),
    sample(at(2026, 9, 25, 10), { h: 80, w: 35, m: { Fable: 25 } }),
    sample(at(2026, 9, 26, 10), { h: 40, w: 90 }), // the bars stay on the 5h while there is one
    // Anthropic took the 5-hour window away:
    sample(at(2026, 9, 27, 10), { w: 70, m: { Fable: 75 } }),
    sample(at(2026, 9, 29, 10), { w: 72, m: { Fable: 77 } }),
  ], 'week', NOW);
  const b = st.buckets; // 23 … 29 September
  assert.deepEqual(b.map((x) => x.sessionPeak), [null, 60, 80, 40, null, null, null]);
  assert.deepEqual(b.map((x) => x.peak), [null, 60, 80, 40, 75, null, 77]);
  assert.deepEqual(b.map((x) => x.peakWindow), [null, null, null, null, 'Fable', null, 'Fable']);
  assert.deepEqual(b.map((x) => x.weekLast), [null, 30, 35, 90, 70, null, 72]);
  assert.deepEqual(b.map((x) => x.modelPeak && x.modelPeak.Fable), [null, 20, 25, null, 75, null, 77]);
  assert.equal(st.peak, 80);
  assert.equal(st.busiest, null, 'readings a day apart: no time in use to go by');
  assert.equal(st.hasSession, true, 'the session line stays, up to the last day that has one');
  assert.equal(st.endsInSession, false, 'but it no longer says where things stand');
  assert.equal(st.topModel, 'Fable');

  // The same history, Today: nothing but the fallback in it.
  const today = S.computeStats(st.samples, 'day', NOW);
  assert.equal(today.hasSession, false);
  assert.equal(today.peak, 77);
  assert.equal(today.buckets[10].peakWindow, 'Fable');
});

// A week as the view gets it: what each line reads per day, oldest first.
const ys = (line) => line && line.points.map((p) => p.y);

test('lineChart with a 5h in every reading: the session and the week as ever, whatever else the readings carry', () => {
  const day = (d, h, mi = 0) => at(2026, 9, d, h, mi);
  const st = S.computeStats([
    sample(day(24, 10), { h: 60, w: 30, m: { Fable: 99 } }),
    sample(day(25, 9), { h: 20, w: 95, m: { Fable: 99 } }),
    sample(day(25, 17), { h: 5, w: 1, m: { Fable: 2 } }), // a reset: the week ends the day at 1
    sample(day(26, 10), { h: 40, w: 2, u: 3 }),
  ], 'week', NOW);
  const plot = S.lineChart(st);
  assert.deepEqual(ys(plot.first), [null, 60, 20, 40, null, null, null], 'each day\'s session peak');
  assert.deepEqual(ys(plot.second), [null, 30, 1, 2, null, null, null], 'the week\'s level at the day\'s end, not its highest');
  assert.deepEqual([plot.first.name, plot.second.name, plot.past, plot.dot], [null, null, null, 'first']);
  assert.deepEqual(ys({ points: plot.spend }), [null, null, null, 3, null, null, null]);
  // Points sit in the middle of their day; a day still ahead has none.
  assert.deepEqual(plot.first.points[1].x, at(2026, 9, 24, 12));
  assert.equal(plot.first.points.length, 7);
  const today = S.lineChart(S.computeStats([sample(day(29, 9), { h: 7, w: 8, u: 1 }), sample(day(29, 10), { h: 9, w: 8 })], 'day', NOW));
  assert.deepEqual(today.first.points, [{ x: day(29, 9), y: 7 }, { x: day(29, 10), y: 9 }], 'Today has a point per reading');
  assert.deepEqual(ys(today.second), [8, 8]);
  assert.deepEqual(ys({ points: today.spend }), [1, null]);
});

test('lineChart, no 5-hour window at all: the top model and the week; the week alone carries the dot', () => {
  const day = (h) => at(2026, 9, 29, h);
  const both = S.lineChart(S.computeStats([sample(day(9), { w: 71, m: { Fable: 82, Opus: 3 } })], 'day', NOW));
  assert.deepEqual([both.first.name, ys(both.first)], ['Fable', [82]]);
  assert.deepEqual([both.second.name, ys(both.second), both.past, both.dot], [null, [71], null, 'first']);
  const weekOnly = S.lineChart(S.computeStats([sample(day(9), { w: 12 })], 'day', NOW));
  assert.deepEqual([weekOnly.first, ys(weekOnly.second), weekOnly.past, weekOnly.dot], [null, [12], null, 'second']);
});

test('lineChart after an account lost its 5h: the limit filling up is drawn, the end dot is on it, and the old 5h stays', () => {
  const day = (d, h, mi = 0) => at(2026, 9, d, h, mi);
  const st = S.computeStats([
    sample(day(24, 10), { h: 32, w: 10, m: { Fable: 14 } }),
    sample(day(25, 10), { h: 100, w: 30, m: { Fable: 37 } }), // the peak of the period, while it had a 5h
    sample(day(26, 10), { h: 35, w: 51, m: { Fable: 54 } }),
    sample(day(27, 2), { h: 0, w: 60, m: { Fable: 70 } }), // an idle 5h, until it went away that night
    sample(day(27, 9), { w: 70, m: { Fable: 82 } }),
    sample(day(28, 9), { w: 75, m: { Fable: 83 } }),
    sample(day(29, 9), { w: 86, m: { Fable: 84 } }),
  ], 'week', NOW);
  assert.deepEqual([st.hasSession, st.endsInSession, st.allSession], [true, false, false]);
  const plot = S.lineChart(st);
  assert.equal(plot.first.name, 'Fable', 'the same line as Today, under the same name');
  assert.deepEqual(ys(plot.first), [null, 14, 37, 54, 82, 83, 84], 'no 0 on the day the 5h went');
  assert.deepEqual(ys(plot.second), [null, 10, 30, 51, 70, 75, 86]);
  assert.equal(plot.past.name, null);
  assert.deepEqual(ys(plot.past), [null, 32, 100, 35, 0, null, null], 'the old 5h, up to the day it stopped');
  assert.equal(plot.dot, 'first');
  // The peak of the period is on a line.
  assert.ok([plot.first, plot.second, plot.past].some((line) => ys(line).includes(st.peak)), `peak ${st.peak}`);

  const today = S.lineChart(S.computeStats([
    sample(day(29, 2), { h: 5, w: 80, m: { Fable: 81 } }),
    sample(day(29, 3), { w: 81, m: { Fable: 82 } }),
  ], 'day', NOW));
  assert.deepEqual([today.first.name, ys(today.first), ys(today.past), today.dot], ['Fable', [81, 82], [5, null], 'first']);
});

test('lineChart after a lost 5h with no model: the session stops without a dot and the week carries it', () => {
  const day = (d) => at(2026, 9, d, 10);
  const plot = S.lineChart(S.computeStats([sample(day(26), { h: 50, w: 10 }), sample(day(27), { h: 60, w: 11 }), sample(day(29), { w: 12 })], 'week', NOW));
  assert.deepEqual([plot.first.name, ys(plot.first)], [null, [null, null, null, 50, 60, null, null]]);
  assert.deepEqual(ys(plot.second), [null, null, null, 10, 11, null, 12]);
  assert.deepEqual([plot.past, plot.dot], [null, 'second']);
});

test('lineChart with a 5h back at the end: the session is the first line again, gaps and all', () => {
  const day = (d) => at(2026, 9, d, 10);
  const plot = S.lineChart(S.computeStats([sample(day(27), { h: 50, w: 10, m: { Fable: 90 } }), sample(day(28), { w: 11, m: { Fable: 90 } }), sample(day(29), { h: 5, w: 12, m: { Fable: 90 } })], 'week', NOW));
  assert.deepEqual([plot.first.name, ys(plot.first)], [null, [null, null, null, null, 50, null, 5]]);
  assert.deepEqual([plot.past, plot.dot], [null, 'first']);
});

test('lineChart on a reset day, with no 5h: the lines keep the day\'s highest, so the peak is on them', () => {
  const day = (d, h) => at(2026, 9, d, h);
  const st = S.computeStats([
    sample(day(27, 22), { w: 70, m: { Fable: 80 } }),
    sample(day(28, 10), { w: 80, m: { Fable: 90 } }),
    sample(day(28, 16), { w: 92, m: { Fable: 97 } }),
    sample(day(28, 18), { w: 0, m: { Fable: 0 } }), // the week starts over
    sample(day(28, 22), { w: 3, m: { Fable: 2 } }),
    sample(day(29, 8), { w: 3, m: { Fable: 2 } }),
  ], 'week', NOW);
  const plot = S.lineChart(st);
  assert.deepEqual(ys(plot.first), [null, null, null, null, 80, 97, 2]);
  assert.deepEqual(ys(plot.second), [null, null, null, null, 70, 92, 3]);
  assert.equal(st.peak, 97);
  assert.equal(st.buckets[5].peak, 97, 'the bar says the same for that day');
  // Today keeps every reading, so it shows the fall as it happened.
  const today = S.lineChart(S.computeStats(st.samples, 'day', day(28, 23)));
  assert.deepEqual(ys(today.first), [90, 97, 0, 2]);
});

test('lineChart on a reset day in a week that lost its 5h: the mix does not bring the fall back', () => {
  const day = (d, h) => at(2026, 9, d, h);
  const st = S.computeStats([
    sample(day(25, 10), { h: 40, w: 92, m: { Fable: 97 } }),
    sample(day(25, 18), { h: 1, w: 1, m: { Fable: 2 } }), // the week starts over, the 5h still there
    sample(day(28, 10), { w: 20, m: { Fable: 30 } }),
  ], 'week', NOW);
  assert.deepEqual([st.hasSession, st.allSession], [true, false]);
  const plot = S.lineChart(st);
  assert.deepEqual(ys(plot.first), [null, null, 97, null, null, 30, null]);
  assert.deepEqual(ys(plot.second), [null, null, 92, null, null, 20, null]);
  assert.deepEqual(ys(plot.past), [null, null, 40, null, null, null, null]);
});

test('lineChart with no week in the period: the next model is the second line, under its name', () => {
  const day = (h) => at(2026, 9, 29, h);
  // A Team seat: 5h and only a per-model week.
  const seat = S.lineChart(S.computeStats([sample(day(9), { h: 30, m: { Fable: 90 } }), sample(day(10), { h: 41, m: { Fable: 97 } })], 'day', NOW));
  assert.deepEqual([seat.first.name, ys(seat.first)], [null, [30, 41]]);
  assert.deepEqual([seat.second.name, ys(seat.second), seat.past, seat.dot], ['Fable', [90, 97], null, 'first']);
  const week = S.lineChart(S.computeStats([sample(at(2026, 9, 28, 9), { h: 30, m: { Fable: 90 } }), sample(at(2026, 9, 28, 18), { h: 2, m: { Fable: 1 } }), sample(day(10), { h: 41, m: { Fable: 7 } })], 'week', NOW));
  assert.deepEqual([week.second.name, ys(week.second)], ['Fable', [null, null, null, null, null, 90, 7]], 'its highest of the day: the only place it is seen');
  // Two models and nothing else: the two fullest, as the rings.
  const two = S.lineChart(S.computeStats([sample(day(9), { m: { Opus: 20, Fable: 90, Haiku: 5 } })], 'day', NOW));
  assert.deepEqual([two.first.name, two.second.name, ys(two.first), ys(two.second)], ['Fable', 'Opus', [90], [20]]);
  // After a lost 5h, a model already drawn is not drawn twice.
  const lost = S.lineChart(S.computeStats([sample(day(9), { h: 5, m: { Fable: 90, Opus: 20 } }), sample(day(10), { m: { Fable: 91, Opus: 21 } })], 'day', NOW));
  assert.deepEqual([lost.first.name, lost.second.name, ys(lost.past)], ['Fable', 'Opus', [5, null]]);
  // One model and no other: nothing to add. A week anywhere in the period keeps the week's place.
  const one = S.lineChart(S.computeStats([sample(day(9), { m: { Fable: 90 } })], 'day', NOW));
  assert.deepEqual([one.first.name, one.second.name, ys(one.second)], ['Fable', null, [null]]);
  const kept = S.lineChart(S.computeStats([sample(day(9), { h: 5, w: 1, m: { Fable: 90 } }), sample(day(10), { h: 6, m: { Fable: 91 } })], 'day', NOW));
  assert.deepEqual([kept.second.name, ys(kept.second)], [null, [1, null]]);
  // The 5h alone keeps its empty second line, as it always had.
  const alone = S.lineChart(S.computeStats([sample(day(9), { h: 5 })], 'day', NOW));
  assert.deepEqual([alone.first.name, alone.second.name, ys(alone.second)], [null, null, [null]]);
});

test('lineChart with nothing to draw: no first line, and a reading with no window draws no point', () => {
  const plot = S.lineChart(S.computeStats([sample(at(2026, 9, 29, 9), { u: 3, l: 50 })], 'day', NOW));
  assert.deepEqual([plot.first, ys(plot.second), plot.past, plot.dot], [null, [null], null, 'second']);
  assert.deepEqual(ys({ points: plot.spend }), [3]);
});

test('a mixed day: the average weighs each reading\'s level by the time it held, near limit too', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { h: 20, w: 95 }),
    sample(day(9, 10), { h: 20, w: 95 }),
    sample(day(9, 20), { w: 95, m: { Fable: 1 } }), // no 5h from here on
    sample(day(9, 30), { w: 95, m: { Fable: 1 } }),
    sample(day(9, 40), { m: { Fable: 60 } }), // and no week
    sample(day(9, 50), { m: { Fable: 60 } }),
  ], 'day', NOW);
  assert.equal(st.avg, (20 * 20 + 95 * 20 + 60 * 10) / 50);
  assert.equal(st.nearMs, 20 * MIN, 'the 20 minutes held at the week\'s 95 %');
  assert.equal(st.peak, 95);
  assert.equal(st.buckets[9].sessionPeak, 20);
  assert.equal(st.hasSession, true);
});

test('average is time-weighted over observed pairs, not a plain sample mean', () => {
  // Uneven cadence: 15 min apart while idle at 20 %, 3 min apart while busy at 80 %.
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const hs = [[0, 20], [15, 20], [30, 80], [33, 80], [36, 80], [39, 20]];
  const st = S.computeStats(hs.map(([mi, h]) => sample(day(10, mi), { h })), 'day', NOW);
  const plain = hs.reduce((a, [, h]) => a + h, 0) / hs.length;
  assert.equal(plain, 50);
  // 20 % held for 30 min, 80 % for 9 min
  const weighted = (20 * 30 + 80 * 9) / 39;
  assert.ok(Math.abs(st.avg - weighted) < 1e-9, `${st.avg} vs ${weighted}`);
  assert.ok(Math.abs(st.buckets[10].avg - weighted) < 1e-9);
  assert.ok(st.avg < 34);
});

test('average: an unobserved gap carries no weight; a lone sample counts as its own value', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(8, 0), { h: 10 }),
    sample(day(8, 10), { h: 10 }),
    sample(day(12, 0), { h: 90 }), // 3 h 50 m later: the 10 % is not held across it
    sample(day(12, 10), { h: 90 }),
    sample(day(14, 30), { h: 70 }), // alone in its bucket
  ], 'day', NOW);
  assert.equal(st.avg, 50, '10 % for 10 min and 90 % for 10 min');
  assert.equal(st.buckets[8].avg, 10);
  assert.equal(st.buckets[12].avg, 90);
  assert.equal(st.buckets[14].avg, 70, 'lone sample');
  assert.equal(st.buckets[13].avg, null);

  const lone = S.computeStats([sample(day(9, 0), { h: 42 })], 'day', NOW);
  assert.equal(lone.avg, 42);
  assert.equal(lone.observedMs, 0);
});

test('average per bucket splits a pair at the bucket edge', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(10, 50), { h: 60 }),
    sample(day(11, 5), { h: 20 }),
    sample(day(11, 15), { h: 20 }),
  ], 'day', NOW);
  assert.equal(st.buckets[10].avg, 60, '10 min of 60 %');
  // 5 min of 60 % (held from 10:50) + 10 min of 20 %
  assert.ok(Math.abs(st.buckets[11].avg - (60 * 5 + 20 * 10) / 15) < 1e-9);
  assert.equal(st.buckets[10].observedMs, 10 * MIN);
  assert.equal(st.buckets[11].observedMs, 15 * MIN);
});

test('In use and Near limit: an observed pair adds its full Δt, a gap over GAP_MAX_MS adds nothing', () => {
  assert.equal(S.GAP_MAX_MS, 20 * MIN);
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const samples = [
    sample(day(9, 0), { h: 91, w: 50 }),
    sample(day(9, 20), { h: 95, w: 50 }), // Δ20 = the limit, still observed: near +20, rising +20
    sample(day(9, 41), { h: 97, w: 51 }), // Δ21: unobserved, adds nothing although it rose from 95
    sample(day(9, 51), { h: 96, w: 51 }), // Δ10 from 97: near +10, nothing rose
    sample(day(10, 1), { h: 85, w: 51 }), // Δ10 from 96: near +10
    sample(day(10, 11), { h: 85, w: 52 }), // Δ10: only 7d rose → in use +10; 85 < 90
    sample(day(10, 21), { h: 85, w: 52, m: { Fable: 40 } }), // no m before: not a rise
    sample(day(10, 31), { h: 85, w: 52, m: { Fable: 41 } }), // scoped rose → in use +10
    sample(day(10, 41), { w: 52, m: { Fable: 41 } }), // h missing: no drop, no near
    sample(day(10, 51), { h: 88, w: 52, m: { Fable: 41 } }), // from a missing h: not a rise
  ];
  const st = S.computeStats(samples, 'day', NOW);
  assert.equal(st.nearMs, 40 * MIN);
  assert.equal(st.inUseMs, 40 * MIN);
  // Maestro's caps would have credited min(Δt, 15 min) / min(Δt, 10 min) across the 21 min gap.
  assert.equal(st.buckets[9].inUseMs, 20 * MIN);
  assert.equal(st.buckets[10].inUseMs, 20 * MIN);
  // Near limit is time held at ≥ 90 %, so a pair is split at the hour:
  // 09:00-09:20 and 09:41-09:51 in 9 o'clock, 09:51 → 10:01 as 9 min + 1 min.
  assert.equal(st.buckets[9].nearMs, 39 * MIN);
  assert.equal(st.buckets[10].nearMs, 1 * MIN);

  // A tighter gap limit turns the 20 min pair into a gap as well.
  const tight = S.computeStats(samples, 'day', NOW, { gapMaxMs: 15 * MIN });
  assert.equal(tight.nearMs, 20 * MIN);
  assert.equal(tight.inUseMs, 20 * MIN);
  // A lower danger line counts the 85 % stretches too.
  const low = S.computeStats(samples, 'day', NOW, { danger: 85 });
  assert.equal(low.nearMs, (20 + 10 + 10 + 10 + 10 + 10 + 10) * MIN);
});

test('In use is credited to the later sample\'s bucket; the pre-window pair is clipped to the window', () => {
  const st = S.computeStats([
    sample(at(2026, 9, 28, 23, 55), { h: 92 }), // yesterday
    sample(at(2026, 9, 29, 0, 5), { h: 93 }),
    sample(at(2026, 9, 29, 0, 55), { h: 10 }),
    sample(at(2026, 9, 29, 1, 5), { h: 12 }),
  ], 'day', NOW);
  assert.equal(st.count, 3, 'the pre-window line is not a window sample');
  assert.equal(st.peak, 93);
  // 23:55 → 00:05 rose: only the 5 minutes inside today count.
  assert.equal(st.buckets[0].inUseMs, 5 * MIN);
  assert.equal(st.buckets[0].nearMs, 5 * MIN);
  // 00:55 → 01:05 rose: all 10 min go to 01:00, the later sample's hour.
  assert.equal(st.buckets[1].inUseMs, 10 * MIN);
  assert.equal(st.inUseMs, 15 * MIN);
  assert.equal(st.nearMs, 5 * MIN);
  // Coverage: 00:00-00:05 (clipped) + 00:55-01:05; the 00:05 → 00:55 gap is unobserved.
  assert.equal(st.observedMs, 15 * MIN);
  assert.equal(st.buckets[0].observedMs, 10 * MIN);
  assert.equal(st.buckets[1].observedMs, 5 * MIN);
});

test('spend: rises count, a reset is ignored, the step from before the window counts', () => {
  const st = S.computeStats([
    sample(at(2026, 9, 28, 23, 50), { h: 5, u: 10, l: 50 }), // before the window
    sample(at(2026, 9, 29, 0, 10), { h: 5, u: 12, l: 50 }), // +2 (from yesterday's reading)
    sample(at(2026, 9, 29, 6, 0), { h: 5, u: 15, l: 50 }), // +3 across a 6 h gap: still money
    sample(at(2026, 9, 29, 7, 0), { h: 5 }), // no spend reading: skipped, no carry-forward
    sample(at(2026, 9, 29, 12, 0), { h: 5, u: 1, l: 60 }), // monthly reset: the drop subtracts nothing
    sample(at(2026, 9, 29, 13, 0), { h: 5, u: 4, l: 60 }), // +3
  ], 'day', NOW, { currency: 'USD' });
  assert.deepEqual(st.spend, { amount: 8, last: 4, limit: 60, currency: 'USD' });
  assert.equal(st.buckets[0].spend, 2);
  assert.equal(st.buckets[6].spend, 3);
  assert.equal(st.buckets[7].spend, 0);
  assert.equal(st.buckets[7].spendLast, null);
  assert.equal(st.buckets[12].spend, 0);
  assert.equal(st.buckets[12].spendLast, 1);
  assert.equal(st.buckets[13].spend, 3);

  // Spend readings only before the window: no spend figure for it.
  const none = S.computeStats([
    sample(at(2026, 9, 28, 20, 0), { u: 10 }),
    sample(at(2026, 9, 29, 9, 0), { h: 5 }),
  ], 'day', NOW);
  assert.equal(none.spend, null);

  // No reading before the window: the first one is a baseline, not a rise.
  const first = S.computeStats([sample(at(2026, 9, 29, 9, 0), { u: 7 }), sample(at(2026, 9, 29, 9, 5), { u: 7.5 })], 'day', NOW);
  assert.equal(first.spend.amount, 0.5);
  assert.equal(first.spend.currency, null);
});

test('busiest bucket: highest peak, then more time in use, then the later one', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  // Each hour: a pair 10 min apart; a rise makes it 10 min in use.
  const hour = (h, a, b) => [sample(day(h, 0), { h: a }), sample(day(h, 10), { h: b })];
  const base = [
    ...hour(8, 79, 80), // peak 80, in use 10
    ...hour(9, 80, 80), // peak 80, in use 0
    ...hour(11, 70, 80), // peak 80, in use 10: tie with 8 → the later wins
  ];
  let st = S.computeStats(base, 'day', NOW);
  assert.equal(st.busiest.start, day(11, 0));
  assert.equal(S.bucketLabel(st.busiest, 'day', true, { hour12: false }), '11:00');

  // More time in use beats a later bucket with the same peak.
  st = S.computeStats([...base, sample(day(8, 20), { h: 80, w: 1 }), sample(day(8, 30), { h: 80, w: 2 })], 'day', NOW);
  assert.equal(st.buckets[8].inUseMs, 20 * MIN);
  assert.equal(st.busiest.start, day(8, 0));

  // A higher peak beats everything.
  st = S.computeStats([...base, sample(day(14, 0), { h: 81 })], 'day', NOW);
  assert.equal(st.busiest.start, day(14, 0));

  // Week: the busiest day.
  st = S.computeStats([sample(at(2026, 9, 25, 10), { h: 90 }), sample(at(2026, 9, 27, 10), { h: 60 })], 'week', NOW);
  assert.equal(st.busiest.start, at(2026, 9, 25));
  assert.equal(S.bucketLabel(st.busiest, 'week', true, { locale: 'en-US' }), 'Friday');
});

test('busiest with a stand-in goes by time in use: a weekly limit is highest just before its reset, not on the day of most use', () => {
  const day = (d, h, mi = 0) => at(2026, 9, d, h, mi);
  const rising = (d, from, n, fields) => Array.from({ length: n }, (_, i) => sample(day(d, 8) + i * 10 * MIN, fields(from + i)));
  // Thursday: climbs for hours. Friday: one rise, to the highest value of the week.
  const week = (fields) => S.computeStats([...rising(24, 5, 40, fields), sample(day(25, 10), fields(45)), sample(day(25, 10, 10), fields(46))], 'week', NOW);
  const onlyWeek = week((w) => ({ w }));
  assert.deepEqual([onlyWeek.buckets[1].peak, onlyWeek.buckets[2].peak], [44, 46]);
  assert.ok(onlyWeek.buckets[1].inUseMs > onlyWeek.buckets[2].inUseMs);
  assert.equal(onlyWeek.busiest.start, at(2026, 9, 24), 'Thursday, though Friday stands higher');
  assert.equal(week((w) => ({ m: { Fable: w } })).busiest.start, at(2026, 9, 24), 'the same on a model alone');
  // A week that mixes both is no different: it still ends on the weekly counter.
  const mixed = S.computeStats([sample(day(23, 9), { h: 60, w: 3 }), ...rising(24, 5, 40, (w) => ({ w })), sample(day(25, 10), { w: 45 }), sample(day(25, 10, 10), { w: 46 })], 'week', NOW);
  assert.equal(mixed.busiest.start, at(2026, 9, 24));
  // A tie: the later one.
  const tie = S.computeStats([sample(day(24, 9), { w: 1 }), sample(day(24, 9, 10), { w: 2 }), sample(day(25, 9), { w: 2 }), sample(day(25, 9, 10), { w: 3 })], 'week', NOW);
  assert.equal(tie.busiest.start, at(2026, 9, 25));
  // Nothing rose: no day was the busiest. With a 5h in every reading the peak still decides.
  assert.equal(S.computeStats([sample(day(24, 9), { w: 40 }), sample(day(24, 9, 10), { w: 40 })], 'week', NOW).busiest, null);
  assert.equal(S.computeStats([sample(day(24, 9), { h: 40 }), sample(day(24, 9, 10), { h: 40 })], 'week', NOW).busiest.start, at(2026, 9, 24));
});

test('coverage: observed time per bucket and in total; no data is none, not 0 %', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { h: 0 }),
    sample(day(9, 10), { h: 0 }),
    sample(day(9, 20), { h: 0 }),
    sample(day(9, 40), { h: 0 }), // Δ20: observed
    sample(day(10, 5), { h: 0 }), // Δ25: not observed
    sample(day(10, 15), { h: 0 }),
  ], 'day', NOW);
  assert.equal(st.observedMs, 50 * MIN);
  assert.equal(st.buckets[9].observedMs, 40 * MIN);
  assert.equal(st.buckets[10].observedMs, 10 * MIN);
  assert.equal(st.elapsedMs, 15.5 * HOUR);
  assert.ok(Math.abs(st.coverage - 50 / (15.5 * 60)) < 1e-12);
  // A 0 % hour is data; an hour without readings is none.
  assert.equal(st.buckets[9].peak, 0);
  assert.equal(st.buckets[9].none, false);
  assert.equal(st.buckets[8].none, true);
  assert.equal(st.buckets[20].none, true);
  // Totals are the sums of the buckets.
  const sum = (k) => st.buckets.reduce((a, b) => a + b[k], 0);
  assert.equal(sum('observedMs'), st.observedMs);
  assert.equal(sum('inUseMs'), st.inUseMs);
  assert.equal(sum('nearMs'), st.nearMs);
  // Week and month count elapsed time up to now.
  assert.equal(S.computeStats([], 'week', NOW).elapsedMs, 6 * 24 * HOUR + 15.5 * HOUR);
});

test('thinSamples folds into at most maxPoints bins: 5h peak, last 7d, last spend', () => {
  const short = [sample(0, { h: 1 })];
  assert.equal(S.thinSamples(short, 720), short);

  const t0 = at(2026, 9, 29, 0);
  const many = Array.from({ length: 2000 }, (_, i) => sample(t0 + i * 30 * 1000, { h: i % 100, w: i, u: i % 7 ? undefined : i }));
  const out = S.thinSamples(many, 720);
  assert.ok(out.length <= 720, `${out.length} points`);
  assert.ok(out.length >= 700);
  assert.equal(out[out.length - 1].t, many[many.length - 1].t);
  assert.equal(out[out.length - 1].w, 1999);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
  assert.equal(Math.max(...out.map((e) => e.h)), 99);
  assert.ok(out.every((e) => e.u === undefined || e.u % 7 === 0));

  // Missing values stay missing; scoped values merge by name, last wins.
  const bin = S.thinSamples([
    sample(0, { w: 5, m: { Fable: 1 } }),
    sample(1000, { h: 7, m: { Opus: 3 } }),
    sample(2000, { m: { Fable: 2 } }),
    sample(10000 * 1000, { h: 1 }),
  ], 2);
  assert.equal(bin.length, 2);
  assert.deepEqual(bin[0], { t: 2, w: 5, h: 7, m: { Fable: 2, Opus: 3 } });
  assert.deepEqual(bin[1], { t: 10000, h: 1 });

  // A gap between readings stays at least as wide after folding.
  const gappy = [
    ...Array.from({ length: 500 }, (_, i) => sample(t0 + i * 30 * 1000, { h: 1 })),
    ...Array.from({ length: 500 }, (_, i) => sample(t0 + 10 * HOUR + i * 30 * 1000, { h: 2 })),
  ];
  const g = S.thinSamples(gappy, 100);
  const gaps = g.slice(1).map((e, i) => (e.t - g[i].t) * 1000);
  assert.ok(Math.max(...gaps) >= 10 * HOUR - 500 * 30 * 1000);
});

test('thinSamples with no h: none is made up, the week and the models survive the folding', () => {
  const t0 = at(2026, 9, 29, 0);
  const many = Array.from({ length: 2000 }, (_, i) => sample(t0 + i * 30 * 1000, { w: i / 100, m: { Fable: i / 50 } }));
  const out = S.thinSamples(many, 720);
  assert.ok(out.length <= 720, `${out.length} points`);
  assert.ok(out.every((e) => !('h' in e) && e.w !== undefined && e.m.Fable !== undefined));
  assert.equal(out[out.length - 1].m.Fable, 1999 / 50);
  assert.equal(out[out.length - 1].w, 1999 / 100);
  const st = S.computeStats(out, 'day', NOW);
  assert.deepEqual([st.hasSession, st.topModel], [false, 'Fable']);
});

test('bucketLabel: hours by the 12/24 h choice, weekdays capitalised, dates in the locale', () => {
  const day = S.statsWindow('day', NOW).buckets;
  assert.equal(S.bucketLabel(day[15], 'day', false, { locale: 'en-US', hour12: false }), '15:00');
  assert.equal(S.bucketLabel(day[0], 'day', false, { locale: 'de-DE', hour12: false }), '00:00');
  assert.equal(S.bucketLabel(day[15], 'day', false, { locale: 'en-US', hour12: true }), '3 PM');
  assert.equal(S.bucketLabel(day[0], 'day', false, { locale: 'en-US', hour12: true }), '12 AM');
  // Without hour12 the locale decides.
  assert.equal(S.bucketLabel(day[15], 'day', false, { locale: 'en-US' }), '3 PM');
  assert.equal(S.bucketLabel(day[15], 'day', false, { locale: 'de-DE' }), '15:00');

  const week = S.statsWindow('week', NOW).buckets; // today, 2026-09-29, is a Tuesday
  assert.equal(S.bucketLabel(week[6], 'week', false, { locale: 'en-US' }), 'Tue');
  assert.equal(S.bucketLabel(week[6], 'week', true, { locale: 'en-US' }), 'Tuesday');
  assert.equal(S.bucketLabel(week[6], 'week', false, { locale: 'ru-RU' }), 'Вт');
  assert.equal(S.bucketLabel(week[6], 'week', true, { locale: 'uk-UA' }), 'Вівторок');
  assert.equal(S.bucketLabel(week[6], 'week', true, { locale: 'de-DE' }), 'Dienstag');

  const month = S.statsWindow('month', NOW).buckets;
  assert.equal(S.bucketLabel(month[29], 'month', false, { locale: 'en-US' }), 'Sep 29');
  assert.equal(S.bucketLabel(month[0], 'month', true, { locale: 'en-US' }), 'Aug 31');
  assert.equal(S.bucketLabel(month[29], 'month', false, { locale: 'de-DE' }), '29. Sept.');
});

test('fmtDurationMs: minutes, hours and minutes, whole hours from 10 h', () => {
  assert.equal(S.fmtDurationMs(0), '0m');
  assert.equal(S.fmtDurationMs(44.6 * MIN), '45m');
  assert.equal(S.fmtDurationMs(2 * HOUR), '2h');
  assert.equal(S.fmtDurationMs(2 * HOUR + 13 * MIN), '2h 13m');
  assert.equal(S.fmtDurationMs(12 * HOUR + 29 * MIN), '12h');
  assert.equal(S.fmtDurationMs(12 * HOUR + 30 * MIN), '13h');
  assert.equal(S.fmtDurationMs(-5), '0m');
  assert.equal(S.fmtDurationMs(NaN), '');
  assert.equal(S.fmtDurationMs(null), '');
  // Through a translator with the dur.* keys.
  const ru = { 'dur.hm': '{h} ч {m} мин', 'dur.h': '{h} ч', 'dur.m': '{m} мин' };
  const t = (key, vars) => ru[key].replace(/\{(\w+)\}/g, (_, n) => vars[n]);
  assert.equal(S.fmtDurationMs(90 * MIN, t), '1 ч 30 мин');
  assert.equal(S.fmtDurationMs(5 * MIN, t), '5 мин');
});

test('does not mutate its input', () => {
  const input = [sample(at(2026, 9, 29, 9, 10), { h: 30, m: { Fable: 1 } }), sample(at(2026, 9, 29, 9, 0), { h: 20 })];
  const copy = JSON.parse(JSON.stringify(input));
  S.computeStats(input, 'day', NOW);
  S.thinSamples(input, 1);
  assert.deepEqual(input, copy);
});
