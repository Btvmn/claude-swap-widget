'use strict';
// Popover UI. Everything from cswap (emails, org names, messages) is put into
// the page with textContent only — never as HTML.

/* global Usage */
// `api` itself is a non-configurable global from contextBridge; alias it.
const ipc = window.api;
const { effectiveUsage, formatDuration, secondsUntil, resetPassed, badges, label, orgLabel, level } = Usage;

const $ = (id) => document.getElementById(id);
const els = {
  subtitle: $('subtitle'),
  refresh: $('refresh'),
  menu: $('menu'),
  banner: $('banner'),
  content: $('content'),
  list: $('list'),
  footer: $('footer'),
  best: $('best'),
  toast: $('toast'),
};

let state = null;
let busy = false; // a switch started from this popover is in flight

// Switch controls are locked while any switch runs, including one that
// started before a reload. aria-disabled, not `disabled`: a disabled button
// drops keyboard focus, and doSwitch() ignores clicks while locked anyway.
const locked = () => busy || Boolean(state && state.switching);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ── rings ─────────────────────────────────────────────────────────

const R = 20;
const CIRC = 2 * Math.PI * R;

// The time-dependent parts (countdown, tooltip, aria label, "has reset"
// dimming) live in data attributes so the 30-s tick can update them in place.
function ring(caption, window, { stale, ariaName }) {
  const pct = window && typeof window.pct === 'number' ? window.pct : null;
  const frac = pct == null ? 0 : Math.min(1, Math.max(0, pct / 100));
  const dial = svg('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' });
  dial.append(svg('circle', { class: 'track', cx: 24, cy: 24, r: R }));
  if (pct != null && frac > 0) {
    dial.append(
      svg('circle', {
        class: 'value',
        cx: 24,
        cy: 24,
        r: R,
        'stroke-dasharray': `${CIRC} ${CIRC}`,
        'stroke-dashoffset': String(CIRC * (1 - frac)),
      }),
    );
  }
  const value = pct == null ? '—' : h('span', null, String(Math.round(pct)), h('small', null, '%'));
  const fig = h(
    'figure',
    {
      class: 'ring',
      'data-level': level(pct),
      'data-name': ariaName,
      'data-pct': pct == null ? '' : String(Math.round(pct)),
      'data-resets-at': (window && window.resetsAt) || '',
      'data-stale': stale ? '1' : '',
    },
    h('div', { class: 'ring-dial' }, dial, h('span', { class: 'ring-pct' }, value, h('span', { class: 'ring-name' }, caption))),
    // Always present (even empty) so both rings keep the same height.
    h('figcaption', null, ' '),
  );
  updateRing(fig);
  return fig;
}

function updateRing(fig, now = Date.now()) {
  const { name, pct, resetsAt, stale } = fig.dataset;
  // Once the window has rolled over, the pct belongs to the previous window
  // until the next refresh brings the new one.
  const passed = resetPassed({ resetsAt }, now);
  const secs = passed ? null : secondsUntil(resetsAt, now);
  const reset = secs != null ? formatDuration(secs) : '';
  const outdated = Boolean(stale) || passed;
  fig.classList.toggle('stale', outdated);
  fig.querySelector('figcaption').textContent = passed ? '↻ now' : reset ? `↻ ${reset}` : ' ';
  fig.title = passed ? 'This window has reset; new usage arrives with the next refresh' : reset ? `Resets in ${reset}` : '';
  const when = passed ? ', window has reset' : reset ? `, resets in ${reset}` : '';
  fig.setAttribute('aria-label', pct === '' ? `${name}: no data` : `${name}: ${pct}%${when}${outdated ? ' (outdated)' : ''}`);
}

// ── cards ─────────────────────────────────────────────────────────

