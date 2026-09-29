'use strict';
// `npm run e2e`: end-to-end flows on the real app and the fake cswap.
//
// Each test/e2e/<name>.flow.js runs in its own Electron process
// (test/e2e/runner.js wraps main.js) with a fresh userData folder and a fresh
// fake-cswap state, so flows never see each other or the real settings in
// ~/Library/Application Support. Prints one line per flow plus every failed
// check, and exits 1 when a check failed.
//
//   npm run e2e                    every flow except the self-test
//   npm run e2e -- switch best     only these flows
//   npm run e2e -- --list          the flows and what they cover
//   E2E_SELFTEST=1 npm run e2e     adds the self-test, which fails on purpose (exit 1)
//   E2E_OUT=<dir>                  artifact folder (default: a new temp folder)
//   E2E_APP=<dir>                  run another checkout's main.js (default: this repo)
//   E2E_THEME=light|dark           passed on as CSW_THEME (screenshots)
//   E2E_VERBOSE=1                  stream Electron's output
//
// Every flow starts from settings.json = BASE_SETTINGS + its own `settings`,
// with CSW_LANG=en unless its `env` says otherwise, so the flows read the
// same English labels and the classic menu-bar title on every Mac. Today's
// app ignores the keys it does not know yet.
//
// Artifacts per flow in <out>/<name>/: transcript.txt, result.json,
// electron.log, NN-*.png from snap(), userData/, fake-state.json.
// <out>/transcript.txt joins the transcripts. It masks paths, timestamps and
// countdowns, so two runs can be compared with diff.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron'); // the binary's path in Node

const ROOT = path.join(__dirname, '..');
const FLOW_DIR = path.join(ROOT, 'test', 'e2e');
const RUNNER = path.join(FLOW_DIR, 'runner.js');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-cswap');
const APP = path.resolve(process.env.E2E_APP || ROOT);
const KILL_AFTER_EXTRA_MS = 30_000; // on top of the flow's own timeout
const DEFAULT_TIMEOUT_MS = 60_000;
const verbose = process.env.E2E_VERBOSE === '1';
const BASE_SETTINGS = { trayStyle: 'classic' };

function loadFlows() {
  return fs
    .readdirSync(FLOW_DIR)
    .filter((f) => f.endsWith('.flow.js'))
    .sort()
    .map((f) => {
      const file = path.join(FLOW_DIR, f);
      return { name: f.slice(0, -'.flow.js'.length), file, def: require(file) };
    });
}

// A developer's shell must not change what the flows see.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CSW_|FAKE_CSWAP_|E2E_)/.test(k) || k === 'CSWAP_PATH' || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  }
  return env;
}

function runFlow(flow, outDir) {
  const dir = path.join(outDir, flow.name);
  fs.rmSync(dir, { recursive: true, force: true });
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const settings = { ...BASE_SETTINGS, ...(flow.def.settings || {}) };
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings, null, 2));
  const state = path.join(dir, 'fake-state.json');
  if (flow.def.fakeState) fs.writeFileSync(state, JSON.stringify(flow.def.fakeState));

  const env = {
    ...cleanEnv(),
    E2E_FLOW: flow.file,
    E2E_OUT: dir,
    E2E_APP: APP,
    E2E_FAKE: FAKE,
    CSWAP_PATH: FAKE,
    CSW_USER_DATA: userData,
    FAKE_CSWAP_STATE: state,
    FAKE_CSWAP_SCENARIO: flow.def.scenario || 'default',
    CSW_LANG: 'en',
    ...(process.env.E2E_THEME ? { CSW_THEME: process.env.E2E_THEME } : {}),
    ...(flow.def.env || {}),
  };
  const log = fs.createWriteStream(path.join(dir, 'electron.log'));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(electron, [RUNNER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let killed = false;
    const limit = (flow.def.timeout || DEFAULT_TIMEOUT_MS) + KILL_AFTER_EXTRA_MS;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, limit);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        log.write(chunk);
        if (verbose) process.stdout.write(chunk);
      });
    }
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      current = null;
      log.end();
      let result = null;
      try {
        result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
      } catch {}
      if (!result) {
        const why = killed ? `killed after ${Math.round(limit / 1000)} s` : `Electron exited (${signal || `code ${code}`}) without a result`;
        result = { flow: flow.name, ok: false, checks: [{ ok: false, msg: 'the flow produced a result', detail: why }] };
      } else if (result.ok && code !== 0) {
        result.ok = false;
        result.checks.push({ ok: false, msg: 'Electron exited cleanly', detail: `exit ${signal || code}` });
      }
      resolve({ ...result, dir, ms: Date.now() - started });
    });
  });
}

function tail(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n);
  } catch {
    return [];
  }
}

let current = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (current) current.kill('SIGKILL');
    process.exit(130);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flows = loadFlows();
  if (args.includes('--list')) {
    for (const f of flows) console.log(`${f.name.padEnd(16)} ${f.def.selftest ? '(self-test) ' : ''}${f.def.description || ''}`);
    return 0;
  }
  const names = args.filter((a) => !a.startsWith('-'));
  const unknown = names.filter((n) => !flows.some((f) => f.name === n));
  if (unknown.length) {
    console.error(`e2e: no such flow: ${unknown.join(', ')} (see npm run e2e -- --list)`);
    return 2;
  }
  const selftest = process.env.E2E_SELFTEST === '1';
  const chosen = names.length ? flows.filter((f) => names.includes(f.name)) : flows.filter((f) => selftest || !f.def.selftest);

  const outDir = process.env.E2E_OUT ? path.resolve(process.env.E2E_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'csw-e2e-'));
  fs.mkdirSync(outDir, { recursive: true });
  const version = require('electron/package.json').version;
  console.log(`e2e: ${chosen.length} flow${chosen.length === 1 ? '' : 's'} · Electron ${version} · fake cswap${APP === ROOT ? '' : ` · app ${APP}`}`);

  const started = Date.now();
  const results = [];
  for (const flow of chosen) {
    const r = await runFlow(flow, outDir);
    results.push(r);
    const failed = r.checks.filter((c) => !c.ok);
    const mark = r.ok ? '✓' : '✗';
    const count = failed.length ? `${failed.length} of ${r.checks.length} checks failed` : `${r.checks.length} checks`;
    console.log(`  ${mark} ${flow.name.padEnd(16)} ${count}${flow.def.selftest ? ' (self-test: meant to fail)' : ''}`);
    for (const c of failed) console.log(`      ✗ ${c.msg}${c.detail ? ` — ${String(c.detail).split('\n').join('\n        ')}` : ''}`);
    if (!r.ok && !flow.def.selftest) {
      console.log(`      electron.log (last lines of ${path.join(r.dir, 'electron.log')}):`);
      for (const line of tail(path.join(r.dir, 'electron.log'), 12)) console.log(`        ${line}`);
    }
  }

  const joined = results.map((r) => `## ${r.flow}\n${tail(path.join(r.dir, 'transcript.txt'), Infinity).join('\n')}\n`).join('\n');
  fs.writeFileSync(path.join(outDir, 'transcript.txt'), joined);
  const failedFlows = results.filter((r) => !r.ok).length;
  const checks = results.reduce((n, r) => n + r.checks.length, 0);
  console.log(
    `${failedFlows ? `${failedFlows} of ${results.length} flows failed` : `all ${results.length} flows passed`} (${checks} checks, ${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  console.log(`artifacts: ${outDir}`);
  return failedFlows ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
