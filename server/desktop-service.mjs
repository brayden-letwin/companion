import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath, lstat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const stopped = () => Object.assign(fail('request_cancelled', 'Desktop work stopped. Input already accepted by an application may remain.', 499), { name: 'AbortError' });
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const forbiddenApp = /(?:powershell|windows.?terminal|command.?prompt|\bcmd\b|\bpwsh\b|\bconhost\b|\bopenconsole\b|\bwsl\b|\bbash\b|\bmintty\b|\bwezterm\b|\balacritty\b)/i;
const sensitive = /(?:password|passcode|one.?time.?code|verification.?code|api.?key|access.?token|credential|terminal|developer.?tools|devtools)/i;
export const DESKTOP_KEYS = Object.freeze(['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space', 'Ctrl+A']);
const str = (description, maxLength = 200) => ({ type: 'string', description, maxLength });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const DESKTOP_TOOL_DEFINITIONS = [
  { name: 'desktop_list_apps', description: 'Discover installed Start-menu apps. Returned opaque IDs can be used to open them. Terminal applications are excluded.', parameters: schema({ query: str('Optional app-name filter.', 100) }) },
  { name: 'desktop_list_windows', description: 'List visible eligible windows with opaque IDs and process identities. Use a query to limit titles and context to the app the user requested.', parameters: schema({ query: str('Optional title or app-name filter.', 100) }) },
  { name: 'desktop_open_app', description: 'Request launch of an app returned by desktop_list_apps. No command, path or launch arguments are accepted. List windows to check what opened.', parameters: schema({ appId: str('A discovered opaque app ID.') }, ['appId']) },
  { name: 'desktop_focus_window', description: 'Focus a known eligible window without silently targeting whichever window is foreground.', parameters: schema({ windowId: str('Opaque ID from desktop_list_windows.') }, ['windowId']) },
  { name: 'desktop_open_url', description: 'Ask Windows to open an explicit HTTP or HTTPS URL in the default browser. This does not prove the page loaded.', parameters: schema({ url: str('HTTP or HTTPS URL, without embedded credentials.', 4000) }, ['url']) },
  { name: 'desktop_read_window', description: 'Read a bounded accessibility snapshot of one explicitly chosen window. Password and obvious credential/terminal controls are excluded. Only this requested snapshot becomes model context.', parameters: schema({ windowId: str('Opaque window ID.') }, ['windowId']) },
  { name: 'desktop_propose_action', description: 'Prepare a target-bound click, text replacement or key press for human review. This does not execute the input. The user must approve its exact preview in Companion; never claim a pending action completed.', parameters: schema({ snapshotId: str('Fresh snapshot ID.'), elementId: str('Opaque accessible element ID from that snapshot.'), action: { type: 'string', enum: ['click', 'setText', 'pressKey'] }, text: str('Exact replacement text, used only for setText.', 4000), key: { type: 'string', enum: DESKTOP_KEYS } }, ['snapshotId', 'elementId', 'action']) },
];
const byName = new Map(DESKTOP_TOOL_DEFINITIONS.map(definition => [definition.name, definition]));
function fields(value, allowed) { if (!obj(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_desktop_input', 'The desktop request contains unsupported fields.'); }
function text(value, max, label, empty = false) { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw fail('invalid_desktop_input', `Use valid ${label}.`); return value; }
function identity(value) {
  if (!obj(value) || typeof value.handle !== 'string' || !/^\d{1,20}$/.test(value.handle) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.startTime !== 'string' || !/^\d{1,24}$/.test(value.startTime)) throw fail('invalid_desktop_response', 'Windows returned an invalid window identity.', 502);
  return { handle: value.handle, pid: value.pid, startTime: value.startTime, title: text(value.title, 600, 'window title', true), appName: text(value.appName, 200, 'app name'), className: text(value.className, 200, 'window class', true) };
}
function urlValue(value) { let url; try { url = new URL(text(value, 4000, 'URL')); } catch { throw fail('invalid_desktop_url', 'Choose an HTTP or HTTPS URL.'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('invalid_desktop_url', 'Use HTTP or HTTPS without embedded credentials.'); return url.href; }
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => { const abort = () => reject(stopped()); signal.addEventListener('abort', abort, { once: true }); Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); });
}

/** Only this fixed script can be spawned; every action argument travels as stdin JSON. */
export async function createDesktopBridgeRunner({ root = ROOT, spawnImpl = spawn, timeoutMs = 12000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  const source = await realpath(root), bridge = path.join(source, 'scripts', 'desktop-bridge.ps1');
  if (!(await lstat(bridge)).isFile() || (await lstat(bridge)).isSymbolicLink() || !(await realpath(bridge)).startsWith(source + path.sep)) throw fail('desktop_bridge_unavailable', 'The fixed Windows desktop bridge is unavailable.', 503);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return (request, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    let child, finished = false, output = '', bytes = 0, diagnosticBytes = 0; const decoder = new StringDecoder('utf8');
    const done = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
    const cancel = () => { done(stopped()); child?.kill(); };
    const timer = setTimeout(() => { done(fail('desktop_timeout', 'Windows did not finish in time. Inspect the target before retrying input.', 504)); child?.kill(); }, timeoutMs); timer.unref?.();
    const env = {}; for (const key of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    try { child = spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', bridge], { windowsHide: true, shell: false, cwd: source, env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { done(fail('desktop_bridge_unavailable', 'The Windows desktop bridge could not start.', 503)); return; }
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) { cancel(); return; }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutputBytes) { child.kill(); done(fail('desktop_output_limit', 'The Windows accessibility response exceeded its limit.', 502)); } else output += decoder.write(chunk); });
    child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 65536) { child.kill(); done(fail('desktop_bridge_failed', 'The Windows bridge returned too much diagnostic data.', 502)); } });
    child.on('error', () => done(fail('desktop_bridge_unavailable', 'The Windows desktop bridge could not start.', 503))); child.stdin.on('error', () => done(fail('desktop_bridge_failed', 'Windows could not receive the desktop request.', 502)));
    child.on('close', code => {
      if (finished) return; output += decoder.end(); let value;
      try { value = JSON.parse(output); if (!obj(value) || typeof value.ok !== 'boolean') throw new Error(); } catch { done(fail('desktop_bridge_failed', 'Windows returned an unreadable desktop result.', 502)); return; }
      if (!value.ok || code !== 0) { const known = ['stale_window', 'stale_element', 'unsupported_element', 'protected_target', 'app_unavailable', 'focus_denied', 'input_outcome_uncertain', 'invalid_input', 'bridge_unavailable']; const errorCode = known.includes(value.error?.code) ? value.error.code : 'desktop_bridge_failed'; done(fail(errorCode, typeof value.error?.message === 'string' ? value.error.message.slice(0, 300) : 'Windows could not complete this desktop action.', errorCode.startsWith('stale') ? 409 : 400)); return; }
      done(null, value.result);
    });
    const input = JSON.stringify(request); if (Buffer.byteLength(input) > 64000) { child.kill(); done(fail('invalid_desktop_input', 'The desktop request is too large.')); return; } child.stdin.end(input);
  });
}

