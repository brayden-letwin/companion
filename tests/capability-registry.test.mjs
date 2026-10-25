import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { loadCapabilities, validateCapabilitySchema, validateToolArguments, builtinCatalog } from '../server/capability-registry.mjs';
import { createProductivityStore } from '../server/productivity-store.mjs';
import { createProductivityTools } from '../server/productivity-tools.mjs';

const schema={type:'object',properties:{text:{type:'string',minLength:1,maxLength:100}},required:['text'],additionalProperties:false};
const entry=(extra={})=>({id:'word-count',title:'Word count',module:'./word-count.mjs',version:1,tool:{name:'cap_word_count',description:'Count words in supplied text.',parameters:structuredClone(schema)},effectPolicy:'pure',workflowAllowed:true,acceptance:[{name:'Counts words',arguments:{text:'one two'},expected:{words:2}}],...extra});
async function fixture(t,record=entry(),code='export async function execute(args){return {words:args.text.trim().split(/\\s+/).length};}'){
  const closers=[],root=await mkdtemp(path.join(tmpdir(),'companion-registry-')),directory=path.join(root,'server','capabilities');await mkdir(directory,{recursive:true});
  const save=async value=>writeFile(path.join(directory,'manifest.json'),JSON.stringify({version:1,capabilities:value}));await save([record]);await writeFile(path.join(directory,'word-count.mjs'),code);
  t.after(async()=>{for(const close of closers)close();assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:30});});
  return{root,directory,save,track:close=>closers.push(close)};
}

test('loader never imports registered code and pins both exact source and normalized metadata',async t=>{
  const f=await fixture(t,entry(),'throw new Error("MUST_NOT_IMPORT"); export async function execute(){return{};}');
  const [loaded]=await loadCapabilities(f);assert.equal(loaded.tool.name,'cap_word_count');assert.equal(loaded.moduleHash,createHash('sha256').update(await readFile(loaded.modulePath)).digest('hex'));
  const first=loaded.hash;await f.save([entry({title:'Renamed count'})]);assert.notEqual((await loadCapabilities(f))[0].hash,first);
  await f.save([entry()]);await writeFile(loaded.modulePath,'export async function execute(){return {changed:true};}');assert.notEqual((await loadCapabilities(f))[0].hash,first);
  assert.equal((await loadCapabilities({root:await mkdtemp(path.join(f.root,'empty-'))})).length,0);
});

test('manifest rejects unsafe paths, duplicate/shadow names, unknown fields and malformed concrete acceptance cases',async t=>{
  const f=await fixture(t);
  for(const record of [entry({module:'../outside.mjs'}),entry({tool:{...entry().tool,name:'create_task'}}),entry({shell:'not allowed'}),entry({version:0}),entry({acceptance:[]}),entry({acceptance:[{name:'Wrong args',arguments:{text:2},expected:{}}]}),entry({acceptance:[{name:'No fabricated approval',arguments:{text:'one'},expected:{},tools:[{name:'desktop_approve',arguments:{},result:{}}]}]})]){await f.save([record]);await assert.rejects(loadCapabilities(f));}
  await f.save([entry(),entry()]);await assert.rejects(loadCapabilities(f),{code:'invalid_capability'});
  await writeFile(path.join(f.directory,'manifest.json'),'x'.repeat(256*1024+1));await assert.rejects(loadCapabilities(f),{code:'invalid_capability'});
});

test('strict recursive schemas enforce nested types, enums, bounds and reject unsupported/prototype keys',()=>{
  const parameters={type:'object',properties:{items:{type:'array',minItems:1,maxItems:2,items:{type:'object',properties:{mode:{type:'string',enum:['a','b']},count:{type:'integer',minimum:1,maximum:3}},required:['mode','count'],additionalProperties:false}}},required:['items'],additionalProperties:false};
  validateCapabilitySchema(parameters);const definition={name:'fixture',parameters};assert.deepEqual(validateToolArguments(definition,{items:[{mode:'a',count:2}]}),{items:[{mode:'a',count:2}]});
  for(const args of [{items:[]},{items:[{mode:'c',count:2}]},{items:[{mode:'a',count:1.5}]},{items:[{mode:'a',count:4}]},{items:[{mode:'a',count:2,extra:true}]}])assert.throws(()=>validateToolArguments(definition,args),{code:'invalid_tool'});
  assert.throws(()=>validateToolArguments(definition,JSON.parse('{"items":[],"__proto__":{}}')),{code:'invalid_tool'});
  for(const invalid of [{...schema,$ref:'#/anything'},{...schema,additionalProperties:true},{...schema,properties:{value:{type:'array',items:{type:'string'}}}},{...schema,properties:{constructor:{type:'string'}}}])assert.throws(()=>validateCapabilitySchema(invalid),{code:'invalid_capability'});
});

