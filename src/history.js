'use strict';
// Retention (32 days kept, 31 served) follows Claude Usage Widget — The Maestro edition (main.js:109,129 @ b79d4b1); MIT, see LICENSE, "Third-party code".
//
// Usage history for the statistics view. Main process only, pure Node.
//
// One JSON line per new cswap measurement, in `<dir>/YYYY-MM-DD.jsonl` by
// the UTC date of the measurement, plus `<dir>/accounts.json`, the only file
// that maps the hashed keys back to emails (no credentials anywhere):
//
//   {"t":<epoch s>,"k":"<12 hex>","a":1?,"h":20.4?,"w":34.1?,"r5":<epoch min>?,"m":{"Fable":76}?,"u":12.4?,"l":50?}
//   {"t":<epoch s of our fetchedAt>,"act":"<12 hex>"}      the active account, at start and on every change
//
// cswap re-measures each account every 3–10 min whatever our refresh rate, so
// a line is written only when a row's measurement time is newer than the last
// one stored for that account. Appends only: a torn last line (crash, full
// disk) is skipped by the reader and the next append starts on a new line.
// A failed write is logged once and pauses recording; the app keeps working.
//
// Times in the files and in everything returned are epoch seconds; `now` is
// a Date.now-style clock in ms, injectable like the directory.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 32; // files kept; Maestro's HISTORY_RETENTION_DAYS
const SERVE_DAYS = 31; // the most a reader gets; Maestro's CHART_DAYS
const DAY_S = 86_400;
const KEY_RE = /^[0-9a-f]{12}$/;
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const INDEX_FILE = 'accounts.json';
// cswap runs on this machine, so a measurement far in the future is a broken
// row or clock; stored, it would block every later line through the dedupe
// and leave a day file that is never pruned. A little is tolerated: a clock
// step, or the fake cswap's `drift` scenario, whose clock runs ahead.
const MAX_SKEW_S = DAY_S;
// Without usageFetchedAt (old cswap) the time is our fetchedAt minus cswap's
// age, which wobbles by a second or two between refreshes. cswap never
// re-measures sooner than 180 s (SERVE_TTL_S), so 60 s of slack is safe.
const AGE_SLACK_S = 60;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v ? v : null);
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const utcDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

// Stable across `cswap move` renumbering and alias changes. The email is used
// exactly as cswap reports it, as service.resolveAccount() matches it.
function historyKey(email, organizationUuid) {
  return crypto.createHash('sha256').update(`${email}\n${organizationUuid || ''}`).digest('hex').slice(0, 12);
}

function rowKey(row) {
  return isObject(row) && text(row.email) ? historyKey(row.email, row.organizationUuid) : null;
}

function activeRow(state, rows) {
  return (
    rows.find((r) => r.active === true) ||
    (state.activeAccountNumber != null && rows.find((r) => r.number === state.activeAccountNumber)) ||
    null
  );
}

// The measurement a row carries and when cswap took it: fresh usage, else the
// last good one, back-filled at its own time. `how` says how sure the time is.
function measurement(row, fetchedMs) {
  const fresh = isObject(row.usage);
  const usage = fresh ? row.usage : isObject(row.lastGoodUsage) ? row.lastGoodUsage : null;
  if (!usage) return null;
  const at = Date.parse(fresh ? row.usageFetchedAt : row.lastGoodFetchedAt);
  if (Number.isFinite(at)) return { usage, t: Math.floor(at / 1000), how: 'exact' };
  const age = fresh ? row.usageAgeSeconds : row.lastGoodAgeSeconds;
  if (finite(age) && age >= 0) return { usage, t: Math.floor(fetchedMs / 1000 - age), how: 'age' };
  return { usage, t: Math.floor(fetchedMs / 1000), how: 'none' };
}

