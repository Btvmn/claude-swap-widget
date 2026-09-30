'use strict';
// What changes between `npm start` and the packaged app. electron-builder
// ships a package.json without the "build" section, so anything main reads
// from it needs a fallback, or the packaged app dies at start.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const MAIN_FILES = ['main.js', ...fs.readdirSync(path.join(ROOT, 'src', 'main')).map((f) => path.join('src', 'main', f))].filter((f) => f.endsWith('.js'));

test('main never reads package.json "build" without a guard', () => {
  for (const file of MAIN_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/pkg\.build\.\w+/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      assert.match(line, /pkg\.build &&/, `${file}: "${line.trim()}" needs a fallback (the packaged package.json has no "build")`);
    }
  }
});

test('the packaged files are what the app needs, and nothing from test/ or scripts/', () => {
  assert.deepEqual(pkg.build.files, ['main.js', 'src/**/*', 'package.json', 'LICENSE']);
  assert.equal(pkg.main, 'main.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'renderer', 'vendor', 'chart.umd.min.js')), 'Chart.js is vendored under src/ so it ships');
  assert.equal(pkg.build.mac.extendInfo.LSUIElement, true, 'menu-bar only: no Dock icon');
});

test('the app ships the Electron and Chromium licences next to app.asar', () => {
  const extra = pkg.build.extraResources || [];
  for (const [from, to] of [
    ['node_modules/electron/dist/LICENSE', 'LICENSE.electron.txt'],
    ['node_modules/electron/dist/LICENSES.chromium.html', 'LICENSES.chromium.html'],
  ]) {
    assert.ok(extra.some((e) => e.from === from && e.to === to), `build.extraResources must copy ${from} to ${to}`);
    assert.ok(fs.existsSync(path.join(ROOT, from)), `${from} is missing (npm install?)`);
  }
});
