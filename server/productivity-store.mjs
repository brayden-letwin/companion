import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const iso = value => new Date(value).toISOString();
function text(value, limit, label, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw fail('invalid_input', `${label} must contain ${empty ? '0' : '1'}–${limit} characters.`);
  return value.trim();
}
function id(value, label) { if (typeof value !== 'string' || !UUID.test(value)) throw fail('invalid_id', `Choose a valid ${label}.`); return value; }
function tags(value = []) { if (!Array.isArray(value) || value.length > 12) throw fail('invalid_tags', 'Use at most 12 tags.'); return [...new Set(value.map(t => text(t, 40, 'Tag')))]; }
function date(value) { if (value == null || value === '') return null; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('invalid_date', 'Choose a valid date.'); return iso(Date.parse(value)); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const initial = () => ({ revision: 0, tasks: [], notes: [], workflows: [], focus: null, activity: [] });
const STEP_TOOLS = new Set(['list_tasks','create_task','update_task','complete_task','list_notes','save_note','search_notes','start_focus','stop_focus','get_time']);
function steps(value) {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw fail('invalid_workflow', 'A workflow needs between 1 and 12 steps.');
  return value.map(step => {
    if (!step || !STEP_TOOLS.has(step.tool) || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments) || JSON.stringify(step.arguments).length > 24000) throw fail('invalid_workflow', 'Choose supported local workflow steps.');
    return { tool: step.tool, arguments: structuredClone(step.arguments) };
  });
}

/** One persistent workspace for the current OS user. Reading-room accounts are separate. */
export async function createProductivityStore({ dataDirectory, now = Date.now } = {}) {
  if (!dataDirectory) throw new Error('A private data directory is required.');
  await mkdir(dataDirectory, { recursive: true });
  const db = new DatabaseSync(path.join(dataDirectory, 'productivity.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_receipts(id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chat_receipts(id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, reply TEXT);');
  db.prepare('INSERT OR IGNORE INTO workspace VALUES(1,?)').run(JSON.stringify(initial()));
  const snapshot = () => JSON.parse(db.prepare('SELECT state FROM workspace WHERE id=1').get().state);
  let closed = false;
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
      const receipt = db.prepare('SELECT hash FROM workspace_receipts WHERE id=?').get(operation.operationId);
      if (receipt) {
        if (receipt.hash !== digest) throw fail('operation_conflict', 'That operation ID was already used for another change.', 409);
        db.exec('COMMIT'); return { workspace: state, replayed: true };
      }
      if (state.revision !== operation.expectedRevision) throw fail('revision_conflict', 'The workspace changed. Your draft is still available; review the latest state and try again.', 409);
      const at = iso(now()); let summary;
      const task = taskId => { const item = state.tasks.find(t => t.id === id(taskId, 'task')); if (!item) throw fail('not_found', 'That task was not found.', 404); return item; };
      const note = noteId => { const item = state.notes.find(n => n.id === id(noteId, 'note')); if (!item) throw fail('not_found', 'That note was not found.', 404); return item; };
      const optionalText = (value, limit, label) => text(value ?? '', limit, label, true);
      switch (operation.type) {
        case 'addTask': {
          if (state.tasks.length >= 2000) throw fail('workspace_limit', 'This workspace supports up to 2,000 tasks.');
          const priority = operation.priority ?? 'normal'; if (!['normal','high'].includes(priority)) throw fail('invalid_priority', 'Choose normal or high priority.');
          const item = { id: operation.operationId, title: text(operation.title, 300, 'Task title'), details: optionalText(operation.details, 12000, 'Task details'), status: 'todo', priority, project: optionalText(operation.project, 100, 'Project'), dueAt: date(operation.dueAt), createdAt: at, updatedAt: at };
          state.tasks.push(item); summary = `Added task: ${item.title}`; break;
        }
        case 'updateTask': case 'completeTask': {
          const item = task(operation.taskId);
          if (operation.title !== undefined) item.title = text(operation.title, 300, 'Task title');
          if (operation.details !== undefined) item.details = text(operation.details, 12000, 'Task details', true);
          if (operation.project !== undefined) item.project = text(operation.project, 100, 'Project', true);
          if (operation.priority !== undefined) { if (!['normal','high'].includes(operation.priority)) throw fail('invalid_priority', 'Choose normal or high priority.'); item.priority = operation.priority; }
          if (operation.dueAt !== undefined) item.dueAt = date(operation.dueAt);
          if (operation.status !== undefined) { if (!['todo','done'].includes(operation.status)) throw fail('invalid_status', 'Choose todo or done.'); item.status = operation.status; }
          if (operation.type === 'completeTask') item.status = 'done';
          item.updatedAt = at; summary = `${item.status === 'done' ? 'Completed' : 'Updated'} task: ${item.title}`; break;
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
          let item = operation.workflowId ? state.workflows.find(w => w.id === id(operation.workflowId, 'workflow')) : null;
          if (operation.workflowId && !item) throw fail('not_found', 'That workflow was not found.', 404);
          if (!item && state.workflows.length >= 100) throw fail('workspace_limit', 'Keep at most 100 workflows.');
          if (operation.enabled !== undefined && typeof operation.enabled !== 'boolean') throw fail('invalid_input', 'Enabled must be true or false.');
          const update = { name: text(operation.name, 200, 'Workflow name'), description: optionalText(operation.description, 2000, 'Workflow description'), steps: steps(operation.steps), enabled: operation.enabled ?? true, updatedAt: at };
          if (item) Object.assign(item, update); else { item = { id: operation.operationId, ...update, createdAt: at }; state.workflows.push(item); }
          summary = `Saved workflow: ${item.name}`; break;
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
      db.prepare('INSERT INTO workspace_receipts VALUES(?,?)').run(operation.operationId, digest);
      db.exec('COMMIT'); return { workspace: state, replayed: false };
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
  return { snapshot, apply, chatReceipt, beginChat, finishChat, close() { if (!closed) { closed = true; db.close(); } } };
}
