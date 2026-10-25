'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, session, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const port = Number(process.env.COMPANION_DESKTOP_PORT || 4174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('COMPANION_DESKTOP_PORT must be a local port from 1024 to 65535.');
const origin = `http://127.0.0.1:${port}`;
const preload = path.join(__dirname, 'productivity-preload.cjs');
const defaultProfile = path.join(app.getPath('appData'), 'Companion', 'productivity-desktop');
const profile = process.env.COMPANION_DESKTOP_PROFILE || defaultProfile;
if (!path.isAbsolute(profile)) throw new Error('COMPANION_DESKTOP_PROFILE must be an absolute dedicated profile directory.');
app.setName('Companion Desktop');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(profile, 'session'), { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.setAppUserModelId('Companion.Productivity.Desktop');

let corner = null, workspace = null, tray = null, quitting = false, expanded = false, relaunching = false;
let clampTimer = null;
let serverStopPromise = null;
let stopCookie = '', stopCsrf = '';
const windows = new Map();
const shortcuts = { toggle: false, stop: false };
const urlFor = mode => `${origin}/assistant.html?mode=${mode}`;

function trustedURL(value, mode) {
  try {
    const parsed = new URL(value);
    return parsed.origin === origin && !parsed.username && !parsed.password && parsed.pathname === '/assistant.html'
      && parsed.searchParams.get('mode') === mode && [...parsed.searchParams.keys()].length === 1;
  } catch { return false; }
}
function trustedOrigin(value) {
  try {
    const parsed = new URL(value);
    // Chromium forwards origins as GURLs, commonly ending in '/'. Accept
    // those two bare-origin forms without accepting a page URL or credentials.
    return parsed.origin === origin && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch { return false; }
}
function recordFor(contents) {
  const record = windows.get(contents?.id);
  return record && record.window.webContents === contents && !record.window.isDestroyed()
    && trustedURL(contents.getURL(), record.mode) ? record : null;
}
function trustedSender(event) {
  const record = recordFor(event.sender);
  return record && event.senderFrame === event.sender.mainFrame && trustedURL(event.senderFrame?.url, record.mode) ? record : null;
}
function emitMode(record) {
  if (record.window.isDestroyed()) return;
  record.window.webContents.send('companion-shell:mode', { mode: record.mode, expanded: record.mode === 'corner' ? expanded : true,
    visible: record.window.isVisible(), sourceRuntime: !app.isPackaged, shortcuts: { ...shortcuts } });
}
function stopWindow(window, reason) {
  if (window && !window.isDestroyed()) { try { window.webContents.send('companion-shell:stop', { reason }); } catch {} }
}
async function boundedStopJson(response, limit, signal) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Stop response exceeded its bound.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Stop response was unreadable.');
  const chunks = []; let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Stop deadline reached.');
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error('Stop response exceeded its bound.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (signal.aborted) throw new Error('Stop deadline reached.');
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}
async function requestServerStop(signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionResponse = await fetch(`${origin}/api/assistant/session`, { method: 'GET', redirect: 'error', cache: 'no-store',
      signal, headers: stopCookie ? { Cookie: stopCookie } : {} });
    if (!sessionResponse.ok) throw new Error('Stop session could not be opened.');
    const sessionValue = await boundedStopJson(sessionResponse, 4096, signal);
    const setCookies = typeof sessionResponse.headers.getSetCookie === 'function' ? sessionResponse.headers.getSetCookie() : [sessionResponse.headers.get('set-cookie') || ''];
    const name = `companion_assistant_session_v1_${port}`;
    const freshCookie = setCookies.map(value => value.split(';')[0].trim()).find(value => new RegExp(`^${name}=[A-Za-z0-9_-]{43}$`).test(value));
    if (freshCookie) stopCookie = freshCookie;
    if (!stopCookie || typeof sessionValue.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionValue.csrfToken)) throw new Error('Stop session was invalid.');
    stopCsrf = sessionValue.csrfToken;
    if (signal.aborted) throw new Error('Stop deadline reached.');
    const response = await fetch(`${origin}/api/assistant/stop`, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { Origin: origin, Cookie: stopCookie, 'X-CSRF-Token': stopCsrf, 'Content-Type': 'application/json' }, body: '{}' });
    if ((response.status === 401 || response.status === 403) && attempt === 0) { stopCookie = ''; stopCsrf = ''; await response.body?.cancel(); continue; }
    if (!response.ok) throw new Error('Stop was not accepted.');
    const result = await boundedStopJson(response, 32768, signal);
    if (result.stopped !== true || result.builds?.some(build => build.status === 'check_required')) throw new Error('Stop could not be fully confirmed.');
    return { stopped: true };
  }
  throw new Error('Stop session could not be refreshed.');
}
function stopServerWork() {
  if (serverStopPromise) return serverStopPromise;
  const controller = new AbortController(); let timer;
  const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Stop deadline reached.')); }, 5000); });
  const work = Promise.race([requestServerStop(controller.signal), deadline]).catch(() => {
    console.warn('The local service did not confirm Stop. Check the connection and try again.'); return { stopped: false };
  }).finally(() => { clearTimeout(timer); });
  serverStopPromise = work;
  void work.finally(() => { if (serverStopPromise === work) serverStopPromise = null; });
  return work;
}
function stopAll(reason = 'shortcut') {
  for (const record of windows.values()) stopWindow(record.window, reason);
  if (reason === 'shortcut') return stopServerWork();
}
function restartDesktop() {
  if (relaunching || quitting) return;
  relaunching = true;
  try { app.relaunch(); app.quit(); }
  catch { relaunching = false; console.warn('Desktop restart could not be requested. Quit the desktop and open its launcher again.'); }
}
function visibleWindows() { return [...windows.values()].some(record => !record.window.isDestroyed() && record.window.isVisible()); }
function hideWindow(window) {
  if (!window || window.isDestroyed()) return;
  stopWindow(window, 'hidden'); window.hide(); emitMode(windows.get(window.webContents.id));
  if (!tray && !visibleWindows()) app.quit();
}
function cornerBounds(previous, resize = false) {
  const display = previous ? screen.getDisplayMatching(previous) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(expanded ? 420 : 400, Math.max(1, area.width));
  const height = Math.min(expanded ? 620 : 230, Math.max(1, area.height));
  const x = previous ? previous.x : area.x + area.width - width - 16;
  const y = previous ? previous.y + (resize ? previous.height - height : 0) : area.y + area.height - height - 16;
  return { width, height, x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)) };
}
function clampCorner(resize = false) {
  if (!corner || corner.isDestroyed()) return;
  const previous = corner.getBounds(); const next = cornerBounds(previous, resize);
  if (Object.keys(next).some(key => next[key] !== previous[key])) corner.setBounds(next);
}
function recoveryURL(mode) {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Companion · reconnect</title><style>body{margin:0;background:#101010;color:#f5f5f5;font:14px system-ui}main{margin:8px;padding:20px;border:1px solid #fff;border-radius:10px;-webkit-app-region:drag}h1{font-size:17px;margin:0 0 10px}p{color:#b6b6b6;line-height:1.45;margin:0 0 15px}a{display:inline-block;color:#101010;background:#fff;border:1px solid #fff;border-radius:8px;padding:9px 14px;text-decoration:none;-webkit-app-region:no-drag}</style><main><h1>Companion is reconnecting</h1><p>The local service is unavailable. Start Companion, then try again.</p><a href="${urlFor(mode)}">Try again</a></main></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function configure(window, mode) {
  const contents = window.webContents; const record = { window, mode, retries: 0, retryTimer: null };
  windows.set(contents.id, record); window.setMenuBarVisibility(false);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-frame-navigate', event => { if (!event.isMainFrame || !trustedURL(event.url, mode)) event.preventDefault(); });
  contents.on('will-navigate', (event, url) => { if (!trustedURL(event.url || url, mode)) event.preventDefault(); else record.retries = 0; });
  contents.on('will-redirect', event => { if (!event.isMainFrame || !trustedURL(event.url, mode)) event.preventDefault(); });
  contents.on('did-finish-load', () => { if (trustedURL(contents.getURL(), mode)) { record.retries = 0; emitMode(record); } });
  contents.on('did-fail-load', (_event, errorCode, _description, failedURL, mainFrame) => {
    if (!mainFrame || errorCode === -3 || quitting || !trustedURL(failedURL, mode)) return;
    void window.loadURL(recoveryURL(mode)).catch(() => {});
    if (record.retries >= 5) return;
    record.retries += 1; clearTimeout(record.retryTimer);
    record.retryTimer = setTimeout(() => { if (!quitting && !window.isDestroyed()) void window.loadURL(urlFor(mode)).catch(() => {}); }, 1500);
  });
  window.on('show', () => emitMode(record)); window.on('hide', () => emitMode(record));
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (mode === 'workspace') { showCorner(); hideWindow(window); }
    else hideWindow(window);
  });
  window.on('closed', () => { clearTimeout(record.retryTimer); windows.delete(contents.id); if (mode === 'corner') corner = null; else workspace = null; });
  return record;
}
function preferences(mode) {
  return { preload, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
    additionalArguments: [`--companion-shell-mode=${mode}`, `--companion-shell-port=${port}`] };
}
function showCorner() {
  if (!corner || corner.isDestroyed()) {
    corner = new BrowserWindow({ title: 'Companion', ...cornerBounds(), frame: false, alwaysOnTop: true,
      skipTaskbar: true, movable: true, resizable: false, maximizable: false, fullscreenable: false,
      backgroundColor: '#101010', show: false, webPreferences: preferences('corner') });
    configure(corner, 'corner');
    corner.on('move', () => { clearTimeout(clampTimer); clampTimer = setTimeout(() => clampCorner(), 120); });
    void corner.loadURL(urlFor('corner')).catch(() => {});
  }
  clampCorner(); if (corner.isMinimized()) corner.restore(); corner.show(); corner.focus();
}
function toggleCorner() { if (corner && !corner.isDestroyed() && corner.isVisible()) hideWindow(corner); else showCorner(); }
function openWorkspace() {
  if (!workspace || workspace.isDestroyed()) {
    workspace = new BrowserWindow({ title: 'Companion — Workspace', width: 1180, height: 840, minWidth: 760, minHeight: 560,
      backgroundColor: '#101010', show: false, webPreferences: preferences('workspace') });
    configure(workspace, 'workspace');
    void workspace.loadURL(urlFor('workspace')).catch(() => {});
  }
  if (workspace.isMinimized()) workspace.restore(); workspace.show(); workspace.focus();
  hideWindow(corner);
}
function icon() {
  const size = 16, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot(x - 7.5, y - 7.5), offset = (y * size + x) * 4;
    if (radius > 7.5) continue;
    const foreground = radius >= 3.5 && radius <= 5.2 && (x < 9 || y < 4 || y > 11);
    pixels[offset] = foreground ? 232 : 120; pixels[offset + 1] = foreground ? 246 : 205;
    pixels[offset + 2] = foreground ? 239 : 154; pixels[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
function microphoneContext(contents, details) {
  const record = recordFor(contents);
  return record && record.window.isVisible() && details?.isMainFrame === true && trustedURL(details.requestingUrl, record.mode)
    && (details.securityOrigin === undefined || trustedOrigin(details.securityOrigin)) && !details.embeddingOrigin;
}
function installPermissions() {
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details = {}) =>
    !!(permission === 'media' && trustedOrigin(requestingOrigin) && microphoneContext(contents, details) && details.mediaType === 'audio'));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details = {}) => callback(!!(permission === 'media'
    && microphoneContext(contents, details) && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio'))));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  session.defaultSession.on('will-download', event => event.preventDefault());
}
function installBridge() {
  function on(channel, callback) {
    ipcMain.on(channel, (event, value) => { const record = trustedSender(event); if (record) callback(record, value); });
  }
  on('companion-shell:open-workspace', () => openWorkspace());
  on('companion-shell:hide', record => hideWindow(record.window));
  on('companion-shell:expanded', (record, value) => { if (record.mode !== 'corner' || typeof value !== 'boolean') return; expanded = value; clampCorner(true); emitMode(record); });
  on('companion-shell:request-mode', record => emitMode(record));
  on('companion-shell:restart', () => restartDesktop());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (app.isReady()) { if (argv.includes('--workspace')) openWorkspace(); else showCorner(); } });
  app.whenReady().then(() => {
    installPermissions(); installBridge(); Menu.setApplicationMenu(null);
    try {
      tray = new Tray(icon()); tray.setToolTip('Companion');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Companion', click: showCorner }, { label: 'Open workspace', click: openWorkspace },
        { label: 'Stop current work', click: () => stopAll() }, { type: 'separator' }, { label: 'Quit desktop', click: () => app.quit() }]));
      tray.on('click', showCorner);
    } catch { tray = null; }
    shortcuts.toggle = globalShortcut.register('Control+Alt+Space', toggleCorner);
    shortcuts.stop = globalShortcut.register('Control+Alt+Escape', () => stopAll());
    screen.on('display-removed', () => clampCorner()); screen.on('display-metrics-changed', () => clampCorner());
    if (process.argv.includes('--workspace')) openWorkspace(); else showCorner();
    app.on('activate', showCorner);
  });
}
app.on('before-quit', () => { quitting = true; stopAll('quit'); });
app.on('will-quit', () => { clearTimeout(clampTimer); globalShortcut.unregisterAll(); tray?.destroy(); });
app.on('window-all-closed', () => { if (quitting || !tray) app.quit(); });
