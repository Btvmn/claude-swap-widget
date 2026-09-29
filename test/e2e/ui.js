'use strict';
// How the flows read and click the page. Everything that knows the renderer's
// markup lives here, so a renderer rewrite updates this file and the flows
// stay as they are. The markup (PLAN §3.2–3.4):
//   #hero[data-number][data-account]  the active account (.is-disabled when disabled);
//                                     its pills in .pills, its menu in #heroMenu
//   #acctList .acct[data-number][data-key]  every other account, .is-disabled,
//                                     .acct-name, .pill, .switch-btn, .acct-menu
//   #screen[data-phase]               setup / error screens (h2, .cmd, .actions)
//   #best, #next in #footer; #toast; #banner; #subtitle; #refresh; #menu
//
// Functions passed to t.js() are serialised into the page: they see only
// their arguments, never the flow's variables.

module.exports = function ui(t) {
  const self = {
    // [{ number, active, disabled, name, badges, canSwitch }]: the active
    // account (hero) first, then the rows in cswap order.
    cards: () =>
      t.js(() => {
        const out = [];
        const hero = document.getElementById('hero');
        if (hero && !hero.hidden && hero.dataset.number) {
          out.push({
            number: Number(hero.dataset.number),
            active: true,
            disabled: hero.classList.contains('is-disabled'),
            name: document.getElementById('title').textContent,
            badges: [...hero.querySelectorAll('.pill')].map((b) => b.textContent),
            canSwitch: false,
          });
        }
        const list = document.getElementById('accounts');
        if (list && !list.hidden) {
          for (const c of document.querySelectorAll('#acctList .acct[data-number]')) {
            out.push({
              number: Number(c.dataset.number),
              active: false,
              disabled: c.classList.contains('is-disabled'),
              name: (c.querySelector('.acct-name') || {}).textContent || '',
              badges: [...c.querySelectorAll('.pill')].map((b) => b.textContent),
              canSwitch: Boolean(c.querySelector('.switch-btn')),
            });
          }
        }
        return out;
      }),
    activeNumbers: async () => (await self.cards()).filter((c) => c.active).map((c) => c.number),
    disabledNumbers: async () => (await self.cards()).filter((c) => c.disabled).map((c) => c.number),

    // Clicks the Switch button of account `number`; false when there is none.
    clickSwitch: (number) =>
      t.js((n) => {
        const b = document.querySelector(`#acctList [data-number="${n}"] .switch-btn`);
        if (b) b.click();
        return Boolean(b);
      }, number),
    clickBest: () => t.js(() => (document.getElementById('best').click(), true)),
    clickMenu: () => t.js(() => (document.getElementById('menu').click(), true)),
    clickRefresh: () => t.js(() => (document.getElementById('refresh').click(), true)),
    footerVisible: () => t.js(() => !document.getElementById('footer').hidden),
    banner: () => t.js(() => (document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent)),
    subtitle: () => t.js(() => document.getElementById('subtitle').textContent),
    // Title of the setup / error screen, '' when the list shows accounts.
    screenTitle: () => t.js(() => (document.getElementById('screen').hidden ? '' : (document.querySelector('#screen h2') || {}).textContent || '')),
    // The screen's copyable commands and its action buttons.
    screenCommands: () => t.js(() => [...document.querySelectorAll('#screen .cmd code')].map((c) => c.textContent)),
    screenButtons: () => t.js(() => [...document.querySelectorAll('#screen .actions button')].map((b) => b.textContent)),
    clickCopy: (command) =>
      t.js((text) => {
        const row = [...document.querySelectorAll('#screen .cmd')].find((c) => c.querySelector('code').textContent === text);
        if (row) row.querySelector('button').click();
        return Boolean(row);
      }, command),
    clickScreenButton: (label) =>
      t.js((text) => {
        const b = [...document.querySelectorAll('#screen .actions button')].find((x) => x.textContent === text);
        if (b) b.click();
        return Boolean(b);
      }, label),

    toast: () =>
      t.js(() => {
        const el = document.getElementById('toast');
        return { text: el.textContent, visible: !el.hidden, error: el.classList.contains('error') };
      }),
    // Hide the toast so the next one can be told apart from the last.
    clearToast: () =>
      t.js(() => {
        const el = document.getElementById('toast');
        el.hidden = true;
        el.textContent = '';
        return true;
      }),
    async waitToast(what = 'a toast', timeout = 8000) {
      const toast = await t.waitFor(async () => {
        const x = await self.toast();
        return x.visible && x.text ? x : null;
      }, what, { timeout });
      return toast.text;
    },
  };
  return self;
};
