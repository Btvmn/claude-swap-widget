'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HistoryStore, historyKey, parseLine, KEY_RE, RETENTION_DAYS, SERVE_DAYS } = require('../src/history');
const { AccountService } = require('../src/service');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cswap');
const NOW = Date.parse('2026-09-29T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S = (ms) => Math.floor(ms / 1000);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const ALICE = { number: 1, email: 'alice@example.com', alias: 'work', organizationName: 'Acme Corp', organizationUuid: 'org-acme' };
const BOB = { number: 2, email: 'bob@example.com', organizationName: "bob@example.com's Organization", organizationUuid: 'org-bob' };
const DAVE = { number: 4, email: 'dave@example.com', organizationName: "dave@example.com's Organization", organizationUuid: 'org-dave' };
// sha256("alice@example.com\norg-acme"), first 12 hex; computed once with shasum.
const K_ALICE = '796355bf735e';
const K_BOB = historyKey(BOB.email, BOB.organizationUuid);
const K_DAVE = historyKey(DAVE.email, DAVE.organizationUuid);
const RESET_5H = '2026-09-29T14:12:00.000417+00:00'; // cswap passes the API's microseconds through

// A fresh folder with a hand-driven clock; reopen() is an app restart.
function setup(t, { dir } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { ms: NOW };
  const logs = [];
  const folder = dir ? dir(root) : path.join(root, 'history');
  const reopen = () => new HistoryStore({ dir: folder, now: () => clock.ms, log: (m) => logs.push(m) });
  return { root, dir: folder, clock, logs, reopen, store: reopen() };
}

function usage(h, w, extra = {}) {
  const u = { ...extra };
  if (h !== undefined) u.fiveHour = { pct: h, resetsAt: RESET_5H };
  if (w !== undefined) u.sevenDay = { pct: w, resetsAt: '2026-10-02T16:00:00.000417+00:00', expectedPct: 55, aheadOfPace: false };
  return u;
}

// A row of `cswap list --json`, measured at `at` (ms).
function row(acc, u, at, extra = {}) {
  return { ...acc, isOrganization: true, usageStatus: 'ok', usage: u, usageFetchedAt: iso(at), usageAgeSeconds: 30, ...extra };
}

// The service state main sees after a refresh at `fetched` (ms).
function state(fetched, rows, active = 1) {
  return {
    phase: 'ok',
    fetchedAt: new Date(fetched).toISOString(),
    activeAccountNumber: active,
    accounts: rows.map((r) => ({ ...r, active: r.number === active })),
    error: null,
    refreshing: false,
    switching: false,
  };
}

// Moves the clock to `ms` and records a refresh made then.
function refresh(h, ms, rows, active = 1) {
  h.clock.ms = ms;
  return h.store.record(state(ms, rows, active));
}

function allLines(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const samplesOf = (dir, k) => allLines(dir).filter((l) => l.k === k);
const acts = (dir) => allLines(dir).filter((l) => 'act' in l).map((l) => l.act);
const readIndex = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));

