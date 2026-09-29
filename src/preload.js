'use strict';
// The renderer's only door to the app (PLAN §7). It runs sandboxed with
// context isolation, so the page gets these calls and nothing else: no
// ipcRenderer, no event objects, no channel names of its own choosing. Main
// checks the sender and validates every payload; test/preload.test.js pins
// the exact list of names and channels.

const { contextBridge, ipcRenderer } = require('electron');

// main → page. The callback gets the payload only (never the IPC event, which
// would hand the page ipcRenderer); the return value unsubscribes.
function subscribe(channel) {
  return (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  // → { platform, capture, version, captureView? }
  info: () => ipcRenderer.invoke('app:info'),

  // Accounts. The state is the service's (src/service.js).
  getState: () => ipcRenderer.invoke('accounts:get'),
  refresh: () => ipcRenderer.invoke('accounts:refresh'),
  // target: { email, organizationUuid } of a listed account, or
  // { strategy: 'rotate' | 'best' | 'next-available' }
  switchTo: (target) => ipcRenderer.invoke('accounts:switch', target),
  setDisabled: (target, disabled) => ipcRenderer.invoke('accounts:set-disabled', target, disabled),
  // The native per-account menu for { email, organizationUuid }.
  showAccountMenu: (target) => ipcRenderer.send('accounts:menu', target),
  onState: subscribe('accounts:state'),

  // Setup screens and the popover's chrome.
  recheck: () => ipcRenderer.invoke('app:recheck'),
  chooseBinary: () => ipcRenderer.invoke('app:choose-binary'),
  usePath: () => ipcRenderer.invoke('app:use-path'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openDocs: () => ipcRenderer.send('app:open-docs'),
  showMenu: () => ipcRenderer.send('app:menu'),
  resize: (height) => ipcRenderer.send('ui:resize', height),
  // The header's pin button: 'widget' keeps the window on the desktop,
  // 'popover' returns it under the menu-bar icon.
  setWindowMode: (mode) => ipcRenderer.send('ui:set-window-mode', mode),
  onToast: subscribe('ui:toast'),
  // { view: 'stats' | 'accounts', email?, organizationUuid? }
  onOpen: subscribe('ui:open'),

  // Settings the page may see; it may write only the view keys
  // (statsStyle, statsPeriod, statsAccount, heroExpanded).
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: subscribe('settings:changed'),

  // Usage history for the statistics: key = 12 hex chars, days = 1…31.
  history: {
    accounts: () => ipcRenderer.invoke('history:accounts'),
    get: (key, days) => ipcRenderer.invoke('history:get', key, days),
  },

  // The menu-bar picture: main asks for a frame, the page paints it on a
  // canvas and answers with a PNG data URL for the same seq.
  onTrayDraw: subscribe('tray:draw'),
  sendTrayImage: (seq, dataUrl, template) => ipcRenderer.send('tray:image', seq, dataUrl, template),
});
