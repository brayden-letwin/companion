import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {setTimeout as wait,setImmediate as tick} from 'node:timers/promises';
import {createProviderCheckService} from '../server/provider-checks.mjs';

const provider=()=>({id:'api',type:'openai',label:'Synthetic provider',model:'synthetic-model',baseUrl:'https://example.invalid/v1',revision:randomUUID(),hasKey:true,secretStorage:'memory'});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,{timeoutMs=60000,now}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'companion-provider-checks-')),providers=[provider()],calls=[];let service,metadataHook=null,probeHook=null;
  const open=async()=>{service=await createProviderCheckService({dataDirectory:directory,timeoutMs,...(now?{now}:{}),listProviders:()=>metadataHook?metadataHook():structuredClone(providers),probeConnection:async input=>{calls.push(input);return probeHook?probeHook(input):{passed:true,providerId:input.providerId,revision:input.expectedRevision};}});return service;};await open();
  t.after(async()=>{await service.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'companion-provider-checks-'));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:25});});
  return{directory,filename:path.join(directory,'provider-checks.json'),providers,calls,get service(){return service;},setMetadata(hook){metadataHook=hook;},setProbe(hook){probeHook=hook;},input(){return{id:randomUUID(),providerId:providers[0].id,revision:providers[0].revision};},async reopen(){await service.close();return open();}};
}
async function terminal(service,id){for(let count=0;count<200;count++){const result=await service.get(id);if(!['queued','running','stopping'].includes(result.check.status))return result.check;await wait(2);}throw new Error('The synthetic probe did not settle.');}

test('one durable identity admits one context-free probe and terminal retries only read its recorded outcome',async t=>{
  const f=await fixture(t),input=f.input(),results=await Promise.all([f.service.start(input),f.service.start(structuredClone(input))]);assert.equal(results[0].check.id,input.id);assert.equal(results[1].check.id,input.id);const passed=await terminal(f.service,input.id);assert.equal(passed.status,'passed');assert.equal(passed.configurationMatches,true);assert.equal(passed.observedThisSession,true);assert.equal(passed.completionOnly,true);assert.equal(passed.scope,'app_configuration');assert.equal(f.calls.length,1);assert.deepEqual(Object.keys(f.calls[0]).sort(),['expectedRevision','onStopping','providerId','signal']);
  await f.service.start(input);await f.service.get(input.id);await f.service.list();assert.equal(f.calls.length,1);await assert.rejects(f.service.start({...input,revision:randomUUID()}),{code:'provider_check_conflict'});assert.equal(f.calls.length,1);
  const serialized=await readFile(f.filename,'utf8');for(const key of ['apiKey','protectedKey','prompt','nonce','output','toolCalls','messages'])assert.ok(!serialized.includes('"'+key+'"'),key);assert.equal(JSON.parse(serialized).checks.length,1);assert.equal(Object.hasOwn(passed,'sessionId'),false);
});

test('global Stop and caller abort during metadata admission prevent any late provider dispatch',async t=>{
  const f=await fixture(t);for(const cause of ['global','caller']){const entered=deferred(),gate=deferred(),input=f.input(),controller=new AbortController();f.setMetadata(async()=>{entered.resolve();return gate.promise;});const start=f.service.start(input,{signal:controller.signal});await entered.promise;if(cause==='global')assert.equal((await f.service.stopAll()).stopped,1);else controller.abort();f.setMetadata(null);gate.resolve(structuredClone(f.providers));const result=await start;assert.equal(result.check.status,'cancelled');assert.equal(f.calls.length,0);assert.equal((await terminal(f.service,input.id)).status,'cancelled');}
});

test('cancelled helpers remain stopping and close retains ownership until their actual promise settles',async t=>{
  const f=await fixture(t),entered=deferred(),gate=deferred();f.setProbe(async input=>{entered.resolve();return gate.promise;});const input=f.input();await f.service.start(input);await entered.promise;const stopped=await f.service.cancel(input.id);assert.equal(stopped.check.status,'stopping');assert.equal(f.calls[0].signal.aborted,true);await assert.rejects(f.service.start(f.input()),{code:'provider_check_active'});
  let closed=false;const closing=f.service.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);gate.resolve({passed:true,providerId:input.providerId,revision:input.revision});await closing;assert.equal(closed,true);assert.equal((await f.service.get(input.id)).check.status,'cancelled');assert.equal(f.calls.length,1);
});

