'use strict';
// Static guards for the popover page (PLAN §8, items 1–8): the CSP stays as
// it is, no inline styles or scripts, styles only through the CSSOM, no HTML
// parsing, no eval, nothing remote, system fonts only, no image or font assets.
//
// Scanned: every file under src/renderer except vendor/ (third-party code,
// pinned by its own test), plus every script index.html loads from outside
// src/renderer (src/shared/*.js). The scan is plain text and comments count
// too: write "HTML parsing" in a comment, not the API's name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const VENDOR = path.join(RENDERER, 'vendor');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:";
const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svg|woff2?|ttf|otf|eot)$/i;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p === VENDOR ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });
}

const rel = (f) => path.relative(ROOT, f);
const read = (f) => fs.readFileSync(f, 'utf8');
const files = walk(RENDERER);
const html = files.filter((f) => f.endsWith('.html'));
const css = files.filter((f) => f.endsWith('.css'));

// <script src> of every page, resolved; those outside src/renderer are
// scanned as renderer code too (they run in the page).
function scriptSrcs(file) {
  return [...read(file).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}
const outside = html
  .flatMap((f) => scriptSrcs(f).map((src) => path.resolve(path.dirname(f), src)))
  .filter((p) => !p.startsWith(RENDERER + path.sep) && fs.existsSync(p));
const js = [...new Set([...files.filter((f) => f.endsWith('.js')), ...outside])];

// Every match of every rule, as "file:line: rule (text)".
function scan(list, rules) {
  const hits = [];
  for (const file of list) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of rules) {
        if (re.test(line)) hits.push(`${rel(file)}:${i + 1}: ${name} (${line.trim().slice(0, 120)})`);
      }
    });
  }
  return hits;
}

// Start tags, so attribute rules never look at text or comments.
function tags(file) {
  const src = read(file).replace(/<!--[\s\S]*?-->/g, '');
  return [...src.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => ({ tag: m[0], line: src.slice(0, m.index).split('\n').length }));
}

function scanTags(list, rules) {
  const hits = [];
  for (const file of list) {
    for (const { tag, line } of tags(file)) {
      for (const [name, re] of rules) {
        if (re.test(tag)) hits.push(`${rel(file)}:${line}: ${name} (${tag.replace(/\s+/g, ' ').slice(0, 120)})`);
      }
    }
  }
  return hits;
}

