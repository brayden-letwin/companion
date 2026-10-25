import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createProductivityStore} from '../server/productivity-store.mjs';
import {createProductivityTools} from '../server/productivity-tools.mjs';
import {runAssistantTurn} from '../server/assistant-turn.mjs';

async function fixture(t,options={}){
 const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-workflow-history-tools-'));let store=await createProductivityStore({dataDirectory}),tools=createProductivityTools({store,...options});
 t.after(async()=>{store.close();const target=path.resolve(dataDirectory);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep+'companion-workflow-history-tools-'));await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:20});});
 return{get store(){return store;},get tools(){return tools;},apply(type,fields={}){return store.apply({operationId:randomUUID(),expectedRevision:store.snapshot().revision,type,...fields});},async reopen(next={}){store.close();store=await createProductivityStore({dataDirectory});tools=createProductivityTools({store,...next});}};
}
async function completeHistory(tools,workflowId,runId){
 let definitionOffset=0,outcomeOffset=0,definitionText='',outcomeText='',revision=null;
 for(let count=0;;count++){
  assert.ok(count<1000,'History paging must make bounded forward progress.');const value=await tools.execute('list_workflows',{action:'run',workflowId,runId,definitionOffset,outcomeOffset,definitionLimit:113,outcomeLimit:127,...(revision?{expectedRunRevision:revision}:{})});assert.ok(Buffer.byteLength(JSON.stringify(value))<=48*1024);
  revision??=value.run.runRevision;assert.equal(value.run.runRevision,revision);definitionText+=value.definitionText;outcomeText+=value.outcomeText;
  if(!value.definitionHasMore&&!value.outcomeHasMore)return{definition:JSON.parse(definitionText),outcome:JSON.parse(outcomeText),definitionText,outcomeText,revision};
  const nextDefinition=value.definitionHasMore?value.nextDefinitionOffset:value.definitionLength,nextOutcome=value.outcomeHasMore?value.nextOutcomeOffset:value.outcomeLength;assert.ok(nextDefinition>definitionOffset||nextOutcome>outcomeOffset);definitionOffset=nextDefinition;outcomeOffset=nextOutcome;
 }
}

test('fresh and exact retried run replies retain the original name after a later rename and disable',async t=>{
 const f=await fixture(t),original=f.apply('saveWorkflow',{name:'Original accepted routine',steps:[{tool:'save_note',arguments:{text:'One original-name effect'}}]}).workflow,context={requestId:'original-name-run'},first=await f.tools.runWorkflow(original.id,context);
 assert.equal(first.originalName,original.name);f.apply('saveWorkflow',{workflowId:original.id,name:'New current name',enabled:false});const before=f.store.snapshot(),replay=await f.tools.runWorkflow(original.id,context);assert.equal(replay.originalName,original.name);assert.equal(replay.runId,first.runId);assert.deepEqual(f.store.snapshot(),before);assert.equal(before.notes.length,1);
});

test('model-facing history reconstructs complete Unicode evidence in bounded pages without reading a current workspace snapshot',async t=>{
 const f=await fixture(t),body='頭😀"\\\n'.repeat(1000)+'FINAL criterion 😀',description='説明😀'.repeat(300),original=f.apply('saveWorkflow',{name:'Original Unicode routine',description,steps:[{tool:'save_note',arguments:{title:'Original note 😀',text:body}},{tool:'get_time',arguments:{timezone:'UTC'}}]}).workflow,ran=await f.tools.runWorkflow(original.id,{requestId:'unicode-history-run'});
 f.apply('saveWorkflow',{workflowId:original.id,name:'Current unrelated name',enabled:false});const before=f.store.snapshot(),proxy=new Proxy(f.store,{get(target,key){if(key==='snapshot')return()=>assert.fail('History must read its own original receipt, not the current workspace.');return target[key];}}),history=createProductivityTools({store:proxy});
 const listed=await history.execute('list_workflows',{action:'runs',workflowId:original.id,limit:1});assert.equal(listed.runs[0].id,ran.runId);assert.equal(listed.runs[0].name,original.name);
 const recovered=await completeHistory(history,original.id,ran.runId);assert.deepEqual(recovered.definition,original);assert.equal(recovered.outcome.steps[0].result.note.text,body);assert.equal(recovered.outcome.status,'completed');assert.equal(recovered.outcome.steps.length,2);assert.deepEqual(f.store.snapshot(),before);
 const split=recovered.definitionText.indexOf('😀')+1;assert.ok(split>0);await assert.rejects(history.execute('list_workflows',{action:'run',workflowId:original.id,runId:ran.runId,definitionOffset:split,expectedRunRevision:recovered.revision}),{code:'invalid_workflow_run_offset'});
 await assert.rejects(history.execute('list_workflows',{action:'run',workflowId:original.id,runId:ran.runId,definitionOffset:1}),{code:'workflow_run_revision_required'});
 await assert.rejects(history.execute('list_workflows',{action:'runs',workflowId:original.id,query:'not a history field'}),{code:'invalid_workflow_run_query'});assert.equal(history.definitions.length,25);
});

