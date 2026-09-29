'use strict';
// Where the window opens: src/main/placement.js, the pure part of
// window.js's position(). The popover hangs from the tray icon; the desktop
// widget returns to where the user left it, unless that is on no display any
// more. Rectangles are in DIP, as Electron's screen and tray report them.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
  MAX_COORD,
  popoverAnchor,
  fitHeight,
  placePopover,
  widgetPosition,
  isPositionOnScreen,
  workAreaFor,
  getCenteredPosition,
  placeWidget,
} = require('../src/main/placement');

// A 1512×982 MacBook display with a 25 pt menu bar, and a tray icon in it.
const MAC_WA = { x: 0, y: 25, width: 1512, height: 957 };
const macTray = (x) => ({ x, y: 0, width: 28, height: 24 });

test('the popover is 360 wide and between 160 and 640 tall', () => {
  assert.equal(WIDTH, 360);
  assert.equal(MIN_HEIGHT, 160);
  assert.equal(MAX_HEIGHT, 640);
});

test('anchor: the middle of the tray icon, or the cursor when the tray rect is empty', () => {
  assert.deepEqual(popoverAnchor(macTray(1200), null), { x: 1214, y: 0, h: 24 });
  assert.deepEqual(popoverAnchor(macTray(1200), { x: 5, y: 5 }), { x: 1214, y: 0, h: 24 }, 'the cursor is ignored');
  assert.deepEqual(popoverAnchor({ x: 0, y: 0, width: 0, height: 0 }, { x: 800, y: 12 }), { x: 800, y: 12, h: 0 });
});

test('tray at the top (macOS): centred under the icon, 4 below it', () => {
  assert.deepEqual(placePopover(macTray(1200), null, MAC_WA, WIDTH, 517), { x: 1034, y: 28, width: 360, height: 517 });
});

test('tray at the bottom (Windows taskbar): above the icon, 4 above it', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const tb = { x: 1700, y: 1040, width: 24, height: 40 };
  assert.deepEqual(placePopover(tb, null, wa, WIDTH, 400), { x: 1532, y: 636, width: 360, height: 400 });
});

test('kept 8 inside the left and right edges of the work area', () => {
  assert.equal(placePopover(macTray(1490), null, MAC_WA, WIDTH, 300).x, 1512 - 360 - 8, 'right edge');
  assert.equal(placePopover(macTray(10), null, MAC_WA, WIDTH, 300).x, 8, 'left edge');
});

test('on a display left of the main one (negative origin), clamped to that display', () => {
  const wa = { x: -1920, y: 25, width: 1920, height: 1055 };
  const r = placePopover({ x: -100, y: 0, width: 24, height: 24 }, null, wa, WIDTH, 300);
  assert.deepEqual(r, { x: -1920 + 1920 - 360 - 8, y: 28, width: 360, height: 300 });
});

test('the height: the renderer\'s natural height, within 160…640 and the work area less 8', () => {
  const at = (wanted, wa = MAC_WA) => placePopover(macTray(700), null, wa, WIDTH, wanted).height;
  assert.equal(at(517), 517);
  assert.equal(at(900), 640, 'capped at 640; the list scrolls beyond');
  assert.equal(at(50), 160, 'never below 160');
  assert.equal(at(900, { x: 0, y: 25, width: 1280, height: 500 }), 492, 'a short display: its height less 8');
});

test('never above the work area, never past its bottom', () => {
  // A popover taller than the room under the icon slides up to end at the bottom.
  const short = { x: 0, y: 0, width: 1280, height: 300 };
  const r = placePopover({ x: 700, y: 0, width: 40, height: 40 }, null, short, WIDTH, 400);
  assert.equal(r.height, 292);
  assert.equal(r.y, 300 - 292);
  assert.ok(r.y >= short.y && r.y + r.height <= short.y + short.height);
  // Smaller than MIN_HEIGHT: the top edge wins.
  const tiny = { x: 0, y: 25, width: 1280, height: 120 };
  assert.equal(placePopover(macTray(700), null, tiny, WIDTH, 400).y, 25);
});

test('empty tray rect (some Linux trays): hangs from the cursor', () => {
  const empty = { x: 0, y: 0, width: 0, height: 0 };
  const top = { x: 0, y: 27, width: 1920, height: 1053 };
  // Panel at the top: below the cursor, but not over the panel.
  assert.deepEqual(placePopover(empty, { x: 800, y: 12 }, top, WIDTH, 300), { x: 620, y: 27, width: 360, height: 300 });
  assert.deepEqual(placePopover(empty, { x: 800, y: 40 }, top, WIDTH, 300), { x: 620, y: 44, width: 360, height: 300 });
  // Panel at the bottom: above the cursor.
  const bottom = { x: 0, y: 0, width: 1920, height: 1050 };
  assert.deepEqual(placePopover(empty, { x: 800, y: 1070 }, bottom, WIDTH, 300), { x: 620, y: 750, width: 360, height: 300 });
});

