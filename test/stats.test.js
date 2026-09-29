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

test('peak and weekLast per bucket; a missing h is skipped, not a 0', () => {
  const day = (h, mi) => at(2026, 9, 29, h, mi);
  const st = S.computeStats([
    sample(day(9, 0), { h: 40, w: 10 }),
    sample(day(9, 10), { w: 11 }),
    sample(day(9, 20), { h: 35, w: 12 }),
    sample(day(10, 0), { w: 13 }),
  ], 'day', NOW);
  assert.equal(st.buckets[9].peak, 40);
  assert.equal(st.buckets[9].weekLast, 12);
  assert.equal(st.buckets[10].peak, null, 'no h in the bucket');
  assert.equal(st.buckets[10].weekLast, 13);
  assert.equal(st.buckets[10].none, false, 'it has data, just no 5h value');
  assert.equal(st.peak, 40);
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
