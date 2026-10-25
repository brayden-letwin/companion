import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createVoiceSession } from '../src/voice-session.mjs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('assistant.html', root), 'utf8');
const buildContinuationSource=readFileSync(new URL('src/build-continuation.mjs',root),'utf8').replace('export function createBuildContinuationUI','function createBuildContinuationUI');
const projectFilesSource=readFileSync(new URL('src/project-files.mjs',root),'utf8').replace('export function createProjectFilesUI','function createProjectFilesUI');
const source = readFileSync(new URL('src/assistant.mjs', root), 'utf8')
  .replace(/^import \{ createVoiceSession \} from '\.\/voice-session\.mjs';\r?\n/, '')
  .replace(/^import \{ createProjectFilesUI \} from '\.\/project-files\.mjs';\r?\n/, '')
  .replace(/^import \{\s*createBuildContinuationUI\s*\} from '\.\/build-continuation\.mjs';\r?\n/, '')
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
  removeEventListener(type,callback){this.listeners[type]=(this.listeners[type]||[]).filter(item=>item!==callback);}
  async dispatch(type, event = {}) { const pending = []; for (const callback of this.listeners[type] || []) pending.push(callback(event)); await Promise.all(pending); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  scrollIntoView() {}
  remove() { this.removed = true; }
  querySelectorAll(selector) { const matches = []; const visit = node => { for (const child of node.children) { if (selector.startsWith('.') && child.className?.split(/\s+/).includes(selector.slice(1))) matches.push(child); visit(child); } }; visit(this); return matches; }
  get childNodes() { return this.children; }
  get lastElementChild() { return this.children.at(-1); }
  get scrollHeight() { return 600; }
}

async function until(predicate, label = 'UI state') { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail(`${label} did not settle`); }

function createLocks() {
  const held = new Set();
  return { request: async (name, options, callback) => { if (held.has(name)) return callback(null); held.add(name); try { return await callback({ name }); } finally { held.delete(name); } } };
}

async function createUI({ saved = [], selected = null, intercept = null, waitForConversations = true, locks = createLocks(), workspacePreferences = [], workspaceWorkflows = [], workspaceTasks = [], storedWorkflowRuns = [], catalog = [], contextWindows = [], savedWork = [], storedWorkIds = [], runtimeBaseline = null, runtimeClock = null, projects = [], storedProject = null, savedContinuations = [], savedBuilds = [] } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  nodes.get('provider-type').value = 'openai';
  const records = new Map(saved.map(item => [item.id, structuredClone(item)]));
  const workRecords = new Map(savedWork.map(item => [item.id, structuredClone(item)]));
  const continuationRecords = new Map(savedContinuations.map(item => [item.id, structuredClone(item)]));
  const buildRecords = new Map(savedBuilds.map(item => [item.id, structuredClone(item)]));
  const projectRecords = new Map(projects.map(item => [item.projectId, structuredClone(item)]));
  const storage = new Map(selected ? [['companion.workspace.ui.v1.conversationId', JSON.stringify(selected)]] : []);
  if (storedProject) storage.set('companion.workspace.ui.v1.selectedProject', JSON.stringify(storedProject));
  if (storedWorkIds.length) storage.set('companion.workspace.ui.v1.pendingWorkIds', JSON.stringify(storedWorkIds));
  if (storedWorkflowRuns.length) storage.set('companion.workspace.ui.v1.pendingWorkflowRuns', JSON.stringify(storedWorkflowRuns));
  const requests = [], intervals = [], timers = new Set();
  const workspace = { revision: 0, tasks: structuredClone(workspaceTasks), notes: [], workflows: structuredClone(workspaceWorkflows), preferences: structuredClone(workspacePreferences), focus: null, activity: [] };
  const contextPins = new Map(); let nextContextId = 0;
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
    if (route === 'projects') return response({ projects: [...projectRecords.values()] });
    if (/^projects\/[^/?]+\?/.test(route)) { const url = new URL('http://fixture/' + route), project = projectRecords.get(url.pathname.split('/')[2]); if (!project || project.available === false || project.revoked || project.grantEpoch !== Number(url.searchParams.get('grantEpoch'))) return response({ error: { code: 'project_grant_changed', message: 'The original folder access is no longer available.' } }, 409); return response({ project }); }
    if (/^projects\/[^/]+\/files\?/.test(route)) { const url = new URL('http://fixture/' + route); return response({ projectId: url.pathname.split('/')[2], grantEpoch: Number(url.searchParams.get('grantEpoch')), path: url.searchParams.get('path') || '', entries: [], offset: 0, hasMore: false, nextOffset: null, directoryHash: 'synthetic-empty-directory', complete: true }); }
    if (route === 'work' && options.method === 'POST') { const body = JSON.parse(options.body); if (!workRecords.has(body.id)) { workRecords.set(body.id, { id: body.id, conversationId: body.id, requestId: 'work_' + body.id, title: body.prompt.slice(0, 70), prompt: body.prompt, providerId: body.providerId, ...(body.project ? { project: structuredClone(body.project) } : {}), provider: { id: body.providerId, label: 'GPT', type: 'codex', model: '' }, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { message: 'Queued', events: [] } }); records.set(body.id, blank(body.id, body.prompt.slice(0, 70))); } return response({ job: workRecords.get(body.id) }); }
    if (route.startsWith('work?')) { const params = new URLSearchParams(route.slice(5)), offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 20), all = [...workRecords.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return response({ jobs: all.slice(offset, offset + limit).map(job => ({ ...job, prompt: undefined, promptPreview: job.prompt.slice(0, 100), outcome: undefined })), total: all.length, hasMore: offset + limit < all.length, nextOffset: offset + limit < all.length ? offset + limit : null }); }
    if (route.startsWith('work/')) { const [pathname, query = ''] = route.split('?'), [, id, operation] = pathname.split('/'), job = workRecords.get(id); if (!job) return response({ error: { code: 'work_missing', message: 'Work missing' } }, 404); if (operation === 'cancel') { job.status = 'cancelled'; job.updatedAt = new Date().toISOString(); } const result = structuredClone(job); if (result.outcome) { const params = new URLSearchParams(query), textOffset = Number(params.get('textOffset') || 0), actionOffset = Number(params.get('actionOffset') || 0), text = result.outcome.text || '', actions = result.outcome.actions || []; result.outcome = { ...result.outcome, text: text.slice(textOffset, textOffset + 4000), textOffset, nextTextOffset: textOffset + 4000 < text.length ? textOffset + 4000 : null, textHasMore: textOffset + 4000 < text.length, totalTextCharacters: text.length, actions: actions.slice(actionOffset, actionOffset + 12), actionOffset, nextActionOffset: actionOffset + 12 < actions.length ? actionOffset + 12 : null, actionsHasMore: actionOffset + 12 < actions.length, totalActions: actions.length }; } return response({ job: result }); }
    if (route.startsWith('continuations?')) { const params = new URLSearchParams(route.slice(route.indexOf('?') + 1)), matches = [...continuationRecords.values()].filter(item => item.buildId === params.get('buildId')), offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 20); return response({ continuations: matches.slice(offset, offset + limit), total: matches.length, offset, limit, hasMore: offset + limit < matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null }); }
    if (route.startsWith('continuations/')) { const [, id, action] = route.split('/'), continuation = continuationRecords.get(id); if (!continuation) return response({ error: { code: 'continuation_not_found', message: 'Original continuation missing' } }, 404); if (action === 'continue') { assert.equal(options.body, '{}'); continuation.status = 'queued'; continuation.workJob = { id: continuation.workId, status: 'queued' }; if (!workRecords.has(continuation.workId)) { workRecords.set(continuation.workId, { id: continuation.workId, conversationId: continuation.workId, requestId: 'work_' + continuation.workId, prompt: continuation.origin.message, title: 'Original request', providerId: continuation.origin.provider.id, provider: continuation.origin.provider, status: 'queued', createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', progress: { message: 'Queued', events: [] } }); records.set(continuation.workId, blank(continuation.workId, 'Original request')); } } if (action === 'cancel') continuation.status = 'cancelled'; return response({ continuation }); }
    if (route === 'features') return response({ jobs: [...buildRecords.values()] });
    if (route.startsWith('features/')) { const job = buildRecords.get(route.split('/')[1]); return job ? response({ job }) : response({ error: { code: 'not_found', message: 'Build missing' } }, 404); }
    if (route === 'integrations') return response({ mcp: { command: 'C:/Node/node.exe', args: ['C:/Companion/server/mcp-server.mjs'] }, tools: catalog, capabilityStatus: { ready: true } });
    if (route === 'runtime') return response(runtimeBaseline || { managed: true, restarting: false, workerPid: 100 });
    if (route === 'desktop') return response({ available: true, capabilities: { installedApps: true, windows: true, read: true, open: true, reviewedInput: true }, pendingCount: 0 });
    if (route === 'desktop/actions') return response({ actions: [] });
    if (route === 'cancel') return response({ cancelled: true });
    if (route === 'context') { const body = JSON.parse(options.body), window = contextWindows.find(item => item.id === body.windowId) || { id: body.windowId, title: 'Window ' + body.windowId, appName: 'Fixture', pid: 7 }; const context = { id: 'context-' + (++nextContextId), window, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 28800000).toISOString() }; contextPins.set(context.id, context); return response({ context }); }
    if (/^context\/[^/]+\/clear$/.test(route)) { contextPins.delete(decodeURIComponent(route.split('/')[1])); return response({ released: true }); }
    if (route === 'conversations' && options.method === 'POST') {
      const body = JSON.parse(options.body); if (!records.has(body.id)) records.set(body.id, blank(body.id)); return response(records.get(body.id));
    }
    if (route === 'conversations') return response({ conversations: [...records.values()].map(item => ({ ...item, turns: undefined, turnCount: item.turns.length, lastStatus: item.turns.at(-1)?.status || null })) });
    if (route.startsWith('conversations/')) return records.has(route.slice(14)) ? response(records.get(route.slice(14))) : response({ error: { code: 'not_found', message: 'Conversation missing' } }, 404);
    if (route === 'chat') {
      const body = JSON.parse(options.body), record = records.get(body.conversationId);
      assert.equal(body.expectedRevision, record.revision);
      const context = contextPins.get(body.contextId), windowContext = context ? { contextId: context.id, windowId: context.window.id, title: context.window.title, appName: context.window.appName, readAt: new Date().toISOString(), sourceTruncated: false, formatterTruncated: false, truncated: false, empty: false } : null;
      const reply = { id: body.id, text: 'A saved response.', actions: [], featureJob: null, providerId: body.providerId, ...(windowContext ? { windowContext } : {}), ...(body.project ? { projectContext: { ...body.project, label: projectRecords.get(body.project.projectId)?.label || 'Selected folder' } } : {}) };
      record.turns.push({ id: body.id, message: body.message, providerId: body.providerId, status: 'completed', startedAt: '2026-10-24T12:00:01Z', finishedAt: '2026-10-24T12:00:02Z', reply }); record.revision += 2;
      return response({ ...reply, conversationId: record.id, conversationRevision: record.revision, workspace });
    }
    throw new Error(`Unexpected request ${route}`);
  }
  const window = { MediaRecorder: Recorder, AudioContext, addEventListener() {} };
  const ClockDate = runtimeClock ? class extends Date { static now() { return runtimeClock.value; } } : Date;
  const context = vm.createContext({ Date: ClockDate, createVoiceSession, window, document, navigator: { locks, permissions: { query: async () => ({ state: 'granted' }) }, mediaDevices: { getUserMedia: () => { permission = deferred(); return permission.promise; } } }, MediaRecorder: Recorder, fetch: fetchMock, Headers, AbortController, TextEncoder, Blob, URL, URLSearchParams, DOMException, crypto: webcrypto, structuredClone, performance, console, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, location: { search: '', reload() {}, assign() {} }, Event: class {}, setTimeout: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref(); timers.add(timer); return timer; }, clearTimeout, setInterval: callback => { intervals.push(callback); return intervals.length; }, requestAnimationFrame: () => 0, cancelAnimationFrame() {} });
  context.createBuildContinuationUI=vm.runInContext('(function(){'+buildContinuationSource+'\nreturn createBuildContinuationUI;})()',context);
  context.createProjectFilesUI=vm.runInContext('(function(){'+projectFilesSource+'\nreturn createProjectFilesUI;})()',context);
  vm.runInContext(source + '\nglobalThis.ui={ready:()=>checkingService,selectConversation,refreshConversations,refreshConversation,loadEarlierConversation,runCommand,cancelTurn,startRecording,setVoiceVisible,renderSavedConversation,rememberDesktopAction,captureConversationContext,setChatOpen,showDialog,openDesktopReview,addMessage,processVoiceSegment,refreshToolCatalog,applyToolCatalog,applyExtensionManifest,openFeatureByName,openWorkflow,renderWorkflowSteps,validateWorkflowSteps,runWorkflow,renderActionReceipts,appendInstalledFeatureReady,refreshJobs,refreshWorkspace,selectWindowContext,clearWindowContext,captureWindowContext,renderWindowContext,applyRuntime,reconnectAfterRestart,restartCompanionService,runtimeRestartConfirmed,jobAction,submitWork,refreshWork,refreshWorkDetail,selectWork,checkWorkHandoff,cancelWork,openWorkConversation,showView,loadWorkOutcome,applyProviders,captureBuildContinuationContext,currentBuildContinuationContext,continueBuildOriginal,initBuildContinuationUI,selectBuild:id=>{selectedJobId=id;renderJobs();},selectProject,refreshProjectAccess,captureProjectContext,currentProjectContext,setExtensionLoader:loader=>loadExtensionModule=loader,get:()=>({id:conversationId,detail:conversationDetail,localChatTurn,turnBusy,recording,voiceCaptureContext,activeRequest,selectedWindowContext,windowContextGeneration,selectedProject,projectSelectionGeneration,voiceState:voiceSessionState,chatOpen,currentView,ownsVoice:voiceOwnsCapture,initial:conversationInitialized,listPending:!!conversationListPending,detailPending:!!conversationDetailRequest,desktop:desktopActions,workflowDraft,toolCatalog,extensions:[...extensions.values()],workspace,workJobs,selectedWorkId,workDetails:[...workDetails.values()],workSubmitting,pendingWorkIds:[...pendingWorkIds],runtimeInfo,runtimeRetry,runtimeNotice,selectedJobId,buildContinuationUI,reconnecting:!!runtimeReconnectPromise})};', context);
  await context.ui.ready();
  if (waitForConversations) await until(() => !context.ui.get().listPending && !context.ui.get().detailPending, 'initial conversation load');
  return { ui: context.ui, nodes, records, workRecords, projectRecords, continuationRecords, buildRecords, storage, requests, document, intervals, setIntercept: value => { custom = value; }, get waitingForMicrophone() { return !!permission; }, grantMicrophone: () => { const pending = permission; permission = null; pending.resolve({ getTracks: () => [{ stop: () => stoppedTracks++ }] }); }, get stoppedTracks() { return stoppedTracks; }, close: () => { context.ui.cancelTurn(false); for (const timer of timers) clearTimeout(timer); } };
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

const feature = (id, title, aliases = []) => ({ id, title, aliases, module: './features/' + id + '.mjs' });
const descendants = node => [node, ...node.children.flatMap(descendants)];
const argumentField = (app, name) => descendants(app.nodes.get('workflow-steps')).find(node => node.dataset.argument === name);
const customAction = (overrides = {}) => ({ name: 'cap_scale', title: 'Scale values', description: 'Scale a small list of values.', kind: 'capability', capabilityId: 'scale', featureId: 'scale-panel', version: '1', hash: 'a'.repeat(64), workflowAllowed: true, effectPolicy: 'pure', parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 40 }, count: { type: 'integer', minimum: 1, maximum: 5 }, rate: { type: 'number', minimum: 0, maximum: 1 }, rounded: { type: 'boolean' }, unit: { type: 'string', enum: ['meters', 'feet'] }, values: { type: 'array', items: { type: 'number' }, maxItems: 3 }, options: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false } }, required: ['name', 'count', 'rate', 'rounded', 'unit', 'values', 'options'] }, ...overrides });

