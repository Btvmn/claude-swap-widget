'use strict';
// Settings between main and the page (PLAN §6.1, §7), how a saved change is
// applied, and the UI language.
//
//   settings:get          → publicSettings(): what the page may see (no cswapPath,
//                           no widgetPosition), with main's resolved language
//   settings:set(patch)   → the page may write only RENDERER_KEYS; anything else
//                           rejects the whole patch with { ok: false }
//   settings:changed      ← pushed to the page when what it can see changed
//
// applySettings(prev, next) runs after every save (main.js saveAndApply): the
// theme and refresh-timer side effects, the language, then one ctx.bus event
// per changed key, 'language' when the resolved language changed, and
// 'settings'. Other modules react to those events; nothing here knows them.
//
// Language: an explicit choice wins; 'system' takes the first of en/ru/uk/de
// in the Mac's preferred languages, else English. Main decides and tells the
// page, so the menu bar, the menus and the popover always agree. CSW_LANG
// (ctx.dev.lang) stands in for the Mac's languages and wins over a saved
// choice until the language is changed from the menu.

const { ipcMain, nativeTheme } = require('electron');
const { isDeepStrictEqual } = require('util');
const I18n = require('../shared/i18n');
const { rendererPatch, publicSettings } = require('../settings');

let ctx = null;
let envOverride = false; // CSW_LANG given and the language not changed since start
let ui = { language: 'en', locale: I18n.LOCALES.en, hour12: true };
let translate = I18n.translator('en');

// The Mac's preferred languages, best first ("en-US", "de-CH", …). With
// CSW_LANG only that language, in its default locale, so captures and e2e
// runs read the same on every Mac. Works before `ready` (dlg.cannotStart).
function languageTags(app, envLang) {
  if (I18n.CODES.includes(envLang)) return [I18n.LOCALES[envLang]];
  let tags = [];
  try {
    tags = app.getPreferredSystemLanguages();
  } catch {}
  if (!Array.isArray(tags) || !tags.length) {
    try {
      tags = [app.getLocale()]; // '' before ready
    } catch {}
  }
  return tags.filter((tag) => typeof tag === 'string' && tag);
}

// { language, locale, hour12 } for a settings object and the system tags. Pure.
function resolveUi(settings, tags) {
  const language = I18n.resolveLanguage(settings.language, tags);
  const locale = I18n.resolveLocale(language, tags);
  return { language, locale, hour12: I18n.hour12For(locale, settings.timeFormat) };
}

function resolve(settings) {
  const tags = languageTags(ctx.app, ctx.dev.lang);
  ui = resolveUi(envOverride ? { ...settings, language: 'system' } : settings, tags);
  translate = I18n.translator(ui.language);
}

// Strings in the current UI language (ctx.t). Call it each time; never keep
// what it returns across a language change.
function t(key, vars) {
  return translate(key, vars);
}

function current() {
  return { ...ui };
}

// CSW_WINDOW (dev only) forces the window mode without saving it; the page
// must lay itself out for what the window really is.
function publicView(settings = ctx.getSettings(), resolved = ui) {
  const view = publicSettings(settings, resolved);
  const forced = ctx.forcedWindowMode && ctx.forcedWindowMode();
  return forced ? { ...view, windowMode: forced } : view;
}

function attach(context) {
  ctx = context;
  envOverride = I18n.CODES.includes(ctx.dev.lang);
  resolve(ctx.getSettings());

  ipcMain.handle('settings:get', (e) => (ctx.fromUi(e) ? publicView() : null));
  // All or nothing: a patch with any key outside RENDERER_KEYS, or any bad
  // value, changes nothing. cswapPath decides which binary runs, so it is
  // only ever set from main's own file panel or "Use cswap from PATH".
  ipcMain.handle('settings:set', (e, patch) => {
    if (!ctx.fromUi(e)) return null;
    const clean = rendererPatch(patch);
    if (!clean) return { ok: false };
    ctx.saveAndApply(clean);
    return publicView();
  });
}

// After a save: side effects, then the bus, then the tray and the page.
// Returns the keys that changed.
function applySettings(prev, next) {
  const changed = Object.keys(next).filter((k) => !isDeepStrictEqual(prev[k], next[k]));
  if (!changed.length) return changed;
  const has = (k) => changed.includes(k);

  if (has('theme')) nativeTheme.themeSource = next.theme;
  if (has('refreshSeconds')) ctx.restartTimer();
  const prevUi = ui;
  if (has('language')) envOverride = false;
  if (has('language') || has('timeFormat')) resolve(next);

  for (const k of changed) ctx.bus.emit(`setting:${k}`, next[k], prev[k]);
  if (!isDeepStrictEqual(prevUi, ui)) ctx.bus.emit('language', current(), prevUi);
  ctx.bus.emit('settings', next, prev);

  ctx.updateTray(ctx.service.state);
  const view = publicView(next, ui);
  if (!isDeepStrictEqual(view, publicView(prev, prevUi))) ctx.send('settings:changed', view);
  return changed;
}

module.exports = { attach, applySettings, t, current, publicView, languageTags, resolveUi };
