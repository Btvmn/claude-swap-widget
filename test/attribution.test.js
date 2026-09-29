'use strict';
// Attribution guards for the UI code ported from Claude Usage Widget — The
// Maestro edition (PLAN §9). Its MIT licence only holds while its notice ships
// with the code, so this checks that LICENSE carries both notices verbatim,
// that every file with ported code opens with the header below, and that what
// we agreed not to ship (their assets, support link, signature mark, data
// layer) stays out. Files that do not exist yet are skipped.
//
// The header (PLAN §9.3), before any code; `'use strict';` may precede it.
// CSS uses the same four lines in one /* … */ block.
//
//   // Adapted from Claude Usage Widget — The Maestro edition
//   // (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, <their file>:<lines>).
//   // Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
//   // MIT licence; see LICENSE, "Third-party code".

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const abs = (file) => path.join(ROOT, file);
const exists = (file) => fs.existsSync(abs(file));
const read = (file) => fs.readFileSync(abs(file), 'utf8');

// PLAN §9.3: files made of ported code. They must carry the header as soon as
// they exist.
const HEADER_FILES = [
  'src/shared/i18n.js',
  'src/shared/stats.js',
  'src/renderer/i18n-dom.js',
  'src/renderer/hero.js',
  'src/renderer/accounts.js',
  'src/renderer/stats-view.js',
  'src/renderer/tray-picture.js',
  'src/renderer/css/tokens.css',
  'src/renderer/css/base.css',
  'src/renderer/css/hero.css',
  'src/renderer/css/accounts.css',
  'src/renderer/css/stats.css',
];

