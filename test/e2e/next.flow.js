'use strict';
// "Switch to Next" rotates through the accounts in slot order with a bare
// `cswap switch`, skipping disabled ones (erin) and wrapping around.

const ROUND = [
  { number: 2, email: 'bob@example.com', title: ' 80%', template: false },
  { number: 3, email: 'carol@example.com', title: ' 95%', template: false },
  { number: 4, email: 'dave@example.com', title: ' 42%?', template: true },
  { number: 1, email: 'alice@example.com', title: ' 20%', template: true },
];

module.exports = {
  description: 'Switch to Next rotates 1 → 2 → 3 → 4 → 1, skipping disabled erin',
  async run(t) {
    for (const step of ROUND) {
      t.section(`next → ${step.email}`);
      const mark = t.mark();
      await t.ui.clearToast();
      t.click(await t.menu(), 'Switch to Next');
      t.equal(await t.ui.waitToast('the switch toast'), `Switched to ${step.email}`, `the toast names ${step.email}`);
      await t.idle();
      t.equal(t.calls(mark)[0], 'switch --json', 'a bare `cswap switch` (rotation)');
      t.equal((await t.state()).activeAccountNumber, step.number, `account ${step.number} is active`);
      await t.expect(() => t.ui.activeNumbers(), [step.number], 'the popover follows');
      await t.expect(t.trayTitle, step.title, `the tray shows${step.title}`);
      await t.expect(() => t.trayImage().template, step.template, step.template ? 'template ring' : 'coloured ring');
    }
    t.equal(t.fakeState().active, 1, 'the fake is back on alice');
  },
};
