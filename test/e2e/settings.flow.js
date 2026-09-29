'use strict';
// Settings between main and the page (settings:get / settings:set /
// settings:changed) and the UI language. Runs with CSW_LANG=ru: the Russian
// menu is compared with test/e2e/menu.ru.txt, toasts and the About panel speak
// Russian, and switching the language from the menu relabels the menu, the
// About panel and reaches the page. The page may write only the view keys;
// everything else, cswapPath above all, is refused and changes nothing.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const I18n = require('../../src/shared/i18n');
const pkg = require('../../package.json');
const { menuText, matchSnapshot } = require('./menu.flow');

const ru = I18n.translator('ru');
const en = I18n.translator('en');
const APP = pkg.productName;
const PUBLIC_KEYS = [
  'danger',
  'gaugeStyle',
  'heroExpanded',
  'hour12',
  'language',
  'languagePref',
  'locale',
  'notifications',
  'recordHistory',
  'statsAccount',
  'statsPeriod',
  'statsStyle',
  'theme',
  'timeFormat',
  'trayStyle',
  'warn',
  'weeklyDateFormat',
  'widgetOnTop',
  'windowMode',
];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o ? o[k] : undefined]));
const labels = (menu) => menu.items.filter((i) => i.visible).map((i) => (i.type === 'separator' ? '──' : i.label));
const ticked = (menu) => menu.items.filter((i) => i.checked).map((i) => i.label);

