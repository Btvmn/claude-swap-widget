'use strict';
// Small JSON settings file in the app's userData directory. Every key is
// validated on load and on save; anything unknown or malformed falls back to
// its default, so a hand-edited or older file can never reach the app as is.
// The key names and value sets of the look-and-feel keys follow Claude Usage
// Widget — The Maestro edition (see LICENSE, "Third-party code"); the code is ours.

const fs = require('fs');
const path = require('path');
const { WARN, CRIT } = require('./shared/usage');

const THEMES = ['system', 'light', 'dark'];
const TITLE_MODES = ['5h', '7d', 'both', 'max', 'off'];
const REFRESH_CHOICES = [30, 60, 120, 300];
const MIN_REFRESH_S = 30;
const MAX_REFRESH_S = 86_400; // also keeps seconds * 1000 inside setInterval's 32-bit limit

const UI_LANGUAGES = ['en', 'ru', 'uk', 'de'];
const LANGUAGE_PREFS = ['system', ...UI_LANGUAGES];
// 'classic' is drawn by main (src/tray-icon.js); the others by the renderer's canvas.
const TRAY_STYLES = ['classic', 'ring', 'bars', 'rings', 'ringsText'];
const GAUGE_STYLES = ['rings', 'concentric'];
const TIME_FORMATS = ['system', '12h', '24h'];
const WEEKLY_DATE_FORMATS = ['date', 'date-day', 'date-day-time'];
const STATS_STYLES = ['line', 'bars', 'summary'];
const STATS_PERIODS = ['day', 'week', 'month'];
const WINDOW_MODES = ['popover', 'widget'];

// The only keys the renderer may write (settings:set). Everything else is
// changed from main's own menu or dialogs; cswapPath decides which binary runs.
const RENDERER_KEYS = Object.freeze(['statsStyle', 'statsPeriod', 'statsAccount', 'heroExpanded']);

const HISTORY_KEY = /^[0-9a-f]{12}$/; // history account key: 12 hex chars of a sha256
const MAX_COORD = 100_000; // far beyond any real display arrangement, well inside int32

// Template images are a macOS concept: elsewhere the tray is always 'classic'.
function trayStylesFor(platform = process.platform) {
  return platform === 'darwin' ? [...TRAY_STYLES] : ['classic'];
}

function defaultTrayStyle(platform = process.platform) {
  return platform === 'darwin' ? 'ring' : 'classic';
}

// For the platform this process runs on; sanitize(null) always equals it.
const DEFAULTS = Object.freeze({
  cswapPath: null, // explicit cswap binary; null = search PATH and the usual dirs
  theme: 'system', // system | light | dark
  refreshSeconds: 60,
  showName: false, // put the active account's alias (or email name) in the menu bar
  titleMode: '5h', // which % the menu bar shows: 5h | 7d | both | max | off ('classic' style only)
  language: 'system', // system | en | ru | uk | de; main resolves 'system'
  trayStyle: defaultTrayStyle(), // classic | ring | bars | rings | ringsText
  gaugeStyle: 'rings', // rings (side by side) | concentric (ring in ring)
  timeFormat: 'system', // system | 12h | 24h
  weeklyDateFormat: 'date', // date | date-day | date-day-time
  notifications: true, // threshold alerts for the active account; they never switch
  recordHistory: true, // append usage samples to userData/history for the statistics
  statsStyle: 'line', // line | bars | summary (renderer)
  statsPeriod: 'day', // day | week | month (renderer)
  statsAccount: null, // history key of the account shown; null = follow the active one (renderer)
  heroExpanded: false, // scoped / spend rows under the rings open (renderer)
  windowMode: 'popover', // popover (anchored to the tray) | widget (floating, movable)
  widgetOnTop: true, // widget mode: stay above other windows
  widgetPosition: null, // widget mode: last { x, y } of the window; null = centre it
});

const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const coord = (v) => Number.isInteger(v) && Math.abs(v) <= MAX_COORD;

// One rule per key: the clean value, or undefined when the input is not valid.
const RULES = {
  cswapPath: (v) => (typeof v === 'string' && v.trim() ? v : undefined),
  theme: oneOf(THEMES),
  // cswap caches usage, but `list` can still reach the usage API: keep a floor.
  refreshSeconds: (v) => (Number.isFinite(v) ? Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, Math.round(v))) : undefined),
  showName: bool,
  titleMode: oneOf(TITLE_MODES),
  language: oneOf(LANGUAGE_PREFS),
  trayStyle: oneOf(TRAY_STYLES),
  gaugeStyle: oneOf(GAUGE_STYLES),
  timeFormat: oneOf(TIME_FORMATS),
  weeklyDateFormat: oneOf(WEEKLY_DATE_FORMATS),
  notifications: bool,
  recordHistory: bool,
  statsStyle: oneOf(STATS_STYLES),
  statsPeriod: oneOf(STATS_PERIODS),
  statsAccount: (v) => (v === null || (typeof v === 'string' && HISTORY_KEY.test(v)) ? v : undefined),
  heroExpanded: bool,
  windowMode: oneOf(WINDOW_MODES),
  widgetOnTop: bool,
  // A fresh object: extra fields in the file are dropped, not carried along.
  widgetPosition: (v) => {
    if (v === null) return null;
    if (!v || typeof v !== 'object' || Array.isArray(v) || !coord(v.x) || !coord(v.y)) return undefined;
    return { x: v.x, y: v.y };
  },
};

