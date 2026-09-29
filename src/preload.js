'use strict';
// The renderer's only door to the app. It runs sandboxed with context
// isolation, so it gets these few calls and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getState: () => ipcRenderer.invoke('accounts:get'),
  refresh: () => ipcRenderer.invoke('accounts:refresh'),
  // target: { email, organizationUuid } of a listed account, or
  // { strategy: 'rotate' | 'best' | 'next-available' }
  switchTo: (target) => ipcRenderer.invoke('accounts:switch', target),
  setDisabled: (target, disabled) => ipcRenderer.invoke('accounts:set-disabled', target, disabled),
  recheck: () => ipcRenderer.invoke('app:recheck'),
  chooseBinary: () => ipcRenderer.invoke('app:choose-binary'),
  usePath: () => ipcRenderer.invoke('app:use-path'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openDocs: () => ipcRenderer.send('app:open-docs'),
  showMenu: () => ipcRenderer.send('app:menu'),
  resize: (height) => ipcRenderer.send('ui:resize', height),
  onToast: (cb) => {
    const listener = (_e, t) => cb(t);
    ipcRenderer.on('ui:toast', listener);
    return () => ipcRenderer.removeListener('ui:toast', listener);
  },
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('accounts:state', listener);
    return () => ipcRenderer.removeListener('accounts:state', listener);
  },
});
