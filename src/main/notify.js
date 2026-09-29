'use strict';
// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:1084-1181,
// 1348-1391, main.js:1204-1210).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// System notifications about the active account's limits (PLAN P2.5). Main
// builds them from the service state; the page has no channel that can post
// one (PLAN §8 item 13). A click shows the popover and never switches: the
// widget does not switch on its own (CLAUDE.md), `cswap auto` does that.
//
// The rules, Maestro's checkUsageAlerts moved to main and made per account:
// - Only the active account's 5h (session) and 7d (weekly) windows count.
// - The first trustworthy value of each window after the start, and again
//   after every change of the active account (ours, the menu's or
//   `cswap auto`'s), is taken as already seen: a launch at 95 % or a switch
//   onto a hot account says nothing.
// - Every rule reads a window's value as the menu bar and the popover show
//   it, rounded to a whole percent: 74.6 reads "75" and warns, 99.5 reads
//   "100" and is the limit.
// - Warn (75 %) and danger (90 %) fire once per window; danger also marks
//   warn, so a jump straight to danger is one notification. A value under
//   warn, or a reset time more than an hour later (the next window), arms
//   them again. At 100 % the "limit reached" notification owns the moment.
// - "Limit reached" fires once when either window reaches 100 %, weekly
//   first. "Available again" fires once when every window is readable again
//   and below 100 %, so a session reset while the week is still used up
//   stays quiet.
// - "All accounts are at their limit" (with the earliest reset) replaces
//   "limit reached" when every account in rotation is at 100 % too; when one
//   of them frees up, it is named as available again.
// - Nothing is read from a doubtful list (phase 'ok' with an error: the last
//   refresh failed), from last-good data (stale), or from a window whose
//   reset time has passed (its value no longer applies). They neither fire
//   nor re-arm anything.
// - With notifications off the rules keep running silently, so turning them
//   back on never replays old crossings.

const { Notification } = require('electron');
const I18n = require('../shared/i18n');
const { effectiveUsage, resetPassed, WARN, CRIT } = require('../shared/usage');

const LIMIT = 100;
const NEW_WINDOW_MS = 3_600_000; // a reset time this much later is the next window
const MAX_LIVE = 20; // notifications kept referenced for their click handler
const WINDOWS = Object.freeze([
  { id: 'session', key: 'fiveHour' },
  { id: 'weekly', key: 'sevenDay' },
]);

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Accounts are told apart by identity, not slot: `cswap move` renumbers.
function identity(row) {
  return `${row.email || ''}\n${row.organizationUuid || ''}`;
}

// A row's windows as the rules may read them. `pct` is the whole percent
// shown, or null when there is nothing trustworthy: no value, last-good data
// only, or a window that has rolled over since cswap measured it. `present`
// says whether cswap reports the window at all (an API-key account has
// neither).
function readWindows(row, now) {
  const { usage, stale } = effectiveUsage(row);
  const out = {};
  for (const { id, key } of WINDOWS) {
    const w = (usage && usage[key]) || null;
    const present = Boolean(w) && finite(w.pct);
    const known = present && !stale && !resetPassed(w, now);
    out[id] = { present, pct: known ? Math.round(w.pct) : null, resetsAt: known ? w.resetsAt : null };
  }
  return out;
}

// 'out' when a readable window is at 100 %, 'free' when every window cswap
// reports is readable and below it, null when that cannot be told yet.
function limitState(read) {
  const all = WINDOWS.map(({ id }) => read[id]);
  if (all.some((r) => r.pct !== null && r.pct >= LIMIT)) return 'out';
  if (all.some((r) => r.pct !== null) && all.every((r) => !r.present || r.pct !== null)) return 'free';
  return null;
}

function freshFlags(key) {
  const win = () => ({ seeded: false, warn: false, danger: false, end: NaN });
  return { key, session: win(), weekly: win(), blocked: null }; // blocked: null until seeded
}

class Notifier {
  // show({kind, title, body}) posts one notification. t(key, vars) is the UI
  // language's translator, asked at the moment a notification is built.
  // formatting() → {locale, hour12} for reset times.
  constructor({ show, t, formatting = () => ({ locale: I18n.LOCALES.en }), enabled = true, warn = WARN, danger = CRIT, now = Date.now } = {}) {
    this.show = show;
    this.t = t || I18n.translator('en');
    this.formatting = formatting;
    this.enabled = enabled !== false;
    this.warn = warn;
    this.danger = danger;
    this.now = now;
    this.account = null; // freshFlags() of the active account, or null
    this.exhausted = null; // every account in rotation at its limit; null until seeded
  }

