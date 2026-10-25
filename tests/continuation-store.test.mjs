import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createContinuationStore} from '../server/continuation-store.mjs';

const captured=()=>({id:randomUUID(),buildId:randomUUID(),workId:randomUUID(),origin:{conversationId:randomUUID(),requestId:'original_'+randomUUID(),requestDigest:'a'.repeat(64),message:'Calculate the requested result once the missing action exists.',providerId:'synthetic-codex',provider:{id:'synthetic-codex',label:'Synthetic Codex',type:'codex',model:'configured'},runtime:{hostInstanceId:randomUUID(),workerInstanceId:randomUUID(),hostPid:1200,workerPid:1300}},buildSpec:'Build a bounded calculation action with concrete acceptance cases.'});
const proof=()=>({ready:true,requiredCapabilities:[{id:'synthetic-calculation',name:'cap_synthetic_calculation',version:1,hash:'b'.repeat(64)}],sourceRevision:'c'.repeat(64),runtime:{hostInstanceId:randomUUID(),workerInstanceId:randomUUID(),hostPid:2200,workerPid:2300}});
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'companion-continuations-'));let store=await createContinuationStore({dataDirectory:directory});t.after(async()=>{store.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'companion-continuations-'));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:25});});return{get store(){return store;},async reopen(){store.close();store=await createContinuationStore({dataDirectory:directory});return store;}};}

test('continuation reservations retain exact original intent separately from build specifications and bind immutable input',async t=>{
  const f=await fixture(t),input=captured();input.origin.message='X'.repeat(11950)+'\nLast criterion: preserve this trailing condition.';
  const first=f.store.reserve(input);assert.equal(first.replayed,false);assert.equal(first.record.origin.message,input.origin.message);assert.equal(first.record.buildSpec,input.buildSpec);assert.notEqual(first.record.buildSpec,first.record.origin.message);assert.equal(f.store.reserve(structuredClone(input)).replayed,true);
  for(const change of [value=>value.origin.message='Y'+value.origin.message.slice(1),value=>value.origin.requestDigest='d'.repeat(64),value=>value.buildSpec+='different',value=>value.origin.provider.model='other',value=>value.workId=randomUUID()]){const different=structuredClone(input);change(different);await assert.rejects(async()=>f.store.reserve(different),{code:'continuation_conflict'});}
  await assert.rejects(async()=>f.store.reserve({...captured(),buildId:input.buildId}),{code:'continuation_conflict'});
  const duplicate=captured();duplicate.origin=structuredClone(input.origin);assert.throws(()=>f.store.reserve(duplicate),{code:'continuation_conflict'});
  await f.reopen();assert.equal(f.store.get(input.id).origin.message,input.origin.message);assert.equal(f.store.getByBuild(input.buildId).id,input.id);assert.equal(f.store.getByWork(input.workId).id,input.id);
});

test('two open stores cannot reserve separate links for one original receipt',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'companion-continuation-owners-')),first=await createContinuationStore({dataDirectory:directory}),second=await createContinuationStore({dataDirectory:directory});
  try{const input=captured();first.reserve(input);const duplicate={...input,id:randomUUID(),buildId:randomUUID(),workId:randomUUID()};assert.throws(()=>second.reserve(duplicate),{code:'continuation_conflict'});assert.equal(second.reserve(input).replayed,true);assert.equal(first.list().total,1);}
  finally{first.close();second.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'companion-continuation-owners-'));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:25});}
});

test('private origin validation rejects credentials, missing digests and fabricated source metadata',async t=>{
  const f=await fixture(t);
  for(const change of [value=>delete value.origin.requestDigest,value=>value.origin.provider.apiKey='never-store-this',value=>value.origin.provider.baseUrl='https://user:secret@example.test',value=>value.origin.project={projectId:randomUUID(),grantEpoch:0},value=>value.origin.windowContext={contextId:randomUUID(),text:'not-authorized-source'},value=>value.origin.scope='never-persist-this',value=>value.scope='never-persist-this']){const input=captured();change(input);await assert.rejects(async()=>f.store.reserve(input));}
  const input=captured();input.origin.project={projectId:randomUUID(),grantEpoch:3,label:'Synthetic folder'};assert.deepEqual(f.store.reserve(input).record.origin.project,input.origin.project);
});

test('one durable start claim survives restart, while cancellation prevents a later claim',async t=>{
  const f=await fixture(t),input=captured();f.store.reserve(input);assert.throws(()=>f.store.claim(input.id,proof()),{code:'continuation_not_ready'});
  f.store.update(input.id,{status:'ready',readiness:proof()});const pinned=proof(),first=f.store.claim(input.id,pinned);assert.equal(first.claimed,true);assert.equal(first.record.status,'starting');assert.deepEqual(first.record.proof,pinned);assert.equal(f.store.claim(input.id,proof()).claimed,false);
  await f.reopen();const after=f.store.get(input.id);assert.equal(after.status,'interrupted');assert.equal(after.startClaimed,true);assert.deepEqual(after.proof,pinned);assert.equal(f.store.claim(input.id,proof()).claimed,false);
  const stopped=captured();f.store.reserve(stopped);f.store.update(stopped.id,{status:'ready',readiness:proof()});f.store.cancel(stopped.id);assert.throws(()=>f.store.claim(stopped.id,proof()),{code:'continuation_cancelled'});
});

test('all retained links have stable bounded paging and a hard history limit',async t=>{
  const f=await fixture(t),ids=[];for(let index=0;index<200;index++){const input=captured();ids.push(input.id);f.store.reserve(input);}const pages=[];for(let offset=0;;){const page=f.store.list({offset,limit:17});assert.ok(page.records.length<=17);pages.push(...page.records.map(record=>record.id));if(!page.hasMore)break;assert.equal(page.nextOffset,offset+page.records.length);offset=page.nextOffset;}assert.deepEqual(pages,ids.reverse());assert.equal(new Set(pages).size,200);
  assert.throws(()=>f.store.reserve(captured()),{code:'continuation_limit'});for(const query of [{offset:201},{offset:-1},{limit:21},{limit:0}])assert.throws(()=>f.store.list(query),{code:'invalid_continuation_page'});assert.deepEqual(f.store.list({offset:200}).records,[]);
});
