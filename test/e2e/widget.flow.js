'use strict';
// Window modes (PLAN §2.2, P2.6): the popover and the desktop widget.
//
// Starts as the popover, switches to the widget from the tray menu, checks
// what each mode does on blur, Escape, Cmd+W, close(), a tray click and a
// second instance, that a move of the widget is saved 300 ms later (and our
// own placements are not), and that a height change keeps its corner. Two
// real extra Electron processes take part:
//   - `electron <app>` on this flow's userData: its single-instance lock fails,
//     so this app gets 'second-instance' and must show the widget;
//   - a second run of this flow file (E2E_WIDGET_PHASE=restore) on a copy of
//     the settings.json saved here: the widget must come up, unfocused, where
//     it was left, and movable.
// Showing the widget focuses it, as a user's tray click would.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PHASE = process.env.E2E_WIDGET_PHASE === 'restore' ? 'restore' : 'main';
const WIDTH = 360;
const SAVE_MS = 300;
const TO_WIDGET = ['Settings', 'Window', 'Desktop Widget'];
const TO_POPOVER = ['Settings', 'Window', 'Menu Bar Popover'];
const ON_TOP = ['Settings', 'Window', 'Keep Widget on Top'];

const pos = (w) => {
  const [x, y] = w.getPosition();
  return { x, y };
};
// Dev builds hide the dock icon at start; turning all-workspaces off without
// skipTransformProcessType would bring it back.
const dockHidden = (t) => !t.electron.app.dock || !t.electron.app.dock.isVisible();

// The env of an extra Electron process: nothing of this run's switches or
// state, only what it is given.
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CSW_|FAKE_CSWAP_|E2E_)/.test(k) || k === 'CSWAP_PATH' || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  }
  return { ...env, ...extra };
}

// Runs an Electron child to its end; kills it after `timeout` ms. macOS asks
// "reopen windows?" in a modal alert at launch once Electron was killed a few
// times, and waits for an answer: the argument tells AppKit not to restore.
function runChild(args, env, logFile, timeout) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile);
    const argv = process.platform === 'darwin' ? [...args, '-ApplePersistenceIgnoreState', 'YES'] : args;
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const started = Date.now();
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, killed, ms: Date.now() - started });
    });
  });
}

