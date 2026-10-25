'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const mainFile = path.resolve(__dirname, '../electron/productivity-main.cjs');
const preloadFile = path.resolve(__dirname, '../electron/productivity-preload.cjs');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function desktop(options = {}) {
  const windows = [], trays = [], paths = new Map(), createdDirectories = [], shortcuts = new Map(), timers = new Map(), fetches = [], warnings = []; let timerId = 0;
  const area = options.area || { x: 0, y: 0, width: 1280, height: 720 };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: options.packaged === true,
    getPath: () => path.join(__dirname, 'mock-app-data'), setPath: (name, value) => paths.set(name, value),
    setName: value => { app.name = value; }, setAppUserModelId: value => { app.modelId = value; },
    requestSingleInstanceLock: () => options.singleInstance !== false, whenReady: () => Promise.resolve(), isReady: () => true,
    relaunch() { app.relaunchCount = (app.relaunchCount || 0) + 1; },
    quit() {
      app.quitCount = (app.quitCount || 0) + 1;
      if (app.quitting) return; app.quitting = true; app.emit('before-quit');
      if (options.deferQuit) return;
      for (const window of windows) window.close(); app.emit('will-quit');
    },
  });
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.visible = false; this.destroyed = false; this.focusCount = 0;
      this.bounds = { x: settings.x ?? 0, y: settings.y ?? 0, width: settings.width, height: settings.height };
      this.webContents = new EventEmitter(); this.webContents.id = windows.length + 1; this.webContents.url = '';
      this.webContents.mainFrame = { url: '' }; this.webContents.messages = [];
      this.webContents.getURL = () => this.webContents.url;
      this.webContents.send = (channel, value) => this.webContents.messages.push({ channel, value });
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.loads = []; windows.push(this);
    }
    setMenuBarVisibility() {} isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return false; }
    restore() {} focus() { this.focusCount++; } show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; this.emit('hide'); }
    getBounds() { return { ...this.bounds }; } setBounds(bounds) { this.bounds = { ...bounds }; this.emit('move'); }
    loadURL(url) { this.loads.push(url); this.webContents.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    close() {
      if (this.destroyed) return;
      const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event);
      if (!event.prevented) { this.visible = false; this.destroyed = true; this.emit('closed'); }
    }
  }
  class FakeTray extends EventEmitter {
    constructor(image) { super(); if (options.trayFails) throw new Error('No tray'); this.image = image; trays.push(this); }
    setToolTip(value) { this.tooltip = value; } setContextMenu(value) { this.menu = value; } destroy() { this.destroyed = true; }
  }
  const ses = new EventEmitter();
  ses.setPermissionCheckHandler = fn => { ses.check = fn; }; ses.setPermissionRequestHandler = fn => { ses.request = fn; };
  ses.setDisplayMediaRequestHandler = fn => { ses.display = fn; };
  const screen = new EventEmitter(); screen.getPrimaryDisplay = () => ({ workArea: area }); screen.getDisplayMatching = () => ({ workArea: area });
  const ipc = new EventEmitter();
  const electron = { app, BrowserWindow: Window, ipcMain: ipc, Tray: FakeTray, screen, session: { defaultSession: ses },
    Menu: { setApplicationMenu() {}, buildFromTemplate: value => value }, nativeImage: { createFromBitmap: (pixels, size) => ({ pixels, size }) },
    globalShortcut: { register(key, handler) { if (options.failedShortcuts?.includes(key)) return false; shortcuts.set(key, handler); return true; }, unregisterAll() { shortcuts.clear(); } },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'node:fs' ? { mkdirSync: value => createdDirectories.push(value) } : require(name), __dirname: path.dirname(mainFile), URL, Buffer, console,
    process: { env: options.env || {}, argv: ['electron', mainFile, ...(options.workspace ? ['--workspace'] : [])] }, AbortController,
    fetch: (url, init) => {
      fetches.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return Promise.resolve(url.endsWith('/session') ? new Response(JSON.stringify({ csrfToken: 'a'.repeat(43) }), { headers: { 'Set-Cookie': `companion_assistant_session_v1_${options.env?.COMPANION_DESKTOP_PORT || 4174}=${'b'.repeat(43)}; Path=/api/assistant; HttpOnly` } }) : new Response(JSON.stringify({ stopped: true, builds: [] })));
    },
    setTimeout(callback, milliseconds) { const id = ++timerId; timers.set(id, { callback, milliseconds }); return id; }, clearTimeout: id => timers.delete(id),
  });
  context.console = { ...console, warn: value => warnings.push(value) };
  vm.runInContext(fs.readFileSync(mainFile, 'utf8'), context, { filename: mainFile }); await nextTurn();
  return { app, windows, trays, paths, createdDirectories, shortcuts, ses, ipc, screen, area, timers, context, fetches, warnings,
    send(window, channel, value, frame = window.webContents.mainFrame, sender = window.webContents) { ipc.emit(channel, { sender, senderFrame: frame }, value); },
  };
}

