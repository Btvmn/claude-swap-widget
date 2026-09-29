'use strict';
// "Switch to best account": the popover's footer button (renderer) and the
// menu item (main) both run `cswap switch --strategy best`. The fake picks the
// enabled account with the most headroom: alice.

module.exports = {
  description: 'Switch to best account (footer and menu), including the already-best no-op',
  fakeState: { active: 3 }, // carol, 95 % / 88 %
  async run(t) {
    t.section('start on carol');
    t.equal((await t.state()).activeAccountNumber, 3, 'carol is active');
    await t.expect(t.trayTitle, ' 95%', 'the tray shows 95 %');
    await t.expect(() => t.trayImage().template, false, 'at 95 % the ring is red, not a template');
    t.ok(await t.ui.footerVisible(), 'the footer with the best button is shown');
    t.equal(t.notifications, [], 'a launch on a hot account does not notify');

    t.section('footer button');
    let mark = t.mark();
    await t.ui.clearToast();
    await t.ui.clickBest();
    t.equal(await t.ui.waitToast('the best toast'), 'Switched to work', 'the toast names the account by its alias');
    await t.idle();
    t.includes(t.calls(mark), 'switch --strategy best --json', 'cswap chose with --strategy best');
    t.equal((await t.state()).activeAccountNumber, 1, 'alice is active');
    await t.expect(() => t.ui.activeNumbers(), [1], 'the popover marks alice active');
    await t.expect(t.trayTitle, ' 20%', 'the tray shows 20 %');
    await t.expect(() => t.trayImage().template, true, 'and a template ring again');

    t.section('already the best');
    mark = t.mark();
    await t.ui.clearToast();
    await t.ui.clickBest();
    // cswap's reason is shown in the UI language (reason.already-best); its own
    // English message stays available as the toast's tooltip.
    t.equal(await t.ui.waitToast('the no-op toast'), 'Already on the account with the most headroom', 'the no-op reason says nothing changed');
    await t.idle();
    t.includes(t.calls(mark), 'switch --strategy best --json', 'cswap was still asked');
    t.equal((await t.state()).activeAccountNumber, 1, 'alice stays active');

    t.section('menu item, from bob');
    await t.ui.clearToast();
    await t.ui.clickSwitch(2);
    await t.ui.waitToast('the switch toast');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, 2, 'bob is active');
    await t.ui.clearToast();
    mark = t.mark();
    t.click(await t.menu(), 'Switch to Best');
    t.equal(await t.ui.waitToast('the best toast'), 'Switched to alice@example.com', 'the menu’s toast names alice');
    await t.idle();
    t.equal(t.calls(mark), ['switch --strategy best --json', 'list --json'], 'one switch, then a refresh');
    t.equal((await t.state()).activeAccountNumber, 1, 'alice is active again');
  },
};
