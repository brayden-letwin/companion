import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createModelRouter } from '../server/model-router.mjs';

const MARKER = 'COMPANION_CONNECTION_OK';
const json = value => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
const responseFor = (type, text=MARKER) => type==='openai'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}:type==='anthropic'?{stop_reason:'end_turn',content:[{type:'text',text}]}:type==='ollama'?{done:true,done_reason:'stop',message:{role:'assistant',content:text}}:{choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}]};
const config = type=>({id:'probe-'+type,type,label:'Synthetic '+type,model:'synthetic-model',...(type==='codex'?{}:{baseUrl:type==='ollama'?'http://127.0.0.1:11434':'https://synthetic.example/v1'}),...(['codex','ollama'].includes(type)?{}:{apiKey:'SYNTHETIC_PRIVATE_KEY'})});
async function fixture(t,options={}){const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-probe-'));t.after(async()=>{assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir())+path.sep+'companion-probe-'));await rm(dataDirectory,{recursive:true,force:true});});const router=await createModelRouter({dataDirectory,settingsOptions:{platform:'linux'},...options});return{router,dataDirectory};}
const revision=(router,id)=>router.getProviderConfigurations().find(entry=>entry.id===id).revision;
const turn = [{role:'user',content:'Synthetic independent normal turn.'}];
const tick = ()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<1000;i++){if(predicate())return;await tick();}throw Error('Synthetic operation did not start.');}

test('all HTTP adapters probe fixed synthetic text with small budgets, no tools and revision-only success',async t=>{
  for(const type of ['openai','anthropic','compatible','ollama']){
    const calls=[];const{router}=await fixture(t,{fetchImpl:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return json(responseFor(type));}});const entry=await router.configure(config(type)),expectedRevision=entry.revision;
    assert.deepEqual(await router.probeConnection({providerId:entry.id,expectedRevision}),{passed:true,providerId:entry.id,revision:expectedRevision});assert.equal(calls.length,1);const call=calls[0];assert.equal(call.init.method,'POST');assert.equal(call.init.redirect,'error');assert.ok(call.init.signal);assert.ok(!('tools'in call.body));assert.ok(!JSON.stringify(call.body).includes('SYNTHETIC_PRIVATE_KEY'));
    if(type==='openai'){assert.match(call.url,/\/responses$/);assert.equal(call.body.max_output_tokens,512);assert.equal(call.body.store,false);assert.equal(call.body.input.length,1);assert.equal(call.body.input[0].role,'user');assert.equal(call.body.input[0].content,'Reply with exactly '+MARKER+' and nothing else.');}
    else if(type==='anthropic'){assert.equal(call.body.max_tokens,512);assert.equal(call.init.headers['anthropic-version'],'2026-10-21');assert.equal(call.init.headers.Authorization,'Bearer SYNTHETIC_PRIVATE_KEY');assert.equal(call.body.messages.length,1);}
    else{assert.equal(call.body.messages.length,2);assert.equal(call.body.messages[0].role,'system');assert.equal(call.body.messages[1].role,'user');if(type==='ollama'){assert.equal(call.body.think,false);assert.equal(call.body.options.num_predict,512);}else assert.equal(call.body.max_tokens,512);}
  }
});

test('metadata reads, stale revisions, extra prompt fields and missing keys never make a connection request',async t=>{
  let requests=0,spawns=0;const{router}=await fixture(t,{fetchImpl:async()=>{requests++;throw Error('No request allowed.');},spawnImpl:()=>{spawns++;throw Error('No helper allowed.');}});const entry=await router.configure({...config('openai'),apiKey:''});
  assert.ok(router.getProviderConfigurations().length);assert.equal(requests,0);assert.equal(spawns,0);
  await assert.rejects(router.probeConnection({providerId:entry.id,expectedRevision:randomUUID()}),{code:'provider_changed'});
  await assert.rejects(router.probeConnection({providerId:entry.id,expectedRevision:entry.revision,messages:turn}),{code:'validation_error'});
  await assert.rejects(router.probeConnection({providerId:entry.id}),{code:'validation_error'});
  await assert.rejects(router.probeConnection({providerId:entry.id,expectedRevision:entry.revision}),{code:'provider_key_required'});assert.equal(requests,0);assert.equal(spawns,0);
});

test('Codex probes return only the exact connection identity and no generated text',async t=>{
  let starts=0;const spawnImpl=(_command,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{child.exitCode=137;queueMicrotask(()=>child.emit('close',137));};let input='';child.stdin=new Writable({write(chunk,_encoding,done){input+=chunk.toString();done();}});child.stdin.on('finish',()=>{starts++;assert.equal(args[0],'exec');assert.ok(!args.includes('--model'));assert.ok(!input.includes('Synthetic independent normal turn'));assert.ok(input.includes('fixed synthetic connection check'));assert.ok(!input.includes(options.cwd));child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:MARKER}})+'\n');child.stdout.write('{"type":"turn.completed"}\n');child.exitCode=0;child.emit('close',0);});return child;};
  const{router}=await fixture(t,{spawnImpl}),entry=router.getProviderConfigurations().find(value=>value.type==='codex'),result=await router.probeConnection({providerId:entry.id,expectedRevision:entry.revision});assert.deepEqual(result,{passed:true,providerId:entry.id,revision:entry.revision});assert.equal(starts,1);assert.ok(!JSON.stringify(result).includes(MARKER));
});