test('an installed panel opens through its normalized voice alias and assistant text never opens it', async () => {
  const app = await createUI();
  try {
    app.ui.setExtensionLoader(async () => ({ mount: ({ container }) => { container.textContent = 'A real mounted fixture'; } }));
    await app.ui.applyExtensionManifest({ version: 1, features: [feature('time-zones', 'Time zones', ['Zone converter'])] });
    app.ui.addMessage('assistant', 'open zone converter'); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.runCommand('show ＺＯＮＥ ＣＯＮＶＥＲＴＥＲ', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.equal(app.ui.get().currentView, 'extension-time-zones');
    assert.match(app.nodes.get('extension-nav').textContent, /Say “open Time zones”/);
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
  } finally { app.close(); }
});

test('ambiguous, failed, duplicate and removed panel names open Tools without choosing a different feature', async () => {
  const app = await createUI();
  try {
    app.ui.setExtensionLoader(async url => { if (url.includes('broken')) throw new Error('Synthetic missing module'); return { mount() {} }; });
    await app.ui.applyExtensionManifest({ version: 1, features: [feature('first', 'First', ['converter']), feature('second', 'Second', ['converter']), feature('broken', 'Broken')] });
    app.ui.openFeatureByName('converter'); assert.equal(app.nodes.get('tools-menu').open, true); assert.match(app.nodes.get('tools-message').textContent, /More than one/); assert.equal(app.ui.get().currentView, 'today');
    app.ui.openFeatureByName('Broken'); assert.match(app.nodes.get('tools-message').textContent, /could not open/); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.applyExtensionManifest({ version: 1, features: [feature('same', 'Duplicate one'), feature('same', 'Duplicate two')] });
    assert.equal(app.ui.get().extensions.length, 0); assert.match(app.nodes.get('extension-nav').textContent, /duplicate installation ID/);
    await app.ui.applyExtensionManifest({ version: 1, features: [] });
    await app.ui.runCommand('open First', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.match(app.nodes.get('tools-message').textContent, /not available/); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
  } finally { app.close(); }
});

test('capability-only tools remain discoverable and an unavailable registry is not labeled uninstalled', async () => {
  const app = await createUI({ catalog: [customAction()] });
  try {
    await app.ui.refreshToolCatalog();
    assert.match(app.nodes.get('extension-nav').textContent, /Scale valuesAvailable by voice/);
    await app.ui.runCommand('open Scale values', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.match(app.nodes.get('tools-message').textContent, /available by voice/); assert.equal(app.ui.get().currentView, 'today');
    app.ui.applyToolCatalog({ tools: [], capabilityStatus: { ready: false, message: 'Installed action registry needs attention.' } });
    assert.match(app.nodes.get('extension-nav').textContent, /needs attention/); assert.doesNotMatch(app.nodes.get('extension-nav').textContent, /No installed tools yet/);
  } finally { app.close(); }
});

test('workflow fields come from the catalog and preserve typed values and invalid structured drafts', async () => {
  const meta = customAction(), forbidden = customAction({ name: 'desktop_forbidden', title: 'External input', workflowAllowed: false });
  const app = await createUI({ catalog: [meta, forbidden] });
  try {
    await app.ui.refreshToolCatalog(); app.ui.openWorkflow();
    const choose = app.nodes.get('workflow-steps').children[0].children[0].children[1];
    assert.ok(choose.children.some(node => node.value === 'cap_scale')); assert.equal(choose.children.some(node => node.value === 'desktop_forbidden'), false);
    choose.value = 'cap_scale'; await choose.dispatch('change');
    for (const [name, value, event] of [['name', 'Fixture', 'input'], ['count', '3', 'input'], ['rate', '0.5', 'input'], ['rounded', 'false', 'change'], ['unit', '1', 'change'], ['values', '[1,2]', 'input'], ['options', '{"tag":"test"}', 'input']]) { const input = argumentField(app, name); input.value = value; await input.dispatch(event); }
    let step = app.ui.get().workflowDraft[0]; assert.equal(step.arguments.count, 3); assert.equal(step.arguments.rate, 0.5); assert.equal(step.arguments.rounded, false); assert.equal(step.arguments.unit, 'feet');
    app.ui.validateWorkflowSteps(app.ui.get().workflowDraft);
    const list = argumentField(app, 'values'); list.value = '['; await list.dispatch('input'); assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /valid list/);
    app.ui.renderWorkflowSteps(); assert.equal(argumentField(app, 'values').value, '['); assert.equal(app.ui.get().workflowDraft[0].arguments.values.length, 2);
    const fixed = argumentField(app, 'values'); fixed.value = '[1,2,3,4]'; await fixed.dispatch('input'); assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /number of items/);
  } finally { app.close(); }
});

test('missing or changed saved capability steps retain their pin and values until explicit reselection', async () => {
  const meta = customAction({ parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const app = await createUI({ catalog: [meta] });
  try {
    await app.ui.refreshToolCatalog();
    app.ui.openWorkflow({ id: A, name: 'Saved', steps: [{ tool: 'cap_scale', arguments: { text: 'Preserve this' }, capability: { id: 'scale', version: '0', hash: 'b'.repeat(64) } }] });
    assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /tool changed/);
    assert.equal(app.ui.get().workflowDraft[0].arguments.text, 'Preserve this'); assert.equal(app.ui.get().workflowDraft[0].capability.version, '0');
    const update = descendants(app.nodes.get('workflow-steps')).find(node => node.textContent === 'Use updated action'); await update.dispatch('click');
    assert.equal(app.ui.get().workflowDraft[0].capability, undefined); assert.equal(app.ui.get().workflowDraft[0].arguments.text, 'Preserve this'); app.ui.validateWorkflowSteps(app.ui.get().workflowDraft);
    app.ui.openWorkflow({ id: A, name: 'Missing', steps: [{ tool: 'cap_removed', arguments: { text: 'Retained value' }, capability: { id: 'removed', version: '1', hash: 'c'.repeat(64) } }] });
    assert.match(app.nodes.get('workflow-steps').textContent, /not installed/); assert.match(app.nodes.get('workflow-steps').textContent, /Retained value/);
    assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /not installed/); assert.equal(app.ui.get().workflowDraft[0].tool, 'cap_removed');
  } finally { app.close(); }
});

test('a ready installed feature gets an explicit Open action and failed panels are never labeled ready', async () => {
  const app = await createUI();
  try {
    app.ui.setExtensionLoader(async () => ({ mount() {} })); await app.ui.applyExtensionManifest({ version: 1, features: [feature('ready-panel', 'Ready panel')] });
    const container = new Element(); app.ui.appendInstalledFeatureReady(container, { status: 'applied', providedFeatures: [{ id: 'ready-panel', title: 'Ready panel' }] });
    assert.match(container.textContent, /Ready panel ready/); await container.children[0].children[1].dispatch('click'); assert.equal(app.ui.get().currentView, 'extension-ready-panel');
    app.ui.setExtensionLoader(async () => { throw new Error('Synthetic mount failure'); }); await app.ui.applyExtensionManifest({ version: 1, features: [feature('ready-panel', 'Ready panel')] });
    const failed = new Element(); app.ui.appendInstalledFeatureReady(failed, { status: 'applied', installedFeatures: [{ id: 'ready-panel', title: 'Ready panel' }] });
    assert.doesNotMatch(failed.textContent, /ready\./); assert.match(failed.textContent, /could not open/);
    await app.ui.applyExtensionManifest({ version: 1, features: [] }); const removed = new Element(); app.ui.appendInstalledFeatureReady(removed, { status: 'applied', providedFeatures: [{ id: 'ready-panel', title: 'Ready panel' }] });
    assert.match(removed.textContent, /not currently available/); assert.doesNotMatch(removed.textContent, /is installed|ready\./);
  } finally { app.close(); }
});

test('panel action helpers use real tool receipts and retain partial error receipts without retrying', async () => {
  const app = await createUI({ catalog: [customAction()] });
  try {
    let api, calls = 0; app.ui.setExtensionLoader(async () => ({ mount: value => { api = value.api; } })); await app.ui.applyExtensionManifest({ version: 1, features: [feature('scale-panel', 'Scale values')] });
    app.setIntercept((url, options, { workspace }) => {
      if (!url.endsWith('/tools/run')) return null;
      const body = JSON.parse(options.body); assert.equal(body.tool, 'cap_scale'); assert.equal(body.arguments.count, 2); calls++;
      if (calls === 1) { workspace.revision++; workspace.tasks.push({ id: A, title: 'Actual server task', status: 'todo' }); return response({ tool: body.tool, result: { capability: { id: 'scale', name: 'cap_scale' }, value: { total: 8 }, hostActions: [] }, workspace }); }
      return response({ error: { code: 'capability_failed', message: 'Synthetic partial failure' }, capability: { id: 'scale', name: 'cap_scale' }, hostActions: [{ tool: 'create_task', status: 'completed', result: { task: { title: 'Actual server task' } } }] }, 500);
    });
    const value = await api.runTool('cap_scale', { count: 2 }); assert.equal(value.result.value.total, 8); assert.equal(app.ui.get().workspace.tasks.length, 1);
    await assert.rejects(api.runTool('cap_scale', { count: 2 }), error => error.code === 'capability_failed' && error.hostActions.length === 1 && error.capability.id === 'scale'); assert.equal(calls, 2);
    const receipt = new Element(); app.ui.renderActionReceipts(receipt, [{ tool: 'run_capability', arguments: { name: 'cap_scale' }, status: 'failed', result: { error: 'Synthetic partial failure', hostActions: [{ tool: 'create_task', status: 'completed', result: { task: { title: 'Actual server task' } } }] } }]);
    assert.match(receipt.textContent, /could not finish/); assert.match(receipt.textContent, /Actual server task/); assert.doesNotMatch(receipt.textContent, /Scale values · completed/);
  } finally { app.close(); }
});

test('saving edited workflows preserves existing capability pins and leaves new steps for server pinning', async () => {
  const meta = customAction({ parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const app = await createUI({ catalog: [meta] });
  try {
    await app.ui.refreshToolCatalog(); const pin = { id: meta.capabilityId, version: meta.version, hash: meta.hash };
    app.ui.openWorkflow({ id: A, name: 'Saved', steps: [{ tool: 'cap_scale', arguments: { text: 'Existing value' }, capability: pin }] });
    await app.nodes.get('add-workflow-step').dispatch('click'); const row = app.nodes.get('workflow-steps').children[1], choose = row.children[0].children[1]; choose.value = 'cap_scale'; await choose.dispatch('change');
    const inputs = descendants(app.nodes.get('workflow-steps')).filter(node => node.dataset.argument === 'text'); inputs[1].value = 'New value'; await inputs[1].dispatch('input');
    let saved;
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace/operations')) return null; saved = JSON.parse(options.body); workspace.revision++; workspace.workflows = [{ id: A, name: saved.name, steps: saved.steps }]; return response({ workspace, replayed: false }); });
    await app.nodes.get('workflow-form').dispatch('submit', { preventDefault() {} });
    assert.equal(saved.type, 'saveWorkflow'); assert.deepEqual(saved.steps[0].capability, pin); assert.equal(saved.steps[0].arguments.text, 'Existing value'); assert.equal(saved.steps[1].arguments.text, 'New value'); assert.equal('capability' in saved.steps[1], false);
  } finally { app.close(); }
});

test('an uncertain workflow run offers Check last run with the same ID through live replay and terminal completion', async () => {
  const meta = customAction({ parameters: { type: 'object', properties: {}, additionalProperties: false } });
  const flow = { id: A, name: 'Receipt fixture', enabled: true, steps: [{ tool: meta.name, arguments: {}, capability: { id: meta.capabilityId, version: meta.version, hash: meta.hash } }] };
  const app = await createUI({ catalog: [meta], workspaceWorkflows: [flow] });
  try {
    const bodies = []; let effects = 0;
    app.setIntercept((url, options, { workspace }) => {
      if (!url.endsWith('/workflows/' + A + '/run')) return null;
      bodies.push(options.body); const operationId = JSON.parse(options.body).operationId;
      if (bodies.length === 1) { effects++; workspace.tasks.push({ id: B, title: 'One actual effect', status: 'todo' }); throw new Error('Synthetic response lost after acceptance'); }
      assert.equal(effects, 1);
      if (bodies.length === 2) return response({ id: A, status: 'running', code: 'workflow_running', steps: [], workspace });
      if (bodies.length === 4) { assert.notEqual(operationId, JSON.parse(bodies[0]).operationId); effects++; }
      return response({ id: A, status: 'completed', steps: [], workspace });
    });
    await app.ui.runWorkflow(flow); assert.equal(bodies.length, 1); assert.match(app.nodes.get('workflow-list').textContent, /Check last run/);
    const pending = JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns'));
    assert.deepEqual(pending, [{ workflowId: A, operationId: JSON.parse(bodies[0]).operationId }]);
    app.ui.applyToolCatalog({ tools: [], capabilityStatus: { ready: false, message: 'Current tool changed' } });
    await app.ui.runWorkflow({ ...flow, enabled: false, steps: [{ tool: 'cap_removed', arguments: {} }] });
    assert.equal(bodies[1], bodies[0]); assert.match(app.nodes.get('workflow-list').textContent, /still running/); assert.doesNotMatch(app.nodes.get('workflow-list').textContent, /Workflow stopped:/);
    await app.ui.runWorkflow(flow); assert.equal(bodies[2], bodies[0]); assert.match(app.nodes.get('workflow-list').textContent, /Workflow finished/);
    assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')), []);
    await app.ui.runWorkflow(flow); assert.equal(bodies.length, 4); assert.equal(effects, 2);
  } finally { app.close(); }
});

test('a reload retains only workflow request IDs and never sends the pending run until an explicit check', async () => {
  const flow = { id: A, name: 'Saved pending workflow', enabled: false, steps: [{ tool: 'cap_removed', arguments: { text: 'Original values remain on server' } }] };
  let posts = 0;
  const app = await createUI({ workspaceWorkflows: [flow], storedWorkflowRuns: [{ workflowId: A, operationId: B }], intercept: (url, options, { workspace }) => {
    if (!url.endsWith('/workflows/' + A + '/run')) return null;
    posts++; assert.deepEqual(JSON.parse(options.body), { operationId: B }); return response({ id: A, status: 'cancelled', error: 'Stopped after its recorded steps.', steps: [], workspace });
  } });
  try {
    assert.equal(posts, 0); const check = descendants(app.nodes.get('workflow-list')).find(node => node.tagName === 'button' && node.textContent === 'Check last run');
    assert.ok(check); assert.equal(check.disabled, false); await check.dispatch('click'); await until(() => /Workflow stopped:/.test(app.nodes.get('workflow-list').textContent));
    assert.equal(posts, 1); assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')), []);
    assert.ok([...app.storage.values()].every(value => !value.includes('Original values remain on server')));
  } finally { app.close(); }
});

test('long build instructions and summaries stay out of headings while exact criteria remain in a collapsed disclosure', async () => {
  const app = await createUI();
  try {
    const prompt = 'Build a duration formatter with a clear input and result. ' + 'Keep all requested behavior and verify every boundary case. '.repeat(200) + '\nExact final criterion: preserve this entire request.';
    const job = { id: A, prompt, summary: '', status: 'generating', createdAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:01Z', files: [], events: [{ at: '2026-10-24T12:00:01Z', type: 'generation', message: 'Generating the actual source.' }] };
    app.setIntercept(url => url.endsWith('/features') ? response({ jobs: [{ ...job, files: undefined }] }) : url.endsWith('/features/' + A) ? response(job) : null);
    await app.ui.refreshJobs(); await until(() => descendants(app.nodes.get('job-detail')).some(node => node.className?.includes('job-original-request')));
    const heading = descendants(app.nodes.get('job-detail')).find(node => node.tagName === 'h2');
    const card = descendants(app.nodes.get('job-list')).find(node => node.className === 'job-name');
    const original = descendants(app.nodes.get('job-detail')).find(node => node.className?.includes('job-original-request'));
    assert.ok(heading.textContent.length <= 84); assert.ok(card.textContent.length <= 64); assert.doesNotMatch(heading.textContent, /Exact final criterion/);
    assert.equal(original.open, false); assert.equal(original.children[0].textContent, 'Build instructions'); assert.equal(original.children[1].textContent, prompt);
    assert.match(app.nodes.get('job-detail').textContent, /Cancel build/); assert.match(app.nodes.get('job-detail').textContent, /Generating the actual source/);
    job.summary = 'Implemented a duration formatter. ' + 'Detailed implementation notes. '.repeat(65); job.status = 'review_required'; job.reviewRequired = true; job.updatedAt = '2026-10-24T12:00:02Z'; job.verification = { passed: true, checks: [{ name: 'Behavior check', passed: true, output: 'Boundary cases verified.' }] };
    await app.ui.refreshJobs(); await until(() => /Boundary cases verified/.test(app.nodes.get('job-detail').textContent));
    const updatedHeading = descendants(app.nodes.get('job-detail')).find(node => node.tagName === 'h2'); assert.ok(updatedHeading.textContent.length <= 84); assert.notEqual(updatedHeading.textContent, job.summary);
    assert.match(app.nodes.get('job-detail').textContent, /Activate feature/); assert.equal(descendants(app.nodes.get('job-detail')).find(node => node.className?.includes('job-original-request')).children[1].textContent, prompt);
  } finally { app.close(); }
});

const taskId = number => '00000000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
const taskFixture = (number, overrides = {}) => ({ id: taskId(number), title: 'Task ' + number, details: '', project: '', status: 'todo', priority: 'normal', dueAt: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(), ...overrides });
const visibleTaskIds = app => app.nodes.get('task-list').children.filter(node => node.className?.includes('task-row')).map(node => node.dataset.taskId);

test('task search covers all saved title, details and project text beyond the first hundred displayed matches', async () => {
  const old = taskFixture(1, { title: 'Old research task', details: 'Legacy integration marker', project: 'Archive research', createdAt: '2020-01-01T00:00:00Z' });
  const tasks = [old, ...Array.from({ length: 124 }, (_, index) => taskFixture(index + 2, { priority: 'high' }))];
  const app = await createUI({ workspaceTasks: tasks });
  try {
    assert.equal(visibleTaskIds(app).length, 50); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 50 of 125 matching tasks.');
    app.nodes.get('tasks-sort').value = 'priority'; await app.nodes.get('tasks-sort').dispatch('change');
    assert.equal(visibleTaskIds(app).includes(old.id), false);
    for (const query of ['old research', 'legacy marker', 'archive research']) { app.nodes.get('tasks-search').value = query; await app.nodes.get('tasks-search').dispatch('input'); assert.deepEqual(visibleTaskIds(app), [old.id]); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 1 of 1 matching task.'); }
    app.nodes.get('tasks-search').value = ''; await app.nodes.get('tasks-search').dispatch('input');
    await app.nodes.get('tasks-show-more').dispatch('click'); assert.equal(visibleTaskIds(app).length, 100); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 100 of 125 matching tasks.');
    assert.equal(app.nodes.get('tasks-show-more').textContent, 'Show 25 more'); await app.nodes.get('tasks-show-more').dispatch('click'); assert.equal(visibleTaskIds(app).length, 125); assert.equal(app.nodes.get('tasks-show-more').hidden, true);
    app.nodes.get('tasks-sort').value = 'created'; await app.nodes.get('tasks-sort').dispatch('change'); assert.equal(visibleTaskIds(app).length, 50);
  } finally { app.close(); }
});

test('project filters distinguish literal Unassigned and reserved-looking names from tasks with no project', async () => {
  const tasks = [taskFixture(1), taskFixture(2, { project: null }), taskFixture(3, { project: 'Unassigned' }), taskFixture(4, { project: 'No project' }), taskFixture(5, { project: 'All projects' }), taskFixture(6, { project: '__proto__' })];
  const app = await createUI({ workspaceTasks: tasks });
  try {
    const project = app.nodes.get('tasks-project');
    project.value = 'none'; await project.dispatch('change'); assert.deepEqual(visibleTaskIds(app), [tasks[0].id, tasks[1].id]);
    for (const name of ['Unassigned', 'No project', 'All projects', '__proto__']) { project.value = 'project:' + name; await project.dispatch('change'); assert.deepEqual(visibleTaskIds(app), [tasks.find(task => task.project === name).id]); }
    assert.ok(project.children.some(option => option.value === 'none' && option.textContent === 'No project'));
    assert.ok(project.children.some(option => option.value === 'project:No project' && option.textContent === 'No project (project)'));
  } finally { app.close(); }
});

test('task sorts use creation order, high priority and due dates with undated tasks last', async () => {
  const tasks = [taskFixture(5, { priority: 'high', dueAt: '2026-05-01T12:00:00Z' }), taskFixture(1), taskFixture(6, { createdAt: '2025-12-31T00:00:00Z' }), taskFixture(3, { priority: 'high', dueAt: '2026-05-01T12:00:00Z' }), taskFixture(2, { dueAt: '2026-05-10T12:00:00Z' }), taskFixture(4, { dueAt: 'invalid' })];
  const app = await createUI({ workspaceTasks: tasks });
  try {
    assert.deepEqual(visibleTaskIds(app), [6, 1, 2, 3, 4, 5].map(taskId));
    app.nodes.get('tasks-sort').value = 'priority'; await app.nodes.get('tasks-sort').dispatch('change'); assert.deepEqual(visibleTaskIds(app), [3, 5, 6, 1, 2, 4].map(taskId));
    app.nodes.get('tasks-sort').value = 'due'; await app.nodes.get('tasks-sort').dispatch('change'); assert.deepEqual(visibleTaskIds(app), [3, 5, 2, 6, 1, 4].map(taskId));
  } finally { app.close(); }
});

test('task filters and page size survive workspace updates and retain a project that no longer has tasks', async () => {
  const tasks = Array.from({ length: 130 }, (_, index) => taskFixture(index + 1, { title: 'Shared task ' + index, project: 'Retained project', priority: 'high' }));
  const app = await createUI({ workspaceTasks: tasks });
  try {
    app.nodes.get('tasks-project').value = 'project:Retained project'; await app.nodes.get('tasks-project').dispatch('change');
    app.nodes.get('tasks-sort').value = 'priority'; await app.nodes.get('tasks-sort').dispatch('change'); app.nodes.get('tasks-search').value = 'shared'; await app.nodes.get('tasks-search').dispatch('input'); await app.nodes.get('tasks-show-more').dispatch('click');
    app.nodes.get('new-task').value = 'An unsent task draft'; await app.nodes.get('task-list').children[0].children.at(-1).dispatch('click'); app.nodes.get('edit-text').value = 'An unsent edit draft';
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace')) return null; workspace.revision++; workspace.tasks = [taskFixture(500, { project: 'Other project' })]; return response(workspace); });
    await app.ui.refreshWorkspace(); assert.equal(app.nodes.get('tasks-project').value, 'project:Retained project'); assert.equal(app.nodes.get('tasks-search').value, 'shared'); assert.equal(app.nodes.get('tasks-sort').value, 'priority'); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 0 of 0 matching tasks.');
    assert.ok(app.nodes.get('tasks-project').children.some(option => option.value === 'project:Retained project' && /no tasks/.test(option.textContent)));
    assert.equal(app.nodes.get('new-task').value, 'An unsent task draft'); assert.equal(app.nodes.get('edit-text').value, 'An unsent edit draft');
    await app.nodes.get('edit-form').dispatch('submit', { preventDefault() {} }); assert.match(app.nodes.get('edit-error').textContent, /workspace changed/);
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace')) return null; workspace.revision++; workspace.tasks = tasks.slice(0, 120); return response(workspace); });
    await app.ui.refreshWorkspace(); assert.equal(visibleTaskIds(app).length, 100); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 100 of 120 matching tasks.');
  } finally { app.close(); }
});

test('filtered task completion and reopening still send actual workspace operations and update matching counts', async () => {
  const task = taskFixture(1, { title: 'Focused task', project: 'Focus' }), app = await createUI({ workspaceTasks: [task] });
  try {
    const operations = [];
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace/operations')) return null; const body = JSON.parse(options.body); operations.push(body); workspace.tasks[0].status = body.type === 'completeTask' ? 'done' : body.status; workspace.revision++; return response({ workspace, replayed: false }); });
    app.nodes.get('tasks-project').value = 'project:Focus'; await app.nodes.get('tasks-project').dispatch('change'); app.nodes.get('tasks-search').value = 'focused'; await app.nodes.get('tasks-search').dispatch('input');
    await app.nodes.get('task-list').children[0].children[0].dispatch('click'); assert.equal(operations[0].type, 'completeTask'); assert.equal(operations[0].taskId, task.id); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 0 of 0 matching tasks.');
    await app.nodes.get('toggle-completed').dispatch('click'); assert.deepEqual(visibleTaskIds(app), [task.id]); const reopen = app.nodes.get('task-list').children[0].children[0]; assert.match(reopen.attributes['aria-label'], /^Reopen task:/);
    await reopen.dispatch('click'); assert.equal(operations[1].type, 'updateTask'); assert.equal(operations[1].status, 'todo'); assert.equal(app.nodes.get('tasks-project').value, 'project:Focus'); assert.equal(app.nodes.get('tasks-search').value, 'focused'); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 1 of 1 matching task.');
  } finally { app.close(); }
});

test('long task details use a short preview and exact full-text disclosure that survives refresh and remains searchable and editable', async () => {
  const full = '<script>literal text</script>\n' + 'Detailed requirements and spaces  '.repeat(160) + '\nTail-only marker: final-criteria-742.';
  const task = taskFixture(1, { title: 'Long task', details: full }), app = await createUI({ workspaceTasks: [task, taskFixture(2)] });
  try {
    const row = app.nodes.get('task-list').children[0], preview = descendants(row).find(node => node.className === 'task-details'), disclosure = descendants(row).find(node => node.className === 'task-details-disclosure');
    assert.ok(preview.textContent.length <= 240); assert.match(preview.textContent, /…$/); assert.doesNotMatch(preview.textContent, /final-criteria-742/);
    assert.equal(disclosure.open, false); assert.equal(disclosure.children[0].textContent, 'Read all details'); assert.equal(disclosure.children[0].attributes['aria-label'], 'Read all details for task: Long task'); assert.equal(disclosure.children[1].textContent, full);
    assert.equal(descendants(row).some(node => node.tagName === 'script'), false);
    disclosure.open = true;
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace')) return null; workspace.revision++; return response(workspace); });
    await app.ui.refreshWorkspace(); let current = descendants(app.nodes.get('task-list')).find(node => node.className === 'task-details-disclosure'); assert.equal(current.open, true); assert.equal(current.children[1].textContent, full);
    current.open = false; await current.dispatch('toggle'); app.nodes.get('tasks-search').value = 'final-criteria-742'; await app.nodes.get('tasks-search').dispatch('input');
    assert.deepEqual(visibleTaskIds(app), [task.id]); current = descendants(app.nodes.get('task-list')).find(node => node.className === 'task-details-disclosure'); assert.equal(current.open, false);
    await app.nodes.get('task-list').children[0].children.at(-1).dispatch('click'); assert.equal(app.nodes.get('edit-text').value, full);
    assert.equal(app.requests.filter(request => request.method === 'POST' && request.url.endsWith('/workspace/operations')).length, 0);
  } finally { app.close(); }
});

const sourceWindowA = { id: 'window-a', title: 'Paper A', appName: 'Fixture reader', pid: 71 };
const sourceWindowB = { id: 'window-b', title: 'Paper B', appName: 'Fixture editor', pid: 72 };
const pinPacket = (id, window) => ({ id, window, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 28800000).toISOString() });

test('window context starts absent, is selected only explicitly, and stores no pin or title in browser storage', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    assert.equal(app.ui.get().selectedWindowContext, null); assert.equal(app.nodes.get('selected-window-context').hidden, true);
    app.ui.addMessage('assistant', 'Use Paper A as context'); assert.equal(app.ui.get().selectedWindowContext, null);
    await app.ui.selectWindowContext(sourceWindowA); const pin = app.ui.get().selectedWindowContext;
    assert.equal(pin.status, 'ready'); assert.equal(pin.window.title, 'Paper A'); assert.equal(app.nodes.get('selected-window-context').hidden, false); assert.match(app.nodes.get('window-context-status').textContent, /chosen AI with each question/);
    assert.deepEqual(JSON.parse(app.requests.find(request => request.url.endsWith('/context')).body), { windowId: 'window-a' });
    assert.equal(app.requests.filter(request => request.url.endsWith('/tools/run')).length, 0); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
    assert.ok([...app.storage.values()].every(value => !value.includes(pin.id) && !value.includes('Paper A')));
  } finally { app.close(); }
});

test('actual window-list context buttons name their individual window and select only the clicked row', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA, sourceWindowB] });
  try {
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/tools/run')) return null; const body = JSON.parse(options.body); assert.equal(body.tool, 'desktop_list_windows'); return response({ tool: body.tool, result: { windows: [sourceWindowA, sourceWindowB], truncated: false }, workspace }); });
    await app.nodes.get('desktop-window-list').dispatch('click');
    const controls = descendants(app.nodes.get('desktop-window-results')).filter(node => node.tagName === 'button' && node.textContent === 'Use as context');
    assert.deepEqual(controls.map(node => node.attributes['aria-label']), ['Use as context: Paper A', 'Use as context: Paper B']);
    await controls[0].dispatch('click'); await until(() => app.ui.get().selectedWindowContext?.status === 'ready');
    assert.equal(app.ui.get().selectedWindowContext.window.id, sourceWindowA.id); assert.equal(app.requests.filter(request => request.url.endsWith('/context')).length, 1);
  } finally { app.close(); }
});

