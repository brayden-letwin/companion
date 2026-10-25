import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createVoiceSession } from '../src/voice-session.mjs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('assistant.html', root), 'utf8');
const source = readFileSync(new URL('src/assistant.mjs', root), 'utf8')
  .replace(/^import \{ createVoiceSession \} from '\.\/voice-session\.mjs';\r?\n/, '')
  .replaceAll('import.meta.url', JSON.stringify('http://127.0.0.1:4174/src/assistant.mjs'));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const copy = value => JSON.parse(JSON.stringify(value));
const blank = (id, title = 'Conversation') => ({ id, title, revision: 0, createdAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:00Z', activeRequestId: null, turns: [] });

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.open = false; this.text = ''; this.scrollTop = 0; this.clientHeight = 300; this.classList = { toggle() {}, add() {}, remove() {} }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent || '').join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = [...children]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  async dispatch(type, event = {}) { const pending = []; for (const callback of this.listeners[type] || []) pending.push(callback(event)); await Promise.all(pending); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  scrollIntoView() {}
  remove() { this.removed = true; }
  get childNodes() { return this.children; }
  get lastElementChild() { return this.children.at(-1); }
  get scrollHeight() { return 600; }
}

async function until(predicate, label = 'UI state') { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail(`${label} did not settle`); }

function createLocks() {
  const held = new Set();
  return { request: async (name, options, callback) => { if (held.has(name)) return callback(null); held.add(name); try { return await callback({ name }); } finally { held.delete(name); } } };
}

async function createUI({ saved = [], selected = null, intercept = null, waitForConversations = true, locks = createLocks(), workspacePreferences = [] } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  nodes.get('provider-type').value = 'openai';
  const records = new Map(saved.map(item => [item.id, structuredClone(item)]));
  const storage = new Map(selected ? [['companion.workspace.ui.v1.conversationId', JSON.stringify(selected)]] : []);
  const requests = [], intervals = [], timers = new Set();
  const workspace = { revision: 0, tasks: [], notes: [], workflows: [], preferences: structuredClone(workspacePreferences), focus: null, activity: [] };
  let custom = intercept, permission = null, stoppedTracks = 0;
  const provider = { id: 'codex', type: 'codex', label: 'GPT', model: '', ready: true };
  const dialogs = [...html.matchAll(/<dialog\b[^>]*\bid="([^"]+)"/g)].map(match => nodes.get(match[1]));
  const document = { body: new Element(), hidden: false, getElementById: id => { assert.ok(nodes.has(id), `Unknown DOM id ${id}`); return nodes.get(id); }, createElement: tag => new Element(tag), querySelectorAll: selector => selector === 'dialog' ? dialogs : [], querySelector: selector => selector === 'dialog[open]' ? dialogs.find(dialog => dialog.open) || null : null, addEventListener() {} };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; this.listeners = {}; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.listeners.stop?.(); }
  }
  class AudioContext {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: samples => samples.fill(0) }; }
    async resume() {}
    async close() {}
  }
  async function fetchMock(url, options = {}) {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    if (custom) { const result = await custom(url, options, { records, workspace }); if (result) return result; }
    if (url === '/src/features/manifest.json') return response({}, 404);
    const route = url.replace('/api/assistant/', '');
    if (route === 'session') return response({ csrfToken: 'synthetic-session' });
    if (route === 'providers') return response({ providers: [provider], activeProviderId: provider.id });
    if (route === 'status') return response({ transcriptionReady: true });
    if (route === 'workspace') return response(workspace);
    if (route === 'features') return response({ jobs: [] });
    if (route === 'runtime') return response({ managed: true, restarting: false, workerPid: 100 });
    if (route === 'desktop') return response({ available: true, capabilities: { installedApps: true, windows: true, read: true, open: true, reviewedInput: true }, pendingCount: 0 });
    if (route === 'desktop/actions') return response({ actions: [] });
    if (route === 'cancel') return response({ cancelled: true });
    if (route === 'conversations' && options.method === 'POST') {
      const body = JSON.parse(options.body); if (!records.has(body.id)) records.set(body.id, blank(body.id)); return response(records.get(body.id));
    }
    if (route === 'conversations') return response({ conversations: [...records.values()].map(item => ({ ...item, turns: undefined, turnCount: item.turns.length, lastStatus: item.turns.at(-1)?.status || null })) });
    if (route.startsWith('conversations/')) return records.has(route.slice(14)) ? response(records.get(route.slice(14))) : response({ error: { code: 'not_found', message: 'Conversation missing' } }, 404);
    if (route === 'chat') {
      const body = JSON.parse(options.body), record = records.get(body.conversationId);
      assert.equal(body.expectedRevision, record.revision);
      const reply = { id: body.id, text: 'A saved response.', actions: [], featureJob: null, providerId: body.providerId };
      record.turns.push({ id: body.id, message: body.message, providerId: body.providerId, status: 'completed', startedAt: '2026-10-24T12:00:01Z', finishedAt: '2026-10-24T12:00:02Z', reply }); record.revision += 2;
      return response({ ...reply, conversationId: record.id, conversationRevision: record.revision, workspace });
    }
    throw new Error(`Unexpected request ${route}`);
  }
  const window = { MediaRecorder: Recorder, AudioContext, addEventListener() {} };
  const context = vm.createContext({ createVoiceSession, window, document, navigator: { locks, permissions: { query: async () => ({ state: 'granted' }) }, mediaDevices: { getUserMedia: () => { permission = deferred(); return permission.promise; } } }, MediaRecorder: Recorder, fetch: fetchMock, Headers, AbortController, Blob, URL, URLSearchParams, DOMException, crypto: webcrypto, structuredClone, performance, console, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, location: { search: '', reload() {}, assign() {} }, Event: class {}, setTimeout: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref(); timers.add(timer); return timer; }, clearTimeout, setInterval: callback => { intervals.push(callback); return intervals.length; }, requestAnimationFrame: () => 0, cancelAnimationFrame() {} });
  vm.runInContext(source + '\nglobalThis.ui={ready:()=>checkingService,selectConversation,refreshConversations,refreshConversation,loadEarlierConversation,runCommand,cancelTurn,startRecording,setVoiceVisible,renderSavedConversation,rememberDesktopAction,captureConversationContext,setChatOpen,showDialog,openDesktopReview,addMessage,processVoiceSegment,get:()=>({id:conversationId,detail:conversationDetail,localChatTurn,turnBusy,recording,voiceState:voiceSessionState,chatOpen,currentView,ownsVoice:voiceOwnsCapture,initial:conversationInitialized,listPending:!!conversationListPending,detailPending:!!conversationDetailRequest,desktop:desktopActions})};', context);
  await context.ui.ready();
  if (waitForConversations) await until(() => !context.ui.get().listPending && !context.ui.get().detailPending, 'initial conversation load');
  return { ui: context.ui, nodes, records, storage, requests, document, intervals, setIntercept: value => { custom = value; }, get waitingForMicrophone() { return !!permission; }, grantMicrophone: () => { const pending = permission; permission = null; pending.resolve({ getTracks: () => [{ stop: () => stoppedTracks++ }] }); }, get stoppedTracks() { return stoppedTracks; }, close: () => { context.ui.cancelTurn(false); for (const timer of timers) clearTimeout(timer); } };
}