/** Snapshot-bound Windows access. Approval methods are intentionally absent from model tools. */
export async function createDesktopService({ root = ROOT, dataDirectory, runner, now = Date.now, platform = process.platform, snapshotMs = 60000, approvalMs = 45000 } = {}) {
  if (!Number.isInteger(snapshotMs) || snapshotMs < 100 || snapshotMs > 120000 || !Number.isInteger(approvalMs) || approvalMs < 100 || approvalMs > snapshotMs) throw new TypeError('Use bounded desktop snapshot and approval lifetimes.');
  const runBridge = runner || (platform === 'win32' ? await createDesktopBridgeRunner({ root }) : null);
  const apps = new Map(), windows = new Map(), snapshots = new Map(), actions = new Map(), receipts = new Map(), active = new Set();
  let closed = false, effectBusy = false, health = null, healthPending = null, writes = Promise.resolve(), stopGeneration = 0;
  const companionPort = Number(process.env.COMPANION_SHARED_PORT || 4174);
  let metadataPath = null;
  if (dataDirectory) {
    const directory = await realpath(dataDirectory).catch(async error => { if (error.code !== 'ENOENT') throw error; await mkdir(dataDirectory, { recursive: true, mode: 0o700 }); return realpath(dataDirectory); });
    const source = await realpath(root); if (!path.isAbsolute(dataDirectory) || directory === source || directory.startsWith(source + path.sep)) throw new TypeError('Keep desktop review history in a private directory outside source.');
    metadataPath = path.join(directory, 'desktop-actions.json');
    try {
      const bytes = await readFile(metadataPath); if (bytes.length > 2 * 1024 * 1024) throw new Error(); const saved = JSON.parse(bytes);
      if (saved.version !== 1 || !Array.isArray(saved.actions) || saved.actions.length > 200) throw new Error();
      for (const action of saved.actions) if (obj(action) && typeof action.id === 'string' && /^[a-f\d-]{36}$/i.test(action.id)) { if (['pending', 'executing'].includes(action.status)) { action.outcomeUnknown = action.status === 'executing'; action.status = 'cancelled'; action.error = 'Companion restarted. Read the target again before requesting more input.'; } actions.set(action.id, { public: action, token: null }); }
    } catch (error) { if (error.code !== 'ENOENT') throw fail('desktop_history_unavailable', 'Desktop action history could not be loaded safely.', 503); }
  }
  async function persist() {
    let body = JSON.stringify({ version: 1, actions: [...actions.values()].map(record => record.public) });
    while (Buffer.byteLength(body) > 2 * 1024 * 1024) {
      const oldest = [...actions].find(([, record]) => !['pending', 'executing'].includes(record.public.status));
      if (!oldest) throw fail('desktop_history_limit', 'Pending desktop previews exceed their retained history limit.', 413);
      actions.delete(oldest[0]); body = JSON.stringify({ version: 1, actions: [...actions.values()].map(record => record.public) });
    }
    if (!metadataPath) return;
    const work = writes.then(async () => { const temporary = path.join(path.dirname(metadataPath), `.desktop-actions-${randomUUID()}.tmp`); try { await writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await rename(temporary, metadataPath); } finally { await rm(temporary, { force: true }); } }); writes = work.catch(() => {}); await work;
  }
  function expire() { for (const record of actions.values()) if (record.public.status === 'pending' && (record.public.expiresAtMs <= now() || !snapshots.has(record.snapshotId))) { record.public.status = 'expired'; record.public.error = 'The target preview expired. Read the window again.'; record.token = null; } for (const cache of [snapshots, apps, windows]) for (const [id, saved] of cache) if (saved.expiresAt <= now()) cache.delete(id); }
  function requireReady() { if (closed) throw fail('desktop_closed', 'Desktop control is shutting down.', 503); if (platform !== 'win32' || !runBridge) throw fail('desktop_unavailable', 'Desktop control currently requires Windows.', 503); }
  async function run(request, { signal, effect = false } = {}) {
    requireReady(); if (signal?.aborted) throw stopped(); if (active.size >= 2 || effect && effectBusy) throw fail('desktop_busy', 'Desktop control is busy. Stop or finish the current action first.', 429);
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort(); active.add(controller); if (effect) effectBusy = true;
    try { const result = await abortable(runBridge(request, { signal: controller.signal }), controller.signal); if (controller.signal.aborted) throw stopped(); return result; }
    finally { signal?.removeEventListener('abort', abort); active.delete(controller); if (effect) effectBusy = false; }
  }
  function targetWindow(id) { const value = windows.get(text(id, 100, 'window ID')); if (!value || value.expiresAt <= now()) throw fail('stale_window', 'List windows again to choose a fresh target.', 409); return value; }
  function publicWindow(saved) { return { id: saved.id, title: saved.identity.title, appName: saved.identity.appName, pid: saved.identity.pid }; }
  function registerWindow(native) { let saved = [...windows.values()].find(saved => digest(saved.identity) === digest(native)); if (!saved) saved = { id: randomUUID(), identity: native }; windows.delete(saved.id); windows.set(saved.id, saved); while (windows.size > 500) windows.delete(windows.keys().next().value); saved.expiresAt = now() + 120000; return saved; }
  function receipt(action, summary, target) { return { desktopReceipt: { id: randomUUID(), status: 'completed', action, summary, target, completedAt: new Date(now()).toISOString() } }; }
  async function executeOnce(name, args, context) {
    expire();
    const definition = byName.get(name); if (!definition) throw fail('invalid_desktop_tool', 'That desktop tool is not available to the model.'); fields(args, Object.keys(definition.parameters.properties)); for (const required of definition.parameters.required) if (!Object.hasOwn(args, required)) throw fail('invalid_desktop_input', `The desktop request needs ${required}.`);
    if (name === 'desktop_list_apps') {
      const query = args.query === undefined ? '' : text(args.query, 100, 'app query', true); const result = await run({ action: 'listApps', query }, context); if (!Array.isArray(result?.apps) || result.apps.length > 500) throw fail('invalid_desktop_response', 'Windows returned an invalid app list.', 502);
      const selected = []; for (const item of result.apps) { if (!obj(item) || typeof item.sourceId !== 'string' || item.sourceId.length > 1000 || typeof item.name !== 'string' || item.name.length > 200 || forbiddenApp.test(item.name + ' ' + item.sourceId) || query && !item.name.toLowerCase().includes(query.toLowerCase())) continue; let saved = [...apps.values()].find(saved => saved.sourceId === item.sourceId); if (!saved) saved = { id: randomUUID(), sourceId: item.sourceId, name: item.name }; apps.delete(saved.id); apps.set(saved.id, saved); while (apps.size > 500) apps.delete(apps.keys().next().value); saved.name = item.name; saved.expiresAt = now() + 300000; selected.push({ id: saved.id, name: saved.name }); } return { apps: selected, truncated: result.truncated === true };
    }
    if (name === 'desktop_list_windows') {
      const query = args.query === undefined ? '' : text(args.query, 100, 'window query', true); const result = await run({ action: 'listWindows', query }, context); if (!Array.isArray(result?.windows) || result.windows.length > 200) throw fail('invalid_desktop_response', 'Windows returned an invalid window list.', 502);
      const selected = []; for (const item of result.windows) { const native = identity(item); if (forbiddenApp.test(native.appName + ' ' + native.title) || query && !(native.title + ' ' + native.appName).toLowerCase().includes(query.toLowerCase())) continue; selected.push(publicWindow(registerWindow(native))); } return { windows: selected, truncated: result.truncated === true };
    }
    if (name === 'desktop_open_app') { const saved = apps.get(text(args.appId, 100, 'app ID')); if (!saved || saved.expiresAt <= now()) throw fail('stale_app', 'Search installed apps again before opening one.', 409); const result = await run({ action: 'openApp', sourceId: saved.sourceId, name: saved.name }, { ...context, effect: true }); if (result?.accepted !== true) throw fail('desktop_bridge_failed', 'Windows did not confirm the launch request.', 502); const observed = (Array.isArray(result.windows) ? result.windows.slice(0, 10) : []).map(identity).filter(item => !forbiddenApp.test(item.appName + ' ' + item.title)).map(item => publicWindow(registerWindow(item))); return { ...receipt('openApp', observed.length ? `Requested ${saved.name}; Windows reports a visible matching window.` : `Requested opening ${saved.name}; no matching window was observed yet.`, { appId: saved.id, name: saved.name }), observedWindows: observed, launchAccepted: true }; }
    if (name === 'desktop_open_url') { const url = urlValue(args.url); const result = await run({ action: 'openUrl', url }, { ...context, effect: true }); if (result?.accepted !== true) throw fail('desktop_bridge_failed', 'Windows did not accept the URL request.', 502); return receipt('openUrl', 'Requested opening this URL in the default browser.', { url }); }
    const saved = name === 'desktop_propose_action' ? null : targetWindow(args.windowId);
    if (name === 'desktop_focus_window') { const result = await run({ action: 'focusWindow', window: saved.identity }, { ...context, effect: true }); if (result?.focused !== true) throw fail('focus_denied', 'Windows did not confirm focus on the requested window.', 409); return receipt('focusWindow', `Focused ${saved.identity.title || saved.identity.appName}.`, publicWindow(saved)); }
    if (name === 'desktop_read_window') {
      const result = await run({ action: 'readWindow', window: saved.identity, companionPort }, context); if (!Array.isArray(result?.elements) || result.elements.length > 200) throw fail('invalid_desktop_response', 'Windows returned an invalid accessibility snapshot.', 502);
      const snapshot = { id: randomUUID(), window: saved, createdAt: now(), expiresAt: now() + snapshotMs, protectedInput: result.protectedInput === true, elements: new Map() };
      for (const item of result.elements) { if (!obj(item) || item.isPassword === true || sensitive.test(`${item.name || ''} ${item.automationId || ''} ${item.className || ''}`)) continue; if (typeof item.runtimeId !== 'string' || !/^-?\d+(?:\.-?\d+){0,79}$/.test(item.runtimeId) || typeof item.fingerprint !== 'string' || !/^[a-f\d]{64}$/i.test(item.fingerprint)) continue; const allowed = (item.actions || []).filter(action => ['click', 'setText', 'pressKey'].includes(action)); const id = randomUUID(); snapshot.elements.set(id, { native: { runtimeId: item.runtimeId, fingerprint: item.fingerprint }, public: { id, name: text(item.name || '', 500, 'element name', true), controlType: text(item.controlType || '', 80, 'control type', true), enabled: item.enabled === true, actions: allowed, ...(typeof item.value === 'string' ? { value: item.value.slice(0, 500) } : {}) } }); }
      if (snapshots.size >= 30) snapshots.delete(snapshots.keys().next().value); snapshots.set(snapshot.id, snapshot); return { snapshot: { id: snapshot.id, createdAt: new Date(snapshot.createdAt).toISOString(), expiresAt: new Date(snapshot.expiresAt).toISOString(), window: publicWindow(saved), elements: [...snapshot.elements.values()].map(item => item.public), protectedInput: snapshot.protectedInput, truncated: result.truncated === true } };
    }
    expire(); const snapshot = snapshots.get(text(args.snapshotId, 100, 'snapshot ID')); if (!snapshot || snapshot.expiresAt <= now()) throw fail('stale_snapshot', 'Read the target window again before proposing input.', 409);
    const element = snapshot.elements.get(text(args.elementId, 100, 'element ID')); if (!element || !element.public.enabled || !element.public.actions.includes(args.action)) throw fail('unsupported_element', 'Choose an enabled element that supports the requested input.');
    if (snapshot.protectedInput || /^(?:electron|companion)$/i.test(snapshot.window.identity.appName) || sensitive.test(element.public.name) || forbiddenApp.test(snapshot.window.identity.appName)) throw fail('protected_target', 'Companion approval controls, credentials and terminals cannot be targeted by desktop input.');
    if (!['click', 'setText', 'pressKey'].includes(args.action)) throw fail('invalid_desktop_input', 'Choose click, setText or pressKey.');
    const preview = { action: args.action };
    if (args.action === 'setText') { preview.text = text(args.text, 4000, 'replacement text', true); if (args.key !== undefined || /^\s*(?:file|javascript|data|shell|powershell):/i.test(preview.text)) throw fail('protected_target', 'This text/protocol is not available as generic desktop input.'); }
    else if (args.action === 'pressKey') { if (!DESKTOP_KEYS.includes(args.key) || args.text !== undefined) throw fail('invalid_desktop_input', 'Choose a supported fixed key name.'); preview.key = args.key; }
    else if (args.text !== undefined || args.key !== undefined) throw fail('invalid_desktop_input', 'A click does not accept text or key fields.');
    while (actions.size >= 200) { const oldest = [...actions].find(([, record]) => !['pending', 'executing'].includes(record.public.status)); if (!oldest) break; actions.delete(oldest[0]); }
    if (actions.size >= 200 || [...actions.values()].filter(record => record.public.status === 'pending').length >= 10) throw fail('desktop_action_limit', 'Desktop review history or pending-action limits have been reached.', 429);
    const target = { windowId: snapshot.window.id, title: snapshot.window.identity.title, appName: snapshot.window.identity.appName, pid: snapshot.window.identity.pid, elementId: element.public.id, name: element.public.name, controlType: element.public.controlType };
    const id = randomUUID(), expiresAtMs = Math.min(snapshot.expiresAt, now() + approvalMs); const record = { token: randomBytes(32).toString('base64url'), snapshotId: snapshot.id, window: snapshot.window.identity, element: element.native, public: { id, status: 'pending', summary: args.action === 'setText' ? `Replace text in ${target.name || target.controlType}.` : args.action === 'pressKey' ? `Press ${preview.key} in ${target.name || target.controlType}.` : `Click ${target.name || target.controlType}.`, createdAt: new Date(now()).toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs, target, preview, requiresApproval: true, warning: 'This input may submit, send, save or otherwise affect another application. Review the exact target and input.' } }; actions.set(id, record); await persist(); return { desktopAction: clone(record.public) };
  }
  return {
    definitions: DESKTOP_TOOL_DEFINITIONS,
    async status() { expire(); if (platform === 'win32' && !closed && (!health || health.until <= now())) { if (!healthPending) healthPending = run({ action: 'health' }).then(result => { health = { available: result?.available === true, reason: result?.available === true ? null : 'Windows UI Automation is unavailable.', until: now() + 30000 }; }).catch(() => { health = { available: false, reason: 'The Windows desktop bridge is unavailable or busy.', until: now() + 3000 }; }).finally(() => { healthPending = null; }); await healthPending; } const available = !closed && platform === 'win32' && health?.available === true; return { available, platform, bridge: 'windows-uia', reason: available ? null : closed ? 'Desktop control is closed.' : health?.reason || 'Desktop control currently requires Windows.', capabilities: { installedApps: available, windows: available, read: available, open: available, reviewedInput: available }, busy: active.size > 0, pendingCount: [...actions.values()].filter(record => record.public.status === 'pending').length, activeCount: active.size }; },
    async execute(name, args = {}, context = {}) { requireReady(); const mutating = !['desktop_list_apps', 'desktop_list_windows', 'desktop_read_window'].includes(name); const key = mutating && context.requestId ? text(context.requestId, 500, 'request ID') : null; if (!key) return executeOnce(name, args, context); const hash = digest({ name, args }); const previous = receipts.get(key); if (previous) { if (previous.hash !== hash) throw fail('desktop_request_conflict', 'That desktop request ID was already used for different input.', 409); return clone(await previous.promise); } if (receipts.size >= 1000) throw fail('desktop_receipt_limit', 'The desktop request receipt limit has been reached.', 429); const pending = executeOnce(name, args, context); receipts.set(key, { hash, promise: pending }); return clone(await pending); },
    async listActions() { expire(); return [...actions.values()].map(record => clone(record.public)).reverse(); },
    async approve(id, { signal } = {}) {
      requireReady(); expire(); const record = actions.get(id); if (!record) throw fail('desktop_action_not_found', 'That desktop action was not found.', 404); if (record.public.status !== 'pending') return clone(record.public);
      if (!record.token) throw fail('desktop_approval_used', 'That one-time approval has already been consumed.', 409);
      const generation = stopGeneration; let dispatched = false; record.token = null; record.public.status = 'executing'; await persist();
      try { if (generation !== stopGeneration || closed || signal?.aborted) throw stopped(); dispatched = true; const result = await run({ action: 'performAction', window: record.window, element: record.element, input: record.public.preview, companionPort }, { signal, effect: true }); if (result?.performed !== true) throw fail('desktop_bridge_failed', 'Windows did not confirm the requested input.', 502); record.public.status = 'completed'; record.public.receipt = { action: record.public.preview.action, target: record.public.target, completedAt: new Date(now()).toISOString(), verification: 'Windows accepted this exact input. Read the target again to check its application-level outcome.' }; }
      catch (error) { record.public.status = error.name === 'AbortError' || error.code === 'request_cancelled' ? 'cancelled' : 'failed'; record.public.error = error.statusCode ? error.message : 'Windows could not complete this input.'; record.public.outcomeUnknown = dispatched && !['stale_window', 'stale_element', 'unsupported_element', 'protected_target', 'focus_denied'].includes(error.code); }
      await persist(); return clone(record.public);
    },
    async cancel(id) { const record = actions.get(id); if (!record) throw fail('desktop_action_not_found', 'That desktop action was not found.', 404); if (record.public.status === 'executing') throw fail('desktop_action_running', 'Use Stop to cancel active desktop input.', 409); if (record.public.status === 'pending') { record.token = null; record.public.status = 'cancelled'; record.public.error = 'Cancelled before approval.'; await persist(); } return clone(record.public); },
    async cancelAll() { stopGeneration += 1; for (const controller of active) controller.abort(); for (const record of actions.values()) if (record.public.status === 'pending') { record.token = null; record.public.status = 'cancelled'; record.public.error = 'Stopped before approval.'; } await persist(); return { stopped: true }; },
    async close() { if (closed) return writes; closed = true; stopGeneration += 1; for (const controller of active) controller.abort(); for (const record of actions.values()) if (record.public.status === 'pending') { record.token = null; record.public.status = 'cancelled'; record.public.error = 'Desktop service closed before approval.'; } await persist(); await writes; },
  };
}
