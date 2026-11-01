'use strict';
// The README's pictures: the project page opens with them, and a missing one is
// a broken image and a long alt text that no other test would notice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { STRINGS } = require('../src/shared/i18n');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('every local picture the README shows exists', () => {
  const html = [...README.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const markdown = [...README.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
  const local = [...html, ...markdown].filter((src) => !/^[a-z]+:/i.test(src));
  assert.ok(local.length >= 6, `found ${local.length}: the patterns still match the README`);
  for (const src of local) assert.ok(fs.existsSync(path.join(ROOT, src)), `${src} is shown in the README but does not exist`);
});

test('the Re-login entry says which badge\'s tooltip has the numbered command', () => {
  const text = README.replace(/\s+/g, ' ');
  assert.match(STRINGS.en['badge.tip.login'], /cswap add --slot \{n\}$/);
  assert.ok(text.includes('The **Login expires** badge\'s tooltip has the command with the right number'));
  assert.match(STRINGS.en['badge.tip.relogin_required'], /cswap add$/);
  assert.ok(text.includes('**Re-login** says plain `cswap add`'));
});
