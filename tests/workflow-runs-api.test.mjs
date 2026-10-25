import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSharedServer} from '../server/shared-server.mjs';
import {createProductivityStore} from '../server/productivity-store.mjs';
import {createProductivityTools} from '../server/productivity-tools.mjs';
import {workflowRunId,workflowRunDigest} from '../server/workflow-runs.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const gateCapability={id:'history-gate',title:'History gate',module:'./history-gate.mjs',modulePath:path.join(tmpdir(),'history-gate.mjs'),moduleHash:'a'.repeat(64),version:1,hash:'b'.repeat(64),effectPolicy:'workspace',workflowAllowed:true,tool:{name:'cap_history_gate',description:'Synthetic controlled gate.',parameters:{type:'object',properties:{},additionalProperties:false}}};
async function fixture(t,{capabilities=[],executeCapability}={}){
 const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-workflow-history-http-')),calls=[],requests=[],cleanup=[];let clock=Date.parse('2026-10-25T18:00:00.000Z'),store,tools,app,origin;
 const router={getStatus:async()=>({defaultProviderId:'synthetic',providers:[{id:'synthetic',type:'compatible',model:'synthetic',label:'Synthetic',ready:true}]}),complete:async()=>{calls.push('model');throw Error('History inspection must never call a model.');}};
 const builder={list:async()=>[],close:async()=>{}},provider={getStatus:async()=>({reasoningReady:false,transcriptionReady:false}),ask:async()=>{throw Error('No legacy model calls.');},transcribe:async()=>{throw Error('No transcription.');},cancel(){},cancelScope(){}};
 async function start(){store=await createProductivityStore({dataDirectory,now:()=>clock});tools=createProductivityTools({store,builder,capabilities,executeCapability,now:()=>clock});app=await createSharedServer({dbPath:path.join(dataDirectory,'room.sqlite'),port:0,assistantProvider:provider,assistantOptions:{createProductivityRuntime:async()=>({store,tools,router,builder})}});origin=new URL((await app.listen()).url).origin;}
 t.after(async()=>{for(const release of cleanup)release();await app?.close();store?.close();const target=path.resolve(dataDirectory);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep+'companion-workflow-history-http-'));await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:20});});await start();
 async function request(method,route,body,user){requests.push({method,route});const response=await fetch(origin+'/api/assistant/'+route,{method,headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'});return{status:response.status,value:await response.json()};}
 async function session(){const response=await fetch(origin+'/api/assistant/session');const value=await response.json();return{cookie:response.headers.get('set-cookie').split(';')[0],csrfToken:value.csrfToken};}
 const apply=(type,fields={})=>store.apply({operationId:randomUUID(),expectedRevision:store.snapshot().revision,type,...fields});
 function executionCount(){const db=new DatabaseSync(path.toNamespacedPath(path.join(dataDirectory,'productivity.sqlite')),{readOnly:true});try{return db.prepare('SELECT count(*) AS count FROM execution_receipts').get().count;}finally{db.close();}}
 return{request,session,apply,calls,requests,executionCount,dataDirectory,get store(){return store;},get tools(){return tools;},advance(ms){clock+=ms;},onCleanup(fn){cleanup.push(fn);},async restart(){await app.close();store.close();await start();}};
}

test('actual HTTP run history and exact operation lookup preserve the original definition/outcome after edits and restart without another POST',async t=>{
 const f=await fixture(t),user=await f.session(),original=f.apply('saveWorkflow',{name:'Original synthetic routine',description:'Pinned original description 😀',steps:[{tool:'create_task',arguments:{title:'One actual task'}},{tool:'save_note',arguments:{text:'One actual note'}}]}).workflow,operationId=randomUUID();
 const started=await f.request('POST','workspace/workflows/'+original.id+'/run',{operationId},user);assert.equal(started.status,200);assert.equal(started.value.status,'completed');assert.equal(started.value.runId,workflowRunId('local-workspace:'+operationId));
 const initial=await f.request('GET','workspace/workflows/'+original.id+'/runs/'+started.value.runId,undefined,user);assert.equal(initial.status,200);assert.deepEqual(JSON.parse(initial.value.definitionText),original);assert.deepEqual(JSON.parse(initial.value.outcomeText),{id:original.id,status:'completed',steps:started.value.steps});assert.equal(initial.value.run.timestampsAvailable,true);assert.ok(initial.value.run.finishedAt);
 f.advance(5000);f.apply('saveWorkflow',{workflowId:original.id,name:'Renamed and disabled',enabled:false});const before=f.store.snapshot(),count=f.executionCount(),readStart=f.requests.length;
 const exact=await f.request('GET','workspace/workflows/'+original.id+'/operations/'+operationId,undefined,user);assert.equal(exact.status,200);assert.deepEqual(exact.value,initial.value);
 const list=await f.request('GET','workflow-runs?'+new URLSearchParams({workflowId:original.id,limit:'1'}),undefined,user);assert.equal(list.status,200);assert.equal(list.value.runs[0].name,original.name);assert.equal(list.value.runs[0].id,started.value.runId);assert.equal(list.value.runs[0].completedStepCount,2);
 assert.deepEqual(f.store.snapshot(),before);assert.equal(f.executionCount(),count);assert.ok(f.requests.slice(readStart).every(x=>x.method==='GET'));assert.equal(before.tasks.length,1);assert.equal(before.notes.length,1);
 await f.restart();const next=await f.session(),after=await f.request('GET','workspace/workflows/'+original.id+'/operations/'+operationId,undefined,next);assert.equal(after.status,200);assert.deepEqual(after.value,initial.value);assert.deepEqual(f.store.snapshot(),before);assert.equal(f.executionCount(),count);assert.deepEqual(f.calls,[]);
});

test('history routes are authenticated GET-only reads and unknown or mismatched identities cannot start or mutate work',async t=>{
 const f=await fixture(t),workflow=f.apply('saveWorkflow',{name:'Read only history',steps:[{tool:'get_time',arguments:{timezone:'UTC'}}]}).workflow,user=await f.session(),unknown=randomUUID();
 for(const route of ['workflow-runs','workspace/workflows/'+workflow.id+'/runs/'+unknown,'workspace/workflows/'+workflow.id+'/operations/'+unknown])assert.equal((await f.request('GET',route)).status,401);
 const before=f.store.snapshot(),count=f.executionCount();
 for(const route of ['workflow-runs','workspace/workflows/'+workflow.id+'/runs/'+unknown,'workspace/workflows/'+workflow.id+'/operations/'+unknown])assert.equal((await f.request('POST',route,{},user)).status,405);
 for(const suffix of ['runs/'+unknown,'operations/'+unknown])assert.equal((await f.request('GET','workspace/workflows/'+workflow.id+'/'+suffix,undefined,user)).status,404);
 for(const route of ['workflow-runs?limit=0','workflow-runs?before=not-a-cursor','workflow-runs?limit=1&limit=2','workflow-runs?unexpected=1','workspace/workflows/'+workflow.id+'/runs/'+unknown+'?definitionOffset=-1'])assert.equal((await f.request('GET',route,undefined,user)).status,400);
 assert.deepEqual(f.store.snapshot(),before);assert.equal(f.executionCount(),count);
 const result=await f.request('POST','workspace/workflows/'+workflow.id+'/run',{operationId:randomUUID()},user),other=f.apply('saveWorkflow',{name:'Another routine',steps:[{tool:'get_time',arguments:{}}]}).workflow,stable=f.store.snapshot(),savedCount=f.executionCount();
 const wrong=await f.request('GET','workspace/workflows/'+other.id+'/runs/'+result.value.runId,undefined,user);assert.equal(wrong.status,409);assert.equal(wrong.value.error.code,'workflow_run_binding');assert.deepEqual(f.store.snapshot(),stable);assert.equal(f.executionCount(),savedCount);assert.deepEqual(f.calls,[]);
});

test('live actual HTTP execution exposes its pending step and rejects combining pages after its nested checkpoint changes',async t=>{
 const entered=deferred(),release=deferred(),nested=deferred(),finish=deferred(),f=await fixture(t,{capabilities:[gateCapability],executeCapability:async({runTool})=>{entered.resolve();await release.promise;await runTool('create_task',{title:'Actual nested live effect'});nested.resolve();await finish.promise;return{value:{finished:true},hostActions:[]};}});f.onCleanup(()=>{release.resolve();finish.resolve();});
 const user=await f.session(),workflow=f.apply('saveWorkflow',{name:'Live synthetic routine',steps:[{tool:'create_task',arguments:{title:'Completed before gate'}},{tool:'cap_history_gate',arguments:{}}]}).workflow,operationId=randomUUID(),pending=f.request('POST','workspace/workflows/'+workflow.id+'/run',{operationId},user);
 try{
  await entered.promise;const route='workspace/workflows/'+workflow.id+'/operations/'+operationId,live=await f.request('GET',route+'?definitionLimit=17&outcomeLimit=17',undefined,user);assert.equal(live.status,200,JSON.stringify(live.value));assert.equal(live.value.run.status,'running');assert.equal(live.value.run.completedStepCount,1);assert.equal(live.value.run.finishedAt,null);assert.equal(live.value.definitionHasMore,true);
  const full=await f.request('GET',route,undefined,user),outcome=JSON.parse(full.value.outcomeText);assert.deepEqual(outcome.activeStep,{index:1,tool:'cap_history_gate',hostActions:[],nestedReceiptState:'in_progress',nestedDetailsTruncated:false,nestedCheckpointAvailable:false,outcomeUnknown:true});assert.equal(outcome.steps[0].result.task.title,'Completed before gate');
  release.resolve();await nested.promise;const before=f.store.snapshot(),changed=await f.request('GET',route+'?'+new URLSearchParams({definitionOffset:String(live.value.nextDefinitionOffset),expectedRunRevision:live.value.run.runRevision}),undefined,user);assert.equal(changed.status,409);assert.equal(changed.value.error.code,'workflow_run_changed');assert.deepEqual(f.store.snapshot(),before);
  const progressed=await f.request('GET',route,undefined,user),active=JSON.parse(progressed.value.outcomeText).activeStep;assert.equal(progressed.value.run.status,'running');assert.equal(progressed.value.run.completedStepCount,1);assert.notEqual(progressed.value.run.runRevision,live.value.run.runRevision);assert.equal(active.hostActions.length,1);assert.equal(active.hostActions[0].status,'completed');assert.equal(active.hostActions[0].result.task.title,'Actual nested live effect');assert.equal(active.nestedCheckpointAvailable,true);assert.equal(active.outcomeUnknown,true);
  finish.resolve();const result=await pending;assert.equal(result.value.status,'completed');const completed=await f.request('GET',route,undefined,user);assert.equal(completed.value.run.status,'completed');assert.equal(completed.value.run.completedStepCount,2);assert.notEqual(completed.value.run.runRevision,progressed.value.run.runRevision);assert.equal(before.tasks.length,2);
 }finally{release.resolve();finish.resolve();await pending;}
});

test('restart marks a real retained checkpoint interrupted while preserving completed timestamps and never resumes its remaining step',async t=>{
 const f=await fixture(t),user=await f.session(),finishedFlow=f.apply('saveWorkflow',{name:'Already finished',steps:[{tool:'get_time',arguments:{timezone:'UTC'}}]}).workflow,doneOperation=randomUUID(),done=await f.request('POST','workspace/workflows/'+finishedFlow.id+'/run',{operationId:doneOperation},user),donePage=await f.request('GET','workspace/workflows/'+finishedFlow.id+'/runs/'+done.value.runId,undefined,user);
 const workflow=f.apply('saveWorkflow',{name:'Interrupted original',steps:[{tool:'create_task',arguments:{title:'Committed before restart'}},{tool:'save_note',arguments:{text:'Must never resume'}}]}).workflow,operationId=randomUUID(),runId=workflowRunId('local-workspace:'+operationId),id='workflow:'+runId,digest=workflowRunDigest(workflow.id);
 f.store.beginExecution({id,digest,definition:workflow,workflowRun:{workflowId:workflow.id,operationId}});const effect=await f.tools.execute('create_task',{title:'Committed before restart'},{requestId:id,callId:'step:0'});f.store.checkpointExecution({id,digest,checkpoint:{steps:[{tool:'create_task',result:effect}],activeStep:{index:1,tool:'save_note'}}});
 const before=f.store.snapshot(),count=f.executionCount();f.advance(10000);await f.restart();const next=await f.session(),restored=await f.request('GET','workspace/workflows/'+workflow.id+'/operations/'+operationId,undefined,next);assert.equal(restored.status,200);assert.equal(restored.value.run.status,'interrupted');assert.equal(restored.value.run.completedStepCount,1);assert.equal(restored.value.run.timestampsAvailable,true);assert.ok(Date.parse(restored.value.run.finishedAt)>Date.parse(restored.value.run.startedAt));
 const outcome=JSON.parse(restored.value.outcomeText);assert.equal(outcome.outcomeUnknown,true);assert.equal(outcome.status,'interrupted');assert.deepEqual(outcome.activeStep,{index:1,tool:'save_note'});assert.equal(outcome.steps[0].result.task.id,effect.task.id);
 const unchanged=await f.request('GET','workspace/workflows/'+finishedFlow.id+'/operations/'+doneOperation,undefined,next);assert.deepEqual(unchanged.value,donePage.value);assert.deepEqual(f.store.snapshot(),before);assert.equal(f.executionCount(),count);assert.equal(before.notes.length,0);assert.deepEqual(f.calls,[]);
});
