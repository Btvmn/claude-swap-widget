'use strict';
// "Next Available" (`cswap switch --strategy next-available`): the next
// enabled account with headroom after the active one, wrapping around. When no
// other account qualifies, cswap answers with a no-op, and the toast gives
// our words for its reason (candidates-exhausted).

module.exports = {
  description: 'Next Available walks 1 → 2 → 3 → 1; with nobody left it is a no-op',
  async run(t) {
    const hops = [
      [2, 'bob@example.com'],
      [3, 'carol@example.com'],
      [1, 'alice@example.com'],
    ];
    for (const [number, email] of hops) {
      t.section(`next available → ${email}`);
      const mark = t.mark();
      await t.ui.clearToast();
      t.click(await t.menu(), 'Next Available');
      t.equal(await t.ui.waitToast('the switch toast'), `Switched to ${email}`, `the toast names ${email}`);
      await t.idle();
      t.equal(t.calls(mark)[0], 'switch --strategy next-available --json', 'cswap chose with --strategy next-available');
      t.equal((await t.state()).activeAccountNumber, number, `account ${number} is active`);
      await t.expect(() => t.ui.activeNumbers(), [number], 'the popover follows');
    }

    t.section('nobody left');
    for (const email of ['bob@example.com', 'carol@example.com']) {
      const r = await t.api('setDisabled', { email, organizationUuid: email === 'bob@example.com' ? 'org-bob' : 'org-globex' }, true);
      t.equal(r, { ok: true }, `${email} disabled over IPC`);
      await t.idle();
    }
    await t.expect(() => t.ui.disabledNumbers(), [2, 3, 5], 'bob, carol and erin are disabled');
    const m = await t.menu();
    t.ok(t.find(m, 'Next Available').enabled, 'Next Available is still offered (alice and dave are enabled)');
    await t.ui.clearToast();
    t.click(m, 'Next Available');
    t.equal(await t.ui.waitToast('the no-op toast'), 'All other accounts are at their limit — staying on alice@example.com', 'the toast explains cswap’s reason');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, 1, 'alice stays active');
    await t.expect(t.trayTitle, ' 20%', 'the tray is unchanged');
  },
};
