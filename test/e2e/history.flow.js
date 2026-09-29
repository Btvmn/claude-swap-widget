'use strict';
// Usage history (PLAN §5.1, P2.4): what main writes to userData/history while
// the app runs, the history:* IPC, "Clear Usage History…" and the
// "Keep Usage History" switch.
//
// It starts on the fake's `drift` scenario, where every list is a new
// measurement, then moves to `default`, where cswap serves one measurement
// for minutes, so repeated refreshes must add nothing. The expected lines
// come from the lists main actually got: per account, one line whenever a
// list carries a measurement newer than the last one written, and one act
// line when the active account changes.
// Clearing and the switch go through the menu, as a user would.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
// As src/history.js keys an account (the flow checks the files, so it keeps
// its own copy of the rule).
const historyKey = (email, org) => crypto.createHash('sha256').update(`${email}\n${org || ''}`).digest('hex').slice(0, 12);
const KEYS = {
  alice: historyKey('alice@example.com', 'org-acme'),
  bob: historyKey('bob@example.com', 'org-bob'),
  carol: historyKey('carol@example.com', 'org-globex'),
  dave: historyKey('dave@example.com', 'org-dave'),
  erin: historyKey('erin@example.com', 'org-erin'),
};
const ORDER = ['alice', 'bob', 'carol', 'dave', 'erin'].map((n) => KEYS[n]);

