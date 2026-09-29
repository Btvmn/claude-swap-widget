'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EventEmitter } = require('events');
const cp = require('child_process');

const {
  Cswap,
  CswapError,
  findCswap,
  candidateDirs,
  compareVersions,
  parseResult,
  isNoAccounts,
  MIN_VERSION,
  DEFAULT_TIMEOUTS,
  runProcess,
} = require('../src/cswap');

// Polls until the pid is gone (a killed orphan stays visible until it is reaped).
async function waitGone(pid, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const FAKE = path.join(__dirname, 'fixtures', 'fake-cswap');

const ok = (payload) => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, spawnError: null });

test('compareVersions', async (t) => {
  await t.test('orders by major, minor, patch', () => {
    assert.equal(compareVersions('0.20.0', '0.20.0'), 0);
    assert.equal(compareVersions('0.19.9', '0.20.0'), -1);
    assert.equal(compareVersions('0.27.0', '0.20.0'), 1);
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1); // numeric, not lexical
  });
  await t.test('treats missing parts as zero', () => {
    assert.equal(compareVersions('1', '1.0.0'), 0);
    assert.equal(compareVersions('0.20', '0.20.1'), -1);
  });
  await t.test('ignores pre-release suffixes', () => {
    assert.equal(compareVersions('0.27.0b1', '0.27.0'), 0);
    assert.equal(compareVersions('0.27.0b1', MIN_VERSION), 1);
  });
  await t.test('survives garbage', () => {
    assert.equal(compareVersions('', '0.0.0'), 0);
    assert.equal(compareVersions('abc', '0.1.0'), -1);
  });
});

test('findCswap', async (t) => {
  const home = '/Users/test';
  const onlyThese = (...paths) => (p) => paths.includes(p);

  await t.test('override wins, and is not replaced by a search when missing', () => {
    const exists = onlyThese('/custom/cswap', '/opt/homebrew/bin/cswap');
    assert.equal(findCswap({ override: '/custom/cswap', env: {}, home, exists }), '/custom/cswap');
    assert.equal(findCswap({ override: '/nope/cswap', env: {}, home, exists }), null);
  });
  await t.test('CSWAP_PATH env is used when it exists', () => {
    const exists = onlyThese('/env/cswap', '/opt/homebrew/bin/cswap');
    assert.equal(findCswap({ env: { CSWAP_PATH: '/env/cswap' }, home, exists }), '/env/cswap');
  });
  await t.test('a stale CSWAP_PATH falls back to the search', () => {
    const exists = onlyThese('/opt/homebrew/bin/cswap');
    assert.equal(findCswap({ env: { CSWAP_PATH: '/gone/cswap' }, home, exists }), '/opt/homebrew/bin/cswap');
  });
  await t.test('PATH comes before the well-known dirs', () => {
    const exists = onlyThese('/my/bin/cswap', `${home}/.local/bin/cswap`);
    assert.equal(findCswap({ env: { PATH: '/usr/bin:/my/bin' }, home, exists }), '/my/bin/cswap');
  });
  await t.test('finds uv/pipx installs with the minimal Finder PATH', () => {
    const exists = onlyThese(`${home}/.local/bin/cswap`);
    assert.equal(findCswap({ env: { PATH: '/usr/bin:/bin' }, home, exists }), `${home}/.local/bin/cswap`);
  });
  await t.test('returns null when nothing is installed', () => {
    assert.equal(findCswap({ env: { PATH: '/usr/bin' }, home, exists: () => false }), null);
  });
  await t.test('candidateDirs dedupes and keeps order', () => {
    const dirs = candidateDirs({ PATH: '/opt/homebrew/bin:/usr/bin::' }, home);
    assert.equal(dirs[0], '/opt/homebrew/bin');
    assert.equal(dirs.filter((d) => d === '/opt/homebrew/bin').length, 1);
    assert.ok(dirs.includes(`${home}/.local/bin`));
    assert.ok(!dirs.includes(''));
  });
  await t.test('the real isExecutable accepts the fake and rejects a directory', () => {
    assert.equal(findCswap({ override: FAKE }), FAKE);
    assert.equal(findCswap({ override: __dirname }), null);
  });
});