test('voice freezes its selected source before permission and an old source cannot retarget a new question', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA, sourceWindowB] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const firstId = app.ui.get().selectedWindowContext.id;
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); assert.equal(app.ui.get().voiceCaptureContext.windowContext.id, firstId);
    app.grantMicrophone(); await opening; const recorded = copy(app.ui.get().recording);
    await app.ui.selectWindowContext(sourceWindowB); assert.equal(app.stoppedTracks, 1);
    await app.ui.runCommand('Explain the old source', { voice: true, providerId: recorded.providerId, conversationContext: recorded.conversationContext, windowContext: recorded.windowContext, approvalContext: null });
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.match(app.nodes.get('question-error').textContent, /context changed or is unavailable/);
    await app.ui.runCommand('Explain Paper B'); const question = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body);
    assert.equal(question.contextId, app.ui.get().selectedWindowContext.id); assert.notEqual(question.contextId, firstId); assert.equal('windowText' in question, false);
  } finally { app.close(); }
});

test('clearing while microphone permission is pending cancels capture and releases the original pin', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const id = app.ui.get().selectedWindowContext.id, opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone);
    await app.ui.clearWindowContext(); assert.equal(app.ui.get().selectedWindowContext, null); assert.equal(app.nodes.get('selected-window-context').hidden, true);
    app.grantMicrophone(); await opening; await until(() => app.stoppedTracks === 1);
    assert.equal(app.ui.get().recording, null); assert.equal(app.ui.get().activeRequest, null); assert.equal(app.requests.some(request => request.url.endsWith('/context/' + id + '/clear')), true);
    assert.equal(app.requests.filter(request => /\/(?:chat|transcribe)$/.test(request.url)).length, 0);
  } finally { app.close(); }
});

