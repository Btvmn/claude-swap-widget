'use strict';
// The menu-bar picture (PLAN §4, §8 item 10): the 'ring' style, painted by
// the popover's page on a canvas and applied by main (src/main/tray.js).
// Covers the first picture while the popover was never shown, the tooltip's
// reset lines, the busy frame of a deliberate refresh and of a switch, the
// menu-bar appearance, "?" and "–", the classic fallback after a renderer
// crash and when no answer comes within 1 s, and the strict check of every
// tray:image answer. Each picture main applies is also saved as
// <out>/tray-<name>.png (2x) for review by eye.
//
// The page's tray:draw messages are recorded by a second onTrayDraw listener
// installed through t.js(); the painter itself is left alone except where a
// section patches HTMLCanvasElement.prototype.toDataURL to make it fail.

const fs = require('fs');
const path = require('path');

const trayUi = () => require(path.join(process.env.E2E_APP, 'src', 'main', 'tray.js'));

// What the runner recorded for a setImage call: the canvas picture is one 2x
// representation 18 pt high; the classic ring is 18 × 18 pt at 1x and 2x.
const isPicture = (d) => Boolean(d && d.height === 18 && d.scaleFactors && d.scaleFactors.join() === '2');
const isClassic = (d) => Boolean(d && d.width === 18 && d.height === 18 && d.scaleFactors && d.scaleFactors.join() === '1,2');
const TOOLTIP_ALICE = /^work · 5h 20% · 7d 34%\nSession: 20% · resets at \d{1,2}:\d\d\s?[AP]M\nWeek: 34% · resets [A-Z][a-z]{2} \d{1,2}$/;