test('the actual turn engine can answer a past-outcome request via runs/run reads without rerunning a renamed disabled routine',async t=>{
 const f=await fixture(t),original=f.apply('saveWorkflow',{name:'Past original name',steps:[{tool:'save_note',arguments:{text:'Exactly one original effect'}}]}).workflow,ran=await f.tools.runWorkflow(original.id,{requestId:'past-completed-run'});f.apply('saveWorkflow',{workflowId:original.id,name:'Renamed current routine',enabled:false});const before=f.store.snapshot(),calls=[],actions=[];
 const services={store:f.store,tools:{definitions:f.tools.definitions,execute:async(name,args,context)=>{actions.push({name,args});return f.tools.execute(name,args,context);}},router:{getStatus:async()=>({defaultProviderId:'synthetic'}),complete:async input=>{
  calls.push(input);const toolMessages=input.messages.filter(x=>x.role==='tool');if(calls.length===1)return{text:'',toolCalls:[{id:'past-runs',name:'list_workflows',arguments:{action:'runs',workflowId:original.id}}]};
  if(calls.length===2){const result=JSON.parse(toolMessages.at(-1).content);assert.equal(result.runs[0].id,ran.runId);return{text:'',toolCalls:[{id:'past-run',name:'list_workflows',arguments:{action:'run',workflowId:original.id,runId:result.runs[0].id}}]};}
  const result=JSON.parse(toolMessages.at(-1).content),outcome=JSON.parse(result.outcomeText);assert.equal(result.run.name,original.name);assert.equal(outcome.status,'completed');return{text:`Recorded ${result.run.name}: ${outcome.status}, ${result.run.completedStepCount} completed step.`,toolCalls:[]};
 }}};
 const conversationId=randomUUID();f.store.createConversation({id:conversationId});const result=await runAssistantTurn({services,body:{id:'inspect-past-outcome',message:'What happened the last time this routine ran? Inspect its saved outcome; do not run it again.',conversationId,expectedRevision:0}});
 assert.equal(calls.length,3);assert.deepEqual(actions.map(x=>x.name),['list_workflows','list_workflows']);assert.deepEqual(actions.map(x=>x.args.action),['runs','run']);assert.equal(result.actions.every(x=>x.status==='completed'),true);assert.match(result.text,/Past original name: completed/);assert.deepEqual(f.store.snapshot(),before);assert.equal(before.notes.length,1);
});

test('failed nested capabilities retain completed host actions in original routine history after restart and capability removal',async t=>{
 const capability={id:'history-partial',title:'Partial fixture',module:'./history-partial.mjs',modulePath:path.join(tmpdir(),'history-partial.mjs'),moduleHash:'a'.repeat(64),version:1,hash:'b'.repeat(64),effectPolicy:'workspace',workflowAllowed:true,tool:{name:'cap_history_partial',description:'Synthetic partial work.',parameters:{type:'object',properties:{},additionalProperties:false}}};let executions=0;
 const f=await fixture(t,{capabilities:[capability],executeCapability:async({runTool})=>{executions++;await runTool('create_task',{title:'Actual nested effect before failure'});throw Object.assign(new Error('Synthetic later failure'),{code:'synthetic_later_failure'});}}),original=f.apply('saveWorkflow',{name:'Original partial routine',steps:[{tool:'save_note',arguments:{text:'Actual completed first step'}},{tool:'cap_history_partial',arguments:{}},{tool:'save_note',arguments:{text:'Must never execute'}}]}).workflow,result=await f.tools.runWorkflow(original.id,{requestId:'partial-history'});
 assert.equal(result.status,'failed');assert.equal(executions,1);const before=f.store.snapshot(),history=await completeHistory(f.tools,original.id,result.runId);assert.deepEqual(history.definition,original);assert.equal(history.outcome.steps.length,1);assert.equal(history.outcome.failedStep.index,1);assert.equal(history.outcome.failedStep.tool,'cap_history_partial');assert.equal(history.outcome.failedStep.hostActions.length,1);const action=history.outcome.failedStep.hostActions[0];assert.equal(action.status,'completed');assert.equal(action.tool,'create_task');assert.equal(action.result.task.id,before.tasks[0].id);assert.equal(action.result.task.title,'Actual nested effect before failure');assert.equal(before.notes.length,1);
 await f.reopen();const after=await completeHistory(f.tools,original.id,result.runId),listed=await f.tools.execute('list_workflows',{action:'runs',workflowId:original.id});assert.deepEqual(after,history);assert.equal(listed.runs[0].status,'failed');assert.equal(listed.runs[0].completedStepCount,1);assert.equal(listed.runs[0].stepCount,3);assert.equal(executions,1);assert.deepEqual(f.store.snapshot(),before);
});
