import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createSharedServer} from '../server/shared-server.mjs';
import {createProductivityStore} from '../server/productivity-store.mjs';
import {createProductivityTools} from '../server/productivity-tools.mjs';
import {loadCapabilities} from '../server/capability-registry.mjs';

const ROOT=path.resolve(import.meta.dirname,'..'),BASE='/api/assistant',OWNER='local-workspace';
const hash=value=>createHash('sha256').update(value).digest('hex');
const ORIGINAL='Remember my calculation, then multiply 6 by 7 using the missing action.';
const SPEC='Implement a general integer multiplication capability; preserve zeros, negative values and actual receipts.';
const NOTE={title:'Original calculation',text:'Compute 6 times 7 once.'};
const stopped=()=>Object.assign(new Error('Synthetic model stopped.'),{name:'AbortError'});
const failed=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const tool=(id,name,args)=>({id,name,arguments:args});
async function until(callback,label){const deadline=Date.now()+7000;for(;;){const value=await callback();if(value)return value;assert.ok(Date.now()<deadline,label||'Synthetic integration did not settle.');await new Promise(resolve=>setTimeout(resolve,15));}}

async function fixture(t,{replyMode='actual',project=false,brokerNote=false,buildBatch,loadedInitially=false}={}){
  const temporary=await mkdtemp(path.join(tmpdir(),'companion-continuation-integration-')),dataDirectory=path.join(temporary,'private'),sourceRoot=path.join(temporary,'source');
  const entry={id:'multiply-value',title:'Multiply values',module:'./multiply-value.mjs',version:1,tool:{name:'cap_multiply_value',description:'Multiply two integer values.',parameters:{type:'object',properties:{left:{type:'integer'},right:{type:'integer'}},required:['left','right'],additionalProperties:false}},workflowAllowed:true,effectPolicy:brokerNote?'workspace':'pure',acceptance:[{name:'Exact product',arguments:{left:6,right:7},expected:{product:42},...(brokerNote?{tools:[{name:'save_note',arguments:NOTE,result:{note:{id:randomUUID(),...NOTE}}}]}:{})}]};
  const moduleText=brokerNote?'export async function execute(args,ctx){await ctx.runTool("save_note",'+JSON.stringify(NOTE)+');return {product:args.left*args.right};}':'export function execute(args){return {product:args.left*args.right};}';
  const moduleFile=path.join(sourceRoot,'server/capabilities/multiply-value.mjs');await mkdir(path.dirname(moduleFile),{recursive:true});await mkdir(dataDirectory);
  await writeFile(moduleFile,moduleText);await writeFile(path.join(sourceRoot,'server/capabilities/manifest.json'),JSON.stringify({version:1,capabilities:[entry]}));
  const capabilities=await loadCapabilities({root:sourceRoot}),pin=capabilities[0],calls=[],builds=new Map(),buildCalls=[],apps=[],stores=[],blockers=new Map();
  let app,store,services,origin,loaded=loadedInitially,readinessHook=null,providerHook=null,allowProject=true,validationHook=null,originalReplyHook=null;
  let runtime={managed:true,restarting:false,hostRestartAvailable:true,hostPid:100,workerPid:101,supervisorPid:99,hostInstanceId:randomUUID(),workerInstanceId:randomUUID(),supervisorInstanceId:randomUUID()};
  const descriptor={id:'synthetic',type:'codex',label:'Synthetic ready provider',model:'configured',ready:true,hasKey:false};
  const binding={projectId:randomUUID(),grantEpoch:3},listeners=new Set();
  const projectFiles={async validateBinding(value){if(validationHook)await validationHook(value);if(!allowProject||value.projectId!==binding.projectId||value.grantEpoch!==binding.grantEpoch)throw failed('project_grant_changed','The original synthetic project is no longer granted.');return{...binding,label:'Synthetic selected project'};},onRevoke(callback){listeners.add(callback);return()=>listeners.delete(callback);},async close(){listeners.clear();}};
  const builder={
    async request(){throw new Error('A linked foreground request must use the stable internal builder admission.');},
    async requestLinked(input,owner,identity){assert.equal(owner,OWNER);buildCalls.push({input:structuredClone(input),identity:structuredClone(identity)});let saved=builds.get(identity.id);if(!saved){saved={id:identity.id,status:'queued',prompt:input.prompt,providerId:input.providerId,autoApply:input.autoApply,summary:'Synthetic callable multiplication',files:[{path:'server/capabilities/multiply-value.mjs',afterHash:hash(moduleText),protected:true}],verification:{passed:true,checks:[]},events:[],reviewRequired:true,createdAt:new Date().toISOString()};builds.set(saved.id,saved);}return structuredClone(saved);},
    async get(id,owner){assert.equal(owner,OWNER);const saved=builds.get(id);if(!saved)throw failed('feature_not_found','Synthetic build not found.',404);return structuredClone(saved);},
    async list(){return[...builds.values()].map(value=>structuredClone(value));},
    async readinessEvidence(id){if(readinessHook)await readinessHook();const saved=builds.get(id);if(!saved)throw failed('feature_not_found','Synthetic build not found.',404);const actual=hash(await readFile(moduleFile)),current=await loadCapabilities({root:sourceRoot});return{job:{id,status:saved.status,verificationPassed:true,files:saved.files.map(({path,afterHash})=>({path,afterHash}))},sourceRevision:hash(actual+JSON.stringify(current.map(item=>item.hash))),sourceStable:true,files:saved.files.map(({path,afterHash})=>({path,afterHash,currentHash:actual})),requiredCapabilities:[{name:pin.tool.name,id:pin.id,version:pin.version,hash:pin.hash,current:current.some(item=>item.hash===pin.hash)}]};},
    async apply(id){builds.get(id).status='applied';return this.get(id,OWNER);},async cancel(id){builds.get(id).status='cancelled';return this.get(id,OWNER);},
    async stopPending(){for(const job of builds.values())if(['queued','generating','validating'].includes(job.status))job.status='cancelled';return{stopped:true};},async close(){},
  };
  const router={async getStatus(){if(providerHook)await providerHook();return{defaultProviderId:descriptor.id,providers:[{...descriptor}]};},async complete(input){
    const captured={...input,messages:structuredClone(input.messages)};calls.push(captured);
    const message=input.messages.filter(item=>item.role==='user').at(-1)?.content||'',continuing=input.system.includes('This is the human-requested follow-through');
    if(message.startsWith('BLOCK '))return new Promise((resolve,reject)=>{blockers.set(message,{resolve,reject});if(input.signal.aborted)return reject(stopped());input.signal.addEventListener('abort',()=>reject(stopped()),{once:true});});
    if(!continuing){if(input.messages.at(-1)?.role==='tool'){if(originalReplyHook)await originalReplyHook(input);return{text:'The build is queued. The multiplication has not happened.',toolCalls:[]};}return{text:'',toolCalls:[tool('remember_original','save_note',NOTE),tool('build_missing','build_feature',{prompt:SPEC}),...(buildBatch?[tool('second_build_call','build_feature',{prompt:buildBatch==='same'?SPEC:'A different unrequested build specification.'})]:[])]};}
    if(input.messages.at(-1)?.role==='tool')return{text:'The installed action computed 42.',toolCalls:[]};
    if(replyMode==='fabricated')return{text:'I computed 42 without using a tool.',toolCalls:[]};
    const requested=replyMode==='forbidden'?[tool('forbidden_build','build_feature',{prompt:'Must not recursively build.'}),tool('forbidden_work','manage_work',{action:'start',prompt:'Must not recursively delegate.'})]:[];
    return{text:'',toolCalls:[...requested,...(!brokerNote?[tool('duplicate_original_note','save_note',NOTE)]:[]),tool('actual_product','run_capability',{name:pin.tool.name,arguments:{left:6,right:7}})]};
  }};
  const legacy={getStatus:async()=>({reasoningReady:false,transcriptionReady:false}),ask:async()=>({text:'Unused.'}),transcribe:async()=>({text:'Unused.'}),cancel(){},cancelScope(){}};
  async function open(){store=await createProductivityStore({dataDirectory});stores.push(store);const tools=createProductivityTools({store,builder,root:sourceRoot,capabilities:loaded?capabilities:[],...(project?{projectFiles}:{})});services={store,router,builder,tools,enableContinuations:true,runtimeStatus:()=>({...runtime}),...(project?{projectFiles}:{})};app=await createSharedServer({dbPath:path.join(dataDirectory,'room.sqlite'),port:0,root:ROOT,assistantProvider:legacy,assistantOptions:{createProductivityRuntime:async()=>services}});apps.push(app);origin=new URL((await app.listen()).url).origin;}
  await open();t.after(async()=>{for(const value of apps)await value.close();for(const value of stores)value.close();assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep+'companion-continuation-integration-'));await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:25});});
  async function request(method,route,body,user,headers={}){const response=await fetch(origin+BASE+route,{method,headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrfToken}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'});return{status:response.status,value:await response.json(),headers:response.headers};}
  async function session(){const response=await request('GET','/session');assert.equal(response.status,200);return{cookie:response.headers.get('set-cookie').split(';')[0],csrfToken:response.value.csrfToken};}
  async function begin(user){const conversationId=randomUUID(),created=await request('POST','/conversations',{id:conversationId},user);assert.equal(created.status,200,JSON.stringify(created.value));const body={id:'original_'+randomUUID(),message:ORIGINAL,providerId:descriptor.id,conversationId,expectedRevision:0,...(project?{project:binding}:{})},result=await request('POST','/chat',body,user);assert.equal(result.status,200,JSON.stringify(result.value));const action=result.value.actions.find(action=>action.tool==='build_feature');assert.ok(action?.result.continuation,JSON.stringify(result.value));return{body,result,link:action.result.continuation};}
  async function reopen({load=true}={}){await app.close();loaded=load;runtime={...runtime,hostPid:runtime.hostPid+10,workerPid:runtime.workerPid+10,hostInstanceId:randomUUID(),workerInstanceId:randomUUID()};await open();return session();}
  async function getLink(user,id){const result=await request('GET','/continuations/'+id,undefined,user);assert.equal(result.status,200,JSON.stringify(result.value));return result.value.continuation;}
  async function waitJob(user,id,status){return until(async()=>{const value=await request('GET','/work/'+id,undefined,user);assert.equal(value.status,200,JSON.stringify(value.value));return value.value.job.status===status?value.value.job:false;},'Work never reached '+status);}
  return{request,session,begin,reopen,getLink,waitJob,calls,builds,buildCalls,blockers,binding,moduleFile,descriptor,get services(){return services;},get store(){return store;},setReadinessHook:hook=>{readinessHook=hook;},setProviderHook:hook=>{providerHook=hook;},setValidationHook:hook=>{validationHook=hook;},setOriginalReplyHook:hook=>{originalReplyHook=hook;},advanceRuntime(){runtime={...runtime,hostPid:runtime.hostPid+10,workerPid:runtime.workerPid+10,hostInstanceId:randomUUID(),workerInstanceId:randomUUID()};},revoke:async()=>{allowProject=false;await Promise.all([...listeners].map(callback=>callback(binding)));}};
}

test('a fast applied capability waits for the original reply receipt without permanently blocking early Continue',async t=>{
  const f=await fixture(t,{loadedInitially:true}),user=await f.session(),conversationId=randomUUID();
  assert.equal((await f.request('POST','/conversations',{id:conversationId},user)).status,200);
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});f.setOriginalReplyHook(async()=>{enter();await gate;});
  const body={id:'original_'+randomUUID(),message:ORIGINAL,providerId:'synthetic',conversationId,expectedRevision:0},pending=f.request('POST','/chat',body,user);void pending.catch(()=>{});
  let link;
  try{
    await entered;assert.equal(f.builds.size,1);const build=[...f.builds.values()][0];build.status='applied';f.advanceRuntime();
    const page=await f.request('GET','/continuations',undefined,user);assert.equal(page.status,200);link=page.value.continuations[0];
    assert.equal(link.status,'waiting_for_runtime');assert.equal(link.readiness.ready,false);assert.match(link.readiness.reason,/original request is still finishing/i);
    assert.equal((await f.request('POST',`/continuations/${link.id}/continue`,{},user)).status,409);
    assert.equal((await f.getLink(user,link.id)).status,'waiting_for_runtime');assert.equal((await f.request('GET','/work',undefined,user)).value.total,0);
  }finally{release();}
  assert.equal((await pending).status,200);f.setOriginalReplyHook(null);link=await f.getLink(user,link.id);
  assert.equal(link.status,'ready');assert.equal(link.readiness.ready,true);assert.equal((await f.request('POST',`/continuations/${link.id}/continue`,{},user)).status,200);
  const job=await f.waitJob(user,link.workId,'completed');assert.equal(job.outcome.actions.find(action=>action.result?.capability).result.value.product,42);assert.equal(f.store.snapshot().notes.length,1);assert.equal((await f.getLink(user,link.id)).status,'completed');
});