function sanitize(raw, platform = process.platform) {
  const s = { ...DEFAULTS, trayStyle: defaultTrayStyle(platform) };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(RULES)) {
      const v = RULES[key](raw[key]);
      if (v !== undefined) s[key] = v;
    }
  }
  if (!trayStylesFor(platform).includes(s.trayStyle)) s.trayStyle = defaultTrayStyle(platform);
  return s;
}

// Checks a settings:set patch from the renderer. All or nothing: returns the
// clean patch, or null for anything but a plain object whose every own key is
// in RENDERER_KEYS with a valid value. Invalid values are rejected here rather
// than reset to their defaults, so a bad message cannot wipe a choice.
function rendererPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const proto = Object.getPrototypeOf(patch);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(patch); // symbols and non-enumerables count too
  if (keys.length > RENDERER_KEYS.length) return null; // cheap exit for a flooded object
  const out = {};
  for (const key of keys) {
    if (!RENDERER_KEYS.includes(key)) return null;
    const v = RULES[key](patch[key]);
    if (v === undefined) return null;
    out[key] = v;
  }
  return out;
}

function canonicalLocale(tag) {
  if (typeof tag !== 'string' || !tag || tag.length > 64) return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] || null;
  } catch {
    return null;
  }
}

function localeHour12(locale) {
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h11' || cycle === 'h12';
  } catch {
    return false;
  }
}

const PUBLIC_KEYS = [
  'theme',
  'trayStyle',
  'gaugeStyle',
  'timeFormat',
  'weeklyDateFormat',
  'notifications',
  'recordHistory',
  'statsStyle',
  'statsPeriod',
  'statsAccount',
  'heroExpanded',
  'windowMode',
  'widgetOnTop',
];

// What the renderer may see (settings:get / settings:changed). A whitelist, so
// cswapPath, widgetPosition and any key added later stay in main unless listed.
// `resolved` is main's decision { language, locale, hour12 } for 'system' prefs;
// when it is missing or malformed the result still has usable values.
function publicSettings(settings, resolved, platform = process.platform) {
  const s = sanitize(settings, platform);
  const r = resolved && typeof resolved === 'object' ? resolved : {};
  let language = s.language === 'system' ? 'en' : s.language;
  if (UI_LANGUAGES.includes(r.language)) language = r.language;
  const locale = canonicalLocale(r.locale) || language;
  // An explicit 12h / 24h choice wins; 'system' takes main's answer, else the locale's.
  let hour12;
  if (s.timeFormat === '12h') hour12 = true;
  else if (s.timeFormat === '24h') hour12 = false;
  else hour12 = typeof r.hour12 === 'boolean' ? r.hour12 : localeHour12(locale);
  const out = { language, languagePref: s.language, locale, hour12 };
  for (const key of PUBLIC_KEYS) out[key] = s[key];
  out.warn = WARN;
  out.danger = CRIT;
  return out;
}

function settingsFile(dir) {
  return path.join(dir, 'settings.json');
}

function loadSettings(dir, platform = process.platform) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8')), platform);
  } catch {
    return sanitize(null, platform);
  }
}

// Returns the sanitized settings even when the write fails (read-only or full
// disk): the choice still applies for this session, it just is not remembered.
function saveSettings(dir, settings, platform = process.platform) {
  const clean = sanitize(settings, platform);
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

module.exports = {
  loadSettings,
  saveSettings,
  sanitize,
  rendererPatch,
  publicSettings,
  trayStylesFor,
  defaultTrayStyle,
  DEFAULTS,
  RENDERER_KEYS,
  THEMES,
  TITLE_MODES,
  REFRESH_CHOICES,
  MIN_REFRESH_S,
  MAX_REFRESH_S,
  LANGUAGE_PREFS,
  UI_LANGUAGES,
  TRAY_STYLES,
  GAUGE_STYLES,
  TIME_FORMATS,
  WEEKLY_DATE_FORMATS,
  STATS_STYLES,
  STATS_PERIODS,
  WINDOW_MODES,
};