test('clearing context cancels an in-flight transcription and never forwards its late words to chat', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    const frozen = copy(app.ui.get().recording), transcript = deferred(); let requestId;
    app.setIntercept((url, options) => { if (!url.endsWith('/transcribe')) return null; requestId = options.headers.get('X-Request-Id'); return transcript.promise; });
    const processing = app.ui.processVoiceSegment({ blob: new Blob(['synthetic audio']), context: frozen, signal: new AbortController().signal }); await until(() => !!requestId);
    await app.ui.clearWindowContext(); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().activeRequest, null);
    transcript.resolve(response({ id: requestId, text: 'Explain this document' })); await processing;
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.equal(app.requests.some(request => request.url.endsWith('/cancel') && JSON.parse(request.body).id === requestId), true);
  } finally { app.close(); }
});

test('clearing context cancels its active chat request and ignores a late response from that source', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const contextId = app.ui.get().selectedWindowContext.id, pending = deferred(); let request;
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null; request = JSON.parse(options.body); const record = records.get(request.conversationId);
      record.turns.push({ id: request.id, message: request.message, status: 'running' }); record.activeRequestId = request.id; record.revision++; return pending.promise;
    });
    const asking = app.ui.runCommand('Explain Paper A'); await until(() => !!request); assert.equal(request.contextId, contextId);
    await app.ui.clearWindowContext(); assert.equal(app.ui.get().activeRequest, null); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().selectedWindowContext, null);
    pending.resolve(response({ id: request.id, text: 'Late answer from the cleared source', actions: [], windowContext: { contextId, title: 'Paper A', readAt: new Date().toISOString() } })); await asking;
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Late answer from the cleared source/); assert.equal(app.requests.some(item => item.url.endsWith('/cancel') && JSON.parse(item.body).id === request.id), true);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('a late pin response is released instead of replacing a newer explicitly selected window', async () => {
  const first = deferred(), app = await createUI();
  try {
    app.setIntercept((url, options) => { if (!url.endsWith('/context')) return null; return JSON.parse(options.body).windowId === sourceWindowA.id ? first.promise : response({ context: pinPacket('pin-b', sourceWindowB) }); });
    const selectingFirst = app.ui.selectWindowContext(sourceWindowA); await app.ui.selectWindowContext(sourceWindowB);
    first.resolve(response({ context: pinPacket('pin-a', sourceWindowA) })); await selectingFirst;
    assert.equal(app.ui.get().selectedWindowContext.id, 'pin-b'); assert.match(app.nodes.get('window-context-label').textContent, /Paper B/);
    assert.equal(app.requests.some(request => request.url.endsWith('/context/pin-a/clear')), true);
  } finally { app.close(); }
});

test('failed replacement and attachment failure stay unavailable until Clear or reselect without source fallback', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA, sourceWindowB] });
  try {
    await app.ui.selectWindowContext(sourceWindowA);
    app.setIntercept((url, options) => url.endsWith('/context') && JSON.parse(options.body).windowId === sourceWindowB.id ? response({ error: { code: 'window_context_unavailable', message: 'Paper B is no longer available.' } }, 409) : null);
    await app.ui.selectWindowContext(sourceWindowB); assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.equal(app.ui.get().selectedWindowContext.id, null); assert.match(app.nodes.get('window-context-label').textContent, /Paper B/);
    app.nodes.get('question').value = 'Keep this draft'; await app.ui.runCommand('Keep this draft'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.equal(app.nodes.get('question').value, 'Keep this draft');
    await app.ui.clearWindowContext(); app.setIntercept(null); await app.ui.selectWindowContext(sourceWindowA);
    app.setIntercept(url => url.endsWith('/chat') ? response({ error: { code: 'window_context_empty', message: 'This window has no readable text.' } }, 409) : null);
    await app.ui.runCommand('Explain this source'); assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.match(app.nodes.get('window-context-status').textContent, /no readable text/);
    await app.ui.runCommand('Try another question'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1);
    await app.ui.clearWindowContext(); app.setIntercept(null); await app.ui.runCommand('A question without window text'); const last = app.requests.filter(request => request.url.endsWith('/chat')).at(-1); assert.equal('contextId' in JSON.parse(last.body), false);
  } finally { app.close(); }
});

test('expiry and worker restart invalidate context including a pin request that resolves after restart', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); app.ui.get().selectedWindowContext.expiresAt = new Date(Date.now() - 1).toISOString(); app.ui.renderWindowContext();
    assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.match(app.nodes.get('window-context-status').textContent, /expired/); await app.ui.runCommand('Explain'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
    await app.ui.clearWindowContext(); const pending = deferred(); app.setIntercept(url => url.endsWith('/context') ? pending.promise : null);
    const selecting = app.ui.selectWindowContext(sourceWindowA); app.ui.applyRuntime({ managed: true, restarting: false, workerPid: 101 });
    pending.resolve(response({ context: pinPacket('old-worker-pin', sourceWindowA) })); await selecting;
    assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.equal(app.ui.get().selectedWindowContext.id, null); assert.match(app.nodes.get('window-context-status').textContent, /restarted/); assert.equal(app.requests.some(request => request.url.endsWith('/context/old-worker-pin/clear')), true);
  } finally { app.close(); }
});

