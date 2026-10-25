import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { builtinCatalog, validateWorkflowSteps } from './capability-registry.mjs';
import { windowContextReference } from './window-context.mjs';
import { projectReference, projectEditReference, projectReadReference } from './project-files-context.mjs';
import {continuationReference} from './continuation-context.mjs';
import { installWorkStore } from './work-store.mjs';
import { workflowDefinitionHash } from './workflow-queries.mjs';
import { normalizeDeadline } from '../src/core/productivity-deadlines.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const iso = value => new Date(value).toISOString();
function text(value, limit, label, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw fail('invalid_input', `${label} must contain ${empty ? '0' : '1'}–${limit} characters.`);
  return value.trim();
}
function id(value, label) { if (typeof value !== 'string' || !UUID.test(value)) throw fail('invalid_id', `Choose a valid ${label}.`); return value; }
function tags(value = []) { if (!Array.isArray(value) || value.length > 12) throw fail('invalid_tags', 'Use at most 12 tags.'); return [...new Set(value.map(t => text(t, 40, 'Tag')))]; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const initial = () => ({ revision: 0, tasks: [], notes: [], workflows: [], preferences: [], focus: null, activity: [] });
const CONVERSATION_DEFAULTS = Object.freeze({ conversations: 200, turns: 400, outcomeBytes: 512 * 1024, totalBytes: 64 * 1024 * 1024 });
const WORKFLOW_RECEIPT_BYTES = 32 * 1024 * 1024;
const TASK_RECEIPT_BYTES = 32 * 1024 * 1024;

/** One persistent workspace for the current OS user. Reading-room accounts are separate. */
export async function createProductivityStore({ dataDirectory, now = Date.now, conversationLimits = {}, workflowReceiptBytes = WORKFLOW_RECEIPT_BYTES, taskReceiptBytes = TASK_RECEIPT_BYTES } = {}) {
  if (!dataDirectory) throw new Error('A private data directory is required.');
  const limits = { ...CONVERSATION_DEFAULTS, ...conversationLimits };
  if (Object.keys(conversationLimits).some(key => !Object.hasOwn(CONVERSATION_DEFAULTS, key)) || Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > CONVERSATION_DEFAULTS[key]) || limits.outcomeBytes < 8192 || limits.totalBytes < 2 * limits.outcomeBytes + 65536) throw new TypeError('Use bounded conversation storage limits.');
  if (!Number.isSafeInteger(workflowReceiptBytes) || workflowReceiptBytes < 1024 || workflowReceiptBytes > WORKFLOW_RECEIPT_BYTES) throw new TypeError('Use a routine receipt budget from 1024 bytes to 32 MiB.');
  if (!Number.isSafeInteger(taskReceiptBytes) || taskReceiptBytes < 1024 || taskReceiptBytes > TASK_RECEIPT_BYTES) throw new TypeError('Use a task receipt budget from 1024 bytes to 32 MiB.');
  await mkdir(dataDirectory, { recursive: true });
  const db = new DatabaseSync(path.toNamespacedPath(path.join(dataDirectory, 'productivity.sqlite')));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_receipts(id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chat_receipts(id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, reply TEXT);');
  // Keep the original two-column receipt table compatible with previous writers.
  db.exec('CREATE TABLE IF NOT EXISTS workflow_mutation_receipts(id TEXT PRIMARY KEY, result_json TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS task_mutation_receipts(id TEXT PRIMARY KEY, result_json TEXT NOT NULL)');
  db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,auto_title INTEGER NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,active_request_id TEXT,last_status TEXT);
    CREATE TABLE IF NOT EXISTS conversation_turns(sequence INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,request_id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,message TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,outcome_json TEXT,base_bytes INTEGER NOT NULL,stored_bytes INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS conversation_turns_order ON conversation_turns(conversation_id,sequence);
    CREATE TABLE IF NOT EXISTS conversation_preferences(id INTEGER PRIMARY KEY CHECK(id=1),active_conversation_id TEXT);`);
  db.exec('CREATE TABLE IF NOT EXISTS execution_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,definition_json TEXT NOT NULL,checkpoint_json TEXT,result_json TEXT);');
  db.prepare('INSERT OR IGNORE INTO workspace VALUES(1,?)').run(JSON.stringify(initial()));
  const snapshot = () => { const state = JSON.parse(db.prepare('SELECT state FROM workspace WHERE id=1').get().state); if (!Object.hasOwn(state, 'preferences')) state.preferences = []; if (!Array.isArray(state.preferences)) throw fail('workspace_invalid', 'Saved preferences could not be loaded safely.', 503); return state; };
  let closed = false;
  let workflowCatalog=builtinCatalog();
  function configureWorkflowTools(catalog){if(!Array.isArray(catalog)||catalog.length>100||new Set(catalog.map(item=>item.name)).size!==catalog.length)throw fail('invalid_catalog','Use a bounded unique workflow catalog.');workflowCatalog=structuredClone(catalog);}
  function workflowSteps(value, previous) {
    if (value === undefined && previous) return structuredClone(previous.steps);
    if (!previous) return validateWorkflowSteps(value, workflowCatalog);
    if (!Array.isArray(value)) return validateWorkflowSteps(value, workflowCatalog);
    const retained = value.map(step => {
      if (!step || typeof step.tool !== 'string' || !step.tool.startsWith('cap_') || step.capability !== undefined) return step;
      const originals = previous.steps.filter(saved => saved.tool === step.tool && saved.capability);
      if (!originals.length || originals.some(saved => hash(saved.capability) !== hash(originals[0].capability))) throw fail('capability_changed', 'Explicitly select the current registered capability version before adding or changing this routine step.', 409);
      return { ...step, capability: structuredClone(originals[0].capability) };
    });
    return validateWorkflowSteps(retained, workflowCatalog);
  }
  function checkWorkflowHash(operation, workflow, revision) {
    if (operation.expectedDefinitionHash === undefined) return;
    if (typeof operation.expectedDefinitionHash !== 'string' || !/^[a-f\d]{64}$/.test(operation.expectedDefinitionHash)) throw fail('invalid_input', 'Use the exact routine definition hash.');
    const current = workflowDefinitionHash(workflow);
    if (operation.expectedDefinitionHash !== current) throw Object.assign(fail('workflow_changed', 'This routine changed. Read its current definition before saving.', 409), { revision, definitionHash: current });
  }
  function workflowReceipt(receipt, operation) {
    if (receipt.workflow_result_json == null) return { workflow: { id: operation.workflowId || operation.operationId }, appliedRevision: null, originalDefinitionUnavailable: true };
    let result; try { result = JSON.parse(receipt.workflow_result_json); } catch { throw fail('workflow_receipt_unavailable', 'The original routine save receipt could not be read.', 503); }
    if (!result || Object.keys(result).some(key => !['workflow','appliedRevision'].includes(key)) || !result.workflow || result.workflow.id !== (operation.workflowId || operation.operationId) || !Number.isSafeInteger(result.appliedRevision) || result.appliedRevision < 1) throw fail('workflow_receipt_unavailable', 'The original routine save receipt could not be matched.', 503);
    return result;
  }
  function taskReceipt(receipt, operation) {
    if (receipt.task_result_json == null) return { task: { id: operation.taskId || operation.operationId }, appliedRevision: null, originalTaskUnavailable: true };
    let result; try { result = JSON.parse(receipt.task_result_json); } catch { throw fail('task_receipt_unavailable', 'The original task change receipt could not be read.', 503); }
    if (!result || Object.keys(result).some(key => !['task','appliedRevision'].includes(key)) || !result.task || result.task.id !== (operation.taskId || operation.operationId) || !Number.isSafeInteger(result.appliedRevision) || result.appliedRevision < 1) throw fail('task_receipt_unavailable', 'The original task change receipt could not be matched.', 503);
    return result;
  }
  function apply(operation) {
    if (closed) throw fail('workspace_closed', 'The workspace is shutting down.', 503);
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw fail('invalid_input', 'Provide a workspace operation.');
    id(operation.operationId, 'operation ID');
    if (!Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 0) throw fail('invalid_revision', 'Use the current workspace revision.');
    if (JSON.stringify(operation).length > 90000) throw fail('input_too_large', 'This change is too large.', 413);
    const { expectedRevision: _precondition, ...semanticOperation } = operation;
    const digest = hash(semanticOperation);
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = snapshot();
      const receipt = db.prepare('SELECT w.hash,r.result_json AS workflow_result_json,t.result_json AS task_result_json FROM workspace_receipts w LEFT JOIN workflow_mutation_receipts r ON r.id=w.id LEFT JOIN task_mutation_receipts t ON t.id=w.id WHERE w.id=?').get(operation.operationId);
      if (receipt) {
        if (receipt.hash !== digest) throw fail('operation_conflict', 'That operation ID was already used for another change.', 409);
        const result = ['saveWorkflow','setWorkflowEnabled'].includes(operation.type) ? workflowReceipt(receipt, operation) : ['addTask','updateTask','completeTask'].includes(operation.type) ? taskReceipt(receipt, operation) : {};
        db.exec('COMMIT'); return { workspace: state, replayed: true, ...result };
      }
      if (state.revision !== operation.expectedRevision) throw fail('revision_conflict', 'The workspace changed. Your draft is still available; review the latest state and try again.', 409);
      const at = iso(now()); let summary, changedWorkflow, changedTask;
      const task = taskId => { const item = state.tasks.find(t => t.id === id(taskId, 'task')); if (!item) throw fail('not_found', 'That task was not found.', 404); return item; };
      const note = noteId => { const item = state.notes.find(n => n.id === id(noteId, 'note')); if (!item) throw fail('not_found', 'That note was not found.', 404); return item; };
      const optionalText = (value, limit, label) => text(value ?? '', limit, label, true);
      switch (operation.type) {
        case 'addTask': {
          if (state.tasks.length >= 2000) throw fail('workspace_limit', 'This workspace supports up to 2,000 tasks.');
          const priority = operation.priority ?? 'normal'; if (!['normal','high'].includes(priority)) throw fail('invalid_priority', 'Choose normal or high priority.');
          const item = { id: operation.operationId, title: text(operation.title, 300, 'Task title'), details: optionalText(operation.details, 12000, 'Task details'), status: 'todo', priority, project: optionalText(operation.project, 100, 'Project'), ...(normalizeDeadline(operation) || { dueDate: null, dueAt: null }), createdAt: at, updatedAt: at };
          state.tasks.push(item); changedTask = item; summary = `Added task: ${item.title}`; break;
        }
        case 'updateTask': case 'completeTask': {
          const item = task(operation.taskId);
          if (operation.title !== undefined) item.title = text(operation.title, 300, 'Task title');
          if (operation.details !== undefined) item.details = text(operation.details, 12000, 'Task details', true);
          if (operation.project !== undefined) item.project = text(operation.project, 100, 'Project', true);
          if (operation.priority !== undefined) { if (!['normal','high'].includes(operation.priority)) throw fail('invalid_priority', 'Choose normal or high priority.'); item.priority = operation.priority; }
          const deadline = normalizeDeadline(operation); if (deadline) Object.assign(item, deadline);
          if (operation.status !== undefined) { if (!['todo','done'].includes(operation.status)) throw fail('invalid_status', 'Choose todo or done.'); item.status = operation.status; }
          if (operation.type === 'completeTask') item.status = 'done';
          item.updatedAt = at; changedTask = item; summary = `${item.status === 'done' ? 'Completed' : 'Updated'} task: ${item.title}`; break;
        }
        case 'addNote': {
          if (state.notes.length >= 1000) throw fail('workspace_limit', 'This workspace supports up to 1,000 notes.');
          const content = text(operation.text, 40000, 'Note');
          const item = { id: operation.operationId, title: operation.title ? text(operation.title, 200, 'Note title') : content.split('\n')[0].slice(0, 100), text: content, tags: tags(operation.tags), archived: false, createdAt: at, updatedAt: at };
          state.notes.push(item); summary = `Saved note: ${item.title}`; break;
        }
        case 'updateNote': case 'archiveNote': {
          const item = note(operation.noteId);
          if (operation.title !== undefined) item.title = text(operation.title, 200, 'Note title');
          if (operation.text !== undefined) item.text = text(operation.text, 40000, 'Note');
          if (operation.tags !== undefined) item.tags = tags(operation.tags);
          if (operation.type === 'archiveNote') { if (operation.archived !== undefined && typeof operation.archived !== 'boolean') throw fail('invalid_input', 'Archived must be true or false.'); item.archived = operation.archived ?? true; }
          item.updatedAt = at; summary = `${item.archived ? 'Archived' : 'Updated'} note: ${item.title}`; break;
        }
        case 'saveWorkflow': {
          let item = operation.workflowId !== undefined ? state.workflows.find(w => w.id === id(operation.workflowId, 'workflow')) : null;
          if (operation.workflowId !== undefined && !item) throw fail('not_found', 'That workflow was not found.', 404);
          if (!item && state.workflows.length >= 100) throw fail('workspace_limit', 'Keep at most 100 workflows.');
          if (operation.enabled !== undefined && typeof operation.enabled !== 'boolean') throw fail('invalid_input', 'Enabled must be true or false.');
          if (item && !['name','description','steps','enabled'].some(key => operation[key] !== undefined)) throw fail('invalid_input', 'Choose at least one routine field to change.');
          if (item) checkWorkflowHash(operation, item, state.revision);
          else if (operation.expectedDefinitionHash !== undefined) throw fail('invalid_input', 'A new routine has no previous definition hash.');
          const update = { name: operation.name === undefined && item ? item.name : text(operation.name, 200, 'Workflow name'),
            description: operation.description === undefined && item ? item.description : optionalText(operation.description, 2000, 'Workflow description'),
            steps: workflowSteps(operation.steps, item), enabled: operation.enabled ?? item?.enabled ?? true, updatedAt: at };
          if (item) Object.assign(item, update); else { item = { id: operation.operationId, ...update, createdAt: at }; state.workflows.push(item); }
          changedWorkflow = item;
          summary = `Saved workflow: ${item.name}`; break;
        }
        case 'setWorkflowEnabled': {
          if (Object.keys(operation).some(key => !['operationId','expectedRevision','type','workflowId','enabled','expectedDefinitionHash'].includes(key)) || typeof operation.enabled !== 'boolean') throw fail('invalid_input', 'Choose one routine and an enabled state.');
          const item = state.workflows.find(workflow => workflow.id === id(operation.workflowId, 'workflow'));
          if (!item) throw fail('not_found', 'That workflow was not found.', 404);
          checkWorkflowHash(operation, item, state.revision);
          item.enabled = operation.enabled; item.updatedAt = at; changedWorkflow = item;
          summary = `${item.enabled ? 'Enabled' : 'Disabled'} workflow: ${item.name}`; break;
        }
        case 'rememberPreference': {
          const key = text(operation.key, 64, 'Preference key');
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw fail('invalid_preference_key', 'Use a lowercase preference key with letters, numbers, underscores or hyphens.');
          const value = text(operation.value, 1000, 'Preference value');
          let item = state.preferences.find(preference => preference.key === key);
          if (!item && state.preferences.length >= 50) throw fail('preference_limit', 'Keep at most 50 retained preferences, including forgotten entries.');
          const label = operation.label === undefined ? item?.label || key : text(operation.label, 100, 'Preference label');
          if (item) Object.assign(item, { label, value, archived: false, updatedAt: at });
          else { item = { id: operation.operationId, key, label, value, createdAt: at, updatedAt: at, archived: false }; state.preferences.push(item); }
          summary = `Remembered preference: ${label}`; break;
        }
        case 'forgetPreference': {
          const preferenceId = id(operation.preferenceId, 'preference'); const item = state.preferences.find(preference => preference.id === preferenceId);
          if (!item) throw fail('not_found', 'That preference was not found.', 404);
          item.archived = true; item.updatedAt = at; summary = `Forgot preference: ${item.label}`; break;
        }
        case 'startFocus': {
          if (!Number.isInteger(operation.minutes) || operation.minutes < 1 || operation.minutes > 240) throw fail('invalid_duration', 'Choose a focus session between 1 and 240 minutes.');
          state.focus = { id: randomUUID(), label: optionalText(operation.label, 200, 'Focus label') || 'Focus time', startedAt: at, endsAt: iso(now() + operation.minutes * 60000) }; summary = `Started ${operation.minutes} minutes of focus`; break;
        }
        case 'stopFocus': state.focus = null; summary = 'Ended focus session'; break;
        default: throw fail('unknown_operation', 'That workspace change is not supported.');
      }
      state.revision += 1; state.activity.push({ id: randomUUID(), type: operation.type, summary, at }); state.activity = state.activity.slice(-250);
      const encoded = JSON.stringify(state); if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw fail('workspace_limit', 'The workspace is full. Export or archive material before adding more.');
      db.prepare('UPDATE workspace SET state=? WHERE id=1').run(encoded);
      if (db.prepare('SELECT count(*) AS count FROM workspace_receipts').get().count >= 50000) throw fail('workspace_limit', 'This workspace has reached its operation receipt limit.');
      const result = changedWorkflow ? { workflow: structuredClone(changedWorkflow), appliedRevision: state.revision } : changedTask ? { task: structuredClone(changedTask), appliedRevision: state.revision } : {};
      const workflowResult = changedWorkflow ? JSON.stringify(result) : null;
      const taskResult = changedTask ? JSON.stringify(result) : null;
      if (workflowResult !== null) {
        const retained = db.prepare('SELECT COALESCE(sum(length(CAST(result_json AS BLOB))),0) AS bytes FROM workflow_mutation_receipts').get().bytes;
        if (retained + Buffer.byteLength(workflowResult) > workflowReceiptBytes) throw fail('workflow_receipt_limit', 'Saved routine history reached its receipt limit. Existing results are retained; no new routine change was saved.', 429);
      }
      if (taskResult !== null) {
        const retained = db.prepare('SELECT COALESCE(sum(length(CAST(result_json AS BLOB))),0) AS bytes FROM task_mutation_receipts').get().bytes;
        if (retained + Buffer.byteLength(taskResult) > taskReceiptBytes) throw fail('task_receipt_limit', 'Saved task change history reached its receipt limit. Existing results are retained; no new task change was saved.', 429);
      }
      db.prepare('INSERT INTO workspace_receipts VALUES(?,?)').run(operation.operationId, digest);
      if (changedWorkflow) db.prepare('INSERT INTO workflow_mutation_receipts(id,result_json) VALUES(?,?)').run(operation.operationId, workflowResult);
      if (changedTask) db.prepare('INSERT INTO task_mutation_receipts(id,result_json) VALUES(?,?)').run(operation.operationId, taskResult);
      db.exec('COMMIT'); return { workspace: state, replayed: false, ...result };
    } catch (error) { db.exec('ROLLBACK'); if (error.statusCode === 409) error.workspace = snapshot(); throw error; }
  }
  function chatReceipt(requestId, digest) {
    const saved = db.prepare('SELECT hash,state,reply FROM chat_receipts WHERE id=?').get(requestId);
    if (!saved) return null;
    if (saved.hash !== digest) throw fail('request_conflict', 'That request ID was used for different input.', 409);
    return { state: saved.state, reply: saved.reply ? JSON.parse(saved.reply) : null };
  }
  function beginChat(requestId, digest) {
    const saved = chatReceipt(requestId, digest); if (saved) return saved;
    if (db.prepare('SELECT count(*) AS count FROM chat_receipts').get().count >= 50000) throw fail('workspace_limit', 'The workspace has reached its request history limit.');
    db.prepare('INSERT INTO chat_receipts VALUES(?,?,?,NULL)').run(requestId, digest, 'in_progress');
    return null;
  }
  function finishChat(requestId, digest, reply, failed = false) {
    const encoded = JSON.stringify(reply); if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw fail('response_limit', 'The request receipt is too large.');
    if (!chatReceipt(requestId, digest)) throw fail('missing_request', 'The request receipt was not found.');
    db.prepare('UPDATE chat_receipts SET state=?,reply=? WHERE id=? AND hash=?').run(failed ? 'failed' : 'completed', encoded, requestId, digest);
  }

  function checkOpen() { if (closed) throw fail('workspace_closed', 'The workspace is shutting down.', 503); }
  function transaction(callback) { checkOpen(); db.exec('BEGIN IMMEDIATE'); try { const value = callback(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function executionIdentity(requestId,digest){if(typeof requestId!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(requestId)||typeof digest!=='string'||!/^[a-f\d]{64}$/.test(digest))throw fail('invalid_input','Use a bounded execution identity and SHA-256 digest.');}
  function executionReceipt(requestId,digest){checkOpen();executionIdentity(requestId,digest);const saved=db.prepare('SELECT * FROM execution_receipts WHERE id=?').get(requestId);if(!saved)return null;if(saved.hash!==digest)throw fail('request_conflict','That execution ID was used for different input.',409);return{state:saved.state,definition:JSON.parse(saved.definition_json),checkpoint:saved.checkpoint_json?JSON.parse(saved.checkpoint_json):null,result:saved.result_json?JSON.parse(saved.result_json):null};}
  function executionData(value){let result=dataCopy(value),encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>1024*1024){const trim=(item,depth=0,key='')=>{if(typeof item==='string')return item.length>600?item.slice(0,600)+'… [details truncated]':item;if(depth>14)return '[nested details omitted]';if(Array.isArray(item))return item.slice(0,['steps','hostActions'].includes(key)?12:8).map(part=>trim(part,depth+1));if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([name,part])=>[name,trim(part,depth+1,name)]));return item;};result={...trim(result),detailsTruncated:true};encoded=JSON.stringify(result);}if(Buffer.byteLength(encoded)>1024*1024)throw fail('response_limit','This execution receipt exceeds its bound.');return encoded;}
  function beginExecution({id:requestId,digest,definition}){return transaction(()=>{const saved=executionReceipt(requestId,digest);if(saved)return saved;if(db.prepare('SELECT count(*) AS count FROM execution_receipts').get().count>=20000)throw fail('workspace_limit','The workspace has reached its execution receipt limit.');db.prepare('INSERT INTO execution_receipts VALUES(?,?,?,?,NULL,NULL)').run(requestId,digest,'in_progress',executionData(definition));return null;});}
  function checkpointExecution({id:requestId,digest,checkpoint}){return transaction(()=>{const saved=executionReceipt(requestId,digest);if(!saved||saved.state!=='in_progress')throw fail('execution_finished','This execution is no longer running.',409);db.prepare('UPDATE execution_receipts SET checkpoint_json=? WHERE id=? AND hash=?').run(executionData(checkpoint),requestId,digest);return executionReceipt(requestId,digest);});}
  function finishExecution({id:requestId,digest,result,failed=false}){return transaction(()=>{const saved=executionReceipt(requestId,digest);if(!saved)throw fail('missing_request','This execution receipt was not found.',409);const encoded=executionData(result),state=failed?'failed':'completed';if(saved.state!=='in_progress'){if(saved.state!==state||hash(saved.result)!==hash(JSON.parse(encoded)))throw fail('request_conflict','This execution already has a different outcome.',409);return saved;}db.prepare('UPDATE execution_receipts SET state=?,result_json=? WHERE id=? AND hash=?').run(state,encoded,requestId,digest);return executionReceipt(requestId,digest);});}
  function conversationRow(conversationId) { id(conversationId, 'conversation ID'); const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId); if (!row) throw fail('conversation_not_found', 'That conversation was not found.', 404); return row; }
  function requestIdentity(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw fail('invalid_id', 'Choose a valid conversation request ID.'); return value; }
  function requestDigest(value) { if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) throw fail('invalid_input', 'Use the conversation request SHA-256 digest.'); return value; }
  function dataCopy(value) { try { return JSON.parse(JSON.stringify(value, (key, entry) => key === 'rawContinuation' ? undefined : entry)); } catch { throw fail('invalid_input', 'Conversation outcomes must contain bounded JSON data.'); } }
  function minimalResult(source,depth=0){
    if(!source||typeof source!=='object'||depth>5)return{};const result={};
    if(source.windowContext)result.windowContext=windowContextReference(source.windowContext);
    if(source.projectContext)result.projectContext=projectReference(source.projectContext);
    if(source.projectFileEdit)result.projectFileEdit=projectEditReference(source.projectFileEdit);
    if(source.continuation)result.continuation=continuationReference(source.continuation);
    if(source.projectFileRead||source.sourceTrust==='untrusted_project_file')result.projectFileRead=projectReadReference(source.projectFileRead||source);
    for(const key of ['task','note','workflow','featureJob','desktopAction','desktopReceipt','workJob'])if(source[key]&&typeof source[key]==='object')result[key]={id:source[key].id,...(source[key].status?{status:source[key].status}:{}),...(key==='workJob'?{conversationId:source[key].conversationId,providerId:source[key].providerId}:{}),...(typeof source[key].outcomeUnknown==='boolean'?{outcomeUnknown:source[key].outcomeUnknown}:{}),...(key==='desktopAction'?{requiresFreshPreview:true}:{})};
    if(source.capability)result.capability={id:source.capability.id,name:source.capability.name,version:source.capability.version,hash:source.capability.hash};
    if(Array.isArray(source.hostActions))result.hostActions=source.hostActions.slice(0,12).map(action=>({id:action.id,tool:action.tool,status:action.status,result:minimalResult(action.result,depth+1)}));
    if(Array.isArray(source.steps))result.steps=source.steps.slice(0,12).map(step=>({tool:step.tool,...(step.status?{status:step.status}:{}),result:minimalResult(step.result,depth+1)}));
    if(source.failedStep)result.failedStep={index:source.failedStep.index,tool:source.failedStep.tool,...minimalResult(source.failedStep,depth+1)};
    for(const key of ['id','status','code'])if(typeof source[key]==='string')result[key]=source[key].slice(0,100);
    if(typeof source.outcomeUnknown==='boolean')result.outcomeUnknown=source.outcomeUnknown;
    if(source.error)result.error=typeof source.error==='string'?source.error.slice(0,120):'This action did not complete.';
    return result;
  }
  function compact(value, size = 1024, depth = 0, key = '') {
    if(key==='windowContext')return windowContextReference(value);
    if(key==='projectContext')return projectReference(value);
    if(key==='projectFileEdit')return projectEditReference(value);
    if(key==='continuation')return continuationReference(value);
    if(key==='projectFileRead'||value?.sourceTrust==='untrusted_project_file')return projectReadReference(value);
    if(value?.sourceType==='selected_window_accessibility')return{...minimalResult(value),readable:value.readable===true,sourceType:'selected_window_accessibility',trust:'untrusted_source_data',sourceOmitted:true};
    if (typeof value === 'string') return value.length > size ? value.slice(0, size) + '… [details truncated]' : value;
    if(key==='hostActions'&&Array.isArray(value))return minimalResult({hostActions:value}).hostActions;
    if(key==='capability'&&value&&typeof value==='object')return minimalResult({capability:value}).capability;
    if (depth > 5) return value&&typeof value==='object'?minimalResult(value):'[nested details omitted]';
    if (Array.isArray(value)) return value.slice(0, ['steps','hostActions'].includes(key) ? 12 : 8).map(item => compact(item, size, depth + 1));
    if (key === 'desktopAction' && value && typeof value === 'object') return { id: value.id, status: value.status, summary: compact(value.summary, size), target: compact(value.target, size, depth + 1), preview: value.preview, requiresApproval: value.requiresApproval, outcomeUnknown: value.outcomeUnknown, error: compact(value.error, size), ...(value.requiresFreshPreview ? { requiresFreshPreview: true } : {}) };
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, entry]) => [childKey, compact(entry, size, depth + 1, childKey)]));
    return value;
  }
  function boundedOutcome(value) {
    let result = dataCopy(value), encoded = JSON.stringify(result);
    if(result.windowContext)result.windowContext=windowContextReference(result.windowContext);
    if(result.projectContext)result.projectContext=projectReference(result.projectContext);
    if(result.continuation)result.continuation=continuationReference(result.continuation);
    encoded=JSON.stringify(result);
    if (Buffer.byteLength(encoded) <= limits.outcomeBytes) return { value: result, encoded };
    const originalActions = Array.isArray(result.actions) ? result.actions : [];
    result = { ...result, outcomeTruncated: true, ...(typeof result.text === 'string' ? { text: compact(result.text, Math.min(32000, Math.floor(limits.outcomeBytes / 16))) } : {}) };
    for (const size of [1024, 128]) {
      result.actions = originalActions.map(action => ({ id: action.id, tool: action.tool, status: action.status, arguments: compact(action.arguments, size), result: compact(action.result, size), resultTruncated: true }));
      if (result.featureJob) result.featureJob = compact(result.featureJob, size);
      encoded = JSON.stringify(result); if (Buffer.byteLength(encoded) <= limits.outcomeBytes) return { value: result, encoded };
    }
    result.actions = originalActions.map(action => {
      const source = action.result || {}, references = minimalResult(source);
      return { id: action.id, tool: action.tool, status: action.status, result: { ...references, ...(source.error ? { error: compact(source.error, 120), code: source.code } : {}), summary: 'Detailed result omitted; use its stored entity or build/action ID for current data.' }, resultTruncated: true };
    });
    if (result.featureJob) result.featureJob = { id: result.featureJob.id, status: result.featureJob.status, summary: compact(result.featureJob.summary, 80) };
    encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > limits.outcomeBytes) { result.text = '[Reply details omitted to preserve the durable action receipts.]'; encoded = JSON.stringify(result); }
    // Tool names and IDs are bounded by the API/router; 24 minimal receipts fit the minimum 8 KiB budget.
    if (Buffer.byteLength(encoded) > limits.outcomeBytes) throw fail('response_limit', 'The conversation outcome exceeds its retained receipt limit.', 413);
    return { value: result, encoded };
  }
  function normalizedActions(value = []) { if (!Array.isArray(value) || value.length > 24 || value.some(action => !action || typeof action !== 'object' || typeof action.id !== 'string' || action.id.length > 160 || typeof action.tool !== 'string' || action.tool.length > 80 || !['pending','completed','failed'].includes(action.status))) throw fail('invalid_input', 'Use at most 24 actual action receipts.'); return dataCopy(value); }
  function detail(row) {
    const turns = db.prepare('SELECT * FROM conversation_turns WHERE conversation_id=? ORDER BY sequence').all(row.id).map(saved => {
      const outcome = saved.outcome_json ? JSON.parse(saved.outcome_json) : {};
      return { id: saved.request_id, message: saved.message, providerId: saved.provider_id, status: saved.status, startedAt: saved.started_at, ...(saved.finished_at ? { finishedAt: saved.finished_at } : {}), actions: outcome.actions || [], featureJob: outcome.featureJob || null,
        ...(outcome.outcomeTruncated ? { outcomeTruncated: true } : {}), ...(saved.status === 'completed' ? { reply: outcome } : !['running'].includes(saved.status) ? { error: outcome } : {}) };
    });
    return { id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, activeRequestId: row.active_request_id, turns };
  }
  function getConversation(conversationId) { checkOpen(); return detail(conversationRow(conversationId)); }
  function listConversations() {
    checkOpen(); const rows = db.prepare('SELECT conversations.*,(SELECT count(*) FROM conversation_turns WHERE conversation_id=conversations.id) AS turn_count FROM conversations ORDER BY updated_at DESC,rowid DESC').all();
    return { conversations: rows.map(row => ({ id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, activeRequestId: row.active_request_id, turnCount: row.turn_count, lastStatus: row.last_status })), activeConversationId: db.prepare('SELECT active_conversation_id AS id FROM conversation_preferences WHERE id=1').get()?.id || null };
  }
  function activate(conversationId) { db.prepare('INSERT INTO conversation_preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET active_conversation_id=excluded.active_conversation_id').run(conversationId); }
  function createConversation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id','title'].includes(key))) throw fail('invalid_input', 'Provide a conversation ID and optional title.');
    const conversationId = id(value.id, 'conversation ID'), title = value.title === undefined ? null : text(value.title, 80, 'Conversation title');
    return transaction(() => {
      let row = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
      if (!row) { if (db.prepare('SELECT count(*) AS count FROM conversations').get().count >= limits.conversations) throw fail('conversation_limit', 'The retained conversation limit has been reached.', 409); const at = iso(now()); db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,NULL,NULL)').run(conversationId, title || 'New conversation', title ? 0 : 1, 0, at, at); row = conversationRow(conversationId); }
      activate(conversationId); return detail(row);
    });
  }
  function existingTurn(conversationId, requestId, digest) {
    const row = db.prepare('SELECT * FROM conversation_turns WHERE request_id=?').get(requestId);
    if (row && (row.conversation_id !== conversationId || row.digest !== digest)) throw fail('request_conflict', 'That request ID was already used for different input or another conversation.', 409);
    return row;
  }
  function receiptFor(requestId, digest) { const saved = chatReceipt(requestId, digest); if (!saved) throw fail('missing_request', 'The conversation effect receipt was not found.', 409); return saved; }
  function beginConversationTurn(value) {
    const conversationId = id(value?.conversationId, 'conversation ID'), requestId = requestIdentity(value.id), digest = requestDigest(value.digest), message = text(value.message, 12000, 'Message'), providerId = text(value.providerId ?? '', 100, 'Provider ID', true);
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw fail('invalid_revision', 'Use the current conversation revision.');
    return transaction(() => {
      const conversation = conversationRow(conversationId), previous = existingTurn(conversationId, requestId, digest);
      if (previous) { if (previous.message !== message || previous.provider_id !== providerId) throw fail('request_conflict', 'That request ID was used for different input.', 409); return { conversation: detail(conversation), replayed: true, receipt: receiptFor(requestId, digest) }; }
      if (chatReceipt(requestId, digest)) throw fail('request_conflict', 'That request ID belongs to an existing request outside this conversation.', 409);
      if (conversation.revision !== value.expectedRevision) throw Object.assign(fail('conversation_revision_conflict', 'The conversation changed. Keep your draft and load its latest state.', 409), { conversation: detail(conversation) });
      if (conversation.active_request_id) throw Object.assign(fail('conversation_busy', 'This conversation already has a running request.', 409), { conversation: detail(conversation) });
      if (db.prepare('SELECT count(*) AS count FROM conversation_turns WHERE conversation_id=?').get(conversationId).count >= limits.turns) throw fail('conversation_turn_limit', 'This conversation reached its retained turn limit. Start another conversation.', 409);
      if (db.prepare('SELECT count(*) AS count FROM chat_receipts').get().count >= 50000) throw fail('workspace_limit', 'The workspace reached its request receipt limit.');
      const at = iso(now()), baseBytes = Buffer.byteLength(JSON.stringify({ id: requestId, conversationId, message, providerId, startedAt: at })) + 128, reserve = 2 * limits.outcomeBytes;
      if (db.prepare('SELECT coalesce(sum(stored_bytes+reserved_bytes),0) AS bytes FROM conversation_turns').get().bytes + baseBytes + reserve > limits.totalBytes) throw fail('conversation_storage_limit', 'The durable conversation storage budget is full.', 409);
      db.prepare('INSERT INTO chat_receipts VALUES(?,?,?,NULL)').run(requestId, digest, 'in_progress');
      db.prepare('INSERT INTO conversation_turns(conversation_id,request_id,digest,message,provider_id,status,started_at,outcome_json,base_bytes,stored_bytes,reserved_bytes) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)').run(conversationId, requestId, digest, message, providerId, 'running', at, baseBytes, baseBytes, reserve);
      const title = conversation.auto_title ? message.replace(/\s+/g, ' ').slice(0, 80) : conversation.title;
      db.prepare('UPDATE conversations SET title=?,auto_title=0,revision=revision+1,updated_at=?,active_request_id=?,last_status=? WHERE id=?').run(title, at, requestId, 'running', conversationId); if(value.activate!==false)activate(conversationId);
      return { conversation: getConversation(conversationId), replayed: false, receipt: { state: 'in_progress', reply: null } };
    });
  }
  function recordConversationActions(value) {
    const conversationId = id(value?.conversationId, 'conversation ID'), requestId = requestIdentity(value.id), digest = requestDigest(value.digest), actions = normalizedActions(value.actions);
    return transaction(() => {
      const conversation = conversationRow(conversationId), saved = existingTurn(conversationId, requestId, digest); if (!saved) throw fail('missing_request', 'That conversation turn was not found.', 404);
      if (saved.status !== 'running' || conversation.active_request_id !== requestId) throw fail('conversation_turn_finished', 'This turn is no longer running.', 409);
      const previous = saved.outcome_json ? JSON.parse(saved.outcome_json) : {};
      if ((previous.actions || []).length > actions.length || (previous.actions || []).some((action, index) => action.id !== actions[index]?.id || action.tool !== actions[index]?.tool || action.status !== actions[index]?.status)) throw fail('conversation_checkpoint_conflict', 'A newer action checkpoint is already retained. Earlier receipts cannot be removed.', 409);
      const context=windowContextReference(actions.find(action=>action.tool==='window_context')?.result?.windowContext??value.windowContext??previous.windowContext);
      const project=projectReference(value.projectContext??previous.projectContext);
      const continuation=continuationReference(value.continuation??previous.continuation);
      const outcome = boundedOutcome({ actions, featureJob: value.featureJob ?? previous.featureJob ?? null,...(context?{windowContext:context}:{}),...(project?{projectContext:project}:{}),...(continuation?{continuation}:{}) });
      db.prepare('UPDATE conversation_turns SET outcome_json=?,stored_bytes=?,reserved_bytes=? WHERE request_id=?').run(outcome.encoded, saved.base_bytes + Buffer.byteLength(outcome.encoded), 2 * limits.outcomeBytes - Buffer.byteLength(outcome.encoded), requestId);
      db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(iso(now()), conversationId);
      return { conversation: getConversation(conversationId), receipt: receiptFor(requestId, digest) };
    });
  }
  function finishConversationTurn(value) {
    const conversationId = id(value?.conversationId, 'conversation ID'), requestId = requestIdentity(value.id), digest = requestDigest(value.digest);
    if (!['completed','failed','cancelled','interrupted'].includes(value.status)) throw fail('invalid_input', 'Choose a terminal conversation turn status.');
    return transaction(() => {
      const conversation = conversationRow(conversationId), saved = existingTurn(conversationId, requestId, digest); if (!saved) throw fail('missing_request', 'That conversation turn was not found.', 404);
      const partial = saved.outcome_json ? JSON.parse(saved.outcome_json) : {}, source = value.status === 'completed' ? value.reply : value.error;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw fail('invalid_input', 'Provide the actual conversation reply or error.');
      const actions = normalizedActions(source.actions ?? partial.actions ?? []), featureJob = source.featureJob ?? partial.featureJob ?? null;
      const conversationRevision = saved.status === 'running' ? conversation.revision + 1 : partial.conversationRevision;
      if (value.status === 'completed') text(source.text ?? '', 1024 * 1024, 'Reply', true);
      const wire = value.status === 'completed' ? { id: requestId, conversationId, conversationRevision, text: source.text ?? '', actions, featureJob, providerId: text(source.providerId ?? saved.provider_id, 100, 'Provider ID', true) }
        : { statusCode: Number.isInteger(source.statusCode) && source.statusCode >= 400 && source.statusCode <= 599 ? source.statusCode : value.status === 'cancelled' ? 499 : 500, code: text(source.code || 'request_failed', 100, 'Error code'), message: text(source.message || 'The request could not finish. Inspect any completed actions.', 2000, 'Error message'), actions, featureJob, conversationId, conversationRevision };
      const context=windowContextReference(source.windowContext??partial.windowContext);if(context)wire.windowContext=context;
      const project=projectReference(source.projectContext??partial.projectContext);if(project)wire.projectContext=project;
      const continuation=continuationReference(source.continuation??partial.continuation);if(continuation)wire.continuation=continuation;
      const outcome = boundedOutcome(wire);
      if (saved.status !== 'running') {
        if (saved.status !== value.status || hash(JSON.parse(saved.outcome_json || '{}')) !== hash(outcome.value)) throw fail('request_conflict', 'That turn already has a different terminal outcome.', 409);
        return { conversation: detail(conversation), replayed: true, receipt: receiptFor(requestId, digest) };
      }
      if (conversation.active_request_id !== requestId) throw fail('conversation_turn_finished', 'This is no longer the active conversation turn.', 409);
      receiptFor(requestId, digest);
      const at = iso(now()); db.prepare('UPDATE conversation_turns SET status=?,finished_at=?,outcome_json=?,stored_bytes=?,reserved_bytes=0 WHERE request_id=?').run(value.status, at, outcome.encoded, saved.base_bytes + 2 * Buffer.byteLength(outcome.encoded), requestId);
      db.prepare('UPDATE chat_receipts SET state=?,reply=? WHERE id=? AND hash=?').run(value.status === 'completed' ? 'completed' : 'failed', outcome.encoded, requestId, digest);
      db.prepare('UPDATE conversations SET revision=revision+1,updated_at=?,active_request_id=NULL,last_status=? WHERE id=?').run(at, value.status, conversationId);
      return { conversation: getConversation(conversationId), replayed: false, receipt: { state: value.status === 'completed' ? 'completed' : 'failed', reply: outcome.value } };
    });
  }
  // A fresh worker never resumes an old model/action turn. Preserve its last
  // durable tool checkpoint and close the paired receipt in one transaction.
  transaction(() => {
    db.exec("UPDATE execution_receipts SET state='interrupted' WHERE state='in_progress';");
    for (const saved of db.prepare("SELECT * FROM conversation_turns WHERE status='running'").all()) {
      const partial = saved.outcome_json ? JSON.parse(saved.outcome_json) : {}, context=windowContextReference(partial.windowContext), project=projectReference(partial.projectContext), outcome = boundedOutcome({ statusCode: 409, code: 'request_interrupted', message: 'Companion restarted during this request. Any recorded actions remain; inspect the workspace and build history before starting another request.', actions: partial.actions || [], featureJob: partial.featureJob || null, ...(context?{windowContext:context}:{}),...(project?{projectContext:project}:{}),...(continuationReference(partial.continuation)?{continuation:continuationReference(partial.continuation)}:{}), conversationId: saved.conversation_id, conversationRevision: conversationRow(saved.conversation_id).revision + 1 });
      const receipt = chatReceipt(saved.request_id, saved.digest); const at = iso(now());
      if (!receipt) db.prepare('INSERT INTO chat_receipts VALUES(?,?,?,?)').run(saved.request_id, saved.digest, 'failed', outcome.encoded);
      else db.prepare('UPDATE chat_receipts SET state=?,reply=? WHERE id=? AND hash=?').run('failed', outcome.encoded, saved.request_id, saved.digest);
      db.prepare('UPDATE conversation_turns SET status=?,finished_at=?,outcome_json=?,stored_bytes=?,reserved_bytes=0 WHERE request_id=?').run('interrupted', at, outcome.encoded, saved.base_bytes + 2 * Buffer.byteLength(outcome.encoded), saved.request_id);
      db.prepare('UPDATE conversations SET revision=revision+1,updated_at=?,active_request_id=NULL,last_status=? WHERE id=?').run(at, 'interrupted', saved.conversation_id);
    }
  });
  const work=installWorkStore({db,now,conversationLimit:limits.conversations,checkOpen});
  return { snapshot, apply, configureWorkflowTools, executionReceipt, beginExecution, checkpointExecution, finishExecution, chatReceipt, beginChat, finishChat, listConversations, createConversation, getConversation, beginConversationTurn, recordConversationActions, finishConversationTurn, ...work, close() { if (!closed) { closed = true; db.close(); } } };
}
