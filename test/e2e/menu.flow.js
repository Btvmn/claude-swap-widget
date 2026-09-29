'use strict';
// The "⋯" menu and the tray's right-click menu (one builder, PLAN §4.4):
// account lines, actions, Statistics, Settings with its submenus, About, and
// the add / remove / log items, which only show a command or reveal a file
// and never run cswap themselves. The whole menu is also compared with the
// snapshot test/e2e/menu.en.txt (settings.flow.js does menu.ru.txt).

const fs = require('fs');
const path = require('path');

const TOP = [
  'Switch to Next',
  'Switch to Best',
  'Next Available',
  '──',
  'Disable / Enable Account',
  'Add Account…',
  'Remove Account',
  'Open cswap Log',
  'Statistics…',
  '──',
  'Settings',
  'About Claude Swap Widget',
  'Refresh Now',
  'Quit',
];
const SETTINGS = [
  'Language',
  'Appearance',
  'Menu Bar',
  'Rings',
  'Time',
  'Weekly Reset Date',
  'Refresh Every',
  'Notifications',
  'Keep Usage History',
  'Clear Usage History…',
  'Window',
  'Open at Login',
  '──',
  'Choose cswap Binary…',
  'Use cswap from PATH',
];
const labels = (menu) => menu.items.map((i) => (i.type === 'separator' ? '──' : i.label));
const ticked = (menu) => menu.items.filter((i) => i.checked).map((i) => i.label);
const item = (t, menu, spec) => t.find(menu, spec) || {};

// The menu as text, for the snapshots. Each account line is cut after
// "N  name": the rest holds countdowns and words that usage.js translates.
function menuText(t, menu, accounts) {
  const lines = t.dumpMenu(menu).split('\n');
  accounts.forEach((a, i) => {
    const head = `${a.number}  ${a.alias || a.email}`;
    if (lines[i] && lines[i].slice(2).startsWith(head)) lines[i] = `${lines[i].slice(0, 2)}${head}  …`;
  });
  return `${lines.join('\n')}\n`;
}

// Compares with test/e2e/<name>. The actual text is always written to the
// flow's artifacts; to accept a deliberate change, copy it over the snapshot.
function matchSnapshot(t, name, actual) {
  const file = path.join(__dirname, name);
  const saved = path.join(t.out, name);
  fs.writeFileSync(saved, actual);
  let expected = null;
  try {
    expected = fs.readFileSync(file, 'utf8');
  } catch {}
  const msg = `the menu matches the snapshot test/e2e/${name}`;
  if (actual === expected) return t.ok(true, msg);
  if (expected === null) return t.fail(msg, `no snapshot yet; review ${saved} and copy it to ${file}`);
  const a = actual.split('\n');
  const e = expected.split('\n');
  const n = a.findIndex((line, i) => line !== e[i]);
  return t.fail(msg, `line ${n + 1}: expected ${JSON.stringify(e[n])}, got ${JSON.stringify(a[n])} (whole menu: ${saved})`);
}

