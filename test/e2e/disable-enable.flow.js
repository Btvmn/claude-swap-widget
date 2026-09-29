'use strict';
// Holding an account out of rotation and back: the Disable / Enable submenu
// (`cswap disable|enable N`, plain text, no --json) and the setDisabled IPC.
// Disabled accounts are skipped by Switch to Next; with one enabled account
// left, the switch actions and the footer go away.

const IDS = {
  1: { email: 'alice@example.com', organizationUuid: 'org-acme' },
  2: { email: 'bob@example.com', organizationUuid: 'org-bob' },
  3: { email: 'carol@example.com', organizationUuid: 'org-globex' },
  4: { email: 'dave@example.com', organizationUuid: 'org-dave' },
  5: { email: 'erin@example.com', organizationUuid: 'org-erin' },
};

module.exports = {
  description: 'Disable / Enable from the menu and over IPC; rotation skips disabled accounts',
  async run(t) {
    t.section('disable carol from the menu');
    let mark = t.mark();
    await t.ui.clearToast();
    const item = t.click(await t.menu(), ['Disable / Enable Account', '3  carol@example.com']);
    t.equal(await t.ui.waitToast('the disable toast'), 'carol@example.com is held out of auto-rotation', 'the toast names carol');
    await t.idle();
    t.equal(item.checked, false, 'the clicked item unticks');
    t.equal(t.calls(mark).slice(0, 2), ['list --json', 'disable 3'], 'slot looked up in a fresh list, then `cswap disable 3`');
    t.equal(t.fakeState().disabled, [5, 3], 'the fake holds carol out');
    await t.expect(() => t.ui.disabledNumbers(), [3, 5], 'the popover dims carol');
    t.includes((await t.ui.cards()).find((c) => c.number === 3).badges, 'Disabled', 'with a Disabled badge');
    let m = await t.menu();
    t.match(t.find(m, /^3  carol@example\.com  /).label, /  — disabled$/, 'her menu line says disabled');
    t.equal(t.find(m, ['Disable / Enable Account', '3  carol@example.com']).checked, false, 'and her toggle is unticked');

    t.section('Switch to Next skips carol');
    for (const [number, email] of [
      [2, 'bob@example.com'],
      [4, 'dave@example.com'],
    ]) {
      await t.ui.clearToast();
      t.click(await t.menu(), 'Switch to Next');
      t.equal(await t.ui.waitToast('the switch toast'), `Switched to ${email}`, `next → ${email}`);
      await t.idle();
      t.equal((await t.state()).activeAccountNumber, number, `account ${number} is active`);
    }
    await t.ui.clearToast();
    await t.ui.clickSwitch(1);
    await t.ui.waitToast('the switch toast');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, 1, 'back on alice');

    t.section('enable carol from the menu');
    mark = t.mark();
    await t.ui.clearToast();
    t.click(await t.menu(), ['Disable / Enable Account', '3  carol@example.com']);
    t.equal(await t.ui.waitToast('the enable toast'), 'carol@example.com is back in the rotation', 'the toast names carol');
    await t.idle();
    t.includes(t.calls(mark), 'enable 3', '`cswap enable 3`');
    t.equal(t.fakeState().disabled, [5], 'only erin is held out');
    await t.expect(() => t.ui.disabledNumbers(), [5], 'the popover follows');

    t.section('over IPC');
    mark = t.mark();
    let r = await t.api('setDisabled', IDS[5], false);
    t.equal(r, { ok: true }, 'enabling erin by identity works');
    await t.idle();
    t.includes(t.calls(mark), 'enable 5', '`cswap enable 5`');
    await t.expect(() => t.ui.disabledNumbers(), [], 'nobody is disabled');
    mark = t.mark();
    r = await t.api('setDisabled', { strategy: 'best' }, true);
    t.equal(r && r.ok, false, 'a strategy is not an account');
    r = await t.api('setDisabled', IDS[2], 'yes');
    t.equal(r && r.ok, false, 'the flag must be a boolean');
    r = await t.api('setDisabled', 'bob@example.com', true);
    t.equal(r && r.ok, false, 'a bare string is not an account');
    t.equal(t.calls(mark), [], 'none of them reached cswap');

    t.section('one enabled account left');
    for (const n of [2, 3, 4, 5]) {
      r = await t.api('setDisabled', IDS[n], true);
      t.equal(r, { ok: true }, `account ${n} disabled`);
      await t.idle();
    }
    await t.expect(() => t.ui.disabledNumbers(), [2, 3, 4, 5], 'only alice is enabled');
    await t.expect(() => t.ui.footerVisible(), false, 'the best-account footer is hidden');
    m = await t.menu();
    for (const name of ['Switch to Next', 'Switch to Best', 'Next Available']) {
      t.equal(t.find(m, name).enabled, false, `${name} is disabled`);
    }
    t.ok(m.items.slice(0, 5).every((i) => i.enabled), 'explicit account lines stay enabled');
    await t.snap('only-alice-enabled');
  },
};
