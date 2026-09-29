'use strict';
// Menu-bar app: a tray item showing the active account's 5h usage and a
// frameless popover with one card per claude-swap account.
//
// Dev switches:
//   CSWAP_PATH=…/fake-cswap   use another cswap binary (see test/fixtures)
//   CSW_THEME=light|dark      force the theme
//   CSW_CAPTURE=out.png       render once, save a screenshot of the popover, quit

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, screen, shell, dialog, powerMonitor, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { AccountService } = require('./src/service');
const { loadSettings, saveSettings, THEMES, TITLE_MODES, REFRESH_CHOICES } = require('./src/settings');
const { trayInfo, menuLabel } = require('./src/shared/usage');
const { trayImage } = require('./src/tray-icon');
const { isExecutable, cswapLogPath } = require('./src/cswap');

const WIDTH = 360;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 640;
const REFRESH_ON_OPEN_AFTER_S = 20;
const DOCS_URL = 'https://github.com/realiti4/claude-swap#installation';
const CAPTURE = process.env.CSW_CAPTURE || null;

let tray = null;
let win = null;
let service = null;
let settings = null;
let timer = null;
let keepOpen = false; // set while a native dialog is up, so blur does not hide the popover
let hiddenAt = 0;
let readyAt = 0;
let quitting = false;
let wantedHeight = MIN_HEIGHT; // the renderer's natural height; clamped to the display when placed
let crashTimes = [];

