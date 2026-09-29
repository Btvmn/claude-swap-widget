'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccountService } = require('../src/service');
const { Cswap, CswapError } = require('../src/cswap');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cswap');

// Pin every knob of the fake, so a FAKE_CSWAP_* left in the shell (e.g. from
// `CSWAP_PATH=… npm start` sessions) cannot change what a test sees.
function pinFake(t, scenario = 'default') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-test-'));
  const saved = { ...process.env };
  process.env.FAKE_CSWAP_SCENARIO = scenario;
  process.env.FAKE_CSWAP_STATE = path.join(dir, 'state.json');
  delete process.env.FAKE_CSWAP_VERSION;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function withFake(t, scenario = 'default') {
  pinFake(t, scenario);
  return new AccountService({ find: () => FAKE });
}

// A scripted cswap: each method is an async function the test provides.
function stubService(methods, extra = {}) {
  return new AccountService({
    find: () => '/fake',
    makeCswap: () => ({ check: async () => '0.27.0', ...methods }),
    ...extra,
  });
}

const LIST = { schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1, active: true }, { number: 2, active: false }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('refresh loads accounts from the fake cswap', async (t) => {
  const svc = withFake(t);
  const phases = [];
  svc.on('state', (s) => phases.push(s.phase));
  const s = await svc.refresh();
  assert.equal(s.phase, 'ok');
  assert.equal(s.accounts.length, 5);
  assert.equal(s.activeAccountNumber, 1);
  assert.deepEqual(s.cswap, { path: FAKE, version: '0.27.0b1', configured: false });
  assert.equal(s.refreshing, false);
  assert.ok(s.fetchedAt);
  assert.equal(phases[0], 'loading');
  assert.ok(svc.ageSeconds() < 5);
});

test('concurrent refreshes share one cswap call', async () => {
  let lists = 0;
  const svc = new AccountService({
    find: () => '/fake',
    makeCswap: () => ({
      check: async () => '0.27.0',
      list: async () => {
        lists++;
        await new Promise((r) => setTimeout(r, 20));
        return { schemaVersion: 1, activeAccountNumber: 1, accounts: [] };
      },
    }),
  });
  const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
  assert.equal(a, b);
  assert.equal(lists, 1);
});

test('switch updates the active account at once, then refreshes', async (t) => {
  const svc = withFake(t);
  await svc.refresh();
  const r = await svc.switchTo(3);
  assert.equal(r.switched, true);
  // optimistic update before the follow-up list lands
  assert.equal(svc.state.activeAccountNumber, 3);
  assert.deepEqual(svc.state.accounts.filter((a) => a.active).map((a) => a.number), [3]);
  const after = await svc.refresh();
  assert.equal(after.activeAccountNumber, 3);
});

test('switch waits for a running refresh (calls never overlap)', async () => {
  const log = [];
  let running = 0;
  const slow = (name) => async () => {
    assert.equal(running, 0, `${name} overlapped another call`);
    running++;
    log.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, 15));
    log.push(`${name}:end`);
    running--;
    return name === 'switch'
      ? { schemaVersion: 1, switched: true, to: { number: 2 } }
      : { schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1, active: true }, { number: 2, active: false }] };
  };
  const svc = new AccountService({
    find: () => '/fake',
    makeCswap: () => ({ check: async () => '0.27.0', list: slow('list'), switchTo: slow('switch') }),
  });
  const refresh = svc.refresh();
  const sw = svc.switchTo(2);
  await Promise.all([refresh, sw]);
  assert.deepEqual(log.slice(0, 4), ['list:start', 'list:end', 'switch:start', 'switch:end']);
});

test('a failed refresh keeps the last good accounts and sets a banner', async () => {
  let fail = false;
  const svc = new AccountService({
    find: () => '/fake',
    makeCswap: () => ({
      check: async () => '0.27.0',
      list: async () => {
        if (fail) throw new CswapError('timeout', 'cswap did not answer in time');
        return { schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1, active: true }] };
      },
    }),
  });
  await svc.refresh();
  fail = true;
  const s = await svc.refresh();
  assert.equal(s.phase, 'ok');
  assert.equal(s.accounts.length, 1);
  assert.deepEqual(s.error, { kind: 'timeout', message: 'cswap did not answer in time' });
  fail = false;
  assert.equal((await svc.refresh()).error, null);
});

