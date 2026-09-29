'use strict';
// The menu-bar title: Settings › Menu Bar › Percentage and Show Account Name.
// Starts from a pre-seeded settings.json (titleMode "both") to prove it loads,
// then walks every mode and checks the title, the ring's colour mode and the
// saved setting.

const MODES = [
  { label: 'Session (5h)', mode: '5h' },
  { label: 'Weekly (7d)', mode: '7d' },
  { label: 'Highest', mode: 'max' },
  { label: 'None', mode: 'off' },
  { label: 'Both (5h · 7d)', mode: 'both' },
];

// Expected title and template flag per account and mode.
const EXPECT = {
  alice: { '5h': [' 20%', true], '7d': [' 34%', true], max: [' 34%', true], off: ['', true], both: [' 20% · 34%', true] },
  bob: { '5h': [' 80%', false], '7d': [' 61%', true], max: [' 80%', false], off: ['', false], both: [' 80% · 61%', false] },
  dave: { '5h': [' 42%?', true], '7d': [' 50%?', true], max: [' 50%?', true], off: ['', true], both: [' 42% · 50%?', true] },
};

async function walk(t, who) {
  for (const { label, mode } of MODES) {
    const [title, template] = EXPECT[who][mode];
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Percentage', label]);
    await t.expect(t.trayTitle, title, `${who}, ${label}: title ${JSON.stringify(title)}`);
    await t.expect(() => t.trayImage().template, template, `${who}, ${label}: ${template ? 'template' : 'coloured'} ring`);
    t.equal((t.settings() || {}).titleMode, mode, `${who}, ${label}: saved as ${mode}`);
  }
}

module.exports = {
  description: 'Menu Bar › Percentage modes and Show Account Name; loaded from and saved to settings.json',
  settings: { titleMode: 'both' },
  async run(t) {
    t.section('loaded from settings.json');
    await t.expect(t.trayTitle, ' 20% · 34%', 'the pre-seeded mode "both" applies at start');
    const radios = t.find(await t.menu(), ['Settings', 'Menu Bar', 'Percentage']).submenu.items;
    t.equal(radios.filter((i) => i.checked).map((i) => i.label), ['Both (5h · 7d)'], 'and is ticked in the menu');

    t.section('alice (20 / 34)');
    await walk(t, 'alice');

    t.section('Show Account Name');
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Show Account Name']);
    await t.expect(t.trayTitle, ' work 20% · 34%', 'the alias goes before the numbers');
    t.equal((t.settings() || {}).showName, true, 'saved');
    t.equal(t.find(await t.menu(), ['Settings', 'Menu Bar', 'Show Account Name']).checked, true, 'ticked in the menu');
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Percentage', 'None']);
    await t.expect(t.trayTitle, ' work', 'with None only the name is left');
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Percentage', 'Both (5h · 7d)']);
    t.click(await t.menu(), ['Settings', 'Menu Bar', 'Show Account Name']);
    await t.expect(t.trayTitle, ' 20% · 34%', 'unticked, the name goes away');
    t.equal((t.settings() || {}).showName, false, 'saved');

    t.section('bob (80 / 61)');
    await t.ui.clearToast();
    await t.ui.clickSwitch(2);
    await t.ui.waitToast('the switch toast');
    await t.idle();
    await walk(t, 'bob');

    t.section('dave (stale 42 / 50)');
    await t.ui.clearToast();
    await t.ui.clickSwitch(4);
    await t.ui.waitToast('the switch toast');
    await t.idle();
    await walk(t, 'dave');
  },
};