function writeLines(dir, name, lines, { torn = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(path.join(dir, name), text + (text ? '\n' : '') + torn);
}

// --- format -------------------------------------------------------------------

test('a line: measurement time, key, active flag, rounded values, r5 in minutes, scoped and spend', (t) => {
  const h = setup(t);
  const at = NOW - 30_000;
  const u = usage(20.44, 34.06, {
    spend: { used: 12.404, limit: 50, pct: 24.8, currency: 'USD' },
    scoped: [{ name: 'Fable', pct: 76, resetsAt: RESET_5H }, { name: 'broken' }, null],
  });
  assert.deepEqual(refresh(h, NOW, [row(ALICE, u, at)]), { samples: 1, act: true });
  const text = fs.readFileSync(path.join(h.dir, '2026-09-29.jsonl'), 'utf8');
  const r5 = Math.round(Date.parse('2026-09-29T14:12:00Z') / MIN);
  assert.equal(
    text,
    `{"t":${S(at)},"k":"${K_ALICE}","a":1,"h":20.4,"w":34.1,"r5":${r5},"m":{"Fable":76},"u":12.4,"l":50}\n` +
      `{"t":${S(NOW)},"act":"${K_ALICE}"}\n`
  );
  // The currency and the names live in the index, and nothing else does.
  assert.deepEqual(readIndex(h.dir), {
    v: 1,
    accounts: {
      [K_ALICE]: {
        email: 'alice@example.com',
        organizationUuid: 'org-acme',
        organizationName: 'Acme Corp',
        alias: 'work',
        currency: 'USD',
        firstSeen: S(at),
        lastSeen: S(NOW),
      },
    },
  });
  assert.deepEqual(fs.readdirSync(h.dir).sort(), ['2026-09-29.jsonl', 'accounts.json']);
});

test('the key is sha256(email \\n org) cut to 12 hex, and survives renumbering and alias changes', (t) => {
  assert.equal(historyKey('alice@example.com', 'org-acme'), K_ALICE);
  assert.equal(crypto.createHash('sha256').update('alice@example.com\norg-acme').digest('hex').slice(0, 12), K_ALICE);
  assert.equal(historyKey('alice@example.com', null), historyKey('alice@example.com', ''));
  assert.notEqual(historyKey('alice@example.com', 'org-other'), K_ALICE);
  assert.match(K_BOB, KEY_RE);

  const h = setup(t);
  refresh(h, NOW, [row(ALICE, usage(20, 34), NOW - 30_000), row(BOB, usage(80, 61), NOW - 60_000)]);
  // `cswap move`: alice is slot 3 now, bob slot 1 and active; alice got a new alias.
  const moved = [row({ ...BOB, number: 1 }, usage(80, 61), NOW - 60_000), row({ ...ALICE, number: 3, alias: 'main' }, usage(25, 35), NOW + 4 * MIN)];
  refresh(h, NOW + 5 * MIN, moved, 1);
  assert.deepEqual(samplesOf(h.dir, K_ALICE).map((l) => l.h), [20, 25]);
  assert.deepEqual(samplesOf(h.dir, K_BOB).map((l) => l.h), [80]);
  assert.deepEqual(acts(h.dir), [K_ALICE, K_BOB]);
  assert.equal(readIndex(h.dir).accounts[K_ALICE].alias, 'main');
});

test('parseLine checks every field and drops what it does not know', () => {
  assert.deepEqual(parseLine(`{"t":5,"k":"${K_ALICE}","a":1,"h":1,"w":"x","m":{"F":2,"G":"y"},"u":3,"zz":1}`), {
    k: K_ALICE,
    s: { t: 5, a: 1, h: 1, m: { F: 2 }, u: 3 },
  });
  assert.deepEqual(parseLine(`{"t":5,"act":"${K_BOB}"}`), { act: K_BOB, t: 5 });
  for (const bad of ['', 'nope', '{"t":"5","k":"796355bf735e"}', '{"t":5,"k":"XYZ"}', '{"t":5,"act":"../../x"}', '[1]', 'null', `{"t":5,"k":"${K_ALICE}"`]) {
    assert.equal(parseLine(bad), null, bad);
  }
});

// --- what gets recorded -------------------------------------------------------

test('dedupes on usageFetchedAt: one line per measurement, not per refresh, also after a restart', (t) => {
  const h = setup(t);
  const rows = [row(ALICE, usage(20, 34), NOW - 30_000), row(BOB, usage(80, 61), NOW - 200_000)];
  for (let i = 0; i < 5; i++) refresh(h, NOW + i * MIN, rows);
  assert.equal(samplesOf(h.dir, K_ALICE).length, 1);
  assert.equal(samplesOf(h.dir, K_BOB).length, 1);

  // cswap measures alice again: one more line, at the new measurement time.
  const next = [row(ALICE, usage(23, 35), NOW + 4 * MIN), rows[1]];
  assert.deepEqual(refresh(h, NOW + 5 * MIN, next), { samples: 1, act: false });
  assert.deepEqual(samplesOf(h.dir, K_ALICE).map((l) => l.t), [S(NOW - 30_000), S(NOW + 4 * MIN)]);

  // An older measurement than the one stored is not written either.
  refresh(h, NOW + 6 * MIN, [row(ALICE, usage(21, 34), NOW + 3 * MIN), rows[1]]);
  assert.equal(samplesOf(h.dir, K_ALICE).length, 2);

  // Restart: the dedupe is rebuilt from the files; only the act line is new.
  h.store = h.reopen();
  assert.deepEqual(refresh(h, NOW + 7 * MIN, next), { samples: 0, act: true });
  assert.equal(allLines(h.dir).length, 2 + 1 + 2);
});

test('lastGoodUsage is back-filled once, at its own time, into its own day file', (t) => {
  const h = setup(t);
  const measured = NOW - 2 * DAY - 3 * HOUR;
  const expired = {
    ...DAVE,
    isOrganization: true,
    usageStatus: 'token_expired',
    usage: null,
    lastGoodUsage: usage(42, 50),
    lastGoodFetchedAt: iso(measured),
    lastGoodAgeSeconds: (NOW - measured) / 1000,
  };
  refresh(h, NOW, [row(ALICE, usage(20, 34), NOW - 30_000), expired]);
  const old = path.join(h.dir, `${day(measured)}.jsonl`);
  assert.equal(fs.readFileSync(old, 'utf8'), `{"t":${S(measured)},"k":"${K_DAVE}","h":42,"w":50,"r5":${Math.round(Date.parse(RESET_5H) / MIN)}}\n`);

  refresh(h, NOW + MIN, [row(ALICE, usage(20, 34), NOW - 30_000), expired]);
  h.store = h.reopen(); // the scan covers old files too, not only the newest
  refresh(h, NOW + 2 * MIN, [row(ALICE, usage(20, 34), NOW - 30_000), expired]);
  assert.equal(samplesOf(h.dir, K_DAVE).length, 1);

  // A last-good measurement taken while we were running is already there.
  const at = NOW + 2 * MIN;
  refresh(h, NOW + 3 * MIN, [row(ALICE, usage(30, 36), at)]);
  const alice = { ...ALICE, usageStatus: 'token_expired', usage: null, lastGoodUsage: usage(30, 36), lastGoodFetchedAt: iso(at), lastGoodAgeSeconds: 120 };
  refresh(h, NOW + 4 * MIN, [alice]);
  assert.deepEqual(samplesOf(h.dir, K_ALICE).map((l) => l.t), [S(NOW - 30_000), S(at)]);
});

test('without usageFetchedAt the time is fetchedAt − the age, and jitter is not a new measurement', (t) => {
  const h = setup(t);
  // As cswap before usageFetchedAt: the same measurement, 30 s old, then
  // 60.4 s later 90.9 s old (our fetchedAt is taken after cswap returns).
  const noAt = (u, age) => ({ ...ALICE, usageStatus: 'ok', usage: u, usageAgeSeconds: age });
  refresh(h, NOW, [noAt(usage(20, 34), 30)]);
  refresh(h, NOW + 60_400, [noAt(usage(20, 34), 90.9)]);
  refresh(h, NOW + 120_900, [noAt(usage(20, 34), 150.2)]);
  assert.deepEqual(samplesOf(h.dir, K_ALICE).map((l) => l.t), [S(NOW) - 30]);

  // cswap measured again: a new time and a new line.
  refresh(h, NOW + 5 * MIN, [noAt(usage(22, 35), 10)]);
  assert.deepEqual(samplesOf(h.dir, K_ALICE).map((l) => l.t), [S(NOW) - 30, S(NOW + 5 * MIN) - 10]);

  // The same fallback for last-good data, with its own age field.
  const lastGood = { ...BOB, usageStatus: 'token_expired', usage: null, lastGoodUsage: usage(42, 50), lastGoodAgeSeconds: 5400 };
  refresh(h, NOW + 6 * MIN, [noAt(usage(22, 35), 70), lastGood]);
  assert.deepEqual(samplesOf(h.dir, K_BOB).map((l) => l.t), [S(NOW + 6 * MIN) - 5400]);
});

test('without any time, a row is written only when its values change', (t) => {
  const h = setup(t);
  const bare = (u) => ({ ...ALICE, usageStatus: 'ok', usage: u });
  refresh(h, NOW, [bare(usage(20, 34))]);
  refresh(h, NOW + MIN, [bare(usage(20, 34))]);
  refresh(h, NOW + 2 * MIN, [bare(usage(21, 34))]);
  assert.deepEqual(samplesOf(h.dir, K_ALICE).map((l) => [l.t, l.h]), [[S(NOW), 20], [S(NOW + 2 * MIN), 21]]);
  h.store = h.reopen();
  refresh(h, NOW + 3 * MIN, [bare(usage(21, 34))]);
  assert.equal(samplesOf(h.dir, K_ALICE).length, 2);
});

test('a missing 5h or 7d is left out, never written as 0; a row with neither is skipped', (t) => {
  const h = setup(t);
  const at = NOW - 30_000;
  const rows = [
    row(ALICE, { sevenDay: { pct: 34 } }, at),
    row(BOB, { fiveHour: { pct: null, resetsAt: null }, sevenDay: {}, spend: { limit: 50, currency: 'USD' } }, at),
    { ...DAVE, usageStatus: 'api_key', usage: null },
    row({ number: 5, email: 'erin@example.com', organizationUuid: 'org-erin' }, { fiveHour: { pct: 0, resetsAt: null } }, at),
  ];
  assert.deepEqual(refresh(h, NOW, rows), { samples: 2, act: true });
  assert.deepEqual(allLines(h.dir), [
    { t: S(at), k: K_ALICE, a: 1, w: 34 },
    { t: S(at), k: historyKey('erin@example.com', 'org-erin'), h: 0 },
    { t: S(NOW), act: K_ALICE },
  ]);
  // Accounts without a line are not in the index yet.
  assert.deepEqual(Object.keys(readIndex(h.dir).accounts).sort(), [K_ALICE, historyKey('erin@example.com', 'org-erin')].sort());
});

test('act lines: first refresh, every change of the active account, and again after a restart', (t) => {
  const h = setup(t);
  const rows = (at) => [row(ALICE, usage(20, 34), at), row(BOB, usage(80, 61), at)];
  assert.equal(refresh(h, NOW, rows(NOW - 30_000), 1).act, true);
  assert.equal(refresh(h, NOW + MIN, rows(NOW - 30_000), 1).act, false);
  // A switch, made here or by `cswap auto` elsewhere, shows as a new active row.
  assert.equal(refresh(h, NOW + 2 * MIN, rows(NOW - 30_000), 2).act, true);
  assert.equal(refresh(h, NOW + 3 * MIN, rows(NOW - 30_000), 2).act, false);
  // No active account (an unmanaged login), then bob again: that is a change too.
  assert.equal(refresh(h, NOW + 4 * MIN, rows(NOW - 30_000), null).act, false);
  assert.equal(refresh(h, NOW + 5 * MIN, rows(NOW - 30_000), 2).act, true);
  // Only activeAccountNumber, no `active` flags on the rows.
  const flagless = { ...state(NOW + 6 * MIN, rows(NOW - 30_000), 1) };
  flagless.accounts = flagless.accounts.map(({ active, ...r }) => r);
  h.clock.ms = NOW + 6 * MIN;
  assert.equal(h.store.record(flagless).act, true);
  h.store = h.reopen();
  assert.equal(refresh(h, NOW + 7 * MIN, rows(NOW - 30_000), 1).act, true);
  assert.deepEqual(acts(h.dir), [K_ALICE, K_BOB, K_BOB, K_ALICE, K_ALICE]);
  const times = allLines(h.dir).filter((l) => l.act).map((l) => l.t);
  assert.deepEqual(times, [0, 2, 5, 6, 7].map((m) => S(NOW + m * MIN)));
});

test('states without a new list are ignored and create nothing', (t) => {
  const h = setup(t);
  const rows = [row(ALICE, usage(20, 34), NOW - 30_000)];
  for (const phase of ['loading', 'missing', 'too-old', 'no-accounts', 'error']) {
    assert.deepEqual(h.store.record({ ...state(NOW, rows), phase }), { samples: 0, act: false });
  }
  assert.deepEqual(h.store.record({ ...state(NOW, rows), fetchedAt: null }), { samples: 0, act: false });
  assert.deepEqual(h.store.record(null), { samples: 0, act: false });
  assert.equal(fs.existsSync(h.dir), false);
  const s = state(NOW, rows);
  assert.equal(h.store.record(s).samples, 1);
  // The service emits the same list again with refreshing / switching flags.
  assert.deepEqual(h.store.record({ ...s, refreshing: true }), { samples: 0, act: false });
  assert.deepEqual(h.store.record({ ...s, switching: true, accounts: s.accounts.map((r) => ({ ...r, active: false })) }), { samples: 0, act: false });
  assert.equal(allLines(h.dir).length, 2);
});

test('measurements far in the future or older than the retention are refused', (t) => {
  const h = setup(t);
  const future = row(ALICE, usage(99, 99), NOW + 2 * DAY);
  const ancient = { ...DAVE, usageStatus: 'token_expired', usage: null, lastGoodUsage: usage(42, 50), lastGoodFetchedAt: iso(NOW - 40 * DAY) };
  assert.deepEqual(refresh(h, NOW, [future, ancient]), { samples: 0, act: true });
  // A clock that runs a little ahead (the fake's drift scenario) is fine,
  // and the refused line did not block the next one.
  assert.deepEqual(refresh(h, NOW + MIN, [row(ALICE, usage(20, 34), NOW + 15 * MIN)]), { samples: 1, act: false });
  assert.deepEqual(fs.readdirSync(h.dir).sort(), ['2026-09-29.jsonl', 'accounts.json']);
  assert.equal(h.store.get(K_ALICE, 1).samples.length, 1);
});

// --- files on disk ------------------------------------------------------------

test('a torn last line is skipped by the reader, and the next append starts on a new line', (t) => {
  const h = setup(t);
  writeLines(h.dir, '2026-09-29.jsonl', [{ t: S(NOW - 20 * MIN), k: K_ALICE, h: 10 }, 'not json', '{"t":"x"}'], {
    torn: `{"t":${S(NOW - 10 * MIN)},"k":"${K_ALICE}","h":1`,
  });
  assert.deepEqual(h.store.get(K_ALICE, 1).samples, [{ t: S(NOW - 20 * MIN), h: 10 }]);
  // The torn measurement is not known to the dedupe, so it can be written again.
  refresh(h, NOW, [row(ALICE, usage(15, 30), NOW - 10 * MIN)]);
  const text = fs.readFileSync(path.join(h.dir, '2026-09-29.jsonl'), 'utf8');
  assert.ok(text.includes(`"h":1\n{"t":${S(NOW - 10 * MIN)}`), text);
  assert.deepEqual(h.store.get(K_ALICE, 1).samples.map((s) => s.h), [10, 15]);
  assert.deepEqual(h.store.get(K_ALICE, 1).switches, [{ t: S(NOW), key: K_ALICE }]);
});

test('prune at start: files older than 32 days go, the boundary day stays, orphaned index entries go', (t) => {
  const h = setup(t);
  const K_GONE = historyKey('gone@example.com', '');
  const K_GHOST = historyKey('ghost@example.com', '');
  for (let d = 0; d <= 40; d++) {
    const ms = NOW - d * DAY;
    writeLines(h.dir, `${day(ms)}.jsonl`, [{ t: S(ms), k: K_ALICE, h: d }, ...(d === 35 ? [{ t: S(ms), k: K_GONE, h: 1 }] : [])]);
  }
  const entry = (email) => ({ email, organizationUuid: null, organizationName: null, alias: null, currency: null, firstSeen: 1, lastSeen: 2 });
  fs.writeFileSync(
    path.join(h.dir, 'accounts.json'),
    JSON.stringify({ v: 1, accounts: { [K_ALICE]: entry('alice@example.com'), [K_GONE]: entry('gone@example.com'), [K_GHOST]: entry('ghost@example.com') } })
  );
  fs.writeFileSync(path.join(h.dir, 'notes.txt'), 'not ours');

  h.store.open();
  const cutoff = day(NOW - RETENTION_DAYS * DAY); // 2026-08-28: its later hours are still inside 32 days
  assert.equal(cutoff, '2026-08-28');
  const files = fs.readdirSync(h.dir).filter((n) => n.endsWith('.jsonl')).sort();
  assert.equal(files[0], '2026-08-28.jsonl');
  assert.equal(files.length, 33);
  assert.ok(fs.existsSync(path.join(h.dir, 'notes.txt')));
  const index = readIndex(h.dir).accounts;
  assert.deepEqual(Object.keys(index), [K_ALICE]);
  assert.equal(index[K_ALICE].email, 'alice@example.com');
  assert.equal(index[K_ALICE].firstSeen, S(NOW - 32 * DAY));
  assert.equal(index[K_ALICE].lastSeen, S(NOW));
  // At most 31 days are served.
  assert.deepEqual(h.store.get(K_ALICE, 99).samples.map((s) => s.h), [31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.equal(SERVE_DAYS, 31);
});

test('prune on the first write of a new UTC day; an account still in the list keeps its entry', (t) => {
  const h = setup(t);
  const bobAt = NOW - 31.9 * DAY; // 2026-08-28, still inside the 32 days
  const rows = [row(ALICE, usage(20, 34), NOW - 30_000), row(BOB, usage(5, 12), bobAt)];
  refresh(h, NOW, rows);
  assert.ok(fs.existsSync(path.join(h.dir, '2026-08-28.jsonl')));

  refresh(h, NOW + 11 * HOUR, rows); // same UTC day: nothing pruned
  assert.ok(fs.existsSync(path.join(h.dir, '2026-08-28.jsonl')));

  refresh(h, NOW + DAY, rows); // 2026-09-30: 2026-08-28 is out
  assert.equal(fs.existsSync(path.join(h.dir, '2026-08-28.jsonl')), false);
  const bob = readIndex(h.dir).accounts[K_BOB];
  assert.equal(bob.email, 'bob@example.com');
  assert.equal(bob.firstSeen, null);
  assert.deepEqual(h.store.get(K_BOB, 31), { key: K_BOB, currency: null, since: null, samples: [], switches: [{ t: S(NOW), key: K_ALICE }] });

  refresh(h, NOW + 2 * DAY, [rows[0]]); // bob left claude-swap and has no lines: dropped
  assert.deepEqual(Object.keys(readIndex(h.dir).accounts), [K_ALICE]);
});

test('get(): validates the key and the days, serves sorted, cleaned samples plus switches', (t) => {
  const h = setup(t);
  for (const bad of ['zzz', 'ABCDEF123456', `${K_ALICE}0`, '../../etc/pa', null, 42]) {
    assert.throws(() => h.store.get(bad, 7), TypeError, String(bad));
  }
  assert.throws(() => h.store.get(K_ALICE, 7.5), TypeError);
  assert.throws(() => h.store.get(K_ALICE, '7'), TypeError);

  writeLines(h.dir, `${day(NOW - 3 * DAY)}.jsonl`, [{ t: S(NOW - 3 * DAY), k: K_ALICE, h: 3, x: 'dropped' }, { t: S(NOW - 3 * DAY), act: K_BOB }]);
  writeLines(h.dir, `${day(NOW - 20 * DAY)}.jsonl`, [{ t: S(NOW - 20 * DAY), k: K_ALICE, h: 20 }]);
  writeLines(h.dir, `${day(NOW - 31.5 * DAY)}.jsonl`, [{ t: S(NOW - 31.5 * DAY), k: K_ALICE, h: 31 }]);
  // Back-filled later, so out of order in its file.
  writeLines(h.dir, `${day(NOW)}.jsonl`, [{ t: S(NOW - HOUR), k: K_ALICE, h: 1 }, { t: S(NOW - 2 * HOUR), k: K_ALICE, h: 2 }, { t: S(NOW - HOUR), k: K_BOB, h: 50 }]);

  assert.deepEqual(h.store.get(K_ALICE, 1).samples, [{ t: S(NOW - 2 * HOUR), h: 2 }, { t: S(NOW - HOUR), h: 1 }]);
  assert.deepEqual(h.store.get(K_ALICE, 0).samples.length, 2); // clamped to 1 day
  const week = h.store.get(K_ALICE, 7);
  assert.deepEqual(week.samples.map((s) => s.h), [3, 2, 1]);
  assert.deepEqual(week.samples[0], { t: S(NOW - 3 * DAY), h: 3 });
  assert.deepEqual(week.switches, [{ t: S(NOW - 3 * DAY), key: K_BOB }]);
  assert.deepEqual(h.store.get(K_ALICE, 99).samples.map((s) => s.h), [20, 3, 2, 1]); // clamped to 31 days
  assert.equal(h.store.get(K_ALICE, 31).since, S(NOW - 31.5 * DAY)); // first line still on disk
  assert.deepEqual(h.store.get(historyKey('nobody@example.com', ''), 7).samples, []);
});

test('accounts(): index entries, the current list first, with present and active', (t) => {
  const h = setup(t);
  refresh(h, NOW, [row(ALICE, usage(20, 34), NOW - 30_000), row(BOB, usage(80, 61, { spend: { used: 1, currency: 'EUR' } }), NOW - 60_000)], 2);
  const list = h.store.accounts();
  assert.deepEqual(list.map((a) => [a.key, a.present, a.active]), [[K_ALICE, true, false], [K_BOB, true, true]]);
  assert.equal(list[1].currency, 'EUR');
  assert.equal(list[0].alias, 'work');
  // Alice was removed from claude-swap: still listed, after the current ones.
  const later = state(NOW + MIN, [row(BOB, usage(80, 61), NOW - 60_000)], 2);
  assert.deepEqual(h.store.accounts(later).map((a) => [a.key, a.present, a.active]), [[K_BOB, true, true], [K_ALICE, false, false]]);
  // Callers cannot change the index through the result.
  list[0].email = 'mallory@example.com';
  assert.equal(h.store.accounts()[0].email, 'alice@example.com');
});

test('the index: written only for new accounts or new names, lastSeen on flush, rebuilt when lost', (t) => {
  const h = setup(t);
  const file = path.join(h.dir, 'accounts.json');
  refresh(h, NOW, [row(ALICE, usage(20, 34), NOW - 30_000)]);
  const first = fs.readFileSync(file, 'utf8');
  refresh(h, NOW + 5 * MIN, [row(ALICE, usage(22, 34), NOW + 4 * MIN)]);
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'a new measurement alone does not rewrite the index');
  assert.equal(h.store.accounts()[0].lastSeen, S(NOW + 4 * MIN));
  assert.equal(h.store.flush(), true);
  assert.equal(readIndex(h.dir).accounts[K_ALICE].lastSeen, S(NOW + 4 * MIN));
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // An org rename is written at once.
  refresh(h, NOW + 6 * MIN, [row({ ...ALICE, organizationName: 'Acme Inc' }, usage(22, 34), NOW + 4 * MIN)]);
  assert.equal(readIndex(h.dir).accounts[K_ALICE].organizationName, 'Acme Inc');

  // Lost index: the day files still give the keys and the times; the names
  // come back with the next list.
  fs.rmSync(file);
  h.store = h.reopen();
  const [lost] = h.store.accounts();
  assert.deepEqual([lost.key, lost.email, lost.firstSeen, lost.lastSeen], [K_ALICE, null, S(NOW - 30_000), S(NOW + 4 * MIN)]);
  assert.equal(readIndex(h.dir).accounts[K_ALICE].email, null); // repaired on open
  refresh(h, NOW + 7 * MIN, [row(ALICE, usage(22, 34), NOW + 4 * MIN)]);
  assert.equal(readIndex(h.dir).accounts[K_ALICE].email, 'alice@example.com');
});

test('a write error is logged once and pauses recording; resume() starts again', (t) => {
  const h = setup(t, { dir: (root) => path.join(root, 'blocker', 'history') });
  const blocker = path.dirname(h.dir);
  fs.writeFileSync(blocker, 'a file where the folder should be');
  const rows = (at) => [row(ALICE, usage(20, 34), at)];
  assert.deepEqual(refresh(h, NOW, rows(NOW - 30_000)), { samples: 0, act: false });
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /^history: cannot write .*recording paused$/);
  assert.ok(h.store.error);
  assert.deepEqual(refresh(h, NOW + MIN, rows(NOW + 30_000)), { samples: 0, act: false });
  assert.equal(h.logs.length, 1, 'logged once');
  // Reading still works (and finds nothing).
  assert.deepEqual(h.store.get(K_ALICE, 7).samples, []);

  fs.rmSync(blocker);
  h.store.resume();
  assert.deepEqual(refresh(h, NOW + 2 * MIN, rows(NOW + 90_000)), { samples: 1, act: true });
  assert.equal(h.store.error, null);
});

test('clear() deletes the history files only, and the next refresh starts over', (t) => {
  const h = setup(t);
  const rows = [row(ALICE, usage(20, 34), NOW - 30_000), row(BOB, usage(80, 61), NOW - 3 * DAY)];
  refresh(h, NOW, rows);
  fs.writeFileSync(path.join(h.dir, 'keep.txt'), 'not ours');
  assert.equal(h.store.clear(), true);
  assert.deepEqual(fs.readdirSync(h.dir), ['keep.txt']);
  assert.deepEqual(h.store.accounts(), []);
  assert.deepEqual(h.store.get(K_ALICE, 31).samples, []);
  // The same list again: written again, with an act line, as a fresh start.
  assert.deepEqual(refresh(h, NOW + MIN, rows), { samples: 2, act: true });
  assert.equal(Object.keys(readIndex(h.dir).accounts).length, 2);
});

// --- with the fake cswap ------------------------------------------------------

function pinFake(t, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-fake-'));
  const saved = { ...process.env };
  process.env.FAKE_CSWAP_SCENARIO = scenario;
  process.env.FAKE_CSWAP_STATE = path.join(dir, 'state.json');
  delete process.env.FAKE_CSWAP_VERSION;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'history');
}