test('parseResult', async (t) => {
  await t.test('returns the payload, keeping unknown fields', () => {
    const p = parseResult(ok({ schemaVersion: 1, accounts: [], newThing: 7 }));
    assert.deepEqual(p, { schemaVersion: 1, accounts: [], newThing: 7 });
  });
  await t.test('accepts pretty-printed JSON with a trailing newline', () => {
    const p = parseResult({ code: 0, stdout: '{\n  "schemaVersion": 1,\n  "active": null\n}\n', stderr: '' });
    assert.equal(p.active, null);
  });
  await t.test('turns the error envelope into a cli error', () => {
    const r = { code: 1, stdout: JSON.stringify({ schemaVersion: 1, error: { type: 'ConfigError', message: 'No accounts are managed yet' } }), stderr: '' };
    assert.throws(() => parseResult(r), (e) => {
      assert.ok(e instanceof CswapError);
      assert.equal(e.kind, 'cli');
      assert.equal(e.errorType, 'ConfigError');
      assert.equal(e.exitCode, 1);
      assert.equal(e.message, 'No accounts are managed yet');
      return true;
    });
  });
  await t.test('rejects an unknown schemaVersion', () => {
    assert.throws(() => parseResult(ok({ schemaVersion: 2, accounts: [] })), { kind: 'schema' });
    assert.throws(() => parseResult(ok({ accounts: [] })), { kind: 'schema' });
  });
  await t.test('uses the last stderr line for plain-text failures', () => {
    const r = { code: 1, stdout: '', stderr: 'Traceback…\nError: cswap must not be run as root.\n\n' };
    assert.throws(() => parseResult(r), { kind: 'cli', message: 'Error: cswap must not be run as root.' });
  });
  await t.test('falls back to the exit code when stderr is empty', () => {
    assert.throws(() => parseResult({ code: 3, stdout: '', stderr: '' }), { kind: 'cli', message: 'cswap exited with code 3', exitCode: 3 });
  });
  await t.test('exit 0 without JSON is bad output', () => {
    assert.throws(() => parseResult({ code: 0, stdout: 'hello', stderr: '' }), { kind: 'bad-output' });
    assert.throws(() => parseResult({ code: 0, stdout: 'null', stderr: '' }), { kind: 'bad-output' });
    assert.throws(() => parseResult({ code: 0, stdout: '', stderr: '' }), { kind: 'bad-output' });
  });
  await t.test('timeout wins over partial output', () => {
    assert.throws(() => parseResult({ code: 1, stdout: '{"schemaVersion":1', stderr: '', timedOut: true }), { kind: 'timeout' });
  });
  await t.test('overflow and foreign signals get their own messages', () => {
    assert.throws(() => parseResult({ code: 1, stdout: 'xxx', stderr: '', overflow: true }), { kind: 'bad-output' });
    assert.throws(() => parseResult({ code: 1, stdout: '', stderr: '', signal: 'SIGKILL' }), { kind: 'cli', message: 'cswap was stopped by SIGKILL' });
  });
  await t.test('other spawn failures get a clear message, not an exit code', () => {
    assert.throws(() => parseResult({ code: null, stdout: '', stderr: '', spawnError: 'ENOEXEC' }), {
      kind: 'cli',
      message: 'The chosen file is not a runnable program (ENOEXEC)',
    });
    assert.throws(() => parseResult({ code: null, stdout: '', stderr: '', spawnError: 'EMFILE' }), { kind: 'cli', message: 'cswap could not be started (EMFILE)' });
  });
  await t.test('a vanished binary is not-installed', () => {
    assert.throws(() => parseResult({ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }), { kind: 'not-installed' });
    assert.throws(() => parseResult({ code: 1, stdout: '', stderr: '', spawnError: 'EACCES' }), { kind: 'not-installed' });
  });
});

test('isNoAccounts', () => {
  assert.equal(isNoAccounts(new CswapError('cli', 'No accounts are managed yet', { errorType: 'ConfigError' })), true);
  assert.equal(isNoAccounts(new CswapError('cli', "Email 'a@b.c' is ambiguous", { errorType: 'ConfigError' })), false);
  assert.equal(isNoAccounts(new CswapError('cli', 'No accounts are managed yet')), false);
  assert.equal(isNoAccounts(new Error('No accounts')), false);
});

