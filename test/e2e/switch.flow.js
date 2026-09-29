'use strict';
// Switching to a named account: from a card's Switch button (renderer →
// accounts:switch) and from an account line in the menu (main). The service,
// the fake cswap, the popover, the tray and the toast all follow. Bad targets
// sent over IPC are refused.

module.exports = {
  description: 'switch to an account from its card and from the menu; bad IPC targets refused',
  async run(t) {
    t.section('start');
    t.equal((await t.state()).activeAccountNumber, 1, 'alice (work) is active');
    await t.expect(() => t.ui.activeNumbers(), [1], 'the popover marks alice active');
    await t.expect(t.trayTitle, ' 20%', 'the tray shows her 5h usage');
    await t.expect(() => t.trayImage().template, true, 'below 75 % the tray ring is a template image');
    t.equal([t.trayImage().width, t.trayImage().height], [18, 18], 'the ring is 18 pt');
    await t.expect(t.trayTooltip, 'work · 5h 20% · 7d 34%', 'the tooltip names her and both windows');
    t.equal((await t.ui.cards()).filter((c) => !c.canSwitch).map((c) => c.number), [1], 'only the active card has no Switch button');

    t.section('Switch on bob’s card');
    let mark = t.mark();
    await t.ui.clearToast();
    t.ok(await t.ui.clickSwitch(2), 'bob’s card has a Switch button');
    t.equal(await t.ui.waitToast('the switch toast'), 'Switched to bob@example.com', 'the toast names bob');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, 2, 'bob is active in main');
    t.equal(t.fakeState().active, 2, 'the fake cswap switched too');
    t.includes(t.calls(mark), 'switch 2 --json', 'by slot number, after a fresh list');
    t.equal(t.calls(mark)[0], 'list --json', 'the slot was looked up in a fresh list first');
    await t.expect(() => t.ui.activeNumbers(), [2], 'the popover marks bob active');
    await t.expect(t.trayTitle, ' 80%', 'the tray shows 80 %');
    await t.expect(() => t.trayImage().template, false, 'at 80 % the ring keeps its amber colour');
    t.match(t.trayTooltip(), /^bob@example\.com · 5h 80% · 7d 61% \(ahead of pace\)$/, 'the tooltip names bob and his pace');
    await t.snap('bob-active');

    t.section('an account line in the menu');
    mark = t.mark();
    await t.ui.clearToast();
    t.click(await t.menu(), /^4  dave@example\.com/);
    t.equal(await t.ui.waitToast('the switch toast'), 'Switched to dave@example.com', 'the toast names dave');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, 4, 'dave is active');
    t.includes(t.calls(mark), 'switch 4 --json', 'cswap switched to slot 4');
    await t.expect(t.trayTitle, ' 42%?', 'his last-good 5h, marked doubtful');
    t.match(t.trayTooltip(), /· stale$/, 'the tooltip says stale');
    const m = await t.menu();
    t.equal(m.items.slice(0, 5).map((i) => i.checked), [false, false, false, true, false], 'the menu ticks dave');

    t.section('a disabled account can still be picked');
    await t.ui.clearToast();
    t.ok(await t.ui.clickSwitch(5), 'erin’s card has a Switch button');
    t.equal(await t.ui.waitToast('the switch toast'), 'Switched to erin@example.com', 'the toast names erin');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, 5, 'erin is active');
    await t.expect(() => t.ui.disabledNumbers(), [5], 'and still disabled');
    await t.expect(t.trayTitle, ' 5%', 'the tray shows 5 %');

    t.section('IPC refuses bad targets');
    mark = t.mark();
    let r = await t.api('switchTo', { strategy: 'evil' });
    t.equal(r && r.ok, false, 'an unknown strategy is refused');
    t.equal(r && r.error && r.error.kind, 'invalid', 'as an invalid target');
    r = await t.api('switchTo', 'bob@example.com');
    t.equal(r && r.ok, false, 'a bare string is refused');
    r = await t.api('switchTo', { email: 42 });
    t.equal(r && r.ok, false, 'a non-string email is refused');
    t.equal(t.calls(mark), [], 'none of them reached cswap');
    r = await t.api('switchTo', { email: 'nobody@example.com', organizationUuid: '' });
    t.equal(r && r.ok, false, 'an account that is not listed is refused');
    t.match(r && r.error && r.error.message, /no longer in claude-swap/, 'with a message that says so');
    await t.idle();
    t.equal(t.calls(mark).filter((c) => c.startsWith('switch')), [], 'cswap switch never ran');
    t.equal((await t.state()).activeAccountNumber, 5, 'erin is still active');
    t.equal(t.notifications, [], 'switching, even to a hot account, never notifies');
  },
};