test('tool proposals, truncated completions, multiple answers, wrong markers and oversized data fail safely',async t=>{
  const cases=[
    ['openai',{status:'completed',output:[{type:'function_call',name:'save_note',arguments:'{}'}]},'invalid_provider_response'],
    ['openai',{status:'incomplete',output:[]},'incomplete_provider_response'],
    ['openai',{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:MARKER},{type:'output_text',text:MARKER}]}]},'invalid_provider_response'],
    ['anthropic',{stop_reason:'tool_use',content:[{type:'tool_use',name:'save_note'}]},'incomplete_provider_response'],
    ['anthropic',{stop_reason:'end_turn',content:[{type:'tool_use',name:'save_note'}]},'invalid_provider_response'],
    ['compatible',{choices:[{finish_reason:'stop',message:{role:'assistant',content:MARKER,tool_calls:[{}]}}]},'invalid_provider_response'],
    ['compatible',{choices:[{finish_reason:'length',message:{role:'assistant',content:MARKER}}]},'incomplete_provider_response'],
    ['ollama',{done:true,done_reason:'length',message:{role:'assistant',content:MARKER}},'incomplete_provider_response'],
    ['ollama',{done:true,message:{role:'assistant',content:'SYNTHETIC_PRIVATE_OUTPUT'}},'probe_response_mismatch'],
  ];
  for(const[type,response,code]of cases){const{router}=await fixture(t,{fetchImpl:async()=>json(response)}),entry=await router.configure(config(type));await assert.rejects(router.probeConnection({providerId:entry.id,expectedRevision:entry.revision}),error=>error.code===code&&!error.message.includes('SYNTHETIC_PRIVATE'));}
  for(const advertised of [false,true]){let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(32769)));},cancel(){cancelled=true;}});const{router}=await fixture(t,{fetchImpl:async()=>new Response(body,{headers:advertised?{'Content-Length':'32769'}:{}})}),entry=await router.configure(config('openai'));await assert.rejects(router.probeConnection({providerId:entry.id,expectedRevision:entry.revision}),{code:'provider_output_limit'});assert.equal(cancelled,true);}
});

