// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:1488-1566,
// 1832-1929, 2917-2944; src/renderer/index.html:136-196).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
'use strict';

// The active account in their two big rings (window.Hero). The DOM is built
// once and then patched in place, never rebuilt, so the 1.2 s arc ease and
// the number count-up play on every refresh and switch.
//
//   Hero.render(el, row | null, ctx)   the active account's cswap row
//   Hero.tick(now)                     countdowns + time arcs, every second

(function () {
  const { h, svg } = window.Dom;
  const Usage = window.Usage;
  const I18nDom = window.I18nDom;
  const t = (key, vars) => I18nDom.t(key, vars);

  const WARN = Usage.WARN;
  const CRIT = Usage.CRIT;
  const R_USAGE = 42;
  const R_TIME = 33;
  const C_USAGE = 2 * Math.PI * R_USAGE; // 263.89
  const C_TIME = 2 * Math.PI * R_TIME; // 207.35
  const WINDOW_MIN = { '5h': 300, '7d': 10080 };

  let root = null;
  let parts = null; // the gauges' elements, built once
  let current = null; // { row, usage, stale, settings }
  let expanded = false; // the "more limits" section (settings.heroExpanded)
  let extraSig = null;

  // ── build once ──────────────────────────────────────────────────

  // Their gauge: track, threshold ticks (plus our pace tick on the week),
  // the usage arc with a gradient from its start, a thin time arc inside.
  function gauge(id, win) {
    const gradId = `${id}ArcGradient`;
    const usage = svg('circle', {
      id: `${id}Progress`,
      class: win === '7d' ? 'ring-usage weekly' : 'ring-usage',
      cx: 48,
      cy: 48,
      r: R_USAGE,
      'stroke-dasharray': C_USAGE.toFixed(2),
      'stroke-dashoffset': C_USAGE.toFixed(2),
      stroke: `url(#${gradId})`,
    });
    const time = svg('circle', {
      id: `${id}Timer`,
      class: 'timer-progress ring-time',
      cx: 48,
      cy: 48,
      r: R_TIME,
      'stroke-dasharray': C_TIME.toFixed(2),
      'stroke-dashoffset': C_TIME.toFixed(2),
    });
    const tickWarn = svg('circle', { class: 'ring-tick ring-tick-warn', r: 1.9 });
    const tickDanger = svg('circle', { class: 'ring-tick ring-tick-danger', r: 1.9 });
    const tickPace = win === '7d' ? svg('circle', { class: 'ring-tick ring-tick-pace', r: 1.9 }) : null;
    placeTick(tickWarn, WARN);
    placeTick(tickDanger, CRIT);
    const ring = svg(
      'svg',
      { class: 'ring', width: 96, height: 96, viewBox: '0 0 96 96', 'aria-hidden': 'true' },
      svg(
        'defs',
        null,
        svg(
          'linearGradient',
          { id: gradId, gradientUnits: 'userSpaceOnUse', x1: 90, y1: 48, x2: 48, y2: 90 },
          svg('stop', { class: 'arc-stop-a', offset: 0 }),
          svg('stop', { class: 'arc-stop-b', offset: 1 }),
        ),
      ),
      svg('circle', { class: 'ring-track', cx: 48, cy: 48, r: R_USAGE }),
      tickWarn,
      tickDanger,
      tickPace,
      usage,
      svg('circle', { class: 'ring-time-track', cx: 48, cy: 48, r: R_TIME }),
      time,
    );
    const num = h('span', { id: `${id}Percentage`, class: 'gauge-num' }, '—');
    const countdown = h('div', { id: `${id}TimeText`, class: 'gauge-countdown timer-text' });
    const reset = h('div', { id: `${id}ResetsAt`, class: 'gauge-reset resets-at-text' });
    const pace = win === '7d' ? h('div', { id: 'weeklyPace', class: 'gauge-pace', hidden: true }) : null;
    const metaPct = h('div', { class: 'gauge-meta-pct' });
    const el = h(
      'div',
      { id: `${id}Gauge`, class: 'gauge', 'data-window': win },
      h('div', { class: 'gauge-ring' }, ring, h('div', { class: 'gauge-value' }, num)),
      h('div', { class: 'gauge-meta' }, h('span', { class: 'gauge-label', 'data-i18n': win === '7d' ? 'gauge.weekly' : 'gauge.session' }, t(win === '7d' ? 'gauge.weekly' : 'gauge.session')), metaPct, countdown, reset, pace),
    );
    return { el, win, usage, time, num, metaPct, countdown, reset, pace, tickPace, window: null };
  }

  // Ticks sit on the usage track; the ring is turned −90° by CSS, so angle 0
  // is twelve o'clock.
  function placeTick(tick, pct) {
    if (!tick) return;
    const angle = (2 * Math.PI * Math.min(Math.max(pct, 0), 100)) / 100;
    tick.setAttribute('cx', (48 + R_USAGE * Math.cos(angle)).toFixed(2));
    tick.setAttribute('cy', (48 + R_USAGE * Math.sin(angle)).toFixed(2));
  }

  function build(el) {
    const status = h('div', { id: 'heroStatus', class: 'pills' });
    const menu = h(
      'button',
      { id: 'heroMenu', class: 'icon-btn small', type: 'button' },
      svg('svg', { class: 'solid', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [5.5, 12, 18.5].map((cx) => svg('circle', { cx, cy: 12, r: 1.7 }))),
    );
    const session = gauge('session', '5h');
    const weekly = gauge('weekly', '7d');
    const empty = h('div', { class: 'hero-empty', hidden: true }, h('p', { class: 'hero-empty-title' }), h('p', { class: 'hero-empty-hint' }));
    const noUsage = h('p', { class: 'hero-no-usage', hidden: true });
    const gauges = h('div', { class: 'gauges' }, session.el, weekly.el);
    const toggle = h(
      'button',
      { id: 'expandToggle', class: 'expand-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'expandSection', hidden: true },
      svg('svg', { class: 'expand-arrow', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('polyline', { points: '6 9 12 15 18 9' })),
    );
    const extra = h('div', { id: 'extraRows' });
    const section = h('div', { id: 'expandSection', class: 'expand-section', hidden: true }, extra);
    el.replaceChildren(h('div', { class: 'hero-status' }, status, menu), gauges, noUsage, toggle, section, empty);
    return { status, menu, session, weekly, gauges, empty, noUsage, toggle, section, extra };
  }

  // ── more limits: per-model weekly windows and extra-usage spend ────

  // Rows under the rings, their expand section: label | bar | % | time or amount.
  function extraRows(usage, now) {
    const rows = [];
    for (const w of usage && Array.isArray(usage.scoped) ? usage.scoped : []) {
      if (!w || typeof w.pct !== 'number') continue;
      const secs = w.resetsAt && !Usage.resetPassed(w, now) ? Usage.secondsUntil(w.resetsAt, now) : null;
      rows.push({
        key: `model|${w.name || '?'}`,
        resetsAt: w.resetsAt || null,
        label: t('model.week', { name: w.name || '?' }),
        pct: w.pct,
        side: secs == null ? '' : I18nDom.duration(secs),
        tip: w.resetsAt ? t('reset.on', { date: window.I18n.formatDay(I18nDom.locale(), w.resetsAt, 'date-day-time', I18nDom.hour12()) }) : '',
      });
    }
    const spend = usage && usage.spend;
    if (spend && typeof spend.used === 'number') {
      const money = (v) => window.I18n.formatMoney(I18nDom.locale(), v, spend.currency || 'USD');
      rows.push({
        key: 'spend',
        label: t('spend.monthly'),
        pct: typeof spend.pct === 'number' ? spend.pct : typeof spend.limit === 'number' && spend.limit > 0 ? (100 * spend.used) / spend.limit : null,
        spend: { used: money(spend.used), limit: typeof spend.limit === 'number' ? money(spend.limit) : '—', over: typeof spend.limit === 'number' && spend.used > spend.limit },
      });
    }
    return rows;
  }

  function paintExtra(rows, expanded) {
    parts.toggle.hidden = rows.length === 0;
    const open = rows.length > 0 && expanded;
    parts.section.hidden = !open;
    parts.toggle.setAttribute('aria-expanded', String(open));
    parts.toggle.classList.toggle('open', open);
    const tip = t('hero.more');
    parts.toggle.title = tip;
    parts.toggle.setAttribute('aria-label', tip);
    if (!open) return;
    // Bars ease from their previous width (the same trick as the account rows).
    const before = new Map([...parts.extra.querySelectorAll('[data-fill]')].map((f) => [f.dataset.fill, f.style.width]));
    parts.extra.replaceChildren(
      ...rows.map((r) => {
        const pct = r.pct === null ? null : Math.min(Math.max(r.pct, 0), 100);
        const lvl = Usage.level(pct);
        const fill = h('div', { class: `progress-fill${lvl === 'crit' ? ' danger' : lvl === 'warn' ? ' warning' : ''}`, 'data-fill': r.key, 'data-pct': pct === null ? '0' : String(pct) });
        const side = h('span', { class: 'extra-side', 'data-resets-at': r.resetsAt || null });
        if (r.spend) {
          I18nDom.fillPhrase(side, 'spend.of', { used: [r.spend.used, r.spend.over ? 'spend-used over' : 'spend-used'], limit: [r.spend.limit, 'spend-limit'] });
        } else {
          side.textContent = r.side;
        }
        return h(
          'div',
          { class: 'extra-row', title: r.tip || null },
          h('span', { class: 'extra-label' }, r.label),
          h('div', { class: 'progress-bar' }, fill),
          h('span', { class: `extra-pct${lvl === 'crit' ? ' crit' : lvl === 'warn' ? ' warn' : ''}` }, pct === null ? '—' : I18nDom.pct(pct)),
          side,
        );
      }),
    );
    const fills = [...parts.extra.querySelectorAll('[data-fill]')];
    for (const f of fills) f.style.width = before.get(f.dataset.fill) || '0%';
    requestAnimationFrame(() => {
      for (const f of fills) f.style.width = `${f.dataset.pct}%`;
    });
  }

  // ── numbers ─────────────────────────────────────────────────────

  // The number counts up to its new value; on first show it starts from zero.
  function animatePercent(el, to, duration = 900) {
    if (to === null) {
      if (el._raf) cancelAnimationFrame(el._raf);
      el._raf = 0;
      delete el.dataset.v;
      el.replaceChildren('—');
      return;
    }
    if (el._raf && el.dataset.v === String(to)) return;
    const from = el.dataset.v === undefined ? 0 : Number(el.dataset.v);
    el.dataset.v = String(to);
    const paint = (v) => {
      const pct = document.createElement('span');
      pct.className = 'gauge-pct';
      pct.textContent = '%';
      el.replaceChildren(document.createTextNode(String(Math.round(v))), pct);
    };
    if (el._raf) cancelAnimationFrame(el._raf);
    el._raf = 0;
    if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(to);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / duration);
      paint(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      el._raf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    el._raf = requestAnimationFrame(step);
  }

  // One gauge from one cswap window ({pct, resetsAt, expectedPct?, aheadOfPace?}).
  function paintGauge(g, win, stale, now) {
    g.window = win || null;
    const pct = win && typeof win.pct === 'number' ? Math.min(Math.max(win.pct, 0), 100) : null;
    const passed = Boolean(win && Usage.resetPassed(win, now));
    const shown = pct === null ? null : Math.round(pct);
    const lvl = Usage.level(pct);
    const cls = {
      'is-warning': lvl === 'warn' && !stale && !passed,
      'is-danger': lvl === 'crit' && !stale && !passed,
      'is-stale': Boolean(stale || passed),
      'has-value': pct !== null && pct > 0,
      'is-idle': !win || !win.resetsAt,
    };
    // A ring in flight lands on these values instead of jumping to them now;
    // its colour and number follow when it starts to land.
    const flight = flightFor(g);
    if (flight) {
      flight.target = (pct || 0) / 100;
      flight.shown = shown;
      if (flight.released) {
        applyClasses(g, cls);
        animatePercent(g.num, shown, 400);
        animatePercent(g.metaPct, shown, 400);
      } else {
        flight.pendingCls = cls;
        g.el.classList.add('has-value'); // the comet must stay visible
      }
    } else {
      g.usage.style.strokeDashoffset = String(C_USAGE * (1 - (pct || 0) / 100));
      animatePercent(g.num, shown);
      animatePercent(g.metaPct, shown);
      applyClasses(g, cls);
    }

    if (g.pace) {
      const expected = win && typeof win.expectedPct === 'number' ? win.expectedPct : null;
      if (g.tickPace) {
        // SVG elements have no `hidden`; the display attribute does it.
        g.tickPace.setAttribute('display', expected === null ? 'none' : 'inline');
        if (expected !== null) placeTick(g.tickPace, expected);
      }
      const ahead = Boolean(win && win.aheadOfPace === true && expected !== null && !passed);
      g.pace.hidden = !ahead;
      g.pace.textContent = ahead ? t('pace.ahead', { expected: Math.round(expected) }) : '';
    }
    paintTime(g, now);
  }

  function applyClasses(g, cls) {
    for (const [name, on] of Object.entries(cls)) g.el.classList.toggle(name, on);
  }

  // ── recharge: a deliberate refresh or a switch ─────────────────────
  // One continuous movement: each usage arc takes off (spins up while
  // shrinking to a comet and fading its tail), orbits while cswap works, and
  // lands on the next full turn (so it stops at twelve o'clock), growing to
  // the fresh value with a slight spring. The time arc turns with it; the
  // number dims in flight and counts to the new value as the ring lands. The
  // week ring starts a little later, so the two land apart.
  const RECHARGE = {
    speed: 400, // cruising angular speed, degrees per second
    takeoff: 450, // ms from rest to cruising speed
    minFlight: 1100, // no ring lands sooner than this after its start
    maxFlight: 60_000, // give up and land anyway (cswap can take a while; never spin forever)
    comet: 0.24, // arc length in flight, as a share of the ring
    tail: 0.06, // opacity of the arc's start (its tail) in flight
    stagger: 120, // ms between the session and the week ring
    dim: 0.55, // opacity of the number in flight
    minTurn: 200, // degrees: the landing turn is at least this long
  };
  let flight = null; // { rings, busy, raf }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const smoothstep = (a, b, x) => {
    const k = clamp01((x - a) / (b - a));
    return k * k * (3 - 2 * k);
  };
  // Gentle spring: settles on 1 after a small overshoot (about 6 % of the move).
  const easeOutBack = (x) => 1 + 2.25 * Math.pow(x - 1, 3) + 1.25 * Math.pow(x - 1, 2);
  const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;

  function flightFor(g) {
    return (flight && flight.rings.find((r) => r.g === g && r.phase !== 'done')) || null;
  }

  function reduced() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function startRecharge() {
    if (flight || !parts || !current || parts.gauges.hidden || reduced() || document.visibilityState !== 'visible') return;
    const start = performance.now();
    const rings = [parts.session, parts.weekly].map((g, i) => {
      // Start from what is on screen right now, even mid-transition.
      const onScreen = parseFloat(getComputedStyle(g.usage).strokeDashoffset);
      const from = Number.isFinite(onScreen) ? clamp01(1 - onScreen / C_USAGE) : 0;
      return {
        g,
        from,
        target: from,
        shown: g.num.dataset.v === undefined ? null : Number(g.num.dataset.v),
        start: start + i * RECHARGE.stagger,
        phase: 'wait',
        theta: 0,
        len: from,
        tail: 1,
        dim: 1,
        released: false,
        pendingCls: null,
      };
    });
    flight = { rings, busy: true, raf: 0 };
    document.body.classList.add('recharging');
    for (const r of rings) {
      r.g.el.classList.add('has-value');
      paintRing(r);
    }
    flight.raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    const f = flight;
    if (!f) return;
    if (!parts || parts.gauges.hidden || document.visibilityState !== 'visible') {
      stopRecharge();
      return;
    }
    for (const r of f.rings) stepRing(r, now, !f.busy);
    if (f.rings.every((r) => r.phase === 'done')) {
      flight = null;
      document.body.classList.remove('recharging');
      return;
    }
    f.raf = requestAnimationFrame(frame);
  }

  function stepRing(r, now, fetched) {
    if (r.phase === 'done') return;
    const w = RECHARGE.speed / 1000; // degrees per ms
    const t = now - r.start;
    if (t < 0) return; // the week ring waits for its turn
    if (r.phase === 'wait') r.phase = 'takeoff';

    if (r.phase === 'takeoff') {
      if (t < RECHARGE.takeoff) {
        r.theta = 0.5 * (w / RECHARGE.takeoff) * t * t;
        const k = easeInOutSine(t / RECHARGE.takeoff);
        r.len = lerp(r.from, RECHARGE.comet, k);
        r.tail = lerp(1, RECHARGE.tail, k);
        r.dim = lerp(1, RECHARGE.dim, k);
      } else {
        r.phase = 'orbit';
      }
    }

    if (r.phase === 'orbit') {
      r.theta = 0.5 * w * RECHARGE.takeoff + w * (t - RECHARGE.takeoff);
      r.len = RECHARGE.comet;
      r.tail = RECHARGE.tail;
      r.dim = RECHARGE.dim;
      if ((fetched && t >= RECHARGE.minFlight) || t >= RECHARGE.maxFlight) {
        // Land on the next full turn at least minTurn ahead:
        // θ(u) = θ0 + Δ·(1 − (1 − u)^1.7) leaves at cruising speed and stops at rest.
        r.phase = 'landing';
        r.landStart = now;
        r.theta0 = r.theta;
        r.delta = Math.ceil((r.theta + RECHARGE.minTurn) / 360) * 360 - r.theta;
        r.landDur = (1.7 * r.delta) / w;
        r.spring = r.target < 0.88; // a full ring must not overshoot into itself
      }
    }

    if (r.phase === 'landing') {
      const u = clamp01((now - r.landStart) / r.landDur);
      r.theta = r.theta0 + r.delta * (1 - Math.pow(1 - u, 1.7));
      const grow = smoothstep(0.3, 1, u);
      r.len = clamp01(lerp(RECHARGE.comet, r.target, r.spring ? easeOutBack(grow) : grow));
      r.tail = lerp(RECHARGE.tail, 1, smoothstep(0.25, 0.85, u));
      r.dim = lerp(RECHARGE.dim, 1, smoothstep(0.3, 0.8, u));
      if (!r.released && u >= 0.3) release(r, 0.7 * r.landDur);
      if (u >= 1) {
        r.phase = 'done';
        land(r);
        return;
      }
    }
    paintRing(r);
  }

  function paintRing(r) {
    const turn = `rotate(${(r.theta % 360).toFixed(3)}deg)`;
    r.g.usage.style.transform = turn;
    r.g.time.style.transform = turn;
    r.g.usage.style.strokeDashoffset = (C_USAGE * (1 - r.len)).toFixed(3);
    r.g.el.style.setProperty('--tail', r.tail.toFixed(3));
    r.g.num.style.opacity = r.dim.toFixed(3);
    r.g.metaPct.style.opacity = r.dim.toFixed(3);
  }

  // The ring starts to grow: its colour and number go with it.
  function release(r, countMs) {
    r.released = true;
    // The ring is still landing: keep the arc drawn even when it lands on 0
    // (land() settles has-value).
    if (r.pendingCls) applyClasses(r.g, { ...r.pendingCls, 'has-value': true });
    r.pendingCls = null;
    animatePercent(r.g.num, r.shown, countMs);
    animatePercent(r.g.metaPct, r.shown, countMs);
  }

  // Landed: hand the ring back to the normal styles, then one soft pulse.
  function land(r) {
    if (!r.released) release(r, 400);
    r.g.usage.style.transform = '';
    r.g.time.style.transform = '';
    r.g.el.style.removeProperty('--tail');
    r.g.num.style.opacity = '';
    r.g.metaPct.style.opacity = '';
    // A value that arrived during the landing still wins.
    r.g.usage.style.strokeDashoffset = String(C_USAGE * (1 - r.target));
    r.g.el.classList.toggle('has-value', r.target > 0);
    r.g.el.classList.remove('landed');
    void r.g.el.offsetWidth;
    r.g.el.classList.add('landed');
    clearTimeout(r.g.landedTimer);
    r.g.landedTimer = setTimeout(() => r.g.el.classList.remove('landed'), 650);
  }

  // Stop at once (the page was hidden, or the rings went away).
  function stopRecharge() {
    const f = flight;
    if (!f) return;
    cancelAnimationFrame(f.raf);
    flight = null;
    for (const r of f.rings) {
      if (r.phase === 'done') continue;
      r.phase = 'done';
      release(r, 0);
      land(r);
    }
    document.body.classList.remove('recharging');
  }

  // Countdown, reset time and the thin time arc (share of the window gone by).
  function paintTime(g, now) {
    const win = g.window;
    const s = current && current.settings ? current.settings : {};
    if (!win || !win.resetsAt) {
      g.countdown.textContent = t('timer.notStarted');
      g.countdown.title = t('timer.notStartedHint');
      g.reset.textContent = '';
      g.time.style.strokeDashoffset = String(C_TIME);
      return;
    }
    g.countdown.title = '';
    const left = Date.parse(win.resetsAt) - now;
    g.el.classList.toggle('is-resetting', !(left > 0));
    if (!(left > 0)) {
      // The window rolled over; the new numbers come with the next refresh.
      // The explanation is a tooltip: it does not fit under a ring.
      g.countdown.textContent = t('timer.resetting');
      g.countdown.title = t('ring.tip.hasReset');
      g.reset.textContent = t('ring.now');
      g.time.style.strokeDashoffset = '0';
      return;
    }
    g.countdown.textContent = countdown(left, g.win === '5h');
    const locale = I18nDom.locale();
    g.reset.textContent =
      g.win === '5h'
        ? t('reset.at', { time: window.I18n.formatClock(locale, win.resetsAt, I18nDom.hour12()) })
        : t('reset.on', { date: window.I18n.formatDay(locale, win.resetsAt, s.weeklyDateFormat || 'date', I18nDom.hour12()) });
    const total = WINDOW_MIN[g.win] * 60 * 1000;
    const elapsed = Math.min(1, Math.max(0, (total - left) / total));
    g.time.style.strokeDashoffset = String(C_TIME * (1 - elapsed));
  }

  // '1:47:12' for the 5-hour window (ticks every second); '3d 4h' for days.
  function countdown(ms, precise) {
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const hh = Math.floor((total % 86400) / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    if (d > 0) return t('cd.days', { d, h: hh });
    if (precise) return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
    return hh > 0 ? t('cd.hours', { h: hh, m: mm }) : t('cd.minutes', { m: mm });
  }

  // ── public ──────────────────────────────────────────────────────

  function render(el, row, ctx) {
    const s = ctx.state || {};
    const working = Boolean(s.refreshing || s.switching);
    // A switch from anywhere (this page, the tray menu, the account menu) flies.
    if (s.switching && !flight) startRecharge();
    if (flight) flight.busy = working;
    if (root !== el || !parts || !el.contains(parts.gauges)) {
      root = el;
      parts = build(el);
      parts.menu.addEventListener('click', () => current && current.row && ctx.showAccountMenu(current.row));
      parts.toggle.addEventListener('click', () => {
        expanded = !expanded;
        if (current) paintExtra(extraRows(current.usage, Date.now()), expanded);
        ctx.api.setSettings({ heroExpanded: expanded });
      });
    }
    if (ctx.settings && typeof ctx.settings.heroExpanded === 'boolean') expanded = ctx.settings.heroExpanded;
    el.dataset.account = row ? ctx.key(row) : '';
    el.dataset.number = row ? String(row.number) : '';
    el.classList.toggle('is-disabled', Boolean(row && row.disabled));
    I18nDom.apply(el);

    if (!row) {
      current = null;
      parts.gauges.hidden = true;
      parts.noUsage.hidden = true;
      parts.menu.hidden = true;
      parts.status.replaceChildren();
      parts.empty.hidden = false;
      parts.empty.firstChild.textContent = t('hero.noActive');
      parts.empty.lastChild.textContent = t('hero.noActiveHint');
      paintExtra([], false);
      extraSig = null; // the next account redraws its "more limits"
      parts.status.parentNode.classList.remove('has-pills');
      stopRecharge();
      return;
    }
    parts.empty.hidden = true;
    parts.menu.hidden = false;
    parts.menu.setAttribute('aria-label', t('acct.actions', { name: Usage.label(row, t) }));
    parts.menu.title = parts.menu.getAttribute('aria-label');

    const { usage, stale } = Usage.effectiveUsage(row);
    current = { row, usage, stale, settings: ctx.settings || {} };
    // Pace has its own line under the week ring; Active is what the hero is.
    const pills = Usage.badges(row, t).filter((b) => b.key !== 'active' && b.key !== 'pace');
    parts.status.replaceChildren(...pills.map((b) => h('span', { class: `pill ${b.tone}`, title: b.title }, b.label)));
    parts.status.parentNode.classList.toggle('has-pills', pills.length > 0);

    const now = Date.now();
    const hasUsage = Boolean(usage && (usage.fiveHour || usage.sevenDay));
    parts.gauges.hidden = false;
    parts.noUsage.hidden = hasUsage;
    parts.noUsage.textContent = hasUsage ? '' : t('card.noUsageHint');
    paintGauge(parts.session, usage && usage.fiveHour, stale, now);
    paintGauge(parts.weekly, usage && usage.sevenDay, stale, now);
    const sig = JSON.stringify([extraRows(usage, now).map((r) => [r.key, r.pct === null ? null : Math.round(r.pct), r.spend || null, r.resetsAt || null]), expanded, I18nDom.lang(), I18nDom.locale(), I18nDom.hour12()]);
    if (sig !== extraSig) {
      extraSig = sig;
      paintExtra(extraRows(usage, now), expanded);
    }
  }

  function tick(now) {
    if (!parts || !current) return;
    // "More limits": the model rows count down too.
    for (const el of parts.extra.querySelectorAll('.extra-side[data-resets-at]')) {
      const at = el.dataset.resetsAt;
      const secs = Usage.resetPassed({ resetsAt: at }, now) ? null : Usage.secondsUntil(at, now);
      el.textContent = secs == null ? t('ring.now') : I18nDom.duration(secs);
    }
    for (const g of [parts.session, parts.weekly]) {
      const before = g.el.classList.contains('is-stale');
      paintTime(g, now);
      // A window that just rolled over looks outdated until the next refresh.
      const passed = Boolean(g.window && Usage.resetPassed(g.window, now));
      if (passed && !before) paintGauge(g, g.window, current.stale, now);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') stopRecharge();
  });

  // A deliberate refresh (the button, Cmd+R) or a switch started on this page.
  function recharge(ctx) {
    startRecharge();
    if (flight) flight.busy = true;
  }

  window.Hero = { render, tick, recharge };
})();
