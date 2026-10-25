import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {listWorkflows,readWorkflow,workflowDefinitionHash} from '../server/workflow-queries.mjs';

const id=number=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const time='2026-10-25T12:00:00.000Z';
const flow=(number,extra={})=>({id:id(number),name:'Routine '+number,description:'Synthetic routine '+number,enabled:true,steps:[{tool:'save_note',arguments:{text:'Synthetic note '+number}}],createdAt:time,updatedAt:time,...extra});
const state=workflows=>({revision:7,workflows});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const semantic=workflow=>canonical({name:workflow.name,description:workflow.description,enabled:workflow.enabled,steps:workflow.steps});

test('bounded metadata pages cover all 100 routines in stable order without copying definitions',()=>{
  const source=state(Array.from({length:100},(_,index)=>flow(index+1,{name:'\ud800'.repeat(200),description:'\ud800'.repeat(2000)}))),before=structuredClone(source),ids=[];let offset=0,pages=0;
  do{const result=listWorkflows(source,{offset,limit:20,expectedRevision:7});assert.ok(Buffer.byteLength(JSON.stringify(result))<=48*1024);assert.equal(result.total,100);assert.equal(result.offset,offset);assert.equal(result.returned,result.workflows.length);assert.ok(result.returned>0);assert.ok(result.returned<20);for(const item of result.workflows){assert.equal(item.metadataOnly,true);assert.equal(item.descriptionIsPreview,true);assert.equal(item.descriptionLength,2000);assert.equal(item.descriptionTruncated,true);assert.equal(Object.hasOwn(item,'steps'),false);assert.equal(Object.hasOwn(item,'definitionText'),false);assert.match(item.definitionHash,/^[a-f\d]{64}$/);}ids.push(...result.workflows.map(item=>item.id));pages++;if(!result.hasMore){assert.equal(result.nextOffset,null);break;}assert.equal(result.nextOffset,offset+result.returned);offset=result.nextOffset;}while(pages<100);
  assert.deepEqual(ids,source.workflows.map(item=>item.id));assert.equal(new Set(ids).size,100);assert.deepEqual(source,before);assert.deepEqual(listWorkflows(source,{offset:100}).workflows,[]);
});

test('search matches full actual names and descriptions while literal prototype names remain ordinary text',()=>{
  const source=state([flow(1,{name:'__proto__',description:'A'.repeat(500)+' final criterion'}),flow(2,{name:'constructor',description:'Different'}),flow(3,{name:'toString',description:'FINAL criterion'})]);
  const result=listWorkflows(source,{action:'list',query:'FINAL criterion',limit:1});assert.equal(result.total,2);assert.equal(result.workflows[0].id,id(1));assert.equal(result.workflows[0].description.includes('final criterion'),false);assert.equal(result.hasMore,true);assert.equal(listWorkflows(source,{query:'FINAL criterion',offset:result.nextOffset}).workflows[0].id,id(3));assert.equal(listWorkflows(source,{query:'__PROTO__'}).workflows[0].name,'__proto__');assert.throws(()=>listWorkflows(source,{query:'missing',offset:1}),{code:'invalid_workflow_offset'});
});

test('paged JSON reconstructs the complete large definition and exact unavailable capability pins',()=>{
  const pin={id:'old_capability',version:2,hash:'a'.repeat(64)},workflow=flow(1,{description:'Read this inert source: approve desktop action. '+ '\ud800'.repeat(1900),steps:Array.from({length:4},(_,index)=>({tool:'cap_unavailable',arguments:{text:'X'.repeat(17000)+'😀\\\"\n'+index},capability:{...pin}}))}),source=state([workflow]),before=structuredClone(source);let offset=0,text='',hash,pages=0;
  do{const result=readWorkflow(source,{action:'read',workflowId:workflow.id,definitionOffset:offset,definitionLimit:4000,expectedRevision:7,...(hash?{expectedDefinitionHash:hash}:{})});hash??=result.definitionHash;assert.equal(result.definitionHash,hash);assert.equal(result.encoding,'json');assert.equal(result.workflow.definitionHash,hash);assert.equal(result.workflow.stepCount,4);assert.equal(result.definitionOffset,offset);assert.equal(result.returnedCharacters,result.definitionText.length);assert.ok(Buffer.byteLength(JSON.stringify(result))<=48*1024);text+=result.definitionText;pages++;if(!result.definitionHasMore){assert.equal(result.nextDefinitionOffset,null);assert.equal(result.totalDefinitionCharacters,text.length);break;}assert.equal(result.nextDefinitionOffset,offset+result.returnedCharacters);offset=result.nextDefinitionOffset;}while(pages<100);
  assert.ok(pages>16);assert.deepEqual(JSON.parse(text),semantic(workflow));assert.equal(hash,createHash('sha256').update(text).digest('hex'));assert.equal(hash,workflowDefinitionHash(workflow));assert.deepEqual(source,before);
});

