#!/usr/bin/env node
'use strict';
// Writes synthetic usage history for the accounts of test/fixtures/fake-cswap,
// through the real HistoryStore, so the statistics view can be built and
// captured without a month of uptime:
//
//   node scripts/fake-history.js "$CSW_USER_DATA/history"
//
// It replays a month of our 60 s refreshes against a simulated cswap:
// - the app runs 07:30–23:30 local time, so every night is a gap and every
//   morning a restart (with its act line); it also runs during the last two
//   hours before --now, so "Today" has fresh data;
// - cswap measures on its own cadence (the active account every 180–300 s,
//   the others every 300–600 s, 600 s once exhausted), so most refreshes
//   bring nothing new and the store's dedupe works as it does in the app;
// - the active account is worked on in office hours: its 5h climbs and
//   resets (a sawtooth), its 7d climbs through the week;
// - alice → bob 10 days ago → alice 4 days ago: two switches;
// - carol is used from another machine, with extra-usage spend that resets
//   on the 1st (UTC) and a scoped "Fable" weekly limit;
// - dave's token expires 2 days ago (only lastGoodUsage after that); erin
//   is disabled and idle;
// - --gone adds frank, who left claude-swap 10 days ago (the picker's
//   "No longer in claude-swap" group).
// Then it prints what it wrote, and the measured time for a cold store to
// read one account's last 31 days.
//
// Options: --days N (default 32), --now <ISO date | epoch ms> (default: now),
// --seed N (default 1), --gone, --clear (empty the history files there
// first), --force (allow the real app's folder). Output depends on TZ.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, historyKey } = require('../src/history');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const REAL_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude Swap Widget');

const personal = (email) => ({ organizationName: `${email}'s Organization`, organizationUuid: `org-${email.split('@')[0]}` });

// Same identities and slots as the fake cswap, so its live list matches.
// weekEndsIn: when the current 7d window resets, counted from --now.
const ACCOUNTS = [
  { number: 1, email: 'alice@example.com', alias: 'work', organizationName: 'Acme Corp', organizationUuid: 'org-acme', weekEndsIn: 76 * HOUR },
  { number: 2, email: 'bob@example.com', ...personal('bob@example.com'), weekEndsIn: 30 * HOUR },
  { number: 3, email: 'carol@example.com', organizationName: 'Globex', organizationUuid: 'org-globex', weekEndsIn: 100 * HOUR, remote: true, spendLimit: 50, scoped: 'Fable' },
  { number: 4, email: 'dave@example.com', ...personal('dave@example.com'), weekEndsIn: 50 * HOUR, expiresAgo: 2 * DAY },
  { number: 5, email: 'erin@example.com', ...personal('erin@example.com'), weekEndsIn: 140 * HOUR, disabled: true },
];
const FRANK = { number: 6, email: 'frank@example.com', ...personal('frank@example.com'), weekEndsIn: 10 * HOUR, goneAgo: 10 * DAY };

// Local-time blocks (hours) in which an account is worked on.
const OFFICE = [[9, 12.5], [13.5, 18], [20, 22]];
const REMOTE = [[10, 17]];