module.exports = {
  description: 'menu-bar picture: ring style from the page, busy frames, appearance, fallbacks, strict tray:image checks',
  settings: { trayStyle: 'ring' },
  show: false, // the first picture must come while the popover was never shown (PLAN R1)
  timeout: 120_000,
  async run(t) {
    const tray = trayUi();
    const saved = [];
    const save = (name) => {
      const img = tray.appliedImage();
      const file = path.join(t.out, `tray-${name}.png`);
      fs.writeFileSync(file, img.toPNG({ scaleFactor: 2 }));
      saved.push(path.basename(file));
    };
    // tray:draw messages as the page receives them.
    const draws = {
      async start() {
        await t.js(() => {
          if (!window.__trayDraws) {
            window.__trayDraws = [];
            window.api.onTrayDraw((m) => window.__trayDraws.push(m));
          }
          window.__trayDraws.length = 0;
          return true;
        });
      },
      list: () => t.js(() => window.__trayDraws.slice()),
      async last() {
        const list = await draws.list();
        return list[list.length - 1];
      },
    };
    const switchTo = async (n) => {
      t.ok(await t.ui.clickSwitch(n), `account ${n} has a Switch button`);
      await t.waitFor(async () => (await t.state()).activeAccountNumber === n, `account ${n} active`, { timeout: 10_000 });
      await t.idle();
    };

    // The menu bar's appearance, as main reads it; restored at the end.
    const prefs = t.electron.systemPreferences;
    const realDefault = prefs.getUserDefault;
    let menuBar = null; // null: the Mac's own; 'Dark' / '': forced
    try {
      prefs.getUserDefault = (key, type) => (key === 'AppleInterfaceStyle' && menuBar !== null ? menuBar : realDefault.call(prefs, key, type));
    } catch {}
    const canForce = prefs.getUserDefault !== realDefault;

    try {
      t.section('the first picture, before the popover was ever shown');
      t.equal(t.win.isVisible(), false, 'the popover has not been shown');
      await t.expect(() => isPicture(t.trayImage()), true, 'the tray shows a picture painted by the page');
      const alice = t.trayImage();
      t.equal([alice.height, alice.template], [18, true], 'alice’s 20 · 34: 18 pt high, a template image');
      t.ok(alice.width > 18 && alice.width <= 80, `wider than the ring alone, at most 80 pt (${alice.width} pt)`);
      t.equal(tray.appliedKind(), 'picture', 'main applied the picture');
      t.equal(t.trayTitle(), '', 'no title next to it');
      t.match(t.trayTooltip(), TOOLTIP_ALICE, 'the tooltip adds the session and week reset lines');
      save('alice');

      t.section('Refresh Now: a busy frame, then the normal one');
      await draws.start();
      let mark = t.trayImages.length;
      t.click(await t.trayMenu(), 'Refresh Now');
      await t.idle();
      await t.expect(async () => (await draws.list()).map((d) => d.busy), [true, false], 'one busy frame, then the normal one');
      const busyImages = t.trayImages.slice(mark);
      t.equal(busyImages.length, 2, 'two pictures applied');
      t.ok(busyImages.length === 2 && busyImages[0].hash !== alice.hash && isPicture(busyImages[0]), 'the busy picture differs from the normal one');
      t.equal(t.trayImage().hash, alice.hash, 'and the normal picture is back');

      t.section('the page’s refresh button is deliberate too; the timer is not');
      await draws.start();
      await t.ui.clickRefresh();
      await t.idle();
      await t.expect(async () => (await draws.list()).map((d) => d.busy), [true, false], 'the refresh button gives a busy frame');
      await draws.start();
      mark = t.trayImages.length;
      await t.service.refresh(); // what the 60 s timer does
      await t.idle();
      t.equal(await draws.list(), [], 'a timer refresh with the same numbers asks for nothing');
      t.equal(t.trayImages.length, mark, 'and changes nothing');

      t.section('menu-bar appearance, template picture');
      if (!canForce) {
        t.log('systemPreferences.getUserDefault cannot be replaced here; appearance checks skipped');
      } else {
        await draws.start();
        mark = t.trayImages.length;
        menuBar = realDefault.call(prefs, 'AppleInterfaceStyle', 'string') === 'Dark' ? '' : 'Dark';
        tray.update(); // what the AppleInterfaceThemeChangedNotification handler does after 150 ms
        t.ok(await tray.settled(1500), 'the page answered');
        const d = await draws.last();
        t.equal(d && d.dark, menuBar === 'Dark', 'the new frame is drawn for the other appearance');
        t.equal(t.trayImages.length, mark, 'a template picture comes back byte for byte, so the item is not touched');
      }

      t.section('a switch: busy while switching, then carol in colour');
      await draws.start();
      await switchTo(3);
      let list = await draws.list();
      t.ok(list.some((d) => d.busy), 'a busy frame while switching');
      let d = list[list.length - 1];
      t.equal(
        d && [d.busy, d.five, d.seven, d.doubtful],
        [false, { pct: 95, hot: 'danger' }, { pct: 88, hot: 'warn' }, false],
        'carol’s 95 · 88: red and amber',
      );
      await t.expect(() => t.trayImage().template, false, 'a hot picture is not a template');
      t.equal(t.trayImage().height, 18, '18 pt high');
      if (canForce) {
        const hashes = {};
        for (const look of ['', 'Dark']) {
          menuBar = look;
          tray.update();
          t.ok(await tray.settled(1500), `answered for the ${look ? 'dark' : 'light'} menu bar`);
          hashes[look || 'light'] = t.trayImage().hash;
          save(`carol-${look ? 'dark' : 'light'}`);
        }
        t.ok(hashes.light !== hashes.Dark, 'the ink follows the menu bar: two different pictures');
        menuBar = null;
        tray.update();
        await tray.settled(1500);
      } else {
        save('carol');
      }

      t.section('dave: last-good data is doubtful');
      await draws.start();
      await switchTo(4);
      d = await draws.last();
      t.equal(d && [d.five, d.seven, d.doubtful], [{ pct: 42, hot: null }, { pct: 50, hot: null }, true], 'dave’s 42 · 50, doubtful');
      await t.expect(() => t.trayImage().template, true, 'a template picture');
      t.equal(t.trayTitle(), '', 'the "?" is in the picture, not the title');
      t.match(t.trayTooltip(), /^dave@example\.com · 5h 42% · 7d 50% · stale\nSession: 42%/, 'the tooltip says stale');
      save('dave');

      t.section('a failed refresh (garbage) marks alice’s numbers "?"');
      await switchTo(1);
      await t.expect(() => t.trayImage().hash, alice.hash, 'alice’s picture is back');
      await draws.start();
      t.scenario('garbage');
      let s = await t.refresh();
      t.equal([s.phase, Boolean(s.error)], ['ok', true], 'the list is kept, with an error');
      d = await draws.last();
      t.equal(d && [d.five, d.seven, d.doubtful, d.busy], [{ pct: 20, hot: null }, { pct: 34, hot: null }, true, false], 'the same numbers, doubtful');
      t.ok(t.trayImage().width > alice.width, `the picture grew by the "?" (${alice.width} → ${t.trayImage().width} pt)`);
      t.match(t.trayTooltip(), /· not updated for /, 'the tooltip says since when');
      save('alice-failing');

      t.section('a rolled-over window shows "–"');
      t.scenario('rolled');
      s = await t.refresh();
      t.equal([s.phase, s.error], ['ok', null], 'the list loads again');
      d = await draws.last();
      t.equal(d && [d.five, d.seven, d.doubtful], [{ pct: null, hot: null }, { pct: 34, hot: null }, false], 'no 5h value, the 7d stays');
      t.match(t.trayTooltip(), /^work · 5h window has reset, waiting for new data · 7d 34%\nWeek: 34% · resets /, 'no session line under a reset window');
      save('alice-rolled');
      t.scenario('default');
      await t.refresh();
      await t.expect(() => t.trayImage().hash, alice.hash, 'back to 20 · 34');

      t.section('styles from the menu');
      const menu = await t.trayMenu();
      if (!t.find(menu, 'Double Ring')) {
        t.log('no Settings › Menu Bar › Style menu yet; style checks skipped');
      } else {
        t.click(menu, 'Double Ring');
        await t.idle();
        t.equal((t.settings() || {}).trayStyle, 'rings', 'saved as rings');
        await t.expect(() => isPicture(t.trayImage()) && t.trayImage().width, 16, 'double ring: 16 pt wide, no digits');
        save('alice-rings');
        t.scenario('garbage');
        await t.refresh();
        await t.expect(t.trayTitle, ' ?', 'its "?" goes to the title');
        t.scenario('default');
        await t.refresh();
        await t.expect(t.trayTitle, '', 'and goes away with the error');
        t.click(await t.trayMenu(), 'Classic');
        await t.idle();
        await t.expect(() => isClassic(t.trayImage()), true, 'classic: the ring drawn by main');
        await t.expect(t.trayTitle, ' 20%', 'with the titleMode title');
        t.equal(t.trayTooltip(), 'work · 5h 20% · 7d 34%', 'and today’s one-line tooltip');
        t.click(await t.trayMenu(), 'Ring and Numbers');
        await t.idle();
        await t.expect(() => t.trayImage().hash, alice.hash, 'back to the ring');
      }

      t.section('a renderer crash: classic within 1 s, the picture after the reload');
      t.allow('renderer-gone');
      mark = t.trayImages.length;
      let t0 = Date.now();
      t.win.webContents.forcefullyCrashRenderer();
      await t.waitFor(() => isClassic(t.trayImage()), 'the classic ring after the crash', { timeout: 3000 });
      t.ok(Date.now() - t0 < 1000, `the classic ring came ${Date.now() - t0} ms after the crash`);
      t.equal(t.trayTitle(), ' 20%', 'with the classic title');
      await t.waitFor(() => t.trayImage().hash === alice.hash, 'the picture after the reload', { timeout: 10_000 });
      t.ok(t.trayImages.slice(mark).some(isClassic), 'classic in between');
      await t.waitFor(() => t.js('document.readyState === "complete"'), 'the reloaded page', { timeout: 5000 });

      t.section('no answer within 1 s: classic');
      t.allow('renderer-error', /tray picture/);
      await t.js(() => {
        const proto = HTMLCanvasElement.prototype;
        if (!window.__realToDataURL) window.__realToDataURL = proto.toDataURL;
        window.__trayMode = 'ok';
        proto.toDataURL = function (...args) {
          if (window.__trayMode === 'throw') throw new Error('blocked by tray.flow.js');
          if (window.__trayMode === 'bad') return window.__trayBad;
          return window.__realToDataURL.apply(this, args);
        };
        return true;
      });
      await t.js(() => ((window.__trayMode = 'throw'), true));
      mark = t.trayImages.length;
      t0 = Date.now();
      await t.ui.clickRefresh();
      await t.waitFor(() => isClassic(t.trayImage()), 'the classic ring', { timeout: 4000 });
      const waited = Date.now() - t0;
      t.ok(waited >= 900 && waited < 3000, `classic after the answer timeout (${waited} ms after the refresh click)`);
      t.equal(t.trayImages.slice(mark).filter(isPicture).length, 0, 'no picture was applied meanwhile');
      t.equal(t.trayTitle(), ' 20%', 'with the classic title');
      await t.idle();

      t.section('tray:image answers are checked strictly');
      // Each update() asks again (main forgets a frame it fell back from);
      // the painter answers with a bad picture, which main must refuse at
      // once rather than after its 1 s timeout.
      const bad = await t.js(() => {
        const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
        const real = (c, type) => window.__realToDataURL.call(c, type);
        const prefix = 'data:image/png;base64,';
        return {
          'a PNG 40 px high': real(canvas(40, 40)),
          'a PNG 170 px wide': real(canvas(170, 36)),
          'a JPEG': real(canvas(60, 36), 'image/jpeg'),
          'a GIF labelled PNG': prefix + btoa('GIF89a' + 'x'.repeat(40)),
          'broken base64': prefix + '!!!!' + real(canvas(60, 36)).slice(prefix.length + 4),
          'over 100,000 characters': prefix + 'A'.repeat(100_000),
        };
      });
      for (const [what, url] of Object.entries(bad)) {
        await t.js((u) => ((window.__trayBad = u), (window.__trayMode = 'bad'), true), url);
        await draws.start();
        mark = t.trayImages.length;
        tray.update();
        const prompt = await tray.settled(600);
        const asked = (await draws.list()).length;
        t.ok(asked === 1 && prompt && tray.appliedKind() === 'classic' && !t.trayImages.slice(mark).some(isPicture), `${what}: refused at once, classic shown`);
      }

      // Hand-made answers: the painter is blocked and the flow answers.
      const { BrowserWindow } = t.electron;
      const stranger = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
      await stranger.loadURL('about:blank');
      await t.js(() => ((window.__trayMode = 'throw'), true));
      await draws.start();
      const t1 = Date.now();
      tray.update();
      const ask = await t.waitFor(() => draws.last(), 'a tray:draw');
      const good = await t.js((msg) => {
        window.__trayMode = 'ok';
        const out = window.TrayPicture.render(msg);
        window.__trayMode = 'throw';
        return out.dataUrl;
      }, ask);
      const send = (...args) => t.js((a) => (window.api.sendTrayImage(...a), true), args);
      mark = t.trayImages.length;
      await send(ask.seq - 1, good, true);
      await send(String(ask.seq), good, true);
      await t.wait(100);
      t.ok(!(await tray.settled(0)) && t.trayImages.length === mark, 'an older seq and a string seq are ignored: still waiting');
      // Another window may not answer at all, not even with the right seq.
      try {
        await stranger.webContents.executeJavaScript(`require('electron').ipcRenderer.send('tray:image', ${ask.seq}, ${JSON.stringify(good)}, true); true`);
        await t.wait(100);
        t.ok(!(await tray.settled(0)) && t.trayImages.length === mark, 'an answer from another window is ignored');
      } catch (err) {
        t.log(`could not send from a second window (${err.message}); that check is skipped`);
      }
      stranger.destroy();
      await send(ask.seq, good, 'yes');
      const refused = await tray.settled(300);
      t.ok(refused && Date.now() - t1 < 1000 && tray.appliedKind() === 'classic', `a template flag that is not a boolean: refused, classic (${Date.now() - t1} ms after the ask)`);
      await draws.start();
      tray.update();
      const again = await t.waitFor(() => draws.last(), 'another tray:draw');
      t.ok(again.seq > ask.seq, `the next frame has a new seq (${ask.seq} → ${again.seq})`);
      await send(again.seq, good, true);
      await t.expect(() => t.trayImage().hash, alice.hash, 'a valid answer for the latest seq is applied');
      t.equal(t.trayTitle(), '', 'with the picture’s title');

      t.section('the page paints again');
      await t.js(() => ((HTMLCanvasElement.prototype.toDataURL = window.__realToDataURL), (window.__trayMode = 'ok'), true));
      await draws.start();
      mark = t.trayImages.length;
      await t.ui.clickRefresh();
      await t.idle();
      await t.expect(async () => (await draws.list()).map((x) => x.busy), [true, false], 'a busy frame and a normal one');
      t.ok(t.trayImages.slice(mark).some((x) => isPicture(x) && x.hash !== alice.hash), 'the busy picture was painted');
      await t.expect(() => t.trayImage().hash, alice.hash, 'and the normal one');

      t.log('saved', saved.join(', '));
    } finally {
      try {
        prefs.getUserDefault = realDefault;
      } catch {}
    }
  },
};
