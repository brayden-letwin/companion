import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {createContinuationStore} from '../server/continuation-store.mjs';
import {createContinuationService} from '../server/continuation-service.mjs';

const missing=()=>Object.assign(new Error('Synthetic item not found.'),{code:'work_not_found',statusCode:404});
const captured=()=>({id:randomUUID(),buildId:randomUUID(),workId:randomUUID(),origin:{conversationId:randomUUID(),requestId:'original_'+randomUUID(),requestDigest:'a'.repeat(64),message:'Compute 6 times 7 using the missing capability.',providerId:'synthetic-codex',provider:{id:'synthetic-codex',label:'Synthetic Codex',type:'codex',model:'configured'}},buildSpec:'Add a multiplication action with exact acceptance fixtures.'});
const pin={id:'multiply',name:'cap_multiply',version:1,hash:'b'.repeat(64)};
const ready=()=>({ready:true,reason:'ready',restartScope:'host',requiredCapabilities:[pin],sourceRevision:'c'.repeat(64),runtime:{instance:randomUUID(),hostInstanceId:randomUUID(),workerInstanceId:randomUUID(),hostPid:300,workerPid:400}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function completed(record,actions=[{id:'new-cap-call',tool:'run_capability',status:'completed',result:{capability:pin,value:{answer:42},hostActions:[]}}]){return{id:'work_'+record.workId,message:record.origin.message.trim(),providerId:record.origin.providerId,status:'completed',reply:{text:'42',continuation:{id:record.id,buildId:record.buildId,workId:record.workId},actions}};}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'companion-followthrough-')),builds=new Map(),jobs=new Map(),turns=new Map(),calls={build:[],work:[],validate:[],cancel:[]};let proof=ready(),validationHook=null,workHook=null,store,service;
  async function open(){store=await createContinuationStore({dataDirectory:directory});service=createContinuationService({store,
    async startBuild(input,{signal}){assert.equal(store.getByBuild(input.id).buildAttempted,true);if(signal.aborted)throw Object.assign(new Error('Stopped.'),{name:'AbortError'});calls.build.push(structuredClone(input));const job={id:input.id,status:'queued'};builds.set(job.id,job);return job;},
    async getBuild(id){if(!builds.has(id))throw missing();return structuredClone(builds.get(id));},
    async proveReady(){return structuredClone(proof);},
    async validateOrigin(record,options){calls.validate.push({record:structuredClone(record),scope:options.scope});if(validationHook)await validationHook(record,options);},
    async startWork(record,options){assert.equal(store.get(record.id).startClaimed,true);calls.work.push({record:structuredClone(record),proof:structuredClone(options.proof)});if(workHook)return workHook(record,options);if(options.signal.aborted)throw Object.assign(new Error('Stopped.'),{name:'AbortError'});const job={id:record.workId,conversationId:record.workId,requestId:'work_'+record.workId,providerId:record.origin.providerId,status:'queued'};jobs.set(job.id,job);return{job};},
    async getWork(id){if(!jobs.has(id))throw missing();return{job:structuredClone(jobs.get(id))};},async getWorkTurn(id){return structuredClone(turns.get(id)||null);},
    async cancelWork(id){calls.cancel.push(id);if(!jobs.has(id))throw missing();const job=jobs.get(id);if(!['completed','failed','cancelled','interrupted','waiting_for_review'].includes(job.status))job.status='cancelled';return{job:structuredClone(job)};},
  });return service;}
  await open();t.after(async()=>{await service.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'companion-followthrough-'));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:25});});
  return{get service(){return service;},get store(){return store;},builds,jobs,turns,calls,setProof(value){proof=value;},setValidation(hook){validationHook=hook;},setWork(hook){workHook=hook;},async reopen(){await service.close();return open();},async create(){const input=captured(),value=await service.requestBuild(input,{scope:'private-original-session'});return{input,value};},async eligible(input){builds.get(input.buildId).status='applied';return service.get(input.id);}};
}

test('build requests reserve exact intent before dispatch, keep model specifications separate and do not expose request digests',async t=>{
  const f=await fixture(t),{input,value}=await f.create();assert.equal(f.calls.build.length,1);assert.equal(value.continuation.originalRequest,input.origin.message);assert.equal(value.continuation.buildSpec,input.buildSpec);assert.equal(value.featureJob.id,input.buildId);assert.ok(!JSON.stringify(value.continuation).includes(input.origin.requestDigest));assert.ok(!JSON.stringify(value.continuation).includes('private-original-session'));
  const retry=await f.service.requestBuild(input);assert.equal(retry.continuation.id,input.id);assert.equal(f.calls.build.length,1);assert.equal((await f.service.getByBuild(input.buildId)).continuation.id,input.id);assert.equal(f.service.recordForWork(input.workId).origin.requestDigest,input.origin.requestDigest);assert.equal(f.service.recordForWork(input.workId).scope,'private-original-session');
  await assert.rejects(f.service.requestBuild({...input,id:randomUUID(),buildId:randomUUID(),workId:randomUUID()}),{code:'continuation_conflict'});assert.equal(f.calls.build.length,1);
  const listed=await f.service.list();assert.equal(listed.continuations[0].originalRequest,input.origin.message);assert.equal(Object.hasOwn(listed.continuations[0],'buildSpec'),false);
});

