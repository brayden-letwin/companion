import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {formatWorkOutcome} from '../server/work-output.mjs';

const job=(status='completed')=>({requestId:'synthetic-work-request',status});
const action=(index,result={})=>({id:'call-'+index,tool:'synthetic_tool',arguments:{index},result,status:'completed'});
function turn(text,actions=[]){return{id:'synthetic-work-request',status:'completed',reply:{text,actions}};}

test('actual reply text and action pages reconstruct without missing or duplicated receipts',()=>{
  const text=('A😀\\\n\"Z'.repeat(1300)),actions=Array.from({length:24},(_,index)=>action(index,{task:{id:randomUUID()},text:'receipt-'+index})),actual=turn(text,actions);
  let textOffset=0,actionOffset=0,reconstructed='',seen=[];
  for(let count=0;count<20;count++){
    const page=formatWorkOutcome(job(),actual,{textOffset,textLimit:3999,actionOffset,actionLimit:7});reconstructed+=page.text;seen.push(...page.actions);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=128*1024);assert.equal(page.totalTextCharacters,text.length);assert.equal(page.totalActions,24);assert.ok(Object.isFrozen(page));assert.ok(Object.isFrozen(page.actions));
    if(!page.textHasMore&&!page.actionsHasMore)break;
    textOffset=page.nextTextOffset??text.length;actionOffset=page.nextActionOffset??actions.length;
  }
  assert.equal(reconstructed,text);assert.deepEqual(seen,actions);assert.equal(actual.reply.text,text);
});

test('Unicode cursors reject pair splitting and past-end pages but allow exact terminal offsets',()=>{
  const actual=turn('A😀B',[action(1)]);
  const first=formatWorkOutcome(job(),actual,{textLimit:2});assert.equal(first.text,'A');assert.equal(first.nextTextOffset,1);
  for(const options of [{textOffset:2},{textOffset:5},{actionOffset:2},{textLimit:0},{textLimit:4001},{actionLimit:13},{maxBytes:16383},{textOffset:1,textLimit:1}])assert.throws(()=>formatWorkOutcome(job(),actual,options),error=>error.code==='invalid_work_output'&&error.statusCode===400);
  const end=formatWorkOutcome(job(),actual,{textOffset:4,actionOffset:1});assert.equal(end.text,'');assert.deepEqual(end.actions,[]);assert.equal(end.textHasMore,false);assert.equal(end.actionsHasMore,false);
});

test('queued and pre-engine errors have no invented turn, while unrelated conversation turns are rejected',()=>{
  const queued=formatWorkOutcome(job('queued'),null);assert.equal(queued.status,'queued');assert.equal(queued.text,'');assert.deepEqual(queued.actions,[]);
  const failed=formatWorkOutcome({...job('failed'),error:{code:'provider_changed',message:'The chosen provider changed.'}},undefined);assert.deepEqual(failed.error,{code:'provider_changed',message:'The chosen provider changed.'});
  assert.throws(()=>formatWorkOutcome(job(),{...turn('Private other conversation'),id:'another-request'}),error=>error.statusCode===502&&error.code==='invalid_work_output');
  assert.throws(()=>formatWorkOutcome(job(),turn('text',[{...action(1),status:'invented'}])),error=>error.statusCode===502);
});

test('running partial actions and terminal errors remain actual evidence with the job status',()=>{
  const partial=action(1,{task:{id:randomUUID()}}),running={id:job().requestId,status:'running',actions:[partial]};
  assert.deepEqual(formatWorkOutcome(job('running'),running).actions,[partial]);
  const failed={...running,status:'cancelled',error:{code:'request_cancelled',message:'Stopped.',actions:[partial]}};
  const outcome=formatWorkOutcome(job('cancelled'),failed);assert.equal(outcome.status,'cancelled');assert.equal(outcome.text,'');assert.deepEqual(outcome.error,{code:'request_cancelled',message:'Stopped.'});assert.deepEqual(outcome.actions,[partial]);
});

