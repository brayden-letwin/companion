import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createVoiceSession } from '../../src/voice-session.mjs';
import { normalizeDeadline, createDeadlineContext, resolveLocalDeadline } from '../../src/core/productivity-deadlines.mjs';
import { taskDeadlineView, formatDeadlineInstant } from '../../server/task-deadline-view.mjs';

const root = new URL('../../', import.meta.url);
const html = readFileSync(new URL('assistant.html', root), 'utf8');
const workflowEditorSource=readFileSync(new URL('src/workflow-editor.mjs',root),'utf8').replace('export function createWorkflowEditor','function createWorkflowEditor');
const workflowHistorySource=readFileSync(new URL('src/workflow-history.mjs',root),'utf8').replace('export function createWorkflowHistoryUI','function createWorkflowHistoryUI');
const workspaceBackupsSource=readFileSync(new URL('src/workspace-backups.mjs',root),'utf8').replace('export function createWorkspaceBackupsUI','function createWorkspaceBackupsUI');
const providerChecksSource=readFileSync(new URL('src/provider-checks.mjs',root),'utf8').replaceAll('export function ','function ');
const buildAttemptsSource=readFileSync(new URL('src/build-attempts.mjs',root),'utf8').replace('export function createBuildAttemptsUI','function createBuildAttemptsUI');
const buildContinuationSource=readFileSync(new URL('src/build-continuation.mjs',root),'utf8').replace('export function createBuildContinuationUI','function createBuildContinuationUI');
const projectFilesSource=readFileSync(new URL('src/project-files.mjs',root),'utf8').replace('export function createProjectFilesUI','function createProjectFilesUI');
const source = readFileSync(new URL('src/assistant.mjs', root), 'utf8')
  .replace(/^import \{ createWorkflowEditor \} from '\.\/workflow-editor\.mjs';\r?\n/m, '')
  .replace(/^import \{ createWorkflowHistoryUI \} from '\.\/workflow-history\.mjs';\r?\n/, '')
  .replace(/^import \{ createWorkspaceBackupsUI \} from '\.\/workspace-backups\.mjs';\r?\n/, '')
  .replace(/^import \{ normalizeDeadline \} from '\.\/core\/productivity-deadlines\.mjs';\r?\n/, '')
  .replace(/^import \{ createVoiceSession \} from '\.\/voice-session\.mjs';\r?\n/, '')
  .replace(/^import \{ createProjectFilesUI \} from '\.\/project-files\.mjs';\r?\n/, '')
  .replace(/^import \{\s*createBuildContinuationUI\s*\} from '\.\/build-continuation\.mjs';\r?\n/, '')
  .replace(/^import \{\s*createBuildAttemptsUI\s*\} from '\.\/build-attempts\.mjs';\r?\n/, '')
  .replace(/^import \{\s*createProviderChecksUI,\s*providerAvailabilityText,\s*providerCheckSummary\s*\} from '\.\/provider-checks\.mjs';\r?\n/, '')
  .replaceAll('import.meta.url', JSON.stringify('http://127.0.0.1:4174/src/assistant.mjs'));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const copy = value => JSON.parse(JSON.stringify(value));