test('whole-pixel coordinates for fractional tray rects', () => {
  const r = placePopover({ x: 1200.5, y: 0, width: 27, height: 24 }, null, MAC_WA, WIDTH, 300);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), JSON.stringify(r));
  assert.equal(r.x, Math.round(1200.5 + 13.5 - 180));
});

test('defaults: 360 wide, the minimum height', () => {
  assert.deepEqual(placePopover(macTray(1200), null, MAC_WA), { x: 1034, y: 28, width: 360, height: 160 });
});

// ── desktop widget ───────────────────────────────────────────────────────────

// The same MacBook, plus a 2560×1440 display to its right (arranged top-aligned).
const EXT_WA = { x: 1512, y: 0, width: 2560, height: 1415 };
const TWO = [MAC_WA, EXT_WA];

test('fitHeight: the popover\'s rule, shared by the widget', () => {
  assert.equal(fitHeight(517, MAC_WA), 517);
  assert.equal(fitHeight(900, MAC_WA), 640);
  assert.equal(fitHeight(50, MAC_WA), 160);
  assert.equal(fitHeight(900, { x: 0, y: 0, width: 800, height: 400 }), 392);
});

test('widgetPosition: whole numbers within ±100000 from {x, y} or getPosition()\'s [x, y], else null', () => {
  assert.equal(MAX_COORD, 100_000);
  assert.deepEqual(widgetPosition({ x: 20, y: -1400 }), { x: 20, y: -1400 });
  assert.deepEqual(widgetPosition([1600, 40]), { x: 1600, y: 40 });
  assert.deepEqual(widgetPosition({ x: 100_000, y: -100_000 }), { x: 100_000, y: -100_000 });
  const extra = { x: 1, y: 2, width: 360, evil: true };
  assert.deepEqual(widgetPosition(extra), { x: 1, y: 2 }, 'a fresh object, extra fields dropped');
  for (const bad of [null, undefined, {}, [], [1], { x: 1 }, { x: 1.5, y: 2 }, { x: '10', y: 20 }, { x: NaN, y: 0 },
    { x: Infinity, y: 0 }, { x: 100_001, y: 0 }, { x: 0, y: -100_001 }, 'x', 42, [1, 2.5]]) {
    assert.equal(widgetPosition(bad), null, JSON.stringify(bad));
  }
});

test('isPositionOnScreen: any overlap with any work area counts, touching does not', () => {
  const r = (x, y) => ({ x, y, width: WIDTH, height: 400 });
  assert.equal(isPositionOnScreen(r(600, 200), [MAC_WA]), true, 'inside');
  assert.equal(isPositionOnScreen(r(1400, 200), [MAC_WA]), true, 'partly off the right edge');
  assert.equal(isPositionOnScreen(r(1511, 200), [MAC_WA]), true, 'one DIP column on screen');
  assert.equal(isPositionOnScreen(r(1512, 200), [MAC_WA]), false, 'touching the right edge only');
  assert.equal(isPositionOnScreen(r(600, -375), [MAC_WA]), false, 'ends at the top of the work area (the menu bar)');
  assert.equal(isPositionOnScreen(r(2000, 300), [MAC_WA]), false, 'on a display that is gone');
  assert.equal(isPositionOnScreen(r(2000, 300), TWO), true, 'on the external display');
  assert.equal(isPositionOnScreen(r(-2000, 300), [{ x: -1920, y: 0, width: 1920, height: 1080 }]), true, 'a display left of the main one');
  assert.equal(isPositionOnScreen(r(0, 0), []), false, 'no displays');
});

test('workAreaFor: the display the rect overlaps most', () => {
  assert.equal(workAreaFor({ x: 1400, y: 100, width: WIDTH, height: 400 }, TWO), EXT_WA, '112 on the Mac, 248 on the external');
  assert.equal(workAreaFor({ x: 1300, y: 100, width: WIDTH, height: 400 }, TWO), MAC_WA, '212 on the Mac, 148 on the external');
  assert.equal(workAreaFor({ x: 5000, y: 100, width: WIDTH, height: 400 }, TWO), null);
});

test('getCenteredPosition: centred in the given work area, whole pixels', () => {
  assert.deepEqual(getCenteredPosition(MAC_WA, WIDTH, 517), { x: 576, y: 245 });
  assert.deepEqual(getCenteredPosition(EXT_WA, WIDTH, 401), { x: 1512 + 1100, y: 507 });
  const odd = getCenteredPosition({ x: 0, y: 25, width: 1511, height: 956 }, WIDTH, 401);
  assert.ok(Number.isInteger(odd.x) && Number.isInteger(odd.y), JSON.stringify(odd));
});

