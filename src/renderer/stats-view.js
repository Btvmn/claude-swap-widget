// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:2180-2240,
// 2268-2663; src/renderer/index.html:208-228, 427-435).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
'use strict';

// The statistics view (window.StatsView, PLAN §5.3–5.4): one account's usage
// history for Today / Week / Month in one of their three looks — a line
// (5h, 7d and spend over time), bars (each bucket's 5h peak, the current one
// pinned with a pill) or summary cards (sparklines and a heat strip).
//
//   StatsView.open(el, ctx, {email?, organizationUuid?})   el = #stats
//   StatsView.update(ctx)                                   every state while open
//   StatsView.close()
//
// Markup (built once into #stats, for test/e2e/ui.js):
//   #stats[data-style=line|bars|summary] (.is-empty, .is-loading)
//     .stats-head   h2#stats-title, #stats-period.segmented[role=radiogroup]
//                   > button.segment-btn[data-period=day|week|month][role=radio][aria-checked]
//     .stats-tools  select#stats-account (value "" = follow the active account;
//                   an optgroup.stats-gone for keys only in the history),
//                   #stats-style.segmented.glyph-picker > button[data-stats-style]
//     .stats-body   .stats-chart > canvas#stats-canvas, #stats-cards, #stats-heat
//                   (.heat-cell.none / .future / .current), #stats-summary
//                   (.stats-item > .stats-item-label + .stats-item-value),
//                   #stats-empty (.stats-empty-text, .stats-empty-hint)
//     p#stats-note  coverage, or "history is off"
//
// Data: window.api.history.accounts() and .get(key, days), which resolve null
// on bad input and never reject; the figures come from window.Stats
// (src/shared/stats.js), whose sample times are epoch SECONDS. The view state
// (statsStyle, statsPeriod, statsAccount) is saved through settings:set.
//
// Chart.js (vendored, 208 KB) is loaded on the first open by appending a
// <script src>, which `script-src 'self'` allows; window.Chart is undefined
// until then. It only writes canvas.style through the CSSOM (measured under
// our CSP, PLAN §5.4). Colours are the --chart-* tokens, read at render time;
// a change of prefers-color-scheme or prefers-contrast renders again.