test('catalog stays public and provider definitions stay bounded while the actual guarded executor serves direct and gateway calls',async t=>{
  const f=await fixture(t),capabilities=await loadCapabilities(f),store=await createProductivityStore({dataDirectory:path.join(f.root,'private')});f.track(()=>store.close());
  const tools=createProductivityTools({store,root:f.root,capabilities});assert.equal(tools.definitions.length,24);assert.equal(tools.definitions.some(item=>item.name==='cap_word_count'),false);
  const publicData=JSON.stringify(tools.catalog());assert.ok(!publicData.includes('modulePath'));assert.ok(!publicData.includes('"acceptance":'));assert.ok(!publicData.includes(f.root));
  const context={requestId:'count-original',callId:'one'};const first=await tools.execute('cap_word_count',{text:'one two three'},context);assert.equal(first.value.words,3);assert.deepEqual(first.hostActions,[]);
  const gateway=await tools.execute('run_capability',{name:'cap_word_count',arguments:{text:'one two three'}},context);assert.equal(gateway.value.words,3);assert.equal(gateway.replayed,true);
  await assert.rejects(tools.execute('run_capability',{name:'create_task',arguments:{title:'No gateway escape'}}),{code:'invalid_tool'});
  assert.equal((await tools.execute('list_capabilities')).capabilities[0].name,'cap_word_count');
  assert.equal(builtinCatalog().find(item=>item.name==='read_note').workflowAllowed,true);
});

test('actual workspace capability brokers real effects once and preserves terminal replay after source replacement and restart',async t=>{
  const record=entry({effectPolicy:'workspace',tool:{...entry().tool,description:'Save the supplied requested note.'},acceptance:[{name:'Saves supplied note',arguments:{text:'one'},expected:{saved:true},tools:[{name:'save_note',arguments:{text:'one'},result:{note:{id:'fixture'}}}]}]});
  const f=await fixture(t,record,'export async function execute(args,ctx){const result=await ctx.runTool("save_note",{text:args.text});return {saved:true,noteId:result.note.id};}'),capabilities=await loadCapabilities(f),dataDirectory=path.join(f.root,'private');let store=await createProductivityStore({dataDirectory});f.track(()=>store.close());
  let tools=createProductivityTools({store,root:f.root,capabilities});const context={requestId:'effect-original',callId:'one'},first=await tools.execute('cap_word_count',{text:'A real synthetic note.'},context);
  assert.equal(first.hostActions.length,1);assert.equal(first.hostActions[0].result.note.id,first.value.noteId);assert.equal(store.snapshot().notes.length,1);
  store.close();store=await createProductivityStore({dataDirectory});tools=createProductivityTools({store,root:f.root,capabilities:[]});
  const replay=await tools.execute('cap_word_count',{text:'A real synthetic note.'},context);assert.equal(replay.value.noteId,first.value.noteId);assert.equal(store.snapshot().notes.length,1);
  await assert.rejects(tools.execute('cap_word_count',{text:'Different request.'},context),{code:'request_conflict'});
  await assert.rejects(tools.execute('cap_word_count',{text:'A new request.'},{requestId:'new',callId:'one'}),{code:'capability_unavailable'});
});

