'use strict';
// Today's app on the fake's newer scenarios, switched mid-run (cswap runs
// inherit main's env): noactive, single, nofetchedat and drift. Later steps
// build on these (hero "No active account", history dedupe, notifications).

async function use(t, scenario, fakeState = {}) {
  t.section(`scenario ${scenario}`);
  t.scenario(scenario);
  t.setFakeState(fakeState);
  return t.refresh();
}

module.exports = {
  description: 'fake scenarios noactive, single, nofetchedat and drift on today’s app',
  async run(t) {
    let s = await use(t, 'noactive');
    t.equal([s.phase, s.activeAccountNumber], ['ok', null], 'the list loads with no active account');
    await t.expect(() => t.ui.activeNumbers(), [], 'no card is marked active');
    t.equal((await t.ui.cards()).length, 5, 'all five accounts are listed');
    await t.expect(t.trayTitle, ' –', 'the tray shows a dash');
    await t.expect(t.trayTooltip, 'No active account', 'and says why');
    let m = await t.menu();
    t.equal(m.items.slice(0, 5).map((i) => i.checked), [false, false, false, false, false], 'no menu line is ticked');
    await t.ui.clearToast();
    t.click(m, 'Switch to Best');
    t.equal(await t.ui.waitToast('the no-op toast'), 'The active Claude Code login is not in claude-swap — run cswap add', 'a strategy switch is cswap’s unmanaged-account no-op');
    await t.idle();
    t.equal((await t.state()).activeAccountNumber, null, 'still no active account');
    await t.snap('noactive');

    s = await use(t, 'single');
    t.equal([s.phase, s.activeAccountNumber, s.accounts.length], ['ok', 1, 1], 'one account, active');
    t.equal((await t.ui.cards()).map((c) => c.number), [1], 'one card');
    await t.expect(() => t.ui.footerVisible(), false, 'no best-account footer for a single account');
    m = await t.menu();
    t.equal(['Switch to Next', 'Switch to Best', 'Next Available'].map((n) => t.find(m, n).enabled), [false, false, false], 'nothing to switch to');
    await t.expect(t.trayTitle, ' 20%', 'the tray shows alice');

    s = await use(t, 'nofetchedat');
    t.equal([s.phase, s.error], ['ok', null], 'rows without usageFetchedAt load');
    t.ok(s.accounts.every((a) => !('usageFetchedAt' in a) && !('lastGoodFetchedAt' in a)), 'the fake left the timestamps out');
    t.ok(s.accounts.every((a) => typeof (a.usageAgeSeconds ?? a.lastGoodAgeSeconds) === 'number'), 'the ages are there');
    t.equal((await t.ui.cards()).length, 5, 'all five cards');
    await t.expect(() => t.ui.banner(), '', 'no error banner');

    s = await use(t, 'drift');
    const seen = [s];
    for (let i = 0; i < 2; i++) seen.push(await t.refresh());
    const alice = seen.map((x) => x.accounts.find((a) => a.number === 1));
    t.equal(alice.map((a) => a.usage.fiveHour.pct), [20, 23, 26], 'each list raises alice’s 5h by 3');
    t.equal(alice.map((a) => a.usage.sevenDay.pct), [34, 37, 40], 'and her 7d by 3');
    const at = alice.map((a) => Date.parse(a.usageFetchedAt) / 1000);
    t.equal([at[1] - at[0], at[2] - at[1]], [300, 300], 'usageFetchedAt moves 300 s per list');
    const dave = seen.map((x) => x.accounts.find((a) => a.number === 4).lastGoodFetchedAt);
    t.equal(new Set(dave).size, 1, 'last-good data does not move');
    t.equal((t.fakeState().drift || {}).lists, 3, 'the fake counted three lists');
    await t.expect(t.trayTitle, ' 26%', 'the tray follows');

    await use(t, 'default', { active: 1 });
    await t.expect(t.trayTitle, ' 20%', 'back on the default roster');
  },
};