async function runMain(t) {
  const win = t.win;
  const { screen } = t.electron;

  t.section('popover (the default)');
  t.ok((t.settings() || {}).windowMode !== 'widget', 'settings.json does not ask for the widget');
  t.equal(win.isMovable(), false, 'the popover is not movable');
  t.equal(win.isAlwaysOnTop(), true, 'and always on top');
  win.emit('blur');
  await t.expect(() => win.isVisible(), false, 'blur hides the popover');

  t.section('tray menu › Window › Desktop Widget');
  const menu = await t.trayMenu();
  t.equal(t.find(menu, TO_POPOVER).checked, true, 'Menu Bar Popover is ticked');
  t.click(menu, TO_WIDGET);
  await t.waitFor(() => win.isVisible(), 'the widget to show');
  t.equal((t.settings() || {}).windowMode, 'widget', 'saved as windowMode "widget"');
  t.equal(win.isMovable(), true, 'the widget is movable (setMovable at runtime)');
  t.equal(win.isAlwaysOnTop(), true, 'on top (Keep Widget on Top defaults to on)');
  if (process.platform === 'darwin') t.equal(win.isVisibleOnAllWorkspaces(), true, 'and on every Space');
  t.ok(dockHidden(t), 'no dock icon');
  const tb = t.tray.getBounds();
  const home = screen.getDisplayNearestPoint({ x: tb.x + tb.width / 2, y: tb.y }).workArea;
  const placed = win.getBounds();
  t.equal(placed.x, Math.round(home.x + (home.width - WIDTH) / 2), 'never moved before: centred on the tray\'s display');
  t.ok(placed.y >= home.y && placed.y + placed.height <= home.y + home.height, 'and inside its work area');
  await t.wait(SAVE_MS + 300);
  t.equal((t.settings() || {}).widgetPosition, null, 'our own placement is not saved as the user\'s position');
  t.equal(t.find(await t.menu(), TO_WIDGET).checked, true, 'Desktop Widget is ticked in the ⋯ menu');

  t.section('blur');
  win.emit('blur');
  await t.wait(200);
  t.equal(win.isVisible(), true, 'blur does not hide the widget');

  t.section('Keep Widget on Top');
  t.click(await t.menu(), ON_TOP);
  await t.expect(() => win.isAlwaysOnTop(), false, 'off: not on top');
  if (process.platform === 'darwin') t.equal(win.isVisibleOnAllWorkspaces(), false, 'off: on one Space only');
  t.ok(dockHidden(t), 'still no dock icon');
  t.equal((t.settings() || {}).widgetOnTop, false, 'saved as widgetOnTop false');
  t.click(await t.menu(), ON_TOP);
  await t.expect(() => win.isAlwaysOnTop(), true, 'on again');
  if (process.platform === 'darwin') t.equal(win.isVisibleOnAllWorkspaces(), true, 'on every Space again');
  t.equal(win.isVisible(), true, 'the widget stays visible throughout');

  t.section('a move is saved 300 ms after it rests');
  // At the right of the work area: macOS Stage Manager pushes windows shown
  // in its strip at the left edge out of it (e.g. x 40 → 310).
  const target = { x: home.x + home.width - WIDTH - 40, y: home.y + 60 };
  win.setPosition(target.x, target.y);
  await t.wait(100);
  t.equal((t.settings() || {}).widgetPosition, null, 'not saved while the move may go on');
  await t.expect(() => (t.settings() || {}).widgetPosition, target, 'widgetPosition saved in settings.json', { timeout: 2000 });
  // What a restart would read, for the second run below.
  const savedSettings = t.settings();

  t.section('a height change keeps the corner');
  const before = win.getBounds();
  const h = before.height === 300 ? 320 : 300;
  await t.js((height) => window.api.resize(height), h);
  await t.expect(() => win.getBounds().height, h, 'the new height applies');
  t.equal(pos(win), target, 'the top-left corner stays');
  t.equal((t.settings() || {}).widgetPosition, target, 'and nothing new is saved');
  await t.js((height) => window.api.resize(height), before.height);
  await t.expect(() => win.getBounds().height, before.height, 'and back to the page\'s height');

  t.section('our own moves are not saved');
  const low = { x: target.x, y: home.y + home.height - 200 };
  win.setPosition(low.x, low.y);
  await t.expect(() => (t.settings() || {}).widgetPosition, low, 'moved near the bottom edge: saved', { timeout: 2000 });
  await t.js((height) => window.api.resize(height), 400);
  // The page also sizes the window to its own height while this runs, so the
  // exact y depends on which resize came last; what must hold is that the
  // window moved up and fits the display.
  await t.expect(
    () => {
      const b = win.getBounds();
      return { x: b.x, width: b.width, height: b.height, movedUp: b.y < low.y, fits: b.y >= home.y && b.y + b.height <= home.y + home.height };
    },
    { x: low.x, width: WIDTH, height: 400, movedUp: true, fits: true },
    'a taller page moves it up to fit the display',
  );
  // macOS sends no 'move' for our own setBounds of a shown window; Windows
  // does (WM_MOVE). Send the one it would.
  win.emit('move');
  await t.wait(SAVE_MS + 300);
  t.equal((t.settings() || {}).widgetPosition, low, 'that move is ours, not saved as the user\'s position');
  win.setPosition(target.x, target.y);
  await t.expect(() => (t.settings() || {}).widgetPosition, target, 'moved back up by the user: saved', { timeout: 2000 });
  await t.js((height) => window.api.resize(height), before.height);
  await t.expect(() => win.getBounds(), { ...target, width: WIDTH, height: before.height }, 'the page\'s height at the user\'s corner');

  t.section('Escape, tray click, Cmd+W, close()');
  const hides = () => t.appCalls.filter((c) => c.fn === 'hide').length;
  let appHides = hides();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await t.expect(() => win.isVisible(), false, 'Escape hides the widget');
  if (process.platform === 'darwin') t.ok(hides() > appHides, 'and hands focus back (app.hide)');
  t.trayClick();
  await t.expect(() => win.isVisible(), true, 'a tray click shows it again');
  t.equal(pos(win), target, 'where it was left');
  t.trayClick();
  await t.expect(() => win.isVisible(), false, 'a second tray click hides it');
  t.trayClick();
  await t.expect(() => win.isVisible(), true, 'and a third shows it');
  appHides = hides();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  await t.expect(() => win.isVisible(), false, 'Cmd+W hides the widget');
  if (process.platform === 'darwin') t.ok(hides() > appHides, 'and hands focus back (app.hide)');
  t.trayClick();
  await t.expect(() => win.isVisible(), true, 'shown again');
  win.close();
  await t.wait(100);
  t.equal(win.isDestroyed(), false, 'close() never destroys the window');
  t.equal(win.isVisible(), false, 'it hides it');

  t.section('second instance');
  const second = await runChild(
    [process.env.E2E_APP],
    childEnv({ CSW_USER_DATA: t.userData, CSWAP_PATH: t.fake, FAKE_CSWAP_STATE: path.join(t.out, 'second-instance-fake.json') }),
    path.join(t.out, 'second-instance.log'),
    20_000,
  );
  t.equal({ code: second.code, killed: second.killed }, { code: 0, killed: false }, 'a second instance on the same userData quits at once');
  await t.expect(() => win.isVisible(), true, 'and shows this app\'s widget');
  t.equal(pos(win), target, 'where it was left');
  await t.snap('widget');

  t.section('back to the popover');
  t.click(await t.menu(), TO_POPOVER);
  await t.expect(() => (t.settings() || {}).windowMode, 'popover', 'saved as windowMode "popover"');
  // Hide, re-place and show again; slower when the whole suite runs.
  await t.waitFor(() => win.isVisible(), 'the popover to show', { timeout: 10_000 });
  t.equal(win.isMovable(), false, 'not movable any more');
  t.equal(win.isAlwaysOnTop(), true, 'on top');
  if (process.platform === 'darwin') t.equal(win.isVisibleOnAllWorkspaces(), true, 'on every Space');
  t.ok(dockHidden(t), 'no dock icon');
  // The app's own rule for where the popover belongs (scripts/e2e.js loads
  // this file outside Electron too, so not at the top).
  const placement = require(path.join(process.env.E2E_APP, 'src', 'main', 'placement'));
  const pb = win.getBounds();
  const tb2 = t.tray.getBounds();
  const wa2 = screen.getDisplayNearestPoint(placement.popoverAnchor(tb2, null)).workArea;
  const under = placement.placePopover(tb2, null, wa2, WIDTH, pb.height);
  t.log('tray', tb2, 'popover', pb);
  t.equal({ x: pb.x, y: pb.y }, { x: under.x, y: under.y }, 'under the tray icon again');
  t.equal((t.settings() || {}).widgetPosition, target, 'the widget\'s position is kept for next time');
  // A blur within the first 400 ms after a show is only acted on if the
  // popover really lost the focus (window.js, SHOW_GRACE_MS); the user
  // leaving comes later.
  await t.wait(500);
  win.emit('blur');
  await t.expect(() => win.isVisible(), false, 'blur hides the popover again');

  t.section('a second run restores the widget');
  const dir = path.join(t.out, 'second-run');
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(savedSettings, null, 2));
  const run = await runChild(
    [path.join(__dirname, 'runner.js')],
    childEnv({
      E2E_FLOW: __filename,
      E2E_OUT: dir,
      E2E_APP: process.env.E2E_APP,
      E2E_FAKE: t.fake,
      E2E_WIDGET_PHASE: 'restore',
      E2E_WIDGET_EXPECT: JSON.stringify(target),
      CSWAP_PATH: t.fake,
      CSW_USER_DATA: userData,
      FAKE_CSWAP_STATE: path.join(dir, 'fake-state.json'),
      FAKE_CSWAP_SCENARIO: 'default',
      CSW_LANG: 'en',
    }),
    path.join(dir, 'electron.log'),
    60_000,
  );
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  } catch {}
  if (!result) {
    t.fail('the second run produced a result', `exit ${run.signal || run.code}${run.killed ? ' (killed)' : ''}; see ${path.join(dir, 'electron.log')}`);
    return;
  }
  for (const c of result.checks) t.ok(c.ok, `second run: ${c.msg}${c.ok ? '' : ` — ${c.detail}`}`);
  t.equal(run.code, result.ok ? 0 : 1, 'the second run exited with its result');
}

// The second run: settings.json says widget, at the position the first run saved.
async function runRestore(t) {
  const win = t.win;
  const expected = JSON.parse(process.env.E2E_WIDGET_EXPECT || 'null');
  await t.expect(() => win.isVisible(), true, 'the widget shows at launch without a tray click');
  t.equal(win.isFocused(), false, 'without taking focus');
  t.equal(pos(win), expected, 'at the saved position');
  t.equal(win.isMovable(), true, 'movable');
  t.equal(win.isAlwaysOnTop(), true, 'on top');
  await t.wait(SAVE_MS + 200);
  t.equal((t.settings() || {}).widgetPosition, expected, 'the saved position is left as it was');
  win.emit('blur');
  await t.wait(200);
  t.equal(win.isVisible(), true, 'blur does not hide it');
}

module.exports = {
  description: 'Window modes: popover ↔ desktop widget from the menu; blur, Escape, Cmd+W, tray, second instance; position saved and restored',
  timeout: 120_000,
  // The second run checks that the app shows the widget by itself.
  show: PHASE !== 'restore',
  async run(t) {
    if (PHASE === 'restore') await runRestore(t);
    else await runMain(t);
  },
};
