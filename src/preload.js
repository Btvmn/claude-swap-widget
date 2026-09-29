'use strict';
// The renderer's only door to the app. It runs sandboxed with context
// isolation, so it gets these few calls and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getState: () => ipcRenderer.invoke('accounts:get'),
  refresh: () => ipcRenderer.invoke('accounts:refresh'),
  // target: account number, or { strategy: 'best' | 'next-available' }
  switchTo: (target) => ipcRenderer.invoke('accounts:switch', target),
  recheck: () => ipcRenderer.invoke('app:recheck'),
  chooseBinary: () => ipcRenderer.invoke('app:choose-binary'),
  usePath: () => ipcRenderer.invoke('app:use-path'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openDocs: () => ipcRenderer.send('app:open-docs'),
  showMenu: () => ipcRenderer.send('app:menu'),
  resize: (height) => ipcRenderer.send('ui:resize', height),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('accounts:state', listener);
    return () => ipcRenderer.removeListener('accounts:state', listener);
  },
});