// The numbers of one line. A missing value is left out, never written as 0
// (a 0 would draw as a drop). null when neither 5h nor 7d is there (api_key).
function readings(usage) {
  const five = isObject(usage.fiveHour) ? usage.fiveHour : {};
  const seven = isObject(usage.sevenDay) ? usage.sevenDay : {};
  const v = {};
  if (finite(five.pct)) v.h = round(five.pct, 1);
  if (finite(seven.pct)) v.w = round(seven.pct, 1);
  if (!('h' in v) && !('w' in v)) return null;
  const reset = Date.parse(five.resetsAt);
  if (Number.isFinite(reset)) v.r5 = Math.round(reset / 60_000);
  if (Array.isArray(usage.scoped)) {
    const m = {};
    let n = 0;
    for (const s of usage.scoped) {
      if (isObject(s) && text(s.name) && s.name !== '__proto__' && finite(s.pct)) {
        m[s.name] = round(s.pct, 1);
        n++;
      }
    }
    if (n) v.m = m;
  }
  if (isObject(usage.spend) && finite(usage.spend.used)) {
    v.u = round(usage.spend.used, 2);
    if (finite(usage.spend.limit)) v.l = round(usage.spend.limit, 2);
  }
  return v;
}

// Same values → same string; for rows that carry no time at all.
const signature = (v) => JSON.stringify([v.h, v.w, v.r5, v.m, v.u, v.l]);

// One stored line, checked field by field, since the files can be edited or
// torn: { k, s: sample } or { act, t }, or null to skip it.
function parseLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(o) || !finite(o.t)) return null;
  if ('act' in o) return typeof o.act === 'string' && KEY_RE.test(o.act) ? { act: o.act, t: o.t } : null;
  if (typeof o.k !== 'string' || !KEY_RE.test(o.k)) return null;
  const s = { t: o.t };
  if (o.a === 1) s.a = 1;
  for (const f of ['h', 'w', 'r5']) if (finite(o[f])) s[f] = o[f];
  if (isObject(o.m)) {
    const m = {};
    let n = 0;
    for (const [name, v] of Object.entries(o.m)) {
      if (name !== '__proto__' && finite(v)) {
        m[name] = v;
        n++;
      }
    }
    if (n) s.m = m;
  }
  for (const f of ['u', 'l']) if (finite(o[f])) s[f] = o[f];
  return { k: o.k, s };
}

function cleanEntry(e) {
  const o = isObject(e) ? e : {};
  const orNull = (v) => (typeof v === 'string' ? v : null);
  return {
    email: orNull(o.email),
    organizationUuid: orNull(o.organizationUuid),
    organizationName: orNull(o.organizationName),
    alias: orNull(o.alias),
    currency: orNull(o.currency),
    firstSeen: finite(o.firstSeen) ? o.firstSeen : null,
    lastSeen: finite(o.lastSeen) ? o.lastSeen : null,
  };
}

function rowInfo(row) {
  return {
    email: row.email,
    organizationUuid: text(row.organizationUuid),
    organizationName: text(row.organizationName),
    alias: text(row.alias),
  };
}

class HistoryStore {
  constructor({ dir, now = Date.now, retentionDays = RETENTION_DAYS, log = (msg) => console.error(msg) } = {}) {
    if (typeof dir !== 'string' || !dir) throw new TypeError('HistoryStore needs a directory');
    this.dir = dir;
    this.now = now;
    this.retentionDays = retentionDays;
    this.log = log;
    this.error = null; // message of the write that failed; recording is paused until resume() or clear()
    this.reset();
  }

  reset() {
    this.loaded = false;
    this.index = {}; // key → cleanEntry()
    this.days = new Map(); // 'YYYY-MM-DD' → Map(key → { first, last }): what each file holds
    this.lastT = new Map(); // key → t of its newest sample line: the dedupe
    this.lastSig = new Map(); // key → signature of that line
    this.lastActKey = null; // what the last act line of this session named
    this.lastFetchedAt = null;
    this.present = []; // keys of the last recorded list, in cswap order
    this.activeKey = null;
    this.today = null;
    this.tailChecked = new Set();
    this.indexDirty = false; // something changed (lastSeen alone waits for a new day or flush())
    this.indexUrgent = false; // a key or a name changed: write it now
  }

  nowS() {
    return this.now() / 1000;
  }

  file(day) {
    return path.join(this.dir, `${day}.jsonl`);
  }

  listDir() {
    try {
      return fs.readdirSync(this.dir);
    } catch {
      return []; // no history yet, or unreadable: a reader shows nothing
    }
  }

