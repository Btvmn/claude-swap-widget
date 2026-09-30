'use strict';
// Usage history for the statistics (PLAN §5.1, §7): src/history.js keeps it
// in userData/history/, this module wires it to the app.
//
//   - Every service 'state' goes to store.record(), which writes only what is
//     new: a list the store has not seen, and in it only the measurements
//     newer than the last one stored per account (cswap re-measures every
//     3–10 min; we refresh every minute). It records while the popover is
//     hidden. Nothing is recorded while `recordHistory` is off, nor in a
//     CSW_CAPTURE run (a capture must not add the fake's accounts to a real
//     history; reading works as always).
//   - bus 'setting:recordHistory': off → write what is pending; back on →
//     the next list starts a new session (with an act line).
//   - bus 'history:clear': delete every history file. The menu asks first;
//     the event means "confirmed". Recording goes on: the next state writes
//     the current list again, as a new start.
//   - history:accounts and history:get for the page, from our own page only,
//     with the key and the day count checked before any file is touched.
//     Anything else is answered with null.

const { ipcMain } = require('electron');
const path = require('path');
const { HistoryStore, historyKey, KEY_RE, SERVE_DAYS } = require('../history');
const { orgLabel } = require('../shared/usage');

let ctx = null;
let store = null;
let recordFailed = false;
let lastProblem = null; // the store's last log line, for a failed clear

function log(msg) {
  lastProblem = String(msg);
  console.error(msg);
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v ? v : null);

function recording() {
  return !ctx.dev.capture && Boolean(ctx.getSettings().recordHistory);
}

// A bug here must never break the service's 'state' fan-out (tray, page).
function record(state) {
  if (!recording()) return;
  try {
    store.record(state);
  } catch (err) {
    if (!recordFailed) console.error(`history: recording failed: ${(err && err.stack) || err}`);
    recordFailed = true;
  }
}

// The menu reports success when this returns and shows the error when it
// throws, so a file that could not be deleted throws (with what the store
// logged about it).
function clear() {
  lastProblem = null;
  const ok = store.clear();
  // An open statistics view must not keep showing what was deleted.
  ctx.send('history:changed');
  if (!ok) throw new Error(lastProblem || 'Some history files could not be deleted');
}

// history:get(key, days): a key the page got from history:accounts, and a
// whole number of days from 1 to SERVE_DAYS (31). → { key, currency, since,
// samples, switches } (see src/history.js), or null.
function validGet(key, days) {
  return typeof key === 'string' && KEY_RE.test(key) && Number.isInteger(days) && days >= 1 && days <= SERVE_DAYS;
}

function rowCurrency(row) {
  for (const u of [row.usage, row.lastGoodUsage]) {
    if (isObject(u) && isObject(u.spend) && text(u.spend.currency)) return u.spend.currency;
  }
  return null;
}

// Every account the statistics can show, in the order of the account list
// (cswap's), then the ones no longer in claude-swap, most recently seen first:
//   { key, email, organizationUuid, label, org, currency, present, active, firstSeen, lastSeen }
// label is the alias, else the email; org is null for a personal account's
// auto-named organisation. A listed account with no history yet is included
// (firstSeen / lastSeen null); an account whose index entry was lost has
// email null until it is listed again.
function accountList() {
  const state = ctx.service.state;
  const live = state && state.phase === 'ok' && Array.isArray(state.accounts) ? state : null;
  const rows = live ? live.accounts.filter((r) => isObject(r) && text(r.email)) : [];
  const activeRow = rows.find((r) => r.active === true) || (live && live.activeAccountNumber != null && rows.find((r) => r.number === live.activeAccountNumber)) || null;
  const rowOf = new Map();
  for (const r of rows) {
    const key = historyKey(r.email, r.organizationUuid);
    if (!rowOf.has(key)) rowOf.set(key, r);
  }
  const activeKey = activeRow ? historyKey(activeRow.email, activeRow.organizationUuid) : null;
  const stored = new Map(store.accounts(live || undefined).map((e) => [e.key, e]));
  const keys = [...rowOf.keys(), ...[...stored.keys()].filter((k) => !rowOf.has(k))];
  return keys.map((key) => {
    const e = stored.get(key) || {};
    const r = rowOf.get(key);
    const info = r
      ? { email: r.email, organizationUuid: text(r.organizationUuid), organizationName: text(r.organizationName), alias: text(r.alias) }
      : { email: e.email ?? null, organizationUuid: e.organizationUuid ?? null, organizationName: e.organizationName ?? null, alias: e.alias ?? null };
    return {
      key,
      email: info.email,
      organizationUuid: info.organizationUuid,
      label: info.alias || info.email || null,
      org: orgLabel({ email: info.email, organizationName: info.organizationName || '' }) || null,
      currency: e.currency ?? (r ? rowCurrency(r) : null),
      present: r ? true : Boolean(e.present),
      active: r ? key === activeKey : Boolean(e.active),
      firstSeen: e.firstSeen ?? null,
      lastSeen: e.lastSeen ?? null,
    };
  });
}

function attach(context) {
  ctx = context;
  store = new HistoryStore({ dir: path.join(ctx.app.getPath('userData'), 'history'), log });
  // Reads what is there and prunes past the retention, before the first list.
  try {
    store.open();
  } catch (err) {
    console.error(`history: cannot open ${store.dir}: ${(err && err.stack) || err}`);
  }

  ctx.service.on('state', record);
  ctx.bus.on('setting:recordHistory', (on) => {
    if (on) store.resume();
    else store.flush();
    ctx.send('history:changed');
  });
  ctx.bus.on('history:clear', clear);
  // lastSeen changes wait for a new UTC day; write them before quitting.
  ctx.app.on('before-quit', () => {
    try {
      store.flush();
    } catch {}
  });

  ipcMain.handle('history:accounts', (e) => {
    if (!ctx.fromUi(e)) return null;
    try {
      return accountList();
    } catch (err) {
      console.error(`history: history:accounts failed: ${(err && err.stack) || err}`);
      return null;
    }
  });
  ipcMain.handle('history:get', (e, key, days) => {
    if (!ctx.fromUi(e) || !validGet(key, days)) return null;
    try {
      return store.get(key, days);
    } catch (err) {
      console.error(`history: history:get failed: ${(err && err.stack) || err}`);
      return null;
    }
  });
}

module.exports = { attach, validGet };
