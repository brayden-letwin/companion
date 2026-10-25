import { windowContextReference } from './window-context.mjs';
import { projectReference, projectEditReference, projectReadReference } from './project-files-context.mjs';

const STATUSES=new Set(['queued','running','completed','failed','cancelled','interrupted','waiting_for_review']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{code:'invalid_work_output',statusCode});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const high=code=>code>=0xd800&&code<=0xdbff,low=code=>code>=0xdc00&&code<=0xdfff;
function integer(value,minimum,maximum,label){if(!Number.isSafeInteger(value)||value<minimum||value>maximum)throw fail(`Use a ${label} between ${minimum} and ${maximum}.`);return value;}
function safeEnd(text,start,limit){let end=Math.min(text.length,start+limit);if(end<text.length&&high(text.charCodeAt(end-1))&&low(text.charCodeAt(end)))end--;return end;}
function shortened(text,limit){return text.slice(0,safeEnd(text,0,limit));}
function clone(value){try{return JSON.parse(JSON.stringify(value));}catch{throw fail('The recorded work outcome is not valid JSON.',502);}}
function freeze(value){if(value&&typeof value==='object'){for(const part of Object.values(value))freeze(part);Object.freeze(value);}return value;}

// A small, explicit reference projection preserves actual identities and every
// nested receipt. Computed capability fields are not turned into action proof.
function references(source,depth=0){
  if(!object(source))return{};
  if(depth>16)throw fail('The recorded action nesting exceeds its supported bound.',502);
  const result={detailsOmitted:true};
  for(const key of ['id','status','code'])if(typeof source[key]==='string')result[key]=shortened(source[key],200);
  if(typeof source.outcomeUnknown==='boolean')result.outcomeUnknown=source.outcomeUnknown;
  if(source.error)result.error=typeof source.error==='string'?shortened(source.error,240):'This action did not complete.';
  for(const key of ['task','note','workflow','featureJob','featureBuild','desktopAction','desktopReceipt','capability','workJob','job']){
    const item=source[key];if(!object(item))continue;
    const reference={};
    for(const name of ['id','name','status','hash'])if(typeof item[name]==='string')reference[name]=shortened(item[name],200);
    if(key==='workJob')for(const name of ['conversationId','providerId'])if(typeof item[name]==='string')reference[name]=shortened(item[name],200);
    if(Number.isSafeInteger(item.version))reference.version=item.version;
    if(typeof item.outcomeUnknown==='boolean')reference.outcomeUnknown=item.outcomeUnknown;
    if(key==='desktopAction')reference.requiresFreshPreview=true;
    if(key==='featureBuild'&&object(item.activation))reference.activation=clone(item.activation);
    result[key]=reference;
  }
  const context=windowContextReference(source.windowContext);if(context)result.windowContext=context;
  if(source.projectContext)result.projectContext=projectReference(source.projectContext);
  if(source.projectFileEdit)result.projectFileEdit=projectEditReference(source.projectFileEdit);
  if(source.projectFileRead||source.sourceTrust==='untrusted_project_file')result.projectFileRead=projectReadReference(source.projectFileRead||source);
  if(source.sourceType==='selected_window_accessibility')Object.assign(result,{sourceType:source.sourceType,sourceOmitted:true,readable:source.readable===true});
  for(const key of ['hostActions','steps'])if(Array.isArray(source[key])){
    if(source[key].length>12)throw fail('The recorded action sequence exceeds its supported bound.',502);
    result[key]=source[key].map(action=>projectAction(action,depth+1));
  }
  if(object(source.failedStep))result.failedStep={...(Number.isSafeInteger(source.failedStep.index)?{index:source.failedStep.index}:{}),...projectAction(source.failedStep,depth+1)};
  return result;
}
function projectAction(action,depth=0){
  if(!object(action))throw fail('An actual recorded action is required.',502);
  const value={};
  for(const key of ['id','tool','status'])if(typeof action[key]==='string')value[key]=action[key];
  if(typeof action.outcomeUnknown==='boolean')value.outcomeUnknown=action.outcomeUnknown;
  value.result=references(action.result,depth);value.resultTruncated=true;return value;
}