test('phases for setup problems', async (t) => {
  await t.test('missing binary', async () => {
    const svc = new AccountService({ find: () => null });
    const s = await svc.refresh();
    assert.equal(s.phase, 'missing');
    assert.equal(s.cswap, null);
  });
  await t.test('too old', async (t2) => {
    const svc = withFake(t2, 'old');
    const s = await svc.refresh();
    assert.equal(s.phase, 'too-old');
    assert.equal(s.cswap.version, '0.19.2');
  });
  await t.test('no accounts (cswap lists an empty install as accounts: [])', async (t2) => {
    const svc = withFake(t2, 'empty');
    const s = await svc.refresh();
    assert.equal(s.phase, 'no-accounts');
    assert.equal(s.error, null);
    assert.equal(s.activeAccountNumber, null);
    assert.ok(s.fetchedAt);
  });
  await t.test('no accounts, then the first `cswap add`', async () => {
    let accounts = [];
    const svc = stubService({ list: async () => ({ schemaVersion: 1, activeAccountNumber: null, accounts }) });
    assert.equal((await svc.refresh()).phase, 'no-accounts');
    accounts = [{ number: 1, active: true }];
    assert.equal((await svc.refresh()).phase, 'ok');
  });
  await t.test('a configured path that is gone is reported as that path', async () => {
    const svc = new AccountService({ getOverride: () => '/nope/cswap', find: ({ override }) => (override ? null : FAKE) });
    const s = await svc.refresh();
    assert.equal(s.phase, 'missing');
    assert.deepEqual(s.cswap, { path: '/nope/cswap', version: null, configured: true });
  });
  await t.test('plain-text failure with nothing to show', async (t2) => {
    const svc = withFake(t2, 'root');
    const s = await svc.refresh();
    assert.equal(s.phase, 'error');
    assert.match(s.error.message, /root/);
  });
  await t.test('binary disappears after it was found', async () => {
    let gone = false;
    const svc = new AccountService({
      find: () => '/fake',
      makeCswap: () => ({
        check: async () => '0.27.0',
        list: async () => {
          if (gone) throw new CswapError('not-installed', 'cswap could not be started (ENOENT)');
          return { schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1 }] };
        },
      }),
    });
    await svc.refresh();
    gone = true;
    const s = await svc.refresh();
    assert.equal(s.phase, 'missing');
    assert.equal(svc.cswap, null);
  });
  await t.test('a configured binary that vanishes at runtime is still named', async () => {
    let gone = false;
    const svc = new AccountService({
      getOverride: () => '/picked/cswap',
      find: ({ override }) => override,
      makeCswap: () => ({
        check: async () => '0.27.0',
        list: async () => {
          if (gone) throw new CswapError('not-installed', 'cswap could not be started (ENOENT)');
          return LIST;
        },
      }),
    });
    assert.equal((await svc.refresh()).cswap.configured, true);
    gone = true;
    const s = await svc.refresh();
    assert.equal(s.phase, 'missing');
    assert.deepEqual(s.cswap, { path: '/picked/cswap', version: null, configured: true });
  });
});

test('reconnect re-runs discovery with a new override', async (t) => {
  pinFake(t);
  let override = null;
  const svc = new AccountService({
    getOverride: () => override,
    find: ({ override: o }) => o || null,
    makeCswap: (binary) => new Cswap({ binary }),
  });
  assert.equal((await svc.refresh()).phase, 'missing');
  override = FAKE;
  const s = await svc.reconnect();
  assert.equal(s.phase, 'ok');
  assert.deepEqual(s.cswap, { path: FAKE, version: '0.27.0b1', configured: true });
});

// Two distinguishable binaries: which one ran the switch is recorded.
function twoBinaries({ newFound = true } = {}) {
  const log = [];
  let override = '/old';
  const svc = new AccountService({
    getOverride: () => override,
    find: ({ override: o }) => (o === '/new' && !newFound ? null : o),
    makeCswap: (bin) => ({
      check: async () => '0.27.0',
      list: async () => {
        await sleep(15);
        return LIST;
      },
      switchTo: async (t) => {
        log.push(`${bin}:switch`);
        return { schemaVersion: 1, switched: true, to: { number: t } };
      },
    }),
  });
  return { svc, log, setOverride: (o) => (override = o) };
}

test('reconnect does not pull the binary from under a queued switch', async (t) => {
  await t.test('work queued before reconnect runs on the old binary', async () => {
    const { svc, log, setOverride } = twoBinaries();
    await svc.refresh();
    const refresh = svc.refresh();
    const sw = svc.switchTo(2);
    setOverride('/new');
    const re = svc.reconnect();
    await refresh;
    assert.equal((await sw).switched, true);
    assert.equal((await re).cswap.path, '/new');
    assert.deepEqual(log, ['/old:switch']);
  });
  await t.test('even when the new binary cannot be found', async () => {
    const { svc, log, setOverride } = twoBinaries({ newFound: false });
    await svc.refresh();
    const sw = svc.switchTo(2);
    setOverride('/new');
    const re = svc.reconnect();
    assert.equal((await sw).switched, true);
    assert.equal((await re).phase, 'missing');
    assert.deepEqual(log, ['/old:switch']);
  });
});

