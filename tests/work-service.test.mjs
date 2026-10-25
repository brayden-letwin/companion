import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProductivityStore } from '../server/productivity-store.mjs';
import { createWorkService } from '../server/work-service.mjs';

const descriptor={id:'synthetic',label:'Synthetic provider',type:'compatible',model:'test-model',baseUrl:'http://127.0.0.1:1'};
const request=(extra={})=>({id:randomUUID(),prompt:'Perform this original synthetic task.',providerId:descriptor.id,provider:descriptor,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const stopped=()=>Object.assign(new Error('Stopped by the synthetic caller.'),{name:'AbortError',code:'request_cancelled',statusCode:499});

test('model work pages fit a single model message and reconstruct the complete Unicode request while list history stays bounded',async t=>{
  const prompt=('界'.repeat(1999)+'😀').repeat(5)+'FINAL-ORIGINAL-CRITERION';
  const f=await fixture(t,{runTurn:(input,store)=>{const turn=begin(store,input);for(let index=0;index<40;index++)store.progressWorkJob(input.jobId,{type:'progress',message:'界'.repeat(500)});const error={statusCode:503,code:'synthetic_failure',message:'界'.repeat(2000),actions:[]};store.finishConversationTurn({...turn,status:'failed',error});throw Object.assign(new Error(error.message),error);}});
  const expected=[];let target;for(let index=0;index<20;index++){const contextId=randomUUID(),created=f.service.create(request({prompt,title:'界'.repeat(80),provider:{...descriptor,label:'界'.repeat(80),model:'界'.repeat(160),baseUrl:'https://example.invalid/'+'x'.repeat(1900)},contextId,scope:'private-fixture-scope',windowContext:{contextId,windowId:'window_for_model_pages',title:'界'.repeat(600),appName:'界'.repeat(200)}}));target=created.job.id;expected.push(target);await until(()=>f.service.list().jobs.some(job=>job.id===target&&job.status==='failed'));}
  const listing=f.service.list({limit:20});assert.ok(Buffer.byteLength(JSON.stringify(listing))<=64*1024);assert.ok(listing.jobs.length<20);assert.ok(listing.jobs.every(job=>job.progress.historyOmitted&&job.progress.events.length===0));assert.equal(listing.total,20);
  let cursor=0;const listed=[];for(;;){const page=f.service.list({offset:cursor,limit:20});assert.ok(Buffer.byteLength(JSON.stringify(page))<=64*1024);listed.push(...page.jobs.map(job=>job.id));if(!page.hasMore)break;assert.equal(page.nextOffset,cursor+page.jobs.length);cursor=page.nextOffset;}assert.deepEqual(listed,[...expected].reverse());
  let offset=0,reconstructed='',pages=0;for(;;){const page=await f.service.get(target,{modelView:true,promptOffset:offset});assert.ok(Buffer.byteLength(JSON.stringify(page))<=64*1024);assert.ok(JSON.stringify(page).length<100000);reconstructed+=page.prompt;pages++;if(!page.promptHasMore)break;assert.ok(page.nextPromptOffset>offset);offset=page.nextPromptOffset;}assert.ok(pages>1);assert.equal(reconstructed,prompt);const full=await f.service.get(target);assert.equal(full.prompt,prompt);assert.ok(full.progress.events.length>0);await assert.rejects(f.service.get(target,{modelView:true,promptOffset:2000}),{code:'invalid_work_page'});
});
async function until(predicate){for(let index=0;index<200;index++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Work state did not settle.');}
function begin(store,input){const digest=createHash('sha256').update(JSON.stringify({message:input.message,providerId:input.providerId,conversationId:input.conversationId,contextId:input.contextId})).digest('hex'),turn={conversationId:input.conversationId,expectedRevision:0,id:input.requestId,message:input.message,providerId:input.providerId,digest,activate:false};store.beginConversationTurn(turn);return turn;}
function finish(store,turn,text='Original completed response.',actions=[]){return store.finishConversationTurn({...turn,status:'completed',reply:{text,actions,providerId:descriptor.id}}).receipt.reply;}
async function fixture(t,options={}){
  const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-work-service-')),stores=[],services=[];
  const open=async()=>{const store=await createProductivityStore({dataDirectory,...options.storeOptions});stores.push(store);return store;},store=await open();
  const service=createWorkService({store,runTurn:input=>options.runTurn?options.runTurn(input,store):finish(store,begin(store,input))});services.push(service);
  t.after(async()=>{for(const item of services)await item.close();for(const item of stores)item.close();assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir())+path.sep));await rm(dataDirectory,{recursive:true,force:true,maxRetries:3,retryDelay:30});});
  return{store,service,open,dataDirectory,addService:(target,runTurn)=>{const item=createWorkService({store:target,runTurn});services.push(item);return item;}};
}

test('job and dedicated conversation creation is atomic, idempotent and never switches the selected conversation',async t=>{
  const f=await fixture(t),active=randomUUID();f.store.createConversation({id:active,title:'Keep this active'});const before=f.store.listConversations().activeConversationId,input=request({prompt:'  Preserve the exact original prompt.\nFinal criterion.  ',scope:'SYNTHETIC_SCOPE_NOT_PUBLIC'});
  const created=f.store.createWorkJob(input);assert.equal(created.replayed,false);assert.equal(created.job.conversationId,input.id);assert.equal(created.job.requestId,'work_'+input.id);assert.equal(created.job.prompt,input.prompt);assert.equal(f.store.listConversations().activeConversationId,before);assert.ok(!JSON.stringify(created).includes(input.scope));
  const replay=f.store.createWorkJob({...input,scope:'another-scope',provider:{...descriptor,label:'Renamed',model:'different-now'}});assert.equal(replay.replayed,true);assert.equal(replay.job.provider.model,descriptor.model);assert.equal(f.store.listConversations().conversations.length,2);
  assert.throws(()=>f.store.createWorkJob({...input,prompt:'Changed semantic input'}),{code:'work_conflict'});
  const db=new DatabaseSync(path.join(f.dataDirectory,'productivity.sqlite'));db.exec("CREATE TRIGGER synthetic_job_insert_failure BEFORE INSERT ON work_jobs BEGIN SELECT RAISE(ABORT,'Synthetic job insert failure'); END;");const next=request();assert.throws(()=>f.store.createWorkJob(next),/Synthetic job insert failure/u);assert.ok(!f.store.listConversations().conversations.some(item=>item.id===next.id));db.exec('DROP TRIGGER synthetic_job_insert_failure');db.close();
  f.store.createWorkJob(next);assert.equal(f.store.listConversations().activeConversationId,before);
});

test('two independent turns run concurrently while a third remains queued and each result stays anchored to its own request',async t=>{
  const gates=new Map(),calls=[];const f=await fixture(t,{runTurn:async(input,store)=>{calls.push(input);const turn=begin(store,input),gate=deferred();gates.set(input.requestId,gate);input.signal.addEventListener('abort',()=>gate.reject(stopped()),{once:true});try{await gate.promise;return finish(store,turn,'Result for '+input.message);}catch(error){store.finishConversationTurn({...turn,status:'cancelled',error:{code:'request_cancelled',message:error.message}});throw error;}}});
  const active=randomUUID();f.store.createConversation({id:active,title:'Foreground remains active'});
  const first=request({prompt:'First independent task.'}),second=request({prompt:'Second independent task.'}),third=request({prompt:'Third queued task.'});f.service.create(first);f.service.create(second);await until(()=>calls.length===2);f.service.create(third);
  assert.equal(f.store.getWorkJob(first.id).status,'running');assert.equal(f.store.getWorkJob(second.id).status,'running');assert.equal(f.store.getWorkJob(third.id).status,'queued');assert.equal(f.store.listConversations().activeConversationId,active);assert.ok(calls.every(call=>call.allowDelegation===false&&call.expectedProvider.model===descriptor.model));
  gates.get('work_'+first.id).resolve();await until(()=>calls.length===3);assert.equal(f.store.getWorkJob(third.id).status,'running');gates.get('work_'+second.id).resolve();gates.get('work_'+third.id).resolve();await until(()=>f.store.getWorkJob(third.id).status==='completed');
  const detail=await f.service.get(first.id);assert.equal(detail.prompt,first.prompt);assert.equal(detail.outcome.text,'Result for '+first.prompt);assert.ok(!JSON.stringify(detail).includes(second.prompt));assert.ok(Buffer.byteLength(JSON.stringify(detail))<=128*1024);
  const later={conversationId:first.id,expectedRevision:2,id:'later-user-request',message:'A later request',providerId:descriptor.id,digest:'a'.repeat(64),activate:false};f.store.beginConversationTurn(later);finish(f.store,later,'MUST_NOT_REPLACE_ORIGINAL_WORK_OUTPUT');assert.equal((await f.service.get(first.id)).outcome.text,detail.outcome.text);
  const replay=f.service.create(first);assert.equal(replay.replayed,true);assert.equal(replay.job.status,'completed');assert.equal(calls.length,3);
});

test('cancellation preserves actual partial effects, waits for callback settlement and does not start cancelled queued jobs',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve);let calls=0;
  const f=await fixture(t,{runTurn:async(input,store)=>{calls++;const turn=begin(store,input),operationId=randomUUID(),task=store.apply({operationId,expectedRevision:store.snapshot().revision,type:'addTask',title:'Actual effect before cancellation'}).workspace.tasks.find(item=>item.id===operationId),actions=[{id:'created',tool:'create_task',status:'completed',result:{task}}];store.recordConversationActions({...turn,actions});entered();try{await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(stopped()),{once:true}));}catch(error){store.finishConversationTurn({...turn,status:'cancelled',error:{code:'request_cancelled',message:error.message,actions}});throw error;}}});
  const input=request();f.service.create(input);await started;const immediate=f.service.cancel(input.id);assert.equal(immediate.cancelRequested,true);assert.equal(immediate.status,'running');assert.deepEqual(f.service.cancel(input.id),immediate);await until(()=>f.store.getWorkJob(input.id).status==='cancelled');
  const detail=await f.service.get(input.id);assert.equal(detail.outcome.actions[0].result.task.id,f.store.snapshot().tasks[0].id);assert.equal(detail.outcome.status,'cancelled');assert.equal(f.service.cancel(input.id).status,'cancelled');assert.equal(f.service.create(input).replayed,true);assert.equal(calls,1);assert.equal(f.store.snapshot().tasks.length,1);
  const queued=request();f.service.create(queued);f.service.cancel(queued.id);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(f.store.getWorkJob(queued.id).status,'cancelled');
});

