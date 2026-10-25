import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProductivityStore } from '../server/productivity-store.mjs';
import { createProductivityTools } from '../server/productivity-tools.mjs';

async function fixture(t) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'companion-productivity-store-')), stores = [];
  const open = async () => { const store = await createProductivityStore({ dataDirectory }); stores.push(store); return store; };
  const store = await open();
  t.after(async () => { for (const item of stores) item.close(); const resolved = path.resolve(dataDirectory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(resolved, { recursive: true, force: true }); });
  const apply = (type, fields = {}, target = store) => target.apply({ operationId: randomUUID(), expectedRevision: target.snapshot().revision, type, ...fields });
  return { store, open, apply, dataDirectory };
}

test('workspace compare-and-swap, exact replay and cross-operation ID conflicts survive SQLite restart', async t => {
  const f = await fixture(t); const operation = { operationId: randomUUID(), expectedRevision: 0, type: 'addTask', title: 'Review a synthetic draft' };
  const first = f.store.apply(operation); assert.equal(first.workspace.tasks[0].id, operation.operationId); assert.equal(first.workspace.revision, 1);
  f.apply('addNote', { text: 'A second synthetic change.' });
  const replay = f.store.apply(operation); assert.equal(replay.replayed, true); assert.equal(replay.workspace.revision, 2); assert.equal(replay.workspace.tasks.length, 1);
  assert.throws(() => f.store.apply({ ...operation, type: 'addNote', text: 'Cannot reuse this receipt.' }), { code: 'operation_conflict', statusCode: 409 });
  const secondConnection = await f.open();
  const revision = f.store.snapshot().revision;
  f.store.apply({ operationId: randomUUID(), expectedRevision: revision, type: 'addTask', title: 'First writer wins' });
  assert.throws(() => secondConnection.apply({ operationId: randomUUID(), expectedRevision: revision, type: 'addTask', title: 'Stale second writer' }), error => error.code === 'revision_conflict' && error.workspace.revision === revision + 1);
  f.store.close(); secondConnection.close(); const restarted = await f.open();
  assert.equal(restarted.snapshot().tasks.length, 2); assert.equal(restarted.apply(operation).replayed, true);
});

test('an invalid multi-field update rolls back every field, activity entry and receipt', async t => {
  const f = await fixture(t); const created = f.apply('addTask', { title: 'Original title', details: 'Original detail' }); const taskId = created.workspace.tasks[0].id;
  const before = f.store.snapshot(), operationId = randomUUID();
  assert.throws(() => f.store.apply({ operationId, expectedRevision: before.revision, type: 'updateTask', taskId, title: 'Must roll back', details: 'Also rolls back', priority: 'invalid' }), { code: 'invalid_priority' });
  assert.deepEqual(f.store.snapshot(), before);
  const corrected = f.store.apply({ operationId, expectedRevision: before.revision, type: 'updateTask', taskId, title: 'Corrected update', priority: 'high' });
  assert.equal(corrected.workspace.tasks[0].title, 'Corrected update'); assert.equal(corrected.workspace.activity.length, before.activity.length + 1);
  assert.throws(() => f.apply('archiveNote', { noteId: randomUUID() }), { code: 'not_found' });
  assert.equal(f.store.snapshot().revision, before.revision + 1);
});

