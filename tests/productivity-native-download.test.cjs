'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const mainFile = path.resolve(__dirname, '../electron/productivity-main.cjs');
const archiveId = '01234567-89ab-4cde-8fab-0123456789ab';
const filename = `companion-workspace-${archiveId}.json`;

// Run the actual native entry point against Electron event doubles, without
// starting Electron, creating files, contacting a server or accepting save paths.
async function nativeDownloads(port = 4174) {
  const windows = [], directories = [], ipc = new EventEmitter(), ses = new EventEmitter(), app = new EventEmitter();
  const origin = `http://127.0.0.1:${port}`, url = `${origin}/api/assistant/backups/${archiveId}/download`;
  Object.assign(app, { isPackaged: false, getPath: () => __dirname, setPath() {}, setName() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() {}, isReady: () => true });
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.destroyed = false; this.visible = false;
      this.bounds = { x: settings.x ?? 0, y: settings.y ?? 0, width: settings.width, height: settings.height };
      this.webContents = new EventEmitter(); Object.assign(this.webContents, { id: windows.length + 1, mainFrame: { url: '' },
        getURL: () => this.webContents.url, send() {}, setWindowOpenHandler() {} }); windows.push(this);
    }
    loadURL(value) { this.webContents.url = value; this.webContents.mainFrame.url = value; return Promise.resolve(); }
    setMenuBarVisibility() {} isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return false; }
    getBounds() { return { ...this.bounds }; } setBounds(value) { this.bounds = value; } restore() {} focus() {}
    show() { this.visible = true; } hide() { this.visible = false; }
  }
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
  const screen = new EventEmitter(), area = { x: 0, y: 0, width: 1280, height: 720 };
  Object.assign(screen, { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) });
  Object.assign(ses, { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {} });
  const electron = { app, BrowserWindow: Window, ipcMain: ipc, screen, session: { defaultSession: ses }, Tray,
    Menu: { setApplicationMenu() {}, buildFromTemplate: value => value }, nativeImage: { createFromBitmap: () => ({}) },
    globalShortcut: { register: () => true, unregisterAll() {} } };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: name => name === 'electron' ? electron : name === 'node:fs' ? { mkdirSync: value => directories.push(value) } : require(name),
    __dirname: path.dirname(mainFile), URL, Buffer, console, process: { env: { COMPANION_DESKTOP_PORT: String(port) }, argv: ['electron', mainFile] },
    setTimeout, clearTimeout, AbortController, fetch: () => { throw new Error('Downloads must not use a native fetch/filesystem bypass.'); } }, { filename: mainFile });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ses.listenerCount('will-download'), 1);
  function download(overrides = {}, contents = windows[0].webContents, frame = contents?.mainFrame) {
    const options = [], event = { prevented: false, preventDefault() { this.prevented = true; } };
    const item = { getURL: () => url, getURLChain: () => [url], getInitiatorOrigin: () => origin,
      getFilename: () => filename, getMimeType: () => 'application/json', setSaveDialogOptions: value => options.push(value),
      setSavePath() { throw new Error('The destination must remain a native user choice.'); }, ...overrides };
    ses.emit('will-download', event, item, contents, frame); return { event, options, item };
  }
  return { windows, directories, ipc, ses, origin, url, download };
}

test('an own main-frame backup uses the native Save dialog with only the fixed safe filename', async () => {
  const d = await nativeDownloads(), result = d.download(); assert.equal(result.event.prevented, false); assert.equal(result.options.length, 1);
  const options = JSON.parse(JSON.stringify(result.options[0]));
  assert.deepEqual(options, { title: 'Save Companion workspace backup', defaultPath: filename, buttonLabel: 'Save backup', filters: [{ name: 'Companion workspace backup', extensions: ['json'] }] });
  assert.equal(path.isAbsolute(options.defaultPath), false); assert.equal(options.defaultPath.includes('/'), false); assert.equal(options.defaultPath.includes('\\'), false);
  assert.equal(d.download({ getMimeType: () => 'application/json; charset=utf-8' }).event.prevented, false);
  const corner = d.windows[0];d.ipc.emit('companion-shell:open-workspace', { sender: corner.webContents, senderFrame: corner.webContents.mainFrame });
  assert.equal(d.windows.length, 2);assert.equal(d.download({}, d.windows[1].webContents).event.prevented, false);
});

