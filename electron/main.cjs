'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, session, screen, shell } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createProvider, validateContext } = require('./provider.cjs');
const { createLocalProvider } = require('./local-provider.cjs');

const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'index.html');
const groupPath = path.join(root, 'group.html');
const sharedRoomURL = 'http://127.0.0.1:4174/room.html';
const envDirectory = app.isPackaged ? path.dirname(app.getPath('exe')) : root;
try { process.loadEnvFile?.(path.join(envDirectory, '.env')); }
catch (error) { if (error.code !== 'ENOENT') console.warn('Companion could not read .env. Environment variables will still be used.'); }
const providerName = process.env.COMPANION_PROVIDER || 'openai';
if (!['local', 'openai'].includes(providerName)) throw new Error('COMPANION_PROVIDER must be local or openai.');
const provider = providerName === 'local'
  ? createLocalProvider({ model: process.env.COMPANION_LOCAL_MODEL })
  : createProvider({ apiKey: process.env.OPENAI_API_KEY, model: process.env.COMPANION_MODEL });
let readerWindow;
let companionWindow;
let groupWindow;
let latestContext;
let quitting = false;
let shortcutAvailable = false;
let stopShortcutAvailable = false;
const trusted = new Set();

function isAppURL(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && path.normalize(fileURLToPath(parsed)) === indexPath;
  } catch { return false; }
}

function validSender(event) {
  return trusted.has(event.sender.id) && event.senderFrame === event.sender.mainFrame && isAppURL(event.senderFrame.url);
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, payload) => {
    if (!validSender(event)) throw new Error('Untrusted Companion window.');
    return callback(event, payload);
  });
}

function on(channel, callback) {
  ipcMain.on(channel, (event, payload) => {
    if (!validSender(event)) return;
    try { callback(event, payload); }
    catch { /* Untrusted/invalid events never become OS actions. */ }
  });
}

function secureWindow(window) {
  const contents = window.webContents;
  trusted.add(contents.id);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  // Electron emits this before will-navigate. Keep subframes blocked here;
  // main-frame links must reach the deny-all handler and fixed-target routing.
  contents.on('will-frame-navigate', (event) => { if (!event.isMainFrame) event.preventDefault(); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  const ownerId = String(contents.id);
  contents.on('destroyed', () => {
    trusted.delete(Number(ownerId));
    provider.cancelScope(ownerId);
  });
}

function cornerBounds(expanded) {
  const display = companionWindow && !companionWindow.isDestroyed()
    ? screen.getDisplayMatching(companionWindow.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(360, area.width);
  const height = Math.min(expanded ? 520 : 82, area.height);
  return {
    width, height,
    x: Math.max(area.x, area.x + area.width - width - 16),
    y: Math.max(area.y, area.y + area.height - height - 16),
  };
}

function openReader() {
  if (!readerWindow || readerWindow.isDestroyed()) createReader();
  readerWindow.show();
  if (readerWindow.isMinimized()) readerWindow.restore();
  readerWindow.focus();
}

function openGroup() {
  if (!groupWindow || groupWindow.isDestroyed()) {
    // Group contributions are a local design demo. This window receives no
    // preload bridge, model access, microphone access, or desktop actions.
    const { preload: _unusedPreload, ...preferences } = windowPreferences();
    groupWindow = new BrowserWindow({
      title: 'Companion — Group discussion', width: 1280, height: 900,
      minWidth: 820, minHeight: 600, backgroundColor: '#f4f3ee',
      show: false, webPreferences: preferences,
    });
    groupWindow.setMenuBarVisibility(false);
    secureWindow(groupWindow);
    groupWindow.webContents.on('will-navigate', (event, url) => {
      if (isAppURL(url)) { event.preventDefault(); openReader(); }
      if (url === sharedRoomURL) { event.preventDefault(); shell.openExternal(sharedRoomURL).catch(() => console.warn('Could not open the local shared room.')); }
    });
    groupWindow.once('ready-to-show', () => groupWindow.show());
    groupWindow.on('closed', () => { groupWindow = null; });
    groupWindow.loadFile(groupPath);
  }
  groupWindow.show();
  if (groupWindow.isMinimized()) groupWindow.restore();
  groupWindow.focus();
}

function windowPreferences() {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

function createReader() {
  readerWindow = new BrowserWindow({
    title: 'Companion — Math reader', width: 1200, height: 850,
    minWidth: 760, minHeight: 560, backgroundColor: '#f7f8f4',
    show: false, webPreferences: windowPreferences(),
  });
  readerWindow.setMenuBarVisibility(false);
  secureWindow(readerWindow);
  readerWindow.once('ready-to-show', () => readerWindow.show());
  readerWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); readerWindow.hide(); } });
  readerWindow.loadFile(indexPath, { query: { mode: 'reader' } });
}