test('explicit New survives a late initial history response and first send creates exactly one saved conversation', async () => {
  const listing = deferred();
  const app = await createUI({ saved: [blank(A, 'Earlier')], waitForConversations: false, intercept: (url, options) => url.endsWith('/conversations') && !options.method ? listing.promise : null });
  try {
    await app.ui.selectConversation(null); listing.resolve(response({ conversations: [{ ...blank(A, 'Earlier'), turnCount: 0 }] }));
    await until(() => !app.ui.get().listPending);
    assert.equal(app.ui.get().id, null);
    app.setIntercept(null); app.nodes.get('question').value = 'Remember this request.';
    await app.ui.runCommand('Remember this request.');
    const posts = app.requests.filter(item => item.url.endsWith('/conversations') && item.method === 'POST');
    assert.equal(posts.length, 1);
    const chats = app.requests.filter(item => item.url.endsWith('/chat'));
    assert.equal(chats.length, 1); const body = JSON.parse(chats[0].body);
    assert.equal(body.conversationId, app.ui.get().id); assert.equal(body.expectedRevision, 0); assert.equal('history' in body, false);
    assert.equal(app.ui.get().detail.turns.length, 1); assert.equal(app.nodes.get('question').value, '');
    assert.equal(JSON.parse(app.storage.get('companion.workspace.ui.v1.conversationId')), body.conversationId);
    assert.ok([...app.storage.values()].every(value => !value.includes('Remember this request.')));
  } finally { app.close(); }
});