function card(row) {
  const { usage, stale } = effectiveUsage(row);
  const sub = [row.alias ? row.email : null, orgLabel(row) || null].filter(Boolean).join(' · ');
  const scoped = (usage && Array.isArray(usage.scoped) ? usage.scoped : [])
    .filter((w) => w && typeof w.pct === 'number')
    .map((w, i) => [i ? ' · ' : '', h('span', { class: level(w.pct) }, `${w.name || 'model'} 7d ${Math.round(w.pct)}%`)]);
  const spend = usage && usage.spend && typeof usage.spend.used === 'number' ? usage.spend : null;

  const classes = ['card', row.active && 'active', row.disabled && 'disabled'].filter(Boolean).join(' ');
  return h(
    'article',
    { class: classes, 'data-number': row.number, tabindex: '-1' },
    h(
      'div',
      { class: 'rings' },
      ring('5h', usage && usage.fiveHour, { stale, ariaName: '5-hour usage' }),
      ring('7d', usage && usage.sevenDay, { stale, ariaName: '7-day usage' }),
    ),
    h(
      'div',
      { class: 'who' },
      h('div', { class: 'name', title: row.alias ? `${row.alias} — ${row.email}` : row.email }, label(row)),
      sub ? h('div', { class: 'sub', title: sub }, sub) : null,
      scoped.length ? h('div', { class: 'scoped' }, scoped) : null,
      spend ? h('div', { class: 'scoped' }, `Extra usage ${formatMoney(spend.used, spend.currency)} of ${formatMoney(spend.limit, spend.currency)}`) : null,
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'badges' }, badges(row).map((b) => h('span', { class: `badge ${b.tone}`, title: b.title }, b.label))),
        row.active
          ? null
          : h(
              'button',
              {
                class: 'switch-btn',
                type: 'button',
                'aria-disabled': locked() ? 'true' : null,
                title: `Switch Claude Code to ${row.email}`,
                onclick: () => doSwitch({ email: row.email, organizationUuid: row.organizationUuid || '' }, row.email),
              },
              'Switch',
            ),
      ),
    ),
  );
}

