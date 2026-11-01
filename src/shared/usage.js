// Pure helpers for reading cswap account rows. Shared by the main process
// (tray title, tooltip, menu) and the sandboxed renderer (cards), so it is
// written as a tiny UMD module: `require()` in main, `<script>` in the
// renderer (exposed as `window.Usage`, loaded after `window.I18n`).
//
// Every visible string goes through a translator `t(key, vars)` from
// i18n.js (or a language code), passed as the last argument; trayInfo also
// takes it as opts.t. Left out, it is English. A page that has not loaded i18n.js still gets
// the same English from FALLBACK_EN below (test/usage.test.js pins the two
// together); only trayInfo's reset lines need i18n.js's date formatting.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./i18n'));
  else root.Usage = factory(root, null);
})(typeof self !== 'undefined' ? self : this, function (root, required) {
  'use strict';

  const WARN = 75;
  const CRIT = 90;
  // cswap serves a cached measurement for up to 180 s without fetching
  // (SERVE_TTL_S) and only then notes its age; past that, but still trusted
  // by cswap, we show how old it is.
  const AGED_AFTER_S = 180;
  const LOGIN_WARN_S = 3 * 86400; // warn this long before a login lapses
  const LOGIN_URGENT_S = 86400; // from here on the warning is red
  // These statuses already say the login is gone, or there is none to lapse.
  // Under foreign_credential cswap's date is the other account's, not this slot's.
  const NO_LOGIN_NOTICE = Object.freeze(['relogin_required', 'no_credentials', 'api_key', 'foreign_credential']);

  // Every usageStatus cswap 0.26–0.27 emits besides "ok", as i18n keys. The
  // menu line uses `menuLine.<status>` (lowercase where the language wants
  // it; German nouns keep their capital). Unknown future values still get a
  // neutral badge (the contract is additive).
  const STATUS_BADGES = Object.freeze({
    token_expired: Object.freeze({ tone: 'warn', labelKey: 'badge.token_expired', tipKey: 'badge.tip.token_expired' }),
    relogin_required: Object.freeze({ tone: 'crit', labelKey: 'badge.relogin_required', tipKey: 'badge.tip.relogin_required' }),
    keychain_unavailable: Object.freeze({ tone: 'warn', labelKey: 'badge.keychain_unavailable', tipKey: 'badge.tip.keychain_unavailable' }),
    foreign_credential: Object.freeze({ tone: 'warn', labelKey: 'badge.foreign_credential', tipKey: 'badge.tip.foreign_credential' }),
    no_credentials: Object.freeze({ tone: 'crit', labelKey: 'badge.no_credentials', tipKey: 'badge.tip.no_credentials' }),
    api_key: Object.freeze({ tone: 'info', labelKey: 'badge.api_key', tipKey: 'badge.tip.api_key' }),
    unavailable: Object.freeze({ tone: 'muted', labelKey: 'badge.unavailable', tipKey: 'badge.tip.unavailable' }),
  });

  // The English of every key used here, for a page that loads usage.js
  // without i18n.js (today's index.html). Must equal I18n.STRINGS.en.
  const FALLBACK_EN = Object.freeze({
    'badge.active': 'Active',
    'badge.activeTip': 'The account Claude Code uses now',
    'badge.disabled': 'Disabled',
    'badge.disabledTip': 'Held out of auto-rotation',
    'badge.stale': 'Stale',
    'badge.staleAgo': 'Stale · {age} ago',
    'badge.staleTip': 'Showing the last good measurement',
    'badge.aged': '{age} ago',
    'badge.agedTip': 'Measured {age} ago; cswap re-measures each account on its own schedule',
    'badge.token_expired': 'Token expired',
    'badge.tip.token_expired': 'Claude Code refreshes it on next use; cswap retries automatically',
    'badge.relogin_required': 'Re-login',
    'badge.tip.relogin_required': 'Log in again in Claude Code, then run: cswap add',
    'badge.keychain_unavailable': 'Keychain locked',
    'badge.tip.keychain_unavailable': 'macOS Keychain could not be read',
    'badge.foreign_credential': 'Credential mismatch',
    'badge.tip.foreign_credential': 'Switching to this account repairs it',
    'badge.no_credentials': 'No credentials',
    'badge.tip.no_credentials': 'Log in again in Claude Code, then run: cswap add',
    'badge.api_key': 'API key',
    'badge.tip.api_key': 'API-key accounts have no subscription quota',
    'badge.unavailable': 'Usage unavailable',
    'badge.tip.unavailable': 'The usage API did not answer',
    'badge.pace': '7d ahead of pace',
    'badge.tip.pace': 'Used {pct}% — faster than an even pace to the weekly reset',
    'badge.tip.paceExpected': 'Used {pct}%; an even pace would be {expected}% by now',
    'badge.loginSoon': 'Login expires in {time}',
    'badge.loginExpired': 'Login expired',
    'badge.tip.login': 'Log in to this account again in Claude Code, then run: cswap add --slot {n}',
    'card.accountN': 'Account {n}',
    'cd.seconds': '{s}s',
    'cd.minutes': '{m}m',
    'cd.hours': '{h}h {m}m',
    'cd.hoursOnly': '{h}h',
    'cd.days': '{d}d {h}h',
    'cd.daysOnly': '{d}d',
    'win.5h': '5h',
    'win.7d': '7d',
    'win.pct': '{window} {pct}%',
    'model.week': '{name} · week',
    'fmt.pct': '{p}%',
    'setup.error.unknown': 'Unknown error',
    'trayTip.loading': 'Claude accounts — loading…',
    'trayTip.setup': 'claude-swap needs setup',
    'trayTip.noAccounts': 'No accounts in claude-swap yet',
    'trayTip.noActive': 'No active account',
    'trayTip.error': 'claude-swap: {message}',
    'trayTip.windowReset': '{window} window has reset, waiting for new data',
    'trayTip.ahead': '(ahead of pace)',
    'trayTip.notUpdatedFor': 'not updated for {age}',
    'trayTip.notUpdated': 'not updated',
    'trayTip.stale': 'stale',
    'trayTip.old': '{age} old',
    'trayTip.model': '{name}: {pct}%',
    'trayTip.noSession': 'no 5-hour limit',
    'trayTip.loginSoon': 'login expires in {time}',
    'trayTip.loginExpired': 'login expired',
    'menuLine.reset': '{window} reset',
    'menuLine.ahead': '(ahead)',
    'menuLine.disabled': 'disabled',
    'menuLine.stale': 'stale',
    'menuLine.token_expired': 'token expired',
    'menuLine.relogin_required': 're-login',
    'menuLine.keychain_unavailable': 'keychain locked',
    'menuLine.foreign_credential': 'credential mismatch',
    'menuLine.no_credentials': 'no credentials',
    'menuLine.api_key': 'API key',
    'menuLine.unavailable': 'usage unavailable',
    'menuLine.loginSoon': 'login expires in {time}',
    'menuLine.loginExpired': 'login expired',
  });

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // i18n.js: required in main; in a page, window.I18n when it was loaded
  // (looked up at call time, so the script order cannot break it).
  function i18n() {
    return required || (root && root.I18n) || null;
  }

  function fallbackT(key, vars) {
    const text = has(FALLBACK_EN, key) ? FALLBACK_EN[key] : String(key);
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? '')) : text;
  }

  // The caller's translator (or a language code, as I18n.formatDuration
  // takes), else English.
  function tr(t) {
    if (typeof t === 'function') return t;
    const I = i18n();
    return I ? I.translator(typeof t === 'string' ? t : 'en') : fallbackT;
  }

  // Our own error messages in the UI language. err is a CswapError or the
  // service's plain {kind, message, errorType?, signal?, spawnError?,
  // exitCode?}. cswap's own text (errorType set: its JSON error envelope, or
  // its last stderr line) stays as it is; our English is replaced by a key.
  // Returns { text, detail }: detail is the raw English when it was replaced.
  const ACCOUNT_GONE = 'That account is no longer in claude-swap; the list has been refreshed';
  function errorText(err, t) {
    const tt = tr(t);
    const raw = String((err && err.message) || '');
    const kind = err && err.kind;
    let text = raw || tt('toast.actionFailed');
    if (raw === ACCOUNT_GONE) text = tt('err.accountGone');
    else if (kind === 'not-installed') text = tt('err.notAvailable');
    else if (kind === 'too-old') text = tt('setup.tooOld.title');
    else if (kind === 'timeout') text = tt('err.timeout');
    else if (kind === 'bad-output') text = tt('err.badOutput');
    else if (kind === 'schema') text = tt('err.schema', { v: (/schemaVersion (\S+)/.exec(raw) || [])[1] || '?' });
    else if (kind === 'invalid') text = tt('err.invalidTarget');
    else if (kind === 'cli' && err.signal) text = tt('err.stopped', { signal: err.signal });
    else if (kind === 'cli' && err.spawnError) text = tt('err.spawn', { code: err.spawnError });
    else if (kind === 'cli' && !err.errorType && /^cswap exited with code \d+$/.test(raw)) text = tt('err.exitCode', { code: err.exitCode });
    return { text, detail: text === raw ? '' : raw };
  }

  // Judged on the whole number the UI shows, so "75%" is always amber and
  // "90%" always red (the tray picture and the notifier follow the same rule).
  function level(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'none';
    const shown = Math.round(pct);
    if (shown >= CRIT) return 'crit';
    if (shown >= WARN) return 'warn';
    return 'ok';
  }

  // Fresh `usage` when cswap has it; otherwise the last good measurement,
  // flagged stale so the UI can dim it and show its age.
  function effectiveUsage(row) {
    if (row && row.usage) {
      return { usage: row.usage, stale: false, ageSeconds: num(row.usageAgeSeconds) };
    }
    if (row && row.lastGoodUsage) {
      return { usage: row.lastGoodUsage, stale: true, ageSeconds: num(row.lastGoodAgeSeconds) };
    }
    return { usage: null, stale: false, ageSeconds: null };
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  // A window with no number is missing, never 0.
  function hasPct(w) {
    return Boolean(w) && num(w.pct) !== null;
  }

  function modelName(w) {
    return w.name || '?';
  }

  // Per-model weekly windows that have a number, fullest first (ties keep cswap's order).
  function modelWindows(usage) {
    const scoped = usage && Array.isArray(usage.scoped) ? usage.scoped : [];
    return scoped.filter(hasPct).sort((a, b) => b.pct - a.pct);
  }

  // The windows that get a ring in the hero and a line in the rows, at most
  // two, as slots { kind: '5h' | '7d' | 'model', win, name? }. `rest` = the
  // model windows not promoted (they stay under "more limits").
  //   5h + 7d            → [5h, 7d]        (models stay in rest)
  //   5h, no 7d, model   → [5h, model]     (Team seats, claude-swap #476)
  //   5h only            → [5h]
  //   7d + model, no 5h  → [model, 7d]     (Ultra: the week keeps its place on the right)
  //   7d only            → [7d]
  //   models only        → [top model, second model if any]
  //   nothing            → []
  function mainWindows(usage) {
    const five = usage && hasPct(usage.fiveHour) ? { kind: '5h', win: usage.fiveHour } : null;
    const seven = usage && hasPct(usage.sevenDay) ? { kind: '7d', win: usage.sevenDay } : null;
    const models = modelWindows(usage);
    const free = 2 - (five ? 1 : 0) - (seven ? 1 : 0);
    const promoted = models.slice(0, free).map((win) => ({ kind: 'model', win, name: modelName(win) }));
    return { shown: [five, ...promoted, seven].filter(Boolean), rest: models.slice(free) };
  }

  // Fresh data (row.usage, not lastGoodUsage) that has limits but no 5-hour
  // window at all. Only this may claim "no 5-hour limit": stale data shows what
  // it has and claims nothing, and so does a window cswap sends without a number.
  // cswap does not expose the plan, so never say more than this about an account.
  function noSessionLimit(row) {
    const usage = row && row.usage;
    return Boolean(usage) && !usage.fiveHour && mainWindows(usage).shown.length > 0;
  }

  // null, or { at: ms, seconds: >=0, expired, urgent } when the stored login
  // lapses in less than LOGIN_WARN_S (or already has). After that the slot is
  // relogin_required and only a fresh /login fixes it, so the UI warns ahead.
  function loginExpiry(row, now = Date.now()) {
    const raw = row && row.loginExpiresAt;
    const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at)) return null;
    const left = (at - now) / 1000;
    if (left >= LOGIN_WARN_S) return null;
    return { at, seconds: Math.max(0, left), expired: left <= 0, urgent: left < LOGIN_URGENT_S };
  }

  // loginExpiry, when the row's status does not already say it (NO_LOGIN_NOTICE).
  function loginNotice(row, now = Date.now()) {
    return NO_LOGIN_NOTICE.includes(row && row.usageStatus) ? null : loginExpiry(row, now);
  }

  // 45s, 12m, 2h 13m, 3d 4h; "1 ч 30 мин", "1 Std. 30 Min." with a translator.
  // Same rule as I18n.formatDuration (test/i18n.test.js pins the English).
  function formatDuration(seconds, t) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    const tt = tr(t);
    const s = Math.round(seconds);
    if (s < 60) return tt('cd.seconds', { s });
    const m = Math.floor(s / 60);
    if (m < 60) return tt('cd.minutes', { m });
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? tt('cd.hours', { h, m: m % 60 }) : tt('cd.hoursOnly', { h });
    const d = Math.floor(h / 24);
    return h % 24 ? tt('cd.days', { d, h: h % 24 }) : tt('cd.daysOnly', { d });
  }

  function secondsUntil(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, (t - now) / 1000);
  }

  // The window has rolled over since cswap measured it: its pct is outdated
  // until the next refresh.
  function resetPassed(window, now = Date.now()) {
    const t = Date.parse(window && window.resetsAt);
    return Number.isFinite(t) && t <= now;
  }

  // Age of a measurement cswap still serves as current, when it is old
  // enough to mention; null otherwise (and for stale last-good data, which
  // has its own badge).
  function agedSeconds(row) {
    const eff = effectiveUsage(row);
    return !eff.stale && eff.usage && eff.ageSeconds !== null && eff.ageSeconds > AGED_AFTER_S ? eff.ageSeconds : null;
  }

  // [{key, label, tone, title?}], labels and titles in the translator's language.
  function badges(row, t, now = Date.now()) {
    const tt = tr(t);
    const out = [];
    if (row.active) out.push({ key: 'active', label: tt('badge.active'), tone: 'accent', title: tt('badge.activeTip') });
    if (row.disabled) out.push({ key: 'disabled', label: tt('badge.disabled'), tone: 'muted', title: tt('badge.disabledTip') });
    const st = row.usageStatus;
    if (st && st !== 'ok') {
      if (has(STATUS_BADGES, st)) {
        const b = STATUS_BADGES[st];
        out.push({ key: st, label: tt(b.labelKey), tone: b.tone, title: tt(b.tipKey) });
      } else {
        // cswap's own word, untranslated
        out.push({ key: st, label: String(st).replace(/_/g, ' '), tone: 'muted' });
      }
    }
    const login = loginNotice(row, now);
    if (login) {
      const label = login.expired ? tt('badge.loginExpired') : tt('badge.loginSoon', { time: formatDuration(login.seconds, tt) });
      out.push({ key: 'login', label, tone: login.urgent ? 'crit' : 'warn', title: tt('badge.tip.login', { n: row.number }) });
    }
    const eff = effectiveUsage(row);
    if (eff.stale) {
      const age = formatDuration(eff.ageSeconds, tt);
      out.push({ key: 'stale', label: age ? tt('badge.staleAgo', { age }) : tt('badge.stale'), tone: 'muted', title: tt('badge.staleTip') });
    }
    const aged = agedSeconds(row);
    if (aged !== null) {
      const age = formatDuration(aged, tt);
      out.push({ key: 'aged', label: tt('badge.aged', { age }), tone: 'muted', title: tt('badge.agedTip', { age }) });
    }
    const pace = paceNote(eff.usage && eff.usage.sevenDay, tt);
    if (pace) out.push({ key: 'pace', label: tt('badge.pace'), tone: 'warn', title: pace });
    return out;
  }

  // One pill per model window with no ring or line of its own (mainWindows'
  // `rest`) that has reached the warn line, in cswap's order. A window that has
  // rolled over says nothing any more. The rows and the hero show the same.
  function modelBadges(usage, t, now = Date.now()) {
    const tt = tr(t);
    const { rest } = mainWindows(usage);
    const out = [];
    for (const w of usage && Array.isArray(usage.scoped) ? usage.scoped : []) {
      if (!rest.includes(w) || resetPassed(w, now) || level(w.pct) === 'ok') continue;
      const name = w.name || '?';
      out.push({ key: `model:${name}`, label: tt('win.pct', { window: name, pct: Math.round(w.pct) }), tone: level(w.pct) === 'crit' ? 'crit' : 'warn', title: tt('model.week', { name }) });
    }
    return out;
  }

  // cswap's weekly pace: `aheadOfPace` when usage runs ahead of an even spread
  // over the window. (Its exhaustion ETA is deliberately not shown: cswap
  // keeps it out of human-facing output because the error bars are wide.)
  function paceNote(window, t) {
    if (!window || window.aheadOfPace !== true || typeof window.pct !== 'number') return '';
    const tt = tr(t);
    const pct = Math.round(window.pct);
    const expected = num(window.expectedPct);
    return expected === null ? tt('badge.tip.pace', { pct }) : tt('badge.tip.paceExpected', { pct, expected: Math.round(expected) });
  }

  function label(row, t) {
    return row.alias || row.email || tr(t)('card.accountN', { n: row.number });
  }

  // Short form for the menu bar: the alias, else the part of the email before "@".
  function shortName(row, t) {
    return row.alias || (row.email ? row.email.split('@')[0] : '') || tr(t)('card.accountN', { n: row.number });
  }

  // One line per account for the native menus, in claude-swap's own style:
  // "1  work  5h 20% (2h 12m) · 7d 34% (ahead) (3d 4h) · Fable 76% (3d 4h)".
  function menuLabel(row, now = Date.now(), t) {
    const tt = tr(t);
    const { usage, stale } = effectiveUsage(row);
    const part = (name, w) => {
      if (!w || typeof w.pct !== 'number') return null;
      if (resetPassed(w, now)) return tt('menuLine.reset', { window: name });
      const secs = secondsUntil(w.resetsAt, now);
      const ahead = w.aheadOfPace === true ? ` ${tt('menuLine.ahead')}` : '';
      return `${tt('win.pct', { window: name, pct: Math.round(w.pct) })}${ahead}${secs != null ? ` (${formatDuration(secs, tt)})` : ''}`;
    };
    const scoped = usage && Array.isArray(usage.scoped) ? usage.scoped : [];
    const windows = usage
      ? [part(tt('win.5h'), usage.fiveHour), part(tt('win.7d'), usage.sevenDay), ...scoped.map((w) => part((w && w.name) || '?', w))]
      : [];
    const notes = [];
    if (row.disabled) notes.push(tt('menuLine.disabled'));
    const st = row.usageStatus;
    if (st && st !== 'ok') notes.push(has(STATUS_BADGES, st) ? tt(`menuLine.${st}`) : String(st).replace(/_/g, ' '));
    const login = loginNotice(row, now);
    if (login) notes.push(login.expired ? tt('menuLine.loginExpired') : tt('menuLine.loginSoon', { time: formatDuration(login.seconds, tt) }));
    if (stale) notes.push(tt('menuLine.stale'));
    const usageText = windows.filter(Boolean).join(' · ');
    return [`${row.number}  ${label(row, tt)}`, usageText, notes.length ? `— ${notes.join(', ')}` : ''].filter(Boolean).join('  ');
  }

  // Personal accounts come with an auto-named org ("<email>'s Organization")
  // that only repeats the email; show real org names only.
  function orgLabel(row) {
    const name = (row.organizationName || '').trim();
    if (!name) return '';
    const m = /^(.*)['’]s Organization$/i.exec(name);
    if (m && row.email && m[1].trim().toLowerCase() === row.email.toLowerCase()) return '';
    return name;
  }

  // Menu-bar summary of the active account. `mode` picks the window(s) the
  // title shows (5h | 7d | both | max | off, as in claude-swap's own menu);
  // the ring shows the same window (5h for both/off) and is coloured by the
  // highest percentage shown. The tray is what people glance at without
  // opening anything, so doubtful numbers say so: a "?" when the list could
  // not be refreshed or only last-good data is left, and no number at all
  // for a window that has rolled over since it was measured.
  //
  // An account with no 5-hour number but other windows (mainWindows) has its
  // "week value" in every mode instead: sevenDay, else its fullest model. The
  // ring shows that value (max: the fullest window) and the colour follows the
  // fullest window, shown or not. 5h without 7d (Team seats) reads the same
  // fallback as its second window.
  //
  // → {title, pct, level, tooltip, tooltipLines?}. `tooltip` is one line;
  // `tooltipLines` are the lines that go under it (PLAN §4.3), present only
  // when there is a reset time to tell, so the whole tooltip is
  // [tooltip, ...(tooltipLines || [])].join('\n'). Their dates follow
  // opts.locale (else the translator's language), opts.hour12 (undefined:
  // the locale's habit) and opts.weeklyDateFormat ('date' | 'date-day' |
  // 'date-day-time').
  function trayInfo(state, now = Date.now(), opts, t) {
    const o = opts || {};
    const { mode = '5h', showName = false } = o;
    const tt = tr(t || o.t);
    const phase = state && state.phase;
    if (!phase || phase === 'loading') return tray('', null, tt('trayTip.loading'));
    if (phase === 'missing' || phase === 'too-old') return tray('!', null, tt('trayTip.setup'));
    if (phase === 'no-accounts') return tray('', null, tt('trayTip.noAccounts'));
    if (phase === 'error') return tray('!', null, tt('trayTip.error', { message: state.error ? errorText(state.error, tt).text : tt('setup.error.unknown') }));
    const active = (state.accounts || []).find((a) => a.active);
    if (!active) return tray('–', null, tt('trayTip.noActive'));
    const { usage, stale } = effectiveUsage(active);
    const parts = [label(active, tt)];
    const read = (name, w) => {
      const p = num(w && w.pct);
      if (p === null) return null;
      if (resetPassed(w, now)) {
        parts.push(tt('trayTip.windowReset', { window: name }));
        return null;
      }
      const ahead = w.aheadOfPace === true ? ` ${tt('trayTip.ahead')}` : '';
      parts.push(`${tt('win.pct', { window: name, pct: Math.round(p) })}${ahead}`);
      return p;
    };
    const five = read(tt('win.5h'), usage && usage.fiveHour);
    const hasWeek = hasPct(usage && usage.sevenDay);
    const models = modelWindows(usage);
    let seven = null;
    if (hasWeek) seven = read(tt('win.7d'), usage.sevenDay);
    else if (models.length) seven = read(modelName(models[0]), models[0]);
    const noFive = !hasPct(usage && usage.fiveHour) && mainWindows(usage).shown.length > 0;
    // Without a 5-hour window every other model window is on the first line too.
    const others = noFive ? models.slice(hasWeek ? 0 : 1).map((w) => read(modelName(w), w)) : [];
    if (noSessionLimit(active)) parts.push(tt('trayTip.noSession'));
    // phase 'ok' with an error: the last refresh failed and this list is older.
    const failing = Boolean(state.error);
    if (failing) {
      const at = Date.parse(state.fetchedAt);
      parts.push(Number.isFinite(at) ? tt('trayTip.notUpdatedFor', { age: formatDuration(Math.max(0, now - at) / 1000, tt) }) : tt('trayTip.notUpdated'));
    }
    if (stale) parts.push(tt('trayTip.stale'));
    const aged = agedSeconds(active);
    if (aged !== null) parts.push(tt('trayTip.old', { age: formatDuration(aged, tt) }));
    const login = loginNotice(active, now);
    if (login) parts.push(login.expired ? tt('trayTip.loginExpired') : tt('trayTip.loginSoon', { time: formatDuration(login.seconds, tt) }));
    // Nothing else on the tooltip says it, and only the user can fix this one.
    if (active.usageStatus === 'relogin_required') parts.push(tt('menuLine.relogin_required'));

    const highest = (...ps) => ps.filter((p) => p !== null).reduce((m, p) => (m === null || p > m ? p : m), null);
    const pct = (p) => (p === null ? '–' : tt('fmt.pct', { p: Math.round(p) }));
    let text;
    let ring;
    let hot;
    if (noFive) {
      hot = highest(seven, ...others);
      ring = mode === 'max' ? hot : seven;
      text = mode === 'off' ? '' : pct(ring);
    } else if (mode === '7d') [text, ring, hot] = [pct(seven), seven, seven];
    else if (mode === 'both') [text, ring, hot] = [`${pct(five)} · ${pct(seven)}`, five, highest(five, seven)];
    else if (mode === 'max') [text, ring, hot] = [pct(highest(five, seven)), highest(five, seven), highest(five, seven)];
    else if (mode === 'off') [text, ring, hot] = ['', five, five];
    else [text, ring, hot] = [pct(five), five, five];
    if (text && /\d/.test(text) && (failing || stale)) text += '?';
    const title = [showName ? shortName(active, tt) : '', text].filter(Boolean).join(' ');
    const info = { title, pct: ring, level: level(hot), tooltip: parts.join(' · ') };
    const lines = resetLines(usage, now, o, tt);
    if (lines.length) info.tooltipLines = lines;
    return info;
  }

  // "Session: 20% · resets at 15:59" and "Week: 34% · resets Oct 2", one for
  // each window with a reset still ahead (a rolled-over one is already
  // explained in the first line). The two-line layout follows Claude Usage
  // Widget — The Maestro edition (main.js:926-934); MIT, see LICENSE.
  function resetLines(usage, now, o, tt) {
    const I = i18n();
    if (!I || !usage) return [];
    const locale = typeof o.locale === 'string' && o.locale ? o.locale : I.LOCALES[tt.lang] || I.LOCALES.en;
    const hour12 = typeof o.hour12 === 'boolean' ? o.hour12 : undefined;
    const ahead = (w) => w && num(w.pct) !== null && !resetPassed(w, now);
    const lines = [];
    if (ahead(usage.fiveHour)) {
      const time = I.formatClock(locale, usage.fiveHour.resetsAt, hour12);
      if (time) lines.push(`${tt('trayTip.session', { pct: Math.round(usage.fiveHour.pct) })} · ${tt('reset.at', { time })}`);
    }
    if (ahead(usage.sevenDay)) {
      const date = I.formatDay(locale, usage.sevenDay.resetsAt, o.weeklyDateFormat || 'date', hour12);
      if (date) lines.push(`${tt('trayTip.week', { pct: Math.round(usage.sevenDay.pct) })} · ${tt('reset.on', { date })}`);
    }
    // Only where a model stands in for a missing window; a 5h + 7d account's
    // tooltip keeps its two lines.
    if (!hasPct(usage.fiveHour) || !hasPct(usage.sevenDay)) {
      for (const w of modelWindows(usage)) {
        const date = ahead(w) ? I.formatDay(locale, w.resetsAt, o.weeklyDateFormat || 'date', hour12) : '';
        if (date) lines.push(`${tt('trayTip.model', { name: modelName(w), pct: Math.round(w.pct) })} · ${tt('reset.on', { date })}`);
      }
    }
    return lines;
  }

  function tray(title, pct, tooltip) {
    return { title, pct, level: level(pct), tooltip };
  }

  return {
    WARN,
    CRIT,
    AGED_AFTER_S,
    LOGIN_WARN_S,
    LOGIN_URGENT_S,
    STATUS_BADGES,
    level,
    effectiveUsage,
    hasPct,
    modelWindows,
    mainWindows,
    noSessionLimit,
    loginExpiry,
    loginNotice,
    formatDuration,
    secondsUntil,
    resetPassed,
    agedSeconds,
    paceNote,
    badges,
    modelBadges,
    label,
    shortName,
    menuLabel,
    orgLabel,
    trayInfo,
    errorText,
    ACCOUNT_GONE,
  };
});
