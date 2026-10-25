import {createHash} from 'node:crypto';

const MAX_BYTES=48*1024,MAX_DEFINITION_CHARACTERS=120000;
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i,HASH=/^[a-f\d]{64}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,code='invalid_tool',statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const fields=(value,allowed)=>{if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('Use supported workflow query fields.');};
const integer=(value,minimum,maximum,label)=>{if(!Number.isSafeInteger(value)||value<minimum||value>maximum)throw fail(`Use ${label} between ${minimum} and ${maximum}.`);return value;};
const high=(text,index)=>text.charCodeAt(index)>=0xd800&&text.charCodeAt(index)<=0xdbff;
const low=(text,index)=>text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff;
function endBoundary(text,start,limit){let end=Math.min(start+limit,text.length);if(end<text.length&&high(text,end-1)&&low(text,end))end--;return end;}
function invalid(){throw fail('A saved workflow definition is invalid.','invalid_workflow_state',500);}
function canonical(value,depth=0,budget={nodes:0}){
  if(depth>16||++budget.nodes>30000)invalid();
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))invalid();return value;}
  if(Array.isArray(value))return value.map(item=>canonical(item,depth+1,budget));
  if(!object(value))invalid();
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1,budget)]));
}
function definition(workflow){
  if(!object(workflow)||typeof workflow.id!=='string'||!UUID.test(workflow.id)||typeof workflow.name!=='string'||!workflow.name.trim()||workflow.name.length>200||typeof workflow.description!=='string'||workflow.description.length>2000||typeof workflow.enabled!=='boolean'||!Array.isArray(workflow.steps)||workflow.steps.length<1||workflow.steps.length>12)invalid();
  for(const key of['createdAt','updatedAt'])if(typeof workflow[key]!=='string'||workflow[key].length>40||!Number.isFinite(Date.parse(workflow[key])))invalid();
  for(const step of workflow.steps){
    if(!object(step)||Object.keys(step).some(key=>!['tool','arguments','capability'].includes(key))||typeof step.tool!=='string'||!step.tool||step.tool.length>64||!object(step.arguments))invalid();
    if(step.capability!==undefined){const pin=step.capability;if(!object(pin)||Object.keys(pin).some(key=>!['id','version','hash'].includes(key))||typeof pin.id!=='string'||!pin.id||pin.id.length>80||!Number.isSafeInteger(pin.version)||pin.version<1||typeof pin.hash!=='string'||!HASH.test(pin.hash))invalid();}
  }
  const value=canonical({name:workflow.name,description:workflow.description,enabled:workflow.enabled,steps:workflow.steps}),text=JSON.stringify(value);
  if(text.length>MAX_DEFINITION_CHARACTERS)invalid();
  return{text,hash:createHash('sha256').update(text).digest('hex')};
}
/** Hash semantic saved bytes, including exact arguments and retained capability pins, without executing or revalidating installed tools. */
export function workflowDefinitionHash(workflow){return definition(workflow).hash;}
function snapshot(state,args){
  if(!object(state)||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.workflows)||state.workflows.length>100)invalid();
  if(args.expectedRevision!==undefined){integer(args.expectedRevision,0,Number.MAX_SAFE_INTEGER,'expectedRevision');if(args.expectedRevision!==state.revision)throw Object.assign(fail('Workflows changed. Read the current definition before combining pages or saving edits.','revision_conflict',409),{revision:state.revision});}
  const ids=new Set();for(const workflow of state.workflows){if(!object(workflow)||typeof workflow.id!=='string'||!UUID.test(workflow.id)||ids.has(workflow.id.toLowerCase()))invalid();ids.add(workflow.id.toLowerCase());}
}
function metadata(workflow,hash,{preview=false}={}){
  const end=preview?endBoundary(workflow.description,0,160):workflow.description.length;
  return{id:workflow.id,name:workflow.name,description:workflow.description.slice(0,end),enabled:workflow.enabled,stepCount:workflow.steps.length,definitionHash:hash,createdAt:workflow.createdAt,updatedAt:workflow.updatedAt,...(preview?{metadataOnly:true,descriptionIsPreview:true,descriptionLength:workflow.description.length,descriptionTruncated:end<workflow.description.length}:{})};
}

