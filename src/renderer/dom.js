'use strict';
// Small DOM helpers shared by the renderer modules (window.Dom). Everything
// from cswap goes in as text: h() turns every non-Node child into a text node
// and sets attributes with setAttribute (never a style attribute: CSP).

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }

  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      el.setAttribute(k, String(v));
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  // Stroke icons for the setup screens (24×24, drawn with the current colour).
  const ICONS = {
    download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
    upgrade: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16V8', 'M8.5 11.5L12 8l3.5 3.5'],
    userPlus: ['M15 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 3 18.5V20', 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19 8v6', 'M16 11h6'],
    alert: ['M12 3.5L2.5 20h19L12 3.5z', 'M12 10v4.5', 'M12 17.2v.3'],
  };

  function icon(name, cls = 'screen-icon') {
    return svg('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, (ICONS[name] || []).map((d) => svg('path', { d })));
  }

  window.Dom = { h, svg, icon, $: (id) => document.getElementById(id) };
})();
