import path from 'node:path';
import {createContinuationStore} from './continuation-store.mjs';
import {createContinuationService} from './continuation-service.mjs';
import {createFeatureReadiness} from './feature-readiness.mjs';
import {continuationReference} from './continuation-context.mjs';
import {normalizeProjectBinding} from './project-files-context.mjs';

const fail=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const check=signal=>{if(signal?.aborted)throw Object.assign(fail('request_cancelled','The original-request continuation was stopped.',499),{name:'AbortError'});};
const providerIdentity=value=>JSON.stringify([value?.id,value?.type,value?.model??'',value?.baseUrl??null]);
function uncertain(actions,depth=0){
  if(!Array.isArray(actions)||depth>3)return true;
  return actions.some(action=>!action||action.status==='pending'||action.resultTruncated||action.outcomeUnknown||action.result?.outcomeUnknown||action.result?.projectFileEdit?.receiptPending||action.result?.projectFileEdit?.outcomeUnknown||['recovery_required','interrupted'].includes(action.result?.projectFileEdit?.status)||['pending','executing','uncertain'].includes(action.result?.desktopAction?.status)||Array.isArray(action.result?.hostActions)&&uncertain(action.result.hostActions,depth+1)||Array.isArray(action.result?.steps)&&uncertain(action.result.steps,depth+1));
}
/** Reads the completed original receipt; it never invents or resumes old effects. */
export function continuationOriginalReceipt(services,record){
  const receipt=services.store.chatReceipt(record.origin.requestId,record.origin.requestDigest);
  if(receipt?.state==='in_progress')throw fail('continuation_origin_running','The original request is still finishing. Check again after its reply is saved.');
  if(!receipt||receipt.state!=='completed'||!receipt.reply)throw fail('continuation_origin_unfinished','The original turn has not finished with a complete receipt. Inspect its actions before making a new request.');
  const reply=receipt.reply,actions=reply.actions||[];
  if(reply.outcomeTruncated||uncertain(actions))throw fail('continuation_origin_uncertain','Some original actions are pending, uncertain or abbreviated. Inspect them before making another request.');
  const linked=actions.some(action=>action.tool==='build_feature'&&action.status==='completed'&&action.result?.featureJob?.id===record.buildId&&action.result?.continuation?.id===record.id);
  if(!linked)throw fail('continuation_origin_mismatch','The original saved build receipt could not be matched to this request.');
  return receipt;
}

/** Trusted adapter joining the build ledger to the existing durable Work engine. */
export async function createContinuationRuntime({services,root,dataDirectory,getRuntimeStatus,validateWindow,owner='local-workspace'}={}){
  const proveSource=createFeatureReadiness({builder:services.builder,root,tools:services.tools,getRuntimeStatus,owner});
  const proveReady=async record=>{const proof=await proveSource(record);if(!proof.ready)return proof;try{continuationOriginalReceipt(services,record);return proof;}catch(error){return{...proof,ready:false,reason:error.code==='continuation_origin_running'?'The original request is still finishing. Check again after its reply is saved.':'origin_unresolved'};}};
  const store=await createContinuationStore({dataDirectory:path.join(dataDirectory,'continuations')});let service;
  async function validateOrigin(record,{scope,signal}={}){
    check(signal);const receipt=continuationOriginalReceipt(services,record);
    const status=await services.router.getStatus();check(signal);
    const provider=status.providers?.find(item=>item.id===record.origin.providerId);
    if(!provider?.ready||providerIdentity(provider)!==providerIdentity(record.origin.provider))throw fail('continuation_provider_changed','The original AI connection changed or is unavailable. Make a new request with your intended connection.');
    if(record.origin.contextId){if(typeof validateWindow!=='function')throw fail('window_context_unavailable','The original window source is unavailable. Reselect it and make a new request.');await validateWindow(record.origin.contextId,scope);check(signal);}
    if(record.origin.project){if(!services.projectFiles?.validateBinding)throw fail('project_files_unavailable','The original project folder is unavailable.');await services.projectFiles.validateBinding(normalizeProjectBinding({projectId:record.origin.project.projectId,grantEpoch:record.origin.project.grantEpoch}),{signal});check(signal);}
    return receipt;
  }
  try{service=createContinuationService({store,
    startBuild:async(input,{signal}={})=>{check(signal);const result=await services.builder.requestLinked({prompt:input.prompt,providerId:input.providerId,autoApply:true},owner,{id:input.id,key:'continuation:'+input.id});check(signal);return result;},
    getBuild:id=>services.builder.get(id,owner),proveReady,validateOrigin,
    startWork:async(record,{signal,proof}={})=>{
      await validateOrigin(record,{scope:record.scope,signal});check(signal);
      const fresh=await proveReady(record);check(signal);
      if(!fresh.ready||JSON.stringify(fresh.requiredCapabilities)!==JSON.stringify(proof.requiredCapabilities))throw fail('continuation_tool_changed','The installed tool changed before this request could start.');
      const origin=record.origin;
      return services.work.create({id:record.workId,prompt:origin.message,title:'Continue: '+origin.message.replace(/\s+/gu,' ').trim().slice(0,70),providerId:origin.providerId,provider:origin.provider,originRequestId:origin.requestId,...(origin.conversationId?{originConversationId:origin.conversationId}:{}),...(origin.contextId?{contextId:origin.contextId,windowContext:origin.windowContext}:{}),...(origin.project?{project:origin.project}:{}),...(record.scope?{scope:record.scope}:{}),continuation:continuationReference(record)});
    },getWork:id=>services.work.get(id),getWorkTurn:id=>services.store.getWorkJobTurn(id),cancelWork:id=>services.work.cancel(id)});}
  catch(error){store.close();throw error;}
  service.prepareWork=async(input,{signal}={})=>{
    const ref=continuationReference(input.continuation);if(!ref||ref.workId!==input.jobId)throw fail('continuation_work_mismatch','The linked Work identity could not be matched.');
    const record=service.recordForWork(input.jobId);
    if(!record||record.id!==ref.id||record.buildId!==ref.buildId||!record.startClaimed||!record.proof?.ready||record.origin.message!==input.message||record.origin.providerId!==input.providerId)throw fail('continuation_work_mismatch','The original-request ledger is unavailable or changed. This Work will not run as an unrestricted task.');
    const receipt=await validateOrigin(record,{scope:record.scope??input.scope,signal});check(signal);
    const proof=await proveReady(record);check(signal);
    if(!proof.ready||JSON.stringify(proof.requiredCapabilities)!==JSON.stringify(record.proof.requiredCapabilities))throw fail('continuation_tool_changed','The installed tool changed while this request was queued.');
    return{...ref,originRequestId:record.origin.requestId,requiredCapabilities:record.proof.requiredCapabilities,sourceRevision:record.proof.sourceRevision,priorActions:receipt.reply.actions||[]};
  };
  return service;
}