test('restarting interrupts queued and uncertain running work without repeating effects, while committed turn completion remains authoritative',async t=>{
  const f=await fixture(t),queued=request(),running=request(),done=request();for(const input of [queued,running,done])f.store.createWorkJob(input);
  f.store.startWorkJob(running.id);const turn=begin(f.store,{requestId:'work_'+running.id,conversationId:running.id,message:running.prompt,providerId:running.providerId});const operationId=randomUUID(),task=f.store.apply({operationId,expectedRevision:0,type:'addTask',title:'Durable actual effect'}).workspace.tasks[0];f.store.recordConversationActions({...turn,actions:[{id:'actual',tool:'create_task',status:'completed',result:{task}}]});
  f.store.startWorkJob(done.id);finish(f.store,begin(f.store,{requestId:'work_'+done.id,conversationId:done.id,message:done.prompt,providerId:done.providerId}),'Committed before wrapper bookkeeping.');
  f.store.close();const restarted=await f.open();let calls=0;const service=f.addService(restarted,async()=>{calls++;throw new Error('Must not restart old work');});
  assert.equal(restarted.getWorkJob(queued.id).status,'interrupted');assert.equal(restarted.getWorkJob(running.id).status,'interrupted');assert.equal(restarted.getWorkJob(done.id).status,'completed');assert.equal((await service.get(running.id)).outcome.actions[0].result.task.id,task.id);assert.equal((await service.get(done.id)).outcome.text,'Committed before wrapper bookkeeping.');
  assert.equal(service.create(running).replayed,true);service.list();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.equal(restarted.snapshot().tasks.length,1);
});