test('new productivity windows use a dedicated profile, fixed loopback URL and isolated renderers', async () => {
  const d = await desktop(); const corner = d.windows[0];
  assert.match(d.paths.get('userData'), /Companion[\\/]productivity-desktop$/);
  assert.equal(d.paths.get('sessionData'), path.join(d.paths.get('userData'), 'session'));
  assert.ok(d.createdDirectories.includes(d.paths.get('userData'))); assert.ok(d.createdDirectories.includes(d.paths.get('sessionData')));
  assert.equal(corner.loads[0], 'http://127.0.0.1:4174/assistant.html?mode=corner');
  assert.equal(corner.settings.alwaysOnTop, true); assert.equal(corner.settings.movable, true); assert.equal(corner.settings.skipTaskbar, true);
  for (const [key, value] of Object.entries({ contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true, webSecurity: true, webviewTag: false })) assert.equal(corner.settings.webPreferences[key], value);
  assert.match(corner.settings.webPreferences.preload, /productivity-preload\.cjs$/);
  assert.deepEqual(Array.from(corner.settings.webPreferences.additionalArguments), ['--companion-shell-mode=corner','--companion-shell-port=4174']);
  assert.equal(d.trays[0].image.pixels.length, 16 * 16 * 4);
});

test('only the owned trusted main frame can use named window controls', async () => {
  const d = await desktop(); const corner = d.windows[0];
  d.send(corner, 'companion-shell:open-workspace', undefined, { url: corner.loads[0] }); assert.equal(d.windows.length, 1);
  d.send(corner, 'companion-shell:open-workspace', undefined, corner.webContents.mainFrame, { id: corner.webContents.id, getURL: () => corner.loads[0] }); assert.equal(d.windows.length, 1);
  const saved = corner.webContents.url; corner.webContents.url = 'https://example.invalid/';
  d.send(corner, 'companion-shell:open-workspace'); assert.equal(d.windows.length, 1); corner.webContents.url = saved;
  d.send(corner, 'companion-shell:open-workspace'); assert.equal(d.windows.length, 2);
  assert.equal(d.windows[1].loads[0], 'http://127.0.0.1:4174/assistant.html?mode=workspace');
  assert.equal(corner.visible, false); assert.equal(d.windows[1].visible, true);
  assert.ok(corner.webContents.messages.some(message => message.channel === 'companion-shell:stop'));
});

