'use strict';
// Pins the vendored Chart.js (PLAN §5.4, §8 item 5). renderer-static skips
// src/renderer/vendor/, so this is where the third-party bundle is checked:
// the exact version and bytes, a static scan for what our CSP forbids or what
// would reach the network, its licence file, and that scripts/vendor.js
// reproduces both files from node_modules, idempotently.
//
// Measured 2026-09-29 (n = 1): dist/chart.umd.min.js of chart.js 4.5.1 is
// 208,522 B with the sha256 below, both from node_modules after
// `npm install --save-exact chart.js@4.5.1` and from the registry tarball.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, vendor } = require('../scripts/vendor');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'src', 'renderer', 'vendor');
const BUNDLE = path.join(VENDOR, 'chart.umd.min.js');
const LICENSE = path.join(VENDOR, 'LICENSE.chartjs.md');

const VERSION = '4.5.1';
const SIZE = 208_522;
const SHA256 = '48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a';
const INTEGRITY =
  'sha512-GIjfiT9dbmHRiYi6Nl2yFCq7kkwdkp1W/lp2J99rX0yo9tgJGn3lKQATztIjb5tVtevcBtIdICNWqlq5+E8/Pw==';
const MIT_GRANT = 'Permission is hereby granted, free of charge, to any person obtaining a copy';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const installed = fs.existsSync(path.join(ROOT, 'node_modules', 'chart.js', 'package.json'));
const NO_INSTALL = !installed && 'chart.js is not in node_modules (npm install)';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A throwaway project root with a package.json and, optionally, a fake
// node_modules/chart.js, for the refusals of build(). The licence only needs
// Chart.js's layout: a copyright line and the MIT grant.
const FAKE_LICENSE = `The MIT License (MIT)\n\nCopyright (c) 2014-2024 Chart.js Contributors\n\n${MIT_GRANT} …\n`;

function fakeRoot(t, { spec = VERSION, installedVersion = null, bundle = null } = {}) {
  const root = tmpDir(t, 'vendor-root-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { 'chart.js': spec } }));
  if (installedVersion) {
    const dir = path.join(root, 'node_modules', 'chart.js');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'chart.js', version: installedVersion }));
    fs.writeFileSync(path.join(dir, 'dist', 'chart.umd.min.js'), bundle || '');
    fs.writeFileSync(path.join(dir, 'LICENSE.md'), FAKE_LICENSE);
  }
  return root;
}

// --- the pin ----------------------------------------------------------------

test('package.json pins chart.js exactly, as a devDependency, and has the vendor script', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  assert.equal(pkg.devDependencies['chart.js'], VERSION);
  assert.equal((pkg.dependencies || {})['chart.js'], undefined, 'the app ships the vendored copy, not the package');
  assert.equal(pkg.scripts.vendor, 'node scripts/vendor.js');
});

test('package-lock.json resolves chart.js to the pinned version and tarball', () => {
  const lock = readJson(path.join(ROOT, 'package-lock.json'));
  assert.equal(lock.packages[''].devDependencies['chart.js'], VERSION);
  const entry = lock.packages['node_modules/chart.js'];
  assert.ok(entry, 'lockfile has node_modules/chart.js');
  assert.equal(entry.version, VERSION);
  assert.equal(entry.dev, true);
  assert.equal(entry.integrity, INTEGRITY);
});

// --- the vendored files -----------------------------------------------------

test(`the bundle is Chart.js v${VERSION}: banner, size and hash`, () => {
  const buf = fs.readFileSync(BUNDLE);
  const text = buf.toString('utf8');
  assert.ok(
    text.startsWith(`/*!\n * Chart.js v${VERSION}\n * https://www.chartjs.org\n`),
    `banner reads Chart.js v${VERSION}`
  );
  assert.ok(text.includes(' * Released under the MIT License\n */'), 'Chart.js banner is complete');
  assert.ok(
    text.includes('/*!\n * @kurkle/color v0.3.2\n * https://github.com/kurkle/color#readme\n * (c) 2023 Jukka Kurkela\n'),
    'the bundled @kurkle/color keeps its banner'
  );
  assert.equal(buf.length, SIZE);
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), SHA256);
});

