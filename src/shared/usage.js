// Pure helpers for reading cswap account rows. Shared by the main process
// (tray title) and the sandboxed renderer (cards), so it is written as a
// tiny UMD module with no dependencies: `require()` in main, `<script>` in
// the renderer (exposed as `window.Usage`).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Usage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WARN = 75;
  const CRIT = 90;
  // cswap serves a cached measurement for up to 180 s without fetching
  // (SERVE_TTL_S) and only then notes its age; past that, but still trusted
  // by cswap, we show how old it is.
  const AGED_AFTER_S = 180;

  function level(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'none';
    if (pct >= CRIT) return 'crit';
    if (pct >= WARN) return 'warn';
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

  // 45s, 12m, 2h 13m, 3d 4h
  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !(seconds >= 0)) return '';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
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

  // Every usageStatus cswap 0.26–0.27 emits besides "ok". Unknown future
  // values still get a neutral badge (the contract is additive).
  const STATUS_BADGES = {
    token_expired: { label: 'Token expired', tone: 'warn', title: 'Claude Code refreshes it on next use; cswap retries automatically' },
    relogin_required: { label: 'Re-login', tone: 'crit', title: 'Log in again in Claude Code, then run: cswap add' },
    keychain_unavailable: { label: 'Keychain locked', tone: 'warn', title: 'macOS Keychain could not be read' },
    foreign_credential: { label: 'Credential mismatch', tone: 'warn', title: 'Switching to this account repairs it' },
    no_credentials: { label: 'No credentials', tone: 'crit', title: 'Log in again in Claude Code, then run: cswap add' },
    api_key: { label: 'API key', tone: 'info', title: 'API-key accounts have no subscription quota' },
    unavailable: { label: 'Usage unavailable', tone: 'muted', title: 'The usage API did not answer' },
  };

  function badges(row) {
    const out = [];
    if (row.active) out.push({ key: 'active', label: 'Active', tone: 'accent' });
    if (row.disabled) out.push({ key: 'disabled', label: 'Disabled', tone: 'muted', title: 'Held out of auto-rotation' });
    const st = row.usageStatus;
    if (st && st !== 'ok') {
      const b = STATUS_BADGES[st] || { label: String(st).replace(/_/g, ' '), tone: 'muted' };
      out.push({ key: st, ...b });
    }
    const eff = effectiveUsage(row);
    if (eff.stale) {
      const age = formatDuration(eff.ageSeconds);
      out.push({ key: 'stale', label: age ? `Stale · ${age} ago` : 'Stale', tone: 'muted', title: 'Showing the last good measurement' });
    }
    const aged = agedSeconds(row);
    if (aged !== null) {
      const age = formatDuration(aged);
      out.push({ key: 'aged', label: `${age} ago`, tone: 'muted', title: `Measured ${age} ago; cswap re-measures each account on its own schedule` });
    }
    const pace = paceNote(eff.usage && eff.usage.sevenDay);
    if (pace) out.push({ key: 'pace', label: '7d ahead of pace', tone: 'warn', title: pace });
    return out;
  }

  // cswap's weekly pace: `aheadOfPace` when usage runs ahead of an even spread
  // over the window. (Its exhaustion ETA is deliberately not shown: cswap
  // keeps it out of human-facing output because the error bars are wide.)
  function paceNote(window) {
    if (!window || window.aheadOfPace !== true || typeof window.pct !== 'number') return '';
    const expected = num(window.expectedPct);
    return expected === null
      ? `Used ${Math.round(window.pct)}% — faster than an even pace to the weekly reset`
      : `Used ${Math.round(window.pct)}%; an even pace would be ${Math.round(expected)}% by now`;
  }

  function label(row) {
    return row.alias || row.email || `Account ${row.number}`;
  }

  // Short form for the menu bar: the alias, else the part of the email before "@".
  function shortName(row) {
    return row.alias || (row.email ? row.email.split('@')[0] : '') || `Account ${row.number}`;
  }

  // One line per account for the native menus, in claude-swap's own style:
  // "1  work  5h 20% (2h 12m) · 7d 34% (ahead) (3d 4h) · Fable 76% (3d 4h)".
  function menuLabel(row, now = Date.now()) {
    const { usage, stale } = effectiveUsage(row);
    const part = (name, w) => {
      if (!w || typeof w.pct !== 'number') return null;
      if (resetPassed(w, now)) return `${name} reset`;
      const secs = secondsUntil(w.resetsAt, now);
      const ahead = w.aheadOfPace === true ? ' (ahead)' : '';
      return `${name} ${Math.round(w.pct)}%${ahead}${secs != null ? ` (${formatDuration(secs)})` : ''}`;
    };
    const windows = usage
      ? [part('5h', usage.fiveHour), part('7d', usage.sevenDay), ...(Array.isArray(usage.scoped) ? usage.scoped : []).map((w) => part((w && w.name) || 'model', w))]
      : [];
    const notes = [];
    if (row.disabled) notes.push('disabled');
    if (row.usageStatus && row.usageStatus !== 'ok') {
      const b = STATUS_BADGES[row.usageStatus];
      notes.push((b ? b.label : String(row.usageStatus).replace(/_/g, ' ')).toLowerCase());
    }
    if (stale) notes.push('stale');
    const usageText = windows.filter(Boolean).join(' · ');
    return [`${row.number}  ${label(row)}`, usageText, notes.length ? `— ${notes.join(', ')}` : ''].filter(Boolean).join('  ');
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
  function trayInfo(state, now = Date.now(), { mode = '5h', showName = false } = {}) {
    const phase = state && state.phase;
    if (!phase || phase === 'loading') return tray('', null, 'Claude accounts — loading…');
    if (phase === 'missing' || phase === 'too-old') return tray('!', null, 'claude-swap needs setup');
    if (phase === 'no-accounts') return tray('', null, 'No accounts in claude-swap yet');
    if (phase === 'error') return tray('!', null, `claude-swap: ${(state.error && state.error.message) || 'error'}`);
    const active = (state.accounts || []).find((a) => a.active);
    if (!active) return tray('–', null, 'No active account');
    const { usage, stale } = effectiveUsage(active);
    const parts = [label(active)];
    const read = (name, w) => {
      const p = num(w && w.pct);
      if (p === null) return null;
      if (resetPassed(w, now)) {
        parts.push(`${name} window has reset, waiting for new data`);
        return null;
      }
      parts.push(`${name} ${Math.round(p)}%${w.aheadOfPace === true ? ' (ahead of pace)' : ''}`);
      return p;
    };
    const five = read('5h', usage && usage.fiveHour);
    const seven = read('7d', usage && usage.sevenDay);
    // phase 'ok' with an error: the last refresh failed and this list is older.
    const failing = Boolean(state.error);
    if (failing) {
      const t = Date.parse(state.fetchedAt);
      parts.push(Number.isFinite(t) ? `not updated for ${formatDuration(Math.max(0, now - t) / 1000)}` : 'not updated');
    }
    if (stale) parts.push('stale');
    const aged = agedSeconds(active);
    if (aged !== null) parts.push(`${formatDuration(aged)} old`);

    const highest = (...ps) => ps.filter((p) => p !== null).reduce((m, p) => (m === null || p > m ? p : m), null);
    const pct = (p) => (p === null ? '–' : `${Math.round(p)}%`);
    let text;
    let ring;
    let hot;
    if (mode === '7d') [text, ring, hot] = [pct(seven), seven, seven];
    else if (mode === 'both') [text, ring, hot] = [`${pct(five)} · ${pct(seven)}`, five, highest(five, seven)];
    else if (mode === 'max') [text, ring, hot] = [pct(highest(five, seven)), highest(five, seven), highest(five, seven)];
    else if (mode === 'off') [text, ring, hot] = ['', five, five];
    else [text, ring, hot] = [pct(five), five, five];
    if (text && /\d/.test(text) && (failing || stale)) text += '?';
    const title = [showName ? shortName(active) : '', text].filter(Boolean).join(' ');
    return { title, pct: ring, level: level(hot), tooltip: parts.join(' · ') };
  }

  function tray(title, pct, tooltip) {
    return { title, pct, level: level(pct), tooltip };
  }

  return {
    WARN,
    CRIT,
    AGED_AFTER_S,
    level,
    effectiveUsage,
    formatDuration,
    secondsUntil,
    resetPassed,
    agedSeconds,
    paceNote,
    badges,
    label,
    shortName,
    menuLabel,
    orgLabel,
    trayInfo,
  };
});
