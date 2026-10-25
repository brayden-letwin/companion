import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService, createDesktopBridgeRunner, DESKTOP_KEYS } from '../server/desktop-service.mjs';

const WINDOW = { handle: '123456', pid: 200, startTime: '638000000000000000', title: 'Synthetic editor', appName: 'SyntheticEditor', className: 'SyntheticClass' };
const ELEMENT = { runtimeId: '42.123.-1', fingerprint: 'a'.repeat(64), name: 'Document input', automationId: 'document', className: 'Edit', controlType: 'Edit', enabled: true, isPassword: false, value: 'Original text', actions: ['click', 'setText', 'pressKey'] };
async function fixture(t, options = {}) {
  const calls = [];
  const runner = options.runner || (async request => {
    if (request.action === 'health') return { available: true };
    if (request.action === 'listApps') return { apps: [{ name: 'Synthetic editor', sourceId: 'Installed.SyntheticEditor!App' }, { name: 'Another app', sourceId: 'Installed.Another!App' }, { name: 'PowerShell', sourceId: 'Windows.PowerShell' }] };
    if (request.action === 'listWindows') return { windows: [WINDOW, { ...WINDOW, handle: '999', pid: 201, title: 'Unrelated window', appName: 'Other' }] };
    if (request.action === 'openApp') return { accepted: true, windows: [WINDOW] };
    if (request.action === 'openUrl') return { accepted: true };
    if (request.action === 'focusWindow') return { focused: true };
    if (request.action === 'readWindow') return { elements: [ELEMENT] };
    if (request.action === 'performAction') return { performed: true };
    throw new Error('Unexpected synthetic bridge request.');
  });
  const service = await createDesktopService({ platform: 'win32', ...options, runner: (request, context) => { calls.push({ request: structuredClone(request), signal: context.signal }); return runner(request, context); } });
  t.after(() => service.close());
  async function snapshot(query = 'Synthetic') { const found = await service.execute('desktop_list_windows', { query }); return (await service.execute('desktop_read_window', { windowId: found.windows[0].id })).snapshot; }
  async function propose(action = 'click', fields = {}) { const source = await snapshot(); return (await service.execute('desktop_propose_action', { snapshotId: source.id, elementId: source.elements[0].id, action, ...fields })).desktopAction; }
  return { service, calls, snapshot, propose };
}

test('desktop availability probes the fixed UIA bridge and unsupported systems do not pretend to work', async t => {
  const f = await fixture(t); const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.bridge, 'windows-uia'); assert.equal(status.capabilities.reviewedInput, true); assert.equal(f.calls[0].request.action, 'health');
  const unsupported = await createDesktopService({ platform: 'linux', runner: () => assert.fail('Unsupported platform must not call bridge') }); t.after(() => unsupported.close()); assert.equal((await unsupported.status()).available, false); await assert.rejects(unsupported.execute('desktop_list_apps'), { code: 'desktop_unavailable' });
});

test('installed discovery and window queries return opaque IDs, exclude terminals, and expose only matching context', async t => {
  const f = await fixture(t); const apps = await f.service.execute('desktop_list_apps', { query: 'editor' }); assert.equal(apps.apps.length, 1); assert.notEqual(apps.apps[0].id, 'Installed.SyntheticEditor!App'); assert.equal(apps.apps[0].sourceId, undefined);
  const opened = await f.service.execute('desktop_open_app', { appId: apps.apps[0].id }, { requestId: 'open-once' }); assert.equal(opened.desktopReceipt.status, 'completed'); assert.equal(opened.observedWindows[0].title, WINDOW.title); assert.match(opened.desktopReceipt.summary, /visible matching window/);
  const replay = await f.service.execute('desktop_open_app', { appId: apps.apps[0].id }, { requestId: 'open-once' }); assert.equal(replay.desktopReceipt.id, opened.desktopReceipt.id); assert.equal(f.calls.filter(call => call.request.action === 'openApp').length, 1);
  await assert.rejects(f.service.execute('desktop_open_url', { url: 'https://example.com' }, { requestId: 'open-once' }), { code: 'desktop_request_conflict' });
  const windows = await f.service.execute('desktop_list_windows', { query: 'synthetic' }); assert.equal(windows.windows.length, 1); assert.equal(windows.windows[0].handle, undefined); assert.equal(windows.windows[0].startTime, undefined); assert.equal(f.calls.find(call => call.request.action === 'listWindows').request.query, 'synthetic');
  const focus = await f.service.execute('desktop_focus_window', { windowId: windows.windows[0].id }); assert.equal(focus.desktopReceipt.status, 'completed'); assert.deepEqual(f.calls.at(-1).request.window, WINDOW);
});