const blank = (id, title = 'Conversation') => ({ id, title, revision: 0, createdAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:00Z', activeRequestId: null, turns: [] });

function historyRecord(flow,result,{id=C,operationId=null}={}){return{run:{id,workflowId:flow.id,name:flow.name||'Original workflow',status:result.status,stepCount:flow.steps?.length||0,completedStepCount:result.steps?.length||0,startedAt:null,updatedAt:null,finishedAt:null,timestampsAvailable:false,runRevision:'a'.repeat(64)},definitionText:JSON.stringify(flow),outcomeText:JSON.stringify(result),operationId};}
function historyPage(record,params=new URLSearchParams()){const definitionOffset=Number(params.get('definitionOffset')||0),outcomeOffset=Number(params.get('outcomeOffset')||0),section=(name,offset)=>{const text=record[name+'Text'];return{[name+'Text']:text.slice(offset,offset+4000),[name+'Offset']:offset,[name+'Length']:text.length,[name+'HasMore']:offset+4000<text.length,['next'+name[0].toUpperCase()+name.slice(1)+'Offset']:offset+4000<text.length?offset+4000:null};};return{run:record.run,...section('definition',definitionOffset),...section('outcome',outcomeOffset)};}
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
  reset() {}
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

async function createUI({ saved = [], selected = null, intercept = null, waitForConversations = true, locks = createLocks(), workspacePreferences = [], workspaceWorkflows = [], savedWorkflowHistory = [], workspaceTasks = [], workspaceNotes = [], deadlineTimezone = 'America/Vancouver', storedWorkflowRuns = [], catalog = [], contextWindows = [], savedWork = [], storedWorkIds = [], runtimeBaseline = null, runtimeClock = null, projects = [], storedProject = null, savedContinuations = [], savedBuilds = [], providerDescriptors = null, savedProviderChecks = [], storedProviderCheckIds = [] } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  nodes.get('provider-type').value = 'openai';
  const records = new Map(saved.map(item => [item.id, structuredClone(item)]));
  const historyRecords=new Map(savedWorkflowHistory.map(item=>[item.run.id,structuredClone(item)]));
  const workRecords = new Map(savedWork.map(item => [item.id, structuredClone(item)]));
  const providerCheckRecords=new Map(savedProviderChecks.map(item=>[item.id,structuredClone(item)]));
  let providerList=providerDescriptors?structuredClone(providerDescriptors):[{id:'codex',type:'codex',label:'GPT',model:'',ready:true,availability:'signed_in',revision:A,connectionCheck:null}],providerActiveId=providerList[0]?.id||'';
  const continuationRecords = new Map(savedContinuations.map(item => [item.id, structuredClone(item)]));
  const buildRecords = new Map(savedBuilds.map(item => [item.id, structuredClone(item)]));
  const projectRecords = new Map(projects.map(item => [item.projectId, structuredClone(item)]));
  const storage = new Map(selected ? [['companion.workspace.ui.v1.conversationId', JSON.stringify(selected)]] : []);
  if(storedProviderCheckIds.length)storage.set('companion.provider.checks.pending.v1',JSON.stringify(storedProviderCheckIds));
  if (storedProject) storage.set('companion.workspace.ui.v1.selectedProject', JSON.stringify(storedProject));
  if (storedWorkIds.length) storage.set('companion.workspace.ui.v1.pendingWorkIds', JSON.stringify(storedWorkIds));
  if (storedWorkflowRuns.length) storage.set('companion.workspace.ui.v1.pendingWorkflowRuns', JSON.stringify(storedWorkflowRuns));
  const requests = [], intervals = [], timers = new Set(), workflowReceipts=new Map();
  const workspace = { revision: 0, tasks: structuredClone(workspaceTasks), notes: structuredClone(workspaceNotes), workflows: structuredClone(workspaceWorkflows), preferences: structuredClone(workspacePreferences), focus: null, activity: [] };
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
    if(route==='providers'||route==='providers/select'||route==='providers/configure'||route==='providers/remove'){
      if(route==='providers/select')providerActiveId=JSON.parse(options.body).id;
      if(route==='providers/configure'){const {apiKey,...body}=JSON.parse(options.body),previous=providerList.find(item=>item.id===body.id);providerList=[...providerList.filter(item=>item.id!==body.id),{...previous,...body,revision:webcrypto.randomUUID(),ready:true,availability:'configured',hasKey:!!apiKey||previous?.hasKey,connectionCheck:null}];}
      if(route==='providers/remove')providerList=providerList.filter(item=>item.id!==JSON.parse(options.body).id);
      const listed=providerList.map(item=>{const checks=[...providerCheckRecords.values()].filter(check=>check.providerId===item.id).reverse().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return{...item,connectionCheck:checks[0]||item.connectionCheck||null};});return response({providers:listed,activeProviderId:providerActiveId,connectionChecksAvailable:true});
    }
    if(route==='provider-checks'&&options.method==='POST'){const body=JSON.parse(options.body),provider=providerList.find(item=>item.id===body.providerId),check={id:body.id,providerId:body.providerId,revision:body.revision,provider:{id:provider.id,type:provider.type,label:provider.label,model:provider.model,...(provider.baseUrl?{baseUrl:provider.baseUrl}:{}),revision:body.revision},status:'queued',createdAt:new Date().toISOString(),configurationMatches:provider.revision===body.revision,observedThisSession:true,completionOnly:true,scope:'app_configuration'};providerCheckRecords.set(check.id,check);return response({check},202);}
    if(route==='provider-checks')return response({checks:[...new Map([...providerCheckRecords.values()].map(check=>[check.providerId,check])).values()],total:providerCheckRecords.size});
    if(route.startsWith('provider-checks/')){const [,id,action]=route.split('/'),check=providerCheckRecords.get(id);if(!check)return response({error:{code:'provider_check_not_found',message:'Test not found'}},404);if(action==='cancel')check.status='stopping';return response({check});}
    if(route==='stop'){for(const check of providerCheckRecords.values())if(['queued','running','stopping'].includes(check.status))check.status='cancelled';return response({stopped:true,desktop:{cancelled:0},builds:[],checks:[...providerCheckRecords.values()].map(({id,status})=>({id,status}))});}
    if(route==='desktop/stop')return response({stopped:true});
    if (route === 'status') return response({ transcriptionReady: true });
    if(route.startsWith('workflow-runs?')){const query=new URLSearchParams(route.split('?')[1]),offset=Number(query.get('before')||0),filter=query.get('workflowId'),all=[...historyRecords.values()].filter(item=>!filter||item.run.workflowId===filter),values=all.slice(offset,offset+20).map(item=>item.run);return response({runs:values,returned:values.length,hasMore:offset+20<all.length,nextCursor:offset+20<all.length?String(offset+20):null,scanned:values.length,scanHasMore:offset+20<all.length});}
    if(/^workspace\/workflows\/[^/]+\/(runs|operations)\//.test(route)){const url=new URL('http://fixture/'+route),parts=url.pathname.split('/'),flowId=parts[3],kind=parts[4],id=parts[5],record=[...historyRecords.values()].find(item=>item.run.workflowId===flowId&&(kind==='runs'?item.run.id===id:item.operationId===id));if(!record)return response({error:{code:'workflow_run_not_found',message:'Saved run missing'}},404);return response(historyPage(record,url.searchParams));}
    if (route === 'workspace') return response(workspace);
    if(route==='deadline-context')return response(createDeadlineContext({timezone:deadlineTimezone,asOf:runtimeClock?.value??Date.now()}));
    if(route.startsWith('task-deadlines?')){const query=new URLSearchParams(route.split('?')[1]);return response(taskDeadlineView(workspace,{timezone:query.get('timezone'),expectedRevision:Number(query.get('expectedRevision'))},runtimeClock?.value??Date.now()));}
    if(route.startsWith('deadline-resolve?')){const query=new URLSearchParams(route.split('?')[1]),timezone=query.get('timezone');if(query.has('dueAt'))return response(formatDeadlineInstant(query.get('dueAt'),timezone,runtimeClock?.value??Date.now()));return response(resolveLocalDeadline({timezone,localDateTime:query.get('localDateTime')}));}
    if(route==='workspace/operations'){
      const body=JSON.parse(options.body);if(['addTask','updateTask','completeTask','updateNote'].includes(body.type)){if(workflowReceipts.has(body.operationId))return response({...workflowReceipts.get(body.operationId),workspace,replayed:true});if(body.expectedRevision!==workspace.revision)return response({error:{code:'revision_conflict',message:'Workspace changed'},workspace},409);let task,note;if(body.type==='addTask'){task={id:body.operationId,title:body.title,details:body.details||'',project:body.project||'',priority:body.priority||'normal',status:'todo',dueDate:null,dueAt:null,createdAt:'2026-10-25T12:00:00Z'};workspace.tasks.push(task);}else if(body.type==='updateNote'){note=workspace.notes.find(item=>item.id===body.noteId);for(const key of ['title','text'])if(Object.hasOwn(body,key))note[key]=body[key];}else{task=workspace.tasks.find(item=>item.id===body.taskId);if(body.type==='completeTask')task.status='done';for(const key of ['title','details','project','priority','status'])if(Object.hasOwn(body,key))task[key]=body[key];}if(task){const deadline=normalizeDeadline(body);if(deadline)Object.assign(task,deadline);}workspace.revision++;const result={workspace:structuredClone(workspace),...(task?{task:structuredClone(task)}:{}),appliedRevision:workspace.revision,replayed:false};workflowReceipts.set(body.operationId,result);return response(result);}if(!['saveWorkflow','setWorkflowEnabled'].includes(body.type))throw new Error('Unexpected workspace operation '+body.type);if(workflowReceipts.has(body.operationId))return response({...workflowReceipts.get(body.operationId),workspace,replayed:true});if(body.expectedRevision!==workspace.revision)return response({error:{code:'revision_conflict',message:'Workspace changed'},workspace},409);
      let flow=workspace.workflows.find(item=>item.id===body.workflowId),originalWorkflow=flow?structuredClone(flow):null;
      if(body.type==='setWorkflowEnabled'){if(!flow)return response({error:{code:'not_found',message:'Workflow missing'}},404);flow.enabled=body.enabled;}else{const updated={id:body.workflowId||body.operationId,name:body.name,description:body.description,enabled:body.enabled??flow?.enabled??true,steps:structuredClone(Object.hasOwn(body,'steps')?body.steps:flow?.steps||[]),updatedAt:'2026-10-25T12:00:01Z'};if(flow)Object.assign(flow,updated);else workspace.workflows.push(updated);flow=updated;}
      workspace.revision++;const result={workspace:structuredClone(workspace),workflow:structuredClone(flow),originalWorkflow,replayed:false};workflowReceipts.set(body.operationId,result);return response(result);
    }

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
  const context = vm.createContext({ Date: ClockDate, normalizeDeadline, createVoiceSession, window, document, navigator: { locks, permissions: { query: async () => ({ state: 'granted' }) }, mediaDevices: { getUserMedia: () => { permission = deferred(); return permission.promise; } } }, MediaRecorder: Recorder, fetch: fetchMock, Headers, AbortController, TextEncoder, Blob, URL, URLSearchParams, DOMException, crypto: webcrypto, structuredClone, performance, console, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, location: { search: '', reload() {}, assign() {} }, Event: class {}, setTimeout: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref(); timers.add(timer); return timer; }, clearTimeout, setInterval: callback => { intervals.push(callback); return intervals.length; }, requestAnimationFrame: () => 0, cancelAnimationFrame() {} });
  context.createWorkflowEditor=vm.runInContext('(function(){'+workflowEditorSource+'\nreturn createWorkflowEditor;})()',context);
  context.createWorkflowHistoryUI=vm.runInContext('(function(){'+workflowHistorySource+'\nreturn createWorkflowHistoryUI;})()',context);
  context.createWorkspaceBackupsUI=vm.runInContext('(function(){'+workspaceBackupsSource+'\nreturn createWorkspaceBackupsUI;})()',context);
  const providerChecksModule=vm.runInContext('(function(){'+providerChecksSource+'\nreturn {createProviderChecksUI,providerAvailabilityText,providerCheckSummary};})()',context);Object.assign(context,providerChecksModule);
  context.createBuildAttemptsUI=vm.runInContext('(function(){'+buildAttemptsSource+'\nreturn createBuildAttemptsUI;})()',context);
  context.createBuildContinuationUI=vm.runInContext('(function(){'+buildContinuationSource+'\nreturn createBuildContinuationUI;})()',context);
  context.createProjectFilesUI=vm.runInContext('(function(){'+projectFilesSource+'\nreturn createProjectFilesUI;})()',context);
  vm.runInContext(source + '\nglobalThis.ui={ready:()=>checkingService,selectConversation,refreshConversations,refreshConversation,loadEarlierConversation,runCommand,cancelTurn,stopAllActivity,startRecording,setVoiceVisible,renderSavedConversation,rememberDesktopAction,captureConversationContext,setChatOpen,showDialog,openDesktopReview,addMessage,processVoiceSegment,refreshToolCatalog,applyToolCatalog,applyExtensionManifest,openFeatureByName,openWorkflow,renderWorkflowSteps,validateWorkflowSteps,openEditor,refreshDeadlineContext,refreshTaskClock,renderTasks,runWorkflow,showWorkflowHistory,openSavedWorkflowRun,renderActionReceipts,appendInstalledFeatureReady,refreshJobs,refreshWorkspace,selectWindowContext,clearWindowContext,captureWindowContext,renderWindowContext,applyRuntime,reconnectAfterRestart,restartCompanionService,runtimeRestartConfirmed,jobAction,submitWork,refreshWork,refreshWorkDetail,selectWork,checkWorkHandoff,cancelWork,openWorkConversation,showView,loadWorkOutcome,applyProviders,captureBuildContinuationContext,currentBuildContinuationContext,continueBuildOriginal,initBuildContinuationUI,captureProviderCheckContext,currentProviderCheckContext,testSelectedProvider,selectBuild:id=>{selectedJobId=id;renderJobs();},selectProject,refreshProjectAccess,captureProjectContext,currentProjectContext,setExtensionLoader:loader=>loadExtensionModule=loader,get:()=>({editingTarget,editorGeneration,editorDeadline,deadlineContext,deadlineTasksRevision,deadlineContextError,taskDeadlineFilter,pendingWorkspaceRequest,id:conversationId,detail:conversationDetail,localChatTurn,turnBusy,recording,voiceCaptureContext,activeRequest,selectedWindowContext,windowContextGeneration,selectedProject,projectSelectionGeneration,voiceState:voiceSessionState,chatOpen,currentView,ownsVoice:voiceOwnsCapture,initial:conversationInitialized,listPending:!!conversationListPending,detailPending:!!conversationDetailRequest,desktop:desktopActions,workflowDraft:getWorkflowDraft(),toolCatalog,extensions:[...extensions.values()],workspace,workflowHistoryUI,workJobs,selectedWorkId,workDetails:[...workDetails.values()],workSubmitting,pendingWorkIds:[...pendingWorkIds],runtimeInfo,runtimeRetry,runtimeNotice,selectedJobId,buildContinuationUI,providerChecksUI,activeProviderId,providers,buildJobsPending:jobsPending,buildDetailsPending:jobDetailPending.size,reconnecting:!!runtimeReconnectPromise})};', context);
  await context.ui.ready();
  if (waitForConversations) await until(() => !context.ui.get().listPending && !context.ui.get().detailPending, 'initial conversation load');
  return { ui: context.ui, nodes, records, workRecords, projectRecords, continuationRecords, buildRecords, providerCheckRecords, storage, requests, document, intervals, setIntercept: value => { custom = value; }, get waitingForMicrophone() { return !!permission; }, grantMicrophone: () => { const pending = permission; permission = null; pending.resolve({ getTracks: () => [{ stop: () => stoppedTracks++ }] }); }, get stoppedTracks() { return stoppedTracks; }, close: () => { context.ui.cancelTurn(false); for (const timer of timers) clearTimeout(timer); } };
}

const descendants = node => [node, ...node.children.flatMap(descendants)];
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444', E = '55555555-5555-4555-8555-555555555555', F = '66666666-6666-4666-8666-666666666666';
const serviceFixture = values => ({ managed: true, restarting: false, hostPid: 10, workerPid: 100, supervisorPid: 5, hostInstanceId: A, workerInstanceId: B, supervisorInstanceId: C, hostRestartAvailable: true, ...values });
const freshService = () => serviceFixture({ hostPid: 20, workerPid: 200, hostInstanceId: D, workerInstanceId: E });
const delayTurn = () => new Promise(resolve => setTimeout(resolve, 15));

export { createUI, Element, createLocks, response, deferred, copy, blank, until, historyRecord, historyPage, html, A, B, C, D, E, F, descendants, serviceFixture, freshService, delayTurn };
