'use strict';
// `npm run vendor`: copies Chart.js from node_modules into the renderer, so
// the page loads it from src/renderer/vendor/ (script-src 'self') and never
// from node_modules, which the packaged app does not ship (PLAN §5.4). Both
// output files are committed; this script only makes them reproducible.
//
//   src/renderer/vendor/chart.umd.min.js    dist/chart.umd.min.js, byte for byte
//   src/renderer/vendor/LICENSE.chartjs.md  Chart.js's LICENSE.md, plus the
//                                           notice of @kurkle/color, which the
//                                           bundle carries inside it
//
// The version comes from package.json, where chart.js is an exact devDependency.
// A file is written only when its content changed, so a second run is a no-op.
// `npm run vendor -- --check` writes nothing and exits 1 when a vendored file
// differs from what node_modules would give.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join('src', 'renderer', 'vendor'); // relative to the root
const BUNDLE = 'chart.umd.min.js';
const LICENSE_OUT = 'LICENSE.chartjs.md';

// The @kurkle/color build inside the bundle. Its licence is not in the chart.js
// package, and the @kurkle/color that npm installs next to it is a newer one
// (0.3.4, "2018-2024"), so the notice of the bundled version is kept here:
// LICENSE.md of @kurkle/color 0.3.2 from the npm registry is Chart.js's
// LICENSE.md with this copyright line (checked 2026-09-29). Updating Chart.js
// fails below until this is checked again for the new bundle.
const KURKLE = Object.freeze({ version: '0.3.2', copyright: 'Copyright (c) 2018-2021 Jukka Kurkela' });

const EXACT = /^\d+\.\d+\.\d+$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The exact chart.js version package.json pins; a range would make the
// vendored file depend on the day of the install.
function pinnedVersion(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const spec = (pkg.devDependencies || {})['chart.js'];
  if (!spec) throw new Error('package.json has no chart.js devDependency');
  if (!EXACT.test(spec)) throw new Error(`package.json must pin chart.js exactly (x.y.z), not "${spec}"`);
  return spec;
}

// The two output files as { name: Buffer }, built from root/node_modules.
// Throws when chart.js is missing, is another version than the pinned one, or
// its bundle does not look like the build whose licences we ship.
function build({ root = ROOT } = {}) {
  const version = pinnedVersion(root);
  const dir = path.join(root, 'node_modules', 'chart.js');
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) throw new Error('chart.js is not installed: run npm install (or npm ci) first');
  const installed = readJson(pkgFile).version;
  if (installed !== version) {
    throw new Error(`node_modules has chart.js ${installed}, package.json pins ${version}: run npm install`);
  }

  const bundle = fs.readFileSync(path.join(dir, 'dist', BUNDLE));
  const text = bundle.toString('utf8');
  if (!text.startsWith(`/*!\n * Chart.js v${version}\n`)) {
    throw new Error(`dist/${BUNDLE} does not start with the Chart.js v${version} banner`);
  }
  const kurkle = /@kurkle\/color v(\d+\.\d+\.\d+)/.exec(text);
  if (!kurkle || kurkle[1] !== KURKLE.version) {
    throw new Error(
      `the bundle carries @kurkle/color ${kurkle ? `v${kurkle[1]}` : '(no banner)'}, not v${KURKLE.version}: ` +
        'check its licence and update KURKLE in scripts/vendor.js'
    );
  }

  const chartLicense = fs.readFileSync(path.join(dir, 'LICENSE.md'), 'utf8');
  const chartCopyright = /^Copyright \(c\) .+$/m.exec(chartLicense);
  if (!chartCopyright || !chartLicense.includes('Permission is hereby granted')) {
    throw new Error('chart.js LICENSE.md is not the MIT text this script expects');
  }
  const kurkleLicense = chartLicense.replace(chartCopyright[0], KURKLE.copyright);

  const notice = [
    '# Licences of src/renderer/vendor/',
    '',
    'Written by `npm run vendor` (scripts/vendor.js); do not edit by hand.',
    '',
    `\`${BUNDLE}\` is Chart.js v${version}, copied unchanged from the npm package`,
    `\`chart.js@${version}\` (\`dist/${BUNDLE}\`). It bundles @kurkle/color v${KURKLE.version}.`,
    'Both are MIT licensed and keep their `/*! … */` banners in the file; their',
    'licences follow.',
    '',
    `## Chart.js v${version}`,
    '',
    chartLicense.trimEnd(),
    '',
    `## @kurkle/color v${KURKLE.version} (bundled in ${BUNDLE})`,
    '',
    kurkleLicense.trimEnd(),
    '',
  ].join('\n');

  return { [BUNDLE]: bundle, [LICENSE_OUT]: Buffer.from(notice, 'utf8') };
}

// Compares (check) or writes the files into outDir. Returns one entry per
// file: { file, bytes, status: 'unchanged' | 'updated' | 'differs' }.
function vendor({ root = ROOT, outDir = path.join(root, OUT_DIR), check = false } = {}) {
  const files = build({ root });
  if (!check) fs.mkdirSync(outDir, { recursive: true });
  return Object.entries(files).map(([name, content]) => {
    const file = path.join(outDir, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const same = current !== null && current.equals(content);
    if (!same && !check) {
      // tmp + rename, so an interrupted run never leaves half a bundle behind
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
    }
    return { file, bytes: content.length, status: same ? 'unchanged' : check ? 'differs' : 'updated' };
  });
}

function main(argv) {
  const check = argv.includes('--check');
  let results;
  try {
    results = vendor({ check });
  } catch (e) {
    console.error(`vendor: ${e.message}`);
    return 1;
  }
  console.log(`vendor: chart.js ${pinnedVersion(ROOT)}${check ? ' (check only)' : ''}`);
  for (const r of results) {
    const rel = path.relative(ROOT, r.file);
    console.log(`  ${rel.padEnd(40)} ${String(r.bytes).padStart(7)} B  ${r.status}`);
  }
  if (check && results.some((r) => r.status === 'differs')) {
    console.error('vendor: the vendored files are out of date; run npm run vendor');
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { build, vendor, pinnedVersion, KURKLE, OUT_DIR, BUNDLE, LICENSE_OUT };