  dayFiles() {
    return this.listDir()
      .filter((n) => DAY_FILE_RE.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }

  lines(day) {
    try {
      return fs.readFileSync(this.file(day), 'utf8').split('\n');
    } catch {
      return [];
    }
  }

  // Reads the index and every retained day file once, then prunes. All files,
  // not only the newest: a back-filled lastGoodUsage lands in an older one,
  // and missing it would write it again after every restart.
  open() {
    if (this.loaded) return this;
    this.loaded = true;
    let saved = {};
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX_FILE), 'utf8'));
      if (isObject(raw) && raw.v === 1 && isObject(raw.accounts)) saved = raw.accounts;
    } catch {}
    for (const day of this.dayFiles()) {
      for (const line of this.lines(day)) {
        const p = line && parseLine(line);
        if (p) this.note(day, p.act || p.k, p.act ? p.t : p.s.t, p.act ? null : p.s);
      }
    }
    // The files are the truth for firstSeen / lastSeen; the index adds names.
    for (const [key, span] of this.spans()) {
      this.index[key] = { ...cleanEntry(KEY_RE.test(key) ? saved[key] : null), firstSeen: span.first, lastSeen: span.last };
    }
    const before = Object.keys(saved).filter((k) => KEY_RE.test(k));
    if (before.length !== Object.keys(this.index).length || before.some((k) => !this.index[k])) {
      this.indexDirty = this.indexUrgent = true;
    }
    this.today = utcDay(this.nowS());
    this.prune();
    return this;
  }

  note(day, key, t, sample) {
    let keys = this.days.get(day);
    if (!keys) this.days.set(day, (keys = new Map()));
    const span = keys.get(key);
    if (!span) keys.set(key, { first: t, last: t });
    else {
      if (t < span.first) span.first = t;
      if (t > span.last) span.last = t;
    }
    if (sample && t >= (this.lastT.get(key) ?? -Infinity)) {
      this.lastT.set(key, t);
      this.lastSig.set(key, signature(sample));
    }
  }

  spans() {
    const all = new Map();
    for (const keys of this.days.values()) {
      for (const [key, { first, last }] of keys) {
        const s = all.get(key);
        if (!s) all.set(key, { first, last });
        else {
          s.first = Math.min(s.first, first);
          s.last = Math.max(s.last, last);
        }
      }
    }
    return all;
  }

  // Deletes the day files whose every line is older than the retention, and
  // the index entries that no remaining line names and the current list does
  // not hold. Runs at open() and on the first record() of a new UTC day.
  prune(presentKeys = this.present) {
    this.open();
    const cutoff = utcDay(this.nowS() - this.retentionDays * DAY_S);
    for (const day of new Set([...this.dayFiles(), ...this.days.keys()])) {
      if (day >= cutoff) continue;
      try {
        fs.rmSync(this.file(day), { force: true });
        this.days.delete(day);
      } catch (err) {
        this.log(`history: cannot delete ${this.file(day)}: ${err.message}`);
      }
    }
    const spans = this.spans();
    const keep = new Set(presentKeys);
    for (const [key, entry] of Object.entries(this.index)) {
      const span = spans.get(key);
      if (span) {
        if (entry.firstSeen !== span.first) {
          entry.firstSeen = span.first;
          this.indexDirty = true;
        }
      } else if (keep.has(key)) {
        if (entry.firstSeen !== null) {
          entry.firstSeen = entry.lastSeen = null;
          this.indexDirty = true;
        }
      } else {
        delete this.index[key];
        this.lastT.delete(key);
        this.lastSig.delete(key);
        this.indexDirty = this.indexUrgent = true;
      }
    }
    if (this.indexUrgent && !this.error) this.writeIndex();
  }

  // Call with every service state; states that bring no new list are ignored.
  // Writes a line for each account whose measurement is newer than the last
  // one stored, and an act line when the active account differs from the one
  // this session last wrote. Returns what it wrote.
  record(state) {
    const none = { samples: 0, act: false };
    if (!isObject(state) || state.phase !== 'ok' || !Array.isArray(state.accounts)) return none;
    const fetchedMs = Date.parse(state.fetchedAt);
    if (!Number.isFinite(fetchedMs) || state.fetchedAt === this.lastFetchedAt) return none;
    this.lastFetchedAt = state.fetchedAt;
    const rows = state.accounts.filter(isObject);
    const active = activeRow(state, rows);
    this.present = rows.map(rowKey).filter(Boolean);
    this.activeKey = active ? rowKey(active) : null;
    if (this.error) return none;
    this.open();
    if (this.error) return none;

    const nowS = this.nowS();
    const today = utcDay(nowS);
    if (today !== this.today) {
      this.today = today;
      this.prune();
      if (this.indexDirty && !this.error) this.writeIndex();
      if (this.error) return none;
    }
    const oldest = nowS - this.retentionDays * DAY_S;
    const newest = nowS + MAX_SKEW_S;
    const lines = [];
    const rowOf = new Map();
    for (const row of rows) {
      const key = rowKey(row);
      if (!key || rowOf.has(key)) continue;
      rowOf.set(key, row);
      const src = measurement(row, fetchedMs);
      const v = src && readings(src.usage);
      if (this.index[key]) this.updateInfo(key, row, src);
      if (!v || src.t < oldest || src.t > newest) continue;
      const last = this.lastT.get(key) ?? -Infinity;
      if (src.t <= last + (src.how === 'age' ? AGE_SLACK_S : 0)) continue;
      if (src.how === 'none' && this.lastSig.get(key) === signature(v)) continue;
      lines.push({ line: { t: src.t, k: key, ...(row === active ? { a: 1 } : {}), ...v }, src });
    }
    const actKey = this.activeKey;
    const fetchedS = Math.floor(fetchedMs / 1000);
    const act = Boolean(actKey) && actKey !== this.lastActKey && fetchedS >= oldest && fetchedS <= newest;
    if (act) lines.push({ line: { t: fetchedS, act: actKey } });

    if (lines.length && !this.append(lines.map((l) => l.line))) return none;
    if (!actKey || act) this.lastActKey = actKey;
    for (const { line, src } of lines) {
      const key = line.act || line.k;
      this.note(utcDay(line.t), key, line.t, line.act ? null : line);
      if (!this.index[key]) {
        this.index[key] = { ...cleanEntry(rowInfo(rowOf.get(key))), firstSeen: line.t, lastSeen: line.t };
        if (src) this.updateInfo(key, rowOf.get(key), src);
        this.indexDirty = this.indexUrgent = true;
      } else {
        const e = this.index[key];
        if (e.firstSeen === null || line.t < e.firstSeen) e.firstSeen = line.t;
        if (e.lastSeen === null || line.t > e.lastSeen) e.lastSeen = line.t;
        this.indexDirty = true;
      }
    }
    if (this.indexUrgent) this.writeIndex();
    return { samples: lines.length - (act ? 1 : 0), act };
  }

  // Keeps the names of a known account current; a change is written at once.
  updateInfo(key, row, src) {
    const e = this.index[key];
    const next = rowInfo(row);
    const spend = src && isObject(src.usage.spend) ? text(src.usage.spend.currency) : null;
    if (spend) next.currency = spend;
    for (const [f, v] of Object.entries(next)) {
      if (e[f] !== v) {
        e[f] = v;
        this.indexDirty = this.indexUrgent = true;
      }
    }
  }

  // One appendFileSync per UTC day touched: normally one per refresh.
  append(lines) {
    const byDay = new Map();
    for (const line of [...lines].sort((a, b) => a.t - b.t)) {
      const day = utcDay(line.t);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(line));
    }
    let target = this.dir;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const [day, texts] of byDay) {
        target = this.file(day);
        fs.appendFileSync(target, this.tailFix(target) + texts.join('\n') + '\n');
      }
      return true;
    } catch (err) {
      this.fail(target, err);
      return false;
    }
  }

  // A file left without its final newline (a torn line) gets one before the
  // first append of this session, so the new line is not glued to it.
  tailFix(file) {
    if (this.tailChecked.has(file)) return '';
    this.tailChecked.add(file);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return '';
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) return '';
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] === 0x0a ? '' : '\n';
    } finally {
      fs.closeSync(fd);
    }
  }

  writeIndex() {
    const file = path.join(this.dir, INDEX_FILE);
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, accounts: this.index }, null, 2));
      fs.renameSync(tmp, file);
      this.indexDirty = this.indexUrgent = false;
      return true;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      this.fail(file, err);
      return false;
    }
  }

  fail(file, err) {
    if (!this.error) this.log(`history: cannot write ${file}: ${err.message}; recording paused`);
    this.error = err.message;
  }

  // Writes lastSeen changes that are waiting (call before quitting).
  flush() {
    this.open();
    return this.indexDirty && !this.error ? this.writeIndex() : true;
  }

  // Recording back on (after a write error, or after the setting was off):
  // the next record() starts a session again, with an act line.
  resume() {
    this.error = null;
    this.lastActKey = null;
    this.lastFetchedAt = null;
  }

  // Deletes every history file (the folder stays) and starts over. False when
  // a file could not be removed; what is left is read again on next use.
  clear() {
    let ok = true;
    for (const name of this.listDir()) {
      if (!DAY_FILE_RE.test(name) && name !== INDEX_FILE && name !== `${INDEX_FILE}.tmp`) continue;
      try {
        fs.rmSync(path.join(this.dir, name), { force: true });
      } catch (err) {
        ok = false;
        this.log(`history: cannot delete ${path.join(this.dir, name)}: ${err.message}`);
      }
    }
    const { present, activeKey } = this;
    this.reset();
    Object.assign(this, { present, activeKey });
    this.error = null;
    return ok;
  }

  // One account's sample lines in [fromS, toS] and every act line there,
  // each sorted by t.
  read(key, fromS, toS) {
    this.open();
    const first = utcDay(fromS);
    const last = utcDay(toS);
    const samples = [];
    const switches = [];
    for (const day of this.dayFiles()) {
      if (day < first || day > last) continue;
      for (const line of this.lines(day)) {
        // Cheap filter before parsing: most lines belong to other accounts.
        if (!line.includes(key) && !line.includes('"act"')) continue;
        const p = parseLine(line);
        if (!p) continue;
        const t = p.act ? p.t : p.s.t;
        if (t < fromS || t > toS) continue;
        if (p.act) switches.push({ t, key: p.act });
        else if (p.k === key) samples.push(p.s);
      }
    }
    samples.sort((a, b) => a.t - b.t);
    switches.sort((a, b) => a.t - b.t);
    return { samples, switches };
  }

  // What `history:get` serves: the last `days` (1…31) of one account.
  // `since` is the account's first line still on disk (null: none).
  get(key, days = SERVE_DAYS) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TypeError('history key must be 12 hex characters');
    if (!Number.isInteger(days)) throw new TypeError('days must be an integer');
    const span = Math.min(SERVE_DAYS, Math.max(1, days));
    const nowS = this.nowS();
    const { samples, switches } = this.read(key, nowS - span * DAY_S, nowS + MAX_SKEW_S);
    const entry = this.index[key];
    return { key, currency: entry ? entry.currency : null, since: entry ? entry.firstSeen : null, samples, switches };
  }

  // Every account with history, the current list's first (in cswap order),
  // then the others, most recently seen first. `present` / `active` come from
  // `state` when given, else from the last recorded one. Accounts without any
  // line yet are not here; the caller adds them from its list.
  accounts(state) {
    this.open();
    let order = this.present;
    let activeKey = this.activeKey;
    if (isObject(state) && Array.isArray(state.accounts)) {
      const rows = state.accounts.filter(isObject);
      order = rows.map(rowKey).filter(Boolean);
      const a = activeRow(state, rows);
      activeKey = a ? rowKey(a) : null;
    }
    const rank = new Map(order.map((k, i) => [k, i]));
    return Object.entries(this.index)
      .map(([key, e]) => ({ key, ...e, present: rank.has(key), active: key === activeKey }))
      .sort((x, y) => (rank.get(x.key) ?? Infinity) - (rank.get(y.key) ?? Infinity) || (y.lastSeen ?? 0) - (x.lastSeen ?? 0));
  }
}

module.exports = { HistoryStore, historyKey, utcDay, parseLine, KEY_RE, RETENTION_DAYS, SERVE_DAYS, MAX_SKEW_S, AGE_SLACK_S };