// Rules, shared with the self-check at the bottom.
const RULES = {
  markupTags: [
    ['inline style attribute', /\sstyle\s*=/i],
    ['inline event handler', /\son[a-z]+\s*=/i],
    ['javascript: URL', /javascript:/i],
    ['embedded document', /^<(iframe|frame|object|embed|base)\b/i],
    ['remote src/href', /\s(src|href)\s*=\s*["']?\s*(https?:)?\/\//i],
    ['node_modules path', /node_modules/i],
    ['image file', /^<(img|image|link)\b(?=[^>]*\s(src|href)\s*=\s*["']?(?!data:|#))[^>]*\.(png|jpe?g|gif|webp|avif|ico|svg)\b/i],
  ],
  cssom: [
    ['setAttribute style', /setAttribute(NS)?\s*\([^)]*['"`]style['"`]/],
    ['cssText', /\.cssText\b/],
    ['insertRule', /\binsertRule\b/],
    ['style element', /createElement(NS)?\s*\([^)]*['"`]style['"`]/],
    ['constructed stylesheet', /\badoptedStyleSheets\b|\bnew\s+CSSStyleSheet\b|\.replaceSync\s*\(/],
  ],
  html: [
    ['innerHTML', /\binnerHTML\b/],
    ['outerHTML', /\bouterHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
    ['document.write', /\bdocument\s*\.\s*write(ln)?\b/],
    ['DOMParser', /\bDOMParser\b/],
    ['createContextualFragment', /\bcreateContextualFragment\b/],
    ['unsafe HTML setter', /\b(setHTMLUnsafe|parseHTMLUnsafe)\b/],
    ['srcdoc', /\bsrcdoc\b/],
  ],
  evaluation: [
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\b/],
    ['Function constructor', /(^|[^\w$.])Function\s*\(/],
    ['string timer', /\bset(Timeout|Interval|Immediate)\s*\(\s*['"`]/],
  ],
  remote: [
    ['fetch', /(^|[^\w$.])fetch\s*\(|\b(window|self|globalThis)\s*\.\s*fetch\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    ['sendBeacon', /\bsendBeacon\b/],
    ['dynamic import', /(^|[^\w$.])import\s*\(/],
    ['importScripts', /\bimportScripts\b/],
    ['node_modules path', /node_modules/],
    ['FontFace', /\bnew\s+FontFace\b|\bfonts\s*\.\s*add\s*\(/],
  ],
  styles: [
    ['@font-face', /@font-face/i],
    ['@import', /@import\b/i],
    ['remote url()', /url\(\s*["']?\s*(https?:)?\/\//i],
    // Only same-document fragments (url(#arcGradient)) and data: URIs.
    ['url() to a file', /url\(\s*["']?\s*(?!#|data:|["']|\s)/i],
    ['node_modules path', /node_modules/i],
  ],
  assets: [['Maestro asset', /claude-logo|tray-icon\.png|\bassets\//i]],
};

test('the renderer folder is where the scan looks', () => {
  assert.ok(fs.existsSync(path.join(RENDERER, 'index.html')), 'src/renderer/index.html exists');
  assert.ok(js.length > 0 && css.length > 0, 'found scripts and stylesheets to scan');
});

test('1. every page carries the exact CSP, before anything it loads', () => {
  for (const file of html) {
    const src = read(file).replace(/<!--[\s\S]*?-->/g, '');
    const metas = [...src.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)];
    assert.equal(metas.length, 1, `${rel(file)}: one CSP meta`);
    const content = /\scontent\s*=\s*"([^"]*)"/i.exec(metas[0][0]) || /\scontent\s*=\s*'([^']*)'/i.exec(metas[0][0]);
    assert.equal(content && content[1], CSP, `${rel(file)}: the CSP string is unchanged`);
    const firstLoad = src.search(/<(script|link|style|img)\b/i);
    assert.ok(firstLoad === -1 || metas[0].index < firstLoad, `${rel(file)}: the CSP comes before the first script, link or image`);
  }
});

test('2. markup has no inline styles, handlers or scripts', () => {
  assert.deepEqual(scanTags(html, RULES.markupTags), []);
  const hits = [];
  for (const file of html) {
    const src = read(file).replace(/<!--[\s\S]*?-->/g, '');
    if (/<style\b/i.test(src)) hits.push(`${rel(file)}: <style> element`);
    for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (!/\bsrc\s*=/.test(m[1])) hits.push(`${rel(file)}: <script> without src`);
      if (m[2].trim()) hits.push(`${rel(file)}: inline script body`);
    }
  }
  assert.deepEqual(hits, []);
});

test('3. scripts set styles only through the CSSOM', () => {
  assert.deepEqual(scan(js, RULES.cssom), []);
});

test('4. scripts never parse HTML', () => {
  assert.deepEqual(scan(js, RULES.html), []);
});

test('5. no eval in any form', () => {
  assert.deepEqual(scan(js, RULES.evaluation), []);
});

test('6. nothing remote: no network calls, no node_modules paths', () => {
  assert.deepEqual(scan(js, RULES.remote), []);
  assert.deepEqual(scan([...html, ...css], [['node_modules path', /node_modules/i]]), []);
});

test('7. system fonts only; stylesheets import nothing', () => {
  assert.deepEqual(scan(css, RULES.styles), []);
  const links = html.flatMap((f) => tags(f).filter((x) => /^<link\b/i.test(x.tag)).map((x) => ({ f, ...x })));
  const bad = links.filter(({ tag }) => !/\bhref\s*=\s*["']?(?![a-z]+:|\/\/)[^"'\s>]+\.css["']?/i.test(tag) || !/\brel\s*=\s*["']?stylesheet\b/i.test(tag));
  assert.deepEqual(
    bad.map(({ f, line, tag }) => `${rel(f)}:${line}: ${tag}`),
    [],
    'every <link> is a local stylesheet',
  );
});

test('8. no image or font files, no Maestro assets', () => {
  assert.deepEqual(files.filter((f) => ASSET_EXT.test(f)).map(rel), []);
  assert.deepEqual(scan([...html, ...css, ...js], RULES.assets), []);
});

// The desktop widget is on screen all day: an endless animation, or a
// transition that the 1 s clock restarts every second, repaints it without
// end (measured: a fifth to a third of a CPU core, 2026-09-30).
const LOOP_OK = /\banimation(-iteration-count)?\s*:\s*(spin\b|bar-sweep\b.*\bpaused\b|infinite\s*!important)/;

test('9. nothing animates forever by itself: spinners loop, the bar sweep only while cswap works', () => {
  const loops = [];
  for (const f of css) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (/\binfinite\b/.test(line) && !LOOP_OK.test(line)) loops.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(loops, []);
  const timeArc = read(path.join(RENDERER, 'css', 'hero.css')).match(/\n\.ring-time \{[^}]*\}/);
  assert.ok(timeArc, 'hero.css styles .ring-time');
  assert.doesNotMatch(timeArc[0], /transition/, '.ring-time must not transition: the 1 s clock would keep it moving');
  for (const line of ['  animation: glow-warn 2.8s ease-in-out infinite;', '  animation: pulse 2s infinite paused;']) {
    assert.ok(!LOOP_OK.test(line), `the check lets through: ${line}`);
  }
});

// The rules themselves: each catches what it is for and lets through what
// today's code legitimately does.
test('the rules catch violations and pass legitimate code', () => {
  const hit = (group, line) => RULES[group].some(([, re]) => re.test(line));
  const cases = [
    ['markupTags', '<div style="display:none">', true],
    ['markupTags', '<button onclick="go()">', true],
    ['markupTags', '<script src="https://cdn.example/x.js">', true],
    ['markupTags', '<script src="../../node_modules/chart.js/dist/chart.umd.js">', true],
    ['markupTags', '<img src="assets/logo.png">', true],
    ['markupTags', '<iframe src="x.html">', true],
    ['markupTags', '<circle class="ring-usage" stroke-dasharray="263.89" data-c="263.89">', false],
    ['markupTags', '<section id="hero" class="hero" hidden data-account="">', false],
    ['markupTags', '<button id="stats-btn" aria-pressed="false" data-i18n-title="btn.graph">', false],
    ['cssom', "el.setAttribute('style', 'color:red')", true],
    ['cssom', 'el.style.cssText = x', true],
    ['cssom', "document.createElement('style')", true],
    ['cssom', 'sheet.insertRule(rule)', true],
    ['cssom', "el.style.setProperty('--i', String(i))", false],
    ['cssom', "el.setAttribute('aria-disabled', 'true')", false],
    ['cssom', "new Intl.NumberFormat(undefined, { style: 'currency', currency })", false],
    ['html', 'el.innerHTML = text', true],
    ['html', "el.insertAdjacentHTML('beforeend', x)", true],
    ['html', 'new DOMParser()', true],
    ['html', 'el.textContent = text', false],
    ['evaluation', 'eval(code)', true],
    ['evaluation', "new Function('return 1')", true],
    ['evaluation', "setTimeout('tick()', 10)", true],
    ['evaluation', 'setTimeout(tick, 10)', false],
    ['evaluation', 'retrieval(x)', false],
    ['evaluation', 'if (typeof x === "function") x()', false],
    ['remote', "fetch('https://x')", true],
    ['remote', 'window.fetch(u)', true],
    ['remote', 'new XMLHttpRequest()', true],
    ['remote', "import('./x.js')", true],
    ['remote', '// Countdowns tick in place, without a refetch or a rebuild.', false],
    ['remote', "const SVG = 'http://www.w3.org/2000/svg';", false],
    ['remote', 'state.fetchedAt', false],
    ['styles', "@import url('x.css');", true],
    ['styles', '@font-face { font-family: X; }', true],
    ['styles', 'background: url(https://x/y.png)', true],
    ['styles', "background: url('img/x.png')", true],
    ['styles', 'stroke: url(#sessionArcGradient);', false],
    ['styles', 'background: url("data:image/svg+xml;utf8,<svg/>")', false],
    ['styles', 'font-family: -apple-system, BlinkMacSystemFont, sans-serif;', false],
    ['assets', "img.src = 'assets/claude-logo.svg'", true],
  ];
  const wrong = cases.filter(([group, line, expected]) => hit(group, line) !== expected);
  assert.deepEqual(wrong, []);
});