test('foreign, blob, malformed and normalized lookalike URLs remain blocked with no dialog', async () => {
  const d = await nativeDownloads();
  const denied = [
    'blob:' + d.url, 'data:application/json,{}', 'file:///backup.json', d.url.replace('http:', 'https:'), d.url.replace(':4174', ':4175'),
    d.url.replace('127.0.0.1', 'localhost'), d.url.replace('127.0.0.1', '127.0.0.1.example.invalid'), d.url.replace('127.0.0.1', 'user@127.0.0.1'),
    d.url + '?download=1', d.url + '?', d.url + '#backup', d.url + '#', d.url + '/', d.url.replace('/api/', '/API/'),
    d.url.replace(archiveId, 'not-a-uuid'), d.url.replace('download', 'preview'), d.url.replace('/backups/', '/notes/'),
    d.url.replace('/api/', '/ignored/../api/'), d.url.replace('/api/', '/%61pi/'), d.url.replace('/api/', '\\api/'),
  ];
  for (const url of denied) { const result = d.download({ getURL: () => url, getURLChain: () => [url] }); assert.equal(result.event.prevented, true, url); assert.equal(result.options.length, 0, url); }
});

test('initiator frame identity and current own-window membership are required independently of the target URL', async () => {
  const d = await nativeDownloads(), contents = d.windows[0].webContents;
  for (const frame of [null, { url: contents.getURL() }, { url: contents.getURL(), parent: contents.mainFrame }]) {
    const result = d.download({}, contents, frame); assert.equal(result.event.prevented, true); assert.equal(result.options.length, 0);
  }
  const missing = { prevented: false, preventDefault() { this.prevented = true; } }; d.ses.emit('will-download', missing, d.download().item, contents); assert.equal(missing.prevented, true);
  const spoofed = { ...contents, getURL: () => contents.getURL(), mainFrame: contents.mainFrame };assert.equal(d.download({}, spoofed).event.prevented, true);
  assert.equal(d.download({}, null, null).event.prevented, true);
  const oldFrameURL = contents.mainFrame.url;contents.mainFrame.url = 'https://example.invalid/assistant.html?mode=corner';assert.equal(d.download().event.prevented, true);contents.mainFrame.url = oldFrameURL;
  const oldURL = contents.url;for (const url of ['data:text/html,recovery', d.origin + '/room.html', d.origin + '/assistant.html?mode=workspace', 'https://example.invalid/']) { contents.url = url;assert.equal(d.download().event.prevented, true); }contents.url = oldURL;
  d.windows[0].destroyed = true;assert.equal(d.download().event.prevented, true);d.windows[0].destroyed = false;d.windows[0].emit('closed');assert.equal(d.download().event.prevented, true);
});

test('the true initiator origin and complete nonredirected URL chain are mandatory', async () => {
  const d = await nativeDownloads();
  for (const initiator of ['', 'null', 'file://', 'https://example.invalid', 'http://127.0.0.1:4175', d.origin + '/assistant.html', 'http://user@127.0.0.1:4174']) {
    const result = d.download({ getInitiatorOrigin: () => initiator });assert.equal(result.event.prevented, true, initiator);assert.equal(result.options.length, 0);
  }
  for (const chain of [[], null, [d.url, d.url], ['https://example.invalid/start', d.url], [d.origin + '/redirect', d.url], [d.url + '?earlier=1']]) {
    const result = d.download({ getURLChain: () => chain });assert.equal(result.event.prevented, true);assert.equal(result.options.length, 0);
  }
});

test('server filename and JSON MIME stay fixed and unavailable Electron evidence fails closed', async () => {
  const d = await nativeDownloads();
  for (const badName of ['backup.json', 'companion-workspace-' + archiveId + '.exe', '../' + filename, 'C:\\Users\\Public\\' + filename, filename + '.json'])assert.equal(d.download({ getFilename: () => badName }).event.prevented, true);
  for (const mime of ['text/html', 'application/octet-stream', 'application/javascript', 'text/json', '', null])assert.equal(d.download({ getMimeType: () => mime }).event.prevented, true);
  for (const key of ['getURL','getURLChain','getInitiatorOrigin','getFilename','getMimeType','setSaveDialogOptions']) {
    assert.equal(d.download({ [key]: undefined }).event.prevented, true, key);
    assert.equal(d.download({ [key]: () => { throw new Error('Synthetic detached or unsupported download.'); } }).event.prevented, true, key);
  }
  const upper = d.url.replace(archiveId, archiveId.toUpperCase());assert.equal(d.download({ getURL: () => upper, getURLChain: () => [upper] }).event.prevented, false);
});

test('the configured Companion port is respected without opening another origin or path', async () => {
  const d = await nativeDownloads(4219);assert.equal(d.download().event.prevented, false);
  const wrongPort = d.url.replace(':4219', ':4174');assert.equal(d.download({ getURL: () => wrongPort, getURLChain: () => [wrongPort] }).event.prevented, true);
});