test('SQLite rolls back the state write when recording its receipt fails, then permits an exact retry', async t => {
  const f = await fixture(t), operation = { operationId: randomUUID(), expectedRevision: 0, type: 'addTask', title: 'Transactional receipt' };
  const install = new DatabaseSync(path.join(f.dataDirectory, 'productivity.sqlite'));
  try { install.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON workspace_receipts BEGIN SELECT RAISE(ABORT, 'Synthetic receipt failure'); END;"); } finally { install.close(); }
  const before = f.store.snapshot(); assert.throws(() => f.store.apply(operation), /Synthetic receipt failure/); assert.deepEqual(f.store.snapshot(), before);
  const remove = new DatabaseSync(path.join(f.dataDirectory, 'productivity.sqlite'));
  try { remove.exec('DROP TRIGGER synthetic_receipt_failure;'); } finally { remove.close(); }
  const retry = f.store.apply(operation); assert.equal(retry.replayed, false); assert.equal(retry.workspace.revision, 1); assert.equal(retry.workspace.tasks.length, 1);
});

test('real task, note, workflow and focus records retain their data and reject invalid changes', async t => {
  const f = await fixture(t); const task = f.apply('addTask', { title: 'Prepare discussion', project: 'Research', dueAt: '2026-10-25T10:00:00Z' }).workspace.tasks[0];
  assert.equal(f.apply('completeTask', { taskId: task.id }).workspace.tasks[0].status, 'done');
  const note = f.apply('addNote', { text: 'A synthetic note.\nSecond line.', tags: ['draft', 'draft'] }).workspace.notes[0]; assert.deepEqual(note.tags, ['draft']);
  assert.equal(f.apply('archiveNote', { noteId: note.id }).workspace.notes[0].archived, true);
  f.apply('saveWorkflow', { name: 'Morning setup', steps: [{ tool: 'list_tasks', arguments: {} }, { tool: 'start_focus', arguments: { minutes: 25 } }] });
  assert.throws(() => f.apply('saveWorkflow', { name: 'Forbidden command', steps: [{ tool: 'shell', arguments: { command: 'anything' } }] }), { code: 'invalid_workflow' });
  assert.ok(f.apply('startFocus', { minutes: 25, label: 'Writing' }).workspace.focus.endsAt); assert.equal(f.apply('stopFocus').workspace.focus, null);
  const before = f.store.snapshot(); assert.throws(() => f.apply('startFocus', { minutes: 241 }), { code: 'invalid_duration' }); assert.deepEqual(f.store.snapshot(), before);
});

test('tool receipts replay identical mutations without duplication, including after another change and restart', async t => {
  const f = await fixture(t); const tools = createProductivityTools({ store: f.store }); const context = { requestId: 'synthetic-retry', callId: 'create-one' };
  const first = await tools.execute('create_task', { title: 'Exactly one task' }, context);
  await tools.execute('save_note', { text: 'An intervening note.' }, { requestId: 'other', callId: 'note' });
  const replay = await tools.execute('create_task', { title: 'Exactly one task' }, context);
  assert.equal(replay.replayed, true); assert.equal(replay.task.id, first.task.id); assert.equal(f.store.snapshot().tasks.length, 1);
  f.store.close(); const restarted = await f.open(); const restartedTools = createProductivityTools({ store: restarted });
  assert.equal((await restartedTools.execute('create_task', { title: 'Exactly one task' }, context)).replayed, true);
  await assert.rejects(restartedTools.execute('create_task', { title: 'Changed payload' }, context), { code: 'operation_conflict' }); assert.equal(restarted.snapshot().tasks.length, 1);
});

test('workflow receipts report actual success, replay completed steps and preserve partial failure', async t => {
  const f = await fixture(t), tools = createProductivityTools({ store: f.store });
  const workflow = f.apply('saveWorkflow', { name: 'Prepare work', steps: [{ tool: 'create_task', arguments: { title: 'Workflow task' } }, { tool: 'save_note', arguments: { text: 'Workflow note.' } }, { tool: 'start_focus', arguments: { minutes: 10 } }] }).workspace.workflows[0];
  const completed = await tools.runWorkflow(workflow.id, { requestId: 'workflow-repeat' }); assert.equal(completed.status, 'completed'); assert.equal(completed.steps.length, 3); const revision = f.store.snapshot().revision;
  const repeated = await tools.runWorkflow(workflow.id, { requestId: 'workflow-repeat' }); assert.equal(repeated.status, 'completed'); assert.equal(f.store.snapshot().revision, revision); assert.equal(f.store.snapshot().tasks.length, 1); assert.equal(f.store.snapshot().notes.length, 1);
  const failedWorkflow = f.apply('saveWorkflow', { name: 'Partial work', steps: [{ tool: 'create_task', arguments: { title: 'Retained completed step' } }, { tool: 'complete_task', arguments: { taskId: randomUUID() } }, { tool: 'save_note', arguments: { text: 'Must not run.' } }] }).workspace.workflows.at(-1);
  const failed = await tools.runWorkflow(failedWorkflow.id, { requestId: 'partial-repeat' }); assert.equal(failed.status, 'failed'); assert.equal(failed.steps.length, 1); assert.match(failed.error, /not found/i); assert.equal(f.store.snapshot().notes.length, 1);
  const count = f.store.snapshot().tasks.length; const failedRetry = await tools.runWorkflow(failedWorkflow.id, { requestId: 'partial-repeat' }); assert.equal(failedRetry.status, 'failed'); assert.equal(failedRetry.steps.length, 1); assert.equal(f.store.snapshot().tasks.length, count);
});

test('tool argument whitelists, cancellation and bounded note reads operate on real records', async t => {
  const f = await fixture(t), tools = createProductivityTools({ store: f.store });
  const note = await tools.execute('save_note', { title: 'Long synthetic note', text: 'a'.repeat(1300) + 'TAIL', tags: ['test'] }, { requestId: 'note-create', callId: 'one' });
  const listed = await tools.execute('list_notes'); assert.equal(listed.notes[0].text.length, 1200); assert.equal(listed.notes[0].truncated, true);
  const section = await tools.execute('read_note', { noteId: note.note.id, offset: 1298, limit: 6 }); assert.equal(section.note.text, 'aaTAIL'); assert.equal(section.hasMore, false);
  const revision = f.store.snapshot().revision;
  await assert.rejects(tools.execute('shell', { command: 'unsupported' }), { code: 'invalid_tool' });
  await assert.rejects(tools.execute('create_task', { title: 'No extra claims', actor: 'administrator' }), { code: 'invalid_tool' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(tools.execute('create_task', { title: 'Cancelled' }, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(f.store.snapshot().revision, revision);
});
