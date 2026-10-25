import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedServer } from '../server/shared-server.mjs';
import { createProductivityStore } from '../server/productivity-store.mjs';
import { createProductivityTools } from '../server/productivity-tools.mjs';

const stopped = () => Object.assign(new Error('Synthetic request stopped.'), { name: 'AbortError' });
const unavailable = () => Object.assign(new Error('Synthetic provider unavailable.'), { code: 'provider_unavailable', statusCode: 503 });
async function fixture(t, { complete = async () => ({ text: 'A synthetic answer.', toolCalls: [] }), desktop } = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'companion-productivity-api-'));
  let store = await createProductivityStore({ dataDirectory });
  const stores = [store], apps = [], calls = [], jobs = [], builderCalls = []; let runtimeCount = 0;
  const descriptors = [{ id: 'fake', type: 'codex', label: 'Synthetic model', model: '', hasKey: false, ready: true }];
  const router = {
    getStatus: async () => ({ defaultProviderId: 'fake', providers: descriptors, codexAvailable: true, reasoningReady: true }),
    async complete(input) { calls.push({ ...input, messages: structuredClone(input.messages) }); return complete(input, calls.length); },
    async configure(input) { descriptors.push({ id: input.id, type: input.type, label: input.label || input.type, model: input.model || 'synthetic', hasKey: Boolean(input.apiKey), ready: Boolean(input.apiKey) }); },
    async select(id) { assert.ok(descriptors.some(entry => entry.id === id)); },
    async remove(id) { const index = descriptors.findIndex(entry => entry.id === id); if (index >= 0) descriptors.splice(index, 1); },
  };
  const builder = {
    async request(input, owner) { builderCalls.push({ type: 'request', input, owner }); const job = { id: randomUUID(), status: 'queued', summary: 'Synthetic feature', prompt: input.prompt, files: [], events: [] }; jobs.push(job); return job; },
    async list(owner) { builderCalls.push({ type: 'list', owner }); return jobs; },
    async get(id, owner) { builderCalls.push({ type: 'get', id, owner }); return jobs.find(job => job.id === id); },
    async source(owner, options) { builderCalls.push({ type: 'source', owner, options }); return { revision: 'synthetic-source-hash', files: [{ path: 'src/example.mjs', hash: 'synthetic-file-hash', ...(options.includeContent ? { content: 'export const example = true;' } : {}) }] }; },
    async submitPatch(input, owner) { builderCalls.push({ type: 'patch', input, owner }); return this.request({ prompt: 'External patch' }, owner); },
    async apply(id, owner) { builderCalls.push({ type: 'apply', id, owner }); return { id, status: 'applied' }; },
    async rollback(id, owner) { builderCalls.push({ type: 'rollback', id, owner }); return { id, status: 'rolled_back' }; },
    async cancel(id, owner) { builderCalls.push({ type: 'cancel', id, owner }); return { id, status: 'cancelled' }; },
    async stopPending(owner) { builderCalls.push({type:'stopPending',owner}); const builds=[]; for(const job of jobs) if(['queued','generating','validating'].includes(job.status)) builds.push(await this.cancel(job.id,owner)); return {stopped:true,builds}; },
    async close() {},
  };
  let tools = createProductivityTools({ store, builder, desktop });
  const legacyProvider = { getStatus: async () => ({ provider: 'local', reasoningReady: false, transcriptionReady: false }), ask: async () => ({ text: 'Legacy synthetic response.' }), transcribe: async () => ({ text: 'Synthetic transcript.' }), cancel() {}, cancelScope() {} };
  const createApp = () => createSharedServer({ dbPath: path.join(dataDirectory, 'room.sqlite'), port: 0, assistantProvider: legacyProvider, assistantOptions: { createProductivityRuntime: async () => { runtimeCount += 1; return { router, store, builder, tools, desktop }; } } });
  let app = await createApp(); apps.push(app);
  let address = await app.listen(), origin = new URL(address.url).origin;
  t.after(async () => { for (const item of apps) await item.close(); for (const item of stores) item.close(); const resolved = path.resolve(dataDirectory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(resolved, { recursive: true, force: true }); });
  async function request(method, route, body, user, headers = {}, raw = false) {
    const response = await fetch(origin + route, { method, headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrfToken } : {}), ...headers }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), redirect: 'error' });
    return { status: response.status, value: await response.json(), headers: response.headers };
  }
  async function session() { const result = await request('GET', '/api/assistant/session'); assert.equal(result.status, 200); return { csrfToken: result.value.csrfToken, cookie: result.headers.get('set-cookie').split(';')[0] }; }
  async function restart() {
    await app.close(); store.close(); store = await createProductivityStore({ dataDirectory }); stores.push(store); tools = createProductivityTools({ store, builder, desktop });
    app = await createApp(); apps.push(app); address = await app.listen(); origin = new URL(address.url).origin; return store;
  }
  return { app, store, router, tools, calls, builderCalls, origin, request, session, restart, runtimeCount: () => runtimeCount };
}

