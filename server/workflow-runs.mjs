import {createHash} from 'node:crypto';
import {capabilityHash} from './capability-registry.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i,HASH=/^[a-f\d]{64}$/;
const MAX_SECTION=1024*1024,MAX_RESPONSE=48*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const integer=(value,min,max,label)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('invalid_workflow_run_query',`Use ${label} between ${min} and ${max}.`);return value;};
export function workflowRunId(requestId,callId='workflow'){
  if(typeof requestId!=='string'||!requestId||requestId.length>200||typeof callId!=='string'||!callId||callId.length>200)throw fail('invalid_workflow_run_query','Use the actual workflow request identity.');
  const hex=createHash('sha256').update(`${requestId}:${callId}`).digest('hex').slice(0,32);return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function workflowRunDigest(workflowId){if(typeof workflowId!=='string'||!UUID.test(workflowId))throw fail('invalid_workflow_run_query','Choose an actual workflow UUID.');return createHash('sha256').update(JSON.stringify({workflowId})).digest('hex');}
export function workflowRunRevision(record){
  const hash=createHash('sha256');for(const key of['state','definition_json','checkpoint_json','result_json']){const value=record[key];if(value!==null&&value!==undefined&&typeof value!=='string')throw fail('workflow_run_unavailable','Recorded workflow evidence is malformed.',503);hash.update(key+'\0');hash.update(value??'null');hash.update('\0');}return hash.digest('hex');
}
function unavailable(){throw fail('workflow_run_unavailable','This saved routine run could not be matched to its original evidence. Retain its history for review.',503);}
function status(record){
  if(record.state==='in_progress')return'running';if(record.state==='interrupted')return'interrupted';
  const value=record.result_status??record.result?.status;
  if(record.state==='completed'&&value==='completed')return'completed';
  if(record.state==='failed'&&['failed','cancelled'].includes(value))return value;unavailable();
}
export function workflowRunSummary(record){
  if(!object(record)||typeof record.id!=='string'||!record.id.startsWith('workflow:')||!UUID.test(record.id.slice(9))||typeof record.workflow_id!=='string'||!UUID.test(record.workflow_id)||record.hash!==workflowRunDigest(record.workflow_id)||typeof record.original_name!=='string'||!record.original_name.trim()||record.original_name.length>200||!Number.isSafeInteger(record.step_count)||record.step_count<1||record.step_count>12||!Number.isSafeInteger(record.completed_count)||record.completed_count<0||record.completed_count>record.step_count)unavailable();
  if(record.result_workflow_id!==null&&record.result_workflow_id!==undefined&&record.result_workflow_id!==record.workflow_id)unavailable();
  const revision=workflowRunRevision(record),timestampsAvailable=record.recorded_revision===revision&&['started_at','updated_at'].every(key=>typeof record[key]==='string'&&Number.isFinite(Date.parse(record[key])))&&(record.finished_at===null||record.finished_at===undefined||typeof record.finished_at==='string'&&Number.isFinite(Date.parse(record.finished_at)));
  return{id:record.id.slice(9).toLowerCase(),workflowId:record.workflow_id,name:record.original_name,status:status(record),stepCount:record.step_count,completedStepCount:record.completed_count,startedAt:timestampsAvailable?record.started_at:null,updatedAt:timestampsAvailable?record.updated_at:null,finishedAt:timestampsAvailable?record.finished_at??null:null,timestampsAvailable,runRevision:revision};
}
function parseSection(value,nullable=false){if(nullable&&value===null)return null;if(typeof value!=='string'||Buffer.byteLength(value)>MAX_SECTION)unavailable();let result;try{result=JSON.parse(value);}catch{unavailable();}if(!object(result))unavailable();return result;}
/** Derive a child identity only from an actually recorded dispatched step. */
export function workflowRunNestedIdentity(record){
  if(!['in_progress','interrupted'].includes(record.state))return null;
  const checkpoint=parseSection(record.checkpoint_json,true);if(checkpoint?.activeStep===null||checkpoint?.activeStep===undefined)return null;
  const definition=parseSection(record.definition_json),active=checkpoint.activeStep;if(!object(active)||!Number.isSafeInteger(active.index)||active.index<0||!Array.isArray(definition.steps)||active.index>=definition.steps.length)unavailable();
  const step=definition.steps[active.index];if(!object(step)||active.tool!==step.tool)unavailable();if(typeof step.tool!=='string'||!step.tool.startsWith('cap_'))return null;
  const pin=step.capability;if(!object(pin)||typeof pin.id!=='string'||!pin.id||!Number.isSafeInteger(pin.version)||pin.version<1||typeof pin.hash!=='string'||!HASH.test(pin.hash)||!object(step.arguments))unavailable();
  return{id:'capability:'+workflowRunId(record.id,'step:'+active.index),digest:capabilityHash({name:step.tool,arguments:step.arguments}),pin,name:step.tool};
}
function nestedEvidence(record,identity){
  const envelope=record.nested_execution;if(!object(envelope)||envelope.id!==identity.id)unavailable();const child=envelope.record;
  if(child===null)return{revision:'not_recorded',fields:{hostActions:[],nestedReceiptState:'not_recorded',nestedDetailsTruncated:false,nestedCheckpointAvailable:false,outcomeUnknown:true}};
  if(!object(child)||child.id!==identity.id||child.hash!==identity.digest||!['in_progress','interrupted','completed','failed'].includes(child.state))unavailable();
  const definition=parseSection(child.definition_json),checkpoint=parseSection(child.checkpoint_json,true),result=parseSection(child.result_json,true),matches=value=>object(value)&&value.id===identity.pin.id&&value.name===identity.name&&value.version===identity.pin.version&&value.hash===identity.pin.hash;
  if(!matches(definition)||result!==null&&!matches(result.capability))unavailable();
  const source=['completed','failed'].includes(child.state)?result:checkpoint;if(['completed','failed'].includes(child.state)&&source===null)unavailable();
  const hostActions=source?.hostActions??[];if(!Array.isArray(hostActions)||hostActions.length>12)unavailable();
  return{revision:workflowRunRevision(child),fields:{hostActions,nestedReceiptState:child.state,nestedDetailsTruncated:[definition,checkpoint,result].some(value=>value?.detailsTruncated===true),nestedCheckpointAvailable:source!==null,...(['in_progress','interrupted'].includes(child.state)?{outcomeUnknown:true}:{})}};
}
function checkedOffset(text,value,label){const offset=integer(value??0,0,(label==='outcomeOffset'?3:2)*MAX_SECTION,label);if(offset>text.length||offset>0&&high(text,offset-1)&&low(text,offset))throw fail('invalid_workflow_run_offset','Use a returned offset within the recorded JSON without splitting a Unicode character.');return offset;}
const high=(text,index)=>text.charCodeAt(index)>=0xd800&&text.charCodeAt(index)<=0xdbff,low=(text,index)=>text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff;
function end(text,start,limit){let value=Math.min(text.length,start+limit);if(value<text.length&&high(text,value-1)&&low(text,value))value--;if(value===start&&start<text.length)throw fail('invalid_workflow_run_query','Increase the page limit to include the next Unicode character.');return value;}

/** Read stored evidence only. Missing or interrupted steps never become successes. */
export function formatWorkflowRun(record,options={}){
  if(!object(options)||Object.keys(options).some(key=>!['definitionOffset','definitionLimit','outcomeOffset','outcomeLimit','expectedRunRevision'].includes(key)))throw fail('invalid_workflow_run_query','Use the returned routine history offsets and revision.');
  const definition=parseSection(record.definition_json),checkpoint=parseSection(record.checkpoint_json,true),result=parseSection(record.result_json,true);
  if(definition.id!==record.workflow_id||!Array.isArray(definition.steps)||definition.steps.length!==record.step_count||checkpoint?.steps!==undefined&&!Array.isArray(checkpoint.steps)||result?.steps!==undefined&&!Array.isArray(result.steps))unavailable();
  const run=workflowRunSummary(record),nestedIdentity=workflowRunNestedIdentity(record),nested=nestedIdentity?nestedEvidence(record,nestedIdentity):null;
  if(nested)run.runRevision=createHash('sha256').update('workflow-run-detail-v1\0'+run.runRevision+'\0'+nestedIdentity.id+'\0'+nested.revision).digest('hex');
  const outcome=['running','interrupted'].includes(run.status)?{...(checkpoint??{}),id:run.workflowId,status:run.status,steps:checkpoint?.steps??[],activeStep:checkpoint?.activeStep?{...checkpoint.activeStep,...(nested?.fields??{})}:null,checkpointAvailable:checkpoint!==null,...(run.status==='interrupted'?{outcomeUnknown:true,message:'This run was interrupted. Recorded actions may already have completed; inspection does not resume it.'}:{})}:result;
  if(!object(outcome)||outcome.id!==run.workflowId||!Array.isArray(outcome.steps)||outcome.steps.length>12)unavailable();
  const definitionText=record.definition_json,outcomeText=JSON.stringify(outcome);if(Buffer.byteLength(outcomeText)>3*MAX_SECTION)throw fail('workflow_run_unavailable','The saved combined routine evidence exceeds its supported bound.',503);
  const definitionOffset=checkedOffset(definitionText,options.definitionOffset,'definitionOffset'),outcomeOffset=checkedOffset(outcomeText,options.outcomeOffset,'outcomeOffset');
  if(options.expectedRunRevision!==undefined&&(typeof options.expectedRunRevision!=='string'||!HASH.test(options.expectedRunRevision)))throw fail('invalid_workflow_run_query','Use the exact recorded run revision.');
  if((definitionOffset>0||outcomeOffset>0)&&options.expectedRunRevision===undefined)throw fail('workflow_run_revision_required','Continuation pages need the original runRevision.');
  if(options.expectedRunRevision!==undefined&&options.expectedRunRevision!==run.runRevision)throw Object.assign(fail('workflow_run_changed','This live run changed. Read its current first page before combining evidence.',409),{runRevision:run.runRevision});
  const definitionEnd=end(definitionText,definitionOffset,integer(options.definitionLimit??4000,1,4000,'definitionLimit')),outcomeEnd=end(outcomeText,outcomeOffset,integer(options.outcomeLimit??4000,1,4000,'outcomeLimit'));
  const response={run,definitionText:definitionText.slice(definitionOffset,definitionEnd),definitionOffset,definitionLength:definitionText.length,definitionHasMore:definitionEnd<definitionText.length,nextDefinitionOffset:definitionEnd<definitionText.length?definitionEnd:null,outcomeText:outcomeText.slice(outcomeOffset,outcomeEnd),outcomeOffset,outcomeLength:outcomeText.length,outcomeHasMore:outcomeEnd<outcomeText.length,nextOutcomeOffset:outcomeEnd<outcomeText.length?outcomeEnd:null};
  if(Buffer.byteLength(JSON.stringify(response))>MAX_RESPONSE)throw fail('workflow_run_page_limit','The recorded routine page exceeds its response bound.',503);return response;
}
