'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('companionDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('companion:status'),
  ask: (payload) => ipcRenderer.invoke('companion:ask', payload),
  transcribe: (payload) => ipcRenderer.invoke('companion:transcribe', payload),
  cancel: (id) => ipcRenderer.send('companion:cancel', id),
  publishContext: (context) => ipcRenderer.send('companion:publish-context', context),
  onContext: (callback) => {
    const unsubscribe = subscribe('companion:context', callback);
    ipcRenderer.send('companion:request-context');
    return unsubscribe;
  },
  setExpanded: (expanded) => ipcRenderer.send('companion:expanded', expanded),
  openReader: () => ipcRenderer.send('companion:open-reader'),
  openGroup: () => ipcRenderer.send('companion:open-group'),
  openSharedRoom: () => ipcRenderer.invoke('companion:open-shared-room'),
  minimize: () => ipcRenderer.send('companion:minimize'),
  onToggleMic: (callback) => subscribe('companion:toggle-mic', callback),
  onStop: (callback) => subscribe('companion:stop', callback),
}));