test('new productivity routes require a personal session, exact Origin and CSRF before lazy initialization', async t => {
  const f = await fixture(t);
  for (const route of ['/workspace', '/providers', '/features', '/features/source', '/integrations','/desktop','/desktop/actions']) assert.equal((await f.request('GET', '/api/assistant' + route)).status, 401);
  assert.equal(f.runtimeCount(), 0); const user = await f.session();
  const operation = { operationId: randomUUID(), expectedRevision: 0, type: 'addTask', title: 'Blocked forgery' };
  for (const headers of [{ Origin: 'https://example.invalid' }, { Origin: '' }, { 'X-CSRF-Token': 'forged' }]) assert.equal((await f.request('POST', '/api/assistant/workspace/operations', operation, user, headers)).status, 403);
  assert.equal(f.runtimeCount(), 0); assert.equal(f.store.snapshot().tasks.length, 0);
  const status = await f.request('GET', '/api/assistant/providers', undefined, user); assert.equal(status.status, 200); assert.equal(status.value.activeProviderId, 'fake'); assert.equal(f.runtimeCount(), 1);
  const integration = await f.request('GET', '/api/assistant/integrations', undefined, user);
  assert.equal(integration.value.mcp.env.COMPANION_URL, f.origin);
  assert.ok(integration.value.mcp.args[0].endsWith(path.join('server', 'mcp-server.mjs')));
  assert.equal((await f.request('POST', '/api/assistant/chat', 'plain', user, { 'Content-Type': 'text/plain' }, true)).status, 415);
  assert.equal((await f.request('POST', '/api/assistant/chat', { id: 'huge', message: 'x'.repeat(2 * 1024 * 1024 + 1) }, user)).status, 413);
  assert.equal((await f.request('POST', '/api/assistant/chat', '{invalid', user, {}, true)).status, 400);
});

test('workspace HTTP CAS and replay return the real current SQLite snapshot without creating a group account', async t => {
  const f = await fixture(t), user = await f.session(); const operation = { operationId: randomUUID(), expectedRevision: 0, type: 'addTask', title: 'One HTTP task' };
  assert.equal((await f.request('POST', '/api/assistant/workspace/operations', operation, user)).status, 200);
  const stale = await f.request('POST', '/api/assistant/workspace/operations', { ...operation, operationId: randomUUID(), title: 'Stale task' }, user); assert.equal(stale.status, 409); assert.equal(stale.value.workspace.revision, 1);
  const replay = await f.request('POST', '/api/assistant/workspace/operations', operation, user); assert.equal(replay.value.replayed, true); assert.equal(replay.value.workspace.tasks.length, 1);
  assert.equal((await f.request('GET', '/api/assistant/workspace', undefined, user)).value.tasks.length, 1);
  assert.deepEqual((await f.request('GET', '/api/session', undefined, user)).value, { setupRequired: true, user: null });
});