test('deadline includes waiting and never turns an unconfirmed stopped helper into a successful check',async t=>{
  const f=await fixture(t,{timeoutMs:1000}),entered=deferred(),gate=deferred();f.setProbe(async()=>{entered.resolve();return gate.promise;});const input=f.input();await f.service.start(input);await entered.promise;await wait(1025);const stopping=(await f.service.get(input.id)).check;assert.equal(stopping.status,'stopping');assert.equal(stopping.error.code,'provider_timeout');assert.equal(f.calls[0].signal.aborted,true);gate.resolve({passed:true,providerId:input.providerId,revision:input.revision});const failed=await terminal(f.service,input.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'provider_timeout');
});

test('key rotation, removal and a stale late success cannot verify a new configuration',async t=>{
  const f=await fixture(t),entered=deferred(),gate=deferred();f.setProbe(async()=>{entered.resolve();return gate.promise;});const input=f.input();await f.service.start(input);await entered.promise;f.providers[0].revision=randomUUID();await f.service.invalidateProvider('api');assert.equal((await f.service.get(input.id)).check.status,'stopping');gate.resolve({passed:true,providerId:'api',revision:input.revision});const stale=await terminal(f.service,input.id);assert.equal(stale.status,'stale');assert.equal(stale.configurationMatches,false);assert.equal((await f.service.start(input)).check.status,'stale');assert.equal(f.calls.length,1);
  f.setProbe(null);const current=f.input();await f.service.start(current);assert.equal((await terminal(f.service,current.id)).status,'passed');f.providers.splice(0,1);await f.service.invalidateProvider('api');const historical=(await f.service.get(current.id)).check;assert.equal(historical.status,'passed');assert.equal(historical.configurationMatches,false);assert.deepEqual(await f.service.list(),{checks:[],total:0});assert.equal(f.calls.length,2);
});

test('metadata is checked again after a returned completion even without an invalidation notification',async t=>{
  const f=await fixture(t);f.setProbe(async input=>{f.providers[0].revision=randomUUID();return{passed:true,providerId:input.providerId,revision:input.expectedRevision};});const input=f.input();await f.service.start(input);const result=await terminal(f.service,input.id);assert.equal(result.status,'stale');assert.equal(result.configurationMatches,false);assert.equal(f.calls.length,1);
});

test('restart preserves terminal historical evidence and marks queued/running/stopping records interrupted without retrying',async t=>{
  const f=await fixture(t),input=f.input();await f.service.start(input);assert.equal((await terminal(f.service,input.id)).status,'passed');await f.service.close();const saved=JSON.parse(await readFile(f.filename,'utf8'));for(const status of ['queued','running','stopping'])saved.checks.push({...saved.checks[0],id:randomUUID(),status,...(status==='queued'?{startedAt:undefined}:{}),finishedAt:undefined});await writeFile(f.filename,JSON.stringify(saved));await f.reopen();const historical=(await f.service.get(input.id)).check;assert.equal(historical.status,'passed');assert.equal(historical.observedThisSession,false);assert.equal(historical.configurationMatches,true);for(const record of saved.checks.slice(1)){const recovered=(await f.service.get(record.id)).check;assert.equal(recovered.status,'interrupted');assert.equal(recovered.observedThisSession,false);}assert.equal(f.calls.length,1);await f.service.start(input);assert.equal(f.calls.length,1);
});

test('fixed diagnostics never persist returned output, prompts or raw provider/credential errors',async t=>{
  const f=await fixture(t),secret='SYNTHETIC_NEVER_REAL_API_KEY_OR_PROMPT';f.setProbe(async()=>{throw Object.assign(new Error(secret),{code:'provider_credentials_rejected'});});let input=f.input();await f.service.start(input);const failed=await terminal(f.service,input.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'provider_credentials_rejected');assert.ok(!JSON.stringify(failed).includes(secret));
  f.setProbe(async value=>({passed:true,providerId:value.providerId,revision:value.expectedRevision,output:secret,nonce:secret}));input=f.input();await f.service.start(input);assert.equal((await terminal(f.service,input.id)).status,'failed');assert.ok(!(await readFile(f.filename,'utf8')).includes(secret));
  f.providers[0].apiKey=secret;input=f.input();await f.service.start(input);assert.equal((await terminal(f.service,input.id)).status,'failed');assert.equal(f.calls.length,2);assert.ok(!(await readFile(f.filename,'utf8')).includes(secret));delete f.providers[0].apiKey;
});

