'use strict';
// Small JSON settings file in the app's userData directory.

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  cswapPath: null, // explicit cswap binary; null = search PATH and the usual dirs
  theme: 'system', // system | light | dark
  refreshSeconds: 60,
  showName: false, // put the active account's alias (or email name) in the menu bar
  titleMode: '5h', // which % the menu bar shows: 5h | 7d | both | max | off
});

const THEMES = ['system', 'light', 'dark'];
const TITLE_MODES = ['5h', '7d', 'both', 'max', 'off'];
const REFRESH_CHOICES = [30, 60, 120, 300];
const MIN_REFRESH_S = 30;
const MAX_REFRESH_S = 86_400; // also keeps seconds * 1000 inside setInterval's 32-bit limit

function sanitize(raw) {
  const s = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.cswapPath === 'string' && raw.cswapPath.trim()) s.cswapPath = raw.cswapPath;
    if (THEMES.includes(raw.theme)) s.theme = raw.theme;
    if (typeof raw.showName === 'boolean') s.showName = raw.showName;
    if (TITLE_MODES.includes(raw.titleMode)) s.titleMode = raw.titleMode;
    // cswap caches usage, but `list` can still reach the usage API: keep a floor.
    if (Number.isFinite(raw.refreshSeconds)) {
      s.refreshSeconds = Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, Math.round(raw.refreshSeconds)));
    }
  }
  return s;
}

function settingsFile(dir) {
  return path.join(dir, 'settings.json');
}

function loadSettings(dir) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8')));
  } catch {
    return sanitize(null);
  }
}

// Returns the sanitized settings even when the write fails (read-only or full
// disk): the choice still applies for this session, it just is not remembered.
function saveSettings(dir, settings) {
  const clean = sanitize(settings);
  const file = settingsFile(dir);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    console.error(`settings: cannot write ${file}: ${err.message}`);
  }
  return clean;
}

module.exports = { loadSettings, saveSettings, sanitize, DEFAULTS, THEMES, TITLE_MODES, REFRESH_CHOICES, MIN_REFRESH_S, MAX_REFRESH_S };