test('Cswap with a stubbed runner', async (t) => {
  const calls = [];
  const timeouts = [];
  const stub = (result) => async (file, args, timeoutMs) => {
    calls.push(args);
    timeouts.push(timeoutMs);
    return typeof result === 'function' ? result(args) : result;
  };

  await t.test('check() accepts a new enough version and rejects an old one', async () => {
    const good = new Cswap({ binary: 'x', run: stub({ code: 0, stdout: 'cswap 0.27.0b1\n', stderr: '' }) });
    assert.equal(await good.check(), '0.27.0b1');
    const old = new Cswap({ binary: 'x', run: stub({ code: 0, stdout: 'cswap 0.19.2\n', stderr: '' }) });
    await assert.rejects(old.check(), { kind: 'too-old', version: '0.19.2' });
  });
  await t.test('version() fails clearly on a missing binary or odd output', async () => {
    await assert.rejects(new Cswap({ binary: 'x', run: stub({ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }) }).version(), { kind: 'not-installed' });
    await assert.rejects(new Cswap({ binary: 'x', run: stub({ code: 0, stdout: 'cswap dev', stderr: '' }) }).version(), { kind: 'bad-output' });
  });
  await t.test('version() reports signals and floods like every other call', async () => {
    const v = (r) => new Cswap({ binary: 'x', run: stub({ stdout: '', stderr: '', ...r }) }).version();
    await assert.rejects(v({ code: null, signal: 'SIGKILL' }), { kind: 'cli', message: 'cswap was stopped by SIGKILL' });
    await assert.rejects(v({ code: null, overflow: true }), { kind: 'bad-output' });
    await assert.rejects(v({ code: null, timedOut: true }), { kind: 'timeout' });
  });
  await t.test('version() reads only a clean "<prog> <version>" line', async () => {
    const v = (r) => new Cswap({ binary: 'x', run: stub({ stderr: '', ...r }) }).version();
    assert.equal(await v({ code: 0, stdout: 'cswap 0.26.0\n' }), '0.26.0');
    assert.equal(await v({ code: 0, stdout: 'claude-swap 0.27.0b1\n' }), '0.27.0b1');
    // a broken install: the version must not be fished out of a traceback path
    const tb = 'Traceback (most recent call last):\n  File "/x/python3.13/site-packages/foo-1.2.3/a.py"\nImportError: boom\n';
    await assert.rejects(v({ code: 1, stdout: '', stderr: tb }), { kind: 'cli', message: 'ImportError: boom' });
    await assert.rejects(v({ code: 0, stdout: 'see /opt/lib-1.2.3/x', stderr: '' }), { kind: 'bad-output' });
  });
  await t.test('each command gets its own timeout', async () => {
    timeouts.length = 0;
    const c = new Cswap({ binary: 'x', run: stub((args) => (args[0] === '--version' ? { code: 0, stdout: 'cswap 0.27.0', stderr: '' } : ok({ schemaVersion: 1 }))) });
    await c.version();
    await c.list();
    await c.status();
    await c.switchTo(1);
    assert.deepEqual(timeouts, [DEFAULT_TIMEOUTS.version, DEFAULT_TIMEOUTS.read, DEFAULT_TIMEOUTS.read, DEFAULT_TIMEOUTS.switch]);
    assert.ok(DEFAULT_TIMEOUTS.switch >= 120_000, 'a switch must not be killed mid-transaction');
  });
  await t.test('switchTo builds the right argv and appends --json', async () => {
    calls.length = 0;
    const c = new Cswap({ binary: 'x', run: stub(ok({ schemaVersion: 1, switched: true })) });
    await c.switchTo(2);
    await c.switchTo('bob@example.com');
    await c.switchTo({ strategy: 'best' });
    await c.switchTo({ strategy: 'next-available' });
    await c.list();
    await c.status();
    assert.deepEqual(calls, [
      ['switch', '2', '--json'],
      ['switch', 'bob@example.com', '--json'],
      ['switch', '--strategy', 'best', '--json'],
      ['switch', '--strategy', 'next-available', '--json'],
      ['list', '--json'],
      ['status', '--json'],
    ]);
  });
  await t.test('switchTo refuses anything that could be read as a flag', async () => {
    calls.length = 0;
    const c = new Cswap({ binary: 'x', run: stub(ok({ schemaVersion: 1 })) });
    for (const bad of ['--force', '-1', '', null, undefined, '1 2', 'a b@c', '-x@evil.com', { strategy: 'worst' }]) {
      await assert.rejects(c.switchTo(bad), CswapError, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(calls.length, 0);
  });
});

test('Cswap against the fake cswap binary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cswap-test-'));
  const saved = { ...process.env };
  // Every subtest states which account is active, so none depends on another's switch.
  const use = (scenario, active = 1) => {
    process.env.FAKE_CSWAP_SCENARIO = scenario;
    const state = path.join(dir, `${scenario}.json`);
    process.env.FAKE_CSWAP_STATE = state;
    delete process.env.FAKE_CSWAP_VERSION;
    delete process.env.FAKE_CSWAP_MARKER;
    fs.writeFileSync(state, JSON.stringify({ active }));
  };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cswap = new Cswap({ binary: FAKE });

  await t.test('check() reads the version', async () => {
    use('default');
    assert.equal(await cswap.check(), '0.27.0b1');
  });
  await t.test('list() returns the five fixture accounts', async () => {
    use('default', 3);
    const r = await cswap.list();
    assert.equal(r.activeAccountNumber, 3);
    assert.deepEqual(r.accounts.filter((a) => a.active).map((a) => a.number), [3]);
    assert.deepEqual(r.accounts.map((a) => a.usage?.fiveHour?.pct ?? null), [20, 80, 95, null, 5]);
    assert.equal(r.accounts[3].usageStatus, 'token_expired');
    assert.equal(r.accounts[3].lastGoodUsage.fiveHour.pct, 42);
    assert.equal(r.accounts[4].disabled, true);
  });
  await t.test('switch persists and is seen by status()', async () => {
    use('default');
    const s = await cswap.switchTo(2);
    assert.equal(s.switched, true);
    assert.deepEqual(s.to, { number: 2, email: 'bob@example.com' });
    assert.equal((await cswap.status()).active.number, 2);
    const again = await cswap.switchTo('bob@example.com');
    assert.equal(again.switched, false);
    assert.equal(again.reason, 'already-active');
  });
  await t.test('best picks the account with the most headroom', async () => {
    use('default', 2);
    const s = await cswap.switchTo({ strategy: 'best' });
    assert.equal(s.switched, true);
    assert.equal(s.reason, 'switched');
    assert.deepEqual([s.from.number, s.to.number], [2, 1]);
    use('default', 1);
    const stay = await cswap.switchTo({ strategy: 'best' });
    assert.equal(stay.switched, false);
    // Real cswap says 'usage-unavailable' for this roster (dave's usage is
    // unknown); the fake's simpler rule says 'already-best'. Either way: no switch.
    assert.equal(stay.to.number, 1);
  });
  await t.test('an unknown account is AccountNotFoundError from the envelope', async () => {
    use('default');
    await assert.rejects(cswap.switchTo(42), { kind: 'cli', errorType: 'AccountNotFoundError', message: 'Account-42 does not exist' });
  });
  await t.test('an empty install lists nothing; only switch raises the ConfigError', async () => {
    use('empty');
    assert.deepEqual(await cswap.list(), { schemaVersion: 1, activeAccountNumber: null, accounts: [] });
    assert.equal((await cswap.status()).active, null);
    await assert.rejects(cswap.switchTo({ strategy: 'best' }), (e) => isNoAccounts(e));
  });
  await t.test('plain-text root guard', async () => {
    use('root');
    await assert.rejects(cswap.list(), { kind: 'cli', message: 'Error: cswap must not be run as root.' });
  });
  await t.test('garbage on stdout', async () => {
    use('garbage');
    await assert.rejects(cswap.list(), { kind: 'bad-output' });
  });
  await t.test('future schema', async () => {
    use('schema2');
    await assert.rejects(cswap.list(), { kind: 'schema' });
  });
  await t.test('too old', async () => {
    use('old');
    await assert.rejects(cswap.check(), { kind: 'too-old' });
  });
  await t.test('timeout stops cswap with SIGINT, so its locks are released', async () => {
    use('slow');
    process.env.FAKE_CSWAP_MARKER = path.join(dir, 'signal');
    await assert.rejects(new Cswap({ binary: FAKE, timeouts: { read: 500 } }).list(), { kind: 'timeout' });
    assert.equal(fs.readFileSync(process.env.FAKE_CSWAP_MARKER, 'utf8'), 'SIGINT');
  });
  await t.test('a cswap that ignores SIGINT is killed after the grace period', async () => {
    use('stubborn');
    const pidfile = path.join(dir, 'pid');
    process.env.FAKE_CSWAP_PIDFILE = pidfile;
    const started = Date.now();
    let pid = 0;
    try {
      await assert.rejects(new Cswap({ binary: FAKE, timeouts: { read: 1500, grace: 300 } }).list(), { kind: 'timeout' });
      pid = Number(fs.readFileSync(pidfile, 'utf8'));
      assert.ok(pid > 0, 'the fake was up before the cap fired');
      assert.ok(Date.now() - started >= 1800, 'the grace period ran');
      assert.ok(await waitGone(pid), 'the child was killed');
    } finally {
      delete process.env.FAKE_CSWAP_PIDFILE;
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  });
  await t.test('signals reach cswap behind a wrapper script that does not exec', { skip: process.platform === 'win32' }, async (t2) => {
    // uv/pipx shims exec, but a hand-written wrapper may not: only the process group gets it there.
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\n"${FAKE}" "$@"\necho done >&2\n`, { mode: 0o755 });
    const pidfile = path.join(dir, 'wrapped-pid');
    process.env.FAKE_CSWAP_PIDFILE = pidfile;
    const killLeftover = () => {
      try {
        process.kill(Number(fs.readFileSync(pidfile, 'utf8')), 'SIGKILL');
      } catch {}
    };
    t2.after(() => {
      killLeftover();
      delete process.env.FAKE_CSWAP_PIDFILE;
    });
    await t2.test('slow: SIGINT, and the wrapper exiting 0 afterwards is still a timeout', async () => {
      use('slow');
      process.env.FAKE_CSWAP_MARKER = path.join(dir, 'wrapped-signal');
      await assert.rejects(new Cswap({ binary: wrapper, timeouts: { read: 1500, grace: 1000 } }).list(), { kind: 'timeout' });
      assert.equal(fs.readFileSync(process.env.FAKE_CSWAP_MARKER, 'utf8'), 'SIGINT');
      assert.ok(await waitGone(Number(fs.readFileSync(pidfile, 'utf8'))), 'the wrapped cswap is gone');
    });
    await t2.test('stubborn: SIGKILL after the grace period', async () => {
      use('stubborn');
      await assert.rejects(new Cswap({ binary: wrapper, timeouts: { read: 1500, grace: 300 } }).list(), { kind: 'timeout' });
      assert.ok(await waitGone(Number(fs.readFileSync(pidfile, 'utf8'))), 'the wrapped cswap is gone');
    });
  });
  await t.test('a payload that arrives just as the cap fires is accepted', () => {
    const payload = JSON.stringify({ schemaVersion: 1, active: null });
    assert.deepEqual(parseResult({ code: 0, stdout: payload, stderr: '', timedOut: true }), { schemaVersion: 1, active: null });
    assert.throws(() => parseResult({ code: 0, stdout: 'done', stderr: '', timedOut: true }), { kind: 'timeout' });
    assert.throws(() => parseResult({ code: 130, stdout: payload, stderr: '', timedOut: true }), { kind: 'timeout' });
  });
  await t.test('running out of file descriptors is reported, not thrown', async () => {
    // Node emits EMFILE/ENFILE asynchronously and creates no stdio for the child.
    const orig = cp.spawn;
    cp.spawn = () => {
      const child = new EventEmitter();
      child.pid = 0;
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
      return child;
    };
    delete require.cache[require.resolve('../src/cswap')];
    try {
      const fresh = require('../src/cswap');
      const r = await fresh.runProcess('/x/cswap', ['list', '--json'], 1000, 100);
      assert.equal(r.spawnError, 'EMFILE');
      await assert.rejects(new fresh.Cswap({ binary: '/x/cswap' }).list(), { kind: 'cli', message: 'cswap could not be started (EMFILE)' });
    } finally {
      cp.spawn = orig;
      delete require.cache[require.resolve('../src/cswap')];
    }
  });
  await t.test('a path through a regular file is not-installed (ENOTDIR)', async () => {
    await assert.rejects(new Cswap({ binary: path.join(FAKE, 'cswap') }).list(), { kind: 'not-installed' });
  });
  await t.test('output beyond maxBuffer', async () => {
    use('flood');
    await assert.rejects(cswap.list(), { kind: 'bad-output', message: /more output/ });
  });
  await t.test('killed by someone else', async () => {
    use('crash');
    await assert.rejects(cswap.list(), { kind: 'cli', signal: 'SIGKILL' });
  });
  await t.test('binary missing after discovery', async () => {
    await assert.rejects(new Cswap({ binary: path.join(dir, 'nope') }).list(), { kind: 'not-installed' });
  });
});
