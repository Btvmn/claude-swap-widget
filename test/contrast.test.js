'use strict';
// Contrast of the colour tokens in src/renderer/css/tokens.css, computed with
// the WCAG 2.x relative-luminance formula. Translucent colours are composited
// over their ground first. The real window is glass over the wallpaper, which
// no test can know, so this checks the opaque --sheet (Reduce transparency,
// html.opaque, CSW_CAPTURE) in all four token sets: light, dark, and both with
// "Increase contrast". The glass itself is judged by eye on the Mac.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'src', 'renderer', 'css');
const read = (name) => fs.readFileSync(path.join(CSS_DIR, name), 'utf8');

const TEXT_MIN = 4.5; // WCAG AA, body text
const UI_MIN = 3; // WCAG AA, non-text (focus ring)

// ── a small parser for the token file ────────────────────────────────────────

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Blocks at one nesting level, in file order: [{ prelude, body }].
function blocks(css) {
  const out = [];
  let i = 0;
  for (;;) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    out.push({ prelude: css.slice(i, open).trim().replace(/\s+/g, ' '), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

function declarations(body) {
  const out = {};
  for (const part of body.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// '@media (a: b) and (c: d)' → [['a','b'], ['c','d']]; anything else → null.
function mediaFeatures(prelude) {
  const m = /^@media (.+)$/.exec(prelude);
  if (!m) return null;
  const parts = m[1].split(/\s+and\s+/);
  const out = [];
  for (const p of parts) {
    const f = /^\((prefers-[\w-]+):\s*([\w-]+)\)$/.exec(p.trim());
    if (!f) return null;
    out.push([f[1], f[2]]);
  }
  return out;
}

// The custom properties :root ends up with for one environment, applying the
// file's blocks in order, as the cascade does. `env` maps a media feature to
// its value; `classes` lists classes on <html> (e.g. 'opaque').
function tokensFor(env, classes = []) {
  const css = stripComments(read('tokens.css'));
  const vars = {};
  for (const b of blocks(css)) {
    if (b.prelude === ':root') {
      Object.assign(vars, declarations(b.body));
    } else if (/^:root\.[\w-]+$/.test(b.prelude)) {
      if (classes.includes(b.prelude.slice(6))) Object.assign(vars, declarations(b.body));
    } else if (b.prelude.startsWith('@media')) {
      const features = mediaFeatures(b.prelude);
      assert.ok(features, `tokens.css: media query this test cannot read: ${b.prelude}`);
      if (!features.every(([k, v]) => env[k] === v)) continue;
      for (const inner of blocks(b.body)) {
        assert.equal(inner.prelude, ':root', `tokens.css: only :root inside ${b.prelude}`);
        Object.assign(vars, declarations(inner.body));
      }
    } else {
      assert.fail(`tokens.css holds tokens only; unexpected rule "${b.prelude}"`);
    }
  }
  return vars;
}

const THEMES = {
  light: { 'prefers-color-scheme': 'light' },
  dark: { 'prefers-color-scheme': 'dark' },
  'light, more contrast': { 'prefers-color-scheme': 'light', 'prefers-contrast': 'more' },
  'dark, more contrast': { 'prefers-color-scheme': 'dark', 'prefers-contrast': 'more' },
};

// ── colours ──────────────────────────────────────────────────────────────────

// → [r, g, b, a] with r,g,b in 0-255 and a in 0-1.
function parseColor(value, vars, seen = []) {
  const v = value.trim();
  let m;
  if ((m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v))) {
    if (seen.includes(m[1])) throw new Error(`cycle through ${m[1]}`);
    if (m[1] in vars) return parseColor(vars[m[1]], vars, [...seen, m[1]]);
    if (m[2] !== undefined) return parseColor(m[2], vars, seen);
    throw new Error(`undefined token ${m[1]}`);
  }
  if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v))) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(v))) {
    const n = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
  }
  if (v === 'transparent') return [0, 0, 0, 0];
  // color-mix(in srgb, <colour> P%, transparent): the colour at P % of its alpha.
  if ((m = /^color-mix\(\s*in srgb\s*,\s*([\s\S]+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(v))) {
    const c = parseColor(m[1], vars, seen);
    return [c[0], c[1], c[2], (c[3] * Number(m[2])) / 100];
  }
  throw new Error(`cannot read colour "${v}"`);
}

// fg over an opaque ground.
function over(fg, ground) {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + ground[i] * (1 - a)).concat(1);
}