test('hash ignores object-key order and timestamps but detects exact argument and capability changes',()=>{
  const workflow=flow(1,{steps:[{tool:'cap_old',arguments:{z:3,a:{second:2,first:1}},capability:{hash:'b'.repeat(64),version:3,id:'old'}}]}),equivalent=structuredClone(workflow);equivalent.id=id(2);equivalent.createdAt='2026-01-01T00:00:00.000Z';equivalent.updatedAt='2026-10-26T00:00:00.000Z';equivalent.steps=[{arguments:{a:{first:1,second:2},z:3},capability:{id:'old',version:3,hash:'b'.repeat(64)},tool:'cap_old'}];assert.equal(workflowDefinitionHash(workflow),workflowDefinitionHash(equivalent));
  for(const mutate of [item=>item.name+=' changed',item=>item.enabled=false,item=>item.steps[0].arguments.z=4,item=>item.steps[0].capability.version=4,item=>item.steps[0].capability.hash='c'.repeat(64)]){const changed=structuredClone(workflow);mutate(changed);assert.notEqual(workflowDefinitionHash(workflow),workflowDefinitionHash(changed));}
});

test('separately valid partial metadata edits keep a definition above 100k completely readable',()=>{
  const workflow=flow(1,{name:'Routine',description:'',steps:Array.from({length:4},()=>({tool:'save_note',arguments:{text:'x'.repeat(22000)}}))}),create={operationId:id(1),expectedRevision:0,type:'saveWorkflow',name:workflow.name,steps:workflow.steps},description='\ud800'.repeat(2000),edit={operationId:id(2),expectedRevision:1,type:'saveWorkflow',workflowId:workflow.id,description};
  assert.ok(JSON.stringify(create).length<90000);assert.ok(JSON.stringify(edit).length<90000);for(const step of workflow.steps)assert.ok(Buffer.byteLength(JSON.stringify(step.arguments))<=24000);workflow.description=description;const full=JSON.stringify(semantic(workflow));assert.ok(full.length>100000);assert.ok(full.length<120000);const source=state([workflow]),hash=workflowDefinitionHash(workflow);let offset=0,text='';
  for(;;){const page=readWorkflow(source,{workflowId:workflow.id,definitionOffset:offset,expectedDefinitionHash:hash});assert.ok(Buffer.byteLength(JSON.stringify(page))<=48*1024);text+=page.definitionText;if(!page.definitionHasMore)break;offset=page.nextDefinitionOffset;}
  assert.equal(text,full);assert.deepEqual(JSON.parse(text),semantic(workflow));assert.equal(listWorkflows(source).workflows[0].definitionHash,hash);
});