test('drafts stay with their conversation and a late old detail cannot replace the selected transcript', async () => {
  const a = blank(A, 'First'), b = blank(B, 'Second');
  const app = await createUI({ saved: [a, b], selected: A });
  try {
    app.nodes.get('question').value = 'Draft A'; await app.nodes.get('question').dispatch('input');
    await app.ui.selectConversation(B); app.nodes.get('question').value = 'Draft B'; await app.nodes.get('question').dispatch('input');
    await app.ui.selectConversation(A); assert.equal(app.nodes.get('question').value, 'Draft A');
    const late = deferred(); app.setIntercept(url => url.endsWith('/conversations/' + A) ? late.promise : null);
    const oldFetch = app.ui.refreshConversation(); await app.ui.selectConversation(B);
    late.resolve(response({ ...a, revision: 7, turns: [{ id: 'old', status: 'completed', message: 'Old transcript', reply: { text: 'Late old response', actions: [] } }] })); await oldFetch;
    assert.equal(app.ui.get().id, B); assert.equal(app.nodes.get('question').value, 'Draft B');
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Late old response/);
  } finally { app.close(); }
});

test('a lost response reconciles an accepted turn without resending and a reload restores it', async () => {
  const app = await createUI({ saved: [blank(A)], selected: A });
  try {
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null;
      const body = JSON.parse(options.body), record = records.get(A);
      record.turns.push({ id: body.id, message: body.message, providerId: body.providerId, status: 'running', startedAt: '2026-10-24T12:00:01Z' }); record.activeRequestId = body.id; record.revision++;
      throw new Error('Synthetic lost response');
    });
    app.nodes.get('question').value = 'A durable request'; await app.ui.runCommand('A durable request');
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
    assert.equal(app.ui.get().detail.turns[0].status, 'running'); assert.match(app.nodes.get('messages').textContent, /saved and running/);
    const record = app.records.get(A); record.turns[0].status = 'interrupted'; record.turns[0].error = { code: 'request_interrupted', message: 'Interrupted on restart', actions: [] }; record.activeRequestId = null; record.revision++;
    await app.ui.refreshConversation(); assert.match(app.nodes.get('messages').textContent, /Interrupted on restart/);
    const reload = await createUI({ saved: [copy(record)], selected: A });
    try { assert.equal(reload.ui.get().detail.turns[0].message, 'A durable request'); assert.match(reload.nodes.get('messages').textContent, /Interrupted/); assert.equal(reload.requests.filter(item => item.url.endsWith('/chat')).length, 0); } finally { reload.close(); }
  } finally { app.close(); }
});