function formatMoney(v, currency) {
  if (typeof v !== 'number') return '?';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency || ''}`.trim();
  }
}

// ── screens ───────────────────────────────────────────────────────

function cmd(text) {
  return h(
    'div',
    { class: 'cmd' },
    h('code', null, text),
    h('button', { type: 'button', onclick: (e) => copy(text, e.currentTarget) }, 'Copy'),
  );
}

async function copy(text, btn) {
  await ipc.copy(text);
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy'), 1200);
}

function screenMissing(s) {
  if (s.cswap && s.cswap.configured) {
    return h(
      'section',
      { class: 'screen' },
      h('h2', null, 'cswap not found at the chosen path'),
      h('p', null, 'The binary picked with “Choose binary…” was moved, uninstalled, or is not an executable file:'),
      h('p', { class: 'path' }, s.cswap.path),
      actions(s),
    );
  }
  return h(
    'section',
    { class: 'screen' },
    h('h2', null, 'Install claude-swap'),
    h('p', null, 'This app is a front end for claude-swap, which does the actual account switching. Install it with one of:'),
    cmd('uv tool install claude-swap'),
    cmd('pipx install claude-swap'),
    h('p', { class: 'path' }, s.cswap && s.cswap.path ? `Tried: ${s.cswap.path}` : 'Searched PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin'),
    actions(s),
  );
}

function screenTooOld(s) {
  const v = (s.cswap && s.cswap.version) || 'installed';
  return h(
    'section',
    { class: 'screen' },
    h('h2', null, 'Update claude-swap'),
    h('p', null, `claude-swap ${v} is too old for this app. Upgrade it with the tool you installed it with:`),
    cmd('uv tool upgrade claude-swap'),
    cmd('pipx upgrade claude-swap'),
    h('p', { class: 'path' }, (s.cswap && s.cswap.path) || ''),
    actions(s),
  );
}

function screenNoAccounts() {
  return h(
    'section',
    { class: 'screen' },
    h('h2', null, 'No accounts yet'),
    h('p', null, 'Log in to Claude Code with an account, then register it with claude-swap. Repeat for each account:'),
    cmd('cswap add'),
    h('div', { class: 'actions' }, h('button', { class: 'secondary', type: 'button', onclick: () => ipc.recheck() }, 'Check again')),
  );
}

function screenError(s) {
  return h(
    'section',
    { class: 'screen' },
    h('h2', null, 'claude-swap failed'),
    h('p', null, (s.error && s.error.message) || 'Unknown error'),
    h('p', { class: 'path' }, (s.cswap && s.cswap.path) || ''),
    actions(s),
  );
}

function actions(s) {
  const configured = Boolean(s.cswap && s.cswap.configured);
  return h(
    'div',
    { class: 'actions' },
    h('button', { class: 'secondary', type: 'button', onclick: () => ipc.recheck() }, 'Check again'),
    configured ? h('button', { class: 'secondary', type: 'button', onclick: () => ipc.usePath() }, 'Use cswap from PATH') : null,
    h('button', { class: 'secondary', type: 'button', onclick: () => ipc.chooseBinary() }, 'Choose binary…'),
    configured ? null : h('button', { class: 'link', type: 'button', onclick: () => ipc.openDocs() }, 'Install guide'),
  );
}

// ── render ────────────────────────────────────────────────────────

// The header, banner and footer follow every state event. The list is
// rebuilt only when its structure changed; cswap sends fields that differ on
// every call (usageAgeSeconds, microsecond resetsAt), so the signature uses
// what the cards show, and time-derived text is patched in place. That way
// focus, hover tooltips and clicks survive the refresh cycle.
let listSig = null;

function minute(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round(t / 60_000) : null;
}

function windowSig(w) {
  return w && typeof w.pct === 'number' ? [Math.round(w.pct), minute(w.resetsAt)] : null;
}

function rowSig(r) {
  const { usage, stale } = effectiveUsage(r);
  const u = usage || {};
  return [
    r.number,
    Boolean(r.active),
    Boolean(r.disabled),
    r.email,
    label(r),
    orgLabel(r),
    stale,
    windowSig(u.fiveHour),
    windowSig(u.sevenDay),
    (Array.isArray(u.scoped) ? u.scoped : []).map((w) => [w && w.name, w && Math.round(w.pct)]),
    u.spend ? [u.spend.used, u.spend.limit, u.spend.currency] : null,
    badges(r).map((b) => `${b.key}:${b.tone}`),
  ];
}

function render() {
  const s = state;
  if (!s) return;
  renderChrome(s);
  const sig = JSON.stringify([s.phase, s.phase === 'ok' ? null : s.error, s.cswap, (s.accounts || []).map(rowSig)]);
  if (sig !== listSig) {
    listSig = sig;
    renderList(s);
  } else {
    patchList(s);
  }
  fit();
}

// Same structure: refresh the texts that depend on time ("9m ago",
// "Stale · 1h 30m ago") without replacing any node.
function patchList(s) {
  for (const row of s.accounts || []) {
    const el = els.list.querySelector(`[data-number="${CSS.escape(String(row.number))}"]`);
    if (!el) continue;
    const spans = el.querySelectorAll('.badges > .badge');
    badges(row).forEach((b, i) => {
      if (!spans[i]) return;
      if (spans[i].textContent !== b.label) spans[i].textContent = b.label;
      if ((spans[i].getAttribute('title') || '') !== (b.title || '')) {
        if (b.title) spans[i].setAttribute('title', b.title);
        else spans[i].removeAttribute('title');
      }
    });
  }
}

function renderChrome(s) {
  els.refresh.classList.toggle('spinning', Boolean(s.refreshing));
  els.refresh.disabled = !['ok', 'no-accounts', 'error'].includes(s.phase);
  els.subtitle.textContent = subtitle(s);
  const bannerText = s.phase === 'ok' && s.error ? `Could not refresh: ${s.error.message}` : '';
  els.banner.hidden = !bannerText;
  els.banner.textContent = bannerText;
  els.footer.hidden = !(s.phase === 'ok' && s.accounts.filter((a) => !a.disabled).length > 1);
  applyLock();
}

function applyLock() {
  const value = String(locked());
  for (const b of [...els.list.querySelectorAll('.switch-btn'), els.best]) b.setAttribute('aria-disabled', value);
}

function renderList(s) {
  let body;
  if (s.phase === 'loading') body = h('div', { class: 'placeholder' }, 'Looking for claude-swap…');
  else if (s.phase === 'missing') body = screenMissing(s);
  else if (s.phase === 'too-old') body = screenTooOld(s);
  else if (s.phase === 'no-accounts') body = screenNoAccounts();
  else if (s.phase === 'error') body = screenError(s);
  else if (!s.accounts.length) body = h('div', { class: 'placeholder' }, 'No accounts');
  else body = s.accounts.map(card);

  // Keep focus on the same account and the same kind of element across the
  // rebuild: a button stays a button, a card stays a card (a mouse click on
  // a card body must not end up on its Switch button, where Space would
  // switch). Never move to another account's button either.
  const focused = document.activeElement;
  const hadFocus = Boolean(focused && els.list.contains(focused));
  const focusedCard = hadFocus ? focused.closest('[data-number]') : null;
  const wasButton = hadFocus && focused.classList.contains('switch-btn');
  els.list.replaceChildren(...[body].flat());
  if (hadFocus) {
    const same = focusedCard && els.list.querySelector(`[data-number="${CSS.escape(focusedCard.dataset.number)}"]`);
    const next = (wasButton && same && same.querySelector('.switch-btn')) || same || els.list;
    next.focus({ preventScroll: true });
  }
}

function subtitle(s) {
  const parts = [];
  if (s.cswap && s.cswap.version) parts.push(`cswap ${s.cswap.version}`);
  if ((s.phase === 'ok' || s.phase === 'no-accounts') && s.fetchedAt) {
    const age = (Date.now() - Date.parse(s.fetchedAt)) / 1000;
    parts.push(age < 10 ? 'checked just now' : `checked ${formatDuration(age)} ago`);
  }
  if (s.switching) parts.push('switching…');
  else if (s.refreshing) parts.push('refreshing…');
  return parts.join(' · ');
}

// Ask main to size the window to our natural height (it clamps to a maximum;
// beyond that the list scrolls).
let lastHeight = 0;
function fit() {
  const natural = Math.ceil(window.innerHeight - els.content.clientHeight + els.list.offsetHeight);
  if (Math.abs(natural - lastHeight) < 1) return;
  lastHeight = natural;
  ipc.resize(natural);
}

// ── actions ───────────────────────────────────────────────────────

function setBusy(value) {
  busy = value;
  applyLock();
}

// The toast names the account cswap actually switched to (`to`), not the card
// that was clicked.
function targetName(to) {
  const row = to && (state?.accounts || []).find((a) => a.number === to.number && (!to.email || a.email === to.email));
  return row ? label(row) : (to && to.email) || 'account';
}

async function doSwitch(target, clickedEmail) {
  if (locked()) return;
  setBusy(true);
  try {
    const r = await ipc.switchTo(target);
    if (!r) return;
    if (r.ok) {
      const res = r.result || {};
      const msg = res.switched ? `Switched to ${targetName(res.to)}` : res.message || 'No switch needed';
      const warnings = Array.isArray(res.warnings) && res.warnings.length ? ` — ${res.warnings.join(' ')}` : '';
      const unexpected = res.switched && clickedEmail && res.to && res.to.email && res.to.email !== clickedEmail;
      toast((unexpected ? `${msg} — the account list had changed` : msg) + warnings, Boolean(unexpected));
    } else {
      toast(r.error?.message || 'Switch failed', true);
    }
  } catch (err) {
    toast(err?.message || 'Switch failed', true);
  } finally {
    setBusy(false);
  }
}

let toastTimer = null;
function toast(text, isError = false) {
  els.toast.textContent = text;
  els.toast.classList.toggle('error', isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), isError ? 6000 : 3500);
}

els.refresh.addEventListener('click', () => ipc.refresh());
els.menu.addEventListener('click', () => ipc.showMenu());
els.best.addEventListener('click', () => doSwitch({ strategy: 'best' }, null));
els.list.tabIndex = -1; // focus fallback when the focused card disappears
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    ipc.refresh();
  }
});

new ResizeObserver(fit).observe(els.list);

// Countdowns and "checked … ago" tick in place, without a refetch or a rebuild.
function tick() {
  if (!state || document.visibilityState !== 'visible') return;
  els.subtitle.textContent = subtitle(state);
  for (const fig of els.list.querySelectorAll('figure.ring')) updateRing(fig);
}
setInterval(tick, 30_000);
document.addEventListener('visibilitychange', tick);

(async function init() {
  const info = (await ipc.info()) || {};
  if (info.platform !== 'darwin' || info.capture) document.documentElement.classList.add('opaque');
  ipc.onState((s) => {
    state = s;
    render();
  });
  state = await ipc.getState();
  render();
})();