test('oversized results keep every nested effect identity and uncertainty without claiming computed proof',()=>{
  const taskId=randomUUID(),noteId=randomUUID(),desktopId=randomUUID(),contextId=randomUUID();
  const nested={id:'nested-workflow',tool:'run_workflow',status:'failed',result:{workflow:{id:randomUUID()},steps:[{tool:'run_capability',status:'failed',result:{capability:{id:'fixture',name:'cap_fixture',version:3,hash:'a'.repeat(64)},value:{sentEmail:true},hostActions:[{id:'host:1',tool:'create_task',status:'completed',result:{task:{id:taskId},text:'X'.repeat(100000)}},{id:'host:2',tool:'save_note',status:'failed',result:{note:{id:noteId},outcomeUnknown:true,error:'Unknown outcome'}}]}},{tool:'desktop_input',status:'pending',result:{desktopAction:{id:desktopId,status:'pending',preview:{text:'Huge preview'.repeat(2000)},outcomeUnknown:true}}}],windowContext:{contextId,windowId:'fixture-window',title:'Synthetic context',appName:'Synthetic app',readAt:'2026-10-25T00:00:00.000Z'},text:'Y'.repeat(100000)}};
  const result=formatWorkOutcome(job('interrupted'),{id:job().requestId,status:'interrupted',actions:[nested]},{maxBytes:16384});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=16384);assert.equal(result.actions.length,1);const projected=result.actions[0];assert.equal(projected.resultTruncated,true);assert.equal(projected.result.steps.length,2);assert.equal(projected.result.steps[0].result.hostActions.length,2);assert.equal(projected.result.steps[0].result.hostActions[0].result.task.id,taskId);assert.equal(projected.result.steps[0].result.hostActions[1].result.outcomeUnknown,true);assert.equal(projected.result.steps[1].result.desktopAction.id,desktopId);assert.equal(projected.result.steps[1].result.desktopAction.outcomeUnknown,true);assert.equal(projected.result.steps[1].result.desktopAction.requiresFreshPreview,true);assert.equal(projected.result.windowContext.contextId,contextId);assert.ok(!JSON.stringify(result).includes('sentEmail'));
});

test('escaped-byte pressure shrinks action pages with an explicit next offset and retains whole receipts',()=>{
  const actions=Array.from({length:12},(_,index)=>action(index,{text:'\u0000'.repeat(2000),task:{id:randomUUID()}}));
  let offset=0,seen=[];
  do{
    const page=formatWorkOutcome(job(),turn('\u0000'.repeat(4000),actions),{actionOffset:offset,maxBytes:32768});assert.ok(Buffer.byteLength(JSON.stringify(page))<=32768);assert.ok(page.actions.length);assert.ok(page.actions.length<12);for(const item of page.actions)assert.notEqual(item.resultTruncated,true);seen.push(...page.actions.map(item=>item.id));offset=page.nextActionOffset;
  }while(offset!==null);
  assert.deepEqual(seen,actions.map(item=>item.id));
  let textOffset=0,reconstructed='';const escaped='\u0000'.repeat(4000)+'😀';
  do{const page=formatWorkOutcome(job(),turn(escaped),{textOffset,maxBytes:16384});assert.ok(Buffer.byteLength(JSON.stringify(page))<=16384);reconstructed+=page.text;textOffset=page.nextTextOffset;}while(textOffset!==null);
  assert.equal(reconstructed,escaped);
});

test('selected-source metadata is public and independent of raw read text',()=>{
  const contextId=randomUUID(),windowContext={contextId,windowId:'synthetic',title:'Actual selected source',appName:'Synthetic app',readAt:'2026-10-25T00:00:00.000Z',text:'PRIVATE EXTRA FIELD',handle:'private-handle'};
  const output=formatWorkOutcome(job(),{id:job().requestId,status:'completed',reply:{text:'Answer',actions:[],windowContext}});
  assert.equal(output.windowContext.contextId,contextId);assert.equal(output.windowContext.readAt,windowContext.readAt);assert.equal(output.windowContext.sourceOmitted,true);assert.ok(!JSON.stringify(output).includes('PRIVATE EXTRA FIELD'));assert.ok(!JSON.stringify(output).includes('private-handle'));
  const beforeRead=formatWorkOutcome({...job('cancelled'),windowContext:{...windowContext,readAt:undefined}},null);assert.equal(beforeRead.windowContext.contextId,contextId);assert.equal(beforeRead.windowContext.readAt,undefined);assert.equal(beforeRead.actions.length,0);
  const conversationId=randomUUID(),workJob={id:randomUUID(),status:'queued',conversationId,providerId:'synthetic'};
  const projected=formatWorkOutcome(job(),turn('',[action(1,{workJob,text:'X'.repeat(100000)})]),{maxBytes:16384});assert.equal(projected.actions[0].result.workJob.conversationId,conversationId);assert.equal(projected.actions[0].result.workJob.providerId,'synthetic');
});