test('snapshots exclude password/credential values and hide native element identifiers', async t => {
  const f = await fixture(t, { runner: async request => request.action === 'listWindows' ? { windows: [WINDOW] } : { elements: [ELEMENT, { ...ELEMENT, name: 'Password', isPassword: true, value: 'synthetic-password-secret' }, { ...ELEMENT, name: 'API key', value: 'synthetic-api-secret' }, { ...ELEMENT, name: 'Long normal value', value: 'x'.repeat(800) }] } });
  const snapshot = await f.snapshot(); assert.equal(snapshot.elements.length, 2); assert.equal(snapshot.elements[0].runtimeId, undefined); assert.equal(snapshot.elements[0].fingerprint, undefined); assert.equal(snapshot.elements[1].value.length, 500); assert.ok(!JSON.stringify(snapshot).includes('synthetic-password-secret')); assert.ok(!JSON.stringify(snapshot).includes('synthetic-api-secret'));
});

test('generic input is a concrete pending preview until one browser approval executes exactly once', async t => {
  const f = await fixture(t); const literal = 'Literal + ^ % {ENTER} [text]\nsecond line'; const action = await f.propose('setText', { text: literal });
  assert.equal(action.status, 'pending'); assert.equal(action.preview.text, literal); assert.equal(action.target.pid, WINDOW.pid); assert.equal(action.requiresApproval, true); assert.equal(action.token, undefined); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 0);
  await assert.rejects(f.service.execute('desktop_approve_action', { id: action.id }), { code: 'invalid_desktop_tool' });
  const [first, second] = await Promise.all([f.service.approve(action.id), f.service.approve(action.id)]); assert.equal(first.status, 'completed'); assert.ok(['executing', 'completed'].includes(second.status)); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 1);
  const performed = f.calls.find(call => call.request.action === 'performAction').request; assert.deepEqual(performed.window, WINDOW); assert.deepEqual(performed.element, { runtimeId: ELEMENT.runtimeId, fingerprint: ELEMENT.fingerprint }); assert.equal(performed.input.text, literal);
  assert.equal((await f.service.approve(action.id)).status, 'completed'); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 1);
});

test('snapshot and approval expiry never silently retarget or execute stale elements', async t => {
  let clock = 100000; const f = await fixture(t, { now: () => clock, snapshotMs: 1000, approvalMs: 500 });
  const snapshot = await f.snapshot(); const action = (await f.service.execute('desktop_propose_action', { snapshotId: snapshot.id, elementId: snapshot.elements[0].id, action: 'click' })).desktopAction;
  clock += 501; assert.equal((await f.service.approve(action.id)).status, 'expired'); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 0);
  clock += 500; await assert.rejects(f.service.execute('desktop_propose_action', { snapshotId: snapshot.id, elementId: snapshot.elements[0].id, action: 'click' }), { code: 'stale_snapshot' });
});

test('Windows stale-target errors remain failures and post-input uncertainty is not reported as safe nonexecution', async t => {
  let failureCode = 'stale_element';
  const f = await fixture(t, { runner: async request => { if (request.action === 'listWindows') return { windows: [WINDOW] }; if (request.action === 'readWindow') return { elements: [ELEMENT] }; if (request.action === 'performAction') throw Object.assign(new Error('Synthetic target changed.'), { code: failureCode, statusCode: 409 }); } });
  const first = await f.propose(); const stale = await f.service.approve(first.id); assert.equal(stale.status, 'failed'); assert.equal(stale.outcomeUnknown, false); assert.equal(stale.receipt, undefined);
  failureCode = 'input_outcome_uncertain'; const second = await f.propose('pressKey', { key: 'Enter' }); const uncertain = await f.service.approve(second.id); assert.equal(uncertain.status, 'failed'); assert.equal(uncertain.outcomeUnknown, true);
});

test('raw commands, untrusted IDs, unsafe URLs and nonwhitelisted key strings are rejected before native effects', async t => {
  const f = await fixture(t); for (const url of ['file:///C:/private.txt', 'javascript:alert(1)', 'shell:AppsFolder', 'https://user:password@example.com']) await assert.rejects(f.service.execute('desktop_open_url', { url }), { code: 'invalid_desktop_url' });
  await assert.rejects(f.service.execute('desktop_open_app', { appId: 'C:/Windows/System32/cmd.exe' }), { code: 'stale_app' });
  const snapshot = await f.snapshot(), base = { snapshotId: snapshot.id, elementId: snapshot.elements[0].id };
  for (const fields of [{ action: 'pressKey', key: '{ENTER}' }, { action: 'pressKey', key: 'Ctrl+Shift+P' }, { action: 'setText', text: 'file:///C:/private.txt' }, { action: 'click', text: 'Unexpected text' }, { action: 'click', command: 'anything' }]) await assert.rejects(f.service.execute('desktop_propose_action', { ...base, ...fields }));
  assert.ok(DESKTOP_KEYS.includes('Enter')); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 0);
});