test('widget: a saved position on a display that is still there is kept', () => {
  assert.deepEqual(placeWidget({ x: 200, y: 300 }, [MAC_WA], MAC_WA, WIDTH, 517), { x: 200, y: 300, width: 360, height: 517, centred: false });
  assert.deepEqual(placeWidget({ x: 3000, y: 60 }, TWO, MAC_WA, WIDTH, 517), { x: 3000, y: 60, width: 360, height: 517, centred: false }, 'on the external display, not moved to the tray\'s');
});

test('widget: a saved position off every display (e.g. the external one was unplugged) is centred on the tray\'s display', () => {
  assert.deepEqual(placeWidget({ x: 3000, y: 60 }, [MAC_WA], MAC_WA, WIDTH, 517), { x: 576, y: 245, width: 360, height: 517, centred: true });
  assert.deepEqual(placeWidget({ x: -5000, y: -5000 }, TWO, EXT_WA, WIDTH, 401), { x: 2612, y: 507, width: 360, height: 401, centred: true }, 'the tray may be on the other display');
});

test('widget: one partly on screen is kept where it is', () => {
  // 112 of 360 DIP on the right edge of the Mac, nothing to its right any more.
  assert.deepEqual(placeWidget({ x: 1400, y: 300 }, [MAC_WA], MAC_WA, WIDTH, 400), { x: 1400, y: 300, width: 360, height: 400, centred: false });
  assert.deepEqual(placeWidget({ x: -300, y: 300 }, [MAC_WA], MAC_WA, WIDTH, 400).x, -300, 'partly off the left edge');
});

test('widget: never saved (null) or garbage → centred', () => {
  for (const anchor of [null, undefined, { x: 1.5, y: 2 }, { x: 'a', y: 0 }, { x: 200_000, y: 0 }]) {
    assert.deepEqual(placeWidget(anchor, [MAC_WA], MAC_WA, WIDTH, 517), { x: 576, y: 245, width: 360, height: 517, centred: true }, JSON.stringify(anchor));
  }
});

test('widget: grows down from its corner, moves up only as far as the bottom edge needs', () => {
  assert.equal(placeWidget({ x: 200, y: 300 }, [MAC_WA], MAC_WA, WIDTH, 640).y, 300, 'fits: the corner stays');
  const low = placeWidget({ x: 200, y: 700 }, [MAC_WA], MAC_WA, WIDTH, 517);
  assert.deepEqual(low, { x: 200, y: 25 + 957 - 517, width: 360, height: 517, centred: false }, 'bottom edge on the work area\'s');
  const small = placeWidget({ x: 200, y: 700 }, [MAC_WA], MAC_WA, WIDTH, 200);
  assert.equal(small.y, 700, 'a shorter page: back at the user\'s corner');
});

test('widget: its top (where it is dragged) never sits above the work area', () => {
  // Overlaps the Mac only by its lower half: kept, but pulled below the menu bar.
  const r = placeWidget({ x: 200, y: -200 }, [MAC_WA], MAC_WA, WIDTH, 517);
  assert.deepEqual(r, { x: 200, y: 25, width: 360, height: 517, centred: false });
});

test('widget: height fitted to the display it is on', () => {
  const short = { x: 1512, y: 0, width: 1024, height: 500 };
  const r = placeWidget({ x: 1600, y: 100 }, [MAC_WA, short], MAC_WA, WIDTH, 900);
  assert.deepEqual(r, { x: 1600, y: 500 - 492, width: 360, height: 492, centred: false }, 'its height less 8, then the top edge moves up to fit');
  assert.equal(placeWidget({ x: 200, y: 100 }, [MAC_WA], MAC_WA, WIDTH, 50).height, 160, 'never below 160');
});

test('widget: straddling two displays, it is fitted to the one it overlaps most', () => {
  const lowExt = { x: 1512, y: 300, width: 1920, height: 1080 };
  // 112 DIP on the Mac, 248 on the external one, whose work area starts at y 300.
  const r = placeWidget({ x: 1400, y: 100 }, [MAC_WA, lowExt], MAC_WA, WIDTH, 400);
  assert.deepEqual(r, { x: 1400, y: 300, width: 360, height: 400, centred: false });
});

test('widget: no display information at all → the anchor as is (or 0,0), nothing to fit to', () => {
  assert.deepEqual(placeWidget({ x: 10, y: 20 }, [], null, WIDTH, 300), { x: 10, y: 20, width: 360, height: 300, centred: false });
  assert.deepEqual(placeWidget(null, [], null, WIDTH, 900), { x: 0, y: 0, width: 360, height: 640, centred: true });
});

test('widget: whole pixels and defaults', () => {
  const r = placeWidget(null, [{ x: 0, y: 25, width: 1511, height: 956 }], { x: 0, y: 25, width: 1511, height: 956 });
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), JSON.stringify(r));
  assert.equal(r.width, WIDTH);
  assert.equal(r.height, MIN_HEIGHT);
});