test('the bundle has nothing our CSP forbids or that reaches out', () => {
  const text = fs.readFileSync(BUNDLE, 'utf8');
  const count = (re) => (text.match(re) || []).length;
  // CSP script-src 'self' without 'unsafe-eval'
  assert.equal(count(/\beval\s*\(/g), 0, 'eval(');
  assert.equal(count(/\bnew\s+Function\b/g), 0, 'new Function');
  // the three `Function(` hits are the method name _tickFormatFunction
  const fnCalls = text.match(/[\w$.]*Function\s*\(/g) || [];
  assert.ok(fnCalls.every((m) => /_tickFormatFunction\($/.test(m)), `Function( other than a method: ${fnCalls}`);
  assert.equal(count(/\bset(?:Timeout|Interval)\s*\(\s*['"`]/g), 0, 'timer with a string');
  // style-src 'self': no <style> injection, no inline style strings
  assert.equal(count(/createElement\(\s*['"`]style/g), 0, 'createElement("style")');
  assert.equal(count(/\binsertRule\b|\bcssText\b|adoptedStyleSheets/g), 0, 'stylesheet or cssText writes');
  assert.equal(count(/setAttribute\(\s*['"`]style/g), 0, 'setAttribute("style")');
  // no HTML parsing, no module loading
  assert.equal(count(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser)\b|document\.write/g), 0, 'HTML parsing');
  const loading = /\brequire\s*\(|\bimport\s*\(|\bimportScripts\b|createElement\(\s*['"`]script/g;
  assert.equal(count(loading), 0, 'module or script loading');
  // no network, and the only URLs are the two banners'
  assert.equal(count(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/g), 0, 'network API');
  const urls = text.match(/\bhttps?:\/\/[^\s'"`)]+/g);
  assert.deepEqual(urls, ['https://www.chartjs.org', 'https://github.com/kurkle/color#readme']);
});

test('vendor/ holds only the bundle and its licence (no source map, no node_modules copy)', () => {
  assert.deepEqual(fs.readdirSync(VENDOR).sort(), ['LICENSE.chartjs.md', 'chart.umd.min.js']);
});

test('LICENSE.chartjs.md carries the Chart.js and @kurkle/color MIT notices', () => {
  const text = fs.readFileSync(LICENSE, 'utf8');
  const notice = (heading, copyright) => `## ${heading}\n\nThe MIT License (MIT)\n\n${copyright}\n\n${MIT_GRANT}`;
  assert.ok(text.includes(notice(`Chart.js v${VERSION}`, 'Copyright (c) 2014-2024 Chart.js Contributors')), 'Chart.js');
  assert.ok(
    text.includes(notice('@kurkle/color v0.3.2 (bundled in chart.umd.min.js)', 'Copyright (c) 2018-2021 Jukka Kurkela')),
    '@kurkle/color'
  );
  assert.equal(text.split(MIT_GRANT).length - 1, 2, 'the MIT permission text, once per notice');
  assert.equal(text.split('THE SOFTWARE IS PROVIDED "AS IS"').length - 1, 2, 'the MIT disclaimer, once per notice');
});

// --- scripts/vendor.js ------------------------------------------------------

test('the vendored files are what npm run vendor makes from node_modules', { skip: NO_INSTALL }, () => {
  const files = build();
  assert.deepEqual(Object.keys(files).sort(), ['LICENSE.chartjs.md', 'chart.umd.min.js']);
  assert.ok(files['chart.umd.min.js'].equals(fs.readFileSync(BUNDLE)), 'bundle differs from node_modules: npm run vendor');
  assert.ok(files['LICENSE.chartjs.md'].equals(fs.readFileSync(LICENSE)), 'licence differs: npm run vendor');
  assert.ok(
    files['chart.umd.min.js'].equals(fs.readFileSync(path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'))),
    'the bundle is copied byte for byte'
  );
});

test('npm run vendor -- --check exits 0 and writes nothing', { skip: NO_INSTALL }, () => {
  const before = fs.statSync(BUNDLE).mtimeMs;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'vendor.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chart\.umd\.min\.js\s+208522 B {2}unchanged/);
  assert.match(r.stdout, /LICENSE\.chartjs\.md\s+\d+ B {2}unchanged/);
  assert.equal(fs.statSync(BUNDLE).mtimeMs, before);
});

test('vendoring is idempotent: the second run writes nothing', { skip: NO_INSTALL }, (t) => {
  const outDir = path.join(tmpDir(t, 'vendor-out-'), 'vendor');
  const first = vendor({ outDir });
  assert.deepEqual(first.map((r) => r.status), ['updated', 'updated']);
  const mtimes = first.map((r) => fs.statSync(r.file).mtimeMs);
  const second = vendor({ outDir });
  assert.deepEqual(second.map((r) => r.status), ['unchanged', 'unchanged']);
  assert.deepEqual(second.map((r) => fs.statSync(r.file).mtimeMs), mtimes);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['LICENSE.chartjs.md', 'chart.umd.min.js'], 'no temp files left');
  assert.ok(fs.readFileSync(path.join(outDir, 'chart.umd.min.js')).equals(fs.readFileSync(BUNDLE)));
  assert.ok(fs.readFileSync(path.join(outDir, 'LICENSE.chartjs.md')).equals(fs.readFileSync(LICENSE)));

  // check mode reports a stale file and leaves it alone
  fs.appendFileSync(path.join(outDir, 'LICENSE.chartjs.md'), 'edited\n');
  const checked = vendor({ outDir, check: true });
  assert.deepEqual(checked.map((r) => r.status), ['unchanged', 'differs']);
  assert.match(fs.readFileSync(path.join(outDir, 'LICENSE.chartjs.md'), 'utf8'), /edited\n$/);
});

test('build refuses a version range, a missing install and another installed version', (t) => {
  assert.throws(() => build({ root: fakeRoot(t, { spec: '^4.5.1' }) }), /exactly .*"\^4\.5\.1"/);
  assert.throws(() => build({ root: fakeRoot(t) }), /not installed: run npm install/);
  assert.throws(() => build({ root: fakeRoot(t, { installedVersion: '4.5.0' }) }), /chart\.js 4\.5\.0, package\.json pins 4\.5\.1/);
});

test('build refuses a bundle without the banner, or with another @kurkle/color', (t) => {
  const banner = `/*!\n * Chart.js v${VERSION}\n */\n`;
  assert.throws(
    () => build({ root: fakeRoot(t, { installedVersion: VERSION, bundle: 'var Chart;' }) }),
    /does not start with the Chart\.js v4\.5\.1 banner/
  );
  assert.throws(
    () => build({ root: fakeRoot(t, { installedVersion: VERSION, bundle: `${banner}/*!\n * @kurkle/color v0.3.4\n */` }) }),
    /@kurkle\/color v0\.3\.4, not v0\.3\.2: check its licence/
  );
  const ok = build({ root: fakeRoot(t, { installedVersion: VERSION, bundle: `${banner}/*!\n * @kurkle/color v0.3.2\n */` }) });
  assert.match(ok['LICENSE.chartjs.md'].toString('utf8'), /Copyright \(c\) 2018-2021 Jukka Kurkela/);
});
