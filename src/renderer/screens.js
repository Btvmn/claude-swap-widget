'use strict';
// Setup and status screens in #screen[data-phase] (window.Screens): loading,
// missing (install / configured path gone), too-old, no-accounts and error.
// The logic is the old popover's; the look is css/screens.css.

(function () {
  const { h, icon } = window.Dom;
  const t = (key, vars) => window.I18nDom.t(key, vars);

  // Keep in step with MIN_VERSION in src/cswap.js.
  const MIN_VERSION = '0.20.0';
  const SEARCHED = 'PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin';

  function cmd(text, api) {
    const button = h('button', { type: 'button' }, t('act.copy'));
    button.addEventListener('click', async () => {
      await api.copy(text);
      button.textContent = t('act.copied');
      setTimeout(() => (button.textContent = t('act.copy')), 1200);
    });
    return h('div', { class: 'cmd' }, h('code', null, text), button);
  }

  function actions(s, api) {
    const configured = Boolean(s.cswap && s.cswap.configured);
    const btn = (cls, key, fn) => h('button', { class: cls, type: 'button', onclick: fn }, t(key));
    return h(
      'div',
      { class: 'actions' },
      btn('secondary', 'act.checkAgain', () => api.recheck()),
      configured ? btn('secondary', 'act.usePath', () => api.usePath()) : null,
      btn('secondary', 'act.chooseBinary', () => api.chooseBinary()),
      configured ? null : btn('link', 'act.installGuide', () => api.openDocs()),
    );
  }

  function loading() {
    return [h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, t('loading.cswap'))];
  }

  function missing(s, api) {
    if (s.cswap && s.cswap.configured) {
      return [
        icon('alert'),
        h('h2', null, t('setup.badPath.title')),
        h('p', null, t('setup.badPath.body', { button: t('act.chooseBinary') })),
        h('p', { class: 'path' }, s.cswap.path || ''),
        actions(s, api),
      ];
    }
    return [
      icon('download'),
      h('h2', null, t('setup.missing.title')),
      h('p', null, t('setup.missing.body')),
      cmd('uv tool install claude-swap', api),
      cmd('pipx install claude-swap', api),
      h('p', { class: 'path' }, s.cswap && s.cswap.path ? t('setup.missing.tried', { path: s.cswap.path }) : t('setup.missing.searched', { dirs: SEARCHED })),
      actions(s, api),
    ];
  }

  function tooOld(s, api) {
    const v = s.cswap && s.cswap.version;
    return [
      icon('upgrade'),
      h('h2', null, t('setup.tooOld.title')),
      h('p', null, v ? t('setup.tooOld.body', { version: v, min: MIN_VERSION }) : t('setup.tooOld.bodyUnknown')),
      cmd('uv tool upgrade claude-swap', api),
      cmd('pipx upgrade claude-swap', api),
      h('p', { class: 'path' }, (s.cswap && s.cswap.path) || ''),
      actions(s, api),
    ];
  }

  function noAccounts(s, api) {
    return [
      icon('userPlus'),
      h('h2', null, t('setup.noAccounts.title')),
      h('p', null, t('setup.noAccounts.body')),
      cmd('cswap add', api),
      h('div', { class: 'actions' }, h('button', { class: 'secondary', type: 'button', onclick: () => api.recheck() }, t('act.checkAgain'))),
    ];
  }

  function error(s, api) {
    return [
      icon('alert'),
      h('h2', null, t('setup.error.title')),
      h('p', { class: 'message' }, (s.error && s.error.message) || t('setup.error.unknown')),
      h('p', { class: 'path' }, (s.cswap && s.cswap.path) || ''),
      actions(s, api),
    ];
  }

  const BUILDERS = { loading, missing, 'too-old': tooOld, 'no-accounts': noAccounts, error };

  // Draws the screen for a non-ok phase into el. Returns false for phase 'ok'.
  function render(el, s, api) {
    const build = BUILDERS[s.phase];
    if (!build) return false;
    el.dataset.phase = s.phase;
    el.replaceChildren(...build(s, api));
    return true;
  }

  window.Screens = { render, MIN_VERSION };
})();