test('saved answer provenance shows the actual fresh window title, read time and truncation without persisting the pin in browser storage', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const contextId = app.ui.get().selectedWindowContext.id;
    app.setIntercept((url, options, { records, workspace }) => {
      if (!url.endsWith('/chat')) return null; const body = JSON.parse(options.body), record = records.get(body.conversationId);
      const windowContext = { contextId, windowId: sourceWindowA.id, title: 'Paper A — revised title', appName: sourceWindowA.appName, readAt: '2026-10-24T15:30:00Z', sourceTruncated: true, formatterTruncated: false, truncated: true, empty: false };
      const reply = { id: body.id, text: 'An explanation grounded in the fresh read.', actions: [], providerId: body.providerId, windowContext }; record.turns.push({ id: body.id, message: body.message, status: 'completed', reply }); record.revision += 2; return response({ ...reply, conversationId: record.id, conversationRevision: record.revision, workspace });
    });
    await app.ui.runCommand('Explain the selected window'); const source = descendants(app.nodes.get('messages')).find(node => node.className === 'window-context-source');
    assert.match(source.textContent, /Paper A — revised title/); assert.match(source.textContent, /Read /); assert.match(source.textContent, /Some window text was omitted/); assert.equal(app.ui.get().selectedWindowContext.window.title, 'Paper A — revised title');
    await app.ui.refreshConversation(); assert.equal(descendants(app.nodes.get('messages')).filter(node => node.className === 'window-context-source').length, 1);
    const saved = app.records.get(app.ui.get().id); saved.turns.push({ id: 'interrupted-before-read', message: 'A question interrupted before its read', status: 'interrupted', error: { message: 'Companion restarted before this read completed.', actions: [], windowContext: { contextId, windowId: sourceWindowA.id, title: 'Paper A selected only', appName: sourceWindowA.appName } } }); saved.revision++;
    await app.ui.refreshConversation(); const selectedOnly = descendants(app.nodes.get('messages')).filter(node => node.className === 'window-context-source').at(-1);
    assert.match(selectedOnly.textContent, /^Selected source: Paper A selected only/); assert.match(selectedOnly.textContent, /No completed read recorded\./); assert.doesNotMatch(selectedOnly.textContent, /Read unknown time|Window source:|text was omitted/);
    assert.ok([...app.storage.values()].every(value => !value.includes(contextId) && !value.includes('Paper A')));
  } finally { app.close(); }
});


const workFixture = (id, values = {}) => ({ id, conversationId: id, requestId: 'work_' + id, title: 'Background review', prompt: 'Review the saved tasks without starting another request.', providerId: 'codex', provider: { id: 'codex', label: 'GPT', type: 'codex', model: '' }, status: 'queued', createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', progress: { message: 'Queued for a worker', events: [] }, ...values });

test('a handoff freezes its provider and source, stays independent of the live turn, and stores only its pending ID', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const sourceId = app.ui.get().selectedWindowContext.id, accepted = deferred();
    app.setIntercept((url, options) => url.endsWith('/work') && options.method === 'POST' ? accepted.promise : null);
    app.nodes.get('work-prompt').value = 'Exact private handoff draft'; const handoff = app.ui.submitWork();
    await until(() => app.requests.some(request => request.url.endsWith('/work')));
    const request = app.requests.find(request => request.url.endsWith('/work')), body = JSON.parse(request.body);
    assert.equal(body.prompt, 'Exact private handoff draft'); assert.equal(body.providerId, 'codex'); assert.equal(body.contextId, sourceId);
    assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().activeRequest, null);
    assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkIds')), [body.id]);
    assert.ok([...app.storage.values()].every(value => !value.includes(body.prompt) && !value.includes(sourceId)));
    app.ui.applyProviders({ providers: [{ id: 'other', label: 'Other AI', type: 'compatible', model: 'new-model', ready: true }], activeProviderId: 'other' });
    await app.ui.clearWindowContext(); app.ui.cancelTurn(false); app.nodes.get('work-prompt').value = 'A newer unsent draft';
    accepted.resolve(response({ job: workFixture(body.id, { prompt: body.prompt }) })); await handoff;
    assert.equal(app.ui.get().workJobs[0].provider.id, 'codex'); assert.equal(app.nodes.get('work-prompt').value, 'A newer unsent draft'); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    assert.equal(app.requests.some(request => request.url.includes('/work/') && request.url.endsWith('/cancel')), false);
  } finally { app.close(); }
});

test('an uncertain work submission offers GET-only Check handoff with its original ID and never repeats the POST', async () => {
  const app = await createUI();
  try {
    let acceptedId;
    app.setIntercept((url, options) => { if (!url.endsWith('/work') || options.method !== 'POST') return null; const body = JSON.parse(options.body); acceptedId = body.id; app.workRecords.set(body.id, workFixture(body.id, { prompt: body.prompt, status: 'running' })); throw new Error('Synthetic dropped response'); });
    app.nodes.get('work-prompt').value = 'Keep this handoff exactly once'; await app.ui.submitWork();
    assert.equal(app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST').length, 1);
    assert.equal(app.nodes.get('work-submit').disabled, true); assert.match(app.nodes.get('work-handoffs').textContent, /Check handoff/);
    await app.ui.submitWork(); assert.equal(app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST').length, 1);
    app.setIntercept(null); const check = descendants(app.nodes.get('work-handoffs')).find(node => node.textContent === 'Check handoff'); await check.dispatch('click'); await until(() => app.ui.get().pendingWorkIds.length === 0);
    assert.equal(app.ui.get().selectedWorkId, acceptedId); assert.equal(app.ui.get().workJobs[0].status, 'running'); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    assert.equal(app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST').length, 1);
    assert.equal(app.nodes.get('work-prompt').value, 'Keep this handoff exactly once'); assert.match(app.nodes.get('work-detail').textContent, /Working/);
  } finally { app.close(); }
});

test('a reload checks a pending handoff only on explicit request and a missing receipt permits a deliberate new handoff', async () => {
  const app = await createUI({ storedWorkIds: [A] });
  try {
    assert.equal(app.requests.some(request => request.url.startsWith('/api/assistant/work/' + A)), false);
    assert.equal(app.requests.some(request => request.url.endsWith('/work') && request.method === 'POST'), false);
    assert.match(app.nodes.get('work-handoffs').textContent, /Check handoff/); await app.ui.checkWorkHandoff(A);
    assert.match(app.nodes.get('work-error').textContent, /No saved handoff was found/); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    app.nodes.get('work-prompt').value = 'A deliberate new attempt'; await app.ui.submitWork();
    const posts = app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST'); assert.equal(posts.length, 1); assert.notEqual(JSON.parse(posts[0].body).id, A);
  } finally { app.close(); }
});

test('a real work receipt releases the foreground turn and a second question can continue while work is running', async () => {
  const job = workFixture(B, { status: 'running' }), app = await createUI({ saved: [blank(A)], selected: A });
  try {
    let questions = 0; app.workRecords.set(B, job); app.records.set(B, blank(B, job.title));
    app.setIntercept((url, options, { records }) => { if (!url.endsWith('/chat')) return null; const body = JSON.parse(options.body), record = records.get(body.conversationId), reply = { id: body.id, text: ++questions === 1 ? 'Handed off. You can keep talking.' : 'Here is the next reply.', providerId: body.providerId, actions: questions === 1 ? [{ id: 'delegate', tool: 'manage_work', arguments: { action: 'start' }, status: 'completed', result: { workJob: job, message: 'Handed off; not completed yet' } }] : [] }; record.turns.push({ id: body.id, message: body.message, status: 'completed', reply }); record.revision += 2; return response(reply); });
    await app.ui.runCommand('Work on this in the background'); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().activeRequest, null);
    assert.equal(app.ui.get().workJobs.find(item => item.id === B).status, 'running'); assert.match(app.nodes.get('messages').textContent, /Work handed off/); assert.match(app.nodes.get('messages').textContent, /Open work/);
    await app.ui.runCommand('And answer another question'); assert.equal(questions, 2); assert.equal(app.ui.get().id, A); assert.match(app.nodes.get('messages').textContent, /next reply/);
    app.ui.cancelTurn(false); assert.equal(app.requests.some(request => request.url.endsWith('/work/' + B + '/cancel')), false);
    const open = descendants(app.nodes.get('messages')).find(node => node.textContent === 'Open work'); await open.dispatch('click'); await until(() => app.ui.get().selectedWorkId === B);
    assert.equal(app.ui.get().currentView, 'work'); assert.equal(app.ui.get().chatOpen, false);
  } finally { app.close(); }
});

test('work list and outcome pages remain explicit and preserve complete text and actual action receipts after refresh', async () => {
  const tasks = Array.from({ length: 23 }, (_, index) => workFixture('10000000-0000-4000-8000-' + String(index).padStart(12, '0'), { createdAt: new Date(Date.UTC(2026, 9, 25, 12, index)).toISOString() }));
  const text = 'First paragraph. ' + 'exact result '.repeat(800) + 'Final paragraph.';
  tasks[22] = { ...tasks[22], status: 'failed', outcome: { status: 'failed', text, error: { code: 'partial_failure', message: 'Stopped after the saved actions below.' }, actions: Array.from({ length: 27 }, (_, index) => ({ id: 'receipt-' + index, tool: 'save_note', status: 'completed', result: { note: { title: 'Actual note ' + index } } })) } };
  const app = await createUI({ savedWork: tasks });
  try {
    await app.ui.refreshWork(); assert.equal(app.ui.get().workJobs.length, 20); assert.match(app.nodes.get('work-count').textContent, /20 of 23/);
    await app.nodes.get('work-more').dispatch('click'); await until(() => app.ui.get().workJobs.length === 23); assert.match(app.nodes.get('work-count').textContent, /23 of 23/); assert.equal(app.nodes.get('work-more').hidden, true);
    const id = tasks[22].id; app.ui.selectWork(id); await app.ui.refreshWorkDetail(id);
    assert.equal(app.ui.get().workDetails.find(item => item.id === id).outcome.text.length, 4000); assert.match(app.nodes.get('work-detail').textContent, /Stopped after the saved actions/);
    while (app.ui.get().workDetails.find(item => item.id === id).outcome.textHasMore) await app.ui.loadWorkOutcome(id, 'text');
    while (app.ui.get().workDetails.find(item => item.id === id).outcome.actionsHasMore) await app.ui.loadWorkOutcome(id, 'actions');
    const outcome = app.ui.get().workDetails.find(item => item.id === id).outcome; assert.equal(outcome.text, text); assert.equal(outcome.actions.length, 27); assert.match(app.nodes.get('work-detail').textContent, /Actual note 26/);
    await app.ui.refreshWorkDetail(id); assert.equal(app.ui.get().workDetails.find(item => item.id === id).outcome.text, text); assert.equal(app.ui.get().workDetails.find(item => item.id === id).outcome.actions.length, 27);
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 0);
  } finally { app.close(); }
});

test('late work detail and ID-scoped stop never retarget the selected work or another conversation', async () => {
  const app = await createUI({ saved: [blank(A), blank(B)], savedWork: [workFixture(A), workFixture(B)] });
  try {
    await app.ui.refreshWork(); const late = deferred(); app.setIntercept(url => url.includes('/work/' + A + '?') ? late.promise : null);
    app.ui.selectWork(A); app.ui.selectWork(B); await app.ui.refreshWorkDetail(B);
    late.resolve(response({ job: workFixture(A, { status: 'completed', outcome: { status: 'completed', text: 'Late A output', actions: [] } }) })); await until(() => app.ui.get().workDetails.some(item => item.id === A && item.status === 'completed'));
    assert.equal(app.ui.get().selectedWorkId, B); assert.doesNotMatch(app.nodes.get('work-detail').textContent, /Late A output/);
    app.setIntercept(null); await app.ui.cancelWork(A); assert.equal(app.ui.get().selectedWorkId, B); assert.equal(app.workRecords.get(A).status, 'cancelled'); assert.equal(app.workRecords.get(B).status, 'queued');
    assert.equal(app.requests.filter(request => /work\/[^/]+\/cancel$/.test(request.url)).length, 1);
    const capture = app.ui.startRecording(); await until(() => app.waitingForMicrophone); await app.ui.openWorkConversation(B); assert.notEqual(app.ui.get().id, B); app.ui.cancelTurn(false); if (app.waitingForMicrophone) app.grantMicrophone(); await capture;
    await app.ui.openWorkConversation(B); assert.equal(app.ui.get().id, B); assert.equal(app.ui.get().chatOpen, true);
  } finally { app.close(); }
});

test('Work stays behind Tools and only an actual human voice navigation command opens it', async () => {
  const app = await createUI({ savedWork: [workFixture(A, { status: 'failed', progress: { message: 'Latest saved update', events: [{ at: '2026-10-25T12:00:00Z', type: 'running', message: 'Earlier actual progress' }] }, outcome: { status: 'failed', error: { code: 'provider_changed', message: 'The frozen provider configuration changed.' }, text: '', actions: [] } })] });
  try {
    await app.ui.refreshWork(); assert.equal(app.ui.get().currentView, 'today'); assert.equal(app.ui.get().chatOpen, false);
    app.ui.addMessage('assistant', 'show work'); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.runCommand('Show work.', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.equal(app.ui.get().currentView, 'work'); assert.match(app.nodes.get('work-detail').textContent, /frozen provider configuration changed/);
    const progress = app.nodes.get('work-detail').querySelectorAll('.work-progress')[0]; assert.equal(progress.tagName, 'details'); assert.equal(progress.open, false); assert.equal(progress.children[0].textContent, 'Progress'); assert.match(app.nodes.get('work-detail').textContent, /Latest saved update/); assert.equal(app.nodes.get('work-detail').querySelectorAll('.work-original')[0].open, false); progress.open = true;
    const job = app.workRecords.get(A); job.status = 'waiting_for_review'; job.updatedAt = '2026-10-25T14:00:00Z'; job.outcome = { status: 'waiting_for_review', text: 'Input is prepared, not executed.', actions: [{ id: 'prepared', tool: 'desktop_propose_action', status: 'completed', result: { desktopAction: { id: 'pending-review', status: 'pending', summary: 'Exact prepared input', expiresAt: new Date(Date.now() + 60000).toISOString() } } }] }; await app.ui.refreshWorkDetail(A);
    assert.equal(app.nodes.get('work-detail').querySelectorAll('.work-progress')[0].open, true); assert.match(app.nodes.get('work-detail').querySelectorAll('.work-progress')[0].textContent, /Earlier actual progress/);
    assert.equal(descendants(app.nodes.get('work-detail')).some(node => node.textContent === 'Stop this work'), false); assert.equal(descendants(app.nodes.get('work-detail')).some(node => node.textContent === 'Open conversation'), true); assert.equal(descendants(app.nodes.get('work-detail')).some(node => node.textContent === 'Review computer action'), true);
    job.status = 'running'; job.cancelRequested = true; job.updatedAt = '2026-10-25T14:01:00Z'; await app.ui.refreshWorkDetail(A); const stopping = descendants(app.nodes.get('work-detail')).find(node => node.textContent === 'Stop this work'); assert.equal(stopping.disabled, true); assert.match(app.nodes.get('work-detail').textContent, /Stopping…/);
    assert.equal(app.requests.some(request => request.method === 'POST'), false);
    assert.match(html, /id="tools-menu"[^]*id="work-open"/); assert.doesNotMatch(html.split('id="tools-menu"')[0], /id="work-open"/);
  } finally { app.close(); }
});


test('uncertain checks and conversation opening respect a newer work selection, and an unconfirmed stop reads without repeating effects', async () => {
  const app = await createUI({ saved: [blank(A), blank(B)], selected: A, savedWork: [workFixture(A, { status: 'running' }), workFixture(B)], storedWorkIds: [A] });
  try {
    await app.ui.refreshWork(); const checking = deferred(); app.setIntercept(url => url.includes('/work/' + A + '?') ? checking.promise : null);
    const check = app.ui.checkWorkHandoff(A); app.ui.selectWork(B); await app.ui.refreshWorkDetail(B);
    checking.resolve(response({ job: workFixture(A, { status: 'running' }) })); await check;
    assert.equal(app.ui.get().selectedWorkId, B); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    const listing = deferred(); app.setIntercept((url, options) => url.endsWith('/conversations') && !options.method ? listing.promise : null);
    const opening = app.ui.openWorkConversation(B); app.ui.selectWork(A); listing.resolve(response({ conversations: [blank(A), blank(B)].map(item => ({ ...item, turnCount: 0 })) })); await opening;
    assert.equal(app.ui.get().id, A); assert.equal(app.ui.get().chatOpen, false); assert.equal(app.ui.get().selectedWorkId, A);
    await app.ui.refreshWorkDetail(A); const confirmation = deferred();
    app.setIntercept((url, options) => { if (url.endsWith('/work/' + A + '/cancel') && options.method === 'POST') { app.workRecords.get(A).status = 'cancelled'; throw new Error('Synthetic stop response lost'); } if (url.includes('/work/' + A + '?')) return confirmation.promise; return null; });
    await app.ui.cancelWork(A); assert.match(app.nodes.get('work-error').textContent, /stop was not confirmed/); assert.equal(app.ui.get().workJobs.find(item => item.id === A).status, 'running');
    app.ui.selectWork(B); await app.ui.refreshWorkDetail(B); confirmation.resolve(response({ job: workFixture(A, { status: 'cancelled', updatedAt: '2026-10-25T15:00:00Z' }) })); await until(() => app.ui.get().workJobs.find(item => item.id === A).status === 'cancelled');
    assert.equal(app.ui.get().selectedWorkId, B); assert.equal(app.requests.filter(request => request.url.endsWith('/work/' + A + '/cancel')).length, 1);
  } finally { app.close(); }
});

test('a ready work result preserves its separately queued feature build and opens the actual build history', async () => {
  const build = { id: '33333333-3333-4333-8333-333333333333', status: 'queued', prompt: 'Build the requested panel', createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', progress: { message: 'Queued' } };
  const job = workFixture(A, { status: 'completed', outcome: { status: 'completed', text: 'The feature build is queued separately.', actions: [{ id: 'build-request', tool: 'build_feature', status: 'completed', result: { featureJob: build } }] } });
  const app = await createUI({ savedWork: [job], intercept: url => url.endsWith('/features/' + build.id) ? response(build) : null });
  try {
    await app.ui.refreshWork(); assert.match(app.nodes.get('work-detail').textContent, /Result ready/); assert.match(app.nodes.get('work-detail').textContent, /Feature build · Queued \(saved status\)/); assert.doesNotMatch(app.nodes.get('work-detail').textContent, /Feature activated|ready to use/);
    const open = descendants(app.nodes.get('work-detail')).find(node => node.textContent === 'View feature build ↗'); assert.ok(open); await open.dispatch('click'); assert.equal(app.ui.get().currentView, 'build');
    assert.equal(app.requests.some(request => request.method === 'POST'), false);
  } finally { app.close(); }
});


const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444', E = '55555555-5555-4555-8555-555555555555', F = '66666666-6666-4666-8666-666666666666';
const serviceFixture = values => ({ managed: true, restarting: false, hostPid: 10, workerPid: 100, supervisorPid: 5, hostInstanceId: A, workerInstanceId: B, supervisorInstanceId: C, hostRestartAvailable: true, ...values });
const freshService = () => serviceFixture({ hostPid: 20, workerPid: 200, hostInstanceId: D, workerInstanceId: E });
const delayTurn = () => new Promise(resolve => setTimeout(resolve, 15));

test('full service reconnect rejects a new worker under the same host and requires final workspace readiness while preserving drafts and view', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline });
  try {
    app.ui.showView('tasks'); app.nodes.get('question').value = 'An unsent chat draft'; app.nodes.get('work-prompt').value = 'An unsent handoff'; app.nodes.get('new-task').value = 'An unsent task';
    let phase = 'worker', observations = 0, failedWorkspace = 0, workspaceReady = false, posted = false;
    app.setIntercept((url, options) => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ ...freshService(), restartScope: 'host', restartRequested: true }); } if (url.endsWith('/runtime')) { if (!posted) return response(baseline); observations++; return response(phase === 'worker' ? serviceFixture({ workerPid: 200, workerInstanceId: E }) : freshService()); } if (url.endsWith('/workspace') && phase === 'fresh' && !workspaceReady) { failedWorkspace++; return response({ error: { code: 'opening', message: 'Workspace is still opening' } }, 503); } return null; });
    const restart = app.ui.restartCompanionService(); await until(() => observations > 0);
    assert.equal(app.ui.get().reconnecting, true); assert.equal(app.ui.get().runtimeRetry.baseline.hostInstanceId, A); assert.equal(app.ui.get().runtimeRetry.baseline.workerPid, 100); assert.notEqual(app.ui.get().runtimeNotice.phase, 'ready');
    phase = 'fresh'; while (!failedWorkspace) await delayTurn(); assert.equal(app.ui.get().reconnecting, true); assert.notEqual(app.ui.get().runtimeNotice.phase, 'ready'); workspaceReady = true;
    const result = await restart; assert.equal(result.confirmed, true); assert.match(app.nodes.get('runtime-message').textContent, /service restarted and reconnected/);
    assert.equal(app.nodes.get('question').value, 'An unsent chat draft'); assert.equal(app.nodes.get('work-prompt').value, 'An unsent handoff'); assert.equal(app.nodes.get('new-task').value, 'An unsent task'); assert.equal(app.ui.get().currentView, 'tasks'); assert.equal(app.ui.get().chatOpen, false);
    const posts = app.requests.filter(request => request.url.endsWith('/runtime/restart')); assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0].body), { scope: 'host' }); assert.equal(app.nodes.get('restart-runtime').disabled, false); assert.equal(app.nodes.get('connection-label').textContent, 'GPT is ready');
    assert.doesNotMatch(app.nodes.get('runtime-message').textContent, /desktop|Electron|package/i);
  } finally { app.close(); }
});

