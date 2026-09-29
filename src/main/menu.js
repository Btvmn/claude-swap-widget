'use strict';
// The one menu behind the tray's right click and the popover's "⋯" button
// (PLAN §4.4), and the actions it starts: switching, disabling, the
// copy-a-command dialogs for add/remove, the cswap log, choosing the cswap
// binary, the statistics and the About panel. Every label goes through ctx.t,
// and the menu is built on every open, so a language change needs no rebuild.
// The account part follows claude-swap's own menu bar app, so both feel alike.
//
// Settings are saved through ctx.saveAndApply; the modules that care react to
// the ctx.bus events that follow (settings-ipc.js). The menu itself only emits
// 'refresh:manual' and 'history:clear'.

const { Menu, nativeTheme, dialog, clipboard, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');
const settingsLists = require('../settings');
const { menuLabel } = require('../shared/usage');
const { LANGUAGES, formatDay } = require('../shared/i18n');
const { isExecutable, cswapLogPath } = require('../cswap');

const { THEMES, TITLE_MODES, REFRESH_CHOICES, LANGUAGE_PREFS, GAUGE_STYLES, TIME_FORMATS, WEEKLY_DATE_FORMATS, WINDOW_MODES } = settingsLists;
const TRAY_STYLE_KEYS = { classic: 'tray.classic', ring: 'tray.ring', bars: 'tray.bars', rings: 'tray.rings', ringsText: 'tray.ringsText' };
const GAUGE_KEYS = { rings: 'rings.side', concentric: 'rings.nested' };
const TIME_KEYS = { system: 'time.system', '12h': 'time.12', '24h': 'time.24' };
const WINDOW_KEYS = { popover: 'set.window.popover', widget: 'set.window.widget' };
// Weekly Reset Date shows each format on this date, written the way the
// current language and clock write it. A fixed day, so the labels (and the
// e2e snapshots) do not change with the calendar.
const SAMPLE_DAY = new Date(2026, 9, 2, 15, 59); // Fri, Oct 2, 15:59 local time
// cswap switch `reason`s we have words for (I18N §6.5); any other shows cswap's message.
const REASONS = new Set([
  'already-active',
  'activated',
  'already-best',
  'candidates-exhausted',
  'no-valid-target',
  'only-one-account',
  'unmanaged-account',
  'usage-unavailable',
]);
// service.js throws this one for a switch or disable whose account left the list.
const ACCOUNT_GONE = 'That account is no longer in claude-swap; the list has been refreshed';

let ctx = null;

function attach(context) {
  ctx = context;
}

const identity = (a) => ({ email: a.email, organizationUuid: a.organizationUuid || '' });
const shortLabel = (a) => a.alias || a.email;

// Built fresh on every open, so it always shows the current state, settings and language.
function buildMenu() {
  const { service, t } = ctx;
  const state = service.state;
  const accounts = state.phase === 'ok' ? state.accounts : [];
  const now = Date.now();
  const busy = Boolean(state.switching);
  const switchable = accounts.filter((a) => !a.disabled).length > 1;
  const strategy = (s) => () => runAction(() => service.switchTo({ strategy: s }), 'switch');

  const accountItems = accounts.map((a) => ({
    label: menuLabel(a, now, t),
    type: 'checkbox',
    checked: Boolean(a.active),
    enabled: !busy,
    // An explicit switch works for disabled accounts too (they only leave auto-rotation).
    click: () => (a.active ? ctx.updateTray(service.state) : runAction(() => service.switchTo(identity(a)), 'switch', { email: a.email })),
  }));

  return Menu.buildFromTemplate([
    ...accountItems,
    ...(accountItems.length ? [{ type: 'separator' }] : []),
    { label: t('menu.next'), enabled: switchable && !busy, click: strategy('rotate') },
    { label: t('menu.best'), enabled: switchable && !busy, click: strategy('best') },
    { label: t('menu.nextAvailable'), enabled: switchable && !busy, click: strategy('next-available') },
    { type: 'separator' },
    {
      label: t('menu.toggleAccount'),
      enabled: accounts.length > 0,
      submenu: accounts.map((a) => ({
        label: `${a.number}  ${shortLabel(a)}`,
        type: 'checkbox',
        // Ticked = in rotation, as in claude-swap's own menu.
        checked: !a.disabled,
        click: () => runAction(() => service.setDisabled(identity(a), !a.disabled), a.disabled ? 'enable' : 'disable', { name: shortLabel(a) }),
      })),
    },
    { label: t('menu.add'), click: () => showAddCommand() },
    {
      label: t('menu.remove'),
      enabled: accounts.length > 0,
      submenu: accounts.map((a) => ({ label: `${a.number}  ${shortLabel(a)}…`, click: () => showRemoveCommand(a) })),
    },
    { label: t('menu.log'), click: () => openCswapLog() },
    { label: t('menu.stats'), click: () => openStats() },
    { type: 'separator' },
    { label: t('settings.title'), submenu: settingsMenu() },
    { label: t('menu.about', { app: pkg.productName }), click: () => ctx.showAbout() },
    {
      label: t('menu.refreshNow'),
      click: () => {
        ctx.bus.emit('refresh:manual');
        service.refresh();
      },
    },
    { label: t('menu.quit'), role: 'quit' },
  ]);
}

function settingsMenu() {
  const { t, app } = ctx;
  const s = ctx.getSettings();
  const { locale, hour12 } = ctx.getLanguage();
  const save = (patch) => () => ctx.saveAndApply(patch);
  const radios = (values, key, labelOf) => values.map((v) => ({ label: labelOf(v), type: 'radio', checked: s[key] === v, click: save({ [key]: v }) }));
  const toggle = (label, key, extra = {}) => ({ label, type: 'checkbox', checked: s[key], click: (item) => ctx.saveAndApply({ [key]: item.checked }), ...extra });
  const trayStyles = settingsLists.trayStylesFor(process.platform);
  const langName = (code) => (code === 'system' ? t('lang.system') : (LANGUAGES.find((l) => l.code === code) || { name: code }).name);

  return [
    // Language names stay in their own language, so anyone can find theirs.
    { label: t('settings.language'), submenu: radios(LANGUAGE_PREFS, 'language', langName) },
    {
      label: t('settings.theme'),
      // Ticks what applies (CSW_THEME may override the saved choice).
      submenu: THEMES.map((th) => ({ label: t(`theme.${th}`), type: 'radio', checked: nativeTheme.themeSource === th, click: () => ctx.setTheme(th) })),
    },
    {
      label: t('settings.menuBar'),
      submenu: [
        // Template pictures are macOS only; elsewhere 'classic' is all there is.
        { label: t('set.menuBar.style'), visible: trayStyles.length > 1, submenu: radios(trayStyles, 'trayStyle', (v) => t(TRAY_STYLE_KEYS[v])) },
        // Only the classic ring has a text title; the pictures carry their own digits.
        { label: t('set.menuBar.percentage'), enabled: s.trayStyle === 'classic', submenu: radios(TITLE_MODES, 'titleMode', (m) => t(`set.titleMode.${m}`)) },
        toggle(t('set.menuBar.showName'), 'showName'),
      ],
    },
    { label: t('settings.rings'), submenu: radios(GAUGE_STYLES, 'gaugeStyle', (v) => t(GAUGE_KEYS[v])) },
    { label: t('settings.time'), submenu: radios(TIME_FORMATS, 'timeFormat', (v) => t(TIME_KEYS[v])) },
    { label: t('settings.date'), submenu: radios(WEEKLY_DATE_FORMATS, 'weeklyDateFormat', (f) => formatDay(locale, SAMPLE_DAY, f, hour12)) },
    { label: t('settings.refresh'), submenu: radios(REFRESH_CHOICES, 'refreshSeconds', (sec) => t(`refresh.${sec}`)) },
    toggle(t('settings.alerts'), 'notifications'),
    toggle(t('set.recordHistory'), 'recordHistory'),
    { label: t('set.clearHistory'), click: () => confirmClearHistory() },
    {
      label: t('set.window'),
      submenu: [
        ...radios(WINDOW_MODES, 'windowMode', (m) => t(WINDOW_KEYS[m])),
        { type: 'separator' },
        toggle(t('set.window.onTop'), 'widgetOnTop', { enabled: s.windowMode === 'widget' }),
      ],
    },
    {
      // Unpackaged, this would register the bare Electron binary as the login item.
      label: t('set.launch'),
      type: 'checkbox',
      visible: process.platform !== 'linux' && app.isPackaged,
      checked: loginChecked(),
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: t('set.chooseBinary'), click: () => chooseBinary() },
    { label: t('act.usePath'), visible: Boolean(s.cswapPath), click: () => ctx.setCswapPath(null) },
  ];
}

function loginChecked() {
  const login = ctx.app.getLoginItemSettings();
  return login.openAtLogin || login.status === 'requires-approval';
}

// ── actions ──────────────────────────────────────────────────────────────────

// "Account-3" when cswap's ref has no email (it always has one today).
function refName(ref) {
  if (!ref) return '';
  return ref.email || (ref.number != null ? `Account-${ref.number}` : '');
}

// The toast for cswap's switch payload. `reason` maps to our words; cswap's
// own message goes along as the detail, and is shown as is for a reason we
// do not know. Warnings (e.g. "restart Claude Code") are cswap's words and
// follow untranslated, as in the popover.
function switchToast(result, clickedEmail) {
  const { t } = ctx;
  const to = refName(result.to);
  const from = refName(result.from);
  const known = REASONS.has(result.reason);
  let text;
  if (result.switched) {
    text = result.reason === 'activated' ? t('reason.activated', { name: to }) : t('toast.switchedTo', { name: to });
  } else if (known) {
    // No switch: {name} is the account that stays active.
    text = t(`reason.${result.reason}`, { name: from || to });
  } else {
    text = result.message || t('toast.noSwitch');
  }
  // An account line switches by identity; cswap may have landed elsewhere if
  // the list changed under the menu.
  const unexpected = Boolean(result.switched && clickedEmail && result.to && result.to.email && result.to.email !== clickedEmail);
  if (unexpected) text = t('toast.listChanged', { message: text });
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((w) => typeof w === 'string' && w) : [];
  if (warnings.length) text += ` — ${warnings.join(' ')}`;
  const message = typeof result.message === 'string' ? result.message : '';
  return { text, error: unexpected, detail: message && !text.startsWith(message) ? message : '' };
}

// What went wrong, in the UI language where we know the case (`kind`, or one
// of our own messages); cswap's own words (a JSON error, a stderr line) are
// shown as they are, since only cswap knows them. `detail` is the raw message.
function errorText(err) {
  const { t } = ctx;
  const raw = String((err && err.message) || '');
  const kind = err && err.kind;
  let text = raw || t('toast.actionFailed');
  if (raw === ACCOUNT_GONE) text = t('err.accountGone');
  else if (kind === 'not-installed') text = t('err.notAvailable');
  else if (kind === 'too-old') text = t('setup.tooOld.title');
  else if (kind === 'timeout') text = t('err.timeout');
  else if (kind === 'bad-output') text = t('err.badOutput');
  else if (kind === 'schema') text = t('err.schema', { v: (/schemaVersion (\S+)/.exec(raw) || [])[1] || '?' });
  else if (kind === 'cli' && err.signal) text = t('err.stopped', { signal: err.signal });
  else if (kind === 'cli' && err.spawnError) text = t('err.spawn', { code: err.spawnError });
  else if (kind === 'cli' && !err.errorType && /^cswap exited with code \d+$/.test(raw)) text = t('err.exitCode', { code: err.exitCode });
  return { text, detail: text === raw ? '' : raw };
}

// Menu actions report back through a toast in the popover; when the popover
// is hidden, a failure gets a dialog so it is not lost. Successes need no
// dialog: the tray already shows the new state.
//   what: 'switch' (opts.email = the account line clicked, if any),
//         'disable' / 'enable' (opts.name = the account's alias or email)
async function runAction(fn, what, opts = {}) {
  const { t } = ctx;
  try {
    const result = await fn();
    if (what === 'switch' && result) {
      const r = switchToast(result, opts.email);
      toast(r.text, r.error, r.detail);
    } else if (what === 'disable' || what === 'enable') {
      toast(t(what === 'disable' ? 'toast.disabled' : 'toast.enabled', { name: opts.name || '' }));
    }
    return result;
  } catch (err) {
    const e = errorText(err);
    toast(e.text, true, e.detail);
    if (!ctx.uiAlive() || !ctx.getWin().isVisible()) {
      dialog.showMessageBox({ type: 'error', message: t('toast.actionFailed'), detail: [e.text, e.detail].filter(Boolean).join('\n\n') });
    }
    return null;
  }
}

// `detail` (optional) is the raw cswap text behind a translated `text`, for
// a tooltip; the page shows `text`.
function toast(text, error = false, detail = '') {
  if (!ctx.uiAlive()) return;
  const payload = { text: String(text || ''), error: Boolean(error) };
  if (detail) payload.detail = String(detail);
  ctx.send('ui:toast', payload);
}

// Add and remove stay in claude-swap's hands: they can prompt, and remove
// cannot be undone. We show the command and offer to copy it.
async function showCommand(title, detail, command) {
  const { t } = ctx;
  ctx.setKeepOpen(true);
  try {
    const r = await dialog.showMessageBox({
      type: 'info',
      message: title,
      detail: `${detail}\n\n    ${command}`,
      buttons: [t('dlg.copyCommand'), t('btn.close')],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) clipboard.writeText(command);
  } finally {
    ctx.setKeepOpen(false);
  }
}

function showAddCommand() {
  const { t } = ctx;
  return showCommand(t('dlg.add.title'), t('dlg.add.detail'), 'cswap add');
}

// `account`: a row of the current list ({ number, email }).
function showRemoveCommand(account) {
  const { t } = ctx;
  return showCommand(t('dlg.remove.title', { n: account.number }), t('dlg.remove.detail', { email: account.email }), `cswap remove ${account.number}`);
}

function openCswapLog() {
  const file = cswapLogPath();
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else if (fs.existsSync(path.dirname(file))) shell.openPath(path.dirname(file));
  else dialog.showMessageBox({ type: 'info', message: ctx.t('dlg.noLog'), detail: file });
}

// Shows the UI on the statistics view; `account` ({ email, organizationUuid })
// picks whose, else the page follows the active account.
function openStats(account) {
  ctx.showUi();
  const msg = { view: 'stats' };
  if (account && typeof account.email === 'string') Object.assign(msg, { email: account.email, organizationUuid: account.organizationUuid || '' });
  ctx.send('ui:open', msg);
}

// Asks first: the history cannot be restored. The history module does the
// clearing ('history:clear'); without one there is nothing to report.
async function confirmClearHistory() {
  const { t } = ctx;
  ctx.setKeepOpen(true);
  let r;
  try {
    r = await dialog.showMessageBox({
      type: 'warning',
      message: t('dlg.clearHistory.title'),
      detail: t('dlg.clearHistory.detail'),
      buttons: [t('dlg.clearHistory.confirm'), t('btn.cancel')],
      defaultId: 1,
      cancelId: 1,
    });
  } finally {
    ctx.setKeepOpen(false);
  }
  if (r.response !== 0) return false;
  try {
    if (ctx.bus.emit('history:clear')) toast(t('toast.historyCleared'));
    return true;
  } catch (err) {
    toast(err.message, true);
    if (!ctx.uiAlive() || !ctx.getWin().isVisible()) {
      dialog.showMessageBox({ type: 'error', message: t('toast.actionFailed'), detail: String(err.message) });
    }
    return false;
  }
}

// The cswap binary override, from the menu or the setup screen. keepOpen
// covers only the dialogs; the reconnect afterwards may wait behind a running
// cswap call and must not make the chooser look busy.
async function chooseBinary() {
  const { app, service, t } = ctx;
  if (ctx.isKeepOpen()) {
    // A panel is already open; if the app was hidden (Cmd+H), bring it back.
    if (process.platform === 'darwin') app.show();
    return service.state;
  }
  ctx.setKeepOpen(true);
  let picked = null;
  try {
    const r = await dialog.showOpenDialog({
      title: t('dlg.chooseTitle'),
      message: t('dlg.chooseHint'),
      defaultPath: path.join(app.getPath('home'), '.local', 'bin'),
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    });
    picked = (!r.canceled && r.filePaths[0]) || null;
    if (picked && !isExecutable(picked)) {
      await dialog.showMessageBox({ type: 'error', message: t('dlg.notExecutable'), detail: picked });
      picked = null;
    }
  } finally {
    ctx.setKeepOpen(false);
  }
  return picked ? ctx.setCswapPath(picked) : service.state;
}

module.exports = {
  attach,
  buildMenu,
  runAction,
  toast,
  showCommand,
  showAddCommand,
  showRemoveCommand,
  openCswapLog,
  openStats,
  chooseBinary,
  switchToast,
  errorText,
};
