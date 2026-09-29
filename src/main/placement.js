'use strict';
// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, main.js:248-273, 312-317).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// Where the window goes, as pure functions of the tray, the cursor and the
// displays' work areas, so they can be tested without Electron. window.js
// looks the rectangles up and applies the result.
//   popover: hangs from the tray icon (ours);
//   widget:  at the position the user dragged it to, if that still overlaps a
//            display, else centred (Maestro's isPositionOnScreen and
//            getCenteredPosition, given the work areas instead of reading
//            Electron's screen).

// The window's size in DIP. The width is fixed; the height is the renderer's
// natural height within these bounds, and beyond that the list scrolls.
const WIDTH = 360;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 640;

const EDGE = 8; // kept free at the left and right edges of the work area, and off its height
const GAP = 4; // between the tray icon and the popover
// A saved widget position beyond this is garbage, not a display (the same
// bound settings.js applies to widgetPosition).
const MAX_COORD = 100_000;

// The point the popover hangs from: the middle of the tray icon, plus the
// icon's height. Some Linux trays report an empty rect: then the cursor
// (which just clicked the icon) is the anchor.
function popoverAnchor(trayBounds, cursor) {
  const tb = trayBounds || {};
  if (tb.width) return { x: tb.x + tb.width / 2, y: tb.y, h: tb.height };
  const c = cursor || { x: 0, y: 0 };
  return { x: c.x, y: c.y, h: 0 };
}

// The renderer's natural height within min…max, and no taller than the work
// area less EDGE.
function fitHeight(wantedHeight, workArea, { minHeight = MIN_HEIGHT, maxHeight = MAX_HEIGHT } = {}) {
  return Math.max(minHeight, Math.min(wantedHeight, maxHeight, workArea.height - EDGE));
}

// Under the tray icon on macOS; above it when the tray sits in the lower half
// of the display (Windows). The height is clamped to the work area of the
// display the popover opens on, then the rect is kept inside that work area.
// `cursor` is only read when the tray rect is empty.
function placePopover(trayBounds, cursor, workArea, width = WIDTH, wantedHeight = MIN_HEIGHT, { minHeight = MIN_HEIGHT, maxHeight = MAX_HEIGHT } = {}) {
  const anchor = popoverAnchor(trayBounds, cursor);
  const wa = workArea;
  const height = fitHeight(wantedHeight, wa, { minHeight, maxHeight });
  const below = anchor.y < wa.y + wa.height / 2;
  let x = Math.round(anchor.x - width / 2);
  let y = below ? Math.round(anchor.y + anchor.h + GAP) : Math.round(anchor.y - height - GAP);
  x = Math.max(wa.x + EDGE, Math.min(x, wa.x + wa.width - width - EDGE));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  return { x, y, width, height };
}

// ── Desktop widget ───────────────────────────────────────────────────────────

// A position worth saving or restoring: whole numbers within ±MAX_COORD, from
// { x, y } or from win.getPosition()'s [x, y]. Anything else is null.
function widgetPosition(pos) {
  const [x, y] = Array.isArray(pos) ? pos : pos && typeof pos === 'object' ? [pos.x, pos.y] : [];
  const ok = (v) => Number.isInteger(v) && Math.abs(v) <= MAX_COORD;
  return ok(x) && ok(y) ? { x, y } : null;
}

// Overlap of two rects in square DIP (0 when they only touch).
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// True when the rect overlaps at least one work area. Recovers from a saved
// position left over from another monitor setup (Maestro, main.js:248-263).
function isPositionOnScreen(rect, workAreas) {
  return (workAreas || []).some((area) => overlap(rect, area) > 0);
}

// The work area the rect overlaps most, or null when it overlaps none.
function workAreaFor(rect, workAreas) {
  let best = null;
  let bestArea = 0;
  for (const area of workAreas || []) {
    const a = overlap(rect, area);
    if (a > bestArea) {
      best = area;
      bestArea = a;
    }
  }
  return best;
}

// Centred in the work area (Maestro, main.js:265-273, which always used the
// primary display; the caller passes the tray's display here).
function getCenteredPosition(workArea, width, height) {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

// The widget's rect. `anchor` is where the user left its top-left corner
// (null: never moved). Kept when the rect overlaps any work area, even partly;
// otherwise centred on `homeArea` (the tray's display). The height is fitted
// like the popover's, and the top edge is then kept inside that display
// vertically, so a taller page grows downwards from the corner and moves up
// only as far as the bottom edge needs, and the top (where the widget is
// dragged) never sits above the work area. `centred` tells the caller the
// anchor was not used.
function placeWidget(anchor, workAreas, homeArea, width = WIDTH, wantedHeight = MIN_HEIGHT, { minHeight = MIN_HEIGHT, maxHeight = MAX_HEIGHT } = {}) {
  const areas = workAreas || [];
  const pos = widgetPosition(anchor);
  const probe = pos && { x: pos.x, y: pos.y, width, height: Math.max(minHeight, Math.min(wantedHeight, maxHeight)) };
  const onScreen = Boolean(probe && isPositionOnScreen(probe, areas));
  const area = (onScreen ? workAreaFor(probe, areas) : homeArea || areas[0]) || null;
  if (!area) {
    // No display at all: nothing to fit to.
    const height = Math.max(minHeight, Math.min(wantedHeight, maxHeight));
    return { x: pos ? pos.x : 0, y: pos ? pos.y : 0, width, height, centred: !pos };
  }
  const height = fitHeight(wantedHeight, area, { minHeight, maxHeight });
  let { x, y } = onScreen ? pos : getCenteredPosition(area, width, height);
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  return { x, y, width, height, centred: !onScreen };
}

module.exports = {
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
};