/** A bounded read-only page of the actual conversation turn owned by this job. */
export function formatWorkOutcome(job,turn,{textOffset=0,textLimit=4000,actionOffset=0,actionLimit=12,maxBytes=128*1024}={}){
  if(!object(job)||typeof job.requestId!=='string'||!job.requestId||!STATUSES.has(job.status))throw fail('An actual work job is required.',502);
  if(turn!==undefined&&turn!==null&&(!object(turn)||turn.id!==job.requestId))throw fail('The conversation turn does not belong to this work job.',502);
  maxBytes=integer(maxBytes,16*1024,128*1024,'response byte limit');
  textLimit=integer(textLimit,1,4000,'text limit');actionLimit=integer(actionLimit,1,12,'action limit');
  const text=turn?.reply?.text??'';
  const recordedActions=turn?.reply?.actions??turn?.error?.actions??turn?.actions??[];
  if(typeof text!=='string'||!Array.isArray(recordedActions)||recordedActions.length>24||recordedActions.some(action=>!object(action)||typeof action.id!=='string'||typeof action.tool!=='string'||!['pending','completed','failed'].includes(action.status)))throw fail('The recorded work outcome is malformed.',502);
  textOffset=integer(textOffset,0,text.length,'text offset');actionOffset=integer(actionOffset,0,recordedActions.length,'action offset');
  if(textOffset>0&&high(text.charCodeAt(textOffset-1))&&low(text.charCodeAt(textOffset)))throw fail('Use a returned text offset instead of splitting a Unicode character.');
  let textEnd=safeEnd(text,textOffset,textLimit);
  if(textEnd===textOffset&&textOffset<text.length)throw fail('Increase the text limit to include the next whole Unicode character.');
  // Escaped characters can cost six wire bytes each. Keep a bounded text share
  // so a small response allocation still has room for actual action evidence.
  if(bytes(text.slice(textOffset,textEnd))>Math.floor(maxBytes/2)){
    let lowEnd=textOffset,highEnd=textEnd;
    while(lowEnd<highEnd){const middle=Math.ceil((lowEnd+highEnd)/2);if(bytes(text.slice(textOffset,middle))<=Math.floor(maxBytes/2))lowEnd=middle;else highEnd=middle-1;}
    textEnd=safeEnd(text,textOffset,lowEnd-textOffset);
  }
  const outcome={status:job.status,text:text.slice(textOffset,textEnd),textOffset,nextTextOffset:textEnd<text.length?textEnd:null,textHasMore:textEnd<text.length,totalTextCharacters:text.length,
    actions:[],actionOffset,nextActionOffset:actionOffset<recordedActions.length?actionOffset:null,actionsHasMore:actionOffset<recordedActions.length,totalActions:recordedActions.length};
  const error=turn?.error??job.error;
  if(error!==undefined&&error!==null){if(!object(error))throw fail('The recorded work error is malformed.',502);outcome.error={code:typeof error.code==='string'?shortened(error.code,100):'work_failed',message:typeof error.message==='string'?shortened(error.message,2000):'This work did not finish. Inspect its recorded actions.'};}
  const context=windowContextReference(turn?.reply?.windowContext??turn?.error?.windowContext??turn?.windowContext??job.windowContext);if(context)outcome.windowContext=context;
  const project=projectReference(turn?.reply?.projectContext??turn?.error?.projectContext??turn?.projectContext??job.project);if(project)outcome.projectContext=project;
  if(bytes(outcome)>maxBytes)throw fail('The work page metadata exceeds its response allocation.',502);
  for(const action of recordedActions.slice(actionOffset,actionOffset+actionLimit)){
    // Most stored receipts fit intact. Only oversized individual results are
    // projected; a later page must not silently skip an unreturned receipt.
    if(bytes(action)>2*1024*1024)throw fail('A recorded work action exceeds its supported bound.',502);
    const full=clone(action);outcome.actions.push(full);
    if(bytes(outcome)>maxBytes){
      outcome.actions.pop();
      if(outcome.actions.length)break;
      outcome.actions.push(projectAction(action));
      if(bytes(outcome)>maxBytes)throw fail('One recorded action cannot fit this response allocation. Inspect its saved conversation.',502);
    }
  }
  const next=actionOffset+outcome.actions.length;outcome.actionsHasMore=next<recordedActions.length;outcome.nextActionOffset=outcome.actionsHasMore?next:null;
  if(bytes(outcome)>maxBytes)throw fail('The work outcome exceeds its response allocation.',502);
  return freeze(outcome);
}