// When cswap measured a row, as history.js reads it (this fake always
// carries the timestamps); null when the row has nothing to record.
function measuredAt(row) {
  const u = row.usage || row.lastGoodUsage;
  if (!u || (typeof (u.fiveHour || {}).pct !== 'number' && typeof (u.sevenDay || {}).pct !== 'number')) return null;
  const at = Date.parse(row.usage ? row.usageFetchedAt : row.lastGoodFetchedAt);
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

// The lines a run of lists should leave: one per new measurement, one act line
// per change of the active account (the first list counts as a change).
function expectedLines(lists) {
  const lastT = new Map();
  const perKey = {};
  let acts = 0;
  let active;
  for (const s of lists) {
    for (const row of s.accounts) {
      const key = historyKey(row.email, row.organizationUuid);
      const at = measuredAt(row);
      if (at === null || at <= (lastT.get(key) ?? -Infinity)) continue;
      lastT.set(key, at);
      perKey[key] = (perKey[key] || 0) + 1;
    }
    const a = s.accounts.find((r) => r.active);
    const key = a ? historyKey(a.email, a.organizationUuid) : null;
    if (key && key !== active) acts++;
    active = key;
  }
  return { perKey, samples: Object.values(perKey).reduce((x, y) => x + y, 0), acts };
}

module.exports = {
  description: 'history: one line per new measurement plus act lines, history:* IPC checks, clear, recordHistory off',
  scenario: 'drift',
  async run(t) {
    // The menu's English labels. Required here, not at the top: scripts/e2e.js
    // loads flow files in plain Node to read their settings.
    const en = require(path.join(process.env.E2E_APP, 'src', 'shared', 'i18n.js')).translator('en');
    const dir = path.join(t.userData, 'history');
    const names = () => {
      try {
        return fs.readdirSync(dir).sort();
      } catch {
        return [];
      }
    };
    const dayFiles = () => names().filter((n) => DAY_FILE.test(n));
    const lines = () => dayFiles().flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const samples = () => lines().filter((l) => l.k);
    const acts = () => lines().filter((l) => l.act);
    const countBy = (list) => list.reduce((o, l) => ({ ...o, [l.k]: (o[l.k] || 0) + 1 }), {});
    const snapshot = () => names().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]);
    const index = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
      } catch {
        return null;
      }
    };
    const noDuplicates = (msg) => {
      const pairs = samples().map((l) => `${l.k}@${l.t}`);
      t.equal(pairs.length - new Set(pairs).size, 0, msg);
    };
    const accounts = () => t.js(() => window.api.history.accounts());
    const get = (key, days) => t.js((k, d) => window.api.history.get(k, d), key, days);

    // Every list main gets, from the one before the flow started on.
    const lists = [await t.state()];
    t.service.on('state', (s) => {
      if (s.phase === 'ok' && s.fetchedAt !== lists[lists.length - 1].fetchedAt) lists.push(JSON.parse(JSON.stringify(s)));
    });

    t.section('drift: every list is a new measurement');
    t.equal(lists[0].phase, 'ok', 'the first list is in');
    for (let i = 0; i < 3; i++) await t.refresh();
    const drift = expectedLines(lists);
    t.log(`${lists.length} lists (the fake counted ${(t.fakeState().drift || {}).lists}); files: ${names().join(' ')}`);
    t.equal(lists.length, (t.fakeState().drift || {}).lists, 'the flow saw every list the fake served');
    t.equal(Object.keys((index() || {}).accounts || {}).sort(), [...ORDER].sort(), 'accounts.json has the 5 accounts');
    t.equal(countBy(samples()), drift.perKey, 'one line per new measurement for each account');
    t.equal([drift.perKey[KEYS.alice], drift.perKey[KEYS.dave]], [lists.length, 1], 'alice measured on every list, dave’s last good data once');
    t.equal(samples().length, drift.samples, `${drift.samples} sample lines in all`);
    t.equal(acts().map((l) => l.act), [KEYS.alice], 'one act line: alice, active from the start');
    const alice = samples().filter((l) => l.k === KEYS.alice);
    t.equal(alice.map((l) => l.h), lists.map((_, i) => 20 + 3 * i), 'alice’s 5h rises by 3 per line');
    t.ok(alice.every((l) => l.a === 1) && samples().every((l) => l.k === KEYS.alice || !('a' in l)), 'only the active account’s lines carry a:1');
    const carolLast = samples().filter((l) => l.k === KEYS.carol).pop() || {};
    t.equal([carolLast.u, carolLast.l, carolLast.m], [12.4, 50, { Fable: 76 }], 'carol’s spend and scoped usage are kept');
    t.equal(index().accounts[KEYS.carol].currency, 'USD', 'the index keeps her currency');
    t.equal(names().filter((n) => !DAY_FILE.test(n)), ['accounts.json'], 'nothing else in the folder');
    noDuplicates('no measurement is written twice');

    t.section('history:accounts and history:get');
    let list = await accounts();
    t.equal(list.map((a) => a.key), ORDER, 'every account, in the list’s order');
    t.equal(list.map((a) => a.label), ['work', 'bob@example.com', 'carol@example.com', 'dave@example.com', 'erin@example.com'], 'labelled by alias, else email');
    t.equal(list.map((a) => a.org), ['Acme Corp', null, 'Globex', null, null], 'real organisations only');
    t.equal([list.every((a) => a.present), list.filter((a) => a.active).map((a) => a.key)], [true, [KEYS.alice]], 'all present, alice active');
    t.equal(list.map((a) => a.currency), [null, null, 'USD', null, null], 'carol’s currency');
    t.ok(list.every((a) => Number.isFinite(a.firstSeen) && a.lastSeen >= a.firstSeen), 'first and last seen are set');
    t.equal(Object.keys(list[0]).sort(), ['active', 'currency', 'email', 'firstSeen', 'key', 'label', 'lastSeen', 'org', 'organizationUuid', 'present'], 'the fields of PLAN §7');
    let h = await get(KEYS.alice, 1);
    t.equal([h.key, h.samples.length, h.switches.map((s) => s.key), h.since], [KEYS.alice, lists.length, [KEYS.alice], list[0].firstSeen], 'alice’s day: her samples and the act line');
    t.equal(h.samples.map((s) => s.h), alice.map((l) => l.h), 'the samples as stored');
    h = await get(KEYS.carol, 31);
    t.equal([h.currency, h.samples.length], ['USD', drift.perKey[KEYS.carol]], 'carol’s month');
    const bad = [
      ['zzz', 7],
      [KEYS.alice.toUpperCase(), 7],
      [`${KEYS.alice}0`, 7],
      ['../../settings', 7],
      [42, 7],
      [KEYS.alice, 0],
      [KEYS.alice, 32],
      [KEYS.alice, 1.5],
      [KEYS.alice, '7'],
      [KEYS.alice, -1],
    ];
    const answers = [];
    for (const [key, days] of bad) answers.push(await get(key, days));
    answers.push(await t.js((k) => window.api.history.get(k), KEYS.alice));
    t.equal(answers, answers.map(() => null), `history:get refuses bad keys and day counts (${bad.length + 1} cases)`);

    t.section('default: one measurement served for minutes');
    t.scenario('default');
    t.setFakeState({ active: 1 });
    await t.refresh();
    const beforeClear = samples().length;
    t.log(`${beforeClear} sample lines before clearing`);

    t.section('Clear Usage History…');
    const kept = snapshot();
    let dialogs = t.dialogs.length;
    t.answer(en('btn.cancel'));
    t.click(await t.menu(), en('set.clearHistory'));
    await t.waitFor(() => t.dialogs.length > dialogs, 'the confirm dialog');
    await t.idle();
    t.equal(snapshot(), kept, 'Cancel keeps every file');
    dialogs = t.dialogs.length;
    t.answer(en('dlg.clearHistory.confirm'));
    t.click(await t.menu(), en('set.clearHistory'));
    await t.waitFor(() => t.dialogs.length > dialogs, 'the confirm dialog');
    t.equal(t.dialogs[dialogs].message, en('dlg.clearHistory.title'), 'the menu asks first');
    await t.waitFor(() => names().length === 0, 'the history files to go', { timeout: 3000 });
    t.equal(names(), [], 'the history folder is empty');
    list = await accounts();
    t.equal([list.map((a) => a.key), list.every((a) => a.firstSeen === null && a.lastSeen === null)], [ORDER, true], 'the listed accounts remain, with no history');
    h = await get(KEYS.alice, 31);
    t.equal([h.samples, h.switches, h.since], [[], [], null], 'history:get has nothing');

    const fromClear = lists.length - 1; // the current list is written again at the next state
    for (let i = 0; i < 3; i++) await t.refresh();
    const steady = expectedLines(lists.slice(fromClear));
    const aliceTimes = new Set(lists.slice(fromClear).map((s) => s.accounts.find((a) => a.number === 1).usageFetchedAt));
    t.equal(aliceTimes.size, 1, 'the fake served one measurement across the refreshes');
    t.equal(countBy(samples()), steady.perKey, 'one line per new measurement');
    t.equal(countBy(samples()), Object.fromEntries(ORDER.map((k) => [k, 1])), 'one line per account after 3 refreshes: no duplicates');
    t.equal(acts().map((l) => l.act), [KEYS.alice], 'and one act line');
    t.equal(Object.keys((index() || {}).accounts || {}).sort(), [...ORDER].sort(), 'accounts.json is back with 5 accounts');
    noDuplicates('no measurement is written twice');

    t.section('Keep Usage History off: nothing is written');
    const setRecording = async (on) => {
      const menu = await t.menu();
      t.equal(t.find(menu, en('set.recordHistory'))?.checked, !on, `the menu shows recording ${on ? 'off' : 'on'}`);
      t.click(menu, en('set.recordHistory'));
      await t.waitFor(() => (t.settings() || {}).recordHistory === on, `recordHistory ${on} in settings.json`, { timeout: 3000 });
    };
    await setRecording(false);
    const frozen = snapshot();
    const newest = {};
    for (const l of samples()) newest[l.k] = Math.max(newest[l.k] ?? -Infinity, l.t);
    t.scenario('drift'); // every list would be new
    t.setFakeState({ active: 1 });
    const offFrom = lists.length;
    for (let i = 0; i < 2; i++) await t.refresh();
    t.equal(lists.length - offFrom, 2, 'two new lists came in');
    const unseen = lists.slice(offFrom).flatMap((s) => s.accounts).filter((r) => measuredAt(r) !== null && measuredAt(r) > (newest[historyKey(r.email, r.organizationUuid)] ?? -Infinity));
    t.ok(unseen.length > 0, `they carried measurements newer than the stored ones (${unseen.length})`);
    t.equal(snapshot(), frozen, 'not a byte was written');

    await setRecording(true);
    const acts0 = acts().length;
    const samples0 = samples().length;
    await t.refresh();
    t.equal(acts().length, acts0 + 1, 'back on: a new session starts with an act line');
    t.ok(samples().length > samples0, `and the new measurements are written (${samples().length - samples0} lines)`);
    noDuplicates('still no measurement written twice');
    t.equal(names().filter((n) => !DAY_FILE.test(n)), ['accounts.json'], 'only day files and the index in the folder');
  },
};