function createCompanion() {
  companionWindow = new BrowserWindow({
    title: 'Companion', ...cornerBounds(false), frame: false,
    alwaysOnTop: true, resizable: false, maximizable: false,
    backgroundColor: '#fbfaf6', show: false,
    webPreferences: windowPreferences(),
  });
  secureWindow(companionWindow);
  companionWindow.once('ready-to-show', () => companionWindow.show());
  companionWindow.on('closed', () => { companionWindow = null; app.quit(); });
  companionWindow.loadFile(indexPath, { query: { mode: 'companion' } });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (app.isReady()) openReader(); });
  app.whenReady().then(() => {
    const micAllowed = (webContents, permission, details = {}) => {
      if (!webContents || !trusted.has(webContents.id) || !isAppURL(webContents.getURL()) || permission !== 'media') return false;
      if (details.isMainFrame === false) return false;
      if (details.requestingUrl && !isAppURL(details.requestingUrl)) return false;
      if (details.mediaTypes && (!details.mediaTypes.length || details.mediaTypes.some((type) => type !== 'audio'))) return false;
      if (details.mediaType && !['audio', 'unknown'].includes(details.mediaType)) return false;
      return true;
    };
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(micAllowed(contents, permission, details)));
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => micAllowed(contents, permission, details));
    session.defaultSession.on('will-download', (event, item, contents) => {
      // The app only exports its own Markdown notes. Keep the native save dialog;
      // never accept a destination path or remote download URL from a renderer.
      const ownWindow = contents && trusted.has(contents.id) && isAppURL(contents.getURL());
      const notesExport = item.getURL().startsWith('blob:')
        && ['null', 'file://'].includes(item.getInitiatorOrigin())
        && item.getFilename() === 'companion-notes.md'
        && item.getMimeType().split(';')[0] === 'text/markdown'
        && item.hasUserGesture();
      if (!ownWindow || !notesExport) { event.preventDefault(); return; }
      item.setSaveDialogOptions({
        title: 'Export Companion notes',
        defaultPath: path.join(app.getPath('documents'), 'companion-notes.md'),
        buttonLabel: 'Export notes',
        filters: [{ name: 'Markdown notes', extensions: ['md'] }],
      });
    });

    handle('companion:status', async () => {
      const status = await provider.getStatus();
      return {
        desktop: true, provider: providerName, reasoningReady: status.aiConfigured,
        transcriptionReady: providerName === 'openai' && status.aiConfigured,
        unavailableReason: status.aiConfigured ? null : 'OpenAI is not connected. Configure its API key or select the local provider.',
        ...status, shortcutAvailable, stopShortcutAvailable,
      };
    });
    handle('companion:ask', (event, payload) => provider.ask(String(event.sender.id), payload));
    handle('companion:transcribe', (event, payload) => provider.transcribe(String(event.sender.id), payload));
    on('companion:cancel', (event, id) => provider.cancel(String(event.sender.id), id));
    on('companion:publish-context', (_event, value) => {
      latestContext = validateContext(value);
      for (const window of [readerWindow, companionWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('companion:context', latestContext);
      }
    });
    on('companion:request-context', (event) => { if (latestContext) event.sender.send('companion:context', latestContext); });
    on('companion:expanded', (event, expanded) => {
      if (typeof expanded === 'boolean' && companionWindow && !companionWindow.isDestroyed()
        && event.sender.id === companionWindow.webContents.id) companionWindow.setBounds(cornerBounds(expanded));
    });
    on('companion:open-reader', openReader);
    on('companion:open-group', openGroup);
    handle('companion:open-shared-room', async () => { await shell.openExternal(sharedRoomURL); return { opened: true }; });
    on('companion:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());

    createReader();
    createCompanion();
    shortcutAvailable = globalShortcut.register('CommandOrControl+Alt+Space', () => {
      if (!companionWindow || companionWindow.isDestroyed()) return;
      if (companionWindow.isMinimized()) companionWindow.restore();
      companionWindow.show();
      companionWindow.webContents.send('companion:toggle-mic');
    });
    stopShortcutAvailable = globalShortcut.register('CommandOrControl+Alt+Escape', () => {
      provider.cancelAll();
      for (const window of [readerWindow, companionWindow]) if (window && !window.isDestroyed()) window.webContents.send('companion:stop');
    });
    app.on('activate', openReader);
  });
}

app.on('before-quit', () => { quitting = true; provider.cancelAll(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
