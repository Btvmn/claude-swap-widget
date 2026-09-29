// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:2010-2178, 2244-2266).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// Pure aggregation for the statistics view: period buckets in local time and
// the figures drawn from one account's usage history. No DOM, no Node APIs,
// so it is a tiny UMD module like usage.js: `require()` in tests, `<script>`
// in the renderer (exposed as `window.Stats`).
//
// Input samples are the history store's lines for one account:
//   { t: <epoch seconds>, a?, h?: 5h pct, w?: 7d pct, r5?, m?: {name: pct}, u?: spend, l?: limit }
// A missing value is missing, never 0: it neither drops nor rises.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Stats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PERIODS = ['day', 'week', 'month'];
  const MINUTE_MS = 60 * 1000;
  // Two consecutive samples further apart than this were not watched in
  // between (app closed, laptop asleep, cswap failing). cswap re-measures an
  // account at most every 600 s + 10 % jitter, so 20 min is well above its
  // normal cadence and far below a night.
  const GAP_MAX_MS = 20 * MINUTE_MS;
  // Same red as the rings (Usage.CRIT); callers pass their own `danger`.
  const DANGER = 90;

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  // Bucket edges in local time, from calendar arithmetic so DST days stay
  // right: the fall-back day has one 2 h bucket, the spring-forward day one
  // empty bucket (its hour does not exist). Day buckets also carry their
  // nominal `hour`, so labels stay 0…23 on both.
  function statsWindow(period, nowMs) {
    const today = new Date(nowMs);
    today.setHours(0, 0, 0, 0);
    const buckets = [];
    if (period === 'week' || period === 'month') {
      const days = period === 'week' ? 7 : 30;
      for (let i = days - 1; i >= 0; i--) {
        const from = new Date(today);
        from.setDate(from.getDate() - i);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        buckets.push({ start: from.getTime(), end: to.getTime() });
      }
    } else {
      // Anything unknown is Today, the default view.
      for (let h = 0; h < 24; h++) {
        const from = new Date(today);
        from.setHours(h);
        const to = new Date(today);
        to.setHours(h + 1);
        buckets.push({ start: from.getTime(), end: to.getTime(), hour: h });
      }
    }
    return { start: buckets[0].start, end: buckets[buckets.length - 1].end, buckets };
  }

  // Any window that went up between two readings: the 5h, the 7d or a scoped
  // one. Both readings must have the value.
  function rose(prev, cur) {
    const up = (a, b) => isNum(a) && isNum(b) && b > a;
    if (up(prev.h, cur.h) || up(prev.w, cur.w)) return true;
    if (cur.m && typeof cur.m === 'object' && prev.m && typeof prev.m === 'object') {
      for (const name of Object.keys(cur.m)) {
        if (Object.prototype.hasOwnProperty.call(prev.m, name) && up(prev.m[name], cur.m[name])) return true;
      }
    }
    return false;
  }

  // What changed against Maestro (their computeStats, app.js:2074-2131):
  // - Average is time-weighted over observed pairs: cswap measures every 3 min
  //   while usage moves and every 10 min while idle, so a plain mean leans
  //   towards busy stretches.
  // - In use (their "Active") and Near limit add a pair's full Δt when it was
  //   observed (Δt ≤ gapMaxMs) and nothing otherwise, instead of min(Δt, cap)
  //   across any gap.
  // - Spend is in currency: the sum of the rises of `u`, without carry-forward.
  // - Coverage (observed time) is new, so "no data" and 0 % differ.
  // The last sample before the window opens the first pair, clipped to the
  // window start, and the last reading with `u` gives the first spend step.
  function computeStats(samples, period, nowMs = Date.now(), opts = {}) {
    const danger = isNum(opts.danger) ? opts.danger : DANGER;
    const gapMaxMs = isNum(opts.gapMaxMs) ? opts.gapMaxMs : GAP_MAX_MS;
    const win = statsWindow(period, nowMs);
    const sorted = (Array.isArray(samples) ? samples : [])
      .filter((e) => e && isNum(e.t))
      .map((e) => ({ e, ms: e.t * 1000 }))
      .sort((a, b) => a.ms - b.ms);

    let pre = null; // last reading before the window
    let lastU = null; // last spend reading before the window
    const inWin = [];
    for (const s of sorted) {
      if (s.ms < win.start) {
        pre = s;
        if (isNum(s.e.u)) lastU = s.e.u;
      } else if (s.ms < win.end) {
        inWin.push(s);
      }
    }

    const buckets = win.buckets.map((b) => ({
      ...b,
      future: b.start > nowMs,
      current: b.start <= nowMs && nowMs < b.end,
      n: 0,
      peak: null,
      weekLast: null, // where the week stood at the end of the bucket
      avg: null,
      observedMs: 0,
      inUseMs: 0,
      nearMs: 0,
      spend: 0,
      spendLast: null,
      none: false,
    }));
    // Accumulators for the averages, kept out of the returned buckets.
    const acc = buckets.map(() => ({ tw: 0, twMs: 0, hSum: 0, hN: 0 }));
    const total = { tw: 0, twMs: 0, hSum: 0, hN: 0 };

    let peak = null;
    let observedMs = 0;
    let inUseMs = 0;
    let nearMs = 0;
    let spendUp = 0;
    let hasSpend = false;
    let limit = null;
    let bi = 0;
    let prev = pre;

    // Credits [from, to) to every bucket it overlaps, walking back from the
    // later sample's bucket; the held value is the earlier reading's.
    function spread(from, to, h, lastIndex) {
      for (let j = lastIndex; j >= 0; j--) {
        const b = buckets[j];
        const part = Math.min(to, b.end) - Math.max(from, b.start);
        if (part > 0) {
          b.observedMs += part;
          if (isNum(h)) {
            acc[j].tw += h * part;
            acc[j].twMs += part;
            if (h >= danger) b.nearMs += part;
          }
        }
        if (b.start <= from) break;
      }
    }

    for (const s of inWin) {
      const e = s.e;
      while (bi < buckets.length - 1 && s.ms >= buckets[bi].end) bi++;
      const b = buckets[bi];
      b.n++;
      if (isNum(e.h)) {
        b.peak = b.peak === null ? e.h : Math.max(b.peak, e.h);
        peak = peak === null ? e.h : Math.max(peak, e.h);
        acc[bi].hSum += e.h;
        acc[bi].hN++;
        total.hSum += e.h;
        total.hN++;
      }
      if (isNum(e.w)) b.weekLast = e.w;
      if (isNum(e.l)) limit = e.l;

      // Spend: every rise counts, even across a gap (it is still money); a
      // drop is the monthly reset and subtracts nothing.
      if (isNum(e.u)) {
        if (lastU !== null && e.u > lastU) {
          spendUp += e.u - lastU;
          b.spend += e.u - lastU;
        }
        lastU = e.u;
        b.spendLast = e.u;
        hasSpend = true;
      }

      if (prev) {
        const from = Math.max(prev.ms, win.start);
        const to = s.ms;
        if (s.ms - prev.ms <= gapMaxMs && to > from) {
          const h = prev.e.h;
          spread(from, to, h, bi);
          observedMs += to - from;
          if (isNum(h)) {
            total.tw += h * (to - from);
            total.twMs += to - from;
            if (h >= danger) nearMs += to - from;
          }
          if (rose(prev.e, e)) {
            inUseMs += to - from;
            b.inUseMs += to - from;
          }
        }
      }
      prev = s;
    }

    buckets.forEach((b, i) => {
      const a = acc[i];
      // A bucket whose readings have no observed time after them (a lone
      // sample) falls back to their plain mean.
      b.avg = a.twMs > 0 ? a.tw / a.twMs : a.hN ? a.hSum / a.hN : null;
      b.none = b.n === 0 && b.observedMs === 0;
    });

    // Busiest bucket: the highest peak; on a tie the one with more time in
    // use, then the later one.
    let busiest = null;
    for (const b of buckets) {
      if (b.peak === null) continue;
      if (!busiest || b.peak > busiest.peak || (b.peak === busiest.peak && b.inUseMs >= busiest.inUseMs)) busiest = b;
    }

    const elapsedMs = Math.max(0, Math.min(nowMs, win.end) - win.start);
    return {
      period: PERIODS.includes(period) ? period : 'day',
      win,
      buckets,
      samples: inWin.map((s) => s.e),
      count: inWin.length,
      peak,
      avg: total.twMs > 0 ? total.tw / total.twMs : total.hN ? total.hSum / total.hN : null,
      nearMs,
      inUseMs,
      observedMs,
      elapsedMs,
      coverage: elapsedMs > 0 ? Math.min(1, observedMs / elapsedMs) : null,
      spend: hasSpend ? { amount: spendUp, last: lastU, limit, currency: opts.currency || null } : null,
      busiest,
      currentIndex: buckets.findIndex((b) => b.current),
    };
  }

  // A day of readings on a narrow line: fold them into at most maxPoints bins
  // of equal time. Each bin keeps the 5h peak and the last 7d, scoped, spend
  // and limit values, stamped with its last reading's time. A gap between
  // readings stays at least as wide as it was.
  function thinSamples(samples, maxPoints = 720) {
    if (!Array.isArray(samples) || samples.length <= maxPoints) return samples;
    const first = samples[0].t;
    const bin = Math.max(1, (samples[samples.length - 1].t - first) / maxPoints);
    const out = [];
    let current = null;
    let key = null;
    for (const e of samples) {
      const k = Math.min(maxPoints - 1, Math.floor((e.t - first) / bin));
      if (k !== key) {
        if (current) out.push(current);
        current = { ...e };
        key = k;
        continue;
      }
      if (isNum(e.h)) current.h = isNum(current.h) ? Math.max(current.h, e.h) : e.h;
      if (isNum(e.w)) current.w = e.w;
      if (isNum(e.u)) current.u = e.u;
      if (isNum(e.l)) current.l = e.l;
      if (e.m && typeof e.m === 'object') current.m = { ...(current.m || {}), ...e.m };
      if (e.r5 !== undefined) current.r5 = e.r5;
      if (e.a !== undefined) current.a = e.a;
      current.t = e.t;
    }
    if (current) out.push(current);
    return out;
  }

  // ---- labels ----

  // 12/24 h from the locale when the caller does not say (main normally
  // resolves it from the timeFormat setting and passes it in).
  function localeHour12(locale) {
    try {
      const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
      return cycle === 'h11' || cycle === 'h12';
    } catch {
      return false;
    }
  }

  // '15:00' or '3 PM'. Built from the nominal hour on a fixed UTC date, so a
  // DST day's buckets are still labelled 0…23.
  function hourLabel(hour, locale, hour12) {
    if (!hour12) return `${String(hour).padStart(2, '0')}:00`;
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' })
      .format(new Date(Date.UTC(2000, 0, 1, hour)));
  }

  function capitalize(text, locale) {
    return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
  }

  function dayLabel(ms, form, locale) {
    const d = new Date(ms);
    if (form === 'weekday') return capitalize(new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d), locale);
    if (form === 'weekdayLong') return capitalize(new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d), locale);
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(d);
  }

  // A bucket's name: '15:00' / '3 PM', 'Fri' ('Friday' when long), 'Sep 26'.
  // `locale` undefined means the runtime's default.
  function bucketLabel(bucket, period, long, { locale, hour12 } = {}) {
    if (period === 'week') return dayLabel(bucket.start, long ? 'weekdayLong' : 'weekday', locale);
    if (period === 'month') return dayLabel(bucket.start, 'date', locale);
    const hour = isNum(bucket.hour) ? bucket.hour : new Date(bucket.start).getHours();
    return hourLabel(hour, locale, typeof hour12 === 'boolean' ? hour12 : localeHour12(locale));
  }

  const DUR_EN = { 'dur.hm': '{h}h {m}m', 'dur.h': '{h}h', 'dur.m': '{m}m' };

  function english(key, vars) {
    return DUR_EN[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
  }

  // '45m', '2h 13m', '12h' (whole hours from 10 h on). `t` is an I18n
  // translator with the dur.* keys; English without it.
  function fmtDurationMs(ms, t) {
    if (!isNum(ms)) return '';
    const say = typeof t === 'function' ? t : english;
    const total = Math.round(Math.max(0, ms) / MINUTE_MS);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return say('dur.m', { m });
    if (h >= 10) return say('dur.h', { h: m >= 30 ? h + 1 : h });
    return m === 0 ? say('dur.h', { h }) : say('dur.hm', { h, m });
  }

  return {
    PERIODS,
    GAP_MAX_MS,
    DANGER,
    statsWindow,
    computeStats,
    thinSamples,
    bucketLabel,
    fmtDurationMs,
  };
});