if (!app.requestSingleInstanceLock()) {
  // The lock also fails when userData cannot be written (e.g. root-owned after
  // a `sudo` run). A real second instance quits silently; this case must not.
  const problem = userDataProblem();
  if (problem) {
    const dir = app.getPath('userData');
    console.error(`single-instance lock failed; userData not writable: ${dir}: ${problem.message}`);
    dialog.showErrorBox(
      'Claude accounts cannot start',
      `The settings folder is not writable:\n${dir}\n\n${problem.code || problem.message}\n\nFix its ownership (for example: sudo chown -R "$USER" "${dir}") and start the app again.`,
    );
  }
  app.quit();
} else {
  app.on('second-instance', () => showPopover());
  // macOS: re-opening the running bundle (Spotlight, Launchpad, Finder) does
  // not start a second process; Launch Services sends a reopen, which Electron
  // delivers as 'activate'. Electron also lists first launch among its
  // triggers, so ignore it right after start (e.g. a login-item launch).
  app.on('activate', (_e, hasVisibleWindows) => {
    if (!hasVisibleWindows && Date.now() - readyAt > 2000) showPopover();
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

  createTray();
  createWindow();
  registerIpc();

  service.refresh();
  restartTimer();
  powerMonitor.on('resume', () => service.refresh());
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(ev, () => {
      if (popoverAlive() && win.isVisible()) positionPopover();
    });
  }
}

function onState(state) {
  updateTray(state);
  if (win && !win.isDestroyed()) win.webContents.send('accounts:state', state);
  if (CAPTURE && state.phase !== 'loading' && !state.refreshing) scheduleCapture();
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(trayImage(nativeImage, null, 'none'));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', togglePopover);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  updateTray(service.state);
}

function updateTray(state) {
  if (!tray || tray.isDestroyed()) return;
  const info = trayInfo(state, Date.now(), { mode: settings.titleMode, showName: settings.showName });
  tray.setImage(trayImage(nativeImage, info.pct, info.level));
  if (process.platform === 'darwin') {
    tray.setTitle(info.title ? ` ${info.title}` : '', { fontType: 'monospacedDigit' });
  }
  tray.setToolTip(info.tooltip);
}

const TITLE_LABELS = { '5h': 'Session (5h)', '7d': 'Weekly (7d)', both: 'Both (5h · 7d)', max: 'Highest', off: 'None' };
const REFRESH_LABELS = { 30: '30 seconds', 60: '1 minute', 120: '2 minutes', 300: '5 minutes' };

// The same menu serves the tray's right click and the popover's "⋯" button.
// Layout follows claude-swap's own menu bar app, so both feel alike.
function buildMenu() {
  const state = service.state;
  const accounts = state.phase === 'ok' ? state.accounts : [];
  const identity = (a) => ({ email: a.email, organizationUuid: a.organizationUuid || '' });
  const now = Date.now();
  const busy = Boolean(state.switching);
  const switchable = accounts.filter((a) => !a.disabled).length > 1;

  const accountItems = accounts.map((a) => ({
    label: menuLabel(a, now),
    type: 'checkbox',
    checked: Boolean(a.active),
    enabled: !busy,
    // An explicit switch works for disabled accounts too (they only leave auto-rotation).
    click: () => (a.active ? updateTray(service.state) : runAction(() => service.switchTo(identity(a)), 'switch')),
  }));

  return Menu.buildFromTemplate([
    ...accountItems,
    ...(accountItems.length ? [{ type: 'separator' }] : []),
    { label: 'Switch to Next', enabled: switchable && !busy, click: () => runAction(() => service.switchTo({ strategy: 'rotate' }), 'switch') },
    { label: 'Switch to Best', enabled: switchable && !busy, click: () => runAction(() => service.switchTo({ strategy: 'best' }), 'switch') },
    {
      label: 'Next Available',
      enabled: switchable && !busy,
      click: () => runAction(() => service.switchTo({ strategy: 'next-available' }), 'switch'),
    },
    { type: 'separator' },
    {
      label: 'Disable / Enable Account',
      enabled: accounts.length > 0,
      submenu: accounts.map((a) => ({
        label: `${a.number}  ${a.alias || a.email}`,
        type: 'checkbox',
        // Ticked = in rotation, as in claude-swap's own menu.
        checked: !a.disabled,
        click: () => runAction(() => service.setDisabled(identity(a), !a.disabled), a.disabled ? 'enable' : 'disable'),
      })),
    },
    { label: 'Add Account…', click: () => showCommand('Add an account', 'Log in to Claude Code with the account, then run this in Terminal:', 'cswap add') },
    {
      label: 'Remove Account',
      enabled: accounts.length > 0,
      submenu: accounts.map((a) => ({
        label: `${a.number}  ${a.alias || a.email}…`,
        click: () =>
          showCommand(
            `Remove Account-${a.number}`,
            `claude-swap asks for confirmation before it forgets ${a.email}. Run this in Terminal:`,
            `cswap remove ${a.number}`,
          ),
      })),
    },
    { label: 'Open cswap Log', click: () => openCswapLog() },
    { type: 'separator' },
    {
      label: 'Settings',
      submenu: [
        { label: 'Show Account Name in Menu Bar', type: 'checkbox', checked: settings.showName, click: (item) => saveAndApply({ showName: item.checked }) },
        {
          label: 'Menu Bar Percentage',
          submenu: TITLE_MODES.map((m) => ({ label: TITLE_LABELS[m], type: 'radio', checked: settings.titleMode === m, click: () => saveAndApply({ titleMode: m }) })),
        },
        {
          label: 'Refresh Every',
          submenu: REFRESH_CHOICES.map((sec) => ({
            label: REFRESH_LABELS[sec],
            type: 'radio',
            checked: settings.refreshSeconds === sec,
            click: () => saveAndApply({ refreshSeconds: sec }),
          })),
        },
        {
          label: 'Appearance',
          submenu: THEMES.map((t) => ({ label: t[0].toUpperCase() + t.slice(1), type: 'radio', checked: nativeTheme.themeSource === t, click: () => setTheme(t) })),
        },
        {
          // Unpackaged, this would register the bare Electron binary as the login item.
          label: 'Open at Login',
          type: 'checkbox',
          visible: process.platform !== 'linux' && app.isPackaged,
          checked: loginChecked(),
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { label: 'Choose cswap Binary…', click: () => chooseBinary() },
        { label: 'Use cswap from PATH', visible: Boolean(settings.cswapPath), click: () => setCswapPath(null) },
      ],
    },
    { label: 'Refresh Now', click: () => service.refresh() },
    { label: 'Quit', role: 'quit' },
  ]);
}

function loginChecked() {
  const login = app.getLoginItemSettings();
  return login.openAtLogin || login.status === 'requires-approval';
}

function saveAndApply(patch) {
  const before = settings.refreshSeconds;
  settings = saveSettings(app.getPath('userData'), { ...settings, ...patch });
  if (settings.refreshSeconds !== before) restartTimer();
  updateTray(service.state);
}

function setTheme(theme) {
  nativeTheme.themeSource = theme;
  settings = saveSettings(app.getPath('userData'), { ...settings, theme });
}

// Menu actions report back through a toast in the popover; when the popover
// is hidden, a failure gets a dialog so it is not lost. Successes need no
// dialog: the tray title already shows the new state.
async function runAction(fn, what) {
  try {
    const result = await fn();
    if (what === 'switch' && result) {
      toast(result.switched ? `Switched to ${result.to && result.to.email}` : result.message || 'No switch needed');
    } else if (what === 'disable' || what === 'enable') {
      toast(what === 'disable' ? 'Held out of auto-rotation' : 'Back in the rotation');
    }
    return result;
  } catch (err) {
    toast(err.message, true);
    if (!popoverAlive() || !win.isVisible()) {
      dialog.showMessageBox({ type: 'error', message: 'claude-swap could not do that', detail: err.message });
    }
    return null;
  }
}

function toast(text, error = false) {
  if (popoverAlive()) win.webContents.send('ui:toast', { text: String(text || ''), error: Boolean(error) });
}

// Add and remove stay in claude-swap's hands: they can prompt, and remove
// cannot be undone. We show the command and offer to copy it.
async function showCommand(title, detail, command) {
  keepOpen = true;
  try {
    const r = await dialog.showMessageBox({
      type: 'info',
      message: title,
      detail: `${detail}\n\n    ${command}`,
      buttons: ['Copy Command', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) clipboard.writeText(command);
  } finally {
    keepOpen = false;
  }
}

function openCswapLog() {
  const file = cswapLogPath();
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else if (fs.existsSync(path.dirname(file))) shell.openPath(path.dirname(file));
  else dialog.showMessageBox({ type: 'info', message: 'No claude-swap log yet', detail: file });
}

function restartTimer() {
  clearInterval(timer);
  timer = setInterval(() => service.refresh(), Math.min(settings.refreshSeconds * 1000, 2 ** 31 - 1));
}

// ── Popover ──────────────────────────────────────────────────────────────────

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: WIDTH,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Native blurred material on macOS; elsewhere the page paints its own background.
    ...(mac ? { vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('blur', () => {
    if (!CAPTURE && !keepOpen && !win.webContents.isDevToolsOpened()) win.hide();
  });
  win.on('hide', () => (hiddenAt = Date.now()));
  // Closing (Cmd+W or any other path) would destroy the only window and
  // leave the tray pointing at nothing: hide it instead, except when quitting.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hidePopover();
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !win.webContents.isDevToolsOpened()) {
      e.preventDefault();
      hidePopover();
    }
  });
  if (!app.isPackaged) {
    win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
      console.log(`[renderer:${level}] ${message} (${path.basename(sourceId || '')}:${lineNumber})`);
    });
  }
  // A dead renderer would leave a blank popover for weeks: reload it, unless it keeps crashing.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60_000);
    if (crashTimes.length >= 3) return; // crash loop: showPopover() retries lazily
    crashTimes.push(now);
    setTimeout(() => {
      if (!quitting && popoverAlive() && win.webContents.isCrashed()) win.webContents.reload();
    }, 500);
  });
  win.webContents.on('unresponsive', () => {
    if (popoverAlive()) win.webContents.forcefullyCrashRenderer();
  });
  // Pinch zoom would make the page taller than the window the renderer asked for.
  win.webContents.on('did-finish-load', () => win.webContents.setVisualZoomLevelLimits(1, 1));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function togglePopover() {
  if (!popoverAlive()) return;
  // macOS: the status-bar window cannot become key, so the click arrives with
  // the popover still visible. Windows/Linux: the click blurred it first and
  // that blur already hid it, so the click must not reopen it.
  if (win.isVisible()) hidePopover();
  else if (Date.now() - hiddenAt > 250) showPopover();
}