test('a lost restart acknowledgement observes the frozen baseline, recovers a fresh session and never repeats the restart POST', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline });
  try {
    let sessionReads = 0, posted = false; app.setIntercept((url, options) => { if (url.endsWith('/runtime/restart')) { posted = true; throw new Error('Synthetic acknowledgement lost'); } if (url.endsWith('/session') && posted && ++sessionReads === 1) return response({ error: { code: 'expired', message: 'Old session expired' } }, 401); if (url.endsWith('/runtime')) return response(posted ? freshService() : baseline); return null; });
    const result = await app.ui.restartCompanionService(); assert.equal(result.confirmed, true); assert.ok(sessionReads >= 2); assert.equal(app.requests.filter(request => request.url.endsWith('/runtime/restart')).length, 1); assert.equal(app.ui.get().runtimeInfo.hostInstanceId, D);
  } finally { app.close(); }
});

test('host timeout and Check again keep the original scope and identities and only perform reads', async () => {
  const baseline = serviceFixture(), clock = { value: Date.now() }, app = await createUI({ runtimeBaseline: baseline, runtimeClock: clock });
  try {
    let changed = false, posted = false; app.nodes.get('question').value = 'Keep this draft through a failed restart';
    app.setIntercept((url, options) => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ ...baseline, restartScope: 'host', restartRequested: true }); } if (url.endsWith('/runtime')) { if (!posted) return response(baseline); if (!changed) clock.value += 31000; return response(changed ? freshService() : serviceFixture({ workerPid: 200, workerInstanceId: E })); } return null; });
    const result = await app.ui.restartCompanionService(); assert.equal(result.confirmed, false); assert.match(app.nodes.get('runtime-message').textContent, /not confirmed a new service host and worker/); assert.equal(app.ui.get().runtimeRetry.scope, 'host'); assert.equal(app.ui.get().runtimeRetry.baseline.hostInstanceId, A); assert.equal(app.nodes.get('runtime-retry').hidden, false);
    const before = app.requests.filter(request => request.method === 'POST').length; changed = true; await app.nodes.get('runtime-retry').dispatch('click'); await until(() => app.ui.get().runtimeNotice.phase === 'ready');
    assert.equal(app.requests.filter(request => request.method === 'POST').length, before); assert.equal(app.ui.get().runtimeRetry, null); assert.equal(app.nodes.get('question').value, 'Keep this draft through a failed restart'); assert.equal(app.ui.get().chatOpen, false);
  } finally { app.close(); }
});

test('legacy worker restart remains compatible and an available worker identity cannot be reused as proof', async () => {
  const app = await createUI({ runtimeBaseline: { managed: true, restarting: false, workerPid: 100 } });
  try {
    let posted = false; app.setIntercept(url => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ managed: true, workerPid: 100, restartScope: 'worker', restartRequested: true }); } return url.endsWith('/runtime') ? response({ managed: true, restarting: false, workerPid: posted ? 101 : 100 }) : null; });
    const result = await app.ui.restartCompanionService(); assert.equal(result.confirmed, true); const post = app.requests.find(request => request.url.endsWith('/runtime/restart')); assert.deepEqual(JSON.parse(post.body), { scope: 'worker' }); assert.match(app.nodes.get('runtime-message').textContent, /worker restarted/);
    assert.equal(app.ui.runtimeRestartConfirmed(serviceFixture({ workerPid: 101 }), serviceFixture(), 'worker'), false); assert.equal(app.ui.runtimeRestartConfirmed(serviceFixture({ workerPid: 101, workerInstanceId: E }), serviceFixture(), 'worker'), true);
  } finally { app.close(); }
});

test('launcher updates stay manual and Check again requires a new supervisor as well as host and worker', async () => {
  const baseline = serviceFixture(), clock = { value: Date.now() }, app = await createUI({ runtimeBaseline: baseline, runtimeClock: clock });
  try {
    const result = await app.ui.reconnectAfterRestart({ ...baseline, restartScope: 'launcher', requiresManualRestart: true }, { baseline }); assert.equal(result.manual, true); assert.match(app.nodes.get('runtime-message').textContent, /owning Companion launcher/); assert.equal(app.requests.some(request => request.method === 'POST'), false);
    let relaunched = false; app.setIntercept(url => { if (!url.endsWith('/runtime')) return null; if (!relaunched) clock.value += 31000; return response(relaunched ? freshServiceWithSupervisor() : freshService()); });
    await app.nodes.get('runtime-retry').dispatch('click'); await until(() => app.ui.get().reconnecting); while (app.ui.get().reconnecting) await delayTurn(); assert.equal(app.ui.get().runtimeNotice.phase, 'failed'); assert.match(app.nodes.get('runtime-message').textContent, /new launcher, service host and worker/);
    relaunched = true; await app.nodes.get('runtime-retry').dispatch('click'); await until(() => app.ui.get().runtimeNotice.phase === 'ready'); assert.match(app.nodes.get('runtime-message').textContent, /launcher restarted/); assert.equal(app.requests.some(request => request.method === 'POST'), false);
    const legacy = { managed: true, workerPid: 100, hostPid: 10 }; assert.equal(app.ui.runtimeRestartConfirmed(freshServiceWithSupervisor(), legacy, 'launcher'), true); assert.equal(app.ui.runtimeRestartConfirmed({ ...freshService(), supervisorInstanceId: undefined }, legacy, 'launcher'), false);
  } finally { app.close(); }
});
function freshServiceWithSupervisor(){return { ...freshService(), supervisorPid: 6, supervisorInstanceId: F };}