module.exports = {
  description: 'the ⋯ and tray menus: accounts, actions, Settings and its submenus, copy-command dialogs',
  menuText,
  matchSnapshot,
  async run(t) {
    const m = await t.menu();
    const state = await t.state();
    t.log(`menu:\n${t.dumpMenu(m)}`);
    matchSnapshot(t, 'menu.en.txt', menuText(t, m, state.accounts));

    t.section('account lines');
    const accounts = m.items.slice(0, 5);
    t.equal(
      accounts.map((i) => i.label.split('  ').slice(0, 2).join('  ')),
      ['1  work', '2  bob@example.com', '3  carol@example.com', '4  dave@example.com', '5  erin@example.com'],
      'one line per account, numbered, alias before email',
    );
    t.equal(accounts.map((i) => i.checked), [true, false, false, false, false], 'only the active account is ticked');
    t.ok(accounts.every((i) => i.type === 'checkbox' && i.enabled), 'account lines are enabled checkboxes');
    t.match(accounts[0].label, /  5h 20% \(\d.*\) · 7d 34% \(\d/, 'alice: 5h and 7d with countdowns');
    t.match(accounts[2].label, /7d 88% \(ahead\).* · Fable 76% \(ahead\)/, 'carol: pace note and the Fable window');
    t.match(accounts[3].label, /5h 42%.*  — token expired, stale$/, 'dave: last-good numbers, token expired, stale');
    t.match(accounts[4].label, /  — disabled$/, 'erin: disabled');

    t.section('top level');
    t.equal(labels(m).slice(5), ['──', ...TOP], 'actions, account tools, Statistics, Settings, About, Refresh, Quit in this order');
    for (const name of ['Switch to Next', 'Switch to Best', 'Next Available', 'Refresh Now', 'Statistics…', 'About Claude Swap Widget']) {
      t.ok(item(t, m, name).enabled, `${name} is enabled`);
    }
    t.equal(item(t, m, 'Quit').role, 'quit', 'Quit is the quit role');

    const toggles = item(t, m, ['Disable / Enable Account']).submenu;
    t.equal(labels(toggles), ['1  work', '2  bob@example.com', '3  carol@example.com', '4  dave@example.com', '5  erin@example.com'], 'Disable / Enable lists every account');
    t.equal(toggles.items.map((i) => i.checked), [true, true, true, true, false], 'ticked = in rotation (erin is disabled)');
    const removes = item(t, m, ['Remove Account']).submenu;
    t.equal(labels(removes), ['1  work…', '2  bob@example.com…', '3  carol@example.com…', '4  dave@example.com…', '5  erin@example.com…'], 'Remove Account lists every account');

    t.section('Settings');
    const settings = item(t, m, ['Settings']).submenu;
    t.equal(labels(settings), SETTINGS, 'Settings items in this order');
    const sub = (...p) => (item(t, settings, p).submenu || { items: [] });
    t.equal(labels(sub('Language')), ['System', 'English', 'Русский', 'Українська', 'Deutsch'], 'languages, each in its own language');
    t.equal(ticked(sub('Language')), ['System'], 'System is the default language');
    t.equal(labels(sub('Appearance')), ['System', 'Light', 'Dark'], 'three appearances');
    t.equal(labels(sub('Menu Bar')), ['Style', 'Percentage', 'Show Account Name'], 'Menu Bar: style, percentage, account name');
    t.equal(labels(sub('Menu Bar', 'Style')), ['Classic', 'Ring and Numbers', 'Two Bars', 'Double Ring', 'Double Ring and Numbers'], 'five menu-bar styles');
    t.equal(ticked(sub('Menu Bar', 'Style')), ['Classic'], 'the flows run on the classic style (pre-seeded)');
    t.equal(labels(sub('Menu Bar', 'Percentage')), ['Session (5h)', 'Weekly (7d)', 'Both (5h · 7d)', 'Highest', 'None'], 'five menu-bar percentage modes');
    t.equal(ticked(sub('Menu Bar', 'Percentage')), ['Session (5h)'], '5h is the default mode');
    t.equal(item(t, settings, ['Menu Bar', 'Percentage']).enabled, true, 'Percentage applies to the classic style');
    t.equal(item(t, settings, ['Menu Bar', 'Show Account Name']).checked, false, 'account name off by default');
    t.equal(labels(sub('Rings')), ['Side by Side', 'Ring in Ring'], 'two ring layouts');
    t.equal(ticked(sub('Rings')), ['Side by Side'], 'side by side by default');
    t.equal(labels(sub('Time')), ['System', '12-hour (3:59 PM)', '24-hour (15:59)'], 'three clocks');
    t.equal(ticked(sub('Time')), ['System'], 'the system clock by default');
    t.equal(labels(sub('Weekly Reset Date')), ['Oct 2', 'Fri, Oct 2', 'Fri, Oct 2, 3:59 PM'], 'date formats shown as samples (en-US)');
    t.equal(ticked(sub('Weekly Reset Date')), ['Oct 2'], 'the date alone by default');
    t.equal(labels(sub('Refresh Every')), ['30 seconds', '1 minute', '2 minutes', '5 minutes'], 'four refresh intervals');
    t.equal(ticked(sub('Refresh Every')), ['1 minute'], '1 minute is the default interval');
    t.equal(item(t, settings, ['Notifications']).checked, true, 'notifications on by default');
    t.equal(item(t, settings, ['Keep Usage History']).checked, true, 'history kept by default');
    t.equal(labels(sub('Window')), ['Menu Bar Popover', 'Desktop Widget', '──', 'Keep Widget on Top'], 'two window modes, then on-top');
    t.equal(ticked(sub('Window')), ['Menu Bar Popover', 'Keep Widget on Top'], 'the popover by default; on-top preset for the widget');
    t.equal(item(t, settings, ['Window', 'Keep Widget on Top']).enabled, false, 'on-top is for the widget only');
    t.equal(item(t, settings, ['Open at Login']).visible, false, 'Open at Login is hidden when unpackaged');
    t.equal(item(t, settings, ['Use cswap from PATH']).visible, false, 'Use cswap from PATH is hidden without an override');

    t.section('tray right-click');
    const tm = await t.trayMenu();
    t.equal(t.normalize(t.dumpMenu(tm)), t.normalize(t.dumpMenu(m)), 'the tray menu is the same menu');

    t.section('Add Account… shows the command');
    const calls = t.mark();
    t.answer('Copy Command');
    t.click(await t.menu(), 'Add Account…');
    const add = await t.waitFor(() => t.dialogs.find((d) => d.message === 'Add an account'), 'the add dialog');
    t.match(add.detail, /\n\n {4}cswap add$/, 'the dialog shows `cswap add`');
    t.equal(add.buttons, ['Copy Command', 'Close'], 'Copy Command or Close');
    await t.waitFor(() => t.clipboard.length, 'the clipboard');
    t.equal(t.clipboard[t.clipboard.length - 1], 'cswap add', 'Copy Command puts `cswap add` on the clipboard');

    t.section('Remove Account › bob shows the command');
    t.answer('Close');
    t.click(await t.menu(), ['Remove Account', '2  bob@example.com…']);
    const remove = await t.waitFor(() => t.dialogs.find((d) => d.message === 'Remove Account-2'), 'the remove dialog');
    t.match(remove.detail, /forgets bob@example\.com.*\n\n {4}cswap remove 2$/s, 'the dialog names bob and shows `cswap remove 2`');
    await t.wait(100);
    t.equal(t.clipboard.length, 1, 'Close copies nothing');
    t.answer('Copy Command');
    t.click(await t.menu(), ['Remove Account', '2  bob@example.com…']);
    await t.waitFor(() => t.clipboard.length === 2, 'the clipboard');
    t.equal(t.clipboard[1], 'cswap remove 2', 'Copy Command puts `cswap remove 2` on the clipboard');
    t.equal(t.calls(calls).filter((c) => /^(add|remove)\b/.test(c)), [], 'add and remove never run cswap');

    t.section('Open cswap Log only reveals it');
    const before = t.shellCalls.length + t.dialogs.length;
    t.click(await t.menu(), 'Open cswap Log');
    await t.waitFor(() => t.shellCalls.length + t.dialogs.length > before, 'Finder or a dialog');
    const revealed = t.shellCalls.slice(-1)[0];
    t.ok(
      (revealed && /claude-swap/.test(revealed.arg)) || t.dialogs.some((d) => d.message === 'No claude-swap log yet'),
      'the log (or its folder) is revealed, or a dialog says there is none',
    );

    t.section('Refresh Now');
    const beforeRefresh = t.mark();
    t.click(await t.menu(), 'Refresh Now');
    await t.idle();
    t.equal(t.calls(beforeRefresh), ['list --json'], 'Refresh Now runs one `cswap list`');

    t.section('Choose cswap Binary… (cancelled)');
    t.click(await t.menu(), ['Settings', 'Choose cswap Binary…']);
    const panel = await t.waitFor(() => t.dialogs.find((d) => d.kind === 'open'), 'the file panel');
    t.equal([panel.message, panel.detail], ['Choose the cswap executable', 'Usually ~/.local/bin/cswap (uv or pipx) or /opt/homebrew/bin/cswap'], 'the panel says what to pick');
    await t.idle();
    t.equal((t.settings() || {}).cswapPath ?? null, null, 'a cancelled panel keeps cswap on the default search');
    t.equal((await t.state()).phase, 'ok', 'the app still works');

    t.section('Refresh Every and Appearance persist');
    t.click(await t.menu(), ['Settings', 'Refresh Every', '2 minutes']);
    await t.waitFor(() => (t.settings() || {}).refreshSeconds === 120, 'refreshSeconds 120');
    t.equal(t.settings().refreshSeconds, 120, '2 minutes is saved');
    t.equal(item(t, await t.menu(), ['Settings', 'Refresh Every', '2 minutes']).checked, true, 'and ticked in the menu');
    t.click(await t.menu(), ['Settings', 'Appearance', 'Dark']);
    await t.waitFor(() => (t.settings() || {}).theme === 'dark', 'theme dark');
    t.equal(t.electron.nativeTheme.themeSource, 'dark', 'Dark applies to the app');
    t.click(await t.menu(), ['Settings', 'Appearance', 'System']);
    await t.waitFor(() => (t.settings() || {}).theme === 'system', 'theme system');
    t.equal(t.electron.nativeTheme.themeSource, 'system', 'System follows macOS again');
    await t.snap('accounts');
  },
};
