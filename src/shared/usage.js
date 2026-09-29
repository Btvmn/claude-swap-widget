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
    return out;
  }

  function label(row) {
    return row.alias || row.email || `Account ${row.number}`;
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

  // Menu-bar summary: the active account's 5h usage. The tray is what people
  // glance at without opening anything, so doubtful numbers say so: a "?"
  // after the % when the list could not be refreshed or only last-good data
  // is left, and no number at all once the 5h window has rolled over.
  function trayInfo(state, now = Date.now()) {
    const phase = state && state.phase;
    if (!phase || phase === 'loading') return tray('', null, 'Claude accounts — loading…');
    if (phase === 'missing' || phase === 'too-old') return tray('!', null, 'claude-swap needs setup');
    if (phase === 'no-accounts') return tray('', null, 'No accounts in claude-swap yet');
    if (phase === 'error') return tray('!', null, `claude-swap: ${(state.error && state.error.message) || 'error'}`);
    const active = (state.accounts || []).find((a) => a.active);
    if (!active) return tray('–', null, 'No active account');
    const { usage, stale } = effectiveUsage(active);
    const fiveWindow = usage && usage.fiveHour;
    let five = num(fiveWindow && fiveWindow.pct);
    const seven = num(usage && usage.sevenDay && usage.sevenDay.pct);
    const parts = [label(active)];
    if (five !== null && resetPassed(fiveWindow, now)) {
      five = null;
      parts.push('5h window has reset, waiting for new data');
    } else if (five !== null) {
      parts.push(`5h ${Math.round(five)}%`);
    }
    if (seven !== null) parts.push(`7d ${Math.round(seven)}%`);
    // phase 'ok' with an error: the last refresh failed and this list is older.
    const failing = Boolean(state.error);
    if (failing) {
      const t = Date.parse(state.fetchedAt);
      parts.push(Number.isFinite(t) ? `not updated for ${formatDuration(Math.max(0, now - t) / 1000)}` : 'not updated');
    }
    if (stale) parts.push('stale');
    const aged = agedSeconds(active);
    if (aged !== null) parts.push(`${formatDuration(aged)} old`);
    const title = five === null ? '–' : `${Math.round(five)}%${failing || stale ? '?' : ''}`;
    return tray(title, five, parts.join(' · '));
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
    badges,
    label,
    orgLabel,
    trayInfo,
  };
});