test('old committed success wins a later Cancel or global Stop and only latest checks for current providers are listed',async t=>{
  const f=await fixture(t);const first=f.input();await f.service.start(first);await terminal(f.service,first.id);const second=f.input();await f.service.start(second);await terminal(f.service,second.id);assert.equal((await f.service.cancel(second.id)).check.status,'passed');assert.equal((await f.service.stopAll()).stopped,0);assert.equal((await f.service.get(second.id)).check.status,'passed');const listed=await f.service.list();assert.equal(listed.total,1);assert.equal(listed.checks[0].id,second.id);assert.equal(f.calls.length,2);
});

test('busy and fixed-response mismatch outcomes retain specific safe diagnostics after restart',async t=>{
  const f=await fixture(t),outcomes=[['provider_busy','The AI connection is busy. Wait for current work to finish or stop it before testing again.'],['probe_response_mismatch','The provider did not return the expected small test response.']],recorded=[];
  for(const[code,message]of outcomes){f.setProbe(async()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'),{code});});const input=f.input();await f.service.start(input);const check=await terminal(f.service,input.id);assert.equal(check.status,'failed');assert.deepEqual(check.error,{code,message});recorded.push({id:input.id,error:check.error});}
  assert.equal(f.calls.length,2);assert.ok(!(await readFile(f.filename,'utf8')).includes('SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'));await f.reopen();for(const expected of recorded){const check=(await f.service.get(expected.id)).check;assert.equal(check.status,'failed');assert.deepEqual(check.error,expected.error);}assert.equal(f.calls.length,2);
});

test('strict input and bounded retained history cannot cause undisclosed extra probe attempts',async t=>{
  const f=await fixture(t);for(const input of [{...f.input(),prompt:'Do not send user data'},{...f.input(),apiKey:'never'},{...f.input(),revision:'bad'},{...f.input(),providerId:'../outside'},{...f.input(),id:'not-a-uuid'}])await assert.rejects(f.service.start(input),{code:'invalid_provider_check'});assert.equal(f.calls.length,0);
  for(let index=0;index<200;index++){const input=f.input();await f.service.start(input);await terminal(f.service,input.id);}await assert.rejects(f.service.start(f.input()),{code:'provider_check_history_limit'});assert.equal(f.calls.length,200);assert.ok(Buffer.byteLength(await readFile(f.filename))<=1024*1024);assert.equal(JSON.parse(await readFile(f.filename,'utf8')).checks.length,200);
});

test('malformed or nonregular private history fails closed without deleting or replacing the evidence',async t=>{
  const f=await fixture(t),input=f.input();await f.service.start(input);await terminal(f.service,input.id);await f.service.close();const good=JSON.parse(await readFile(f.filename,'utf8')),open=()=>createProviderCheckService({dataDirectory:f.directory,listProviders:()=>f.providers,probeConnection:async()=>{throw new Error('No probe may run.');}});
  for(const change of [saved=>saved.version=2,saved=>saved.checks.push(saved.checks[0]),saved=>saved.checks[0].rawOutput='PRIVATE_OUTPUT',saved=>saved.checks[0].provider.apiKey='PRIVATE_KEY',saved=>saved.checks[0].status='invented']){const malformed=structuredClone(good);change(malformed);const text=JSON.stringify(malformed);await writeFile(f.filename,text);await assert.rejects(open(),{code:'provider_checks_unavailable'});assert.equal(await readFile(f.filename,'utf8'),text);}
  const oversized=' '.repeat(1024*1024+1);await writeFile(f.filename,oversized);await assert.rejects(open(),{code:'provider_checks_unavailable'});assert.equal((await readFile(f.filename)).length,oversized.length);await rm(f.filename);await mkdir(f.filename);await assert.rejects(open(),{code:'provider_checks_unavailable'});await rm(f.filename,{recursive:true});await writeFile(f.filename,JSON.stringify(good));
});

test('zero injected clock produces actual epoch timestamps rather than an unrelated fallback year',async t=>{
  const f=await fixture(t,{now:()=>0}),input=f.input();const result=await f.service.start(input);assert.equal(result.check.createdAt,'1970-01-01T00:00:00.000Z');const completed=await terminal(f.service,input.id);assert.ok(completed.updatedAt.startsWith('1970-01-01T00:00:00.'));assert.equal(f.calls.length,1);
});