  setEnabled(on) {
    this.enabled = on !== false;
  }

  // Feed every service state. Returns the notifications it posted.
  update(state) {
    if (!state || state.phase !== 'ok' || state.error) return [];
    const now = this.now();
    const accounts = (Array.isArray(state.accounts) ? state.accounts : []).filter(Boolean);
    const active = accounts.find((a) => a.active) || null;
    const key = active ? identity(active) : null;
    if (!this.account || this.account.key !== key) this.account = key === null ? null : freshFlags(key);

    const notes = [];
    if (active) {
      const read = readWindows(active, now);
      this.thresholds(active, read, notes);
      this.blocked(active, read, notes);
    }
    this.allExhausted(accounts, now, notes);
    const out = this.enabled ? notes : [];
    for (const n of out) this.show(n);
    return out;
  }

  // Warn and danger per window, once each per window.
  thresholds(row, read, notes) {
    for (const { id } of WINDOWS) {
      const { pct, resetsAt } = read[id];
      if (pct === null) continue;
      const f = this.account[id];
      const end = Date.parse(resetsAt);
      if (f.seeded && finite(f.end) && finite(end) && end - f.end > NEW_WINDOW_MS) f.warn = f.danger = false;
      if (finite(end)) f.end = end;
      if (!f.seeded) {
        f.seeded = true;
        f.danger = pct >= this.danger;
        f.warn = pct >= this.warn;
      } else if (pct < this.warn) {
        f.warn = f.danger = false;
      } else if (pct >= LIMIT) {
        f.warn = f.danger = true;
      } else if (pct >= this.danger) {
        if (!f.danger) {
          f.warn = f.danger = true;
          notes.push(this.level(`${id}Danger`, row, pct));
        }
      } else if (!f.warn) {
        f.warn = true;
        notes.push(this.level(`${id}Warn`, row, pct));
      }
    }
  }

  // "Limit reached" and "available again", one flag for both windows.
  blocked(row, read, notes) {
    const state = limitState(read);
    const acct = this.account;
    if (acct.blocked === null) {
      if (WINDOWS.some(({ id }) => read[id].pct !== null)) acct.blocked = state === 'out';
    } else if (state === 'out' && !acct.blocked) {
      acct.blocked = true;
      notes.push(this.reached(row, read));
    } else if (state === 'free' && acct.blocked) {
      acct.blocked = false;
      notes.push(this.available(row));
    }
  }

  // Every account in rotation (and the active one, which is in use even
  // when disabled) at its limit. Needs two or more: for one account
  // "limit reached" says it better.
  allExhausted(accounts, now, notes) {
    const pool = accounts
      .filter((a) => !a.disabled || a.active)
      .map((row) => {
        const read = readWindows(row, now);
        return { row, read, state: limitState(read) };
      });
    const allOut = pool.length >= 2 && pool.every((p) => p.state === 'out');
    const free = pool.filter((p) => p.state === 'free');
    if (this.exhausted === null) {
      if (allOut || free.length) this.exhausted = allOut;
    } else if (allOut && !this.exhausted) {
      this.exhausted = true;
      for (let i = notes.length - 1; i >= 0; i--) if (notes[i].kind === 'reached') notes.splice(i, 1);
      notes.push(this.exhaustedNote(pool));
    } else if (free.length && this.exhausted) {
      this.exhausted = false;
      const first = free.find((p) => p.row.active) || free[0];
      const key = identity(first.row);
      if (!notes.some((n) => n.kind === 'available' && n.key === key)) notes.push(this.available(first.row));
    }
  }

  // ── the texts ───────────────────────────────────────────────────────────

  name(row) {
    return row.alias || row.email || this.t('card.accountN', { n: row.number });
  }

  level(which, row, p) {
    return this.note('level', row, this.t('app.title'), this.t(`notify.${which}`, { name: this.name(row), p }));
  }