// PLAN §9.3 as well, but these start as our own code: P0.2 moves main.js into
// them or leaves a stub. The header is due once the ported part lands, which
// is recognised by the names the plan gives it (§2.2, §4.2, P2.5), or by any
// header-like claim in the file.
const LATE_HEADER_FILES = {
  'src/main/tray.js': /['"`]tray:(?:image|draw)['"`]|\bisMenuBarDark\b/,
  'src/main/notify.js': /\bclass\s+Notifier\b|\bNotifier\s*\(|\bnew\s+Notification\s*\(|\bNotification\.isSupported\b/,
  'src/main/placement.js': /\b(?:isPositionOnScreen|getCenteredPosition|placeWidget)\b/,
};

// Only the retention constants and the idea come from Maestro, so a one-line
// note is enough here (PLAN §9.3).
const NOTE_FILE = 'src/history.js';

// A file that says this much claims to carry ported code.
const CLAIM = /Adapted from Claude Usage Widget|b79d4b1/;

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// sha256 of every file under assets/ and docs/maestro/ in maestro-src @ b79d4b1
// (computed 2026-09-29). None of them may ship: the Claude logo is Anthropic's
// mark, the tray PNGs are of unknown origin, the rest is their branding
// (PLAN §8 item 8, §9.4).
const MAESTRO_ASSETS = {
  bff826877340468d931e339e1b82e7f07d260da9c85326d47a7ebd22a4df9d75: 'assets/claude-logo.svg',
  '64a56daba3185114397e84e1e22fac08c8bfb971c458bc194a9e4022bd20e3a5': 'assets/claude-usage-screenshot.jpg',
  '4971f68cac405d51a27d29e248b58cd5f75019f9195278d86d65c940daa943e9': 'assets/fonts/LibreBaskerville-Bold.ttf',
  b93dfb2ec674ef59fd9a1b47498a8d1db498bb9e64ed22a96f8071082e3d6add: 'assets/fonts/LibreBaskerville-Regular.ttf',
  '90f36123a7ebd3827a5fa70bc31990374e5f3b5518b559952c9f6b326a87a44f': 'assets/icon.icns',
  '39987fcc0cedf964ae3aa8ac2977ebe7eb4c5653fb6128594c4b85701dbbe38e': 'assets/icon.ico',
  e4f282e1f8817b34e3882787b46f8bb665465d0eed23d7fb24708d39342f7082: 'assets/icon.svg',
  '3b3365be8cefa0448c4f3ed64a36ab60759dfeacb41fcc45e24d10659e0ef7fc': 'assets/logo.png',
  bfa5aa11f6672c911259308977d8e7dd1b48df8c0d29cb29bf352a544a09e3c0: 'assets/screenshot-graph.png',
  '558a3723df79d538f9b9de73ba20638f322598c2321017e3969ed6a87d39dbb4': 'assets/screenshot-main.png',
  fe14f21adb835351568d8b39e25d3f2a411b8b351002b19a02e1a2a7f8a27fbc: 'assets/screenshot-settings.png',
  cce7a73956998779fdf398305da0764994a9658da41bc9f10d48ef25fc936715: 'assets/screenshot-tray.png',
  '4c0a5eb979d58f500207c25b3158f3fa446c8b22a7eef16ec25496bb81540f36': 'assets/tray-icon-linux.png',
  f0ea0986a55a68ab44c2f206c44db6ad0bd75a51593e0010bac7179d075a5926: 'assets/tray-icon-mac.png',
  fa7381379238d8fc8b0837c9a09ffa1064f38a44c1dccc04e22bc3f577abf9fe: 'assets/tray-icon.png',
  eefadfd63cdc7644c6779908925960524c73d40eb734bfcc00a38c9bbe6a83b6: 'docs/maestro/cover.png',
  d33309dd03bf44ff7e12ec315e26036ed53d2178f4674c10b1c4613e30278a25: 'docs/maestro/icon.png',
  a28449f970a959ad4ddc582b2737d451fbcc15fd5e4da63555e5d6757a50875a: 'docs/maestro/menu-bar.png',
  '4f4800f83074d800ecc32c02f3e652abe3fb0bdc495ecdf5144b3f76144f076d': 'docs/maestro/refresh-dark.gif',
  '5ec6ce35af45c4de0b0af841eb98e99a24f835dfb31af445483ddb52ffe7e333': 'docs/maestro/refresh-light-b.gif',
  c62f4b24ec54dbe6632b31a0ff157279c92d5170f67b012cc430cda38276e8e7: 'docs/maestro/rings.png',
  '106b37606bfeb726f6e0313d2af4f2e98cc55aad58d5a59d25005b0aebd71cba': 'docs/maestro/statistics.png',
};
const ASSET_EXT = /\.(?:svg|png|jpe?g|gif|icns|ico|ttf|otf|woff2?)$/i;

// Their data layer is not ported (PLAN §1.3), nor the support link and the
// signature mark (§9.4; decided: not unless he asks).
const DATA_LAYER_FILES = ['fetch-via-window.js', 'normalize-usage-limits.js'];
const NOT_SHIPPED = /paypal|ohnedan|maestro-logo|coffee-?btn|Support The Maestro|claude-logo/i;

// Repo-relative paths with forward slashes, depth first.
function walk(dir, skipDirs, out = []) {
  if (!fs.existsSync(abs(dir))) return out;
  for (const ent of fs.readdirSync(abs(dir), { withFileTypes: true })) {
    const file = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (!skipDirs.has(file)) walk(file, skipDirs, out);
    } else if (ent.isFile()) {
      out.push(file);
    }
  }
  return out;
}

// What ships in the app (package.json build.files), minus vendored code.
function shippedSources() {
  const files = ['main.js', ...walk('src', new Set(['src/renderer/vendor']))];
  return files.filter((f) => /\.(?:js|css|html|json)$/.test(f));
}

// The comments before the first line of code, markers stripped. A shebang,
// a BOM and 'use strict' directives are allowed before them.
function leadingComments(src) {
  let rest = src.replace(/^﻿/, '').replace(/^#![^\n]*\n/, '');
  const parts = [];
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    let m = /^\/\/[^\n]*/.exec(rest);
    if (m) parts.push(m[0].slice(2));
    else if ((m = /^\/\*[\s\S]*?\*\//.exec(rest))) parts.push(m[0].slice(2, -2));
    else if (!(m = /^(['"])use strict\1;?/.exec(rest))) break;
    rest = rest.slice(m[0].length);
  }
  return parts.join('\n');
}

// Every comment in the file, roughly (a `//` inside a string counts too, which
// is fine for a presence check).
function allComments(src) {
  return (src.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) || []).join('\n');
}

// One line of text: leading `*` of block comments dropped, whitespace
// collapsed, so a header may wrap anywhere.
function flatten(text) {
  return text.split('\n').map((l) => l.replace(/^\s*\*?/, '')).join(' ').replace(/\s+/g, ' ');
}

// The parts of the header that are missing or malformed, as readable strings.
function headerProblems(src) {
  const head = flatten(leadingComments(src));
  const problems = [];
  if (!/Adapted from Claude Usage Widget\s?[—–-]{1,2}\s?The Maestro edition/.test(head)) {
    problems.push('missing "Adapted from Claude Usage Widget — The Maestro edition"');
  }
  if (!/github\.com\/TheMaestr-o\/claude-usage-widget @ b79d4b1, [\w./-]+\.(?:js|css|html):\d/.test(head)) {
    problems.push('missing "(github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, <their file>:<lines>)" with a real file and line range');
  }
  if (!/Copyright (?:\(c\)|©) 2024 Slavomir Durej; Maestro edition (?:\(c\)|©) 2026 The Maestro\./.test(head)) {
    problems.push('missing "Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro."');
  }
  if (!/MIT licen[cs]e; see LICENSE, ["“]Third-party code["”]\./.test(head)) {
    problems.push('missing \'MIT licence; see LICENSE, "Third-party code".\'');
  }
  return problems;
}

function section(markdown, heading) {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

// --- the checker itself -----------------------------------------------------

test('header check: accepts the §9.3 template in JS and CSS, rejects the placeholder and a late header', () => {
  const js = [
    "'use strict';",
    '// Adapted from Claude Usage Widget — The Maestro edition',
    '// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/app.js:1488-1529,',
    '// 1532-1566). Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.',
    '// MIT licence; see LICENSE, "Third-party code".',
    '// Our own description of the module may follow.',
    '(function () {})();',
  ].join('\n');
  assert.deepEqual(headerProblems(js), []);

  const css = [
    '/* Adapted from Claude Usage Widget — The Maestro edition',
    ' * (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/styles.css:1819-1970).',
    ' * Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.',
    ' * MIT licence; see LICENSE, "Third-party code". */',
    ':root { --x: 1px; }',
  ].join('\n');
  assert.deepEqual(headerProblems(css), []);

  const placeholder = js.replace('src/renderer/app.js:1488-1529,', '<their file>:<lines>).');
  assert.equal(headerProblems(placeholder).length, 1);
  assert.match(headerProblems(placeholder)[0], /b79d4b1/);

  const late = `const x = 1;\n${js}`;
  assert.equal(headerProblems(late).length, 4);
  assert.equal(headerProblems('').length, 4);
});

// --- LICENSE, package.json, README ------------------------------------------

test('LICENSE: our notice, then the Durej / Maestro notice, each with the full MIT text', () => {
  const text = read('LICENSE');
  assert.ok(
    text.startsWith(`MIT License\n\nCopyright (c) 2026 claude-swap-widget contributors\n\n${MIT_BODY}`),
    'LICENSE must open with our own MIT notice'
  );
  assert.ok(
    text.includes(
      'MIT License\n\nCopyright (c) 2024 Slavomir Durej\n' +
        `Copyright (c) 2026 The Maestro (https://github.com/TheMaestr-o)\n\n${MIT_BODY}`
    ),
    'LICENSE must carry the upstream notice with the Maestro line, verbatim'
  );
  assert.equal(text.split(MIT_BODY).length - 1, 2, 'the MIT permission text appears exactly twice');
  assert.match(text, /\nThird-party code\n/);
  assert.match(text, /https:\/\/github\.com\/TheMaestr-o\/claude-usage-widget, branch maestro-edition,\s+commit b79d4b1\)/);
  assert.match(text, /https:\/\/github\.com\/SlavomirDurej\/claude-usage-widget/);
});

test('LICENSE names Chart.js, and its licence file ships next to the vendored copy', () => {
  const text = read('LICENSE');
  assert.match(text, /Chart\.js \(MIT, Copyright \(c\) 2014-2024 Chart\.js Contributors\)/);
  assert.match(text, /@kurkle\/color library bundled in it \(MIT, Jukka Kurkela\)/);
  assert.match(text, /src\/renderer\/vendor\/LICENSE\.chartjs\.md/);
  if (exists('src/renderer/vendor/chart.umd.min.js')) {
    assert.ok(exists('src/renderer/vendor/LICENSE.chartjs.md'), 'vendored Chart.js without its licence');
  }
});

test('the packaged app ships LICENSE and everything under src/', () => {
  const { build } = JSON.parse(read('package.json'));
  assert.ok(build.files.includes('LICENSE'), 'build.files must include LICENSE');
  assert.ok(build.files.includes('src/**/*'), 'build.files must include src/**/* (vendor licence)');
});

test('README credits claude-swap, The Maestro, Slavomir Durej and Chart.js, and has the privacy note', () => {
  const text = read('README.md');
  assert.doesNotMatch(text, /no code or assets were copied/i);
  const credits = section(text, 'Credits');
  assert.ok(credits, 'README has a "## Credits" section');
  for (const link of [
    'https://github.com/realiti4/claude-swap',
    'https://github.com/TheMaestr-o/claude-usage-widget',
    'https://github.com/TheMaestr-o)',
    'https://github.com/SlavomirDurej/claude-usage-widget',
    'https://www.chartjs.org',
    '(LICENSE)',
  ]) {
    assert.ok(credits.includes(link), `Credits links ${link}`);
  }
  const privacy = section(text, 'Privacy');
  assert.ok(privacy, 'README has a "## Privacy" section');
  assert.match(privacy, /Claude Swap Widget\/history\//);
  assert.match(privacy, /never tokens or credentials/);
});

// --- file headers -----------------------------------------------------------

for (const file of HEADER_FILES) {
  test(`header: ${file}`, { skip: !exists(file) && 'not created yet' }, () => {
    assert.deepEqual(headerProblems(read(file)), [], `${file} must open with the PLAN §9.3 header`);
  });
}

for (const [file, ported] of Object.entries(LATE_HEADER_FILES)) {
  const src = exists(file) ? read(file) : null;
  let skip = false;
  if (src === null) skip = 'not created yet';
  else if (!ported.test(src) && !CLAIM.test(src)) skip = 'no ported code yet';
  test(`header: ${file}`, { skip }, () => {
    assert.deepEqual(headerProblems(src), [], `${file} carries ported code, so it must open with the PLAN §9.3 header`);
  });
}

test(`note: ${NOTE_FILE}`, { skip: !exists(NOTE_FILE) && 'not created yet' }, () => {
  assert.match(
    allComments(read(NOTE_FILE)),
    /Maestro/,
    `${NOTE_FILE} needs a one-line comment crediting Claude Usage Widget — The Maestro edition`
  );
});

test('every other source file that claims ported code has the full header', () => {
  const listed = new Set([...HEADER_FILES, ...Object.keys(LATE_HEADER_FILES), NOTE_FILE]);
  const files = [
    ...shippedSources(),
    ...walk('scripts', new Set()),
  ].filter((f) => /\.(?:js|css)$/.test(f) && !listed.has(f));
  const bad = {};
  for (const file of files) {
    const src = read(file);
    if (!CLAIM.test(src)) continue;
    const problems = headerProblems(src);
    if (problems.length) bad[file] = problems;
  }
  assert.deepEqual(bad, {});
});

// --- what must not ship -----------------------------------------------------

test('no Maestro asset is in the repo (logo, icons, tray pictures, fonts, screenshots)', () => {
  const skipDirs = new Set(['node_modules', 'dist', '.git', '.serena']);
  const found = [];
  for (const file of walk('', skipDirs)) {
    if (!ASSET_EXT.test(file)) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs(file))).digest('hex');
    if (MAESTRO_ASSETS[hash]) found.push(`${file} = their ${MAESTRO_ASSETS[hash]}`);
  }
  assert.deepEqual(found, []);
});

test('no support link, signature mark, Claude logo or Maestro data layer in what ships', () => {
  const found = [];
  for (const file of shippedSources()) {
    if (DATA_LAYER_FILES.includes(path.basename(file))) found.push(`${file}: their data layer`);
    const m = NOT_SHIPPED.exec(read(file));
    if (m) found.push(`${file}: "${m[0]}"`);
  }
  assert.deepEqual(found, []);
});
