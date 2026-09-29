'use strict';
// Bridge to the claude-swap CLI (https://github.com/realiti4/claude-swap).
//
// This app never touches credentials itself. Every account operation goes
// through `cswap … --json`, which is claude-swap's documented, versioned
// scripting contract (schemaVersion 1, additive changes only). That keeps all
// the fragile work — Keychain, refresh tokens, locking — in claude-swap.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUPPORTED_SCHEMA = 1;
const MIN_VERSION = '0.20.0';

// Last-resort caps against a wedged process, not response-time targets.
// `list`/`status` may refresh an OAuth token under cswap's locks (its own
// budgets add up to ~50 s) and `switch` rewrites credentials under several
// locks (~80 s worst case); killing either mid-way can strand a rotated
// refresh token or leave a half-applied switch, so the caps sit well above
// those budgets. `--version` is answered by argparse and never blocks.
// At the cap cswap gets SIGINT (Python's KeyboardInterrupt, so its `finally`
// blocks release their locks); `grace` later, if it is still there, SIGKILL.
const DEFAULT_TIMEOUTS = Object.freeze({ version: 15_000, read: 120_000, switch: 180_000, grace: 10_000 });
const MAX_OUTPUT = 8 * 1024 * 1024;

class CswapError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CswapError';
    this.kind = kind; // 'not-installed' | 'too-old' | 'cli' | 'bad-output' | 'schema' | 'timeout'
    Object.assign(this, extra);
  }
}

// GUI apps on macOS start with a minimal PATH (/usr/bin:/bin:…), so a cswap
// installed by uv, pipx or Homebrew is invisible unless we look for it.
function candidateDirs(env = process.env, home = os.homedir()) {
  const fromPath = (env.PATH || '').split(path.delimiter).filter(Boolean);
  return [
    ...fromPath,
    path.join(home, '.local', 'bin'), // uv tool / pipx default
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.cargo', 'bin'),
  ].filter((d, i, all) => all.indexOf(d) === i);
}