test('HTTP follow-through retains exact original intent, stable identities and actual new-capability receipts without repeating prior effects',async t=>{
  const f=await fixture(t),user=await f.session(),first=await f.begin(user),count=f.calls.length;
  assert.equal((await f.request('POST','/chat',first.body,user)).status,200);assert.equal(f.calls.length,count);assert.equal(f.buildCalls.length,1);assert.equal(f.store.snapshot().notes.length,1);
  let link=await f.getLink(user,first.link.id);assert.equal(link.originalRequest,ORIGINAL);assert.equal(link.buildSpec,SPEC);assert.notEqual(link.originalRequest,link.buildSpec);assert.equal(link.buildId,first.link.buildId);assert.equal(link.workId,first.link.workId);
  assert.equal((await f.request('POST',`/continuations/${link.id}/continue`,{},user)).status,409);
  f.builds.get(link.buildId).status='applied';let next=await f.reopen({load:false});link=await f.getLink(next,link.id);assert.equal(link.readiness.ready,false);assert.equal((await f.request('POST',`/continuations/${link.id}/continue`,{},next)).status,409);
  next=await f.reopen();link=await f.getLink(next,link.id);assert.equal(link.readiness.ready,true);const accepted=await f.request('POST',`/continuations/${link.id}/continue`,{},next);assert.ok([200,202].includes(accepted.status),JSON.stringify(accepted.value));
  const job=await f.waitJob(next,link.workId,'completed');assert.equal(job.prompt,ORIGINAL);assert.equal(job.continuation.id,link.id);assert.equal(f.store.snapshot().notes.length,1);
  const capAction=job.outcome.actions.find(action=>action.result?.capability);assert.equal(capAction.status,'completed');assert.equal(capAction.result.value.product,42);assert.equal(capAction.result.capability.name,'cap_multiply_value');assert.ok(job.outcome.actions.some(action=>action.result.continuationReuse));
  link=await f.getLink(next,link.id);assert.equal(link.status,'completed');const finishedCalls=f.calls.length;await f.request('POST',`/continuations/${link.id}/continue`,{},next);assert.equal(f.calls.length,finishedCalls);assert.equal(f.buildCalls.length,1);assert.equal(f.store.snapshot().notes.length,1);
  const model=f.calls.find(call=>call.system.includes('This is the human-requested follow-through'));assert.equal(model.messages.filter(message=>message.role==='user').at(-1).content,ORIGINAL);assert.ok(!model.tools.some(tool=>['build_feature','manage_work'].includes(tool.name)));
  f.descriptor.ready=false;await writeFile(f.moduleFile,'export function execute(){return {product:0};}');next=await f.reopen();
  assert.equal((await f.getLink(next,link.id)).status,'completed');assert.equal((await f.request('POST',`/continuations/${link.id}/continue`,{},next)).value.continuation.status,'completed');
  assert.equal((await f.request('POST','/chat',first.body,next)).status,200);assert.equal(f.calls.length,finishedCalls);assert.equal(f.buildCalls.length,1);assert.equal(f.store.snapshot().notes.length,1);
});