test('reconnected rollback is reported as restored source and never as activation', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline });
  try {
    app.setIntercept(url => url.endsWith('/runtime') ? response(freshService()) : url.endsWith('/features/' + C) ? response({ id: C, status: 'rolled_back', prompt: 'Synthetic update', updatedAt: '2026-10-25T12:00:00Z', createdAt: '2026-10-25T12:00:00Z' }) : null);
    const result = await app.ui.reconnectAfterRestart({ ...baseline, restartScope: 'host', restartRequested: true }, { baseline, jobId: C, action: 'apply' }); assert.equal(result.confirmed, true); assert.equal(app.ui.get().runtimeNotice.phase, 'rolled-back'); assert.match(app.nodes.get('runtime-message').textContent, /restored the previous version/); assert.doesNotMatch(app.nodes.get('runtime-message').textContent, /activated|Electron|desktop app/);
  } finally { app.close(); }
});

test('a changed service instance invalidates selected window context even when operating-system PIDs are reused', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline, contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); app.ui.applyRuntime({ ...baseline, hostInstanceId: D, workerInstanceId: E });
    assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.match(app.nodes.get('window-context-status').textContent, /restarted/); assert.equal(app.ui.runtimeRestartConfirmed({ ...baseline, hostInstanceId: D, workerInstanceId: E }, baseline, 'host'), false);
  } finally { app.close(); }
});


test('a combined launcher and desktop source update retains manual service proof alongside separate desktop instructions', async () => {
  const baseline = serviceFixture(), job = { id: C, status: 'applied', prompt: 'Synthetic combined update', updatedAt: '2026-10-25T12:00:00Z', createdAt: '2026-10-25T12:00:00Z', files: [{ path: 'server/companion-supervisor.mjs' }, { path: 'electron/productivity-main.cjs' }] }, app = await createUI({ runtimeBaseline: baseline });
  try {
    app.setIntercept(url => url.endsWith('/features/' + C + '/apply') ? response({ ...job, runtime: { ...baseline, restartScope: 'launcher', requiresManualRestart: true, restartRequested: false } }) : url.endsWith('/features/' + C) ? response(job) : null);
    await app.ui.jobAction({ id: C }, 'apply'); assert.equal(app.ui.get().runtimeNotice.phase, 'manual'); assert.match(app.nodes.get('runtime-message').textContent, /owning Companion launcher/); assert.match(app.nodes.get('runtime-message').textContent, /Desktop source changed/); assert.equal(app.ui.get().runtimeRetry.scope, 'launcher'); assert.equal(app.nodes.get('runtime-retry').hidden, false);
    assert.equal(app.requests.filter(request => request.url.endsWith('/runtime/restart')).length, 0);
  } finally { app.close(); }
});


test('restart preflight freezes a fresh identity rather than confirming a host that already changed outside this window', async () => {
  const baseline = serviceFixture(), alreadyChanged = freshService(), latest = serviceFixture({ hostPid: 30, workerPid: 300, hostInstanceId: F, workerInstanceId: '77777777-7777-4777-8777-777777777777' }), app = await createUI({ runtimeBaseline: baseline });
  try {
    let posted = false, ready = false, observed = 0;
    app.setIntercept(url => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ ...alreadyChanged, restartScope: 'host', restartRequested: true }); } if (url.endsWith('/runtime')) { if (posted) observed++; return response(ready ? latest : alreadyChanged); } return null; });
    const restart = app.ui.restartCompanionService(); await until(() => observed > 0); assert.equal(app.ui.get().reconnecting, true); assert.equal(app.ui.get().runtimeRetry.baseline.hostInstanceId, D); assert.equal(app.ui.get().runtimeRetry.baseline.workerPid, 200); assert.notEqual(app.ui.get().runtimeNotice.phase, 'ready');
    ready = true; assert.equal((await restart).confirmed, true); assert.equal(app.ui.get().runtimeInfo.hostInstanceId, F); assert.equal(app.requests.filter(request => request.url.endsWith('/runtime/restart')).length, 1);
  } finally { app.close(); }
});


const PROJECT_A = { projectId: '88888888-8888-4888-8888-888888888888', grantEpoch: 1, label: 'Original project', localPath: 'C:/Synthetic/Original', available: true, mode: 'read_write' };
const PROJECT_B = { projectId: '99999999-9999-4999-8999-999999999999', grantEpoch: 4, label: 'Other project', localPath: 'C:/Synthetic/Other', available: true, mode: 'read_write' };
const projectBindingOnly = project => ({ projectId: project.projectId, grantEpoch: project.grantEpoch });
const isProjectFileRequest = request => /\/projects\/[^/?]+\/(?:file|files|history|edit|edits|revoke)(?:[/?]|$)/.test(request.url);

test('project integration starts blank with no file IO and explicit selection retains only an opaque browser binding', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    assert.equal(app.ui.get().selectedProject, null); assert.equal(app.nodes.get('selected-project-context').hidden, true); assert.equal(app.requests.some(request => request.url.includes('/projects')), false); assert.equal(app.ui.get().currentView, 'today'); assert.equal(app.ui.get().chatOpen, false);
    app.ui.addMessage('assistant', 'Choose another project folder'); assert.equal(app.ui.get().selectedProject, null);
    assert.equal(await app.ui.selectProject(PROJECT_A), true); assert.equal(app.ui.get().selectedProject.status, 'ready'); assert.equal(app.nodes.get('selected-project-context').hidden, false); assert.match(app.nodes.get('project-context-label').textContent, /Original project/);
    assert.equal(app.requests.some(isProjectFileRequest), false); assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.selectedProject')), projectBindingOnly(PROJECT_A)); assert.ok([...app.storage.values()].every(value => !value.includes(PROJECT_A.label) && !value.includes(PROJECT_A.localPath)));
    await app.ui.runCommand('Explain the selected project'); const body = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body); assert.deepEqual(body.project, projectBindingOnly(PROJECT_A)); assert.equal(JSON.stringify(body).includes(PROJECT_A.localPath), false); assert.equal(app.requests.some(isProjectFileRequest), false);
  } finally { app.close(); }
});

test('voice freezes the project before microphone permission and stale words cannot retarget a newly selected folder', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    await app.ui.selectProject(PROJECT_A); const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); const frozen = copy(app.ui.get().voiceCaptureContext); assert.deepEqual(frozen.projectContext.project, projectBindingOnly(PROJECT_A));
    await app.ui.selectProject(PROJECT_B); app.grantMicrophone(); await opening; assert.equal(app.ui.get().recording, null); assert.equal(app.stoppedTracks, 1); assert.equal(app.ui.currentProjectContext(frozen.projectContext), false);
    await app.ui.runCommand('Write these old voice words into a file', { voice: true, providerId: frozen.providerId, conversationContext: frozen.conversationContext, windowContext: frozen.windowContext, projectContext: frozen.projectContext, approvalContext: null });
    assert.equal(app.requests.some(request => request.url.endsWith('/chat')), false); assert.match(app.nodes.get('question-error').textContent, /project folder changed/); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId);
    await app.ui.runCommand('A new explicit question'); const latest = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body); assert.deepEqual(latest.project, projectBindingOnly(PROJECT_B));
  } finally { app.close(); }
});

test('switching project folders cancels the old foreground turn and ignores its late reply without changing the new binding', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [blank(A)], selected: A });
  try {
    await app.ui.selectProject(PROJECT_A); const pending = deferred(); let body;
    app.setIntercept((url, options) => { if (!url.endsWith('/chat')) return null; body = JSON.parse(options.body); return pending.promise; });
    const turn = app.ui.runCommand('Read the original folder'); await until(() => !!app.ui.get().activeRequest); const request = app.ui.get().activeRequest; assert.deepEqual(body.project, projectBindingOnly(PROJECT_A));
    await app.ui.selectProject(PROJECT_B); assert.equal(request.controller.signal.aborted, true); assert.equal(app.ui.get().activeRequest, null); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId);
    pending.resolve(response({ id: body.id, text: 'A late original-folder result', actions: [], projectContext: { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label } })); await turn;
    assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.doesNotMatch(app.nodes.get('messages').textContent, /A late original-folder result/); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1); const cancelled = app.requests.find(request => request.url.endsWith('/cancel')); assert.equal(JSON.parse(cancelled.body).id, body.id);
  } finally { app.close(); }
});

test('handoff freezes its original project and accepted Work survives foreground folder switching and Leave', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    await app.ui.selectProject(PROJECT_A); const ack = deferred(); let body;
    app.setIntercept((url, options) => { if (!url.endsWith('/work') || options.method !== 'POST') return null; body = JSON.parse(options.body); const job = workFixture(body.id, { status: 'running', prompt: body.prompt, project: { ...body.project, label: PROJECT_A.label } }); app.workRecords.set(job.id, job); app.records.set(job.id, blank(job.id)); return ack.promise; });
    app.nodes.get('work-prompt').value = 'Continue requested files work independently'; const handoff = app.ui.submitWork(); await until(() => !!body); assert.deepEqual(body.project, projectBindingOnly(PROJECT_A));
    await app.ui.selectProject(PROJECT_B); ack.resolve(response({ job: app.workRecords.get(body.id) })); await handoff; await app.ui.selectProject(null);
    assert.equal(app.ui.get().selectedProject, null); assert.deepEqual(app.workRecords.get(body.id).project, { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label }); assert.equal(app.requests.some(request => request.url.endsWith('/work/' + body.id + '/cancel') || request.url.endsWith('/revoke')), false);
    await app.ui.refreshWork(); app.ui.selectWork(body.id); await app.ui.refreshWorkDetail(body.id); assert.match(app.nodes.get('work-detail').textContent, /Project folder · Original project/); assert.equal(app.workRecords.get(body.id).status, 'running');
  } finally { app.close(); }
});

test('a delegated Work receipt stays bound to the foreground request project after the human chooses another folder', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [blank(A)], selected: A });
  try {
    await app.ui.selectProject(PROJECT_A);
    app.setIntercept((url, options, { records }) => { if (!url.endsWith('/chat')) return null; const body = JSON.parse(options.body); const job = workFixture(B, { status: 'running', project: { ...body.project, label: PROJECT_A.label } }); app.workRecords.set(B, job); app.records.set(B, blank(B)); const reply = { id: body.id, text: 'Handed off independently.', providerId: body.providerId, projectContext: { ...body.project, label: PROJECT_A.label }, actions: [{ id: 'project-delegate', tool: 'manage_work', arguments: { action: 'start' }, status: 'completed', result: { workJob: job } }] }; const record = records.get(A); record.turns.push({ id: body.id, message: body.message, status: 'completed', reply }); record.revision += 2; return response(reply); });
    await app.ui.runCommand('Work on this project in the background'); await app.ui.selectProject(PROJECT_B); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.deepEqual(app.workRecords.get(B).project, { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label }); assert.equal(app.requests.some(request => request.url.endsWith('/work/' + B + '/cancel')), false); assert.match(app.nodes.get('messages').textContent, /Project folder · Original project/);
  } finally { app.close(); }
});

test('restored stale project access fails closed without upgrading the epoch, choosing another folder or reading files', async () => {
  const app = await createUI({ projects: [{ ...PROJECT_A, grantEpoch: 2 }, PROJECT_B], storedProject: projectBindingOnly(PROJECT_A) });
  try {
    assert.equal(app.ui.get().selectedProject.projectId, PROJECT_A.projectId); assert.equal(app.ui.get().selectedProject.grantEpoch, 1); assert.equal(app.ui.get().selectedProject.status, 'unavailable'); assert.equal(app.nodes.get('send-question').disabled, true); assert.equal(app.requests.some(isProjectFileRequest), false);
    await app.ui.runCommand('Edit a file using this stale grant'); await app.ui.startRecording(); assert.equal(app.requests.some(request => request.url.endsWith('/chat')), false); assert.equal(app.waitingForMicrophone, false);
    await app.ui.selectProject(null); await app.ui.runCommand('Continue without a folder'); const body = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body); assert.equal('project' in body, false);
  } finally { app.close(); }
});

test('access refresh cancels a now-invalid foreground route while a stale refresh cannot invalidate a newer folder', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    await app.ui.selectProject(PROJECT_A); const oldContext = copy(app.ui.captureProjectContext()), refresh = deferred(); app.setIntercept(url => url.startsWith('/api/assistant/projects/' + PROJECT_A.projectId + '?') ? refresh.promise : null);
    const checking = app.ui.refreshProjectAccess(); await app.ui.selectProject(PROJECT_B); refresh.resolve(response({ error: { code: 'project_grant_changed', message: 'Old access changed' } }, 409)); await checking; assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.equal(app.ui.get().selectedProject.status, 'ready'); assert.equal(app.ui.currentProjectContext(oldContext), false);
    app.setIntercept(null); const pending = deferred(); let requestBody; app.setIntercept((url, options) => { if (!url.endsWith('/chat')) return null; requestBody = JSON.parse(options.body); return pending.promise; }); const running = app.ui.runCommand('Read the current project'); await until(() => !!app.ui.get().activeRequest); const request = app.ui.get().activeRequest; app.projectRecords.get(PROJECT_B.projectId).grantEpoch++;
    await app.ui.refreshProjectAccess(); assert.equal(app.ui.get().selectedProject.status, 'unavailable'); assert.equal(request.controller.signal.aborted, true); assert.equal(app.ui.get().turnBusy, false); pending.resolve(response({ id: requestBody.id, text: 'Late stale-grant result', actions: [], projectContext: { ...requestBody.project, label: PROJECT_B.label } })); await running; assert.doesNotMatch(app.nodes.get('messages').textContent, /Late stale-grant result/); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('project tool failures mark the selected grant unavailable and never retry or drop its binding', async () => {
  const app = await createUI({ projects: [PROJECT_A] });
  try {
    await app.ui.selectProject(PROJECT_A); app.setIntercept(url => url.endsWith('/chat') ? response({ error: { code: 'project_binding_changed', message: 'The original project root changed.' } }, 409) : null);
    app.nodes.get('question').value = 'Keep my exact file-edit request'; await app.ui.runCommand(app.nodes.get('question').value); assert.equal(app.ui.get().selectedProject.status, 'unavailable'); assert.equal(app.nodes.get('question').value, 'Keep my exact file-edit request'); await app.ui.runCommand('Try another edit'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1); assert.deepEqual(JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body).project, projectBindingOnly(PROJECT_A));
  } finally { app.close(); }
});

