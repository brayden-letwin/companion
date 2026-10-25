import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createProductivityStore} from '../server/productivity-store.mjs';
import {createProductivityTools} from '../server/productivity-tools.mjs';
import {workflowRunId,workflowRunDigest} from '../server/workflow-runs.mjs';
import {capabilityHash} from '../server/capability-registry.mjs';

async function fixture(t,options={}){
  const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-run-history-')),stores=[];
  const open=async()=>{const value=await createProductivityStore({dataDirectory,...options});stores.push(value);return value;};
  const store=await open();t.after(async()=>{for(const value of stores)value.close();await rm(dataDirectory,{recursive:true,force:true});});
  const db=()=>new DatabaseSync(path.toNamespacedPath(path.join(dataDirectory,'productivity.sqlite')));
  return{store,open,db,dataDirectory};
}
function definition(fields={}){return{id:randomUUID(),name:'Original routine',description:'Synthetic fixture.',enabled:true,createdAt:'2000-01-01T00:00:00.000Z',updatedAt:'2000-01-01T00:00:00.000Z',steps:[{tool:'get_time',arguments:{}}],...fields};}
function begin(store,original,{requestId=randomUUID(),callId='workflow',operationId,legacy=false}={}){
  if(operationId)requestId='local-workspace:'+operationId;
  const runId=workflowRunId(requestId,callId),value={id:'workflow:'+runId,digest:workflowRunDigest(original.id),definition:original,...(!legacy?{workflowRun:{workflowId:original.id,...(operationId?{operationId}:{})}}:{})};
  store.beginExecution(value);return{runId,id:value.id,digest:value.digest,workflowId:original.id};
}
function finish(store,run,result={}){store.finishExecution({...run,result:{id:run.workflowId,status:'completed',steps:[{tool:'get_time',result:{now:'2026-10-25T12:00:00.000Z'}}],...result},failed:['failed','cancelled'].includes(result.status)});}
function insert(db,original,result,{state='completed',runId=randomUUID(),digest=workflowRunDigest(original.id),checkpoint=null}={}){db.prepare('INSERT INTO execution_receipts VALUES(?,?,?,?,?,?)').run('workflow:'+runId,digest,state,JSON.stringify(original),checkpoint?JSON.stringify(checkpoint):null,result?JSON.stringify(result):null);return runId;}

test('actual routine run history retains original definition and effects after edit, disable, deletion and restart',async t=>{
  const f=await fixture(t),created=f.store.apply({operationId:randomUUID(),expectedRevision:0,type:'saveWorkflow',name:'Remember synthetic note',steps:[{tool:'save_note',arguments:{title:'Fixture note',text:'Only one saved effect.'}}]}),workflowId=created.workflow.id,tools=createProductivityTools({store:f.store}),operationId=randomUUID();
  const result=await tools.runWorkflow(workflowId,{requestId:'local-workspace:'+operationId,callId:'workflow',workflowOperationId:operationId});assert.equal(result.status,'completed');assert.equal(f.store.snapshot().notes.length,1);
  const original=f.store.getWorkflowRun({workflowId,operationId});assert.equal(original.run.id,result.runId);assert.equal(original.run.completedStepCount,1);assert.equal(original.run.timestampsAvailable,true);assert.equal(JSON.parse(original.definitionText).name,'Remember synthetic note');assert.equal(JSON.parse(original.outcomeText).steps[0].result.note.id,f.store.snapshot().notes[0].id);
  f.store.apply({operationId:randomUUID(),expectedRevision:f.store.snapshot().revision,type:'saveWorkflow',workflowId,name:'Edited today',enabled:false});
  const db=f.db();try{const state=f.store.snapshot();state.workflows=[];db.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify(state));}finally{db.close();}
  const before=f.store.snapshot();assert.deepEqual(f.store.getWorkflowRun({workflowId,runId:result.runId}),original);assert.deepEqual(f.store.listWorkflowRuns().runs.map(run=>run.id),[result.runId]);assert.deepEqual(f.store.snapshot(),before);
  f.store.close();const reopened=await f.open();assert.deepEqual(reopened.getWorkflowRun({workflowId,operationId}),original);assert.deepEqual(reopened.snapshot(),before);assert.equal(reopened.snapshot().notes.length,1);
});