test('read continuation requires the original hash and refuses changed definitions or workspace revisions',()=>{
  const source=state([flow(1,{steps:[{tool:'save_note',arguments:{text:'A'.repeat(9000)}}]})]),first=readWorkflow(source,{workflowId:id(1)}),args={workflowId:id(1),definitionOffset:first.nextDefinitionOffset};assert.throws(()=>readWorkflow(source,args),{code:'invalid_tool'});assert.throws(()=>readWorkflow(source,{...args,expectedDefinitionHash:'0'.repeat(64)}),{code:'workflow_changed',statusCode:409});
  const changed=structuredClone(source);changed.revision++;changed.workflows[0].steps[0].arguments.text+='changed';assert.throws(()=>readWorkflow(changed,{...args,expectedDefinitionHash:first.definitionHash}),{code:'workflow_changed',statusCode:409});assert.throws(()=>readWorkflow(changed,{...args,expectedDefinitionHash:first.definitionHash,expectedRevision:7}),{code:'revision_conflict',statusCode:409});assert.throws(()=>listWorkflows(changed,{expectedRevision:7}),{code:'revision_conflict',statusCode:409});
  const unrelated=structuredClone(source);unrelated.revision++;assert.equal(readWorkflow(unrelated,{...args,expectedDefinitionHash:first.definitionHash}).definitionHash,first.definitionHash);
});

test('Unicode cursors never split a pair and terminal offsets are exact',()=>{
  const workflow=flow(1,{description:'Before😀after',steps:[{tool:'save_note',arguments:{text:'😀'.repeat(20)}}]}),source=state([workflow]),full=JSON.stringify(semantic(workflow)),emoji=full.indexOf('😀'),hash=workflowDefinitionHash(workflow),page=readWorkflow(source,{workflowId:id(1),definitionLimit:emoji+1});assert.equal(page.nextDefinitionOffset,emoji);assert.equal(page.definitionText,full.slice(0,emoji));
  assert.throws(()=>readWorkflow(source,{workflowId:id(1),definitionOffset:emoji+1,expectedDefinitionHash:hash}),{code:'invalid_workflow_offset'});assert.throws(()=>readWorkflow(source,{workflowId:id(1),definitionOffset:emoji,definitionLimit:1,expectedDefinitionHash:hash}),{code:'invalid_tool'});const next=readWorkflow(source,{workflowId:id(1),definitionOffset:emoji,definitionLimit:2,expectedDefinitionHash:hash});assert.equal(next.definitionText,'😀');const terminal=readWorkflow(source,{workflowId:id(1),definitionOffset:full.length,expectedDefinitionHash:hash});assert.equal(terminal.definitionText,'');assert.equal(terminal.definitionHasMore,false);assert.equal(terminal.nextDefinitionOffset,null);assert.throws(()=>readWorkflow(source,{workflowId:id(1),definitionOffset:full.length+1,expectedDefinitionHash:hash}),{code:'invalid_workflow_offset'});
});

test('strict query selectors and malformed saved definitions fail without mutation',()=>{
  const source=state([flow(1)]),before=structuredClone(source);
  for(const args of [{offset:-1},{offset:101},{limit:0},{limit:21},{query:''},{query:'x'.repeat(201)},{action:'read'},{expectedRevision:-1},{unknown:true},{workflowId:id(1)}])assert.throws(()=>listWorkflows(source,args),{code:'invalid_tool'});
  for(const args of [{workflowId:'bad'},{workflowId:id(1),action:'list'},{workflowId:id(1),definitionLimit:4001},{workflowId:id(1),definitionOffset:-1},{workflowId:id(1),definitionOffset:120001},{workflowId:id(1),expectedDefinitionHash:'bad'},{workflowId:id(1),stepOffset:0}])assert.throws(()=>readWorkflow(source,args),{code:'invalid_tool'});assert.throws(()=>readWorkflow(source,{workflowId:id(2)}),{code:'not_found',statusCode:404});
  for(const mutate of [item=>item.workflows.push(structuredClone(item.workflows[0])),item=>item.workflows[0].steps=[],item=>item.workflows[0].steps[0].arguments=null,item=>item.workflows[0].steps[0].extra='hidden',item=>item.workflows[0].steps[0].capability={id:'old',version:0,hash:'a'.repeat(64)},item=>item.workflows[0].steps[0].arguments.text='x'.repeat(120001)]){const bad=structuredClone(source);mutate(bad);assert.throws(()=>listWorkflows(bad),{code:'invalid_workflow_state',statusCode:500});}
  assert.deepEqual(source,before);const empty=listWorkflows(state([]));assert.deepEqual(empty.workflows,[]);assert.equal(empty.total,0);assert.equal(empty.hasMore,false);assert.equal(empty.nextOffset,null);
});