test('queued, review-required and unready runtime states never start work; only a real readiness proof permits explicit continue',async t=>{
  const f=await fixture(t),{input}=await f.create();assert.equal((await f.service.get(input.id)).continuation.status,'waiting_for_build');
  f.builds.get(input.buildId).status='review_required';assert.equal((await f.service.get(input.id)).continuation.status,'waiting_for_activation');await assert.rejects(f.service.continue(input.id),{code:'continuation_not_ready'});
  f.builds.get(input.buildId).status='applied';f.setProof({ready:false,reason:'runtime_restart_required',requiredCapabilities:[],sourceRevision:null,runtime:{managed:true,restarting:false},restartScope:'host'});const waiting=(await f.service.get(input.id)).continuation;assert.equal(waiting.status,'waiting_for_runtime');assert.equal(waiting.readiness.reason,'runtime_restart_required');assert.ok(waiting.reason.includes('Restart'));
  f.setProof({ready:false,reason:'no_callable_result',requiredCapabilities:[]});assert.equal((await f.service.get(input.id)).continuation.status,'blocked');assert.equal(f.calls.work.length,0);
  f.setProof(ready());assert.equal((await f.service.get(input.id)).continuation.status,'ready');assert.equal(f.calls.work.length,0);
  const started=await f.service.continue(input.id);assert.equal(started.continuation.status,'queued');assert.equal(started.continuation.workJob.id,input.workId);assert.equal(f.calls.work[0].record.origin.message,input.origin.message);assert.equal(f.calls.work[0].record.scope,'private-original-session');assert.equal(f.calls.validate[0].scope,'private-original-session');
});

test('concurrent Continue and lost acknowledgements retain one original Work identity without another effect',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);const gate=deferred();f.setWork(async(record)=>{await gate.promise;const job={id:record.workId,status:'running',conversationId:record.workId};f.jobs.set(job.id,job);throw Object.assign(new Error('Synthetic lost acknowledgement.'),{statusCode:503});});
  const first=f.service.continue(input.id),second=f.service.continue(input.id);await tick();gate.resolve();const[a,b]=await Promise.all([first,second]);assert.equal(a.continuation.workId,input.workId);assert.equal(b.continuation.workId,input.workId);assert.equal(f.calls.work.length,1);assert.equal(a.continuation.status,'running');
  await f.service.continue(input.id);await f.service.get(input.id);assert.equal(f.calls.work.length,1);await f.reopen();await f.service.get(input.id);await f.service.continue(input.id);assert.equal(f.calls.work.length,1);
});

test('provider or original-source validation blocks a new run without fallback or changing the stored intention',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);f.setValidation(async()=>{throw Object.assign(new Error('The original selected source is unavailable.'),{code:'source_unavailable',statusCode:409});});
  await assert.rejects(f.service.continue(input.id),{code:'source_unavailable'});assert.equal(f.store.get(input.id).status,'blocked');assert.equal(f.store.get(input.id).origin.message,input.origin.message);assert.equal(f.calls.work.length,0);assert.equal((await f.service.get(input.id)).continuation.status,'blocked');await assert.rejects(f.service.continue(input.id),{code:'continuation_not_ready'});assert.equal(f.calls.work.length,0);
});

test('global Stop during awaited validation durably prevents a late work claim',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);const entered=deferred(),gate=deferred();f.setValidation(async()=>{entered.resolve();await gate.promise;});
  const pending=f.service.continue(input.id);await entered.promise;const stopped=await f.service.stopAll();assert.equal(stopped.stopped,1);assert.equal(f.store.get(input.id).cancelRequested,true);gate.resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.calls.work.length,0);assert.equal(f.store.get(input.id).startClaimed,false);await assert.rejects(f.service.continue(input.id),{name:'AbortError'});
});

test('readiness is checked again after awaited origin validation before the durable start claim',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);f.setValidation(async()=>{f.setProof({ready:false,reason:'source_changed',requiredCapabilities:[]});});await assert.rejects(f.service.continue(input.id),{code:'continuation_not_ready'});assert.equal(f.store.get(input.id).startClaimed,false);assert.equal(f.calls.work.length,0);
});

test('a committed Work handoff with delayed acknowledgement is cancelled by Stop without a second admission',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);const accepted=deferred(),ack=deferred();f.setWork(async record=>{const job={id:record.workId,status:'queued',conversationId:record.workId};f.jobs.set(job.id,job);accepted.resolve();await ack.promise;return{job};});const pending=f.service.continue(input.id);await accepted.promise;const stopped=await f.service.stopAll();assert.equal(stopped.stopped,1);assert.equal(f.jobs.get(input.workId).status,'cancelled');ack.resolve();assert.equal((await pending).continuation.status,'cancelled');assert.equal(f.calls.work.length,1);await f.service.continue(input.id);assert.equal(f.calls.work.length,1);
});