module.exports = {
  description: 'settings IPC (get / set whitelist / changed), the Russian menu and toasts, switching the language',
  env: { CSW_LANG: 'ru' },
  async run(t) {
    const { app } = t.electron;
    const file = path.join(t.userData, 'settings.json');

    // Spies in main: the About panel, focus stealing, what main sends to the
    // page, and the bus event that asks the history module to clear.
    const about = [];
    const focus = [];
    const sent = [];
    const cleared = [];
    const setAbout = app.setAboutPanelOptions;
    app.setAboutPanelOptions = function (options) {
      about.push(options);
      return setAbout.call(this, options);
    };
    app.focus = (options) => focus.push(options);
    const wc = t.win.webContents;
    const send = wc.send;
    wc.send = function (channel, ...args) {
      sent.push({ channel, payload: args[0] });
      return send.call(this, channel, ...args);
    };
    const emit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function (name, ...args) {
      if (name === 'history:clear') cleared.push(this.listenerCount(name));
      return emit.call(this, name, ...args);
    };
    const toasts = () => sent.filter((s) => s.channel === 'ui:toast').map((s) => s.payload);

    // What the page receives.
    await t.js(() => {
      window.__settings = [];
      window.__open = [];
      window.api.onSettings((s) => window.__settings.push(s));
      window.api.onOpen((o) => window.__open.push(o));
      return true;
    });
    const pushed = () => t.js(() => window.__settings);
    const lastPushed = async () => (await pushed()).slice(-1)[0] || null;

    t.section('the Russian menu (CSW_LANG=ru)');
    const state = await t.state();
    let m = await t.menu();
    t.log(`menu:\n${t.dumpMenu(m)}`);
    matchSnapshot(t, 'menu.ru.txt', menuText(t, m, state.accounts));
    t.equal(
      labels(m).slice(6),
      [ru('menu.next'), ru('menu.best'), ru('menu.nextAvailable'), '──', ru('menu.toggleAccount'), ru('menu.add'), ru('menu.remove'), ru('menu.log'), ru('menu.stats'), '──', ru('settings.title'), ru('menu.about', { app: APP }), ru('menu.refreshNow'), ru('menu.quit')],
      'every top-level label is Russian',
    );
    t.equal(
      labels(t.find(m, [ru('settings.title'), ru('settings.date')]).submenu),
      ['2 окт.', 'пт, 2 окт.', 'пт, 2 окт., 15:59'],
      'the weekly reset samples are written the Russian way',
    );
    t.equal(ticked(t.find(m, [ru('settings.title'), ru('settings.language')]).submenu), [ru('lang.system')], 'the language follows the system (here CSW_LANG)');
    const tipIn = (tr) => () => (t.trayTooltip() || '').includes(`${tr('win.5h')} `);
    await t.expect(tipIn(ru), true, 'the tray tooltip is Russian');

    t.section('settings:get');
    let s = await t.api('getSettings');
    t.equal(Object.keys(s || {}).sort(), PUBLIC_KEYS, 'exactly the public keys: no cswapPath, no widgetPosition');
    t.equal(pick(s, ['language', 'languagePref', 'locale', 'hour12', 'warn', 'danger']), { language: 'ru', languagePref: 'system', locale: 'ru-RU', hour12: false, warn: 75, danger: 90 }, 'main resolved the language, locale and clock');
    t.equal(pick(s, ['trayStyle', 'statsPeriod', 'windowMode', 'notifications']), { trayStyle: 'classic', statsPeriod: 'day', windowMode: 'popover', notifications: true }, 'and the settings as saved');

    t.section('settings:set refuses anything but the view keys');
    const before = fs.readFileSync(file, 'utf8');
    const refused = [
      [{ cswapPath: '/bin/sh' }, 'cswapPath'],
      [{ statsPeriod: 'week', cswapPath: '/bin/sh' }, 'a view key plus cswapPath (all or nothing)'],
      [{ theme: 'dark' }, 'a key the menu owns'],
      [{ language: 'de' }, 'the language'],
      [{ statsPeriod: 'year' }, 'a bad value'],
      ['statsPeriod', 'a string'],
      [null, 'null'],
      [[{ statsPeriod: 'week' }], 'an array'],
    ];
    for (const [patch, what] of refused) t.equal(await t.api('setSettings', patch), { ok: false }, `refused: ${what}`);
    await t.wait(200);
    t.equal(fs.readFileSync(file, 'utf8'), before, 'settings.json is unchanged, byte for byte');
    t.equal((await pushed()).length, 0, 'nothing was announced to the page');
    t.equal(t.electron.nativeTheme.themeSource, 'system', 'the theme did not change');

    t.section('settings:set saves a view key');
    s = await t.api('setSettings', { statsPeriod: 'week' });
    t.equal(pick(s, ['ok', 'statsPeriod', 'language']), { ok: undefined, statsPeriod: 'week', language: 'ru' }, 'the answer is the new public settings');
    t.equal(t.settings().statsPeriod, 'week', 'statsPeriod is saved');
    await t.expect(async () => ((await lastPushed()) || {}).statsPeriod, 'week', 'settings:changed tells the page');
    s = await t.api('setSettings', { statsStyle: 'bars', statsAccount: '0123456789ab', heroExpanded: true });
    t.equal(pick(t.settings(), ['statsStyle', 'statsAccount', 'heroExpanded']), { statsStyle: 'bars', statsAccount: '0123456789ab', heroExpanded: true }, 'several view keys in one patch');
    await t.expect(async () => (await pushed()).length, 2, 'one announcement per save');
    await t.api('setSettings', { statsStyle: 'bars' });
    await t.wait(200);
    t.equal((await pushed()).length, 2, 'a save that changes nothing is not announced');
    t.equal(t.settings().cswapPath ?? null, null, 'cswapPath was never touched');

    t.section('toasts in Russian');
    await t.ui.clearToast();
    t.click(await t.menu(), ru('menu.next'));
    t.equal(await t.ui.waitToast('the switch toast'), ru('toast.switchedTo', { name: 'bob@example.com' }), 'Switch to Next');
    await t.idle();
    await t.ui.clearToast();
    t.click(await t.menu(), ru('menu.best'));
    t.equal(await t.ui.waitToast('the best toast'), ru('toast.switchedTo', { name: 'alice@example.com' }), 'Switch to Best');
    await t.idle();
    await t.ui.clearToast();
    t.click(await t.menu(), ru('menu.best'));
    t.equal(await t.ui.waitToast('the no-op toast'), ru('reason.already-best'), 'a no-op speaks our words for cswap’s reason');
    t.equal(toasts().slice(-1)[0], { text: ru('reason.already-best'), error: false, detail: 'Already on Account-1 (alice@example.com)' }, 'cswap’s own message goes along as the detail');
    await t.idle();
    await t.ui.clearToast();
    t.click(await t.menu(), [ru('menu.toggleAccount'), '3  carol@example.com']);
    t.equal(await t.ui.waitToast('the disable toast'), ru('toast.disabled', { name: 'carol@example.com' }), 'disable names the account');
    await t.idle();
    await t.ui.clearToast();
    t.click(await t.menu(), [ru('menu.toggleAccount'), '3  carol@example.com']);
    t.equal(await t.ui.waitToast('the enable toast'), ru('toast.enabled', { name: 'carol@example.com' }), 'enable names the account');
    await t.idle();
    t.equal((await t.api('switchTo', { email: 42 })).error.message, ru('err.invalidTarget'), 'IPC errors of our own are Russian too');

    t.section('About in Russian');
    t.click(await t.menu(), ru('menu.about', { app: APP }));
    await t.waitFor(() => t.appCalls.some((c) => c.fn === 'showAboutPanel'), 'the About panel');
    const credits = (tr) => `${tr('about.credits')}\n${tr('about.cswap')}`;
    t.equal(
      about.slice(-1)[0],
      { applicationName: APP, applicationVersion: pkg.version, version: pkg.version, copyright: pkg.build.copyright, credits: credits(ru) },
      'name, version from package.json, copyright and Russian credits',
    );
    t.equal(focus, process.platform === 'darwin' ? [{ steal: true }] : [], 'the app comes to the front first (macOS)');

    t.section('Language › English');
    const aboutCalls = about.length;
    t.click(await t.menu(), [ru('settings.title'), ru('settings.language'), 'English']);
    await t.waitFor(() => (t.settings() || {}).language === 'en', 'language en saved');
    await t.expect(
      async () => pick(await lastPushed(), ['language', 'languagePref', 'locale', 'hour12']),
      { language: 'en', languagePref: 'en', locale: 'en-US', hour12: true },
      'settings:changed brings the page the new language, locale and clock',
    );
    t.equal(pick(await t.api('getSettings'), ['language', 'locale']), { language: 'en', locale: 'en-US' }, 'settings:get agrees');
    t.equal(about.length > aboutCalls && about.slice(-1)[0].credits, credits(en), 'the About panel is re-set in English');
    await t.expect(() => tipIn(en)() && !tipIn(ru)(), true, 'the tray tooltip is re-translated at once');
    m = await t.menu();
    t.ok(t.find(m, ['Settings', 'Language', 'English']), 'the menu is English now');
    t.equal(ticked(t.find(m, ['Settings', 'Language']).submenu), ['English'], 'and English is ticked');
    await t.ui.clearToast();
    t.click(m, 'Switch to Next');
    t.equal(await t.ui.waitToast('the switch toast'), 'Switched to bob@example.com', 'toasts follow');
    await t.idle();

    t.section('Time › 24-hour');
    t.click(await t.menu(), ['Settings', 'Time', '24-hour (15:59)']);
    await t.waitFor(() => (t.settings() || {}).timeFormat === '24h', 'timeFormat 24h saved');
    await t.expect(async () => pick(await lastPushed(), ['timeFormat', 'hour12']), { timeFormat: '24h', hour12: false }, 'the page gets the 24-hour clock');
    t.equal(labels(t.find(await t.menu(), ['Settings', 'Weekly Reset Date']).submenu), ['Oct 2', 'Fri, Oct 2', 'Fri, Oct 2, 15:59'], 'the samples follow the clock');
    t.click(await t.menu(), ['Settings', 'Time', 'System']);
    await t.expect(async () => pick(await lastPushed(), ['timeFormat', 'hour12']), { timeFormat: 'system', hour12: true }, 'System gives en-US’s 12-hour clock back');

    t.section('the other settings save and reach the page');
    const cases = [
      [['Settings', 'Rings', 'Ring in Ring'], 'gaugeStyle', 'concentric'],
      [['Settings', 'Weekly Reset Date', 'Fri, Oct 2'], 'weeklyDateFormat', 'date-day'],
      [['Settings', 'Notifications'], 'notifications', false],
      [['Settings', 'Keep Usage History'], 'recordHistory', false],
      [['Settings', 'Menu Bar', 'Style', 'Ring and Numbers'], 'trayStyle', 'ring'],
      [['Settings', 'Window', 'Desktop Widget'], 'windowMode', 'widget'],
      [['Settings', 'Window', 'Keep Widget on Top'], 'widgetOnTop', false],
      [['Settings', 'Window', 'Menu Bar Popover'], 'windowMode', 'popover'],
      [['Settings', 'Menu Bar', 'Style', 'Classic'], 'trayStyle', 'classic'],
    ];
    for (const [where, key, value] of cases) {
      const menu = await t.menu();
      if (key === 'trayStyle') t.equal(t.find(menu, ['Settings', 'Menu Bar', 'Percentage']).enabled, t.settings().trayStyle === 'classic', `Percentage is offered for the classic style only (${t.settings().trayStyle})`);
      if (key === 'widgetOnTop') t.equal(t.find(menu, where).enabled, true, 'Keep Widget on Top is offered in widget mode');
      t.click(menu, where);
      await t.waitFor(() => (t.settings() || {})[key] === value, `${key} ${value} saved`);
      await t.expect(async () => ((await lastPushed()) || {})[key], value, `${where.slice(1).join(' › ')}: ${key} = ${JSON.stringify(value)} saved and announced`);
    }
    const count = (await pushed()).length;
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Show Account Name']);
    await t.waitFor(() => (t.settings() || {}).showName === true, 'showName saved');
    await t.wait(200);
    t.equal((await pushed()).length, count, 'a key the page cannot see is not announced');

    t.section('Clear Usage History…');
    t.answer('Cancel');
    t.click(await t.menu(), ['Settings', 'Clear Usage History…']);
    const ask = await t.waitFor(() => t.dialogs.find((d) => d.message === 'Clear usage history?'), 'the confirmation');
    t.equal([ask.type, ask.buttons], ['warning', ['Clear History', 'Cancel']], 'a warning with Clear History or Cancel');
    await t.wait(100);
    t.equal(cleared, [], 'Cancel clears nothing');
    await t.ui.clearToast();
    t.answer('Clear History');
    t.click(await t.menu(), ['Settings', 'Clear Usage History…']);
    await t.waitFor(() => cleared.length, 'history:clear');
    t.equal(cleared.length, 1, 'confirmed: the history module is asked once');
    if (cleared[0] > 0) t.equal(await t.ui.waitToast('the cleared toast'), 'Usage history cleared', 'and the toast confirms');
    else t.log('no history module listens yet: no toast');

    t.section('Statistics…');
    const shows = [];
    const { show, focus: winFocus } = t.win;
    t.win.show = () => (shows.push('show'), t.win.showInactive()); // never take focus in a test
    t.win.focus = () => {};
    t.click(await t.menu(), 'Statistics…');
    await t.expect(() => t.js(() => window.__open), [{ view: 'stats' }], 'the page is asked to open the statistics');
    t.ok(shows.length && t.win.isVisible(), 'and the window is shown');
    t.win.show = show;
    t.win.focus = winFocus;

    t.section('Language › System');
    t.click(await t.menu(), ['Settings', 'Language', 'System']);
    await t.expect(
      async () => pick(await lastPushed(), ['language', 'languagePref', 'locale', 'hour12']),
      { language: 'ru', languagePref: 'system', locale: 'ru-RU', hour12: false },
      'System resolves to the system language again (CSW_LANG=ru)',
    );
    t.ok(t.find(await t.menu(), [ru('settings.title'), ru('settings.language'), ru('lang.system')]).checked, 'the menu is Russian again');
    t.equal(t.settings().cswapPath ?? null, null, 'cswapPath is still untouched');

    EventEmitter.prototype.emit = emit;
    wc.send = send;
  },
};