test('active selection is locked; cancellation and a late completed response cannot retarget another conversation', async () => {
  const pending = deferred(); const app = await createUI({ saved: [blank(A), blank(B)], selected: A });
  try {
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null;
      const body = JSON.parse(options.body), record = records.get(A); record.turns.push({ id: body.id, message: body.message, providerId: body.providerId, status: 'running', startedAt: '2026-10-24T12:00:00Z' }); record.activeRequestId = body.id; record.revision++;
      return pending.promise;
    });
    app.nodes.get('question').value = 'Request A'; const turn = app.ui.runCommand('Request A');
    await until(() => app.requests.some(item => item.url.endsWith('/chat')));
    assert.equal(app.nodes.get('conversation-select').disabled, true); assert.equal(await app.ui.selectConversation(B), false); assert.equal(app.ui.get().id, A);
    app.ui.cancelTurn(false); await app.ui.selectConversation(B);
    const record = app.records.get(A), savedTurn = record.turns[0]; savedTurn.status = 'completed'; savedTurn.reply = { id: savedTurn.id, text: 'Completed only in A', actions: [], providerId: 'codex' }; record.activeRequestId = null; record.revision++;
    pending.resolve(response({ ...savedTurn.reply, conversationId: A, conversationRevision: record.revision })); await turn;
    assert.equal(app.ui.get().id, B); assert.doesNotMatch(app.nodes.get('messages').textContent, /Completed only in A/);
    await app.ui.selectConversation(A); assert.match(app.nodes.get('messages').textContent, /Completed only in A/);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('voice captures its conversation before microphone permission and rejects that context after a switch', async () => {
  const app = await createUI({ saved: [blank(A), blank(B)], selected: A });
  try {
    const opening = app.ui.startRecording(); assert.equal(app.nodes.get('conversation-select').disabled, true); assert.equal(await app.ui.selectConversation(B), false);
    await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening; const item = app.ui.get().recording; assert.equal(item.conversationContext.id, A);
    app.ui.cancelTurn(false); assert.equal(app.stoppedTracks, 1); await app.ui.selectConversation(B);
    await app.ui.runCommand('Old voice words', { voice: true, providerId: item.providerId, conversationContext: item.conversationContext, approvalContext: null });
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.match(app.nodes.get('question-error').textContent, /conversation changed/);
  } finally { app.close(); }
});

test('historical desktop receipts do not revive an action that is already completed', async () => {
  const action = { id: B, status: 'pending', summary: 'Synthetic input', createdAt: '2026-10-24T12:00:00Z', expiresAt: new Date(Date.now() + 60000).toISOString(), requiresApproval: true, target: { windowId: 'fixture', title: 'Fixture', elementId: 'field' }, preview: { action: 'setText', text: 'Synthetic' } };
  const detail = blank(A); detail.revision = 2; detail.turns.push({ id: 'saved', message: 'Prepare text', providerId: 'codex', status: 'completed', reply: { text: 'Please review.', actions: [{ tool: 'desktop_propose_action', status: 'pending', result: { desktopAction: action } }] } });
  const app = await createUI({ saved: [detail], selected: A });
  try {
    app.ui.rememberDesktopAction({ ...action, status: 'completed' }); app.ui.renderSavedConversation();
    assert.equal(app.ui.get().desktop.find(item => item.id === B).status, 'completed');
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Needs your review|Prepared desktop action/);
    assert.match(app.nodes.get('messages').textContent, /Completed/);
  } finally { app.close(); }
});

