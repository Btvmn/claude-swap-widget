'use strict';
// The per-account "⋯" menu (PLAN §3.4, accounts:menu), opened from the hero
// and from each account row: Switch to This Account, In Rotation (disable /
// enable), Show Statistics, Copy Email and Remove Account… (the copy-command
// dialog: we never remove an account ourselves). The identity comes from the
// page, so it must name an account in the current list.

const { ipcMain, Menu, clipboard } = require('electron');
const Usage = require('../shared/usage');

let ctx = null;

function find(target) {
  const state = ctx.service.state;
  if (!state || state.phase !== 'ok' || !target || typeof target !== 'object') return null;
  if (typeof target.email !== 'string' || !target.email) return null;
  const org = typeof target.organizationUuid === 'string' ? target.organizationUuid : '';
  return state.accounts.find((a) => a.email === target.email && (a.organizationUuid || '') === org) || null;
}

function build(account) {
  const { t } = ctx;
  const identity = { email: account.email, organizationUuid: account.organizationUuid || '' };
  const name = Usage.label(account, t);
  const busy = Boolean(ctx.service.state.switching);
  return Menu.buildFromTemplate([
    {
      label: t('acct.menu.switch'),
      visible: !account.active,
      enabled: !busy,
      click: () => ctx.runAction(() => ctx.service.switchTo(identity), 'switch', { email: account.email }),
    },
    {
      label: t('acct.menu.inRotation'),
      type: 'checkbox',
      checked: !account.disabled,
      click: () => ctx.runAction(() => ctx.service.setDisabled(identity, !account.disabled), account.disabled ? 'enable' : 'disable', { name }),
    },
    { label: t('acct.menu.stats'), click: () => ctx.openStats(identity) },
    { type: 'separator' },
    { label: t('acct.menu.copyEmail'), click: () => clipboard.writeText(account.email) },
    { label: t('acct.menu.remove'), click: () => ctx.showRemoveCommand(account) },
  ]);
}

function attach(context) {
  ctx = context;
  ipcMain.on('accounts:menu', (e, target) => {
    if (!ctx.fromUi(e)) return;
    const account = find(target);
    if (!account) return;
    build(account).popup({ window: ctx.getWin() });
  });
}

module.exports = { attach, find };