test('saved project receipts retain original provenance and open their recorded folder rather than the current one', async () => {
  const edit = { id: C, ...projectBindingOnly(PROJECT_A), path: 'notes.md', status: 'applied', receiptPending: true, undoAvailable: true }, record = { ...blank(A), revision: 2, turns: [{ id: 'project-saved-turn', message: 'Requested original folder edit', status: 'completed', reply: { text: 'Inspect the actual recorded edit.', projectContext: { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label }, actions: [{ id: 'original-edit', tool: 'run_capability', status: 'completed', result: { projectFileEdit: edit } }, { id: 'read-original', tool: 'run_capability', status: 'completed', result: { projectFileRead: { ...projectBindingOnly(PROJECT_A), path: 'notes.md', hasMore: true } } }] } }] };
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [record], selected: A });
  try {
    await app.ui.selectProject(PROJECT_B); assert.match(app.nodes.get('messages').textContent, /Project folder · Original project/); assert.match(app.nodes.get('messages').textContent, /File changed · receipt needs checking/); assert.match(app.nodes.get('messages').textContent, /File read · notes.md · partial page · saved read/); assert.doesNotMatch(app.nodes.get('messages').textContent, /File saved · notes.md/); assert.equal(app.requests.some(isProjectFileRequest), false);
    const open = descendants(app.nodes.get('messages')).find(item => item.tagName === 'button' && item.textContent === 'Open this project ↗'); await open.dispatch('click'); await until(() => app.ui.get().currentView === 'files'); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_A.projectId); assert.equal(app.ui.get().selectedProject.status, 'ready');
  } finally { app.close(); }
});

test('a late original-project receipt click cannot navigate to Files for a newer selection', async () => {
  const record = { ...blank(A), revision: 2, turns: [{ id: 'saved-file', message: 'An earlier edit', status: 'completed', reply: { text: 'Original edit receipt', actions: [{ id: 'edit', tool: 'run_capability', status: 'completed', result: { projectFileEdit: { id: C, ...projectBindingOnly(PROJECT_A), path: 'original.md', status: 'applied', undoAvailable: false } } }] } }] }, app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [record], selected: A });
  try {
    const waiting = deferred(); app.setIntercept(url => url.startsWith('/api/assistant/projects/' + PROJECT_A.projectId + '?') ? waiting.promise : null); const open = descendants(app.nodes.get('messages')).find(item => item.tagName === 'button' && item.textContent === 'Open this project ↗'); await open.dispatch('click'); await until(() => app.ui.get().selectedProject?.projectId === PROJECT_A.projectId);
    await app.ui.selectProject(PROJECT_B); waiting.resolve(response({ project: PROJECT_A })); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.equal(app.ui.get().currentView, 'today');
  } finally { app.close(); }
});

const FOLLOW_WORK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const followBuild = (id=C,status='applied') => ({ id,status,prompt:'Build the original requested report tool.',summary:'Report tool',createdAt:'2026-10-25T12:00:00Z',updatedAt:'2026-10-25T12:00:00Z',files:[],verification:{passed:true,checks:[]} });
const followRecord = (buildId=C,id=E,patch={}) => ({ id,buildId,workId:FOLLOW_WORK,status:'ready',origin:{requestId:'original-human-turn',conversationId:A,message:'Write the original report using the original project.',provider:{id:'codex',label:'GPT',type:'codex',model:''}},buildSpec:'Implement the bounded report tool. Keep the human outcome separate.',readiness:{ready:true},...patch });
const continuationControl = (app,text) => descendants(app.nodes.get('build-continuation-container')).find(node=>node.tagName==='button'&&node.textContent===text);
async function openFollowBuild(app,id=C){app.ui.selectBuild(id);app.ui.showView('build');await until(()=>!!continuationControl(app,'Continue original request'),'continuation panel');}

test('linked continuations stay out of the blank canvas and applied builds or service reconnect never resume them automatically',async()=>{
  const baseline=serviceFixture(),app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,savedBuilds:[followBuild()],savedContinuations:[followRecord()],runtimeBaseline:baseline});
  try{
    app.nodes.get('question').value='An unsent foreground draft';assert.equal(app.ui.get().chatOpen,false);assert.equal(app.requests.some(request=>request.url.includes('/continuations')),false);
    await openFollowBuild(app);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.ui.get().id,A);assert.equal(app.nodes.get('question').value,'An unsent foreground draft');assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);
    await app.ui.refreshJobs();app.setIntercept(url=>url.endsWith('/runtime')?response(freshService()):null);const result=await app.ui.reconnectAfterRestart({managed:true,restartRequested:true,restartScope:'host',baseline},{baseline});assert.equal(result.confirmed,true);await app.ui.get().buildContinuationUI.refresh();
    assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.nodes.get('question').value,'An unsent foreground draft');
  }finally{app.close();}
});

test('voice freezes the selected build before microphone permission and a changed build cannot receive the old Continue command',async()=>{
  const app=await createUI({savedBuilds:[followBuild(C),followBuild(D)],savedContinuations:[followRecord(C,E),followRecord(D,F)]});
  try{
    await openFollowBuild(app,C);const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);const frozen=copy(app.ui.get().voiceCaptureContext);assert.ok(frozen.buildContinuationContext);assert.equal(app.ui.currentBuildContinuationContext(frozen.buildContinuationContext),true);
    app.ui.selectBuild(D);await until(()=>app.ui.get().selectedJobId===D);app.grantMicrophone();await opening;assert.equal(app.ui.currentBuildContinuationContext(frozen.buildContinuationContext),false);
    await app.ui.runCommand('continue original request',{voice:true,...frozen});assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);assert.equal(app.requests.some(request=>request.url.endsWith('/chat')),false);assert.equal(app.ui.get().selectedJobId,D);assert.equal(app.ui.get().chatOpen,false);
  }finally{app.close();}
});

test('a real human voice Continue uses its captured build only and preserves foreground chat until an explicit matching Work link',async()=>{
  const app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,savedBuilds:[followBuild()],savedContinuations:[followRecord()],savedWork:[workFixture(B)]});
  try{
    await openFollowBuild(app);const context=copy(app.ui.captureBuildContinuationContext());await app.ui.addMessage('assistant','continue original request');assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);
    await app.ui.runCommand('continue original request',{voice:true,buildContinuationContext:context});const posts=app.requests.filter(request=>request.url.includes('/continuations/')&&request.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/assistant/continuations/'+E+'/continue');assert.equal(posts[0].body,'{}');assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.ui.get().currentView,'build');assert.equal(app.requests.some(request=>request.url.endsWith('/chat')),false);
    await app.ui.get().buildContinuationUI.refresh();await until(()=>!!continuationControl(app,'Open work'));await continuationControl(app,'Open work').dispatch('click');await until(()=>app.ui.get().selectedWorkId===FOLLOW_WORK);assert.equal(app.ui.get().currentView,'work');assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.workRecords.get(FOLLOW_WORK).prompt,followRecord().origin.message);
  }finally{app.close();}
});


test('a build selected during the voice readiness GET cannot receive the previous original-request command',async()=>{
  const app=await createUI({savedBuilds:[followBuild(C),followBuild(D)],savedContinuations:[followRecord(C,E),followRecord(D,F)]});const pending=deferred();
  try{await openFollowBuild(app,C);const context=copy(app.ui.captureBuildContinuationContext());app.setIntercept(url=>url.startsWith('/api/assistant/continuations?')?pending.promise:null);const command=app.ui.runCommand('continue original request',{voice:true,buildContinuationContext:context});await until(()=>app.requests.filter(request=>request.url.startsWith('/api/assistant/continuations?')).length>=2);app.ui.selectBuild(D);pending.resolve(response({continuations:[followRecord(C,E)],total:1,offset:0,limit:20,hasMore:false,nextOffset:null}));await command;assert.equal(app.ui.get().selectedJobId,D);assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);assert.match(app.nodes.get('question-error').textContent,/selected build changed/);assert.equal(app.ui.get().chatOpen,false);}finally{app.close();}
});

test('an uncertain voice Continue stops capture, retains Check continuation and never repeats the saved original request',async()=>{
  const app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,savedBuilds:[followBuild()],savedContinuations:[followRecord()]});
  try{
    await openFollowBuild(app);const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);app.grantMicrophone();await opening;const frozen=copy(app.ui.get().voiceCaptureContext);assert.equal(app.ui.get().voiceState.enabled,true);assert.equal(app.ui.get().ownsVoice,true);
    app.setIntercept((url,options)=>{if(url==='/api/assistant/continuations/'+E+'/continue'&&options.method==='POST'){const accepted=app.continuationRecords.get(E);accepted.status='queued';accepted.workJob={id:FOLLOW_WORK,status:'queued'};throw new Error('Synthetic lost continuation acknowledgement');}return null;});
    await app.ui.runCommand('continue original request',{voice:true,...frozen});assert.equal(app.ui.get().voiceState.enabled,false);assert.equal(app.ui.get().ownsVoice,false);assert.equal(app.waitingForMicrophone,false);assert.ok(app.stoppedTracks>0);assert.match(app.nodes.get('question-error').textContent,/not confirmed|unconfirmed|Check continuation/i);assert.ok(continuationControl(app,'Check continuation'));assert.equal(continuationControl(app,'Continue original request'),undefined);assert.deepEqual(JSON.parse(app.storage.get('companion.build.continuations.pending.v1')),[E]);assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);
    const posts=app.requests.filter(request=>request.url.includes('/continuations/')&&request.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body,'{}');const before=app.requests.length;await continuationControl(app,'Check continuation').dispatch('click');await until(()=>!!continuationControl(app,'Open work'));const checks=app.requests.slice(before).filter(request=>request.url.includes('/continuations/'));assert.equal(checks.length,1);assert.equal(checks[0].url,'/api/assistant/continuations/'+E);assert.equal(checks[0].method,'GET');assert.equal(app.requests.filter(request=>request.url.includes('/continuations/')&&request.method==='POST').length,1);assert.equal(app.ui.get().voiceState.enabled,false);assert.equal(app.ui.get().ownsVoice,false);
  }finally{app.close();}
});

test('live and saved continuation receipts mark reused note and nested task effects as already completed earlier',async()=>{
  const reuse={requestId:'original-human-request',actionId:'original-action'},actions=[{id:'reused-note',tool:'save_note',status:'completed',result:{note:{id:E,title:'Earlier note'},replayed:true,historical:true,continuationReuse:reuse}},{id:'new-capability',tool:'run_capability',arguments:{name:'cap_report'},status:'completed',result:{capability:{id:'report',name:'cap_report',version:1,hash:'a'.repeat(64)},value:{count:1},hostActions:[{id:'reused-task',tool:'create_task',status:'completed',result:{task:{id:F,title:'Earlier task'},replayed:true,historical:true,continuationReuse:reuse}}]}}];
  const saved=blank(A,'Follow-through result');saved.turns=[{id:'continued-work-turn',message:'Continue the original report',providerId:'codex',status:'completed',startedAt:'2026-10-25T12:00:00Z',finishedAt:'2026-10-25T12:00:01Z',reply:{id:'continued-work-turn',text:'The installed tool returned its result.',providerId:'codex',actions}}];saved.revision=2;
  const app=await createUI({saved:[saved],selected:A});
  try{
    const labels=()=>descendants(app.nodes.get('messages')).filter(node=>node.className?.split(/\s+/).includes('action-receipt')).map(node=>node.textContent);assert.ok(labels().some(text=>text==='Already completed earlier · Earlier note'));assert.ok(labels().some(text=>text==='Already completed earlier · Earlier task'));assert.equal(labels().some(text=>text.startsWith('Note saved · Earlier note')||text.startsWith('Task saved · Earlier task')),false);
    const live=new Element();app.ui.renderActionReceipts(live,actions);const liveLabels=descendants(live).filter(node=>node.className?.split(/\s+/).includes('action-receipt')).map(node=>node.textContent);assert.ok(liveLabels.includes('Already completed earlier · Earlier note'));assert.ok(liveLabels.includes('Already completed earlier · Earlier task'));
    await app.ui.refreshConversation();assert.equal(labels().filter(text=>text==='Already completed earlier · Earlier note').length,1);assert.equal(labels().filter(text=>text==='Already completed earlier · Earlier task').length,1);assert.equal(app.requests.some(request=>request.method==='POST'),false);assert.equal(app.ui.get().workspace.tasks.length,0);
  }finally{app.close();}
});
