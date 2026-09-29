// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:805-815,
// 1806-1830).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
'use strict';

// Every account but the active one, as a row with their compact bars
// (window.AccountList): name, status pills, Switch and ⋯, then two thin bars
// (5h, 7d) with their percentages and the time to the 5-hour reset.
//
//   AccountList.render(listEl, rows, ctx)
//   AccountList.tick(now)      reset countdowns, every 30 s
//   AccountList.sweep(ctx)     a light sweeps the bars during a refresh/switch
//
// The list is rebuilt only when what it shows changed (cswap sends fields
// that differ on every call), keeping keyboard focus on the same account and
// easing each bar from its previous width.

(function () {
  const { h } = window.Dom;
  const Usage = window.Usage;
  const I18nDom = window.I18nDom;
  const t = (key, vars) => I18nDom.t(key, vars);

  let listSig = null;
  let listEl = null;

  function minute(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
  }

  function windowSig(w) {
    return w && typeof w.pct === 'number' ? [Math.round(w.pct), minute(w.resetsAt)] : null;
  }

  // What a row shows, without the fields that change on every cswap call.
  function rowSig(r) {
    const { usage, stale } = Usage.effectiveUsage(r);
    const u = usage || {};
    return [
      r.number,
      Boolean(r.disabled),
      r.email,
      Usage.label(r, t),
      stale,
      windowSig(u.fiveHour),
      windowSig(u.sevenDay),
      (Array.isArray(u.scoped) ? u.scoped : []).map((w) => [w && w.name, w && Math.round(w.pct)]),
      Usage.badges(r, t).map((b) => `${b.key}:${b.tone}`),
    ];
  }

  // Pills: the badges minus Active (the hero is the active one), plus one per
  // model window that has reached the warn line.
  function pills(row) {
    const { usage } = Usage.effectiveUsage(row);
    const out = Usage.badges(row, t).filter((b) => b.key !== 'active');
    for (const w of usage && Array.isArray(usage.scoped) ? usage.scoped : []) {
      if (w && typeof w.pct === 'number' && Usage.level(w.pct) !== 'ok') {
        out.push({ key: `model:${w.name}`, label: t('win.pct', { window: w.name || '?', pct: Math.round(w.pct) }), tone: Usage.level(w.pct) === 'crit' ? 'crit' : 'warn', title: t('model.week', { name: w.name || '?' }) });
      }
    }
    return out.map((b) => h('span', { class: `pill ${b.tone}`, title: b.title || null, 'data-badge': b.key }, b.label));
  }

  function tone(pct) {
    const lvl = Usage.level(pct);
    return lvl === 'crit' ? 'is-danger' : lvl === 'warn' ? 'is-warning' : '';
  }

  function bar(win, kind, stale, key) {
    const pct = win && typeof win.pct === 'number' ? Math.min(Math.max(win.pct, 0), 100) : null;
    const cls = ['compact-bar-fill', kind === '7d' ? 'weekly' : '', pct > 0 ? 'has-value' : '', stale ? '' : tone(pct)].filter(Boolean).join(' ');
    const fill = h('div', { class: cls, 'data-fill': `${key}|${kind}`, 'data-pct': pct === null ? '' : String(pct) });
    const lvl = Usage.level(pct);
    const pctText = pct === null ? '—' : `${Math.round(pct)}%`;
    return [
      h('span', { class: 'lbl' }, t(`win.${kind}`)),
      h('div', { class: 'compact-bar-bg' }, fill),
      h('span', { class: `pct${stale ? '' : lvl === 'crit' ? ' crit' : lvl === 'warn' ? ' warn' : ''}` }, pctText),
    ];
  }

  function resetText(win, now) {
    if (!win || !win.resetsAt) return '';
    if (Usage.resetPassed(win, now)) return t('ring.now');
    const secs = Usage.secondsUntil(win.resetsAt, now);
    return secs == null ? '' : `↻ ${I18nDom.duration(secs)}`;
  }

  function row(r, ctx, now) {
    const { usage, stale } = Usage.effectiveUsage(r);
    const key = ctx.key(r);
    const name = Usage.label(r, t);
    const five = usage && usage.fiveHour;
    const reset = h('span', { class: 'acct-reset', 'data-resets-at': (five && five.resetsAt) || '' }, resetText(five, now));
    const pillEls = pills(r);
    const classes = ['acct', r.disabled ? 'is-disabled' : '', stale ? 'is-stale' : ''].filter(Boolean).join(' ');
    return h(
      'article',
      { class: classes, role: 'listitem', 'data-number': r.number, 'data-key': key, tabindex: '-1' },
      h(
        'div',
        { class: 'acct-head' },
        h('span', { class: 'acct-name', title: r.alias ? `${r.alias} — ${r.email}` : r.email }, name),
        h(
          'div',
          { class: 'acct-actions' },
          h(
            'button',
            {
              class: 'pill-btn switch-btn',
              type: 'button',
              'aria-disabled': String(ctx.locked()),
              title: t('card.switchTip', { email: r.email }),
              onclick: () => ctx.doSwitch(ctx.identity(r), r.email),
            },
            t('act.switch'),
          ),
          h(
            'button',
            { class: 'icon-btn small acct-menu', type: 'button', 'aria-label': t('acct.actions', { name }), title: t('acct.actions', { name }), onclick: () => ctx.showAccountMenu(r) },
            window.Dom.svg('svg', { class: 'solid', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [5.5, 12, 18.5].map((cx) => window.Dom.svg('circle', { cx, cy: 12, r: 1.7 }))),
          ),
        ),
      ),
      pillEls.length ? h('div', { class: 'pills acct-pills' }, pillEls) : null,
      usage
        ? h('div', { class: 'acct-bars' }, bar(five, '5h', stale, key), bar(usage.sevenDay, '7d', stale, key), reset)
        : h('p', { class: 'acct-no-usage' }, t('card.noUsage')),
    );
  }

  function render(el, rows, ctx) {
    listEl = el;
    const sig = JSON.stringify([rows.map(rowSig), I18nDom.lang()]);
    if (sig === listSig && el.childElementCount === rows.length) {
      patch(el, rows);
      return;
    }
    listSig = sig;

    // The bars ease from where they were (the old nodes are about to go).
    const before = new Map([...el.querySelectorAll('[data-fill]')].map((f) => [f.dataset.fill, f.style.width]));
    // Keep focus on the same account and the same kind of element; never on
    // another account's Switch button (Enter there would switch elsewhere).
    const focused = document.activeElement;
    const hadFocus = Boolean(focused && el.contains(focused));
    const focusedKey = hadFocus && focused.closest('[data-key]') ? focused.closest('[data-key]').dataset.key : null;
    const wasButton = hadFocus && focused.classList.contains('switch-btn');

    const now = Date.now();
    el.replaceChildren(...rows.map((r) => row(r, ctx, now)));

    const fills = [...el.querySelectorAll('[data-fill]')];
    for (const f of fills) f.style.width = before.get(f.dataset.fill) || '0%';
    requestAnimationFrame(() => {
      for (const f of fills) f.style.width = `${f.dataset.pct === '' ? 0 : Number(f.dataset.pct)}%`;
    });

    if (hadFocus) {
      const same = focusedKey ? [...el.querySelectorAll('[data-key]')].find((x) => x.dataset.key === focusedKey) : null;
      const next = (wasButton && same && same.querySelector('.switch-btn')) || same || el;
      next.focus({ preventScroll: true });
    }
    sweepEnd(ctx);
  }

  // Same structure: refresh the time-derived texts in place.
  function patch(el, rows) {
    for (const r of rows) {
      const art = [...el.querySelectorAll('[data-number]')].find((x) => x.dataset.number === String(r.number));
      if (!art) continue;
      const spans = art.querySelectorAll('.acct-pills > .pill');
      const want = Usage.badges(r, t).filter((b) => b.key !== 'active');
      want.forEach((b, i) => {
        if (!spans[i] || spans[i].dataset.badge !== b.key) return;
        if (spans[i].textContent !== b.label) spans[i].textContent = b.label;
        if ((spans[i].getAttribute('title') || '') !== (b.title || '')) spans[i].title = b.title || '';
      });
    }
    tick(Date.now());
  }

  function tick(now) {
    if (!listEl) return;
    for (const el of listEl.querySelectorAll('.acct-reset')) {
      const at = el.dataset.resetsAt;
      el.textContent = at ? resetText({ resetsAt: at }, now) : '';
    }
  }

  // A light sweeps the bars while cswap works (a deliberate refresh or a
  // switch); it stops with the next state that is idle.
  function sweep() {
    if (listEl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) listEl.classList.add('sweeping');
  }

  function sweepEnd(ctx) {
    const s = ctx && ctx.state;
    if (listEl && !(s && (s.refreshing || s.switching))) listEl.classList.remove('sweeping');
  }

  window.AccountList = {
    render(el, rows, ctx) {
      render(el, rows, ctx);
      sweepEnd(ctx);
    },
    tick,
    sweep,
  };
})();