const fakeHas = (scenario) => fs.readFileSync(FAKE, 'utf8').includes(scenario);

test('records the fake cswap list as main would: 5 samples, 1 act line, 5 index entries', async (t) => {
  const dir = pinFake(t, 'default');
  const svc = new AccountService({ find: () => FAKE });
  const store = new HistoryStore({ dir, log: () => {} });
  svc.on('state', (s) => store.record(s));
  const s = await svc.refresh();
  const lines = allLines(dir);
  assert.equal(lines.filter((l) => l.k).length, 5);
  assert.deepEqual(acts(dir), [K_ALICE]);
  const byKey = Object.fromEntries(lines.filter((l) => l.k).map((l) => [l.k, l]));
  const carol = byKey[historyKey('carol@example.com', 'org-globex')];
  assert.deepEqual([carol.h, carol.w, carol.m, carol.u, carol.l], [95, 88, { Fable: 76 }, 12.4, 50]);
  assert.equal(byKey[K_ALICE].a, 1);
  // dave's last good data is back-filled 5400 s before cswap's own clock.
  const dave = byKey[K_DAVE];
  assert.deepEqual([dave.h, dave.w], [42, 50]);
  assert.ok(Math.abs(dave.t - (S(Date.parse(s.fetchedAt)) - 5400)) <= 5, `${dave.t} vs ${s.fetchedAt}`);
  const index = readIndex(dir).accounts;
  assert.equal(Object.keys(index).length, 5);
  assert.equal(index[historyKey('carol@example.com', 'org-globex')].currency, 'USD');
  assert.equal(index[K_ALICE].alias, 'work');
});