test('a revision conflict preserves the draft and reconciles the actual accepted request', async () => {
  const app = await createUI({ saved: [blank(A)], selected: A });
  try {
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null;
      const current = records.get(A); current.revision = 2;
      current.turns.push({ id: 'other-window', message: 'Other window request', providerId: 'codex', status: 'completed', reply: { text: 'Other window result', actions: [] } });
      return response({ error: { code: 'revision_conflict', message: 'The conversation changed. Review and send again.' }, conversation: current }, 409);
    });
    app.nodes.get('question').value = 'Keep my exact draft'; await app.ui.runCommand('Keep my exact draft');
    assert.equal(app.nodes.get('question').value, 'Keep my exact draft');
    assert.match(app.nodes.get('messages').textContent, /Other window result/);
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Keep my exact draft/);
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('loading an older page preserves current revision, active state and draft and rejects a late page after switching', async () => {
  const older = { id: 'older-turn', message: 'An earlier message', status: 'completed', reply: { text: 'An earlier reply', actions: [] } };
  const latest = { ...blank(A), revision: 8, totalTurns: 2, hasMore: true, olderThan: 'latest-turn', turns: [{ id: 'latest-turn', message: 'Latest message', status: 'completed', reply: { text: 'Latest reply', actions: [] } }] };
  const app = await createUI({ saved: [latest, blank(B)], selected: A });
  try {
    app.nodes.get('question').value = 'Unsent current draft';
    app.setIntercept(url => url.includes('/conversations/' + A + '?before=') ? response({ ...blank(A), revision: 1, activeRequestId: 'obsolete', hasMore: false, turns: [older], olderThan: older.id }) : null);
    await app.ui.loadEarlierConversation();
    assert.equal(app.ui.get().detail.revision, 8); assert.equal(app.ui.get().detail.activeRequestId, null);
    assert.equal(app.nodes.get('question').value, 'Unsent current draft');
    assert.match(app.nodes.get('messages').textContent, /An earlier reply/); assert.match(app.nodes.get('messages').textContent, /Latest reply/);
    await app.ui.selectConversation(B); await app.ui.selectConversation(A);
    const pending = deferred(); app.setIntercept(url => url.includes('/conversations/' + A + '?before=') ? pending.promise : null);
    const oldPage = app.ui.loadEarlierConversation(); await app.ui.selectConversation(B);
    pending.resolve(response({ ...blank(A), hasMore: false, turns: [older] })); await oldPage;
    assert.equal(app.ui.get().id, B); assert.doesNotMatch(app.nodes.get('messages').textContent, /An earlier reply/);
  } finally { app.close(); }
});

test('voice stops when hidden and reacquires its capture owner with granted permission on return', async () => {
  const app = await createUI();
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    assert.equal(app.ui.get().voiceState.status, 'listening');
    await app.ui.setVoiceVisible(false); assert.equal(app.stoppedTracks, 1); assert.equal(app.ui.get().ownsVoice, false);
    const showing = app.ui.setVoiceVisible(true); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await showing;
    assert.equal(app.ui.get().voiceState.status, 'listening'); assert.equal(app.ui.get().ownsVoice, true);
  } finally { app.close(); }
});

test('a paused dialog microphone explicitly resumes with freshly frozen review context', async () => {
  const app = await createUI();
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    const action = { id: A, status: 'pending', summary: 'Synthetic prepared text', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), requiresApproval: true, target: { windowId: 'fixture-window', title: 'Fixture editor', elementId: 'fixture-field' }, preview: { action: 'setText', text: 'Exact synthetic text' } };
    app.setIntercept(url => url.endsWith('/desktop/actions') ? response({ actions: [action] }) : null);
    await app.ui.openDesktopReview(A); assert.equal(app.ui.get().recording, null); assert.equal(app.ui.get().voiceState.status, 'paused');
    const restarting = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await restarting;
    assert.equal(app.ui.get().voiceState.status, 'listening'); assert.equal(app.stoppedTracks, 1); assert.equal(app.ui.get().recording.approvalContext.id, A);
  } finally { app.close(); }
});

test('closing the actual review dialog resumes after its cleanup listeners with no retained approval context', async () => {
  const app = await createUI();
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    app.ui.showDialog('desktop-review-dialog'); assert.equal(app.ui.get().voiceState.status, 'paused');
    const dialog = app.nodes.get('desktop-review-dialog'); dialog.close(); await dialog.dispatch('close');
    await until(() => app.waitingForMicrophone); app.grantMicrophone(); await until(() => app.ui.get().voiceState.status === 'listening');
    assert.equal(app.ui.get().recording.approvalContext, null); assert.equal(app.stoppedTracks, 1);
  } finally { app.close(); }
});