test('review-waiting work is terminal and cannot silently continue after an approval or an exact create retry',async t=>{
  let calls=0;const pendingId=randomUUID();const f=await fixture(t,{runTurn:async(input,store)=>{calls++;const turn=begin(store,input);return finish(store,turn,'Review this actual prepared action.',[{id:'prepare',tool:'desktop_propose_action',status:'pending',result:{desktopAction:{id:pendingId,status:'pending',requiresApproval:true}}}]);}});
  const input=request();f.service.create(input);await until(()=>f.store.getWorkJob(input.id).status==='waiting_for_review');const detail=await f.service.get(input.id);assert.equal(detail.outcome.status,'waiting_for_review');assert.equal(detail.outcome.actions[0].result.desktopAction.id,pendingId);assert.equal(f.service.cancel(input.id).status,'waiting_for_review');assert.equal(f.service.create(input).job.status,'waiting_for_review');assert.equal(calls,1);
});

test('queue capacity, atomic start claims and retained limits fail before any assistant effects',async t=>{
  const f=await fixture(t),inputs=Array.from({length:10},()=>request());for(const input of inputs)f.store.createWorkJob(input);
  assert.throws(()=>f.store.createWorkJob(request()),{code:'work_queue_limit'});assert.equal(f.store.startWorkJob(inputs[0].id).started,true);assert.equal(f.store.startWorkJob(inputs[1].id).started,true);assert.equal(f.store.startWorkJob(inputs[2].id).started,false);assert.equal(f.store.startWorkJob(inputs[0].id).started,false);
  f.store.createWorkJob(request());f.store.createWorkJob(request());assert.throws(()=>f.store.createWorkJob(request()),{code:'work_queue_limit'});assert.equal(f.store.snapshot().tasks.length,0);
  assert.equal(f.service.list({offset:0,limit:5}).jobs.length,5);assert.equal(f.service.list({offset:5,limit:5}).hasMore,true);assert.throws(()=>f.service.list({limit:21}),{code:'invalid_work_page'});
  for(const job of f.store.listWorkJobs({limit:20}).jobs)f.store.cancelWorkJob(job.id);
  for(let index=12;index<200;index++){const input=request();f.store.createWorkJob(input);f.store.cancelWorkJob(input.id);}assert.equal(f.store.listWorkJobs({limit:1}).total,200);assert.throws(()=>f.store.createWorkJob(request()),{code:'work_history_limit'});
});