test('pending operation lookup binds exact original request mapping, namespace, digest and workflow ID',async t=>{
  const f=await fixture(t),original=definition(),operationId=randomUUID(),run=begin(f.store,original,{operationId});finish(f.store,run);
  assert.equal(f.store.getWorkflowRun({workflowId:original.id,operationId}).run.id,run.runId);
  assert.throws(()=>f.store.getWorkflowRun({workflowId:randomUUID(),operationId}),{code:'workflow_run_binding',statusCode:409});
  assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,operationId:randomUUID()}),{code:'workflow_run_not_found',statusCode:404});
  const other=begin(f.store,original,{requestId:operationId,callId:'custom-call'});finish(f.store,other);assert.equal(f.store.getWorkflowRun({workflowId:original.id,runId:other.runId}).run.id,other.runId);
  const db=f.db();try{db.prepare('INSERT INTO execution_receipts VALUES(?,?,?,?,NULL,NULL)').run('capability:'+operationId,'a'.repeat(64),'completed','{}');}finally{db.close();}
  assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:operationId}),{code:'workflow_run_not_found'});
  assert.throws(()=>f.store.beginExecution({id:'workflow:'+randomUUID(),digest:workflowRunDigest(original.id),definition:original,workflowRun:{workflowId:original.id,operationId:randomUUID()}}),{code:'invalid_workflow_run'});
});

test('running checkpoints, terminal cancellation and nested failed host effects remain truthful',async t=>{
  const f=await fixture(t),original=definition({steps:[{tool:'get_time',arguments:{}},{tool:'cap_fixture',arguments:{},capability:{id:'fixture',version:3,hash:'d'.repeat(64)}}]}),run=begin(f.store,original),steps=[{tool:'get_time',result:{now:'2026-10-25T12:00:00.000Z'}}];
  f.store.checkpointExecution({...run,checkpoint:{steps,activeStep:{index:1,tool:'cap_fixture'}}});const running=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId});assert.equal(running.run.status,'running');assert.equal(running.run.completedStepCount,1);assert.deepEqual(JSON.parse(running.outcomeText).activeStep,{index:1,tool:'cap_fixture',hostActions:[],nestedReceiptState:'not_recorded',nestedDetailsTruncated:false,nestedCheckpointAvailable:false,outcomeUnknown:true});
  const hostActions=[{id:'host:1',tool:'save_note',arguments:{title:'Synthetic'},status:'completed',result:{note:{id:randomUUID()}}},{id:'host:2',tool:'update_task',arguments:{taskId:randomUUID()},status:'pending',result:{outcomeUnknown:true}}];
  finish(f.store,run,{status:'cancelled',steps,error:'Stopped after one step.',failedStep:{index:1,tool:'cap_fixture',hostActions}});
  const terminal=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId});assert.equal(terminal.run.status,'cancelled');assert.equal(terminal.run.completedStepCount,1);assert.deepEqual(JSON.parse(terminal.outcomeText).failedStep.hostActions,hostActions);assert.equal(terminal.run.finishedAt!==null,true);
});

test('restart marks live evidence interrupted without replay and legacy run times remain unavailable',async t=>{
  let clock=Date.parse('2026-10-25T12:00:00Z');const f=await fixture(t,{now:()=>clock}),original=definition(),run=begin(f.store,original);
  f.store.checkpointExecution({...run,checkpoint:{steps:[],activeStep:{index:0,tool:'get_time'}}});const live=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId});assert.equal(live.run.startedAt,'2026-10-25T12:00:00.000Z');assert.notEqual(live.run.startedAt,original.createdAt);
  const legacy=begin(f.store,definition(),{legacy:true});f.store.close();clock+=5000;const reopened=await f.open(),interrupted=reopened.getWorkflowRun({workflowId:original.id,runId:run.runId});assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.run.finishedAt,'2026-10-25T12:00:05.000Z');assert.equal(JSON.parse(interrupted.outcomeText).outcomeUnknown,true);assert.equal(JSON.parse(interrupted.outcomeText).activeStep.index,0);
  const old=reopened.getWorkflowRun({workflowId:legacy.workflowId,runId:legacy.runId});assert.equal(old.run.timestampsAvailable,false);assert.equal(old.run.startedAt,null);assert.equal(old.run.updatedAt,null);assert.equal(old.run.finishedAt,null);
  const db=f.db();try{assert.equal(db.prepare('SELECT count(*) AS n FROM workflow_run_metadata').get().n,1);assert.equal(db.prepare('PRAGMA table_info(execution_receipts)').all().length,6);}finally{db.close();}
});

