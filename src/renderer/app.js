'use strict';
// The popover / widget page (PLAN §3). This file is the shell: phase dispatch,
// title bar, banner, toast, the switch lock, window sizing, the statistics
// toggle and the pin button. The views are separate modules, each an IIFE
// with one global:
//   window.Hero        the active account (big rings)            hero.js
//   window.AccountList the other accounts (bar rows)              accounts.js
//   window.StatsView   Today / Week / Month statistics            stats-view.js
// When a module is absent (or still a placeholder), a plain fallback below
// keeps the page usable.
//
// Module contract (all optional; ctx is the object built by context()):
//   Hero.render(el, row | null, ctx)          active row, or null (no active account)
//   Hero.tick(now)                            1 s clock while visible
//   AccountList.render(listEl, rows, ctx)     rows = every account but the active one
//   AccountList.tick(now)                     30 s clock
//   StatsView.open(el, ctx, {email?, organizationUuid?})
//   StatsView.update(ctx)                     new state while open
//   StatsView.close()
//   Hero.recharge / AccountList.sweep(ctx)    motion hooks (P3.6), called on a
//                                             deliberate refresh or a switch
//
// Everything from cswap goes in as text (Dom.h / textContent / title), never
// as HTML.

(function () {
  // `api` is a non-configurable global from contextBridge; alias it in scope.
  const ipc = window.api;
  const Usage = window.Usage;
  const { h, $ } = window.Dom;
  const I18nDom = window.I18nDom;
  const t = (key, vars) => I18nDom.t(key, vars);

  const els = {
    app: $('app'),
    title: $('title'),
    subtitle: $('subtitle'),
    statsBtn: $('stats-btn'),
    pin: $('pin'),
    refresh: $('refresh'),
    menu: $('menu'),
    banner: $('banner'),
    screen: $('screen'),
    content: $('content'),
    hero: $('hero'),
    accounts: $('accounts'),
    list: $('acctList'),
    stats: $('stats'),
    footer: $('footer'),
    best: $('best'),
    next: $('next'),
    toast: $('toast'),
  };

  let state = null;
  let settings = {};
  let busy = false; // a switch started from this page is in flight
  let manualRefresh = false; // the running refresh was asked for by the user
  let view = 'accounts'; // 'accounts' | 'stats'
  let listSig = null;

  const locked = () => busy || Boolean(state && state.switching);
  const key = (row) => `${row.email || ''}|${row.organizationUuid || ''}`;
  const identity = (row) => ({ email: row.email, organizationUuid: row.organizationUuid || '' });

  // What the view modules get. Built fresh per call, so it never goes stale.
  function context() {
    return {
      t,
      api: ipc,
      usage: Usage,
      i18n: I18nDom,
      dom: window.Dom,
      state,
      settings,
      locked,
      manual: manualRefresh,
      doSwitch,
      identity,
      key,
      showAccountMenu: (row) => ipc.showAccountMenu(identity(row)),
    };
  }

  // ── render ──────────────────────────────────────────────────────

  function render() {
    const s = state;
    if (!s) return;
    renderChrome(s);
    const ok = s.phase === 'ok';
    const stats = view === 'stats' && ok;
    document.body.classList.toggle('view-stats', stats);
    els.statsBtn.setAttribute('aria-pressed', String(stats));
    els.statsBtn.disabled = !ok;

    els.screen.hidden = ok;
    if (!ok) {
      els.hero.hidden = true;
      els.accounts.hidden = true;
      els.footer.hidden = true;
      els.stats.hidden = true;
      const sig = JSON.stringify(['screen', s.phase, s.error, s.cswap, I18nDom.lang()]);
      if (sig !== listSig) {
        listSig = sig;
        window.Screens.render(els.screen, s, ipc);
      }
      fit();
      return;
    }

    const active = s.accounts.find((a) => a.active) || null;
    const others = s.accounts.filter((a) => a !== active);
    els.hero.hidden = false;
    els.accounts.hidden = others.length === 0;
    els.stats.hidden = !stats;
    els.footer.hidden = !(s.accounts.filter((a) => !a.disabled).length > 1);

    const ctx = context();
    if (window.Hero && typeof window.Hero.render === 'function') window.Hero.render(els.hero, active, ctx);
    else fallbackHero(els.hero, active, ctx);
    if (window.AccountList && typeof window.AccountList.render === 'function') window.AccountList.render(els.list, others, ctx);
    else fallbackList(els.list, others, ctx);
    if (stats && window.StatsView && typeof window.StatsView.update === 'function') window.StatsView.update(ctx);
    listSig = null; // a later screen phase must redraw
    applyLock();
    fit();
  }

  function renderChrome(s) {
    const active = s.phase === 'ok' ? s.accounts.find((a) => a.active) : null;
    // With no active account the hero says so; the title stays the app's.
    els.title.textContent = active ? Usage.label(active, t) : t('app.title');
    els.subtitle.textContent = subtitle(s, active);
    els.refresh.classList.toggle('spinning', Boolean(s.refreshing || s.switching));
    els.refresh.disabled = !['ok', 'no-accounts', 'error'].includes(s.phase);
    const err = s.phase === 'ok' && s.error ? Usage.errorText(s.error, t) : null;
    const bannerText = err ? t('banner.refreshFailed', { message: err.text }) : '';
    els.banner.hidden = !bannerText;
    els.banner.textContent = bannerText;
    els.banner.title = err ? err.detail : '';
    const widget = settings.windowMode === 'widget';
    els.pin.setAttribute('aria-pressed', String(widget));
    const pinTip = t(widget ? 'btn.unpin' : 'btn.pin');
    els.pin.title = pinTip;
    els.pin.setAttribute('aria-label', pinTip);
  }

  // Org · checked … ago · switching/refreshing. The cswap version goes in the
  // tooltip (and in the subtitle only when there is no org): 360 px is narrow.
  function subtitle(s, active) {
    const parts = [];
    const org = active && Usage.orgLabel(active);
    const version = s.cswap && s.cswap.version ? `cswap ${s.cswap.version}` : '';
    els.subtitle.title = version;
    if (org) parts.push(org);
    else if (version) parts.push(version);
    if ((s.phase === 'ok' || s.phase === 'no-accounts') && s.fetchedAt) {
      const age = (Date.now() - Date.parse(s.fetchedAt)) / 1000;
      parts.push(age < 10 ? t('hdr.checkedNow') : t('hdr.checkedAgo', { age: I18nDom.duration(age) }));
    }
    if (s.switching) parts.push(t('hdr.switching'));
    else if (s.refreshing) parts.push(t('hdr.refreshing'));
    return parts.join(' · ');
  }

  // aria-disabled, not `disabled`: a disabled button drops keyboard focus.
  function applyLock() {
    const value = String(locked());
    for (const b of [...els.list.querySelectorAll('.switch-btn'), els.best, els.next]) b.setAttribute('aria-disabled', value);
  }

  // ── fallbacks (replaced by hero.js / accounts.js) ────────────────

  function usageLine(row) {
    const { usage } = Usage.effectiveUsage(row);
    const part = (win, w) => (w && typeof w.pct === 'number' ? t('win.pct', { window: t(`win.${win}`), pct: Math.round(w.pct) }) : null);
    return [part('5h', usage && usage.fiveHour), part('7d', usage && usage.sevenDay)].filter(Boolean).join(' · ') || t('card.noUsage');
  }

  function pills(row, skipActive) {
    return h(
      'span',
      { class: 'pills' },
      Usage.badges(row, t)
        .filter((b) => !(skipActive && b.key === 'active'))
        .map((b) => h('span', { class: `pill ${b.tone}`, title: b.title }, b.label)),
    );
  }

  function fallbackHero(el, row, ctx) {
    el.dataset.account = row ? key(row) : '';
    el.dataset.number = row ? String(row.number) : '';
    el.classList.toggle('is-disabled', Boolean(row && row.disabled));
    const sig = JSON.stringify([row, I18nDom.lang()]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    if (!row) {
      el.replaceChildren(h('p', { class: 'hero-empty' }, t('hero.noActive')), h('p', { class: 'hero-empty-hint' }, t('hero.noActiveHint')));
      return;
    }
    el.replaceChildren(
      h('div', { class: 'hero-status' }, pills(row, true), h('button', { id: 'heroMenu', class: 'icon-btn small', type: 'button', 'aria-label': t('acct.actions', { name: Usage.label(row, t) }), onclick: () => ctx.showAccountMenu(row) }, '⋯')),
      h('p', { class: 'hero-usage' }, usageLine(row)),
    );
  }

  function fallbackList(listEl, rows, ctx) {
    const sig = JSON.stringify([rows, I18nDom.lang()]);
    if (listEl.dataset.sig === sig) return;
    listEl.dataset.sig = sig;
    const focused = document.activeElement;
    const focusedKey = focused && listEl.contains(focused) && focused.closest('[data-key]') ? focused.closest('[data-key]').dataset.key : null;
    const wasButton = Boolean(focusedKey && focused.classList.contains('switch-btn'));
    listEl.replaceChildren(
      ...rows.map((row) =>
        h(
          'article',
          { class: `acct${row.disabled ? ' is-disabled' : ''}`, role: 'listitem', 'data-number': row.number, 'data-key': key(row), tabindex: '-1' },
          h(
            'div',
            { class: 'acct-head' },
            h('span', { class: 'acct-name', title: row.alias ? `${row.alias} — ${row.email}` : row.email }, Usage.label(row, t)),
            pills(row, false),
            h(
              'div',
              { class: 'acct-actions' },
              h('button', { class: 'pill-btn switch-btn', type: 'button', 'aria-disabled': String(ctx.locked()), title: t('card.switchTip', { email: row.email }), onclick: () => ctx.doSwitch(identity(row), row.email) }, t('act.switch')),
              h('button', { class: 'icon-btn small acct-menu', type: 'button', 'aria-label': t('acct.actions', { name: Usage.label(row, t) }), onclick: () => ctx.showAccountMenu(row) }, '⋯'),
            ),
          ),
          h('p', { class: 'acct-usage' }, usageLine(row)),
        ),
      ),
    );
    if (focusedKey) {
      const same = [...listEl.querySelectorAll('[data-key]')].find((x) => x.dataset.key === focusedKey);
      const next = (wasButton && same && same.querySelector('.switch-btn')) || same || listEl;
      next.focus({ preventScroll: true });
    }
  }

  // ── window size ─────────────────────────────────────────────────

  // Natural height = #app as laid out + what the visible scroller hides.
  // It shrinks as well as grows (nothing stretches to fill the window).
  let lastHeight = 0;
  function fit() {
    // Skip what CSS hides (body.view-stats hides #accounts without `hidden`).
    const scroller = [els.screen, els.accounts, els.stats].find((x) => !x.hidden && x.getClientRects().length > 0) || null;
    const hidden = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    // Plus what overflows #content itself (the hero never shrinks): with no
    // scroller (one account) a window opened shorter than the hero never grew.
    const over = els.content.scrollHeight - els.content.clientHeight;
    const natural = Math.ceil(els.app.getBoundingClientRect().height + Math.max(0, hidden) + Math.max(0, over));
    if (Math.abs(natural - lastHeight) < 1) return;
    lastHeight = natural;
    ipc.resize(natural);
  }

  // ── actions ─────────────────────────────────────────────────────

  function setBusy(value) {
    busy = value;
    applyLock();
  }

  function targetName(to) {
    const row = to && (state && state.accounts ? state.accounts : []).find((a) => a.number === to.number && (!to.email || a.email === to.email));
    return row ? Usage.label(row, t) : (to && to.email) || '?';
  }

  function reasonText(res) {
    const k = `reason.${res.reason}`;
    const text = t(k, { name: targetName(res.to) });
    return text === k ? res.message || t('toast.noSwitch') : text;
  }

  async function doSwitch(target, clickedEmail) {
    if (locked()) return;
    setBusy(true);
    motion();
    try {
      const r = await ipc.switchTo(target);
      if (!r) return;
      if (r.ok) {
        const res = r.result || {};
        let msg = res.switched ? t('toast.switchedTo', { name: targetName(res.to) }) : reasonText(res);
        const changed = res.switched && clickedEmail && res.to && res.to.email && res.to.email !== clickedEmail;
        if (changed) msg = t('toast.listChanged', { message: msg });
        // cswap's warnings are for the user: shown, as main's menu toasts do.
        const warnings = Array.isArray(res.warnings) && res.warnings.length ? ` — ${res.warnings.join(' ')}` : '';
        toast({ text: msg + warnings, error: Boolean(changed), detail: res.message || '' });
      } else {
        const e = r.error ? Usage.errorText(r.error, t) : { text: t('toast.switchFailed'), detail: '' };
        toast({ text: e.text, error: true, detail: e.detail });
      }
    } catch (err) {
      toast({ text: t('toast.switchFailed'), error: true, detail: (err && err.message) || '' });
    } finally {
      setBusy(false);
    }
  }

  function refresh() {
    if (els.refresh.disabled) return;
    manualRefresh = true;
    motion();
    ipc.refresh();
  }

  // P3.6 hooks: the comet on the hero and the sweep on the rows.
  function motion() {
    const ctx = context();
    if (window.Hero && typeof window.Hero.recharge === 'function') window.Hero.recharge(ctx);
    if (window.AccountList && typeof window.AccountList.sweep === 'function') window.AccountList.sweep(ctx);
  }

  let toastTimer = null;
  function toast(msg) {
    const m = typeof msg === 'string' ? { text: msg } : msg || {};
    if (!m.text) return;
    els.toast.textContent = m.text;
    els.toast.title = m.detail || '';
    els.toast.classList.toggle('error', Boolean(m.error));
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), m.error ? 6000 : 3500);
  }

  // ── statistics ──────────────────────────────────────────────────

  // An open asked for before the first list (CSW_VIEW=stats, an early
  // ui:open) waits for the first 'ok' state instead of being dropped.
  let pendingOpen = null;

  function openStats(opts) {
    if (!state || state.phase !== 'ok') {
      pendingOpen = opts || {};
      return;
    }
    pendingOpen = null;
    view = 'stats';
    els.stats.hidden = false;
    if (window.StatsView && typeof window.StatsView.open === 'function') window.StatsView.open(els.stats, context(), opts || {});
    else els.stats.replaceChildren(h('p', { class: 'placeholder' }, t('stats.empty')));
    render();
  }

  function closeStats() {
    pendingOpen = null;
    view = 'accounts';
    if (window.StatsView && typeof window.StatsView.close === 'function') window.StatsView.close();
    render();
  }

  // ── settings ────────────────────────────────────────────────────

  function applySettings(s) {
    if (!s) return;
    settings = s;
    if (I18nDom.set(s)) {
      listSig = null;
      for (const el of [els.hero, els.list]) delete el.dataset.sig;
    }
    document.body.classList.toggle('mode-widget', s.windowMode === 'widget');
    document.body.classList.toggle('gauges-b', s.gaugeStyle === 'concentric');
    render();
  }

  // ── wiring ──────────────────────────────────────────────────────

  els.refresh.addEventListener('click', refresh);
  els.menu.addEventListener('click', () => ipc.showMenu());
  els.statsBtn.addEventListener('click', () => (view === 'stats' ? closeStats() : openStats()));
  els.pin.addEventListener('click', () => ipc.setWindowMode(settings.windowMode === 'widget' ? 'popover' : 'widget'));
  els.best.addEventListener('click', () => doSwitch({ strategy: 'best' }, null));
  els.next.addEventListener('click', () => doSwitch({ strategy: 'rotate' }, null));
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR')) {
      e.preventDefault();
      refresh();
    }
  });

  const ro = new ResizeObserver(() => fit());
  for (const el of [els.app, els.list, els.screen, els.stats, els.hero]) ro.observe(el);

  // Clocks: the 30 s one for "checked … ago" and the rows; the hero keeps its own 1 s tick.
  function tick() {
    if (!state || document.visibilityState !== 'visible') return;
    els.subtitle.textContent = subtitle(state, state.phase === 'ok' ? state.accounts.find((a) => a.active) : null);
    if (window.AccountList && typeof window.AccountList.tick === 'function') window.AccountList.tick(Date.now());
  }
  setInterval(tick, 30_000);
  setInterval(() => {
    if (state && state.phase === 'ok' && view !== 'stats' && document.visibilityState === 'visible' && window.Hero && typeof window.Hero.tick === 'function') {
      window.Hero.tick(Date.now());
    }
  }, 1000);
  document.addEventListener('visibilitychange', tick);

  (async function init() {
    const info = (await ipc.info()) || {};
    if (info.platform !== 'darwin' || info.capture) document.documentElement.classList.add('opaque');
    ipc.onToast((m) => toast(m));
    ipc.onSettings((s) => applySettings(s));
    ipc.onOpen((o) => {
      if (o && o.view === 'stats') openStats(o);
      else if (o && o.view === 'accounts') closeStats();
    });
    ipc.onState((s) => {
      const wasBusy = state && (state.refreshing || state.switching);
      state = s;
      if (wasBusy && !s.refreshing && !s.switching) manualRefresh = false;
      render();
      if (pendingOpen && s.phase === 'ok') openStats(pendingOpen);
    });
    applySettings(await ipc.getSettings());
    state = await ipc.getState();
    render();
    if (info.captureView === 'stats') openStats();
    else if (pendingOpen && state && state.phase === 'ok') openStats(pendingOpen);
  })();
})();