function popoverAlive() {
  return Boolean(win && !win.isDestroyed() && tray && !tray.isDestroyed());
}

function showPopover() {
  if (!popoverAlive()) return;
  if (win.webContents.isCrashed()) win.webContents.reload();
  positionPopover();
  win.show();
  win.focus();
  if (service.ageSeconds() > REFRESH_ON_OPEN_AFTER_S) service.refresh();
}

// Keyboard dismissal: the popover was the key window of a dock-less app, so
// hand focus back to the app the user came from (blur-driven hides never need this).
// Not while a file panel is open: app.hide() would hide that panel too.
function hidePopover() {
  win.hide();
  if (process.platform === 'darwin' && !keepOpen) app.hide();
}

// Under the tray icon on macOS; above it when the tray sits at the bottom
// (Windows). The height is the renderer's natural height, clamped to the
// display it opens on; beyond that the list scrolls.
function positionPopover() {
  const tb = tray.getBounds();
  // Some Linux trays report an empty rect: anchor at the cursor instead.
  const anchor = tb.width ? { x: tb.x + tb.width / 2, y: tb.y, h: tb.height } : { ...screen.getCursorScreenPoint(), h: 0 };
  const wa = screen.getDisplayNearestPoint(anchor).workArea;
  const width = WIDTH;
  const height = Math.max(MIN_HEIGHT, Math.min(wantedHeight, MAX_HEIGHT, wa.height - 8));
  const below = anchor.y < wa.y + wa.height / 2;
  let x = Math.round(anchor.x - width / 2);
  let y = below ? Math.round(anchor.y + anchor.h + 4) : Math.round(anchor.y - height - 4);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  const b = win.getBounds();
  if (b.x !== x || b.y !== y || b.width !== width || b.height !== height) win.setBounds({ x, y, width, height }, false);
}

// `height` is in CSS px; the window is sized in DIP.
function resizePopover(height) {
  if (!Number.isFinite(height) || !popoverAlive()) return;
  wantedHeight = Math.ceil(height * win.webContents.getZoomFactor());
  positionPopover();
}