test('a capability broker also reuses the exact successful original workspace effect',async t=>{
  const f=await fixture(t,{brokerNote:true}),user=await f.session(),first=await f.begin(user);f.builds.get(first.link.buildId).status='applied';const next=await f.reopen();
  assert.ok([200,202].includes((await f.request('POST',`/continuations/${first.link.id}/continue`,{},next)).status));const job=await f.waitJob(next,first.link.workId,'completed');
  const capability=job.outcome.actions.find(action=>action.result?.capability);assert.equal(capability.result.value.product,42);assert.equal(f.store.snapshot().notes.length,1);assert.equal(capability.result.hostActions.length,1);assert.equal(capability.result.hostActions[0].result.continuationReuse.requestId,first.body.id);
});

test('multiple model build calls cannot reserve two follow-throughs for one original request',async t=>{
  for(const buildBatch of ['same','different'])await t.test(buildBatch,async t=>{
    const f=await fixture(t,{buildBatch}),user=await f.session(),first=await f.begin(user),page=await f.request('GET','/continuations',undefined,user);
    assert.equal(page.status,200);assert.equal(page.value.total,1);assert.equal(f.builds.size,1);assert.equal(f.buildCalls.length,1);
    const actions=first.result.value.actions.filter(action=>action.tool==='build_feature');assert.equal(actions.length,2);
    if(buildBatch==='same')assert.equal(actions[1].result.continuation.id,first.link.id);else assert.ok(actions[1].result.error);
  });
});