function findCswap({ override, env = process.env, home = os.homedir(), exists = isExecutable } = {}) {
  if (override) return exists(override) ? override : null;
  if (env.CSWAP_PATH && exists(env.CSWAP_PATH)) return env.CSWAP_PATH;
  // uv and pipx install cswap.exe on Windows. A .cmd shim is not listed:
  // Node refuses to execFile .cmd/.bat without a shell (EINVAL).
  const names = process.platform === 'win32' ? ['cswap.exe'] : ['cswap'];
  for (const dir of candidateDirs(env, home)) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (exists(p)) return p;
    }
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function compareVersions(a, b) {
  const parse = (v) => String(v).match(/\d+/g)?.slice(0, 3).map(Number) ?? [0];
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The binary vanished or lost its exec bit after discovery (e.g. uninstalled
// while the app runs). Treat it like a missing install, not a CLI failure.
const MISSING_BINARY = new Set(['ENOENT', 'EACCES', 'ENOTDIR']);

function spawnMessage(code) {
  if (code === 'ENOEXEC') return 'The chosen file is not a runnable program (ENOEXEC)';
  if (code === 'EINVAL' && process.platform === 'win32') return 'Choose cswap.exe; .cmd and .bat shims cannot be run directly';
  return `cswap could not be started (${code})`;
}

// Everything that says "the process did not run to a normal end", checked
// before looking at its output or exit code.
function throwIfAbnormal({ spawnError, overflow, signal }) {
  if (spawnError && MISSING_BINARY.has(spawnError)) throw new CswapError('not-installed', `cswap could not be started (${spawnError})`);
  if (spawnError) throw new CswapError('cli', spawnMessage(spawnError), { spawnError });
  if (overflow) throw new CswapError('bad-output', 'cswap printed far more output than expected');
  if (signal) throw new CswapError('cli', `cswap was stopped by ${signal}`, { signal });
}

const TIMEOUT = () => new CswapError('timeout', 'cswap did not answer in time');

// Pure: turn a finished process into a payload or a CswapError.
// cswap prints exactly one JSON object on stdout for list/status/switch;
// human notices go to stderr. Some early failures (e.g. the root guard) print
// plain text to stderr instead, so non-JSON output must be handled too.
function parseResult(r) {
  throwIfAbnormal(r);
  const { code, stdout, stderr, timedOut } = r;
  let payload = null;
  const text = (stdout || '').trim();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  // After the cap only a clean exit with a payload counts (cswap finished
  // just as the signal arrived); a wrapper script exiting 0 does not.
  if (timedOut && !(code === 0 && payload && typeof payload === 'object')) throw TIMEOUT();
  if (payload && typeof payload === 'object') {
    if (payload.schemaVersion !== SUPPORTED_SCHEMA) {
      throw new CswapError('schema', `Unsupported cswap schemaVersion ${payload.schemaVersion}`);
    }
    if (payload.error) {
      throw new CswapError('cli', payload.error.message || 'cswap reported an error', {
        errorType: payload.error.type,
        exitCode: code,
      });
    }
    return payload;
  }
  const msg = (stderr || '').trim().split('\n').filter(Boolean).pop();
  if (code !== 0) throw new CswapError('cli', msg || `cswap exited with code ${code}`, { exitCode: code });
  throw new CswapError('bad-output', 'cswap returned no JSON');
}

class Cswap {
  constructor({ binary, run = runProcess, timeouts = {} } = {}) {
    this.binary = binary;
    this.run = run;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  // argparse prints "<prog> <version>", where prog is the name it was run as
  // (`cswap` or `claude-swap`).
  async version() {
    const r = await this.run(this.binary, ['--version'], this.timeouts.version, this.timeouts.grace);
    throwIfAbnormal(r);
    if (r.timedOut && r.code !== 0) throw TIMEOUT();
    if (r.code !== 0) {
      const msg = (r.stderr || '').trim().split('\n').filter(Boolean).pop();
      throw new CswapError('cli', msg || `cswap exited with code ${r.code}`, { exitCode: r.code });
    }
    const m = String(r.stdout).match(/^\S+\s+(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/m);
    if (!m) throw r.timedOut ? TIMEOUT() : new CswapError('bad-output', 'Could not read cswap version');
    return m[1];
  }

  async check() {
    const v = await this.version();
    if (compareVersions(v, MIN_VERSION) < 0) {
      throw new CswapError('too-old', `claude-swap ${v} is too old, need ${MIN_VERSION}+`, { version: v });
    }
    return v;
  }

  async json(args, timeoutMs) {
    return parseResult(await this.run(this.binary, [...args, '--json'], timeoutMs, this.timeouts.grace));
  }

  list() {
    return this.json(['list'], this.timeouts.read);
  }

  status() {
    return this.json(['status'], this.timeouts.read);
  }

  // target: account number, email, or { strategy: 'best' | 'next-available' }
  switchTo(target) {
    if (target && typeof target === 'object' && target.strategy) {
      if (!['best', 'next-available'].includes(target.strategy)) {
        return Promise.reject(new CswapError('cli', `Unknown strategy ${target.strategy}`));
      }
      return this.json(['switch', '--strategy', target.strategy], this.timeouts.switch);
    }
    const t = String(target ?? '');
    if (!/^\d+$/.test(t) && !/^[^\s@-][^\s@]*@[^\s@]+$/.test(t)) {
      return Promise.reject(new CswapError('cli', `Invalid account: ${t}`));
    }
    return this.json(['switch', t], this.timeouts.switch);
  }
}

// Defensive: cswap 0.26/0.27 answer an empty `list --json` with
// `accounts: []` (exit 0) and raise this ConfigError only from `switch`.
// AccountService.refresh() still checks for it in case another version
// lists that way. A switch on an empty install does not come through here:
// it shows an error toast, and the follow-up refresh then shows the
// no-accounts screen from the empty list.
function isNoAccounts(err) {
  return (
    err instanceof CswapError &&
    err.errorType === 'ConfigError' &&
    /no accounts/i.test(err.message)
  );
}

// Runs cswap with its own deadline instead of execFile's: execFile sends one
// signal and then waits for the child forever, so a cswap that survives
// SIGINT (a wrapper script that does not `exec`, a thread it cannot
// interrupt) would block every later call behind it.
function runProcess(file, args, timeoutMs, graceMs = DEFAULT_TIMEOUTS.grace) {
  return new Promise((resolve) => {
    const result = { code: null, stdout: '', stderr: '', timedOut: false, overflow: false, signal: null, spawnError: null };
    let child;
    try {
      child = spawn(file, args, {
        // Its own process group, so the whole tree gets the signal.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // No colours / prompts: we only want the JSON.
        env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (e) {
      // Node throws most spawn errors synchronously (ENOTDIR, EINVAL, ENOEXEC…).
      resolve({ ...result, spawnError: (e && e.code) || 'ESPAWN' });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let settled = false;
    let stopping = false;
    let capTimer = null;
    let graceTimer = null;

    const signalTree = (sig) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      clearTimeout(graceTimer);
      resolve({ ...result, ...patch, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    // Once: a second SIGINT could land in the very cleanup the first one started.
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(capTimer);
      signalTree('SIGINT');
      graceTimer = setTimeout(() => {
        signalTree('SIGKILL');
        // An orphaned grandchild may still hold the pipes: do not wait for 'close'.
        child.stdout.destroy();
        child.stderr.destroy();
        finish({});
      }, graceMs);
    };
    const collect = (chunks) => (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        if (!result.overflow) {
          result.overflow = true;
          stop();
        }
        return;
      }
      chunks.push(chunk);
    };

    // EMFILE/ENFILE: Node reports these asynchronously and creates no stdio.
    child.on('error', (e) => finish({ spawnError: (e && e.code) || 'ESPAWN' }));
    if (!child.stdout || !child.stderr) return;
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('close', (code, signal) => {
      const ours = result.timedOut || result.overflow;
      finish({ code, signal: ours ? null : signal });
    });
    if (timeoutMs > 0) {
      capTimer = setTimeout(() => {
        result.timedOut = true;
        stop();
      }, timeoutMs);
    }
  });
}

module.exports = {
  Cswap,
  CswapError,
  findCswap,
  candidateDirs,
  compareVersions,
  parseResult,
  runProcess,
  isNoAccounts,
  isExecutable,
  MIN_VERSION,
  SUPPORTED_SCHEMA,
  DEFAULT_TIMEOUTS,
};
