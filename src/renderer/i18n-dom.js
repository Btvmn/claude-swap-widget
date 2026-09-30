// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/i18n.js:569-592,
// src/renderer/app.js:714-730).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
'use strict';

// The page's language (window.I18nDom). Main decides the language, locale and
// 12/24 h clock and pushes them with the settings; the page only applies them.
// Markup declares its text by key: data-i18n (text), data-i18n-title
// (tooltip + aria-label), data-i18n-tip (tooltip only).

(function () {
  const I18n = window.I18n;
  let lang = 'en';
  let locale = 'en-US';
  let hour12 = true;
  let translate = I18n.translator('en');
  let applied = false;

  function t(key, vars) {
    return translate(key, vars);
  }

  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      const text = t(el.dataset.i18nTitle);
      el.title = text;
      el.setAttribute('aria-label', text);
    }
    for (const el of root.querySelectorAll('[data-i18n-tip]')) el.title = t(el.dataset.i18nTip);
  }

  // settings: { language, locale, hour12 } from settings:get / settings:changed.
  // Returns true when anything changed, so callers can rebuild what they drew.
  function set(settings) {
    const next = {
      lang: I18n.CODES.includes(settings && settings.language) ? settings.language : 'en',
      locale: (settings && settings.locale) || I18n.LOCALES[(settings && settings.language) || 'en'] || 'en-US',
      hour12: settings && typeof settings.hour12 === 'boolean' ? settings.hour12 : true,
    };
    // The first call always applies: the markup's own English has no
    // tooltips or accessible names until apply() has run once.
    if (applied && next.lang === lang && next.locale === locale && next.hour12 === hour12) return false;
    applied = true;
    lang = next.lang;
    locale = next.locale;
    hour12 = next.hour12;
    translate = I18n.translator(lang);
    document.documentElement.lang = lang;
    document.title = t('app.title');
    apply();
    return true;
  }

  // Puts a translated phrase into el with some parts as styled spans, without
  // parsing any HTML: parts = { name: [text, className] }.
  function fillPhrase(el, key, parts) {
    const names = Object.keys(parts);
    const marked = t(key, Object.fromEntries(names.map((name, i) => [name, `\u0001${i}\u0002`])));
    el.replaceChildren();
    for (const piece of marked.split(/(\u0001\d+\u0002)/)) {
      const mark = piece.match(/^\u0001(\d+)\u0002$/);
      if (!mark) {
        if (piece) el.appendChild(document.createTextNode(piece));
        continue;
      }
      const [text, className] = parts[names[Number(mark[1])]];
      const span = document.createElement('span');
      if (className) span.className = className;
      span.textContent = text;
      el.appendChild(span);
    }
  }

  window.I18nDom = {
    t,
    apply,
    set,
    fillPhrase,
    lang: () => lang,
    locale: () => locale,
    hour12: () => hour12,
    duration: (seconds) => I18n.formatDuration(t, seconds),
    pct: (p) => t('fmt.pct', { p: Math.round(p) }),
  };
})();