test('one unconfirmed attempt is interrupted across restart and never dispatched on GET or repeated Continue',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);f.setWork(async()=>{throw Object.assign(new Error('Synthetic failure before a receipt.'),{statusCode:503});});
  const first=await f.service.continue(input.id);assert.equal(first.continuation.status,'interrupted');assert.equal(first.continuation.workJob,undefined);assert.equal(f.calls.work.length,1);await f.reopen();await f.service.get(input.id);await f.service.continue(input.id);assert.equal(f.calls.work.length,1);
});

test('only the exact new terminal continuation receipt completes the outcome and its committed result wins a late Stop',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);await f.service.continue(input.id);const record=f.store.get(input.id);f.turns.set(input.workId,completed(record));f.jobs.get(input.workId).status='running';
  const finished=await f.service.cancel(input.id);assert.equal(finished.continuation.status,'completed');assert.equal(finished.continuation.cancelRequested,true);assert.equal(finished.continuation.workJob.id,input.workId);assert.deepEqual(finished.continuation.requiredCapabilities,[pin]);
  f.setProof({...ready(),requiredCapabilities:[{...pin,hash:'d'.repeat(64)}]});await f.service.get(input.id);assert.deepEqual(f.store.get(input.id).proof.requiredCapabilities,[pin]);
});

test('a model success statement, historical capability or forged continuation identity cannot prove completion',async t=>{
  const f=await fixture(t);
  for(const mode of ['no-action','wrong-hash','wrong-link','wrong-turn']){const{input}=await f.create();await f.eligible(input);await f.service.continue(input.id);const record=f.store.get(input.id),turn=completed(record);if(mode==='no-action')turn.reply.actions=[];if(mode==='wrong-hash')turn.reply.actions[0].result.capability={...pin,hash:'d'.repeat(64)};if(mode==='wrong-link')turn.reply.continuation.id=randomUUID();if(mode==='wrong-turn')turn.id='work_'+randomUUID();f.turns.set(input.workId,turn);f.jobs.get(input.workId).status='completed';assert.equal((await f.service.get(input.id)).continuation.status,'failed');assert.equal(f.store.get(input.id).error.code,'continuation_result_unproven');}
});

test('review-required outcomes preserve pending evidence without claiming capability completion',async t=>{
  const f=await fixture(t),{input}=await f.create();await f.eligible(input);await f.service.continue(input.id);f.jobs.get(input.workId).status='waiting_for_review';f.turns.set(input.workId,completed(f.store.get(input.id),[{id:'pending',status:'pending',result:{desktopAction:{id:randomUUID(),status:'pending'}}}]));
  const value=await f.service.get(input.id);assert.equal(value.continuation.status,'waiting_for_review');assert.equal(value.continuation.workJob.id,input.workId);assert.equal(f.calls.work.length,1);
  const turn=completed(f.store.get(input.id));turn.reply.actions.push({id:'later-pending',status:'pending',result:{desktopAction:{id:randomUUID(),status:'pending'}}});f.turns.set(input.workId,turn);assert.equal((await f.service.get(input.id)).continuation.status,'waiting_for_review');
});

test('project revocation cancels only matching waiting links and exact accepted terminal results remain inspectable',async t=>{
  const f=await fixture(t),first=captured(),second=captured(),project={projectId:randomUUID(),grantEpoch:4};first.origin.project=project;second.origin.project={projectId:randomUUID(),grantEpoch:4};await f.service.requestBuild(first);await f.service.requestBuild(second);const result=await f.service.cancelProject(project);assert.equal(result.stopped,1);assert.equal(f.store.get(first.id).status,'cancelled');assert.equal(f.store.get(second.id).status,'waiting_for_build');assert.equal(f.calls.work.length,0);
});

test('summary pages honor actual escaped-byte bounds and never skip links when fewer than the requested limit fit',async t=>{
  const f=await fixture(t);for(let index=0;index<25;index++){const input=captured();input.origin.message='\u0001'.repeat(11900)+'Last exact criterion '+index;input.buildSpec='\u0002'.repeat(11900)+'Implement the exact original goal.';await f.service.requestBuild(input);f.store.update(input.id,{status:'cancelled',cancelRequested:true,reason:'\u0003'.repeat(1000),error:{code:'synthetic',message:'\u0004'.repeat(1000)}});}
  // Retained stopped metadata is not replaced by a fresh readiness read.
  const ids=[];let offset=0;for(;;){const page=await f.service.list({offset,limit:20});assert.ok(Buffer.byteLength(JSON.stringify(page))<=48*1024);assert.ok(page.continuations.length>0);ids.push(...page.continuations.map(item=>item.id));if(!page.hasMore)break;assert.equal(page.nextOffset,offset+page.continuations.length);offset=page.nextOffset;}assert.equal(ids.length,25);assert.equal(new Set(ids).size,25);
  const detail=(await f.service.get(ids[0])).continuation;assert.ok(detail.originalRequest.endsWith('24'));assert.ok(detail.buildSpec.endsWith('original goal.'));assert.ok(Buffer.byteLength(JSON.stringify(detail))<=384*1024);assert.ok(!JSON.stringify(detail).includes('a'.repeat(64)));
});