test('continuation requires a new matching capability receipt and rejects recursively fabricated build/delegation calls',async t=>{
  for(const replyMode of ['fabricated','forbidden'])await t.test(replyMode,async t=>{
    const f=await fixture(t,{replyMode}),user=await f.session(),first=await f.begin(user);f.builds.get(first.link.buildId).status='applied';const next=await f.reopen();
    const accepted=await f.request('POST',`/continuations/${first.link.id}/continue`,{},next);assert.ok([200,202].includes(accepted.status),JSON.stringify(accepted.value));
    const job=await f.waitJob(next,first.link.workId,replyMode==='fabricated'?'failed':'completed');assert.equal(f.buildCalls.length,1);assert.equal((await f.request('GET','/work',undefined,next)).value.total,1);
    if(replyMode==='fabricated'){assert.equal(job.outcome.error.code,'continuation_result_unproven');assert.equal((await f.getLink(next,first.link.id)).status,'failed');}
    else{assert.ok(job.outcome.actions.some(action=>action.result.code==='continuation_build_forbidden'));assert.ok(job.outcome.actions.some(action=>action.result.code==='delegation_forbidden'));}
  });
});

test('source, provider and project changes block acceptance instead of silently retargeting the original goal',async t=>{
  for(const changed of ['source','provider','project'])await t.test(changed,async t=>{
    const f=await fixture(t,{project:changed==='project'}),user=await f.session(),first=await f.begin(user);f.builds.get(first.link.buildId).status='applied';const next=await f.reopen();
    assert.equal((await f.getLink(next,first.link.id)).readiness.ready,true);
    if(changed==='source')await writeFile(f.moduleFile,'export function execute(){return {product:0};}');else if(changed==='provider')f.descriptor.model='different-model';else await f.revoke();
    const result=await f.request('POST',`/continuations/${first.link.id}/continue`,{},next);assert.ok([200,409,499].includes(result.status),JSON.stringify(result.value));if(result.status===200)assert.equal(result.value.continuation.status,'cancelled');assert.equal((await f.request('GET','/work',undefined,next)).value.total,0);assert.equal(f.store.snapshot().notes.length,1);
  });
});

