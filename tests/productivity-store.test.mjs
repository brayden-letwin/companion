import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProductivityStore } from '../server/productivity-store.mjs';
import { createProductivityTools } from '../server/productivity-tools.mjs';
import { capabilityHash } from '../server/capability-registry.mjs';

async function fixture(t, options = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'companion-productivity-store-')), stores = [];
  const open = async () => { const store = await createProductivityStore({ dataDirectory, ...options }); stores.push(store); return store; };
  const store = await open();
  t.after(async () => { for (const item of stores) item.close(); const resolved = path.resolve(dataDirectory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(resolved, { recursive: true, force: true }); });
  const apply = (type, fields = {}, target = store) => target.apply({ operationId: randomUUID(), expectedRevision: target.snapshot().revision, type, ...fields });
  return { store, open, apply, dataDirectory };
}
const executionId=(prefix,request,call)=>{const h=createHash('sha256').update(`${request}:${call}`).digest('hex').slice(0,32);return`${prefix}:${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
const fakeCapability=(version=1)=>({id:'fixture',title:'Fixture',module:'./fixture.mjs',modulePath:path.join(tmpdir(),'fixture.mjs'),moduleHash:'a'.repeat(64),version,hash:String(version).repeat(64),effectPolicy:'workspace',workflowAllowed:true,tool:{name:'cap_fixture',description:'Synthetic capability.',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:100}},required:['text'],additionalProperties:false}}});

test('workflow terminal receipts pin the original definition across edits, disabling, intervening changes and restart',async t=>{
  const f=await fixture(t);let tools=createProductivityTools({store:f.store});const flow=f.apply('saveWorkflow',{name:'Original sequence',steps:[{tool:'create_task',arguments:{title:'Original task'}},{tool:'save_note',arguments:{text:'Original note'}}]}).workspace.workflows[0],context={requestId:'stable-workflow'};
  const first=await tools.runWorkflow(flow.id,context);assert.equal(first.steps.length,2);
  f.apply('saveWorkflow',{workflowId:flow.id,name:'Edited sequence',enabled:false,steps:[...flow.steps,{tool:'save_note',arguments:{text:'Must never run on original retry'}}]});
  const replay=await tools.runWorkflow(flow.id,context);assert.deepEqual(replay.steps,first.steps);assert.equal(f.store.snapshot().notes.length,1);
  f.store.close();const restarted=await f.open();tools=createProductivityTools({store:restarted});assert.deepEqual((await tools.runWorkflow(flow.id,context)).steps,first.steps);assert.equal(restarted.snapshot().tasks.length,1);
  const other=f.apply('saveWorkflow',{name:'Other sequence',steps:[{tool:'get_time',arguments:{}}]},restarted).workspace.workflows.at(-1);await assert.rejects(tools.runWorkflow(other.id,context),{code:'request_conflict'});
});

test('checking a live workflow returns running with its checkpoint and never starts a duplicate run',async t=>{
  const f=await fixture(t);let release,entered,runs=0;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const tools=createProductivityTools({store:f.store,capabilities:[fakeCapability()],executeCapability:async()=>{runs++;entered();await held;return{value:{finished:true},hostActions:[]};}});
  const flow=f.apply('saveWorkflow',{name:'Held live sequence',steps:[{tool:'create_task',arguments:{title:'Only one first effect'}},{tool:'cap_fixture',arguments:{text:'Wait'}}]}).workspace.workflows[0],context={requestId:'live-workflow'};
  const running=tools.runWorkflow(flow.id,context);
  try{
    await started;const check=await tools.runWorkflow(flow.id,{requestId:context.requestId});assert.equal(check.status,'running');assert.equal(check.code,'workflow_running');assert.equal(check.error,undefined);assert.equal(check.steps.length,1);assert.equal(check.steps[0].result.task.id,f.store.snapshot().tasks[0].id);assert.equal(runs,1);assert.equal(f.store.snapshot().tasks.length,1);
    release();const finished=await running;assert.equal(finished.status,'completed');const replay=await tools.runWorkflow(flow.id,{requestId:context.requestId});assert.equal(replay.status,'completed');assert.deepEqual(replay.steps,finished.steps);assert.equal(runs,1);
  }finally{release();await running;}
});

test('central workflow schema validation preflights every step and custom version pins cannot silently change',async t=>{
  const f=await fixture(t),capability=fakeCapability();let runs=0;createProductivityTools({store:f.store,capabilities:[capability],executeCapability:async()=>{runs++;return{value:{},hostActions:[]};}});
  const before=f.store.snapshot();assert.throws(()=>f.apply('saveWorkflow',{name:'Invalid later step',steps:[{tool:'create_task',arguments:{title:'Must not be saved'}},{tool:'start_focus',arguments:{minutes:'twenty'}}]}),{code:'invalid_tool'});assert.deepEqual(f.store.snapshot(),before);
  const flow=f.apply('saveWorkflow',{name:'Pinned capability',steps:[{tool:'create_task',arguments:{title:'Must not run after stale pin'}},{tool:'cap_fixture',arguments:{text:'Original'}}]}).workspace.workflows[0];assert.deepEqual(flow.steps[1].capability,{id:'fixture',version:1,hash:capability.hash});
  const tools=createProductivityTools({store:f.store,capabilities:[fakeCapability(2)],executeCapability:async()=>{runs++;return{value:{},hostActions:[]};}});
  await assert.rejects(tools.runWorkflow(flow.id,{requestId:'stale-workflow'}),{code:'capability_changed'});assert.equal(f.store.snapshot().tasks.length,0);assert.equal(runs,0);
  assert.throws(()=>f.apply('saveWorkflow',{workflowId:flow.id,name:'Keep stale pin',steps:flow.steps}),{code:'capability_changed'});
  const changed=f.apply('saveWorkflow',{workflowId:flow.id,name:'Explicit updated selection',steps:[{tool:'cap_fixture',arguments:{text:'Updated'}}]}).workspace.workflows[0];assert.equal(changed.steps[0].capability.version,2);
  const missing=createProductivityTools({store:f.store});await assert.rejects(missing.runWorkflow(flow.id,{requestId:'missing-capability'}),{code:'capability_unavailable'});
});

test('interrupted workflow and capability executions retain real partial effects and never resume after restart',async t=>{
  const f=await fixture(t),tools=createProductivityTools({store:f.store}),flow=f.apply('saveWorkflow',{name:'Interrupted sequence',steps:[{tool:'create_task',arguments:{title:'Actually completed'}},{tool:'save_note',arguments:{text:'Must not resume'}}]}).workspace.workflows[0];
  const id=executionId('workflow','interrupted-workflow','workflow'),digest=capabilityHash({workflowId:flow.id});f.store.beginExecution({id,digest,definition:flow});
  const task=await tools.execute('create_task',{title:'Actually completed'},{requestId:id,callId:'step:0'});f.store.checkpointExecution({id,digest,checkpoint:{steps:[{tool:'create_task',result:task}]}});
  const capabilityId=executionId('capability','interrupted-capability','one'),capabilityDigest=capabilityHash({name:'cap_fixture',arguments:{text:'Original'}});f.store.beginExecution({id:capabilityId,digest:capabilityDigest,definition:{id:'fixture',version:1,hash:'a'.repeat(64)}});f.store.checkpointExecution({id:capabilityId,digest:capabilityDigest,checkpoint:{hostActions:[{id:'host:1',tool:'create_task',status:'completed',result:task}]}});
  f.store.close();const restarted=await f.open(),after=createProductivityTools({store:restarted});const replay=await after.runWorkflow(flow.id,{requestId:'interrupted-workflow'});assert.equal(replay.status,'interrupted');assert.equal(replay.steps[0].result.task.id,task.task.id);assert.equal(restarted.snapshot().tasks.length,1);assert.equal(restarted.snapshot().notes.length,0);
  await assert.rejects(after.execute('cap_fixture',{text:'Original'},{requestId:'interrupted-capability',callId:'one'}),error=>error.code==='capability_interrupted'&&error.hostActions[0].result.task.id===task.task.id);
});

test('capability cancellation inside a workflow retains parent-confirmed effects and terminal retries execute nothing',async t=>{
  const f=await fixture(t),controller=new AbortController();let runs=0;const tools=createProductivityTools({store:f.store,capabilities:[fakeCapability()],executeCapability:async({runTool})=>{runs++;await runTool('create_task',{title:'Real effect before stop'});controller.abort();throw Object.assign(new Error('Stopped after a real effect'),{name:'AbortError'});}});
  const flow=f.apply('saveWorkflow',{name:'Stop after actual effect',steps:[{tool:'save_note',arguments:{text:'First actual note'}},{tool:'cap_fixture',arguments:{text:'Continue'}},{tool:'save_note',arguments:{text:'Never run'}}]}).workspace.workflows[0],context={requestId:'cancelled-workflow',signal:controller.signal};
  const result=await tools.runWorkflow(flow.id,context);assert.equal(result.status,'cancelled');assert.equal(result.steps.length,1);assert.equal(result.failedStep.hostActions[0].result.task.id,f.store.snapshot().tasks[0].id);
  const retry=await tools.runWorkflow(flow.id,{requestId:context.requestId});assert.equal(retry.status,'cancelled');assert.deepEqual(retry.failedStep,result.failedStep);assert.equal(runs,1);assert.equal(f.store.snapshot().notes.length,1);assert.equal(f.store.snapshot().tasks.length,1);
});

test('large execution and conversation compaction retain all nested capability effect IDs and uncertainty flags',async t=>{
  const f=await fixture(t,{conversationLimits:{outcomeBytes:16000}}),hostActions=Array.from({length:12},(_,index)=>({id:'host:'+(index+1),tool:'save_note',status:'completed',result:{note:{id:randomUUID(),title:'Note '+index,text:'x'.repeat(12000)}}}));
  hostActions[11]={id:'host:12',tool:'create_task',status:'pending',result:{outcomeUnknown:true,task:{id:randomUUID()}}};
  const conversationId=randomUUID(),digest=createHash('sha256').update('nested-capabilities').digest('hex');f.store.createConversation({id:conversationId});f.store.beginConversationTurn({conversationId,expectedRevision:0,id:'nested',message:'Retain actual effects',providerId:'fixture',digest});
  const action={id:'capability-call',tool:'run_capability',status:'failed',result:{capability:{id:'fixture',name:'cap_fixture',version:1,hash:'b'.repeat(64)},hostActions,error:'Later failure'}};f.store.recordConversationActions({conversationId,id:'nested',digest,actions:[action]});
  const retained=f.store.getConversation(conversationId).turns[0].actions[0].result;assert.equal(retained.hostActions.length,12);assert.deepEqual(retained.hostActions.map(item=>item.result.note?.id||item.result.task?.id),hostActions.map(item=>item.result.note?.id||item.result.task?.id));assert.equal(retained.hostActions[11].result.outcomeUnknown,true);assert.equal(retained.capability.hash,'b'.repeat(64));
  const execution='workflow:synthetic-large',executionDigest='c'.repeat(64);f.store.beginExecution({id:execution,digest:executionDigest,definition:{id:randomUUID()}});const steps=Array.from({length:12},()=>({tool:'cap_fixture',result:{capability:retained.capability,hostActions}}));
  const finished=f.store.finishExecution({id:execution,digest:executionDigest,result:{status:'failed',steps}});assert.equal(finished.result.detailsTruncated,true);for(const step of finished.result.steps){assert.equal(step.result.hostActions.length,12);assert.equal(step.result.hostActions[11].result.task.id,hostActions[11].result.task.id);assert.equal(step.result.hostActions[11].result.outcomeUnknown,true);}
});

test('one shared budget bounds nested workflow capability effects and terminal replay cannot resume exhausted work',async t=>{
  const f=await fixture(t);let runs=0;const tools=createProductivityTools({store:f.store,capabilities:[fakeCapability()],executeCapability:async({runTool})=>{runs++;await runTool('create_task',{title:'Only permitted nested effect'});try{await runTool('save_note',{text:'No remaining budget'});}catch{}return{value:{attempted:true},hostActions:[]};}});
  const flow=f.apply('saveWorkflow',{name:'Bounded nested work',steps:[{tool:'cap_fixture',arguments:{text:'one'}},{tool:'create_task',arguments:{title:'Must never run'}}]}).workspace.workflows[0],budget={remaining:2};
  const result=await tools.runWorkflow(flow.id,{requestId:'bounded-workflow',executionBudget:budget});assert.equal(result.status,'failed');assert.equal(result.code,'execution_budget_exceeded');assert.equal(budget.remaining,0);assert.equal(result.failedStep.hostActions[0].status,'completed');assert.equal(result.failedStep.hostActions[1].status,'failed');assert.equal(f.store.snapshot().tasks.length,1);assert.equal(f.store.snapshot().notes.length,0);
  const replay=await tools.runWorkflow(flow.id,{requestId:'bounded-workflow',executionBudget:{remaining:48}});assert.equal(replay.code,result.code);assert.deepEqual(replay.failedStep,result.failedStep);assert.equal(runs,1);assert.equal(f.store.snapshot().tasks.length,1);
  const gatewayFlow=f.apply('saveWorkflow',{name:'Gateway shares its budget',steps:[{tool:'create_task',arguments:{title:'One gateway effect'}},{tool:'save_note',arguments:{text:'Must not reset budget'}}]}).workspace.workflows.at(-1),gatewayBudget={remaining:2};
  const gateway=await tools.execute('run_workflow',{workflowId:gatewayFlow.id},{requestId:'gateway-budget',callId:'one',executionBudget:gatewayBudget});assert.equal(gateway.code,'execution_budget_exceeded');assert.equal(gatewayBudget.remaining,0);assert.equal(gateway.steps.length,1);assert.equal(f.store.snapshot().tasks.length,2);assert.equal(f.store.snapshot().notes.length,0);
});

test('task tools page more than one hundred actual records and compute complete filtered counts without mutating the workspace',async t=>{
  const instant=Date.UTC(2026,9,24),f=await fixture(t,{now:()=>instant}),projects=['','__proto__','constructor','toString','Unassigned','research','Research'];
  const details='A'.repeat(3999)+'😀'+('Complete task details.\n'.repeat(200))+'LAST_DETAIL';let selectedTask;
  for(let index=0;index<125;index++){
    const created=f.apply('addTask',{title:'Synthetic task '+index,details:index===0?details:'Preview detail. '.repeat(40),project:projects[index%projects.length],priority:index%4===0?'high':'normal',dueAt:new Date(instant+(index%3===0?-1:1)*86400000).toISOString()}).workspace.tasks.at(-1);
    if(index===0)selectedTask=created;
    if(index%5===0)f.apply('completeTask',{taskId:created.id});
  }
  const tools=createProductivityTools({store:f.store,now:()=>instant}),before=f.store.snapshot(),seen=[];let offset=0,pages=0;
  for(;;){const page=await tools.execute('list_tasks',{offset,limit:100,expectedRevision:before.revision});pages++;assert.equal(page.total,125);assert.equal(page.returned,page.tasks.length);assert.ok(page.returned<=100);assert.ok(Buffer.byteLength(JSON.stringify(page))<=48*1024);for(const task of page.tasks){assert.ok(task.details.length<=400);assert.equal(task.detailsTruncated,true);assert.ok(task.detailsLength>task.details.length);seen.push(task.id);}if(!page.hasMore){assert.equal(page.nextOffset,null);break;}assert.ok(page.nextOffset>offset);offset=page.nextOffset;}
  assert.ok(pages>1);assert.equal(seen.length,125);assert.equal(new Set(seen).size,125);
  const summary=await tools.execute('summarize_tasks',{});assert.equal(summary.totalTasks,125);assert.equal(summary.openTasks,100);assert.equal(summary.completedTasks,25);assert.equal(summary.highPriorityOpenTasks,25);assert.equal(summary.overdueOpenTasks,33);assert.equal(summary.projectCount,7);
  let projectOffset=0;const projectNames=[];for(;;){const page=await tools.execute('summarize_tasks',{offset:projectOffset,limit:2,expectedRevision:before.revision});assert.equal(page.totalTasks,125);assert.equal(page.projectCount,7);assert.ok(page.returned<=2);projectNames.push(...page.projects.map(group=>group.project));if(!page.hasMore)break;assert.ok(page.nextOffset>projectOffset);projectOffset=page.nextOffset;}assert.equal(new Set(projectNames).size,7);
  for(const name of ['__proto__','constructor','toString','Unassigned'])assert.equal(summary.projects.find(group=>group.project===name).totalTasks,18,name);
  assert.equal((await tools.execute('list_tasks',{unassigned:true})).total,18);assert.equal((await tools.execute('summarize_tasks',{unassigned:false})).totalTasks,107);assert.equal((await tools.execute('list_tasks',{project:'RESEARCH'})).total,35);
  const urgent=await tools.execute('summarize_tasks',{status:'todo',priority:'high',dueBefore:new Date(instant).toISOString()});assert.equal(urgent.totalTasks,8);assert.equal(urgent.openTasks,8);assert.equal(urgent.highPriorityOpenTasks,8);assert.equal(urgent.overdueOpenTasks,8);
  const listed=await tools.execute('list_tasks',{status:'todo',priority:'high',dueBefore:new Date(instant).toISOString()});assert.equal(listed.total,8);assert.equal(listed.tasks.length,8);
  let detailOffset=0,recovered='';for(;;){const page=await tools.execute('read_task',{taskId:selectedTask.id,offset:detailOffset,limit:4000,expectedRevision:before.revision});assert.equal(page.detailsLength,details.length);recovered+=page.task.details;if(!page.hasMore)break;assert.ok(page.nextOffset>detailOffset);detailOffset=page.nextOffset;}
  assert.equal(recovered,details);assert.deepEqual(f.store.snapshot(),before);
  const workflow=f.apply('saveWorkflow',{name:'Review actual task counts',steps:[{tool:'list_tasks',arguments:{limit:1}},{tool:'read_task',arguments:{taskId:selectedTask.id,offset:4001,limit:100}},{tool:'summarize_tasks',arguments:{status:'todo'}}]}).workspace.workflows[0];
  const run=await tools.runWorkflow(workflow.id,{requestId:'task-read-workflow'});assert.equal(run.status,'completed');assert.equal(run.steps[0].result.total,125);assert.equal(run.steps[2].result.totalTasks,100);assert.equal(f.store.snapshot().tasks.length,125);
  for(const name of ['read_task','summarize_tasks']){const meta=tools.catalog().find(item=>item.name===name);assert.equal(meta.workflowAllowed,true);assert.equal(meta.effectPolicy,'pure');}
  for(const [name,args]of [['list_tasks',{}],['read_task',{taskId:selectedTask.id}],['summarize_tasks',{}]])await assert.rejects(tools.execute(name,{...args,expectedRevision:before.revision}),error=>error.code==='revision_conflict'&&error.revision===f.store.snapshot().revision);
  await assert.rejects(tools.execute('list_tasks',{project:'research',unassigned:false}),{code:'invalid_tool'});await assert.rejects(tools.execute('summarize_tasks',{dueBefore:'not-a-date'}),{code:'invalid_tool'});
});

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

const turnInput = (conversationId, revision = 0, requestId = 'turn_' + randomUUID()) => ({ conversationId, expectedRevision: revision, id: requestId, message: 'A synthetic conversation request.', providerId: '', digest: createHash('sha256').update(requestId).digest('hex') });
const completed = (turn, reply = { text: 'A synthetic reply.', actions: [], providerId: 'synthetic-provider' }) => ({ conversationId: turn.conversationId, id: turn.id, digest: turn.digest, status: 'completed', reply });

test('durable conversations preserve existing workspace data, derive first-message titles and restore ordered replies', async t => {
  const f = await fixture(t); f.apply('addNote', { text: 'An existing workspace note.' });
  const conversationId = randomUUID(); assert.equal(f.store.listConversations().conversations.length, 0); assert.equal(f.store.createConversation({ id: conversationId }).title, 'New conversation');
  const turn = { ...turnInput(conversationId), message: 'Plan a synthetic week with concrete next steps.' };
  const started = f.store.beginConversationTurn(turn); assert.equal(started.conversation.revision, 1); assert.equal(started.conversation.title, turn.message); assert.equal(started.conversation.activeRequestId, turn.id); assert.deepEqual(started.receipt, { state: 'in_progress', reply: null });
  const reply = { text: '\n  Preserve this reply’s spacing.\n', actions: [], providerId: 'resolved-provider', rawContinuation: { mustNotPersist: 'opaque-secret-marker' } };
  const finished = f.store.finishConversationTurn(completed(turn, reply)); assert.equal(finished.conversation.revision, 2); assert.equal(finished.receipt.reply.conversationRevision, 2); assert.equal(finished.receipt.reply.text, reply.text); assert.equal(finished.conversation.activeRequestId, null);
  assert.ok(!JSON.stringify(finished).includes('opaque-secret-marker')); assert.equal(f.store.createConversation({ id: conversationId, title: 'Must not overwrite existing title' }).title, turn.message);
  f.store.close(); const restarted = await f.open(), restored = restarted.getConversation(conversationId); assert.equal(restored.turns[0].status, 'completed'); assert.equal(restored.turns[0].reply.text, reply.text); assert.equal(restored.turns[0].reply.providerId, 'resolved-provider'); assert.equal(restarted.snapshot().notes[0].text, 'An existing workspace note.');
  const listed = restarted.listConversations(); assert.equal(listed.activeConversationId, conversationId); assert.equal(listed.conversations[0].turnCount, 1); assert.equal(listed.conversations[0].lastStatus, 'completed');
});

test('conversation CAS and one-running-turn rule are atomic across connections and do not poison failed request IDs', async t => {
  const f = await fixture(t), other = await f.open(), conversationId = randomUUID(); f.store.createConversation({ id: conversationId }); const first = turnInput(conversationId), competing = turnInput(conversationId);
  f.store.beginConversationTurn(first);
  assert.throws(() => other.beginConversationTurn(competing), error => error.code === 'conversation_revision_conflict' && error.conversation.revision === 1); assert.equal(other.chatReceipt(competing.id, competing.digest), null);
  assert.throws(() => other.beginConversationTurn({ ...competing, expectedRevision: 1 }), { code: 'conversation_busy' }); assert.equal(other.chatReceipt(competing.id, competing.digest), null);
  assert.equal(other.beginConversationTurn(first).replayed, true); assert.throws(() => other.beginConversationTurn({ ...first, message: 'Same digest with changed input' }), { code: 'request_conflict' });
  const parallelId = randomUUID(); other.createConversation({ id: parallelId }); assert.equal(other.beginConversationTurn(turnInput(parallelId)).conversation.activeRequestId.startsWith('turn_'), true);
});

test('conversation turn and paired effect receipts roll back together when either SQL write fails', async t => {
  const f = await fixture(t), conversationId = randomUUID(); f.store.createConversation({ id: conversationId }); const turn = turnInput(conversationId);
  function executeSql(sql) { const connection = new DatabaseSync(path.join(f.dataDirectory, 'productivity.sqlite')); try { connection.exec(sql); } finally { connection.close(); } }
  executeSql("CREATE TRIGGER synthetic_conversation_insert BEFORE INSERT ON conversation_turns BEGIN SELECT RAISE(ABORT, 'Synthetic turn insert failure'); END;");
  assert.throws(() => f.store.beginConversationTurn(turn), /Synthetic turn insert failure/); assert.equal(f.store.chatReceipt(turn.id, turn.digest), null); assert.equal(f.store.getConversation(conversationId).revision, 0); assert.equal(f.store.getConversation(conversationId).turns.length, 0);
  executeSql('DROP TRIGGER synthetic_conversation_insert;'); f.store.beginConversationTurn(turn);
  executeSql("CREATE TRIGGER synthetic_conversation_finish BEFORE UPDATE ON chat_receipts WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'Synthetic receipt finish failure'); END;");
  assert.throws(() => f.store.finishConversationTurn(completed(turn)), /Synthetic receipt finish failure/); assert.equal(f.store.getConversation(conversationId).turns[0].status, 'running'); assert.equal(f.store.getConversation(conversationId).revision, 1); assert.equal(f.store.chatReceipt(turn.id, turn.digest).state, 'in_progress');
  executeSql('DROP TRIGGER synthetic_conversation_finish;'); assert.equal(f.store.finishConversationTurn(completed(turn)).receipt.state, 'completed');
});

test('exact turn and terminal replays preserve the original committed revision after later turns', async t => {
  const f = await fixture(t), conversationId = randomUUID(); f.store.createConversation({ id: conversationId }); const first = turnInput(conversationId); f.store.beginConversationTurn(first); const initial = f.store.finishConversationTurn(completed(first));
  const second = turnInput(conversationId, 2); f.store.beginConversationTurn(second); f.store.finishConversationTurn(completed(second));
  const replay = f.store.beginConversationTurn(first); assert.equal(replay.replayed, true); assert.equal(replay.conversation.revision, 4); assert.deepEqual(replay.receipt, initial.receipt); assert.equal(f.store.finishConversationTurn(completed(first)).receipt.reply.conversationRevision, 2);
  assert.throws(() => f.store.finishConversationTurn(completed(first, { text: 'Changed final answer.' })), { code: 'request_conflict' });
  const another = randomUUID(); f.store.createConversation({ id: another }); assert.throws(() => f.store.beginConversationTurn({ ...first, conversationId: another }), { code: 'request_conflict' });
});

test('restart marks running turns interrupted and retains their actual task/build checkpoints without resuming', async t => {
  const f = await fixture(t), conversationId = randomUUID(); f.store.createConversation({ id: conversationId }); const turn = turnInput(conversationId); f.store.beginConversationTurn(turn);
  const task = f.apply('addTask', { title: 'Finished before the simulated restart' }).workspace.tasks[0], featureJob = { id: randomUUID(), status: 'queued' };
  const actions = [{ id: 'created_task', tool: 'create_task', status: 'completed', arguments: { title: task.title }, result: { task } }];
  const checkpoint = f.store.recordConversationActions({ ...turn, actions, featureJob }); assert.equal(checkpoint.conversation.revision, 1); assert.equal(checkpoint.conversation.turns[0].actions[0].result.task.id, task.id);
  assert.throws(() => f.store.recordConversationActions({ ...turn, actions: [] }), { code: 'conversation_checkpoint_conflict' });
  f.store.close(); const restarted = await f.open(), restored = restarted.getConversation(conversationId); assert.equal(restored.revision, 2); assert.equal(restored.activeRequestId, null); assert.equal(restored.turns[0].status, 'interrupted'); assert.equal(restored.turns[0].error.code, 'request_interrupted'); assert.equal(restored.turns[0].error.actions[0].result.task.id, task.id); assert.equal(restored.turns[0].featureJob.id, featureJob.id); assert.equal(restarted.snapshot().tasks.length, 1);
  const replay = restarted.beginConversationTurn(turn); assert.equal(replay.replayed, true); assert.equal(replay.receipt.state, 'failed'); assert.equal(replay.receipt.reply.statusCode, 409); assert.equal(replay.receipt.reply.conversationRevision, 2); assert.throws(() => restarted.finishConversationTurn(completed(turn)), { code: 'request_conflict' });
});

test('large checkpoints compact details while retaining every action, workflow-step ID and desktop uncertainty', async t => {
  const f = await fixture(t, { conversationLimits: { outcomeBytes: 8192 } }), conversationId = randomUUID(); f.store.createConversation({ id: conversationId }); const turn = turnInput(conversationId); f.store.beginConversationTurn(turn);
  const stepIds = Array.from({ length: 12 }, () => randomUUID());
  const actions = [
    { id: 'workflow', tool: 'run_workflow', status: 'completed', result: { steps: stepIds.map((id, index) => ({ tool: 'create_task', result: { task: { id, title: 'Step ' + index, details: 'x'.repeat(4000) } } })) } },
    { id: 'uncertain', tool: 'desktop_propose_action', status: 'failed', result: { desktopAction: { id: randomUUID(), status: 'failed', outcomeUnknown: true } } },
    { id: 'pending', tool: 'desktop_propose_action', status: 'pending', result: { desktopAction: { id: randomUUID(), status: 'pending', preview: { action: 'setText', text: 'Literal preview '.repeat(200) }, requiresApproval: true } } },
  ];
  const checkpoint = f.store.recordConversationActions({ ...turn, actions }); assert.equal(checkpoint.conversation.turns[0].actions.length, 3);
  const final = f.store.finishConversationTurn(completed(turn, { text: 'Long answer '.repeat(18000), actions, rawContinuation: { marker: 'must-not-persist' } })); const saved = final.receipt.reply;
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 8192); assert.equal(saved.outcomeTruncated, true); assert.equal(saved.actions.length, 3); assert.equal(saved.actions[0].result.steps.length, 12); assert.equal(saved.actions[0].result.steps[11].result.task.id, stepIds[11]); assert.equal(saved.actions[1].result.desktopAction.outcomeUnknown, true); assert.ok(!JSON.stringify(saved).includes('must-not-persist'));
  const pending = saved.actions[2].result.desktopAction; if (pending.preview) assert.equal(pending.preview.text, actions[2].result.desktopAction.preview.text); else assert.equal(pending.requiresFreshPreview, true);
});

test('conversation/turn limits reject before effects, and terminal-capacity reservations release safely', async t => {
  const f = await fixture(t, { conversationLimits: { conversations: 2, turns: 2 } }), conversationId = randomUUID(); f.store.createConversation({ id: conversationId }); f.store.createConversation({ id: randomUUID() }); assert.throws(() => f.store.createConversation({ id: randomUUID() }), { code: 'conversation_limit' });
  for (let index = 0; index < 2; index++) { const turn = turnInput(conversationId, index * 2); f.store.beginConversationTurn(turn); f.store.finishConversationTurn(completed(turn)); }
  const limited = turnInput(conversationId, 4); assert.throws(() => f.store.beginConversationTurn(limited), { code: 'conversation_turn_limit' }); assert.equal(f.store.chatReceipt(limited.id, limited.digest), null);
  const budget = await fixture(t, { conversationLimits: { outcomeBytes: 32768, totalBytes: 131072 } }); const firstId = randomUUID(), secondId = randomUUID(); budget.store.createConversation({ id: firstId }); budget.store.createConversation({ id: secondId }); const first = turnInput(firstId), second = turnInput(secondId); budget.store.beginConversationTurn(first); assert.throws(() => budget.store.beginConversationTurn(second), { code: 'conversation_storage_limit' }); assert.equal(budget.store.chatReceipt(second.id, second.digest), null); budget.store.finishConversationTurn(completed(first)); assert.equal(budget.store.beginConversationTurn(second).replayed, false);
});

test('cancelled turns keep partial receipts, and conversation creation never adopts an unrelated legacy request', async t => {
  const f = await fixture(t), conversationId = randomUUID(); f.store.createConversation({ id: conversationId, title: 'A chosen title' }); const turn = turnInput(conversationId); f.store.beginConversationTurn(turn);
  const actions = [{ id: 'saved_note', tool: 'save_note', status: 'completed', result: { note: { id: randomUUID(), title: 'A completed draft' } } }]; f.store.recordConversationActions({ ...turn, actions });
  const finished = f.store.finishConversationTurn({ ...turn, status: 'cancelled', error: { statusCode: 499, code: 'request_cancelled', message: 'Stopped by the user.' } }); assert.equal(finished.conversation.turns[0].status, 'cancelled'); assert.equal(finished.receipt.reply.actions[0].id, 'saved_note'); assert.equal(finished.receipt.state, 'failed'); assert.equal(finished.conversation.title, 'A chosen title');
  const legacy = turnInput(conversationId, 2); f.store.beginChat(legacy.id, legacy.digest); assert.throws(() => f.store.beginConversationTurn(legacy), { code: 'request_conflict' }); assert.equal(f.store.getConversation(conversationId).turns.length, 1); assert.equal(f.store.chatReceipt(legacy.id, legacy.digest).state, 'in_progress');
});

test('legacy workspace snapshots expose empty memory without rewriting their revision or losing notes', async t => {
  const f = await fixture(t); f.apply('addNote', { text: 'A pre-memory workspace note.' }); const legacy = f.store.snapshot(); delete legacy.preferences;
  const connection = new DatabaseSync(path.join(f.dataDirectory, 'productivity.sqlite'));
  try { connection.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify(legacy)); } finally { connection.close(); }
  const restored = f.store.snapshot(); assert.deepEqual(restored.preferences, []); assert.equal(restored.revision, legacy.revision); assert.equal(restored.notes[0].text, 'A pre-memory workspace note.');
  const inspect = new DatabaseSync(path.join(f.dataDirectory, 'productivity.sqlite'));
  try { assert.equal(Object.hasOwn(JSON.parse(inspect.prepare('SELECT state FROM workspace WHERE id=1').get().state), 'preferences'), false); } finally { inspect.close(); }
  const changed = f.apply('rememberPreference', { key: 'reply-length', label: 'Reply length', value: 'Keep routine replies concise.' }); assert.equal(changed.workspace.preferences.length, 1); assert.equal(changed.workspace.revision, legacy.revision + 1);
  f.store.close(); const restarted = await f.open(); assert.equal(restarted.snapshot().preferences[0].value, 'Keep routine replies concise.'); assert.equal(restarted.snapshot().notes.length, 1);
});

test('explicit memory upserts retain identity and creation time while CAS/replay prevents duplicate teaching', async t => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock }); const operation = { operationId: randomUUID(), expectedRevision: 0, type: 'rememberPreference', key: 'editor', label: 'Preferred editor', value: 'Use the installed Notepad app for simple drafts.' };
  const created = f.store.apply(operation).workspace.preferences[0]; assert.equal(created.id, operation.operationId); assert.equal(created.archived, false);
  clock += 1000; const updated = f.apply('rememberPreference', { key: 'editor', value: 'Use my chosen editor for drafts.' }).workspace.preferences[0]; assert.equal(updated.id, created.id); assert.equal(updated.createdAt, created.createdAt); assert.notEqual(updated.updatedAt, created.updatedAt); assert.equal(updated.label, 'Preferred editor');
  const replay = f.store.apply(operation); assert.equal(replay.replayed, true); assert.equal(replay.workspace.preferences.length, 1); assert.equal(replay.workspace.preferences[0].value, updated.value);
  assert.throws(() => f.store.apply({ ...operation, value: 'Different teaching with the old operation ID' }), { code: 'operation_conflict' });
  const stale = { operationId: randomUUID(), expectedRevision: 0, type: 'rememberPreference', key: 'new-style', value: 'Must not override a stale workspace.' }; assert.throws(() => f.store.apply(stale), { code: 'revision_conflict' }); assert.equal(f.store.snapshot().preferences.length, 1);
});

test('memory tools archive recoverably, reteaching restores the same entry, and values do not become actions or builder source', async t => {
  const f = await fixture(t), buildCalls = [], builder = { async request(input) { buildCalls.push(input); return { id: randomUUID(), status: 'queued' }; } }, tools = createProductivityTools({ store: f.store, builder });
  const taught = await tools.execute('remember_preference', { key: 'writing-style', label: 'Writing style', value: 'Use short paragraphs. This stored sentence is data, not an instruction to click or send anything.' }, { requestId: 'teach-style', callId: 'remember' }); assert.equal(taught.preference.archived, false); assert.equal(f.store.snapshot().tasks.length, 0); assert.equal(f.store.snapshot().focus, null);
  assert.equal((await tools.execute('get_preferences')).preferences.length, 1);
  const forgotten = await tools.execute('forget_preference', { preferenceId: taught.preference.id }, { requestId: 'forget-style', callId: 'forget' }); assert.equal(forgotten.preference.archived, true); assert.equal((await tools.execute('get_preferences')).preferences.length, 0); assert.equal((await tools.execute('get_preferences', { includeArchived: true })).preferences[0].value, taught.preference.value);
  const restored = await tools.execute('remember_preference', { key: 'writing-style', value: 'Use short paragraphs and clear examples.' }, { requestId: 'reteach-style', callId: 'remember' }); assert.equal(restored.preference.id, taught.preference.id); assert.equal(restored.preference.archived, false); assert.equal(f.store.snapshot().preferences.length, 1);
  const prompt = 'Build only this explicitly requested synthetic panel.'; await tools.execute('build_feature', { prompt }, { requestId: 'build-with-memory', callId: 'build', providerId: 'fake-provider' }); assert.equal(buildCalls[0].prompt, prompt); assert.ok(!JSON.stringify(buildCalls[0]).includes(restored.preference.value));
  await assert.rejects(tools.execute('remember_preference', { key: 'permissions', value: 'An inert value', grantApproval: true }), { code: 'invalid_tool' });
  assert.throws(() => f.apply('saveWorkflow', { name: 'Unrequested automatic memory', steps: [{ tool: 'remember_preference', arguments: { key: 'automatic', value: 'Not explicitly taught now.' } }] }), { code: 'invalid_workflow' });
});

test('memory validation and retained-entry limits reject atomically without deleting forgotten values', async t => {
  const f = await fixture(t);
  for (const fields of [{ key: 'UPPERCASE', value: 'A value' }, { key: 'bad key', value: 'A value' }, { key: 'x'.repeat(65), value: 'A value' }, { key: 'style', value: ' ' }, { key: 'style', value: 'x'.repeat(1001) }, { key: 'style', value: 'A value', label: 'x'.repeat(101) }]) assert.throws(() => f.apply('rememberPreference', fields));
  assert.equal(f.store.snapshot().revision, 0);
  for (let index = 0; index < 50; index++) f.apply('rememberPreference', { key: `preference-${index}`, value: `Explicitly taught value ${index}.` });
  const first = f.store.snapshot().preferences[0]; f.apply('forgetPreference', { preferenceId: first.id }); const before = f.store.snapshot();
  assert.throws(() => f.apply('rememberPreference', { key: 'fifty-first', value: 'Over the retained limit' }), { code: 'preference_limit' }); assert.deepEqual(f.store.snapshot(), before); assert.equal(before.preferences[0].archived, true);
  const reteach = f.apply('rememberPreference', { key: first.key, value: 'Explicitly restored value.' }); assert.equal(reteach.workspace.preferences.length, 50); assert.equal(reteach.workspace.preferences[0].id, first.id); assert.equal(reteach.workspace.preferences[0].archived, false);
});