test('capability wrappers retain only actual broker receipts, never child-supplied claims, and failed effects replay without rerunning',async t=>{
  const f=await fixture(t,entry({effectPolicy:'workspace'})),capabilities=await loadCapabilities(f),store=await createProductivityStore({dataDirectory:path.join(f.root,'private')});f.track(()=>store.close());let runs=0;
  const tools=createProductivityTools({store,root:f.root,capabilities,executeCapability:async({runTool})=>{runs++;await runTool('create_task',{title:'Retained actual task'});throw Object.assign(new Error('Synthetic later failure'),{code:'synthetic_failure',hostActions:[{status:'completed',tool:'desktop_approve'}]});}});
  const context={requestId:'failed-capability',callId:'one'};
  for(let index=0;index<2;index++)await assert.rejects(tools.execute('cap_word_count',{text:'one'},context),error=>error.code==='synthetic_failure'&&error.hostActions.length===1&&error.hostActions[0].tool==='create_task'&&error.hostActions[0].result.task.id===store.snapshot().tasks[0].id);
  assert.equal(runs,1);assert.equal(store.snapshot().tasks.length,1);
  const unavailable=createProductivityTools({store,capabilityStatus:{ready:false,unavailableReason:'Synthetic registry failure'}});assert.equal((await unavailable.execute('list_capabilities')).unavailableReason,'Synthetic registry failure');
});

test('an actual guarded capability reads task sections and complete summaries through the new approved broker tools',async t=>{
  const fixtureTaskId=randomUUID(),parameters={type:'object',properties:{taskId:{type:'string',minLength:36,maxLength:36}},required:['taskId'],additionalProperties:false};
  const record=entry({title:'Actual task overview',effectPolicy:'workspace',tool:{name:'cap_word_count',description:'Read actual task counts and a requested detail section.',parameters},acceptance:[{name:'Uses approved task reads',arguments:{taskId:fixtureTaskId},expected:{totalTasks:2,openTasks:1,detailChars:15,hasFullEnd:true,hasMore:false,prototypeTotal:2},tools:[{name:'summarize_tasks',arguments:{},result:{totalTasks:2,openTasks:1,revision:7,projects:[{project:'__proto__',totalTasks:2}]}},{name:'read_task',arguments:{taskId:fixtureTaskId,offset:4000,limit:4000,expectedRevision:7},result:{task:{details:'FULL_DETAIL_END'},hasMore:false}}]}]});
  const code='export async function execute(args,ctx){const summary=await ctx.runTool("summarize_tasks",{});const detail=await ctx.runTool("read_task",{taskId:args.taskId,offset:4000,limit:4000,expectedRevision:summary.revision});return {totalTasks:summary.totalTasks,openTasks:summary.openTasks,detailChars:detail.task.details.length,hasFullEnd:detail.task.details.endsWith("FULL_DETAIL_END"),hasMore:detail.hasMore,prototypeTotal:summary.projects.find(project=>project.project==="__proto__")?.totalTasks||0};}';
  const f=await fixture(t,record,code),capabilities=await loadCapabilities(f),store=await createProductivityStore({dataDirectory:path.join(f.root,'private')});f.track(()=>store.close());let first;
  for(let index=0;index<105;index++){const operationId=randomUUID();store.apply({operationId,expectedRevision:store.snapshot().revision,type:'addTask',title:'Actual task '+index,details:index===0?'D'.repeat(5000)+'FULL_DETAIL_END':'Small detail',project:index%2===0?'__proto__':'constructor'});if(index===0)first=operationId;}
  const tools=createProductivityTools({store,root:f.root,capabilities}),before=store.snapshot(),result=await tools.execute('run_capability',{name:'cap_word_count',arguments:{taskId:first}},{requestId:'task-overview',callId:'one'});
  assert.deepEqual(result.value,{totalTasks:105,openTasks:105,detailChars:1015,hasFullEnd:true,hasMore:false,prototypeTotal:53});assert.deepEqual(result.hostActions.map(action=>action.tool),['summarize_tasks','read_task']);assert.ok(result.hostActions.every(action=>action.status==='completed'));assert.deepEqual(store.snapshot(),before);
  const replay=await tools.execute('cap_word_count',{taskId:first},{requestId:'task-overview',callId:'one'});assert.equal(replay.replayed,true);assert.deepEqual(replay.value,result.value);
});