test('exact JSON pages reconstruct large original pins and all nested receipts with Unicode-safe boundaries',async t=>{
  const f=await fixture(t),original=definition({name:'界😀'.repeat(60),steps:[{tool:'cap_fixture',arguments:{body:'\\\n😀'.repeat(9000)},capability:{id:'fixture',version:7,hash:'e'.repeat(64)}}]}),run=begin(f.store,original),hostActions=Array.from({length:12},(_,index)=>({id:'host:'+(index+1),tool:'save_note',status:index===11?'pending':'completed',result:{note:{id:randomUUID()},body:'😀\\\n'.repeat(1700),...(index===11?{outcomeUnknown:true}:{})}}));
  finish(f.store,run,{steps:[],status:'failed',failedStep:{tool:'cap_fixture',hostActions},error:'Synthetic fixture failure.'});let page=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId}),revision=page.run.runRevision,definitionText='',outcomeText='';
  for(let count=0;;count++){
    assert.ok(count<200);assert.ok(Buffer.byteLength(JSON.stringify(page))<=48*1024);definitionText+=page.definitionText;outcomeText+=page.outcomeText;
    if(!page.definitionHasMore&&!page.outcomeHasMore)break;
    page=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId,definitionOffset:page.nextDefinitionOffset??page.definitionLength,outcomeOffset:page.nextOutcomeOffset??page.outcomeLength,expectedRunRevision:revision});
  }
  assert.deepEqual(JSON.parse(definitionText),original);assert.deepEqual(JSON.parse(outcomeText).failedStep.hostActions,hostActions);assert.equal(JSON.parse(definitionText).steps[0].capability.hash,'e'.repeat(64));
});

test('a changing checkpoint invalidates continuation pages and malformed selectors cannot mix histories',async t=>{
  const f=await fixture(t),original=definition({steps:[{tool:'save_note',arguments:{body:'😀'.repeat(5000)}}]}),run=begin(f.store,original),first=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId});
  assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:run.runId,definitionOffset:first.nextDefinitionOffset}),{code:'workflow_run_revision_required'});
  f.store.checkpointExecution({...run,checkpoint:{steps:[],activeStep:{index:0,tool:'save_note'}}});assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:run.runId,definitionOffset:first.nextDefinitionOffset,expectedRunRevision:first.run.runRevision}),{code:'workflow_run_changed',statusCode:409});
  const current=f.store.getWorkflowRun({workflowId:original.id,runId:run.runId}),text=JSON.stringify(original),emoji=text.indexOf('😀');assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:run.runId,definitionOffset:emoji+1,expectedRunRevision:current.run.runRevision}),{code:'invalid_workflow_run_offset'});
  for(const options of [{runId:run.runId,operationId:randomUUID()},{},{runId:run.runId,definitionLimit:4001},{runId:run.runId,outcomeOffset:999999,expectedRunRevision:current.run.runRevision},{runId:run.runId,unknown:true}])assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,...options}),error=>error.statusCode===400);
});

test('filtered history scans at most100 candidate rows, returns empty continuation and reaches every older match',async t=>{
  const f=await fixture(t),wanted=definition({name:'Wanted'}),unmatched=definition({name:'Other'}),db=f.db(),expected=[];
  try{db.exec('BEGIN');for(let index=0;index<230;index++){const original=index<5?wanted:unmatched,runId=insert(db,original,{id:original.id,status:'completed',steps:[]});if(index<5)expected.unshift(runId);}db.exec('COMMIT');}finally{db.close();}
  const first=f.store.listWorkflowRuns({workflowId:wanted.id,limit:2});assert.equal(first.runs.length,0);assert.equal(first.scanned,100);assert.equal(first.hasMore,true);assert.equal(first.scanHasMore,true);assert.ok(first.nextCursor);
  let before=first.nextCursor,all=[];for(let count=0;before;count++){assert.ok(count<10);const page=f.store.listWorkflowRuns({workflowId:wanted.id,before,limit:2});assert.ok(page.scanned<=100);assert.ok(Buffer.byteLength(JSON.stringify(page))<=48*1024);all.push(...page.runs.map(run=>run.id));before=page.nextCursor;}
  assert.deepEqual(all,expected);assert.equal(new Set(all).size,expected.length);assert.throws(()=>f.store.listWorkflowRuns({before:'0'}),{code:'invalid_workflow_run_query'});assert.throws(()=>f.store.listWorkflowRuns({limit:21}),{code:'invalid_workflow_run_query'});
});