/** Stable creation/insertion-order metadata. A page never silently represents a complete definition. */
export function listWorkflows(state,args={}){
  fields(args,['action','query','offset','limit','expectedRevision']);if(args.action!==undefined&&args.action!=='list')throw fail('Use the list action for a workflow list.');snapshot(state,args);
  if(args.query!==undefined&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>200))throw fail('Use a nonblank workflow search of at most 200 characters.');
  const terms=(args.query||'').trim().toLowerCase().split(/\s+/).filter(Boolean),all=state.workflows.map(workflow=>({workflow,...definition(workflow)})).filter(({workflow})=>terms.every(term=>`${workflow.name}\n${workflow.description}`.toLowerCase().includes(term)));
  const offset=integer(args.offset??0,0,100,'offset'),limit=integer(args.limit??20,1,20,'limit');if(offset>all.length)throw fail('The workflow offset is past the matching results.','invalid_workflow_offset');
  const result={workflows:[],revision:state.revision,total:all.length,offset,limit,returned:0,nextOffset:null,hasMore:false};
  const cursors=()=>{result.returned=result.workflows.length;result.hasMore=offset+result.returned<all.length;result.nextOffset=result.hasMore?offset+result.returned:null;};
  for(const item of all.slice(offset,offset+limit)){result.workflows.push(metadata(item.workflow,item.hash,{preview:true}));cursors();if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES){result.workflows.pop();cursors();break;}}
  if(offset<all.length&&!result.returned||Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)throw fail('One workflow metadata result exceeds the response bound.','workflow_result_limit',500);
  return result;
}

/** Page one exact, inert JSON definition. Reconstruct all text before a complete steps replacement. */
export function readWorkflow(state,args={}){
  fields(args,['action','workflowId','definitionOffset','definitionLimit','expectedRevision','expectedDefinitionHash']);if(args.action!==undefined&&args.action!=='read')throw fail('Use the read action for a workflow definition.');snapshot(state,args);
  if(typeof args.workflowId!=='string'||!UUID.test(args.workflowId))throw fail('Choose an actual workflow UUID.');
  const workflow=state.workflows.find(item=>item.id===args.workflowId);if(!workflow)throw fail('That workflow was not found.','not_found',404);
  const saved=definition(workflow),offset=integer(args.definitionOffset??0,0,MAX_DEFINITION_CHARACTERS,'definitionOffset'),limit=integer(args.definitionLimit??4000,1,4000,'definitionLimit');
  if(args.expectedDefinitionHash!==undefined&&(typeof args.expectedDefinitionHash!=='string'||!HASH.test(args.expectedDefinitionHash)))throw fail('Use the exact workflow definition hash.');
  if(offset>0&&args.expectedDefinitionHash===undefined)throw fail('Continuation pages need the original expectedDefinitionHash.');
  if(args.expectedDefinitionHash!==undefined&&args.expectedDefinitionHash!==saved.hash)throw Object.assign(fail('This workflow definition changed. Start from its current first page.','workflow_changed',409),{revision:state.revision,definitionHash:saved.hash});
  if(offset>saved.text.length||offset>0&&high(saved.text,offset-1)&&low(saved.text,offset))throw fail('Use a returned workflow definition offset without splitting a Unicode character.','invalid_workflow_offset');
  const end=endBoundary(saved.text,offset,limit);if(end===offset&&offset<saved.text.length)throw fail('Increase the definition limit to include the next whole Unicode character.');
  const result={workflow:metadata(workflow,saved.hash),revision:state.revision,definitionHash:saved.hash,encoding:'json',definitionText:saved.text.slice(offset,end),definitionOffset:offset,nextDefinitionOffset:end<saved.text.length?end:null,definitionHasMore:end<saved.text.length,totalDefinitionCharacters:saved.text.length,returnedCharacters:end-offset};
  if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)throw fail('The workflow definition page exceeds its response bound.','workflow_result_limit',500);
  return result;
}