function usage(msg) {
  process.stderr.write(`${msg}\nusage: node scripts/fake-history.js <history dir> [--days N] [--now ISO|ms] [--seed N] [--gone] [--clear] [--force]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { dir: null, days: 32, now: Date.now(), seed: 1, gone: false, clear: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    if (a === '--days') o.days = Number(value());
    else if (a === '--now') {
      const v = value();
      o.now = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    } else if (a === '--seed') o.seed = Number(value());
    else if (a === '--gone') o.gone = true;
    else if (a === '--clear') o.clear = true;
    else if (a === '--force') o.force = true;
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (!o.dir) o.dir = path.resolve(a);
    else usage(`unexpected argument ${a}`);
  }
  if (!o.dir) usage('no history folder given');
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 60) usage('--days must be 1…60');
  if (!Number.isFinite(o.now)) usage('--now is not a date');
  if (!Number.isInteger(o.seed)) usage('--seed must be an integer');
  return o;
}

// Small seeded PRNG (mulberry32): the same seed, --now and TZ give the same files.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const apiTime = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1417+00:00');
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const localHour = (ms) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};
const localAt = (ms, hours) => {
  const d = new Date(ms);
  d.setHours(hours, 0, 0, 0);
  return d.getTime();
};
const inBlocks = (ms, blocks) => blocks.some(([a, b]) => localHour(ms) >= a && localHour(ms) < b);
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

function simulate(o) {
  const rand = prng(o.seed);
  const end = Math.floor(o.now / MIN) * MIN;
  const start = end - o.days * DAY;
  const toBob = localAt(end - 10 * DAY, 14);
  const toAlice = localAt(end - 4 * DAY, 10);
  const activeAt = (t) => (t >= toBob && t < toAlice ? 2 : 1);
  const running = (t) => end - t <= 2 * HOUR || (localHour(t) >= 7.5 && localHour(t) < 23.5);
  const accounts = o.gone ? [...ACCOUNTS, FRANK] : ACCOUNTS;

  const sim = new Map(
    accounts.map((a) => {
      let weekEnd = end + a.weekEndsIn;
      while (weekEnd - WEEK > start) weekEnd -= WEEK;
      return [a.number, { five: 0, fiveStart: null, seven: 0, weekEnd, spent: 0, fable: 0, measured: null, measuredAt: 0, nextDue: 0 }];
    })
  );

  const snapshot = (a, s, t) => {
    const expected = 100 * (1 - (s.weekEnd - t) / WEEK);
    const u = {
      fiveHour: { pct: round(s.five, 1), resetsAt: s.fiveStart === null ? null : apiTime(s.fiveStart + 5 * HOUR) },
      sevenDay: { pct: round(s.seven, 1), resetsAt: apiTime(s.weekEnd), expectedPct: round(expected, 1), aheadOfPace: s.seven > expected },
    };
    if (a.spendLimit) u.spend = { used: round(s.spent, 2), limit: a.spendLimit, pct: round((100 * s.spent) / a.spendLimit, 1), currency: 'USD' };
    if (a.scoped) u.scoped = [{ name: a.scoped, pct: round(s.fable, 1), resetsAt: apiTime(s.weekEnd) }];
    return u;
  };

  const rowOf = (a, s, active, t) => {
    const r = {
      number: a.number,
      email: a.email,
      organizationName: a.organizationName,
      organizationUuid: a.organizationUuid,
      isOrganization: true,
      active: a.number === active,
      usageStatus: 'ok',
      usage: null,
    };
    if (a.alias) r.alias = a.alias;
    if (a.disabled) r.disabled = true;
    const age = round((t - s.measuredAt) / 1000, 1);
    if (a.expiresAgo && t >= end - a.expiresAgo) {
      r.usageStatus = 'token_expired';
      if (s.measured) Object.assign(r, { lastGoodUsage: s.measured, lastGoodFetchedAt: iso(s.measuredAt), lastGoodAgeSeconds: age });
    } else if (s.measured) {
      Object.assign(r, { usage: s.measured, usageFetchedAt: iso(s.measuredAt), usageAgeSeconds: age });
    }
    return r;
  };

  let clock = start;
  let store = null;
  let wasRunning = false;
  let dayKey = null;
  let intensity = 1;
  let refreshes = 0;
  let sessions = 0;
  for (let t = start; t <= end; t += MIN) {
    clock = t;
    const day = new Date(t).toDateString();
    if (day !== dayKey) {
      dayKey = day;
      const weekend = [0, 6].includes(new Date(t).getDay());
      intensity = (0.35 + 1.25 * rand()) * (weekend ? 0.25 : 1);
    }
    const active = activeAt(t);

    // What really happens to each account this minute.
    for (const a of accounts) {
      const s = sim.get(a.number);
      if (t >= s.weekEnd) {
        s.seven = 0;
        s.fable = 0;
        s.weekEnd += WEEK;
      }
      if (s.fiveStart !== null && t >= s.fiveStart + 5 * HOUR) {
        s.five = 0;
        s.fiveStart = null;
      }
      if (monthOf(t) !== monthOf(t - MIN)) s.spent = 0;
      const worked = a.remote ? inBlocks(t, REMOTE) && intensity > 0.3 : a.number === active && inBlocks(t, OFFICE);
      if (!worked || a.disabled || s.five >= 100 || s.seven >= 100 || rand() > 0.55) continue;
      const g = intensity * (a.remote ? 0.5 : 1) * (0.15 + 0.7 * rand());
      if (s.fiveStart === null) s.fiveStart = t;
      s.five = Math.min(100, s.five + g);
      s.seven = Math.min(100, s.seven + g * 0.11);
      if (a.scoped) s.fable = Math.min(100, s.fable + g * 0.09);
      if (a.spendLimit) s.spent = Math.min(a.spendLimit, s.spent + g * 0.03);
    }

    // Our refresh, while the app runs; a restart after every gap.
    const isRunning = running(t);
    if (isRunning && !wasRunning) {
      store = new HistoryStore({ dir: o.dir, now: () => clock });
      sessions++;
    }
    wasRunning = isRunning;
    if (!isRunning) continue;
    const roster = accounts.filter((a) => !(a.goneAgo && t >= end - a.goneAgo));
    for (const a of roster) {
      const s = sim.get(a.number);
      if ((a.expiresAgo && t >= end - a.expiresAgo) || t < s.nextDue) continue;
      s.measured = snapshot(a, s, t);
      s.measuredAt = t - (1 + Math.floor(rand() * 3)) * 1000;
      const exhausted = s.five >= 100 || s.seven >= 100;
      const [lo, hi] = exhausted ? [600, 600] : a.number === active ? [180, 300] : [300, 600];
      s.nextDue = t + (lo + (hi - lo) * rand()) * 1000;
    }
    store.record({
      phase: 'ok',
      cswap: { path: 'fake-history', version: '0.27.0b1', configured: false },
      accounts: roster.map((a) => rowOf(a, sim.get(a.number), active, t)),
      activeAccountNumber: active,
      fetchedAt: new Date(t).toISOString(),
      error: null,
      refreshing: false,
      switching: false,
    });
    refreshes++;
  }
  if (store && !store.flush()) throw new Error(`could not write ${o.dir}: ${store.error}`);
  return { start, end, refreshes, sessions, accounts };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.force && (o.dir + path.sep).startsWith(REAL_DIR + path.sep)) {
    usage(`refusing to write into the app's real history (${o.dir}); use a CSW_USER_DATA folder, or --force`);
  }
  const ours = (n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) || n === 'accounts.json';
  const existing = fs.existsSync(o.dir) ? fs.readdirSync(o.dir).filter(ours) : [];
  if (existing.length && !o.clear) usage(`${o.dir} already holds history (${existing.length} files); pass --clear to replace it`);
  if (existing.length && !new HistoryStore({ dir: o.dir }).clear()) throw new Error(`could not clear ${o.dir}`);

  const began = process.hrtime.bigint();
  const run = simulate(o);
  const took = Number(process.hrtime.bigint() - began) / 1e6;

  const files = fs.readdirSync(o.dir).filter((n) => n.endsWith('.jsonl')).sort();
  let bytes = 0;
  let lines = 0;
  const perKey = new Map();
  for (const n of files) {
    const text = fs.readFileSync(path.join(o.dir, n), 'utf8');
    bytes += Buffer.byteLength(text);
    for (const line of text.split('\n')) {
      if (!line) continue;
      lines++;
      const l = JSON.parse(line);
      const k = l.act ? 'act' : l.k;
      perKey.set(k, (perKey.get(k) || 0) + 1);
    }
  }
  const indexBytes = fs.statSync(path.join(o.dir, 'accounts.json')).size;

  // The measurement: a cold store (a fresh app start) reads one account's 31 days.
  const aliceKey = historyKey('alice@example.com', 'org-acme');
  const t0 = process.hrtime.bigint();
  const cold = new HistoryStore({ dir: o.dir, now: () => run.end });
  cold.open();
  const t1 = process.hrtime.bigint();
  const got = cold.get(aliceKey, 31);
  const t2 = process.hrtime.bigint();
  const ms = (a, b) => (Number(b - a) / 1e6).toFixed(1);

  const out = [
    `history: ${o.dir}`,
    `simulated ${iso(run.start)} … ${iso(run.end)} (TZ ${Intl.DateTimeFormat().resolvedOptions().timeZone}, seed ${o.seed}): ${run.refreshes} refreshes in ${run.sessions} app sessions, ${took.toFixed(0)} ms`,
    `wrote ${files.length} day files, ${lines} lines, ${bytes} B (${(bytes / lines).toFixed(1)} B/line); accounts.json ${indexBytes} B`,
    ...run.accounts.map((a) => `  ${a.email.padEnd(20)} ${historyKey(a.email, a.organizationUuid)}  ${perKey.get(historyKey(a.email, a.organizationUuid)) || 0} lines`),
    `  act lines${' '.repeat(26)}${perKey.get('act') || 0}`,
    `measured (n = 1, ${new Date().toISOString().slice(0, 10)}, Node ${process.versions.node}): cold open (index + scan of every day file + prune) ${ms(t0, t1)} ms; get(alice, 31) ${ms(t1, t2)} ms → ${got.samples.length} samples, ${got.switches.length} switches`,
  ];
  process.stdout.write(out.join('\n') + '\n');
}

main();