test('original receipt and timestamp metadata commit atomically and old writer changes cannot keep stale times',async t=>{
  const f=await fixture(t),original=definition(),operationId=randomUUID(),runId=workflowRunId('local-workspace:'+operationId),run={id:'workflow:'+runId,digest:workflowRunDigest(original.id),definition:original,workflowRun:{workflowId:original.id,operationId}},db=f.db();
  try{
    db.exec("CREATE TRIGGER fixture_metadata_failure BEFORE INSERT ON workflow_run_metadata BEGIN SELECT RAISE(ABORT,'Synthetic index failure'); END;");assert.throws(()=>f.store.beginExecution(run),/Synthetic index failure/);assert.equal(db.prepare('SELECT id FROM execution_receipts WHERE id=?').get(run.id),undefined);db.exec('DROP TRIGGER fixture_metadata_failure;');f.store.beginExecution(run);
    db.exec("CREATE TRIGGER fixture_metadata_update_failure BEFORE UPDATE ON workflow_run_metadata BEGIN SELECT RAISE(ABORT,'Synthetic update failure'); END;");assert.throws(()=>f.store.checkpointExecution({...run,checkpoint:{steps:[],activeStep:{index:0,tool:'get_time'}}}),/Synthetic update failure/);assert.equal(db.prepare('SELECT checkpoint_json FROM execution_receipts WHERE id=?').get(run.id).checkpoint_json,null);db.exec('DROP TRIGGER fixture_metadata_update_failure;');
    finish(f.store,{...run,workflowId:original.id});assert.equal(f.store.getWorkflowRun({workflowId:original.id,runId}).run.timestampsAvailable,true);
    db.prepare('UPDATE execution_receipts SET result_json=? WHERE id=?').run(JSON.stringify({id:original.id,status:'completed',steps:[],message:'Later compatible writer.'}),run.id);const changed=f.store.getWorkflowRun({workflowId:original.id,runId});assert.equal(changed.run.timestampsAvailable,false);assert.equal(changed.run.finishedAt,null);assert.equal(JSON.parse(changed.outcomeText).message,'Later compatible writer.');
  }finally{db.close();}
});

test('malformed original binding fails closed without exposing current definition or private SQL diagnostics',async t=>{
  const f=await fixture(t),original=definition(),db=f.db();let runId;
  try{runId=insert(db,original,{id:randomUUID(),status:'completed',steps:[]});}finally{db.close();}
  assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId}),error=>error.code==='workflow_run_unavailable'&&error.statusCode===503&&!error.message.includes('sqlite'));
  const bad=f.db();try{bad.prepare('UPDATE execution_receipts SET definition_json=? WHERE id=?').run('{broken private fixture','workflow:'+runId);}finally{bad.close();}
  assert.throws(()=>f.store.listWorkflowRuns(),error=>error.code==='workflow_run_unavailable'&&!error.message.includes('broken private'));
});

test('a restarted active custom step exposes its exact durable child host actions without running or guessing another step',async t=>{
  const f=await fixture(t),pin={id:'fixture',version:4,hash:'f'.repeat(64)},step={tool:'cap_fixture',arguments:{text:'Synthetic original request'},capability:pin},original=definition({steps:[step]}),parent=begin(f.store,original),meta={...pin,name:step.tool};
  f.store.checkpointExecution({...parent,checkpoint:{steps:[],activeStep:{index:0,tool:step.tool}}});
  const child={id:'capability:'+workflowRunId(parent.id,'step:0'),digest:capabilityHash({name:step.tool,arguments:step.arguments}),definition:meta};f.store.beginExecution(child);
  const tools=createProductivityTools({store:f.store}),note=await tools.execute('save_note',{title:'Durable nested fixture',text:'Created before the interrupted custom step returned.'},{requestId:child.id,callId:'host:1'}),hostActions=[{id:'host:1',tool:'save_note',arguments:{title:'Durable nested fixture',text:'Created before the interrupted custom step returned.'},status:'completed',result:note}];
  f.store.checkpointExecution({...child,checkpoint:{hostActions}});const before=f.store.snapshot();f.store.close();const reopened=await f.open(),packet=reopened.getWorkflowRun({workflowId:original.id,runId:parent.runId}),outcome=JSON.parse(packet.outcomeText);assert.equal(packet.run.status,'interrupted');assert.equal(outcome.activeStep.nestedReceiptState,'interrupted');assert.deepEqual(outcome.activeStep.hostActions,hostActions);assert.equal(outcome.activeStep.hostActions[0].result.note.id,before.notes[0].id);assert.equal(outcome.activeStep.nestedCheckpointAvailable,true);assert.deepEqual(reopened.snapshot(),before);assert.equal(reopened.snapshot().notes.length,1);
  const db=f.db();try{db.prepare('UPDATE execution_receipts SET checkpoint_json=? WHERE id=?').run(JSON.stringify({steps:[]}),parent.id);}finally{db.close();}
  assert.equal(JSON.parse(reopened.getWorkflowRun({workflowId:original.id,runId:parent.runId}).outcomeText).activeStep,null,'Legacy absence cannot infer which step was dispatched.');assert.deepEqual(reopened.snapshot(),before);
});