test('credential/network failures never expose provider output, URL details or the private marker',async t=>{
  for(const failure of [new Response('SYNTHETIC_PRIVATE_DIAGNOSTIC',{status:401}),new Response('SYNTHETIC_PRIVATE_DIAGNOSTIC',{status:429}),new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC')]){const{router}=await fixture(t,{fetchImpl:async()=>{if(failure instanceof Error)throw failure;return failure;}}),entry=await router.configure(config('openai'));await assert.rejects(router.probeConnection({providerId:entry.id,expectedRevision:entry.revision}),error=>!error.message.includes('SYNTHETIC_PRIVATE')&&!error.message.includes(MARKER)&&['provider_credentials_rejected','provider_rate_limited','provider_unavailable'].includes(error.code));}
});

test('an old credential unlock snapshot cannot dispatch after concurrent configuration changes',async t=>{
  const firstRevision=randomUUID(),secondRevision=randomUUID();let currentRevision=firstRevision,release,entered=false,requests=0;
  const publicEntry=()=>({id:'synthetic',type:'openai',label:'Synthetic',model:'model',baseUrl:'https://synthetic.example/v1',revision:currentRevision,hasKey:true});
  const settings={list:()=>[publicEntry()],defaultProviderId:()=>null,get:async()=>{const old={...publicEntry(),apiKey:'SYNTHETIC_PRIVATE_OLD_KEY'};entered=true;await new Promise(resolve=>{release=resolve;});return old;}};
  const{router}=await fixture(t,{settings,fetchImpl:async()=>{requests++;return json(responseFor('openai'));}});const pending=router.probeConnection({providerId:'synthetic',expectedRevision:firstRevision});await until(()=>entered);const rejected=assert.rejects(pending,{code:'provider_changed'});currentRevision=secondRevision;release();await rejected;assert.equal(requests,0);
});

test('configuration changes and remove/re-add during a response cannot certify the new connection',async t=>{
  for(const remove of [false,true]){let release,entered=false;const{router}=await fixture(t,{fetchImpl:async()=>{entered=true;return new Promise(resolve=>{release=resolve;});}}),entry=await router.configure(config('openai')),pending=router.probeConnection({providerId:entry.id,expectedRevision:entry.revision});await until(()=>entered);const rejected=assert.rejects(pending,{code:'provider_changed'});if(remove)await router.remove(entry.id);const next=await router.configure(config('openai'));assert.notEqual(next.revision,entry.revision);release(json(responseFor('openai')));await rejected;}
});

test('connection checks share two model leases and interactive turns precede a queued check',async t=>{
  const pending=[];const{router}=await fixture(t,{fetchImpl:async(_url,init)=>new Promise(resolve=>pending.push({resolve,body:JSON.parse(init.body)}))}),entry=await router.configure(config('openai'));
  const first=router.complete({providerId:entry.id,messages:turn}),second=router.complete({providerId:entry.id,messages:turn});await until(()=>pending.length===2);
  const probe=router.probeConnection({providerId:entry.id,expectedRevision:entry.revision}),interactive=router.complete({providerId:entry.id,messages:turn});await tick();assert.equal(pending.length,2);
  pending[0].resolve(json(responseFor('openai','Normal one')));await first;await until(()=>pending.length===3);assert.equal(pending[2].body.max_output_tokens,8192);
  pending[2].resolve(json(responseFor('openai','Normal three')));await interactive;await until(()=>pending.length===4);assert.equal(pending[3].body.max_output_tokens,512);pending[3].resolve(json(responseFor('openai')));assert.equal((await probe).passed,true);pending[1].resolve(json(responseFor('openai','Normal two')));await second;
});

test('the fixed deadline includes waiting for a shared lease and cancellation ignores late response data',async t=>{
  const pending=[];const{router}=await fixture(t,{fetchImpl:async(_url,init)=>new Promise((resolve,reject)=>{pending.push({resolve});init.signal.addEventListener('abort',()=>reject(Error('SYNTHETIC_PRIVATE_ABORT')));})}),entry=await router.configure(config('openai'));t.mock.timers.enable({apis:['setTimeout']});
  const controllers=[new AbortController(),new AbortController()],normal=controllers.map(controller=>router.complete({providerId:entry.id,messages:turn,signal:controller.signal}));const normalRejected=normal.map(p=>assert.rejects(p,{name:'AbortError'}));await until(()=>pending.length===2);
  let stopping=0;const probe=router.probeConnection({providerId:entry.id,expectedRevision:entry.revision,onStopping(...args){assert.deepEqual(args,[]);stopping++;}}),rejected=assert.rejects(probe,{code:'provider_timeout'});t.mock.timers.tick(60000);await rejected;assert.equal(pending.length,2);assert.equal(stopping,1);controllers.forEach(controller=>controller.abort());await Promise.all(normalRejected);t.mock.timers.reset();
  const controller=new AbortController(),late=router.probeConnection({providerId:entry.id,expectedRevision:entry.revision,signal:controller.signal}),lateRejected=assert.rejects(late,{name:'AbortError'});await until(()=>pending.length===3);controller.abort();pending[2].resolve(json(responseFor('openai')));await lateRejected;
});

test('cancelled Codex checks keep their promises, private jobs and both leases until actual owned helpers close',async t=>{
  const children=[];const spawnImpl=(_command,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.pid=20000+children.length;child.cwd=options.cwd;child.kill=()=>true;child.stdin=new Writable({write(_chunk,_encoding,done){done();}});children.push(child);return child;};
  const{router,dataDirectory}=await fixture(t,{spawnImpl}),entry=router.getProviderConfigurations().find(x=>x.type==='codex'),controllers=[new AbortController(),new AbortController()];let settled=0,stopping=0;
  const probes=controllers.map(controller=>router.probeConnection({providerId:entry.id,expectedRevision:entry.revision,signal:controller.signal,onStopping(){stopping++;}}).finally(()=>{settled++;})),rejections=probes.map(p=>assert.rejects(p,{name:'AbortError'}));
  try{
    // This case owns real private directories: keep real timers for Windows
    // filesystem retries while waiting beyond the runner's 1.5s caller bound.
    await until(()=>children.length===2);controllers.forEach(controller=>controller.abort());await new Promise(resolve=>setTimeout(resolve,1550));assert.equal(settled,0);assert.equal(stopping,2);assert.equal((await readdir(dataDirectory)).filter(x=>x.startsWith('codex-job-')).length,2);
    const third=router.complete({providerId:entry.id,messages:turn});await tick();assert.equal(children.length,2);
    // Concurrent private-directory I/O can reverse spawn order. The first
    // child need not belong to probe[0]; wait for its actual result, not an
    // assumed probe index, then reconcile both original promises at the end.
    children[0].exitCode=137;children[0].emit('close',137);await until(()=>settled===1);await until(()=>children.length===3);children[2].stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fresh after confirmed closure.'}})+'\n');children[2].stdout.write('{"type":"turn.completed"}\n');children[2].exitCode=0;children[2].emit('close',0);assert.equal((await third).text,'Fresh after confirmed closure.');children[1].exitCode=137;children[1].emit('close',137);await Promise.all(rejections);assert.equal(settled,2);
  }finally{for(const child of children)if(child.exitCode===null){child.exitCode=137;child.emit('close',137);}await Promise.all(rejections);}
});