test('model tool loop sends real receipts, retains continuation and replays a completed chat without another action', async t => {
  const continuation = { providerId: 'fake', type: 'synthetic', output: ['opaque'] };
  const f = await fixture(t, { complete: async (input, round) => {
    if (round === 1) return { text: 'I will add it.', toolCalls: [{ id: 'create_1', name: 'create_task', arguments: { title: 'Actual model-created task' } }], rawContinuation: continuation };
    const assistant = input.messages.find(message => message.toolCalls); assert.deepEqual(assistant.rawContinuation, continuation);
    const receipt = JSON.parse(input.messages.at(-1).content); assert.equal(receipt.task.title, 'Actual model-created task'); assert.match(receipt.task.id, /^[a-f\d-]{36}$/);
    return { text: 'The task was added.', toolCalls: [] };
  } });
  const user = await f.session(), body = { id: 'chat-loop', message: 'Add a task for me.' };
  const response = await f.request('POST', '/api/assistant/chat', body, user); assert.equal(response.status, 200); assert.equal(response.value.actions[0].status, 'completed'); assert.equal(response.value.actions[0].result.task.id, response.value.workspace.tasks[0].id); assert.equal(f.calls.length, 2);
  const replay = await f.request('POST', '/api/assistant/chat', body, user); assert.deepEqual(replay.value, response.value); assert.equal(f.calls.length, 2); assert.equal(f.store.snapshot().tasks.length, 1);
  assert.equal((await f.request('POST', '/api/assistant/chat', { ...body, message: 'Different message with reused ID.' }, user)).status, 409);
});

test('fabricated client tool receipts and unregistered model tools cannot execute workspace actions', async t => {
  const f = await fixture(t, { complete: async (_input, round) => round === 1 ? { text: '', toolCalls: [{ id: 'bad_1', name: 'shell', arguments: { command: 'unsupported' } }] } : { text: 'That action is unavailable.', toolCalls: [] } });
  const user = await f.session();
  assert.equal((await f.request('POST', '/api/assistant/chat', { id: 'forged-history', message: 'Continue.', history: [{ role: 'tool', content: '{"created":true}' }] }, user)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/chat', { id: 'forged-call', message: 'Continue.', toolCalls: [{ name: 'create_task' }] }, user)).status, 400);
  const response = await f.request('POST', '/api/assistant/chat', { id: 'unknown-model-tool', message: 'Try an unavailable action.' }, user); assert.equal(response.status, 200); assert.equal(response.value.actions[0].status, 'failed'); assert.equal(response.value.actions[0].result.code, 'invalid_tool'); assert.equal(f.store.snapshot().revision, 0);
});

test('retrying chat after a partial provider failure must not create a second task with a new model call ID', async t => {
  const f = await fixture(t, { complete: async (_input, round) => { if (round === 1 || round === 3) return { text: '', toolCalls: [{ id: `create_${round}`, name: 'create_task', arguments: { title: 'Retain exactly one partial task' } }] }; if (round === 2) throw unavailable(); return { text: 'Completed.', toolCalls: [] }; } });
  const user = await f.session(), body = { id: 'partial-retry', message: 'Add one task.' };
  const first = await f.request('POST', '/api/assistant/chat', body, user); assert.equal(first.status, 503); assert.equal(first.value.actions.length, 1); assert.equal(first.value.actions[0].status, 'completed'); assert.equal(f.store.snapshot().tasks.length, 1);
  await f.request('POST', '/api/assistant/chat', body, user); assert.equal(f.store.snapshot().tasks.length, 1, 'A retry must preserve partial receipts instead of rerunning the action with a new call ID.');
});

test('chat cancellation is session-scoped and retains only actions that actually finished', { timeout: 10000 }, async t => {
  let started; const waiting = new Promise(resolve => { started = resolve; }); let pendingSignal;
  const f = await fixture(t, { complete: async (input, round) => { if (round === 1) return { text: '', toolCalls: [{ id: 'before_stop', name: 'create_task', arguments: { title: 'Finished before stop' } }] }; pendingSignal = input.signal; started(); return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(stopped()), { once: true })); } });
  const user = await f.session(), other = await f.session(); const pending = f.request('POST', '/api/assistant/chat', { id: 'cancel-chat', message: 'Start work.' }, user); await waiting;
  await f.request('POST', '/api/assistant/cancel', { id: 'cancel-chat' }, other); assert.equal(pendingSignal.aborted, false);
  assert.equal((await f.request('POST', '/api/assistant/cancel', { id: 'cancel-chat' }, user)).status, 200);
  const response = await pending; assert.equal(response.status, 499); assert.equal(response.value.error.code, 'request_cancelled'); assert.equal(response.value.actions[0].status, 'completed'); assert.equal(f.store.snapshot().tasks.length, 1);
});