test('child-only checkpoint changes invalidate detail pages and child pins or argument mismatches fail closed',async t=>{
  const f=await fixture(t),pin={id:'fixture',version:1,hash:'b'.repeat(64)},step={tool:'cap_fixture',arguments:{text:'😀'.repeat(5000)},capability:pin},original=definition({steps:[step]}),parent=begin(f.store,original),meta={...pin,name:step.tool};f.store.checkpointExecution({...parent,checkpoint:{steps:[],activeStep:{index:0,tool:step.tool}}});
  const missing=f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId}),child={id:'capability:'+workflowRunId(parent.id,'step:0'),digest:capabilityHash({name:step.tool,arguments:step.arguments}),definition:meta};f.store.beginExecution(child);
  const first=f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId});assert.notEqual(first.run.runRevision,missing.run.runRevision);f.store.checkpointExecution({...child,checkpoint:{hostActions:[{id:'host:1',tool:'save_note',status:'pending',result:{outcomeUnknown:true}}],detailsTruncated:true}});
  assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId,definitionOffset:first.nextDefinitionOffset,expectedRunRevision:first.run.runRevision}),{code:'workflow_run_changed',statusCode:409});const current=f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId});assert.equal(JSON.parse(current.outcomeText).activeStep.nestedDetailsTruncated,true);assert.equal(current.run.timestampsAvailable,true,'Parent timestamps retain only their original checkpoint meaning.');
  const db=f.db();try{
    db.prepare('UPDATE execution_receipts SET definition_json=? WHERE id=?').run(JSON.stringify({...meta,version:2}),child.id);assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId}),{code:'workflow_run_unavailable',statusCode:503});
    db.prepare('UPDATE execution_receipts SET definition_json=?,hash=? WHERE id=?').run(JSON.stringify(meta),'0'.repeat(64),child.id);assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId}),{code:'workflow_run_unavailable',statusCode:503});
  }finally{db.close();}
});

test('combined parent and child evidence near both stored bounds has a reachable tail beyond2MiB',async t=>{
  const f=await fixture(t),pin={id:'fixture',version:1,hash:'9'.repeat(64)},step={tool:'cap_fixture',arguments:{text:'Synthetic bounded fixture'},capability:pin},original=definition({steps:[{tool:'get_time',arguments:{}},step]}),parent=begin(f.store,original),child={id:'capability:'+workflowRunId(parent.id,'step:1'),digest:capabilityHash({name:step.tool,arguments:step.arguments}),definition:{...pin,name:step.tool}};f.store.beginExecution(child);
  const checkpoint={steps:[{tool:'get_time',result:{retainedFixtureText:''}}],activeStep:{index:1,tool:step.tool}},childCheckpoint={hostActions:[{id:'host:1',tool:'read_note',status:'completed',result:{retainedFixtureText:''}}]};
  checkpoint.steps[0].result.retainedFixtureText='p'.repeat(1024*1024-Buffer.byteLength(JSON.stringify(checkpoint)));childCheckpoint.hostActions[0].result.retainedFixtureText='c'.repeat(1024*1024-Buffer.byteLength(JSON.stringify(childCheckpoint)));
  const db=f.db();try{db.prepare('UPDATE execution_receipts SET checkpoint_json=? WHERE id=?').run(JSON.stringify(checkpoint),parent.id);db.prepare('UPDATE execution_receipts SET checkpoint_json=? WHERE id=?').run(JSON.stringify(childCheckpoint),child.id);}finally{db.close();}
  const first=f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId});assert.ok(first.outcomeLength>2*1024*1024);assert.ok(first.outcomeLength<3*1024*1024);const tail=f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId,outcomeOffset:first.outcomeLength-100,expectedRunRevision:first.run.runRevision});assert.equal(tail.outcomeText.length,100);assert.equal(tail.outcomeHasMore,false);assert.equal(tail.nextOutcomeOffset,null);assert.ok(Buffer.byteLength(JSON.stringify(tail))<=48*1024);assert.match(tail.outcomeText,/"checkpointAvailable":true\}$/);
  assert.throws(()=>f.store.getWorkflowRun({workflowId:original.id,runId:parent.runId,outcomeOffset:3*1024*1024+1,expectedRunRevision:first.run.runRevision}),{code:'invalid_workflow_run_query'});
});
