'use strict';
// Menu-bar app: a tray item showing the active account's 5h usage and a
// frameless popover with one card per claude-swap account.
//
// This file is the entry point: the single-instance lock, the app lifecycle,
// the dev switches, the settings, the About panel and the wiring. The parts
// live in src/main/ and reach each other only through the `ctx` built in start():
//   window.js      the popover and its hardening     placement.js  where it opens (pure)
//   tray.js        the menu-bar item                  menu.js       the menu and its actions
//   ipc.js         account/app IPC, fromUi()          capture.js    CSW_CAPTURE
//   settings-ipc.js  settings IPC, applying a change, the UI language
//   history-hook.js, notify.js, account-menu.js   filled in by later steps
//
// Dev switches:
//   CSWAP_PATH=…/fake-cswap   use another cswap binary (see test/fixtures)
//   CSW_THEME=light|dark      force the theme
//   CSW_LANG=en|ru|uk|de      force the UI language (in its default locale: en-US, ru-RU, …);
//                             "System" in Settings ▸ Language then means this language too
//   CSW_CAPTURE=out.png       render once, save a screenshot of the popover, quit
//   CSW_USER_DATA=<dir>       keep settings (and the single-instance lock) in <dir>, so
//                             captures and tests never touch the real ones; ignored when packaged
//   CSW_VIEW=expanded|stats|stats-bars|stats-summary
//                             the view a capture shows, passed to the page in app:info;
//                             ignored when packaged
//   CSW_WINDOW=widget         force the desktop-widget window for a capture (ctx.dev.window);
//                             ignored when packaged

const { app, Menu, nativeTheme, powerMonitor, dialog } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');
const { AccountService } = require('./src/service');
const { loadSettings, saveSettings, THEMES } = require('./src/settings');
const { translator, resolveLanguage, CODES } = require('./src/shared/i18n');
const windowUi = require('./src/main/window');
const trayUi = require('./src/main/tray');
const menu = require('./src/main/menu');
const ipc = require('./src/main/ipc');
const capture = require('./src/main/capture');
const settingsIpc = require('./src/main/settings-ipc');
const historyHook = require('./src/main/history-hook');
const notify = require('./src/main/notify');
const accountMenu = require('./src/main/account-menu');

const DEV = !app.isPackaged;
const CAPTURE = process.env.CSW_CAPTURE || null;
const LANG = CODES.includes(process.env.CSW_LANG) ? process.env.CSW_LANG : null;
const USER_DATA = DEV && process.env.CSW_USER_DATA ? path.resolve(process.env.CSW_USER_DATA) : null;
const CAPTURE_VIEWS = ['expanded', 'stats', 'stats-bars', 'stats-summary'];
const CAPTURE_VIEW = DEV && CAPTURE_VIEWS.includes(process.env.CSW_VIEW) ? process.env.CSW_VIEW : null;
const WINDOW = DEV && process.env.CSW_WINDOW === 'widget' ? 'widget' : null;

let ctx = null;
let service = null;
let settings = null;
let timer = null;
let readyAt = 0;
let quitting = false;

// Before the lock: the lock lives in userData, so a dev instance with its own
// folder runs next to the installed app instead of quitting in its favour.
if (USER_DATA) {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
  } catch {} // reported by userDataProblem() below if it matters
  app.setPath('userData', USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  // The lock also fails when userData cannot be written (e.g. root-owned after
  // a `sudo` run). A real second instance quits silently; this case must not.
  const problem = userDataProblem();
  if (problem) {
    const dir = app.getPath('userData');
    console.error(`single-instance lock failed; userData not writable: ${dir}: ${problem.message}`);
    // No settings yet: the Mac's own language (or CSW_LANG).
    const t = translator(resolveLanguage('system', settingsIpc.languageTags(app, LANG)));
    dialog.showErrorBox(t('dlg.cannotStart'), t('dlg.cannotStart.detail', { dir, problem: problem.code || problem.message }));
  }
  app.quit();
} else {
  app.on('second-instance', () => windowUi.show());
  // macOS: re-opening the running bundle (Spotlight, Launchpad, Finder) does
  // not start a second process; Launch Services sends a reopen, which Electron
  // delivers as 'activate'. Electron also lists first launch among its
  // triggers, so ignore it right after start (e.g. a login-item launch).
  app.on('activate', (_e, hasVisibleWindows) => {
    if (!hasVisibleWindows && Date.now() - readyAt > 2000) windowUi.show();
  });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(timer);
  });
  app.whenReady().then(start);
}

function userDataProblem() {
  const dir = app.getPath('userData');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return null;
  } catch (err) {
    return err;
  }
}