test('only one Companion window can capture voice at a time, without requiring operating-system focus', async () => {
  const locks = createLocks(), first = await createUI({ locks }), second = await createUI({ locks });
  try {
    const opening = first.ui.startRecording(); await until(() => first.waitingForMicrophone); first.grantMicrophone(); await opening;
    await second.ui.startRecording(); assert.equal(second.waitingForMicrophone, false); assert.equal(first.ui.get().voiceState.status, 'listening');
    assert.match(second.nodes.get('question-error').textContent, /another Companion window/);
    await first.ui.setVoiceVisible(false);
    const handoff = second.ui.startRecording(); await until(() => second.waitingForMicrophone); second.grantMicrophone(); await handoff;
    assert.equal(second.ui.get().voiceState.status, 'listening'); assert.equal(first.ui.get().ownsVoice, false);
  } finally { first.close(); second.close(); }
});

test('the default canvas keeps chat closed and only actual human voice commands navigate', async () => {
  const app = await createUI();
  try {
    assert.equal(app.ui.get().chatOpen, false);
    app.ui.addMessage('assistant', 'show tasks'); assert.equal(app.ui.get().currentView, 'today');
    const options = { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null };
    await app.ui.runCommand('show tasks', options); assert.equal(app.ui.get().currentView, 'tasks');
    await app.ui.runCommand('show chat', options); assert.equal(app.ui.get().chatOpen, true); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.runCommand('hide chat', options); assert.equal(app.ui.get().chatOpen, false);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 0);
  } finally { app.close(); }
});

test('a failed voice chat inhibits automatic listening instead of repeating an uncertain request', async () => {
  const app = await createUI({ saved: [blank(A)], selected: A });
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    const voiceContext = copy(app.ui.get().recording);
    app.setIntercept(url => url.endsWith('/chat') ? response({ error: { code: 'provider_failed', message: 'Synthetic provider failure' } }, 502) : null);
    app.nodes.get('question').value = 'A failing voice request';
    await app.ui.runCommand('A failing voice request', { voice: true, providerId: voiceContext.providerId, conversationContext: voiceContext.conversationContext, approvalContext: null });
    assert.equal(app.ui.get().voiceState.enabled, false); assert.equal(app.ui.get().ownsVoice, false); assert.equal(app.waitingForMicrophone, false);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('Memory shows actual saved preferences and Forget and Remember again use reversible tools', async () => {
  const preference = { id: A, key: 'reply_style', label: 'Reply style', value: 'Keep replies concise.', archived: false };
  const app = await createUI({ workspacePreferences: [preference] });
  try {
    const calls = [];
    app.setIntercept((url, options, { workspace }) => {
      if (!url.endsWith('/tools/run')) return null;
      const body = JSON.parse(options.body); calls.push(body);
      if (body.tool === 'forget_preference') { assert.equal(body.arguments.preferenceId, A); workspace.preferences[0].archived = true; }
      else { assert.equal(body.tool, 'remember_preference'); assert.equal(body.arguments.key, 'reply_style'); assert.equal(body.arguments.value, preference.value); workspace.preferences[0].archived = false; }
      workspace.revision++; return response({ result: { preference: workspace.preferences[0] }, workspace });
    });
    assert.match(app.nodes.get('memory-list').textContent, /Keep replies concise/);
    await app.nodes.get('memory-list').children[0].children.at(-1).dispatch('click'); await until(() => /No preferences/.test(app.nodes.get('memory-list').textContent));
    app.nodes.get('memory-show-forgotten').checked = true; await app.nodes.get('memory-show-forgotten').dispatch('change');
    assert.match(app.nodes.get('memory-list').textContent, /Remember again/);
    await app.nodes.get('memory-list').children[0].children.at(-1).dispatch('click'); await until(() => /Forget/.test(app.nodes.get('memory-list').textContent));
    assert.equal(calls.length, 2); assert.notEqual(calls[0].operationId, calls[1].operationId);
  } finally { app.close(); }
});
