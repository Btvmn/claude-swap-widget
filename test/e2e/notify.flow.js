'use strict';
// Threshold notifications (src/main/notify.js, PLAN P2.5) on the real app.
// The drift scenario raises every pct by 3 per list, so alice (work, 20 / 34)
// crosses each threshold in turn: one Notification.show per threshold, none
// at the launch or on a switch to a hot account, "available again" once the
// limit clears, a click shows the popover and switches nothing, and
// Settings ▸ Notifications silences them without replaying anything later.

const TITLE = 'Claude accounts';
const CAROL = { email: 'carol@example.com', organizationUuid: 'org-globex' };

module.exports = {
  description: 'notifications on drift: one per threshold, available again, a click shows the popover, the toggle',
  scenario: 'drift',
  timeout: 120_000,
  async run(t) {
    // Keep the Notification objects too, to click one. The runner's recorder
    // still runs, so nothing reaches Notification Center.
    const { Notification } = t.electron;
    const shown = [];
    const record = Notification.prototype.show;
    Notification.prototype.show = function () {
      shown.push(this);
      return record.call(this);
    };
    const since = (n) => t.notifications.slice(n).map((x) => [x.title, x.body]);
    const pcts = (s, number) => {
      const u = s.accounts.find((a) => a.number === number).usage;
      return [u.fiveHour.pct, u.sevenDay.pct];
    };
    try {
      t.section('launch');
      let s = await t.state();
      t.equal(pcts(s, 1), [20, 34], 'alice starts at 20 / 34');
      t.equal(t.notifications, [], 'the launch says nothing');

      t.section('drift until alice’s 5h window is used up');
      for (let i = 0; i < 40 && pcts(s, 1)[0] < 100; i++) s = await t.refresh();
      t.equal(pcts(s, 1)[0], 100, 'alice’s 5h reached 100 %');
      const got = since(0);
      t.equal(
        got.map(([title]) => title),
        [TITLE, TITLE, TITLE, 'work: weekly limit reached', TITLE],
        'five notifications: one per threshold',
      );
      t.equal(
        got.filter((_, i) => i !== 3).map(([, body]) => body),
        ['work: week at 76% — running low', 'work: session at 77% — running low', 'work: week at 91% — almost out', 'work: session at 92% — almost out'],
        'week warn, session warn, week danger, session danger, in the order crossed',
      );
      t.match(got[3] && got[3][1], /^Resets .+ at \d{1,2}:\d\d( [AP]M)?\.$/, 'the weekly limit names its reset day and time');
      for (let i = 0; i < 2; i++) await t.refresh();
      t.equal(since(got.length), [], 'nothing more while it stays at 100 %');

      t.section('a click on a notification');
      const note = shown[shown.length - 1];
      t.ok(note && note.listenerCount('click') > 0, 'the notification listens for a click');
      if (!note) throw new Error('no notification was shown, so there is nothing to click');
      const w = t.win;
      w.hide();
      await t.expect(() => w.isVisible(), false, 'the popover is hidden');
      // The app's own show() runs; only its show and focus are softened, so
      // no other app loses focus during the run.
      const asked = [];
      w.show = () => (asked.push('show'), w.showInactive());
      w.focus = () => asked.push('focus');
      const mark = t.mark();
      try {
        note.emit('click');
        await t.expect(() => w.isVisible(), true, 'a click shows the popover');
        t.ok(asked.includes('show'), 'through the app’s own show()');
      } finally {
        delete w.show;
        delete w.focus;
      }
      await t.idle();
      t.equal(t.calls(mark).filter((c) => c.startsWith('switch')), [], 'and switches nothing');
      t.equal((await t.state()).activeAccountNumber, 1, 'alice is still active');

      t.section('the limit clears');
      let n0 = t.notifications.length;
      t.scenario('default');
      s = await t.refresh();
      t.equal(pcts(s, 1), [20, 34], 'alice is back at 20 / 34');
      t.equal(since(n0), [[TITLE, 'work is available again']], 'available again');
      await t.refresh();
      t.equal(since(n0).length, 1, 'once');

      t.section('a switch onto a hot account');
      n0 = t.notifications.length;
      const r = await t.api('switchTo', CAROL);
      t.equal(r && r.ok, true, 'switched to carol');
      await t.idle();
      s = await t.state();
      t.equal([s.activeAccountNumber, ...pcts(s, 3)], [3, 95, 88], 'carol is active at 95 / 88');
      t.equal(since(n0), [], 'nothing about her 95 %');

      t.section('Settings ▸ Notifications off');
      t.click(await t.menu(), 'Notifications');
      await t.expect(() => t.settings().notifications, false, 'saved as off');
      t.scenario('drift');
      t.setFakeState({ active: 3 }); // a fresh drift counter: carol 95 → 98 → 100
      for (let i = 0; i < 3; i++) s = await t.refresh();
      t.equal(pcts(s, 3)[0], 100, 'carol’s 5h reached 100 %');
      t.equal(since(n0), [], 'nothing while they are off');

      t.section('Settings ▸ Notifications on');
      t.click(await t.menu(), 'Notifications');
      await t.expect(() => t.settings().notifications, true, 'saved as on');
      await t.refresh();
      t.equal(since(n0), [], 'turning them on replays nothing');
      t.scenario('default');
      await t.refresh();
      t.equal(since(n0), [[TITLE, 'carol@example.com is available again']], 'the next change is told');
      t.equal(t.notifications.every((n) => n.silent === false), true, 'with sound, as Maestro does');
    } finally {
      Notification.prototype.show = record;
    }
  },
};