test('navigation permits app reloads but denies subframes, webviews, popups and foreign targets', async () => {
  const d = await desktop(); const corner = d.windows[0], contents = corner.webContents;
  for (const url of ['https://example.invalid/','file:///private.txt','http://localhost:4174/assistant.html?mode=corner','http://127.0.0.1:4175/assistant.html?mode=corner','http://127.0.0.1:4174/room.html','http://127.0.0.1:4174/assistant.html?mode=corner&mode=workspace']) {
    const event = { url, isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
    contents.emit('will-frame-navigate', event); assert.equal(event.prevented, true, url);
  }
  const reload = { url: corner.loads[0], isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-frame-navigate', reload); assert.equal(reload.prevented, false);
  contents.emit('will-frame-navigate', { ...reload, isMainFrame: false, preventDefault() { this.prevented = true; } });
  assert.equal(contents.listenerCount('will-attach-webview'), 1); assert.equal(corner.openHandler().action, 'deny');
});

test('permissions grant visible trusted main-frame audio and reject camera or ambiguous requests', async () => {
  const d = await desktop(); const corner = d.windows[0], contents = corner.webContents;
  const detail = { isMainFrame: true, requestingUrl: corner.loads[0], securityOrigin: 'http://127.0.0.1:4174', mediaType: 'audio' };
  assert.equal(!!d.ses.check(contents, 'media', detail.securityOrigin, detail), true);
  for (const extra of [{ isMainFrame: false }, { isMainFrame: undefined }, { mediaType: 'video' }, { mediaType: 'unknown' }, { requestingUrl: 'https://example.invalid/' }, { embeddingOrigin: 'https://example.invalid' }]) assert.equal(!!d.ses.check(contents, 'media', detail.securityOrigin, { ...detail, ...extra }), false);
  assert.equal(!!d.ses.check(contents, 'geolocation', detail.securityOrigin, detail), false);
  let allowed; d.ses.request(contents, 'media', value => { allowed = value; }, { ...detail, mediaTypes: ['audio'] }); assert.equal(allowed, true);
  for (const mediaTypes of [['video'],['audio','video'],[],undefined]) { d.ses.request(contents, 'media', value => { allowed = value; }, { ...detail, mediaTypes }); assert.equal(allowed, false); }
  d.send(corner, 'companion-shell:hide'); assert.equal(!!d.ses.check(contents, 'media', detail.securityOrigin, detail), false);
  d.ses.display({}, value => { allowed = value; }); assert.equal(allowed, null);
});

test('microphone policy accepts Chromium bare-origin slash serialization without weakening frame or camera checks', async () => {
  const d = await desktop({ env: { COMPANION_DESKTOP_PORT: '4202' } }); const corner = d.windows[0], contents = corner.webContents;
  const details = { isMainFrame: true, requestingUrl: corner.loads[0], securityOrigin: 'http://127.0.0.1:4202/', mediaType: 'audio' };
  for (const origin of ['http://127.0.0.1:4202', 'http://127.0.0.1:4202/']) {
    assert.equal(d.ses.check(contents, 'media', origin, details), true);
    let allowed; d.ses.request(contents, 'media', value => { allowed = value; }, { ...details, securityOrigin: origin, mediaTypes: ['audio'] }); assert.equal(allowed, true);
  }
  for (const origin of ['http://user@127.0.0.1:4202/', 'http://127.0.0.1:4202/assistant.html', 'http://127.0.0.1:4202/?x=1', 'http://127.0.0.1:4202/#x', 'http://localhost:4202/', 'http://127.0.0.1:4203/', 'https://127.0.0.1:4202/']) {
    assert.equal(d.ses.check(contents, 'media', origin, details), false, origin);
    let allowed; d.ses.request(contents, 'media', value => { allowed = value; }, { ...details, securityOrigin: origin, mediaTypes: ['audio'] }); assert.equal(allowed, false, origin);
  }
  assert.equal(d.ses.check(contents, 'media', 'http://127.0.0.1:4202/', { ...details, isMainFrame: false }), false);
  assert.equal(d.ses.check(contents, 'media', 'http://127.0.0.1:4202/', { ...details, mediaType: 'video' }), false);
  let camera; d.ses.request(contents, 'media', value => { camera = value; }, { ...details, mediaTypes: ['audio','video'] }); assert.equal(camera, false);
});

test('expanded corners retain their dragged location and stay inside negative display work areas', async () => {
  const d = await desktop({ area: { x: -900, y: -200, width: 800, height: 600 } }); const corner = d.windows[0];
  corner.bounds = { x: -780, y: 100, width: 400, height: 230 };
  d.send(corner, 'companion-shell:expanded', true);
  assert.equal(corner.bounds.width, 420); assert.equal(corner.bounds.height, 600); assert.equal(corner.bounds.x, -780); assert.equal(corner.bounds.y, -200);
  d.send(corner, 'companion-shell:expanded', 'yes'); assert.equal(corner.bounds.height, 600);
  d.send(corner, 'companion-shell:expanded', false); assert.equal(corner.bounds.width, 400); assert.equal(corner.bounds.height, 230);
  corner.bounds.x = -2000; corner.bounds.y = 1000; d.screen.emit('display-removed');
  assert.ok(corner.bounds.x >= d.area.x && corner.bounds.x + corner.bounds.width <= d.area.x + d.area.width);
  assert.ok(corner.bounds.y >= d.area.y && corner.bounds.y + corner.bounds.height <= d.area.y + d.area.height);
});

test('shortcuts, close-to-corner and explicit tray quit have separate lifecycles', async () => {
  const d = await desktop(); const corner = d.windows[0];
  d.shortcuts.get('Control+Alt+Space')(); assert.equal(corner.visible, false);
  d.shortcuts.get('Control+Alt+Space')(); assert.equal(corner.visible, true);
  d.send(corner, 'companion-shell:open-workspace'); const workspace = d.windows[1];
  await d.shortcuts.get('Control+Alt+Escape')();
  assert.ok(workspace.webContents.messages.some(message => message.channel === 'companion-shell:stop' && message.value.reason === 'shortcut'));
  workspace.close(); assert.equal(workspace.destroyed, false); assert.equal(workspace.visible, false); assert.equal(corner.visible, true);
  corner.close(); assert.equal(corner.destroyed, false); assert.equal(d.app.quitCount || 0, 0);
  d.trays[0].menu.find(item => item.label === 'Quit desktop').click();
  assert.ok(d.app.quitCount >= 1); assert.equal(d.trays[0].destroyed, true); assert.equal(d.shortcuts.size, 0);
  assert.ok(d.windows.every(window => window.destroyed));
});

test('physical Stop bootstraps a fixed-origin RAM-only session and confirms the backend independently', async () => {
  const d = await desktop({ env: { COMPANION_DESKTOP_PORT: '4202' } }); const corner = d.windows[0];
  const result = await d.shortcuts.get('Control+Alt+Escape')(); assert.equal(result.stopped, true);
  assert.deepEqual(d.fetches.map(call => call.url), ['http://127.0.0.1:4202/api/assistant/session','http://127.0.0.1:4202/api/assistant/stop']);
  const post = d.fetches[1].init; assert.equal(post.method, 'POST'); assert.equal(post.redirect, 'error'); assert.equal(post.body, '{}');
  assert.equal(post.headers.Origin, 'http://127.0.0.1:4202'); assert.equal(post.headers['X-CSRF-Token'], 'a'.repeat(43)); assert.equal(post.headers.Cookie, `companion_assistant_session_v1_4202=${'b'.repeat(43)}`);
  assert.ok(corner.webContents.messages.some(message => message.channel === 'companion-shell:stop' && message.value.reason === 'shortcut'));
  assert.ok(!JSON.stringify(corner.webContents.messages).includes('a'.repeat(43)));
  await d.shortcuts.get('Control+Alt+Escape')(); assert.equal(d.fetches[2].init.headers.Cookie, post.headers.Cookie);
});

test('global Stop coalesces HTTP while always issuing local cleanup even with a failed renderer', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const d = await desktop({ fetch: async url => {
    if (url.endsWith('/session')) { await gate; return new Response(JSON.stringify({ csrfToken: 'a'.repeat(43) }), { headers: { 'set-cookie': `companion_assistant_session_v1_4174=${'b'.repeat(43)}` } }); }
    return new Response(JSON.stringify({ stopped: true }));
  } });
  const corner = d.windows[0]; let attempts = 0; corner.webContents.send = () => { attempts++; throw new Error('Synthetic crashed renderer'); };
  const first = d.shortcuts.get('Control+Alt+Escape')(), second = d.shortcuts.get('Control+Alt+Escape')();
  assert.equal(first, second); assert.equal(attempts, 2); assert.equal(d.fetches.length, 1);
  release(); assert.equal((await first).stopped, true); assert.equal(d.fetches.length, 2);
});

test('hidden and quit cleanup never invoke global backend Stop, and timeout errors stay generic', async () => {
  const local = await desktop(); local.send(local.windows[0], 'companion-shell:hide'); local.app.quit(); assert.equal(local.fetches.length, 0);
  const d = await desktop({ fetch: () => new Promise(() => {}) }); const pending = d.shortcuts.get('Control+Alt+Escape')();
  const deadline = [...d.timers.values()].find(timer => timer.milliseconds === 5000); deadline.callback();
  assert.equal((await pending).stopped, false); assert.equal(d.warnings.length, 1); assert.match(d.warnings[0], /did not confirm Stop/);
  assert.equal(d.fetches[0].init.signal.aborted, true);
});

test('offline loading presents a constrained Retry document and rejects its bridge IPC', async () => {
  const d = await desktop(); const corner = d.windows[0];
  corner.webContents.emit('did-fail-load', {}, -102, 'refused', corner.loads[0], true);
  assert.ok(corner.loads.at(-1).startsWith('data:text/html;'));
  const html = decodeURIComponent(corner.loads.at(-1).split(',')[1]); assert.match(html, /Companion is reconnecting/); assert.match(html, /Try again/);
  assert.match(html, /default-src 'none'/); assert.ok(!html.includes('<script'));
  d.send(corner, 'companion-shell:open-workspace'); assert.equal(d.windows.length, 1);
  const retry = [...d.timers.values()].find(timer => timer.milliseconds === 1500); retry.callback();
  assert.equal(corner.loads.at(-1), 'http://127.0.0.1:4174/assistant.html?mode=corner');
});

test('single-instance failure opens no windows and tray failure cannot leave a hidden orphan', async () => {
  const duplicate = await desktop({ singleInstance: false }); assert.equal(duplicate.windows.length, 0); assert.ok(duplicate.app.quitCount >= 1);
  const noTray = await desktop({ trayFails: true }); noTray.send(noTray.windows[0], 'companion-shell:hide'); assert.ok(noTray.app.quitCount >= 1);
});

test('desktop relaunch is a fixed own-app action available only to the trusted main frame once', async () => {
  const d = await desktop({ deferQuit: true }); const corner = d.windows[0];
  d.send(corner, 'companion-shell:restart', undefined, { url: corner.loads[0] }); assert.equal(d.app.relaunchCount || 0, 0);
  const saved = corner.webContents.url; corner.webContents.url = 'data:text/html,recovery';
  d.send(corner, 'companion-shell:restart'); assert.equal(d.app.relaunchCount || 0, 0); corner.webContents.url = saved;
  d.send(corner, 'companion-shell:restart'); d.send(corner, 'companion-shell:restart');
  assert.equal(d.app.relaunchCount, 1); assert.equal(d.app.quitCount, 1);
  assert.ok(corner.webContents.messages.some(message => message.channel === 'companion-shell:stop' && message.value.reason === 'quit'));
});

test('mode updates distinguish editable source runtimes from copied packaged shells', async () => {
  for (const packaged of [false, true]) {
    const d = await desktop({ packaged }); const corner = d.windows[0];
    d.send(corner, 'companion-shell:request-mode');
    const state = corner.webContents.messages.filter(message => message.channel === 'companion-shell:mode').at(-1).value;
    assert.equal(state.sourceRuntime, !packaged);
  }
});

function preload({ mainFrame = true, url = 'http://127.0.0.1:4174/assistant.html?mode=corner' } = {}) {
  const ipc = new EventEmitter(), sent = []; ipc.send = (...args) => sent.push(args);
  let bridge;
  const location = new URL(url);
  vm.runInNewContext(fs.readFileSync(preloadFile, 'utf8'), { require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'companionShell'); bridge = value; } } }; },
    process: { isMainFrame: mainFrame, argv: ['--companion-shell-mode=corner','--companion-shell-port=4174'] }, window: { location }, URLSearchParams }, { filename: preloadFile });
  return { bridge, ipc, sent };
}
test('preload exposes only named window controls and unsubscribes listeners without leaking IPC', () => {
  const p = preload(); assert.deepEqual(Object.keys(p.bridge).sort(), ['desktop','hide','mode','onModeChanged','onStop','openWorkspace','restart','setExpanded'].sort());
  assert.equal(p.bridge.mode, 'corner'); assert.ok(Object.isFrozen(p.bridge));
  p.bridge.openWorkspace(); p.bridge.setExpanded(true); assert.throws(() => p.bridge.setExpanded('yes'), /true or false/);
  let count = 0; const unsubscribe = p.bridge.onStop(() => { count++; }); p.ipc.emit('companion-shell:stop', {}, {}); unsubscribe(); p.ipc.emit('companion-shell:stop', {}, {}); assert.equal(count, 1);
  p.bridge.onModeChanged(() => {}); assert.ok(p.sent.some(args => args[0] === 'companion-shell:request-mode'));
  assert.equal(p.bridge.send, undefined); assert.equal(p.bridge.invoke, undefined);
});
test('preload exposes no bridge to subframes, recovery pages, wrong modes or foreign origins', () => {
  assert.equal(preload({ mainFrame: false }).bridge, undefined);
  for (const url of ['data:text/html,recovery','https://example.invalid/assistant.html?mode=corner','http://127.0.0.1:4175/assistant.html?mode=corner','http://127.0.0.1:4174/room.html?mode=corner','http://127.0.0.1:4174/assistant.html?mode=workspace']) assert.equal(preload({ url }).bridge, undefined, url);
});