// ── cswap binary override ───────────────────────────────────────────────────

// keepOpen covers only the dialogs; the reconnect afterwards may wait behind
// a running cswap call and must not make the chooser look busy.
async function chooseBinary() {
  if (keepOpen) {
    // A panel is already open; if the app was hidden (Cmd+H), bring it back.
    if (process.platform === 'darwin') app.show();
    return service.state;
  }
  keepOpen = true;
  let picked = null;
  try {
    const r = await dialog.showOpenDialog({
      title: 'Choose the cswap executable',
      message: 'Usually ~/.local/bin/cswap (uv or pipx) or /opt/homebrew/bin/cswap',
      defaultPath: path.join(app.getPath('home'), '.local', 'bin'),
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    });
    picked = (!r.canceled && r.filePaths[0]) || null;
    if (picked && !isExecutable(picked)) {
      await dialog.showMessageBox({ type: 'error', message: 'Not an executable file', detail: picked });
      picked = null;
    }
  } finally {
    keepOpen = false;
  }
  return picked ? setCswapPath(picked) : service.state;
}

async function setCswapPath(p) {
  settings = saveSettings(app.getPath('userData'), { ...settings, cswapPath: p });
  return service.reconnect();
}

// ── IPC ──────────────────────────────────────────────────────────────────────

// A strategy, or the identity of a listed account (the service looks its
// current slot number up again right before switching).
function switchTarget(t) {
  if (!t || typeof t !== 'object') return null;
  if (['rotate', 'best', 'next-available'].includes(t.strategy)) return { strategy: t.strategy };
  if (typeof t.email === 'string' && t.email && (t.organizationUuid == null || typeof t.organizationUuid === 'string')) {
    return { email: t.email, organizationUuid: t.organizationUuid || '' };
  }
  return null;
}

function registerIpc() {
  // Only our own page may call in.
  const fromPopover = (e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents);

  ipcMain.handle('app:info', (e) => (fromPopover(e) ? { platform: process.platform, capture: Boolean(CAPTURE) } : null));
  ipcMain.handle('accounts:get', (e) => (fromPopover(e) ? service.state : null));
  ipcMain.handle('accounts:refresh', (e) => (fromPopover(e) ? service.refresh() : null));
  ipcMain.handle('accounts:switch', async (e, target) => {
    if (!fromPopover(e)) return null;
    const t = switchTarget(target);
    if (!t) return { ok: false, error: { kind: 'invalid', message: 'Invalid switch target' } };
    try {
      const result = await service.switchTo(t);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { kind: err.kind || 'unknown', message: err.message, errorType: err.errorType } };
    }
  });
  ipcMain.handle('accounts:set-disabled', async (e, target, disabled) => {
    if (!fromPopover(e)) return null;
    const t = switchTarget(target);
    if (!t || t.strategy || typeof disabled !== 'boolean') return { ok: false, error: { kind: 'invalid', message: 'Invalid account' } };
    try {
      await service.setDisabled(t, disabled);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: { kind: err.kind || 'unknown', message: err.message, errorType: err.errorType } };
    }
  });
  ipcMain.handle('app:recheck', (e) => (fromPopover(e) ? service.reconnect() : null));
  ipcMain.handle('app:choose-binary', (e) => (fromPopover(e) ? chooseBinary() : null));
  ipcMain.handle('app:use-path', (e) => (fromPopover(e) ? setCswapPath(null) : null));
  // Setup screens copy install commands; keep it to short plain text.
  ipcMain.handle('app:copy', (e, text) => {
    if (fromPopover(e) && typeof text === 'string' && text.length <= 200) clipboard.writeText(text);
  });
  ipcMain.on('app:open-docs', (e) => {
    if (fromPopover(e)) shell.openExternal(DOCS_URL);
  });
  ipcMain.on('app:menu', (e) => {
    if (fromPopover(e)) buildMenu().popup({ window: win });
  });
  ipcMain.on('ui:resize', (e, height) => {
    if (fromPopover(e)) resizePopover(Number(height));
  });
}

// ── Dev: screenshot ─────────────────────────────────────────────────────────

let captureTimer = null;
function scheduleCapture() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    positionPopover();
    win.showInactive();
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(CAPTURE, img.toPNG());
    const tray2x = trayImage(nativeImage, trayInfo(service.state).pct, trayInfo(service.state).level);
    fs.writeFileSync(CAPTURE.replace(/\.png$/i, '') + '-tray.png', tray2x.toPNG({ scaleFactor: 2 }));
    console.log(`captured ${CAPTURE}`);
    app.quit();
  }, 700);
}

// A tray app keeps running with its popover hidden.
app.on('window-all-closed', () => {});