(function () {
  const { h, svg } = window.Dom;
  const Stats = window.Stats;
  const I18n = window.I18n;
  const I18nDom = window.I18nDom;
  const t = (key, vars) => I18nDom.t(key, vars);

  const STYLES = ['line', 'bars', 'summary'];
  const PERIODS = Stats.PERIODS; // day, week, month
  // Days of history per period: the window plus the reading before it (the
  // first pair and the first spend step start there).
  const DAYS = { day: 2, week: 8, month: 31 };
  const CHART_SRC = 'vendor/chart.umd.min.js';

  let root = null;
  let els = null;
  let ctx = null;
  let isOpen = false;
  let view = { style: 'line', period: 'day', account: '' }; // account '' = follow the active one
  let seen = null; // the settings values last taken over (see adopt())
  let accounts = []; // history:accounts(), [] until the first answer
  let accountsOk = false;
  let accountsStale = true;
  let target = null; // { email, organizationUuid } asked for by ui:open, until the list is in
  let data = null; // { key, days, stamp, res } — res is history:get's answer (null: none)
  let stamp = null; // state.fetchedAt the data belongs to
  let langSig = null;
  let seq = 0;
  let chart = null;
  let chartLoad = null;
  let chartFailed = false;
  let deferred = false; // a new list came while the window was hidden

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // ── formatting ──────────────────────────────────────────────────

  const pctFormats = new Map();
  function fmtPct(v) {
    if (!isNum(v)) return '—';
    const locale = I18nDom.locale();
    let f = pctFormats.get(locale);
    if (!f) {
      try {
        f = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
      } catch {
        f = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
      }
      pctFormats.set(locale, f);
    }
    return f.format(Math.round(v) / 100);
  }

  const fmtDuration = (ms) => (isNum(ms) ? Stats.fmtDurationMs(ms, t) : '—');
  const fmtMoney = (amount, currency) => I18n.formatMoney(I18nDom.locale(), amount, currency) || '—';
  const labelOpts = () => ({ locale: I18nDom.locale(), hour12: I18nDom.hour12() });
  const bucketName = (b, period, long) => Stats.bucketLabel(b, period, long, labelOpts());

  // An hour on the axis: '06' on a 24-hour clock, '6 AM' on a 12-hour one.
  function hourTick(hour) {
    if (!I18nDom.hour12()) return String(hour % 24).padStart(2, '0');
    try {
      return new Intl.DateTimeFormat(I18nDom.locale(), { hour: 'numeric', hour12: true, timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, hour % 24)));
    } catch {
      return `${hour % 12 || 12} ${hour % 24 >= 12 ? 'PM' : 'AM'}`;
    }
  }

  let measure = null;
  function textWidth(text, px) {
    if (!measure) measure = document.createElement('canvas').getContext('2d');
    measure.font = `${px}px ${getComputedStyle(document.body).fontFamily}`;
    return measure.measureText(text).width;
  }

  // Month ticks: every fifth day counted back from today, as theirs, or every
  // 7th / 10th / 15th when the language's dates ("29. Sept.", "29 сент.") are
  // too wide for the 360 px window.
  function monthStep(buckets) {
    const widest = Math.max(0, ...buckets.map((b) => textWidth(bucketName(b, 'month', false), 10)));
    const slot = Math.max(120, els.chartBox.clientWidth - 44) / Math.max(1, buckets.length);
    return [5, 7, 10, 15].find((step) => step * slot >= widest + 10) || 15;
  }

  // ── colours (their chartInk(), from the --chart-* tokens) ─────────

  function chartInk() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
      session: v('--chart-5h', '#1d1d1f'),
      weekly: v('--chart-7d', '#5856d6'),
      extra: v('--chart-spend', '#f08c00'),
      grid: v('--chart-grid', 'rgba(0, 0, 0, 0.06)'),
      text: v('--chart-text', 'rgba(29, 29, 31, 0.64)'),
      tipBg: v('--chart-tip-bg', '#ffffff'),
      tipInk: v('--chart-tip-fg', '#1d1d1f'),
      tipEdge: v('--chart-tip-edge', 'rgba(0, 0, 0, 0.1)'),
      pillBg: v('--chart-pill-bg', '#1d1d1f'),
      pillInk: v('--chart-pill-fg', '#ffffff'),
    };
  }

  // '#rrggbb' at the given opacity (the tokens keep the series in that form).
  function inkAlpha(hex, a) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function chartFont(size, weight) {
    return weight ? { size, weight } : { size };
  }

  // ── Chart.js, loaded on the first open ──────────────────────────

  function loadChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (!chartLoad) {
      chartLoad = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = CHART_SRC;
        s.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error('Chart.js did not define window.Chart')));
        s.onerror = () => reject(new Error(`cannot load ${CHART_SRC}`));
        document.head.appendChild(s);
      }).then(
        (Chart) => {
          Chart.defaults.animation = false;
          Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
          return Chart;
        },
        (err) => {
          chartFailed = true;
          console.warn(`stats: ${err.message}; showing the summary cards instead`);
          throw err;
        },
      );
    }
    return chartLoad;
  }

  function destroyChart() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  // ── build once ──────────────────────────────────────────────────

  // Their look-picker glyphs (index.html:427-435).
  function glyph(style) {
    const base = { width: 22, height: 14, viewBox: '0 0 22 14', 'aria-hidden': 'true' };
    if (style === 'line') {
      return svg('svg', { ...base, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg('polyline', { points: '2 11 7 7 11 9 16 3 20 5' }));
    }
    if (style === 'bars') {
      return svg(
        'svg',
        { ...base, fill: 'currentColor' },
        svg('rect', { x: 3, y: 7, width: 3, height: 6, rx: 1 }),
        svg('rect', { x: 9.5, y: 2, width: 3, height: 11, rx: 1 }),
        svg('rect', { x: 16, y: 5, width: 3, height: 8, rx: 1 }),
      );
    }
    return svg(
      'svg',
      { ...base, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 },
      svg('rect', { x: 1.5, y: 3, width: 5.5, height: 8, rx: 1.6 }),
      svg('rect', { x: 8.25, y: 3, width: 5.5, height: 8, rx: 1.6 }),
      svg('rect', { x: 15, y: 3, width: 5.5, height: 8, rx: 1.6 }),
    );
  }

  // A radio group of buttons: click, and the arrow keys move the choice.
  function radioGroup(attrs, buttons, onPick) {
    const group = h('div', { ...attrs, role: 'radiogroup' }, buttons);
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && group.contains(b)) onPick(b);
    });
    group.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!step) return;
      const list = [...group.querySelectorAll('button')];
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = list[(i + step + list.length) % list.length];
      next.focus();
      onPick(next);
    });
    return group;
  }

  function mark(group, attr, value) {
    for (const b of group.querySelectorAll('button')) {
      const on = b.dataset[attr] === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  function build() {
    const period = radioGroup(
      { id: 'stats-period', class: 'stats-period segmented', 'aria-labelledby': 'stats-title' },
      PERIODS.map((p) => h('button', { class: 'segment-btn', type: 'button', role: 'radio', 'data-period': p, 'data-i18n': `stats.${p}` }, t(`stats.${p}`))),
      (b) => pick('period', b.dataset.period),
    );
    const style = radioGroup(
      { id: 'stats-style', class: 'stats-style segmented glyph-picker' },
      STYLES.map((s) => h('button', { class: 'segment-btn glyph-btn', type: 'button', role: 'radio', 'data-stats-style': s, 'data-i18n-title': `statsStyle.${s}`, title: t(`statsStyle.${s}`), 'aria-label': t(`statsStyle.${s}`) }, glyph(s))),
      (b) => pick('style', b.dataset.statsStyle),
    );
    const account = h('select', { id: 'stats-account' });
    account.addEventListener('change', () => pick('account', account.value));
    const canvas = h('canvas', { id: 'stats-canvas', role: 'img' });
    els = {
      title: h('h2', { id: 'stats-title', class: 'stats-title' }),
      period,
      style,
      account,
      chartBox: h('div', { class: 'stats-chart' }, canvas),
      canvas,
      cards: h('div', { id: 'stats-cards', class: 'stats-cards' }),
      heat: h('div', { id: 'stats-heat', class: 'stats-heat' }),
      summary: h('div', { id: 'stats-summary', class: 'stats-summary' }),
      emptyText: h('span', { class: 'stats-empty-text' }),
      emptyHint: h('span', { class: 'stats-empty-hint' }),
      note: h('p', { id: 'stats-note', class: 'stats-note' }),
    };
    root.replaceChildren(
      h('div', { class: 'stats-head' }, els.title, period),
      h('div', { class: 'stats-tools' }, h('label', { class: 'stats-select' }, account), style),
      h(
        'div',
        { class: 'stats-body' },
        els.chartBox,
        els.cards,
        els.heat,
        els.summary,
        h('div', { id: 'stats-empty', class: 'stats-empty', role: 'status' }, els.emptyText, els.emptyHint),
      ),
      els.note,
    );
    I18nDom.apply(root);
  }

  // ── view state ──────────────────────────────────────────────────

  function fromSettings(s) {
    const o = s || {};
    return {
      style: STYLES.includes(o.statsStyle) ? o.statsStyle : 'line',
      period: PERIODS.includes(o.statsPeriod) ? o.statsPeriod : 'day',
      account: typeof o.statsAccount === 'string' ? o.statsAccount : '',
      record: o.recordHistory !== false,
    };
  }

  // Takes over what changed in the settings since the last look. A push that
  // still carries the old value while our own settings:set is on its way is
  // not a change, so it cannot undo a click. True when the view changed.
  function adopt(settings, force) {
    const next = fromSettings(settings);
    let changed = false;
    for (const k of ['style', 'period', 'account']) {
      if ((force || !seen || next[k] !== seen[k]) && view[k] !== next[k]) {
        view[k] = next[k];
        changed = true;
      }
    }
    if (seen && next.record !== seen.record) changed = true;
    seen = next;
    return changed;
  }

  const persistKey = { style: 'statsStyle', period: 'statsPeriod', account: 'statsAccount' };
  function persist(k) {
    const value = k === 'account' ? view.account || null : view[k];
    try {
      Promise.resolve(ctx.api.setSettings({ [persistKey[k]]: value })).catch(() => {});
    } catch {}
  }

  function pick(k, value) {
    if (!isOpen || value === undefined || view[k] === value) return;
    view[k] = value;
    persist(k);
    if (k === 'style') render();
    else load();
  }

  // ── accounts ────────────────────────────────────────────────────

  const activeEntry = () => accounts.find((e) => e.active) || null;
  const entryName = (e) => e.label || e.email || e.key;
  const entryText = (e) => (e.org ? `${entryName(e)} · ${e.org}` : entryName(e));

  // The key shown: the pinned account while the list has it (or while there
  // is no list to check against), else the active one; null when none.
  function currentKey() {
    if (view.account && (!accountsOk || accounts.some((e) => e.key === view.account))) return view.account;
    const a = activeEntry();
    return a ? a.key : null;
  }

  // ui:open for one account: pin it, or follow when it is the active one.
  function applyTarget() {
    if (!target || !accountsOk) return;
    const want = target;
    target = null;
    const e = accounts.find((x) => x.email === want.email && (x.organizationUuid || '') === (want.organizationUuid || ''));
    if (!e) return;
    const value = e.active ? '' : e.key;
    if (view.account !== value) {
      view.account = value;
      persist('account');
    }
  }

  function fillPicker() {
    const sel = els.account;
    const present = accounts.filter((e) => e.present);
    const gone = accounts.filter((e) => !e.present);
    const option = (value, text, extra) => {
      const o = h('option', { value, title: extra || null });
      o.textContent = text;
      return o;
    };
    const active = activeEntry();
    const options = [option('', active ? t('stats.account.follow', { label: entryName(active) }) : t('hero.noActive'), active ? active.email : null)];
    for (const e of present) options.push(option(e.key, entryText(e), e.email));
    if (gone.length) {
      const group = h('optgroup', { class: 'stats-gone', label: t('stats.account.gone') });
      for (const e of gone) group.append(option(e.key, entryText(e), e.email));
      options.push(group);
    }
    // A pinned key the history no longer has shows as "follow".
    const shown = currentKey() === view.account ? view.account : '';
    // Rebuilt only when something in it changed: every refresh lands here, and
    // the menu may be open.
    const sig = JSON.stringify([shown, options.map((o) => (o.tagName === 'OPTGROUP' ? [o.label, [...o.children].map((x) => [x.value, x.textContent])] : [o.value, o.textContent, o.title]))]);
    sel.setAttribute('aria-label', t('stats.account'));
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.replaceChildren(...options);
    sel.value = shown;
    const chosen = sel.selectedOptions[0];
    sel.title = chosen ? [chosen.textContent, chosen.title].filter(Boolean).join('\n') : '';
  }

  // ── loading ─────────────────────────────────────────────────────

  async function load() {
    const my = ++seq;
    const api = ctx && ctx.api && ctx.api.history;
    if (!api) {
      data = { key: null, days: 0, stamp, res: null };
      render();
      return;
    }
    if (accountsStale) {
      const list = await api.accounts();
      if (my !== seq || !isOpen) return;
      if (Array.isArray(list)) {
        accounts = list.filter((e) => e && typeof e.key === 'string');
        accountsOk = true;
        accountsStale = false;
      }
      applyTarget();
    }
    fillPicker();
    const key = currentKey();
    const days = DAYS[view.period] || DAYS.month;
    if (!key) {
      data = { key: null, days, stamp, res: null };
    } else if (!(data && data.key === key && data.days >= days && data.stamp === stamp && data.res)) {
      const res = await api.get(key, days);
      if (my !== seq || !isOpen) return;
      data = { key, days, stamp, res: res && Array.isArray(res.samples) ? res : null };
    }
    render();
  }

  // ── rendering ───────────────────────────────────────────────────

  function currencyOf(key) {
    if (data && data.res && data.res.currency) return data.res.currency;
    const e = accounts.find((x) => x.key === key);
    return (e && e.currency) || null;
  }

  // "History is recorded while the app runs · since Sep 2", from the
  // account's first line on disk; '' when there is none.
  function sinceText(res) {
    const since = res && isNum(res.since) ? I18n.formatDay(I18nDom.locale(), res.since * 1000, 'date') : '';
    return since ? t('stats.recordingSince', { date: since }) : '';
  }

  function summaryItem(label, value, tip) {
    return h(
      'div',
      { class: 'stats-item', title: tip || null },
      h('span', { class: 'stats-item-label' }, label),
      h('span', { class: 'stats-item-value' }, value),
    );
  }

  // Everything but the chart: title, controls, summary, cards, empty text,
  // note. The chart is drawn by drawChart() once Chart.js is there.
  function render() {
    if (!isOpen || !els) return;
    const period = view.period;
    els.title.textContent = t(`stats.title.${period}`);
    mark(els.period, 'period', period);
    mark(els.style, 'statsStyle', view.style);
    els.style.setAttribute('aria-label', t('settings.stats'));
    destroyChart();
    els.cards.replaceChildren();
    els.heat.replaceChildren();
    els.summary.replaceChildren();

    const loading = !data;
    const key = data ? data.key : null;
    const res = data && data.res;
    const danger = isNum(ctx.settings && ctx.settings.danger) ? ctx.settings.danger : Stats.DANGER;
    const stats = Stats.computeStats(res ? res.samples : [], period, Date.now(), { danger, currency: currencyOf(key) });
    const look = view.style !== 'summary' && chartFailed ? 'summary' : view.style;
    const empty = stats.count === 0;
    const record = !seen || seen.record;
    root.dataset.style = look;
    root.classList.toggle('is-empty', empty);
    root.classList.toggle('is-loading', loading);
    els.canvas.setAttribute('aria-label', els.title.textContent);

    // Empty: the controls stay, the body keeps its height, the text says why.
    let text = '';
    let hint = '';
    if (!loading && empty) {
      if (!key) text = t('hero.noActive');
      else if (!record && !(res && res.samples.length)) text = t('stats.off');
      else {
        text = t('stats.empty');
        hint = record ? sinceText(res) || t('stats.recording') : t('stats.off');
      }
    }
    els.emptyText.textContent = text;
    els.emptyHint.textContent = hint;
    els.emptyHint.hidden = !hint;

    // The note under the body: how much of the period was measured, or, while
    // there is nothing measured between two readings yet, that recording runs.
    const notes = [];
    const covered = !empty && stats.observedMs > 0 && isNum(stats.coverage);
    if (covered) notes.push(`${t('stats.coverage')} ${fmtPct(stats.coverage * 100)}`);
    else if (!empty && record) notes.push(sinceText(res) || t('stats.recording'));
    if (!record && !(empty && text === t('stats.off'))) notes.push(t('stats.off'));
    // Always one line tall (a no-break space when there is nothing to say), so
    // an answer from history:get never changes the view's height.
    els.note.textContent = notes.join(' · ') || '\u00a0';
    els.note.title = covered ? t('stats.coverageTip') : '';

    if (look === 'summary') {
      renderStatsCards(stats);
      return;
    }

    const inUse = [t('stats.inUse'), fmtDuration(stats.inUseMs), t('stats.inUseTip')];
    const items =
      look === 'bars'
        ? [
            [t('stats.peak'), fmtPct(stats.peak)],
            [t(period === 'day' ? 'stats.busiestHour' : 'stats.busiestDay'), stats.busiest ? bucketName(stats.busiest, period, true) : '—'],
            inUse,
          ]
        : [
            [t('stats.peak'), fmtPct(stats.peak)],
            [t('stats.average'), fmtPct(stats.avg)],
            [t('stats.nearLimit'), fmtDuration(stats.nearMs), t('stats.nearLimitTip', { pct: danger })],
            stats.spend && stats.spend.amount > 0 ? [t('stats.spend'), fmtMoney(stats.spend.amount, stats.spend.currency)] : inUse,
          ];
    for (const [label, value, tip] of items) els.summary.append(summaryItem(label, value, tip));

    if (empty) return;
    if (window.Chart) drawChart(stats, look);
    else {
      const my = seq;
      loadChart().then(
        () => my === seq && isOpen && render(),
        () => my === seq && isOpen && render(),
      );
    }
  }

  function drawChart(stats, look) {
    try {
      if (look === 'bars') renderBarChart(stats);
      else renderLineChart(stats);
    } catch (err) {
      destroyChart();
      console.warn(`stats: the chart failed: ${(err && err.stack) || err}`);
    }
  }

  // ── A: line ─────────────────────────────────────────────────────
  // Session (5h) and week (7d) over the period. Today uses every reading; a
  // week or a month one point per day (the session's peak, the week's level at
  // the day's end), so five-hour windows don't turn the line into a saw.
  // Spend gets its own money axis when the account spent in the window.

  function renderLineChart(stats) {
    const Chart = window.Chart;
    const ink = chartInk();
    const { win, period } = stats;
    const perDay = period !== 'day';
    const mid = (b) => b.start + (b.end - b.start) / 2;
    const days = stats.buckets.filter((b) => !b.future);
    const readings = perDay ? [] : Stats.thinSamples(stats.samples);
    const val = (v) => (isNum(v) ? v : null);
    const sessionPts = perDay ? days.map((b) => ({ x: mid(b), y: b.peak })) : readings.map((e) => ({ x: e.t * 1000, y: val(e.h) }));
    const weekPts = perDay ? days.map((b) => ({ x: mid(b), y: b.weekLast })) : readings.map((e) => ({ x: e.t * 1000, y: val(e.w) }));
    const lastSession = sessionPts.reduce((last, p, i) => (p.y !== null ? i : last), -1);
    // A reading with no neighbour it is drawn to (a gap on both sides) would
    // be invisible as a line; it gets a small dot.
    const gap = perDay ? Infinity : Stats.GAP_MAX_MS;
    const joined = (p, q) => Boolean(q) && q.y !== null && Math.abs(q.x - p.x) <= gap;
    const lone = (c) => {
      const pts = c.dataset.data;
      const p = pts[c.dataIndex];
      return Boolean(p) && p.y !== null && !joined(p, pts[c.dataIndex - 1]) && !joined(p, pts[c.dataIndex + 1]);
    };

    const line = {
      borderWidth: 2,
      pointRadius: (c) => (lone(c) ? 2 : 0),
      pointBackgroundColor: (c) => c.dataset.borderColor,
      pointBorderWidth: 0,
      pointHoverRadius: 3,
      pointHitRadius: 10,
      cubicInterpolationMode: 'monotone',
      // Today: readings further apart than cswap's slowest cadence were not
      // watched in between (app closed, asleep), so the line breaks there.
      spanGaps: perDay ? false : Stats.GAP_MAX_MS,
    };
    const datasets = [
      {
        ...line,
        label: t('chart.session'),
        data: sessionPts,
        borderColor: ink.session,
        // A soft wash under the session line gives the chart a surface without a second colour
        backgroundColor(context) {
          const area = context.chart.chartArea;
          if (!area) return 'transparent';
          const wash = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          wash.addColorStop(0, inkAlpha(ink.session, 0.1));
          wash.addColorStop(1, inkAlpha(ink.session, 0));
          return wash;
        },
        fill: 'origin',
        // The line ends in a dot: where things stand now
        pointRadius: (c) => (c.dataIndex === lastSession ? 3 : lone(c) ? 2 : 0),
      },
      { ...line, label: t('chart.weekly'), data: weekPts, borderColor: ink.weekly, backgroundColor: 'transparent' },
    ];

    const spend = stats.spend;
    let spendShown = false;
    if (spend) {
      const spendPts = perDay ? days.map((b) => ({ x: mid(b), y: b.spendLast })) : readings.map((e) => ({ x: e.t * 1000, y: val(e.u) }));
      if (spendPts.some((p) => p.y > 0)) {
        spendShown = true;
        datasets.push({
          ...line,
          label: t('extra.label'),
          data: spendPts,
          yAxisID: 'spend',
          borderColor: ink.extra,
          borderDash: [4, 3],
          backgroundColor: 'transparent',
          cubicInterpolationMode: 'default',
          stepped: !perDay,
        });
      }
    }
    const money = (v) => fmtMoney(v, spend && spend.currency);

    const ticks = [];
    if (period === 'day') {
      for (const hr of [0, 6, 12, 18, 24]) {
        const d = new Date(win.start);
        d.setHours(hr);
        ticks.push({ value: d.getTime(), label: hourTick(hr) });
      }
    } else {
      const n = stats.buckets.length;
      const step = period === 'month' ? monthStep(stats.buckets) : 1;
      stats.buckets.forEach((b, i) => {
        // A week: every day; a month: every fifth day (or more), counted back from today
        if ((n - 1 - i) % step === 0) ticks.push({ value: mid(b), label: bucketName(b, period, false) });
      });
    }
    const tickLabels = new Map(ticks.map((tk) => [tk.value, tk.label]));
    const locale = I18nDom.locale();
    const hour12 = I18nDom.hour12();

    chart = new Chart(els.canvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 6, right: spendShown ? 0 : 6 } },
        // A reading at 100 % sits on the chart's top edge: let the line's
        // own width draw past it instead of being cut in half.
        datasets: { line: { clip: 6 } },
        interaction: { intersect: false, mode: 'nearest', axis: 'x' },
        scales: {
          x: {
            type: 'linear',
            min: win.start,
            max: win.end,
            afterBuildTicks(axis) {
              axis.ticks = ticks.map((tk) => ({ value: tk.value }));
            },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              color: ink.text,
              font: chartFont(10),
              callback: (value) => tickLabels.get(value) ?? '',
            },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            min: 0,
            max: 100,
            ticks: {
              stepSize: 25,
              color: ink.text,
              font: chartFont(10),
              callback: (value) => (value === 0 ? '0' : value % 50 === 0 ? fmtPct(value) : ''),
            },
            grid: { color: ink.grid },
            border: { display: false },
          },
          ...(spendShown
            ? {
                spend: {
                  position: 'right',
                  min: 0,
                  grace: '10%',
                  ticks: { color: ink.text, font: chartFont(10), maxTicksLimit: 4, callback: (value) => money(value) },
                  grid: { display: false },
                  border: { display: false },
                },
              }
            : {}),
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: ink.tipBg,
            titleColor: ink.tipInk,
            bodyColor: ink.tipInk,
            borderColor: ink.tipEdge,
            borderWidth: 1,
            cornerRadius: 8,
            padding: 8,
            boxWidth: 7,
            boxHeight: 7,
            usePointStyle: true,
            titleFont: chartFont(11, '600'),
            bodyFont: chartFont(11),
            filter: (item) => item.parsed.y !== null && !Number.isNaN(item.parsed.y),
            callbacks: {
              labelColor(item) {
                return { borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor };
              },
              title(items) {
                const x = items.length ? items[0].parsed.x : null;
                if (!isNum(x)) return '';
                return perDay ? I18n.formatDay(locale, x, 'date-day') : I18n.formatClock(locale, x, hour12);
              },
              label(item) {
                const y = item.parsed.y;
                return `${item.dataset.label}: ${item.dataset.yAxisID === 'spend' ? money(y) : fmtPct(y)}`;
              },
            },
          },
        },
      },
    });
  }

  // ── B: bars ─────────────────────────────────────────────────────
  // One bar per bucket: its 5h peak. The current bucket is marked and carries
  // the pill; buckets still ahead are faint stubs; a past bucket without a
  // measurement has no bar at all (0 % is a stub in the normal colour).

  function renderBarChart(stats) {
    const Chart = window.Chart;
    const ink = chartInk();
    const { buckets, period } = stats;
    const current = stats.currentIndex;
    const values = buckets.map((b) => (b.future ? 0 : isNum(b.peak) ? b.peak : null));
    const colours = buckets.map((b, i) => (i === current ? ink.weekly : b.future ? inkAlpha(ink.session, 0.1) : inkAlpha(ink.session, 0.55)));
    const n = buckets.length;
    const step = period === 'month' ? monthStep(buckets) : 1;
    const tickShown = (i) => {
      if (period === 'week') return true;
      if (period === 'day') return i % 6 === 0 || i === n - 1;
      return (n - 1 - i) % step === 0;
    };
    const tickText = (i) => (period === 'day' ? hourTick(isNum(buckets[i].hour) ? buckets[i].hour : new Date(buckets[i].start).getHours()) : bucketName(buckets[i], period, false));
    const pinned = current >= 0 && values[current] !== null ? current : -1;

    // Keeps the pill over the current bucket whenever the pointer is not on
    // the chart — placed again after every update, so a resize never leaves it behind
    const pinCurrent = {
      id: 'pinCurrent',
      afterUpdate(c) {
        if (!c.$pointerIn) pinTooltip(c, pinned);
      },
      afterEvent(c, args) {
        const type = args.event.type;
        if (type === 'mousemove') c.$pointerIn = true;
        if (type === 'mouseout') {
          c.$pointerIn = false;
          if (pinTooltip(c, pinned)) args.changed = true;
        }
      },
    };

    chart = new Chart(els.canvas, {
      type: 'bar',
      data: {
        labels: buckets.map((b, i) => String(i)),
        datasets: [
          {
            data: values,
            backgroundColor: colours,
            hoverBackgroundColor: colours,
            borderRadius: 3,
            minBarLength: 3,
            categoryPercentage: period === 'month' ? 0.74 : 0.8,
            barPercentage: 1,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 30 } }, // room for the pill above a full bar
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              color: ink.text,
              font: chartFont(10),
              callback: (value, index) => (tickShown(index) ? tickText(index) : ''),
            },
          },
          y: {
            min: 0,
            max: 100,
            ticks: { display: false, stepSize: 50 },
            grid: { color: ink.grid, drawTicks: false },
            border: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            // An inverted pill: light on dark, dark on light
            backgroundColor: ink.pillBg,
            bodyColor: ink.pillInk,
            borderWidth: 0,
            cornerRadius: 7,
            padding: { x: 8, y: 5 },
            caretSize: 0,
            yAlign: 'bottom',
            displayColors: false,
            bodyFont: chartFont(11, '600'),
            filter: (item) => !buckets[item.dataIndex].future && values[item.dataIndex] !== null,
            callbacks: {
              title: () => '',
              label: (item) => {
                const b = buckets[item.dataIndex];
                return `${bucketName(b, period, false)} · ${fmtPct(b.peak)}`;
              },
            },
          },
        },
      },
      plugins: [pinCurrent],
    });
  }

  function pinTooltip(c, index) {
    if (!c || index < 0 || !c.tooltip) return false;
    const bar = c.getDatasetMeta(0).data[index];
    if (!bar || !isNum(bar.x) || !isNum(bar.y)) return false;
    c.tooltip.setActiveElements([{ datasetIndex: 0, index }], { x: bar.x, y: bar.y });
    return true;
  }

  // ── C: summary cards ────────────────────────────────────────────
  // Three cards with a small line each, and a strip of bucket peaks. Colours
  // are CSS (the sparkline strokes and the heat tint use the --chart-*
  // tokens), so a theme change needs no render.

  function renderStatsCards(stats) {
    const upto = stats.currentIndex >= 0 ? stats.currentIndex : stats.buckets.length - 1;
    const shown = stats.buckets.slice(0, upto + 1);
    const orNull = (b, v) => (b.none ? null : v);
    const cards = [
      { label: t('stats.peak'), value: fmtPct(stats.peak), series: shown.map((b) => b.peak), tone: 's5h' },
      { label: t('stats.average'), value: fmtPct(stats.avg), series: shown.map((b) => b.avg), tone: 's7d' },
      { label: t('stats.inUse'), ms: stats.inUseMs, series: shown.map((b) => orNull(b, b.inUseMs)), tone: 's7d', tip: t('stats.inUseTip') },
    ];
    const n = stats.buckets.length;
    const values = [];
    for (const card of cards) {
      const value = h('span', { class: 'stats-card-value' });
      if ('ms' in card) durationInto(value, card.ms);
      else value.textContent = card.value;
      values.push(value);
      els.cards.append(
        h(
          'div',
          { class: 'stats-card', title: card.tip || null },
          h('span', { class: 'stats-card-label' }, card.label),
          value,
          sparkline(card.series, n, card.tone),
        ),
      );
    }
    // A value too wide for its third of 328 px ("9 ч 32 мин", "9 Std. 19 Min.")
    // steps down from 17 px instead of being cut.
    // (A Range, not scrollWidth: that rounds a sub-pixel overflow away.)
    const range = document.createRange();
    const tooWide = (el) => {
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width > el.clientWidth;
    };
    for (const el of values) {
      const base = parseFloat(getComputedStyle(el).fontSize) || 17;
      for (let px = base - 1; px >= base * 0.7 && tooWide(el); px--) el.style.fontSize = `${px}px`;
    }

    const cells = h('div', { class: 'stats-heat-cells' });
    cells.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    for (const b of stats.buckets) {
      const cell = h('span', { class: 'heat-cell' });
      if (b.future) cell.classList.add('future');
      else if (b.none || !isNum(b.peak)) cell.classList.add('none');
      else {
        cell.classList.add('has-value');
        cell.style.setProperty('--heat', `${(16 + (84 * Math.min(Math.max(b.peak, 0), 100)) / 100).toFixed(1)}%`);
      }
      if (b.current) cell.classList.add('current');
      cell.title = `${bucketName(b, stats.period, true)} · ${b.future ? '—' : isNum(b.peak) ? fmtPct(b.peak) : t('stats.noData')}`;
      cells.append(cell);
    }
    els.heat.append(h('span', { class: 'stats-heat-label' }, t(stats.period === 'day' ? 'stats.byHour' : 'stats.byDay')), cells);
  }

  // "9 h 40 m" with the numbers at full size and the units small, like the
  // hero's "%": the translated phrase from Stats.fmtDurationMs (its rounding,
  // its key), filled in by I18nDom.fillPhrase with the numbers as spans.
  function durationInto(el, ms) {
    let said = null;
    const text = isNum(ms) ? Stats.fmtDurationMs(ms, (key, vars) => ((said = { key, vars }), t(key, vars))) : '—';
    if (!said) {
      el.textContent = text;
      return;
    }
    el.classList.add('is-duration');
    I18nDom.fillPhrase(el, said.key, Object.fromEntries(Object.entries(said.vars).map(([k, v]) => [k, [String(v), 'num']])));
  }

  // A small line over the whole period's width, drawn up to now. A bucket
  // without data breaks it; a lone point is a short dash.
  function sparkline(series, slots, tone) {
    const W = 142;
    const H = 22;
    const nums = series.filter(isNum);
    const max = Math.max(...nums, 0);
    const x = (i) => (slots > 1 ? (i / (slots - 1)) * W : W / 2);
    const y = (v) => (max > 0 ? H - 2 - (v / max) * (H - 4) : H - 2);
    const parts = [];
    let run = [];
    const flush = () => {
      if (run.length === 1) {
        const [i, v] = run[0];
        parts.push(`M${Math.max(0, x(i) - 1.5).toFixed(2)} ${y(v).toFixed(2)}L${Math.min(W, x(i) + 1.5).toFixed(2)} ${y(v).toFixed(2)}`);
      } else if (run.length > 1) {
        parts.push(run.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(''));
      }
      run = [];
    };
    series.forEach((v, i) => (isNum(v) ? run.push([i, v]) : flush()));
    flush();
    return svg(
      'svg',
      { class: `stats-spark ${tone}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      parts.length ? svg('path', { d: parts.join('') }) : null,
    );
  }

  // ── theme ───────────────────────────────────────────────────────

  function onScheme() {
    if (isOpen && chart) render();
  }

  document.addEventListener('visibilitychange', () => {
    if (!deferred || document.visibilityState === 'hidden') return;
    deferred = false;
    if (isOpen) load();
  });
  for (const q of ['(prefers-color-scheme: dark)', '(prefers-contrast: more)']) {
    try {
      window.matchMedia(q).addEventListener('change', onScheme);
    } catch {}
  }

  // ── the module ──────────────────────────────────────────────────

  function languageSig() {
    return `${I18nDom.lang()}|${I18nDom.locale()}|${I18nDom.hour12()}`;
  }

  function open(el, c, opts) {
    ctx = c;
    if (root !== el || !els) {
      root = el;
      build();
    }
    const again = isOpen;
    isOpen = true;
    deferred = false;
    if (!again) {
      adopt(c.settings, true);
      // History can change while the view is closed (Clear Usage History…,
      // the recordHistory switch): ask again on every open.
      data = null;
      accountsStale = true;
    }
    stamp = c.state ? c.state.fetchedAt || null : null;
    langSig = languageSig();
    target = opts && typeof opts.email === 'string' && opts.email ? { email: opts.email, organizationUuid: opts.organizationUuid || '' } : null;
    if (target) accountsStale = true;
    loadChart().catch(() => {});
    render();
    load();
  }

  function update(c) {
    ctx = c;
    if (!isOpen || !els) return;
    let reload = adopt(c.settings, false);
    const f = c.state ? c.state.fetchedAt || null : null;
    if (f !== stamp) {
      stamp = f;
      accountsStale = true;
      reload = true;
    }
    const lang = languageSig();
    const relabel = lang !== langSig;
    langSig = lang;
    // The popover keeps getting lists while it is hidden: read the history
    // again only once it shows.
    if (reload && document.visibilityState === 'hidden') deferred = true;
    else if (reload) load();
    else if (relabel) {
      if (accountsOk) fillPicker();
      render();
    }
  }

  function close() {
    isOpen = false;
    seq++;
    destroyChart();
  }

  // Main says the history changed (cleared, or recording switched): read it
  // again if the view is open; open() always reads it anyway.
  if (window.api && window.api.history && typeof window.api.history.onChanged === 'function') {
    window.api.history.onChanged(() => {
      if (!isOpen || !els) return;
      data = null;
      accountsStale = true;
      if (document.visibilityState === 'hidden') deferred = true;
      else load();
    });
  }

  window.StatsView = { open, update, close };
})();
