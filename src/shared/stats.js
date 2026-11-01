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
//
// Peak, Average, Near limit and the busiest bucket read a reading's level: its
// 5h, else the fullest of its weekly limits (the 7d and the model windows). An
// account with no 5-hour window keeps its cards, bars and strip that way, and
// they agree with the chart's lines; a reading with a 5h behaves as if the
// others were not there. What must not show a stand-in reads `sessionPeak` (the
// strict 5h peak); `peakWindow` names the limit a bucket's stand-in came from,
// `allSession` says a period has none.
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

  // The model windows a reading has a number for: its own names, never
  // `__proto__` (the files can be edited).
  function modelNames(e) {
    if (!e.m || typeof e.m !== 'object') return [];
    return Object.keys(e.m).filter((name) => name !== '__proto__' && isNum(e.m[name]));
  }

  // A reading's level (see the top); null when no window in it has a number.
  function level(e) {
    if (isNum(e.h)) return e.h;
    const values = modelNames(e).map((name) => e.m[name]);
    if (isNum(e.w)) values.push(e.w);
    return values.length ? Math.max(...values) : null;
  }

  // Where that level came from when it is not a 5h: '7d' (which wins a tie) or
  // a model's name.
  function levelWindow(e, lv) {
    if (isNum(e.h)) return null;
    if (isNum(e.w) && e.w === lv) return '7d';
    return modelNames(e).find((name) => e.m[name] === lv) || null;
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
      peak: null, // the highest level
      sessionPeak: null, // the highest 5h, nothing else
      peakWindow: null, // '7d' or a model's name when `peak` is not a 5h value
      weekLast: null, // where the week stood at the end of the bucket
      modelLast: null, // { name: pct }: where each model stood at the end of the bucket
      avg: null,
      observedMs: 0,
      inUseMs: 0,
      nearMs: 0,
      spend: 0,
      spendLast: null,
      none: false,
    }));
    // Accumulators for the averages, kept out of the returned buckets.
    const acc = buckets.map(() => ({ tw: 0, twMs: 0, sum: 0, n: 0 }));
    const total = { tw: 0, twMs: 0, sum: 0, n: 0 };

    let peak = null;
    let hasSession = false;
    let allSession = true; // no reading in the window stands in with a 7d or a model
    const modelLatest = new Map(); // name → its last reading in the window
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
    function spread(from, to, held, lastIndex) {
      for (let j = lastIndex; j >= 0; j--) {
        const b = buckets[j];
        const part = Math.min(to, b.end) - Math.max(from, b.start);
        if (part > 0) {
          b.observedMs += part;
          if (held !== null) {
            acc[j].tw += held * part;
            acc[j].twMs += part;
            if (held >= danger) b.nearMs += part;
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
      const lv = level(e);
      if (lv !== null) {
        // The peak is what the bar shows, so its name follows it; a tie is the 5h's.
        if (b.peak === null || lv > b.peak || (lv === b.peak && isNum(e.h))) {
          b.peak = lv;
          b.peakWindow = levelWindow(e, lv);
        }
        peak = peak === null ? lv : Math.max(peak, lv);
        acc[bi].sum += lv;
        acc[bi].n++;
        total.sum += lv;
        total.n++;
        if (!isNum(e.h)) allSession = false;
      }
      if (isNum(e.h)) {
        b.sessionPeak = b.sessionPeak === null ? e.h : Math.max(b.sessionPeak, e.h);
        hasSession = true;
      }
      if (isNum(e.w)) b.weekLast = e.w;
      for (const name of modelNames(e)) {
        if (!b.modelLast) b.modelLast = {};
        b.modelLast[name] = e.m[name];
        modelLatest.set(name, e.m[name]);
      }
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
          const held = level(prev.e);
          spread(from, to, held, bi);
          observedMs += to - from;
          if (held !== null) {
            total.tw += held * (to - from);
            total.twMs += to - from;
            if (held >= danger) nearMs += to - from;
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
      b.avg = a.twMs > 0 ? a.tw / a.twMs : a.n ? a.sum / a.n : null;
      b.none = b.n === 0 && b.observedMs === 0;
    });

    // Busiest bucket: the highest peak; on a tie the one with more time in
    // use, then the later one.
    let busiest = null;
    for (const b of buckets) {
      if (b.peak === null) continue;
      if (!busiest || b.peak > busiest.peak || (b.peak === busiest.peak && b.inUseMs >= busiest.inUseMs)) busiest = b;
    }

    // The model that stands highest at its last reading; a tie keeps the one
    // seen first.
    let topModel = null;
    for (const [name, pct] of modelLatest) {
      if (topModel === null || pct > modelLatest.get(topModel)) topModel = name;
    }

    const elapsedMs = Math.max(0, Math.min(nowMs, win.end) - win.start);
    return {
      period: PERIODS.includes(period) ? period : 'day',
      win,
      buckets,
      samples: inWin.map((s) => s.e),
      count: inWin.length,
      peak,
      avg: total.twMs > 0 ? total.tw / total.twMs : total.n ? total.sum / total.n : null,
      nearMs,
      inUseMs,
      observedMs,
      elapsedMs,
      coverage: elapsedMs > 0 ? Math.min(1, observedMs / elapsedMs) : null,
      spend: hasSpend ? { amount: spendUp, last: lastU, limit, currency: opts.currency || null } : null,
      busiest,
      hasSession,
      allSession,
      topModel,
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
