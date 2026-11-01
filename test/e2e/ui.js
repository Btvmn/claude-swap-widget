'use strict';
// How the flows read and click the page. Everything that knows the renderer's
// markup lives here, so a renderer rewrite updates this file and the flows
// stay as they are. The markup (PLAN §3.2–3.4):
//   #hero[data-number][data-account]  the active account (.is-disabled when disabled);
//                                     its pills in .pills, its menu in #heroMenu;
//                                     .gauges(.one) > .gauge[data-window] (left '5h',
//                                     right '7d'; .is-stale, hidden when not in use),
//                                     .hero-note, #expandToggle, #expandSection .extra-label
//   #acctList .acct[data-number][data-key]  every other account, .is-disabled, .is-stale,
//                                     .acct-name, .pill[data-badge], .switch-btn, .acct-menu;
//                                     .acct-bars: .lbl, .compact-bar-fill, .pct, .acct-reset per line
//   #screen[data-phase]               setup / error screens (h2, .cmd, .actions)
//   #stats[data-style]                the statistics (#stats-btn opens them): #stats-account,
//                                     #stats-period, #stats-style, canvas#stats-canvas, .stats-item,
//                                     .stats-card, .heat-cell
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

    // The hero's rings on screen, left before right.
    gauges: () =>
      t.js(() =>
        [...document.querySelectorAll('#hero .gauge')]
          .filter((g) => !g.hidden)
          .map((g) => {
            const pace = g.querySelector('.gauge-pace');
            return {
              side: g.dataset.window === '7d' ? 'right' : 'left',
              label: g.querySelector('.gauge-label').textContent,
              tip: g.querySelector('.gauge-label-text').title,
              pct: g.querySelector('.gauge-num').textContent,
              metaPct: g.querySelector('.gauge-meta-pct').textContent,
              countdown: g.querySelector('.gauge-countdown').textContent,
              reset: g.querySelector('.gauge-reset').textContent,
              stale: g.classList.contains('is-stale'),
              paceTick: g.querySelector('.ring-tick-pace').getAttribute('display') !== 'none',
              pace: pace.hidden ? '' : pace.textContent,
            };
          }),
      ),
    // true when one ring is left in the middle (.gauges.one).
    oneRing: () => t.js(() => document.querySelector('#hero .gauges').classList.contains('one')),
    // The line under the rings: its text ('' when not shown) and tooltip.
    heroNote: () =>
      t.js(() => {
        const n = document.querySelector('#hero .hero-note');
        return n.hidden ? { text: '', tip: '' } : { text: n.textContent, tip: n.title };
      }),
    // The labels under "more limits", and whether it can be opened at all.
    moreLimits: () =>
      t.js(() => ({
        toggle: !document.getElementById('expandToggle').hidden,
        labels: document.getElementById('expandSection').hidden ? [] : [...document.querySelectorAll('#expandSection .extra-label')].map((l) => l.textContent),
      })),
    // A ring is in flight (a refresh or a switch).
    recharging: () => t.js(() => document.body.classList.contains('recharging')),
    // A gauge that went away holds nothing of a flight: its arc is not being turned.
    hiddenGaugesAtRest: () => t.js(() => [...document.querySelectorAll('#hero .gauge[hidden] .ring-usage')].every((u) => !u.style.transform)),
    ringInRing: () => t.js(() => document.body.classList.contains('gauges-b')),
    // Every row in the list: its window lines and pills.
    rows: () =>
      t.js(() =>
        [...document.querySelectorAll('#acctList .acct[data-number]')].map((c) => {
          const labels = [...c.querySelectorAll('.acct-bars .lbl')];
          const fills = [...c.querySelectorAll('.acct-bars .compact-bar-fill')];
          const pcts = [...c.querySelectorAll('.acct-bars .pct')];
          const resets = [...c.querySelectorAll('.acct-bars .acct-reset')];
          return {
            number: Number(c.dataset.number),
            stale: c.classList.contains('is-stale'),
            lines: labels.map((l, i) => ({
              label: l.textContent,
              tip: l.title,
              pct: pcts[i].textContent,
              weekly: fills[i].classList.contains('weekly'),
              old: fills[i].classList.contains('is-old'),
              resetTip: resets[i].title,
            })),
            pills: [...c.querySelectorAll('.pill')].map((p) => ({ key: p.dataset.badge, tone: p.className.replace(/\bpill\b/, '').trim(), text: p.textContent })),
          };
        }),
      ),
    // Where the hero's parts are, for layout checks: per ring on screen its
    // ring, its text block and that block's visible parts as boxes.
    heroLayout: () =>
      t.js(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const hero = document.getElementById('hero');
        return {
          hero: box(hero),
          overflows: hero.scrollWidth > hero.clientWidth,
          gauges: [...hero.querySelectorAll('.gauge')]
            .filter((g) => !g.hidden)
            .map((g) => {
              const meta = g.querySelector('.gauge-meta');
              const parts = [...meta.children].filter((c) => c.getClientRects().length > 0);
              return {
                ring: box(g.querySelector('.gauge-ring')),
                meta: box(meta),
                texts: parts.map(box),
                cut: parts.filter((c) => c.scrollWidth > c.clientWidth).map((c) => c.className),
                stroke: getComputedStyle(g.querySelector('.ring-track')).strokeWidth,
                hairline: parseFloat(getComputedStyle(meta).borderBottomWidth) > 0,
              };
            }),
        };
      }),

    // The statistics view, from the title bar's button; it loads Chart.js on the first open.
    openStats: () => t.js(() => (document.getElementById('stats-btn').click(), true)),
    // One account of the picker, by the text of its option ("follow the active one" is not one).
    statsAccount: (name) =>
      t.js((text) => {
        const sel = document.getElementById('stats-account');
        const option = [...sel.options].find((o) => o.value && o.textContent.includes(text));
        if (option) {
          sel.value = option.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return Boolean(option);
      }, name),
    statsLook: (look) => t.js((l) => (document.querySelector(`#stats-style [data-stats-style=${l}]`).click(), true), look),
    statsPeriod: (period) => t.js((p) => (document.querySelector(`#stats-period [data-period=${p}]`).click(), true), period),
    // What the view shows for the current choice: its summary, what Chart.js was
    // handed (a line chart's lines, the bars' pills) and the strip's titles.
    stats: () =>
      t.js(() => {
        const root = document.getElementById('stats');
        const chart = window.Chart && window.Chart.getChart(document.getElementById('stats-canvas'));
        const type = chart ? chart.config.type : null;
        return {
          look: root.dataset.style,
          items: [...root.querySelectorAll('.stats-item')].map((i) => ({ label: i.querySelector('.stats-item-label').textContent, value: i.querySelector('.stats-item-value').textContent, tip: i.title })),
          cards: [...root.querySelectorAll('.stats-card')].map((c) => ({ label: c.querySelector('.stats-card-label').textContent, tip: c.title })),
          lines:
            type === 'line'
              ? chart.data.datasets.map((d, n) => {
                  const last = d.data.reduce((found, p, i) => (p.y !== null ? i : found), -1);
                  return { label: d.label, ys: d.data.map((p) => p.y), last: last < 0 ? null : d.data[last].y, endDot: last >= 0 && chart.getDatasetMeta(n).data[last].options.radius === 3 };
                })
              : [],
          pills: type === 'bar' ? chart.data.datasets[0].data.flatMap((v, i) => (v ? [chart.config.options.plugins.tooltip.callbacks.label({ dataIndex: i })] : [])) : [],
          cells: [...root.querySelectorAll('.heat-cell.has-value')].map((c) => c.title),
        };
      }),

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