test('disconnecting a productivity chat aborts the model and cannot apply later actions', { timeout: 10000 }, async t => {
  let started, aborted; const waiting = new Promise(resolve => { started = resolve; }), cancelled = new Promise(resolve => { aborted = resolve; });
  const f = await fixture(t, { complete: input => { started(); return new Promise((_, reject) => input.signal.addEventListener('abort', () => { aborted(); reject(stopped()); }, { once: true })); } });
  const user = await f.session(), body = JSON.stringify({ id: 'disconnect-chat', message: 'A synthetic pending request.' });
  const request = http.request(f.origin + '/api/assistant/chat', { method: 'POST', headers: { Origin: f.origin, Cookie: user.cookie, 'X-CSRF-Token': user.csrfToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }); request.on('error', () => {}); request.end(body); await waiting; request.destroy(); await cancelled; assert.equal(f.store.snapshot().revision, 0);
});

test('direct tools, workflows and feature-job routes return real receipts and forward explicit activation actions', async t => {
  const f = await fixture(t), user = await f.session(); const operationId = randomUUID();
  const create = await f.request('POST', '/api/assistant/tools/run', { tool: 'create_task', arguments: { title: 'Direct task' }, operationId }, user); assert.equal(create.status, 200); assert.equal(create.value.result.task.title, 'Direct task');
  const repeat = await f.request('POST', '/api/assistant/tools/run', { tool: 'create_task', arguments: { title: 'Direct task' }, operationId }, user); assert.equal(repeat.status, 200); assert.equal(repeat.value.result.replayed, true); assert.equal(f.store.snapshot().tasks.length, 1);
  const workflowId = randomUUID();
  const savedWorkflow = await f.request('POST', '/api/assistant/workspace/operations', { operationId: workflowId, expectedRevision: f.store.snapshot().revision, type: 'saveWorkflow', name: 'Direct workflow', steps: [{ tool: 'create_task', arguments: { title: 'Workflow HTTP task' } }] }, user);
  assert.equal(savedWorkflow.status, 200);
  const workflowOperation = { operationId: randomUUID() };
  const run = await f.request('POST', `/api/assistant/workspace/workflows/${workflowId}/run`, workflowOperation, user); assert.equal(run.value.status, 'completed'); assert.equal(run.value.steps[0].result.task.title, 'Workflow HTTP task');
  assert.equal((await f.request('POST', `/api/assistant/workspace/workflows/${workflowId}/run`, workflowOperation, user)).value.status, 'completed'); assert.equal(f.store.snapshot().tasks.length, 2);
  const build = await f.request('POST', '/api/assistant/features', { prompt: 'Add a synthetic panel.' }, user); assert.equal(build.status, 202); assert.equal(build.value.status, 'queued'); assert.equal(f.builderCalls.find(call => call.type === 'request').input.providerId, 'fake');
  assert.equal((await f.request('GET', '/api/assistant/features', undefined, user)).value.jobs.length, 1);
  for (const [action, status] of [['apply', 'applied'], ['rollback', 'rolled_back'], ['cancel', 'cancelled']]) assert.equal((await f.request('POST', `/api/assistant/features/${build.value.id}/${action}`, {}, user)).value.status, status);
  const source = await f.request('GET', '/api/assistant/features/source?content=1', undefined, user); assert.equal(source.value.files[0].content, 'export const example = true;');
  const configured = await f.request('POST', '/api/assistant/providers/configure', { id: 'synthetic-api', type: 'openai', apiKey: 'synthetic-secret-key' }, user); assert.equal(configured.status, 200); assert.ok(!JSON.stringify(configured.value).includes('synthetic-secret-key'));
  assert.equal((await f.request('GET', '/api/assistant/integrations', undefined, user)).value.tools.some(tool => tool.name === 'create_task'), true);
});

test('an explicitly retried feature-build tool returns its first job instead of queuing another build', async t => {
  const f = await fixture(t), user = await f.session(), body = { tool: 'build_feature', arguments: { prompt: 'Add one synthetic panel.' }, operationId: randomUUID() };
  const first = await f.request('POST', '/api/assistant/tools/run', body, user); assert.equal(first.status, 200); assert.ok(first.value.result.featureJob.id);
  const replay = await f.request('POST', '/api/assistant/tools/run', body, user); assert.equal(replay.status, 200); assert.equal(replay.value.result.featureJob.id, first.value.result.featureJob.id); assert.equal(f.builderCalls.filter(call => call.type === 'request').length, 1);
  const changed = await f.request('POST', '/api/assistant/tools/run', { ...body, arguments: { prompt: 'A different feature using the same operation ID.' } }, user); assert.equal(changed.status, 409);
});

test('desktop proposals stop the model turn before more actions and only the protected action route can approve', async t => {
  const id = randomUUID(), desktopCalls = [], pending = { id, status: 'pending', summary: 'Type a synthetic draft in the selected test editor.', preview: { action: 'setText', text: 'Synthetic draft' }, requiresApproval: true };
  const definition = { name: 'desktop_propose_action', parameters: { type: 'object', properties: { snapshotId: { type: 'string' } }, required: ['snapshotId'], additionalProperties: false } };
  const desktop = { definitions: [definition], status: () => ({ available: true }), listActions: () => [pending], execute: async (...args) => { desktopCalls.push(args); return { desktopAction: { ...pending } }; }, approve: async actionId => { assert.equal(actionId,id); pending.status = 'completed'; pending.requiresApproval = false; return { ...pending }; }, cancel: async () => ({ ...pending,status:'cancelled' }), cancelAll: () => ({ cancelled: 1 }), close() {} };
  const f = await fixture(t, { desktop, complete: async () => ({ text: 'I will prepare the action.', toolCalls: [{ id:'preview', name:definition.name, arguments:{snapshotId:'observed'} }, { id:'must_not_run', name:'create_task', arguments:{title:'Must not run before approval'} }] }) });
  const user = await f.session();
  const reply = await f.request('POST','/api/assistant/chat',{id:'desktop-review',message:'Prepare the synthetic desktop action.'},user);
  assert.equal(reply.status,200); assert.equal(reply.value.actions.length,1); assert.equal(reply.value.actions[0].status,'pending'); assert.match(reply.value.text,/has not run/);
  assert.equal(f.calls.length,1); assert.equal(desktopCalls.length,1); assert.equal(f.store.snapshot().revision,0);
  const reviewRoute = `/api/assistant/desktop/actions/${id}/approve`;
  assert.equal((await f.request('POST',reviewRoute,{},user,{Origin:'https://example.invalid'})).status,403);
  assert.equal(pending.status,'pending');
  assert.equal((await f.request('POST','/api/assistant/tools/run',{tool:'desktop_approve_action',arguments:{id}},user)).status,400);
  const approved = await f.request('POST',reviewRoute,{},user); assert.equal(approved.status,200); assert.equal(approved.value.desktopAction.status,'completed');
  assert.equal((await f.request('GET','/api/assistant/desktop/actions',undefined,user)).value.actions[0].status,'completed');
  assert.equal((await f.request('POST','/api/assistant/desktop/stop',{},user)).value.stopped,true);
});

test('direct desktop effects retain a persistent retry receipt across HTTP requests and restart', async t => {
  let launches = 0;
  const desktop = { definitions:[{ name:'desktop_open_app',parameters:{type:'object',properties:{appId:{type:'string'}},required:['appId'],additionalProperties:false} }], execute:async (_name,args) => { launches++; return { opened:true,appId:args.appId }; }, close() {} };
  const f = await fixture(t,{desktop}), user = await f.session();
  const body = {tool:'desktop_open_app',arguments:{appId:'discovered-synthetic-app'},operationId:randomUUID()};
  const first = await f.request('POST','/api/assistant/tools/run',body,user); assert.equal(first.status,200); assert.equal(first.value.result.opened,true);
  const replay = await f.request('POST','/api/assistant/tools/run',body,user); assert.equal(replay.status,200); assert.equal(launches,1);
  await f.restart(); const newSession = await f.session();
  assert.equal((await f.request('POST','/api/assistant/tools/run',body,newSession)).status,200); assert.equal(launches,1);
  assert.equal((await f.request('POST','/api/assistant/tools/run',{...body,arguments:{appId:'different-app'}},newSession)).status,409); assert.equal(launches,1);
});

test('global Stop cancels active reasoning, desktop work, and queued feature builds without changing saved data', async t => {
  let begin, desktopStops = 0; const began = new Promise(resolve => { begin = resolve; });
  const desktop = { definitions:[], cancelAll:() => { desktopStops++; return {cancelled:1}; }, close() {} };
  const f = await fixture(t,{desktop,complete:input => { begin(); return new Promise((_resolve,reject) => input.signal.addEventListener('abort',()=>reject(stopped()),{once:true})); }});
  const user = await f.session();
  await f.request('POST','/api/assistant/workspace/operations',{operationId:randomUUID(),expectedRevision:0,type:'addTask',title:'Keep completed local changes'},user);
  const build = await f.request('POST','/api/assistant/features',{prompt:'A queued synthetic feature.'},user); assert.equal(build.status,202);
  const reasoning = f.request('POST','/api/assistant/chat',{id:'global-stop-test',message:'Wait for cancellation.'},user); await began;
  assert.equal((await f.request('POST','/api/assistant/stop',{},user,{'X-CSRF-Token':'forged'})).status,403); assert.equal(desktopStops,0);
  const stop = await f.request('POST','/api/assistant/stop',{},user); assert.equal(stop.status,200); assert.equal(desktopStops,1); assert.equal(stop.value.builds[0].status,'cancelled');
  assert.equal((await reasoning).status,499); assert.equal(f.store.snapshot().tasks.length,1);
  assert.equal(f.builderCalls.filter(call=>call.type==='cancel').length,1);
  assert.equal(f.builderCalls.filter(call=>call.type==='stopPending').length,1);
});

test('an in-progress chat receipt survives API restart and refuses rerun in a fresh browser session', async t => {
  const f = await fixture(t), body = { id: 'interrupted-chat', message: 'Create one interrupted task.' };
  const digest = createHash('sha256').update(JSON.stringify({ message: body.message, history: [], providerId: undefined })).digest('hex');
  assert.equal(f.store.beginChat(body.id, digest), null);
  f.store.apply({ operationId: randomUUID(), expectedRevision: 0, type: 'addTask', title: 'Finished before simulated crash' });
  const restarted = await f.restart(), user = await f.session();
  const response = await f.request('POST', '/api/assistant/chat', body, user); assert.equal(response.status, 409); assert.equal(response.value.error.code, 'request_interrupted'); assert.equal(f.calls.length, 0); assert.equal(restarted.snapshot().tasks.length, 1);
  const changed = await f.request('POST', '/api/assistant/chat', { ...body, message: 'Different input with interrupted ID.' }, user); assert.equal(changed.status, 409); assert.equal(changed.value.error.code, 'request_conflict'); assert.equal(f.calls.length, 0);
});