function luminance(c) {
  const lin = (x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Contrast of text `ink` on `fills` laid over the opaque `ground`, in order.
function contrast(vars, ink, fills, ground) {
  let bg = parseColor(`var(${ground})`, vars);
  assert.equal(bg[3], 1, `${ground} must be opaque`);
  for (const f of fills) bg = over(parseColor(`var(${f})`, vars), bg);
  return ratio(over(parseColor(`var(${ink})`, vars), bg), bg);
}

const brightness = (c, k) => c.slice(0, 3).map((x) => Math.min(255, x * k)).concat(1);

// ── the checks ───────────────────────────────────────────────────────────────

test('parser: reads the colour forms tokens.css uses', () => {
  const vars = { '--a': '#ff9500', '--b': 'var(--a)' };
  assert.deepEqual(parseColor('#fff', vars), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgba(29, 29, 31, 0.74)', vars), [29, 29, 31, 0.74]);
  assert.deepEqual(parseColor('color-mix(in srgb, var(--b) 12%, transparent)', vars), [255, 149, 0, 0.12]);
  assert.deepEqual(parseColor('var(--missing, #000)', vars), [0, 0, 0, 1]);
  assert.throws(() => parseColor('var(--missing)', vars), /undefined token/);
  // Known WCAG pairs: black on white 21:1, #777 on white about 4.48:1.
  assert.equal(ratio([0, 0, 0, 1], [255, 255, 255, 1]).toFixed(2), '21.00');
  assert.equal(ratio(parseColor('#777', vars), [255, 255, 255, 1]).toFixed(2), '4.48');
});

test('dark and more-contrast only override tokens the light set defines', () => {
  const light = tokensFor(THEMES.light);
  for (const [name, env] of Object.entries(THEMES)) {
    const extra = Object.keys(tokensFor(env)).filter((k) => !(k in light));
    assert.deepEqual(extra, [], `${name} defines tokens that light lacks`);
  }
});

for (const [name, env] of Object.entries(THEMES)) {
  test(`${name}: text tokens keep ${TEXT_MIN}:1 on --sheet and on a --group card`, () => {
    const vars = tokensFor(env);
    const inks = ['--ink', '--ink-2', '--ink-3', '--warn-ink', '--danger-ink', '--ok-ink', '--accent-ink', '--chart-text'];
    for (const ink of inks) {
      const onSheet = contrast(vars, ink, [], '--sheet');
      assert.ok(onSheet >= TEXT_MIN, `${ink} on --sheet: ${onSheet.toFixed(2)}:1`);
      const onGroup = contrast(vars, ink, ['--group'], '--sheet');
      assert.ok(onGroup >= TEXT_MIN, `${ink} on --group: ${onGroup.toFixed(2)}:1`);
    }
  });

  test(`${name}: every pill keeps ${TEXT_MIN}:1 on its own tint`, () => {
    const vars = tokensFor(env);
    for (const tone of ['', 'warn-', 'crit-', 'accent-']) {
      const r = contrast(vars, `--pill-${tone}ink`, [`--pill-${tone}fill`], '--sheet');
      assert.ok(r >= TEXT_MIN, `${tone || 'neutral '}pill: ${r.toFixed(2)}:1`);
    }
  });

  test(`${name}: the primary button keeps ${TEXT_MIN}:1, also at its hover brightness`, () => {
    const vars = tokensFor(env);
    const ink = parseColor('var(--primary-ink)', vars);
    const fill = parseColor('var(--primary)', vars);
    assert.equal(fill[3], 1, '--primary must be opaque');
    assert.ok(ratio(ink, fill) >= TEXT_MIN, `at rest: ${ratio(ink, fill).toFixed(2)}:1`);
    const hover = /\.primary:hover[^{]*\{[^}]*brightness\(([\d.]+)\)/.exec(stripComments(read('base.css')));
    assert.ok(hover, 'base.css: .primary:hover { filter: brightness(…) }');
    const lit = brightness(fill, Number(hover[1]));
    assert.ok(ratio(ink, lit) >= TEXT_MIN, `on hover: ${ratio(ink, lit).toFixed(2)}:1`);
  });

  test(`${name}: chart tooltips and the pinned pill keep ${TEXT_MIN}:1`, () => {
    const vars = tokensFor(env);
    const pairs = [
      ['--chart-tip-fg', '--chart-tip-bg'],
      ['--chart-text', '--chart-tip-bg'],
      ['--chart-pill-fg', '--chart-pill-bg'],
    ];
    for (const [ink, ground] of pairs) {
      const r = contrast(vars, ink, [], ground);
      assert.ok(r >= TEXT_MIN, `${ink} on ${ground}: ${r.toFixed(2)}:1`);
    }
  });

  test(`${name}: the focus ring (--accent) keeps ${UI_MIN}:1 against --sheet`, () => {
    const vars = tokensFor(env);
    const r = contrast(vars, '--accent', [], '--sheet');
    assert.ok(r >= UI_MIN, `--accent on --sheet: ${r.toFixed(2)}:1`);
  });
}

test('chart colours are literal, and the series are 6-digit hex (inkAlpha parses them)', () => {
  for (const [name, env] of Object.entries(THEMES)) {
    const vars = tokensFor(env);
    const chart = Object.keys(vars).filter((k) => k.startsWith('--chart-'));
    assert.ok(chart.length >= 10, `${name}: the --chart-* set is missing`);
    for (const k of chart) {
      assert.doesNotMatch(vars[k], /var\(|color-mix\(/, `${name}: ${k} must be a literal colour for Chart.js`);
      parseColor(vars[k], {});
    }
    for (const k of ['--chart-5h', '--chart-7d', '--chart-spend']) {
      assert.match(vars[k], /^#[0-9a-f]{6}$/i, `${name}: ${k}`);
    }
  }
});

test('no glass: Reduce transparency and html.opaque paint the window with --sheet', () => {
  for (const scheme of ['light', 'dark']) {
    const glass = tokensFor({ 'prefers-color-scheme': scheme });
    assert.equal(glass['--window-fill'], 'var(--glass-fill)');
    const reduced = tokensFor({ 'prefers-color-scheme': scheme, 'prefers-reduced-transparency': 'reduce' });
    assert.equal(reduced['--window-fill'], 'var(--sheet)');
    const opaque = tokensFor({ 'prefers-color-scheme': scheme }, ['opaque']);
    assert.equal(opaque['--window-fill'], 'var(--sheet)');
    assert.equal(parseColor('var(--window-fill)', opaque)[3], 1, `${scheme}: --sheet is opaque`);
  }
});

test('every var() in base, screens and window resolves to a token', () => {
  const defined = new Set(Object.keys(tokensFor(THEMES.light)));
  const missing = [];
  for (const file of ['base.css', 'screens.css', 'window.css']) {
    const css = stripComments(read(file));
    for (const [, name] of css.matchAll(/--([\w-]+)\s*:/g)) defined.add(`--${name}`);
    for (const [, name, fallback] of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      if (!defined.has(name) && !fallback) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