test('fake cswap `nofetchedat`: times come from the ages', { skip: !fakeHas('nofetchedat') && 'fake has no nofetchedat yet' }, async (t) => {
  const dir = pinFake(t, 'nofetchedat');
  const svc = new AccountService({ find: () => FAKE });
  const store = new HistoryStore({ dir, log: () => {} });
  svc.on('state', (s) => store.record(s));
  const s = await svc.refresh();
  assert.equal(s.accounts.some((a) => 'usageFetchedAt' in a || 'lastGoodFetchedAt' in a), false);
  const fetched = S(Date.parse(s.fetchedAt));
  const byKey = Object.fromEntries(allLines(dir).filter((l) => l.k).map((l) => [l.k, l]));
  assert.equal(Object.keys(byKey).length, 5);
  const age = (email, org, field) => s.accounts.find((a) => a.email === email)[field];
  const carolKey = historyKey('carol@example.com', 'org-globex');
  assert.ok(Math.abs(byKey[carolKey].t - (fetched - age('carol@example.com', 'org-globex', 'usageAgeSeconds'))) <= 1);
  assert.ok(Math.abs(byKey[K_DAVE].t - (fetched - age('dave@example.com', 'org-dave', 'lastGoodAgeSeconds'))) <= 1);
  // A second refresh right away is the same measurement.
  await svc.refresh();
  assert.equal(allLines(dir).filter((l) => l.k).length, 5);
});

test('fake cswap `drift`: every list is one new line per measured account', { skip: !fakeHas('drift') && 'fake has no drift yet' }, async (t) => {
  const dir = pinFake(t, 'drift');
  const svc = new AccountService({ find: () => FAKE });
  const store = new HistoryStore({ dir, log: () => {} });
  svc.on('state', (s) => store.record(s));
  for (let i = 0; i < 3; i++) await svc.refresh();
  const lines = allLines(dir);
  // Four accounts with fresh usage measured three times; dave's last-good once.
  assert.equal(samplesOf(dir, K_ALICE).length, 3);
  assert.equal(samplesOf(dir, K_DAVE).length, 1);
  assert.equal(lines.filter((l) => l.k).length, 4 * 3 + 1);
  assert.deepEqual(acts(dir), [K_ALICE]);
  const h = samplesOf(dir, K_ALICE).map((l) => l.h);
  assert.deepEqual(h, [20, 23, 26]);
});