test('human continuation routes enforce authentication, Origin, CSRF and ID-only bodies',async t=>{
  const f=await fixture(t),user=await f.session(),first=await f.begin(user),route=`/continuations/${first.link.id}/continue`;
  assert.equal((await f.request('GET','/continuations')).status,401);assert.equal((await f.request('POST',route,{})).status,401);
  assert.equal((await f.request('POST',route,{},user,{Origin:'https://foreign.invalid'})).status,403);assert.equal((await f.request('POST',route,{},user,{'X-CSRF-Token':'wrong'})).status,403);
  for(const body of [{prompt:'New unauthorized goal'},{project:{projectId:randomUUID(),grantEpoch:1}},{providerId:'other'}])assert.equal((await f.request('POST',route,body,user)).status,400);
  assert.equal((await f.request('GET','/work',undefined,user)).value.total,0);
});

test('explicit cancel and global Stop prevent late continuation acceptance while readiness is awaited',async t=>{
  for(const global of [false,true])await t.test(global?'global Stop':'selected cancel',async t=>{
    const f=await fixture(t),user=await f.session(),first=await f.begin(user);f.builds.get(first.link.buildId).status='applied';const next=await f.reopen();
    let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});f.setReadinessHook(async()=>{enter();await gate;});
    const pending=f.request('POST',`/continuations/${first.link.id}/continue`,{},next);await entered;let cancelled;try{cancelled=await f.request('POST',global?'/stop':`/continuations/${first.link.id}/cancel`,{},next);}finally{release();}const result=await pending;assert.equal(cancelled.status,200,JSON.stringify(cancelled.value));assert.ok([409,499].includes(result.status),JSON.stringify(result.value));f.setReadinessHook(null);
    assert.equal((await f.getLink(next,first.link.id)).status,'cancelled');assert.equal((await f.request('GET','/work',undefined,next)).value.total,0);
  });
});