test('renamed Companion native windows and browser approval pages cannot be used for model self-approval', async t => {
  let native = { ...WINDOW, appName: 'electron', title: 'Renamed native window' }, protectedInput = false;
  const f = await fixture(t, { runner: async request => request.action === 'listWindows' ? { windows: [native] } : { elements: [ELEMENT], protectedInput } });
  let snapshot = await f.snapshot(''); await assert.rejects(f.service.execute('desktop_propose_action', { snapshotId: snapshot.id, elementId: snapshot.elements[0].id, action: 'click' }), { code: 'protected_target' });
  native = { ...WINDOW, appName: 'chrome', title: 'Synthetic browser' }; protectedInput = true; snapshot = await f.snapshot(); assert.equal(snapshot.protectedInput, true); await assert.rejects(f.service.execute('desktop_propose_action', { snapshotId: snapshot.id, elementId: snapshot.elements[0].id, action: 'click' }), { code: 'protected_target' });
});

test('a legitimate Notepad document containing Companion in its title can prepare ordinary reviewed input', async t => {
  const native = { ...WINDOW, appName: 'Notepad', title: '*Companion desktop input test. - Notepad' };
  const f = await fixture(t, { runner: async request => request.action === 'listWindows' ? { windows: [native] } : { elements: [{ ...ELEMENT, name: 'Text editor' }], protectedInput: false } });
  const snapshot = await f.snapshot('Notepad'); assert.equal(snapshot.protectedInput, false);
  const result = await f.service.execute('desktop_propose_action', { snapshotId: snapshot.id, elementId: snapshot.elements[0].id, action: 'setText', text: 'An ordinary document update.' });
  assert.equal(result.desktopAction.status, 'pending'); assert.equal(result.desktopAction.target.title, native.title); assert.equal(result.desktopAction.preview.text, 'An ordinary document update.'); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 0);
});

test('Stop between approval persistence and dispatch cancels the review without executing native input', async t => {
  const f = await fixture(t), action = await f.propose();
  const approved = f.service.approve(action.id); const stopped = f.service.cancelAll();
  const result = await approved; await stopped; assert.equal(result.status, 'cancelled'); assert.equal(result.outcomeUnknown, false); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 0);
});

test('Stop aborts active native work, suppresses late success and cancels remaining pending approvals', async t => {
  let started, finish, nativeSignal; const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { runner: async (request, { signal }) => { if (request.action === 'listWindows') return { windows: [WINDOW] }; if (request.action === 'readWindow') return { elements: [ELEMENT] }; if (request.action === 'performAction') { nativeSignal = signal; started(); return new Promise(resolve => { finish = resolve; }); } } });
  const first = await f.propose(), second = await f.propose(); const approved = f.service.approve(first.id); await began; await f.service.cancelAll(); const result = await approved; assert.equal(nativeSignal.aborted, true); assert.equal(result.status, 'cancelled'); assert.equal(result.outcomeUnknown, true); assert.equal((await f.service.listActions()).find(action => action.id === second.id).status, 'cancelled'); finish({ performed: true });
  assert.equal((await f.service.approve(first.id)).status, 'cancelled'); assert.equal(f.calls.filter(call => call.request.action === 'performAction').length, 1);
});

test('private review history survives restart and never resumes ambiguous or unapproved input', async t => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'companion-desktop-test-')); let service;
  t.after(async () => { await service?.close(); assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(dataDirectory, { recursive: true, force: true }); });
  const f = await fixture(t, { dataDirectory }); const action = await f.propose(); await f.service.close(); const file = path.join(dataDirectory, 'desktop-actions.json'); const saved = JSON.parse(await readFile(file, 'utf8')); saved.actions[0].status = 'executing'; await writeFile(file, JSON.stringify(saved));
  service = await createDesktopService({ dataDirectory, platform: 'win32', runner: () => assert.fail('Restarted review must not execute') }); const restored = (await service.listActions())[0]; assert.equal(restored.id, action.id); assert.equal(restored.status, 'cancelled'); assert.equal(restored.outcomeUnknown, true); assert.equal((await service.approve(action.id)).status, 'cancelled');
});

test('fixed PowerShell bridge receives all data through stdin, scrubs secrets and kills only its child on cancellation', async () => {
  const calls = []; let child, sendResult = true;
  const spawnImpl = (command, args, options) => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new Writable({ write(chunk, _, callback) { child.input = (child.input || '') + chunk.toString(); callback(); } }); child.kill = () => { child.killed = true; child.emit('close', 1); };
    calls.push({ command, args, options }); child.stdin.on('finish', () => { if (sendResult) { child.stdout.write('{"ok":true,"result":{"available":true}}'); child.emit('close', 0); } }); return child;
  };
  const run = await createDesktopBridgeRunner({ spawnImpl }); const result = await run({ action: 'health', data: '`PowerShell metacharacters`; $value' }); assert.equal(result.available, true); assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true); assert.ok(calls[0].args.includes('-File')); assert.ok(!calls[0].args.includes('-Command')); assert.ok(!calls[0].args.some(arg => arg.includes('metacharacters'))); assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined); assert.equal(calls[0].options.env.NODE_OPTIONS, undefined); assert.match(child.input, /metacharacters/);
  sendResult = false; const controller = new AbortController(); const pending = run({ action: 'health' }, { signal: controller.signal }); controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(child.killed, true);
});