function start() {
  readyAt = Date.now();
  if (process.platform === 'darwin') app.dock?.hide();
  // Electron's default menu would give the popover Reload, DevTools and zoom
  // shortcuts. Keep only Quit/Hide and Edit (copy on the setup screens).
  if (process.platform === 'darwin') {
    const template = [{ role: 'appMenu' }, { role: 'editMenu' }];
    if (!app.isPackaged) template.push({ role: 'viewMenu' });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
  settings = loadSettings(app.getPath('userData'));
  nativeTheme.themeSource = THEMES.includes(process.env.CSW_THEME) ? process.env.CSW_THEME : settings.theme;

  service = new AccountService({ getOverride: () => settings.cswapPath });
  service.on('state', onState);

  ctx = makeContext();
  // First: it resolves the UI language, which every module after it may use.
  settingsIpc.attach(ctx);
  setAboutPanel();
  ctx.bus.on('language', setAboutPanel);
  menu.attach(ctx);
  capture.attach(ctx);
  trayUi.attach(ctx);
  windowUi.attach(ctx);
  ipc.attach(ctx);
  historyHook.attach(ctx);
  notify.attach(ctx);
  accountMenu.attach(ctx);

  service.refresh();
  restartTimer();
  powerMonitor.on('resume', () => service.refresh());
}

// What the modules in src/main/ share. They read it at call time (e.g.
// ctx.getSettings(), ctx.t(key)), never cache what it returns.
//
// ctx.bus is in-process only (these are not IPC channels), emitted by
// settings-ipc.js applySettings() after every save that changed something:
//   'setting:<key>' (next, prev)  one per settings key that changed
//   'language'      (next, prev)  the resolved { language, locale, hour12 } changed
//                                 (language or timeFormat); ctx.t already speaks it
//   'settings'      (next, prev)  once per save, after those
// and by the menu / IPC:
//   'refresh:manual' ()           a deliberate refresh (menu Refresh Now, accounts:refresh),
//                                 emitted before the refresh starts
//   'history:clear'  ()           Clear Usage History… was confirmed; emit() returns
//                                 false when nothing listens
function makeContext() {
  // Like an I18n translator, including t.lang, but always in the current language.
  const t = (key, vars) => settingsIpc.t(key, vars);
  Object.defineProperty(t, 'lang', { enumerable: true, get: () => settingsIpc.current().language });
  return {
    app,
    bus: new EventEmitter(),
    service,
    // The UI language: t(key, vars) in it, and { language, locale, hour12 }
    // for dates and times (locale e.g. 'en-GB', hour12 from timeFormat).
    t,
    getLanguage: () => settingsIpc.current(),
    dev: { capture: CAPTURE, captureView: CAPTURE_VIEW, userData: USER_DATA, lang: LANG, window: WINDOW },
    isQuitting: () => quitting,

    getSettings: () => settings,
    // What the page may see of the settings (settings:get / settings:changed).
    publicSettings: () => settingsIpc.publicView(),
    saveAndApply,
    setTheme,
    setCswapPath,
    restartTimer,

    fromUi: ipc.fromUi,

    getWin: windowUi.getWin,
    forcedWindowMode: windowUi.forced,
    uiAlive: windowUi.alive,
    showUi: windowUi.show,
    hideUi: windowUi.hide,
    toggleUi: windowUi.toggle,
    positionUi: windowUi.position,
    resizeUi: windowUi.resize,
    send: windowUi.send,
    setKeepOpen: windowUi.setKeepOpen,
    isKeepOpen: windowUi.isKeepOpen,

    getTray: trayUi.getTray,
    updateTray: trayUi.update,

    buildMenu: menu.buildMenu,
    runAction: menu.runAction,
    toast: menu.toast,
    showCommand: menu.showCommand,
    showAddCommand: menu.showAddCommand,
    showRemoveCommand: menu.showRemoveCommand,
    openStats: menu.openStats,
    chooseBinary: menu.chooseBinary,
    showAbout,
  };
}

function onState(state) {
  trayUi.update(state);
  windowUi.send('accounts:state', state);
  capture.onState(state);
}

// ── Settings ─────────────────────────────────────────────────────────────────

// Saves the merged settings (sanitised; kept for this session even if the
// file cannot be written), then applies what changed (settings-ipc.js).
function saveAndApply(patch) {
  const prev = settings;
  settings = saveSettings(app.getPath('userData'), { ...settings, ...patch });
  settingsIpc.applySettings(prev, settings);
  return settings;
}

// Also when the saved theme is unchanged: CSW_THEME may have overridden it.
function setTheme(theme) {
  nativeTheme.themeSource = theme;
  saveAndApply({ theme });
}

// Reconnects even when the path is the same: choosing the binary again is
// how to make the app look at it again.
async function setCswapPath(p) {
  saveAndApply({ cswapPath: p });
  return service.reconnect();
}

function restartTimer() {
  clearInterval(timer);
  timer = setInterval(() => service.refresh(), Math.min(settings.refreshSeconds * 1000, 2 ** 31 - 1));
}

// ── About ────────────────────────────────────────────────────────────────────

// The version comes from package.json: under a test harness app.getVersion()
// is Electron's own. The credits follow the UI language.
function aboutOptions() {
  return {
    applicationName: pkg.productName,
    applicationVersion: pkg.version,
    version: pkg.version,
    copyright: pkg.build.copyright,
    credits: `${ctx.t('about.credits')}\n${ctx.t('about.cswap')}`,
  };
}

function setAboutPanel() {
  app.setAboutPanelOptions(aboutOptions());
}

// A menu-bar app is often not the active app when its menu is used, and the
// panel would open behind the frontmost window.
function showAbout() {
  setAboutPanel();
  if (process.platform === 'darwin') app.focus({ steal: true });
  app.showAboutPanel();
}

// A tray app keeps running with its popover hidden.
app.on('window-all-closed', () => {});
