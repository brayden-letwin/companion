'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const portArgument = process.argv.find(value => value.startsWith('--companion-shell-port='));
const port = Number(portArgument?.split('=')[1]);
const mode = process.argv.includes('--companion-shell-mode=corner') ? 'corner' : 'workspace';
const query = new URLSearchParams(window.location.search);
if (process.isMainFrame && Number.isInteger(port) && port >= 1024 && port <= 65535 && window.location.origin === `http://127.0.0.1:${port}`
  && window.location.pathname === '/assistant.html' && query.get('mode') === mode && [...query.keys()].length === 1) {
  function subscribe(channel, callback, requestState = false) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    if (requestState) ipcRenderer.send('companion-shell:request-mode');
    return () => ipcRenderer.removeListener(channel, listener);
  }
  contextBridge.exposeInMainWorld('companionShell', Object.freeze({
    desktop: true,
    mode,
    openWorkspace: () => ipcRenderer.send('companion-shell:open-workspace'),
    setExpanded: value => {
      if (typeof value !== 'boolean') throw new TypeError('Expanded must be true or false.');
      ipcRenderer.send('companion-shell:expanded', value);
    },
    hide: () => ipcRenderer.send('companion-shell:hide'),
    restart: () => ipcRenderer.send('companion-shell:restart'),
    onStop: callback => subscribe('companion-shell:stop', callback),
    onModeChanged: callback => subscribe('companion-shell:mode', callback, true),
  }));
}