  reached(row, read) {
    const name = this.name(row);
    const f = this.formats();
    if (read.weekly.pct !== null && read.weekly.pct >= LIMIT) {
      const { resetsAt } = read.weekly;
      const body = Number.isFinite(Date.parse(resetsAt)) ? this.t('notify.weeklyReachedBody', { date: f.day(resetsAt), time: f.clock(resetsAt) }) : '';
      return this.note('reached', row, this.t('notify.weeklyReached', { name }), body);
    }
    const { resetsAt } = read.session;
    const body = Number.isFinite(Date.parse(resetsAt)) ? this.t('notify.sessionReachedBody', { time: f.clock(resetsAt) }) : '';
    return this.note('reached', row, this.t('notify.sessionReached', { name }), body);
  }

  available(row) {
    return this.note('available', row, this.t('app.title'), this.t('notify.available', { name: this.name(row) }));
  }

  // The account that frees up first: for each, the later reset of the
  // windows that hold it at 100 %.
  exhaustedNote(pool) {
    let first = null;
    for (const p of pool) {
      const ends = WINDOWS.map(({ id }) => p.read[id])
        .filter((r) => r.pct !== null && r.pct >= LIMIT)
        .map((r) => Date.parse(r.resetsAt));
      if (!ends.length || !ends.every(finite)) continue;
      const at = Math.max(...ends);
      if (!first || at < first.at) first = { row: p.row, at };
    }
    const body = first ? this.t('notify.allExhaustedBody', { name: this.name(first.row), when: this.formats().when(first.at) }) : '';
    return { kind: 'exhausted', key: null, title: this.t('notify.allExhausted'), body };
  }

  note(kind, row, title, body) {
    return { kind, key: identity(row), title, body };
  }

  formats() {
    const { locale, hour12 } = this.formatting() || {};
    const loc = typeof locale === 'string' && locale ? locale : I18n.LOCALES.en;
    const h12 = typeof hour12 === 'boolean' ? hour12 : undefined;
    const now = new Date(this.now());
    return {
      clock: (when) => I18n.formatClock(loc, when, h12),
      day: (when) => I18n.formatDay(loc, when, 'date-day', h12),
      // Today: the time; later: the day and the time.
      when: (ms) => (new Date(ms).toDateString() === now.toDateString() ? I18n.formatClock(loc, ms, h12) : I18n.formatDay(loc, ms, 'date-day-time', h12)),
    };
  }
}

// ── main-process glue ───────────────────────────────────────────────────────

// The language ctx.t speaks: its `lang` when it carries one, else recognised
// by a string that differs in every language.
function languageOf(t) {
  if (t && I18n.CODES.includes(t.lang)) return t.lang;
  const title = typeof t === 'function' ? t('app.title') : '';
  return I18n.CODES.find((code) => I18n.STRINGS[code]['app.title'] === title) || 'en';
}

// Reset times as the popover writes them: main's resolved { locale, hour12 }
// (ctx.getLanguage(), settings-ipc.js). Without it, the default locale of the
// language ctx.t speaks, and that locale's clock.
function formatting(ctx) {
  const ui = typeof ctx.getLanguage === 'function' ? ctx.getLanguage() : null;
  if (ui && typeof ui.locale === 'string' && ui.locale) return { locale: ui.locale, hour12: ui.hour12 };
  return { locale: I18n.LOCALES[languageOf(ctx.t)] };
}

let notifier = null;
const live = new Set(); // shown notifications; a collected one loses its click handler

function attach(ctx) {
  notifier = new Notifier({
    enabled: (ctx.getSettings() || {}).notifications !== false,
    t: (key, vars) => ctx.t(key, vars),
    formatting: () => formatting(ctx),
    show: (note) => post(ctx, note),
  });
  ctx.bus.on('setting:notifications', (next) => notifier.setEnabled(next));
  ctx.service.on('state', (state) => notifier.update(state));
  notifier.update(ctx.service.state);
}

function post(ctx, { title, body }) {
  if (!Notification || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  const forget = () => live.delete(n);
  // Shows the popover (or the widget); never switches accounts.
  n.on('click', () => {
    forget();
    ctx.showUi();
  });
  n.on('close', forget);
  live.add(n);
  if (live.size > MAX_LIVE) live.delete(live.values().next().value);
  n.show();
}

module.exports = { attach, Notifier, languageOf, formatting };