test('selected source scope stays private and source identity/provider metadata are frozen for the runner',async t=>{
  let observed;const f=await fixture(t,{runTurn:async(input,store)=>{observed=input;return finish(store,begin(store,input));}}),contextId=randomUUID(),windowContext={contextId,windowId:randomUUID(),title:'Selected fixture',appName:'Fixture'},input=request({contextId,windowContext,scope:'PRIVATE_ORIGINAL_SCOPE'});
  const created=f.service.create(input);assert.ok(!JSON.stringify(created).includes(input.scope));await until(()=>f.store.getWorkJob(input.id).status==='completed');assert.equal(observed.scope,input.scope);assert.equal(observed.contextId,contextId);assert.equal(observed.windowContext.contextId,contextId);assert.equal(observed.expectedProvider.model,descriptor.model);assert.equal(observed.allowDelegation,false);
  const db=new DatabaseSync(path.join(f.dataDirectory,'productivity.sqlite'));try{assert.ok(!JSON.stringify(db.prepare('SELECT * FROM work_jobs').all()).includes(input.scope));}finally{db.close();}
  assert.equal(f.service.create({...input,scope:'A_NEW_SESSION',provider:{...descriptor,label:'New label',model:'New configured model'}}).replayed,true);assert.equal(observed.expectedProvider.model,descriptor.model);
});

test('engine progress retains real phases using fixed host messages without storing provider output',async t=>{
  const messages=[];let f;
  f=await fixture(t,{runTurn:async(input,store)=>{
    const turn=begin(store,input),emit=(update,type,message)=>{input.onProgress({...update,message:'UNTRUSTED_PROVIDER_TEXT_DO_NOT_RETAIN'});const actual=store.getWorkJob(input.jobId).progress;assert.equal(actual.events.at(-1).type,type);assert.equal(actual.message,message);messages.push(actual.message);};
    emit({phase:'context',state:'running'},'context','Reading the selected window.');
    emit({phase:'model',state:'waiting'},'model','Waiting for an AI connection slot.');
    emit({type:'queue_waiting'},'queue_waiting','Waiting for an AI connection slot.');
    emit({phase:'model',state:'running'},'model','Working with the selected AI.');
    emit({phase:'tool',state:'running',tool:'create_task'},'tool','Running create task.');
    emit({phase:'tool',state:'completed',tool:'create_task'},'tool','Finished create task.');
    emit({phase:'tool',state:'failed',tool:'UNTRUSTED\nLABEL'},'tool','Could not finish the requested action.');
    emit({phase:'completed',state:'completed'},'completed','Finished.');
    input.onProgress({phase:'fabricated_phase',message:'UNTRUSTED_PROVIDER_TEXT_DO_NOT_RETAIN'});
    return finish(store,turn);
  }});
  const input=request();f.service.create(input);await until(()=>f.store.getWorkJob(input.id).status==='completed');const job=f.store.getWorkJob(input.id);
  assert.equal(messages.length,8);assert.equal(job.progress.message,'Completed.');assert.ok(!JSON.stringify(job.progress).includes('UNTRUSTED'));assert.equal(job.progress.events.filter(event=>event.type==='model').length,2);
});

test('close aborts active turns and awaits their actual settlement before the store may close',async t=>{
  let entered,release,observedSignal;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{runTurn:async(input,store)=>{observedSignal=input.signal;const turn=begin(store,input);entered();await held;store.finishConversationTurn({...turn,status:'cancelled',error:{code:'request_cancelled',message:'Closed after actual settlement.'}});throw stopped();}}),input=request();f.service.create(input);await started;let closed=false;const closing=f.service.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(observedSignal.aborted,true);assert.equal(closed,false);assert.ok(f.store.getWorkJob(input.id));release();await closing;assert.equal(closed,true);assert.ok(['cancelled','interrupted'].includes(f.store.getWorkJob(input.id).status));assert.throws(()=>f.service.create(request()),{code:'work_closed'});
});