test('switch routing', async (t) => {
  await t.test('a strategy goes straight to cswap, without an extra list', async () => {
    let lists = 0;
    const received = [];
    const svc = stubService({
      list: async () => {
        lists++;
        return LIST;
      },
      switchTo: async (target) => {
        received.push({ target, listsBefore: lists });
        return { schemaVersion: 1, switched: true, to: { number: 2, email: 'b@x' } };
      },
    });
    await svc.refresh();
    await svc.switchTo({ strategy: 'best' });
    assert.deepEqual(received, [{ target: { strategy: 'best' }, listsBefore: 1 }]);
  });
  await t.test('`best` end to end through the fake', async (t2) => {
    pinFake(t2);
    const svc = new AccountService({ find: () => FAKE });
    await svc.refresh();
    await svc.switchTo({ email: 'carol@example.com', organizationUuid: 'org-globex' });
    await svc.pending;
    assert.equal(svc.state.activeAccountNumber, 3);
    const r = await svc.switchTo({ strategy: 'best' });
    assert.equal(r.switched, true);
    assert.equal(r.to.number, 1);
    assert.equal(svc.state.activeAccountNumber, 1);
  });
  await t.test('the same email in two organizations is told apart', async () => {
    const received = [];
    const svc = stubService({
      list: async () => ({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [
          { number: 1, email: 'a@x', organizationUuid: 'org-1', active: true },
          { number: 2, email: 'a@x', organizationUuid: 'org-2', active: false },
        ],
      }),
      switchTo: async (n) => {
        received.push(n);
        return { schemaVersion: 1, switched: true, to: { number: n, email: 'a@x' } };
      },
    });
    await svc.refresh();
    await svc.switchTo({ email: 'a@x', organizationUuid: 'org-2' });
    assert.deepEqual(received, [2]);
  });
  await t.test('the optimistic update needs number and email to match', async () => {
    const svc = stubService({
      list: async () => LIST,
      switchTo: async () => ({ schemaVersion: 1, switched: true, to: { number: 2, email: 'someone-else@x' } }),
    });
    await svc.refresh();
    const before = svc.state.accounts.map((a) => a.active);
    await svc.switchTo({ strategy: 'best' });
    assert.deepEqual(
      svc.state.accounts.map((a) => a.active),
      before,
      'a `to` that matches no known row is not marked active until the list confirms it',
    );
  });
});

test('a switch by identity uses the slot number from a fresh list', async (t) => {
  const rows = (pairs) => ({
    schemaVersion: 1,
    activeAccountNumber: 1,
    accounts: pairs.map(([number, email]) => ({ number, email, organizationUuid: 'org', active: number === 1 })),
  });
  const make = (lists) => {
    const switched = [];
    let i = 0;
    const svc = stubService({
      list: async () => lists[Math.min(i++, lists.length - 1)],
      switchTo: async (n) => {
        switched.push(n);
        return { schemaVersion: 1, switched: true, to: { number: n, email: lists[lists.length - 1].accounts.find((a) => a.number === n).email } };
      },
    });
    return { svc, switched };
  };
  await t.test('`cswap move` renumbered the slots since the popover was drawn', async () => {
    const { svc, switched } = make([rows([[1, 'a@x'], [2, 'b@x'], [3, 'c@x']]), rows([[1, 'a@x'], [2, 'c@x'], [3, 'b@x']])]);
    await svc.refresh();
    const r = await svc.switchTo({ email: 'b@x', organizationUuid: 'org' });
    assert.deepEqual(switched, [3]);
    assert.equal(r.to.email, 'b@x');
    assert.deepEqual(svc.state.accounts.filter((a) => a.active).map((a) => a.email), ['b@x']);
  });
  await t.test('the account was removed meanwhile', async () => {
    const { svc, switched } = make([rows([[1, 'a@x'], [2, 'b@x']]), rows([[1, 'a@x']])]);
    await svc.refresh();
    await assert.rejects(svc.switchTo({ email: 'b@x', organizationUuid: 'org' }), { kind: 'cli', message: /no longer in claude-swap/ });
    assert.deepEqual(switched, []);
    assert.equal(svc.state.accounts.length, 1, 'the fresh list is shown');
  });
});

test('a failed switch still refreshes the list, and `switching` tracks it', async () => {
  let lists = 0;
  const seen = [];
  const svc = stubService({
    list: async () => {
      lists++;
      return LIST;
    },
    switchTo: async () => {
      await sleep(5);
      throw new CswapError('timeout', 'cswap did not answer in time');
    },
  });
  await svc.refresh();
  svc.on('state', (s) => seen.push(s.switching));
  await assert.rejects(svc.switchTo(2), { kind: 'timeout' });
  assert.equal(svc.state.switching, false);
  assert.ok(seen.includes(true));
  await svc.pending;
  assert.equal(lists, 2);
});

test('a switch after a failed connect tries to connect again', async () => {
  let installed = false;
  const svc = new AccountService({
    find: () => (installed ? '/fake' : null),
    makeCswap: () => ({ check: async () => '0.27.0', list: async () => LIST, switchTo: async () => ({ schemaVersion: 1, switched: true, to: { number: 2 } }) }),
  });
  assert.equal((await svc.refresh()).phase, 'missing');
  installed = true;
  assert.equal((await svc.switchTo(2)).switched, true);
});

test('switch without cswap is a clear error', async () => {
  const svc = new AccountService({ find: () => null });
  await svc.refresh();
  await assert.rejects(svc.switchTo(1), { kind: 'not-installed' });
});