test('accepted continuation metadata never becomes unrestricted Work when its intent ledger is unavailable',async t=>{
  const f=await fixture(t),user=await f.session(),first=await f.begin(user);f.builds.get(first.link.buildId).status='applied';const next=await f.reopen();
  const blockers=[randomUUID(),randomUUID()];for(let index=0;index<2;index++)assert.equal((await f.request('POST','/work',{id:blockers[index],prompt:'BLOCK '+index,providerId:'synthetic'},next)).status,202);
  await until(()=>f.blockers.size===2,'Both synthetic queue blockers should run.');const accepted=await f.request('POST',`/continuations/${first.link.id}/continue`,{},next);assert.ok([200,202].includes(accepted.status),JSON.stringify(accepted.value));
  assert.equal(f.services.store.getWorkJob(first.link.workId).status,'queued');const calls=f.calls.length;f.services.continuations.prepareWork=async()=>{throw failed('continuation_unavailable','The retained intent ledger is temporarily unavailable.',503);};
  for(const blocker of f.blockers.values())blocker.resolve({text:'Finished synthetic blocker.',toolCalls:[]});
  const job=await f.waitJob(next,first.link.workId,'failed');assert.equal(job.continuation.id,first.link.id);assert.equal(f.calls.length,calls);assert.equal(f.store.snapshot().notes.length,1);assert.equal(f.buildCalls.length,1);
});

test('a queued continuation rechecks installed source before model work and keeps its one retained attempt',async t=>{
  const f=await fixture(t),user=await f.session(),first=await f.begin(user);f.builds.get(first.link.buildId).status='applied';const next=await f.reopen();
  for(let index=0;index<2;index++)assert.equal((await f.request('POST','/work',{id:randomUUID(),prompt:'BLOCK '+index,providerId:'synthetic'},next)).status,202);
  await until(()=>f.blockers.size===2,'Both synthetic blockers should hold the Work slots.');
  assert.ok([200,202].includes((await f.request('POST',`/continuations/${first.link.id}/continue`,{},next)).status));assert.equal(f.services.store.getWorkJob(first.link.workId).status,'queued');
  const calls=f.calls.length;await writeFile(f.moduleFile,'export function execute(){return {product:0};}');for(const blocker of f.blockers.values())blocker.resolve({text:'Finished synthetic blocker.',toolCalls:[]});
  await f.waitJob(next,first.link.workId,'failed');assert.equal(f.calls.length,calls);assert.equal((await f.getLink(next,first.link.id)).status,'failed');
  await f.request('POST',`/continuations/${first.link.id}/continue`,{},next);assert.equal(f.calls.length,calls);assert.equal((await f.request('GET','/work',undefined,next)).value.total,3);assert.equal(f.store.snapshot().notes.length,1);
});
