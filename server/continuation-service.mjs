import { continuationProof } from './continuation-store.mjs';
import { hasContinuationCapabilityReceipt } from './continuation-context.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
const BUILD_ACTIVE=new Set(['queued','generating','validating','applying']);
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const aborted=()=>Object.assign(fail('request_cancelled','The follow-through was stopped.',499),{name:'AbortError'});
const id=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail('invalid_continuation_id','Use an actual follow-through UUID.',400);return value.toLowerCase();};
const safeError=error=>({code:typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(error.code)?error.code:'continuation_unavailable',message:typeof error?.message==='string'&&error.statusCode?error.message.slice(0,1000):'Follow-through could not be confirmed. Check its retained build and work identities.'});
const reasonText=code=>({origin_unresolved:'The original request has incomplete or uncertain action receipts. Inspect them before making a new request.',runtime_restart_required:'Restart the owning Companion service to load this feature, then check again.',runtime_restarting:'Companion is still restarting. Check again after it reconnects.',capability_unavailable:'The installed action has not loaded in the current app.',no_callable_result:'This build provides no callable action for finishing the original request. You can still open its interface.',source_changed:'The applied source changed. Inspect the build before continuing.',capability_source_changed:'The installed action changed. Inspect the build before continuing.',feature_evidence_changed:'The build source proof changed. Inspect it before continuing.',build_evidence_unavailable:'The applied build evidence could not be confirmed.',build_not_applied:'Activate the verified feature change before continuing.',source_unavailable:'The original selected source is unavailable. Start a new explicit request with the intended source.',provider_changed:'The original AI connection changed. Start a new explicit request using the intended provider.'}[code]||code||'The installed function is not ready.');
function publicRecord(record,{summary=false}={}){
  const origin=clone(record.origin);delete origin.requestDigest;
  const result={id:record.id,buildId:record.buildId,workId:record.workId,status:record.status,createdAt:record.createdAt,updatedAt:record.updatedAt,cancelRequested:record.cancelRequested,origin,originalRequest:origin.message,buildSpec:record.buildSpec,readiness:clone(record.readiness)};
  for(const key of ['buildStatus','workStatus','reason','error','startedAt','finishedAt'])if(record[key]!==undefined)result[key]=clone(record[key]);
  if(record.work)result.workJob=clone(record.work);
  if(record.proof){result.requiredCapabilities=clone(record.proof.requiredCapabilities);result.runtime=clone(record.proof.runtime);result.sourceRevision=record.proof.sourceRevision;}
  if(summary){const text=origin.message;result.originalRequest=text.slice(0,240);result.originalRequestTruncated=text.length>240;result.origin={...(origin.conversationId?{conversationId:origin.conversationId}:{}),requestId:origin.requestId,providerId:origin.providerId,...(origin.project?{project:origin.project}:{}),...(origin.contextId?{contextId:origin.contextId}:{})};delete result.buildSpec;if(result.readiness?.requiredCapabilities?.length)result.readiness={ready:result.readiness.ready,...(result.readiness.reason?{reason:result.readiness.reason}:{})};delete result.requiredCapabilities;delete result.runtime;delete result.sourceRevision;}
  if(Buffer.byteLength(JSON.stringify(result))>384*1024)throw fail('continuation_output_limit','The original intent metadata exceeds its detail budget.',503);
  return result;
}
function workSummary(job){return{id:job.id,status:job.status,...(job.conversationId?{conversationId:job.conversationId}:{}),...(job.requestId?{requestId:job.requestId}:{}),...(job.providerId?{providerId:job.providerId}:{})};}
function turnMatches(record,turn){
  const reference=turn?.reply?.continuation;
  return turn?.status==='completed'&&turn.id==='work_'+record.workId&&(!turn.message||turn.message===record.origin.message.trim())&&(!turn.providerId||turn.providerId===record.origin.providerId)&&reference?.id===record.id&&reference.buildId===record.buildId&&reference.workId===record.workId&&hasContinuationCapabilityReceipt(turn.reply?.actions||turn.actions,record.proof?.requiredCapabilities);
}

/** Links a build to one explicit new Work turn. Reads never resume effects. */
export function createContinuationService({store,startBuild,getBuild,proveReady,validateOrigin,startWork,getWork,getWorkTurn,cancelWork,now=Date.now}={}){
  if(!store||['reserve','get','update','claim','cancel','list','getByBuild','getByWork','close'].some(key=>typeof store[key]!=='function')||[startBuild,getBuild,proveReady,validateOrigin,startWork,getWork,getWorkTurn,cancelWork].some(value=>typeof value!=='function'))throw new TypeError('Use the trusted intent store and build/work callbacks.');
  const scopes=new Map(),building=new Map(),starting=new Map();let closed=false,closePromise;
  const check=signal=>{if(closed||signal?.aborted)throw aborted();};
  const timestamp=()=>new Date(now()).toISOString();
  function operation(map,key,signal,callback){
    const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();const entry={controller,promise:null};map.set(key,entry);
    entry.promise=Promise.resolve().then(()=>callback(controller.signal)).finally(()=>{signal?.removeEventListener('abort',cancel);if(map.get(key)===entry)map.delete(key);});return entry.promise;
  }
  async function reconcileWork(record){
    let value;
    try{value=await getWork(record.workId);}catch(error){
      if(error?.statusCode===404||error?.code==='work_not_found'){
        if(starting.has(record.id))return store.get(record.id);
        return store.update(record.id,{status:record.cancelRequested?'cancelled':'interrupted',reason:'The original work start has not been confirmed. It will not be started again automatically.',workStatus:undefined});
      }
      return store.update(record.id,{reason:'The original work could not be checked. Its reserved identity has been retained.',error:safeError(error)});
    }
    const job=value?.job||value;if(!job||job.id!==record.workId||typeof job.status!=='string')throw fail('invalid_continuation_work','The work response did not match its reserved identity.',502);
    let turn=null;try{turn=await getWorkTurn(record.workId);}catch(error){if(error?.statusCode!==404&&error?.code!=='work_not_found')return store.update(record.id,{work:workSummary(job),workStatus:job.status,reason:'The original work turn could not be confirmed.',error:safeError(error)});}
    record=store.get(record.id);
    // The durable original turn is authoritative if Stop arrives after effects.
    if(turn?.status==='completed'){
      const actions=turn.reply?.actions||turn.actions||[];
      if(job.status==='waiting_for_review'||actions.some(action=>action.status==='pending'||action.result?.desktopAction?.status==='pending'))return store.update(record.id,{status:'waiting_for_review',workStatus:job.status,work:workSummary(job),reason:'The follow-through stopped for human review. A pending action has not executed.'});
      if(turnMatches(record,turn))return store.update(record.id,{status:'completed',workStatus:job.status,work:workSummary(job),finishedAt:turn.finishedAt||timestamp(),reason:undefined,error:undefined});
      return store.update(record.id,{status:'failed',workStatus:job.status,work:workSummary(job),finishedAt:timestamp(),reason:'The turn finished without a confirmed new execution of the installed capability.',error:{code:'continuation_result_unproven',message:'Inspect the linked Work result. No completed original outcome was proved.'}});
    }
    const status=turn&&['failed','cancelled','interrupted'].includes(turn.status)?turn.status:job.status;
    if(!['queued','running','waiting_for_review','completed','failed','cancelled','interrupted'].includes(status))throw fail('invalid_continuation_work','The linked work returned an unknown state.',502);
    if(status==='completed')return store.update(record.id,{status:'interrupted',workStatus:job.status,work:workSummary(job),reason:'The terminal original work turn is unavailable. Recorded effects will not be repeated.'});
    return store.update(record.id,{status,workStatus:job.status,work:workSummary(job),...(TERMINAL.has(status)?{finishedAt:turn?.finishedAt||timestamp()}:{}),reason:status==='waiting_for_review'?'The follow-through stopped for human review.':status==='cancelled'?'The follow-through was stopped. Completed actions remain in Work.':status==='interrupted'?'Work was interrupted. Recorded effects will not be replayed.':undefined,...(job.error?{error:{code:String(job.error.code||'work_failed').slice(0,80),message:String(job.error.message||'The work stopped. Inspect its retained result.').slice(0,1000)}}:{error:undefined})});
  }
  async function refresh(record){
    if(record.startClaimed)return reconcileWork(record);
    if(record.cancelRequested||record.originBlocked||TERMINAL.has(record.status))return record;
    let value;try{value=await getBuild(record.buildId);}catch(error){if(error?.statusCode===404||error?.code==='not_found'||error?.code==='build_not_found'){if(building.has(record.id))return record;return store.update(record.id,{status:'interrupted',reason:'The original build admission was not confirmed. Its reserved identity has been retained.'});}return store.update(record.id,{reason:'The feature build could not be checked.',error:safeError(error)});}
    const job=value?.job||value;if(!job||job.id!==record.buildId||typeof job.status!=='string')throw fail('invalid_continuation_build','The build response did not match its reserved identity.',502);
    record=store.get(record.id);if(record.cancelRequested)return record;
    if(BUILD_ACTIVE.has(job.status))return store.update(record.id,{status:'waiting_for_build',buildStatus:job.status,readiness:{ready:false,requiredCapabilities:[],reason:'The feature build is still running.'},reason:undefined,error:undefined});
    if(['ready','review_required'].includes(job.status))return store.update(record.id,{status:'waiting_for_activation',buildStatus:job.status,readiness:{ready:false,requiredCapabilities:[],reason:'Review and activate the concrete feature change first.'},reason:undefined,error:undefined});
    if(job.status!=='applied')return store.update(record.id,{status:job.status==='cancelled'?'cancelled':'failed',buildStatus:job.status,readiness:{ready:false,requiredCapabilities:[],reason:'The feature build is not applied.'},reason:'The original build is '+job.status+'. It has not produced an available result.'});
    let proof;try{proof=continuationProof(await proveReady(record));}catch(error){return store.update(record.id,{status:'waiting_for_runtime',buildStatus:job.status,readiness:{ready:false,requiredCapabilities:[],reason:'Installed capability and runtime readiness could not be confirmed.'},error:safeError(error)});}
    record=store.get(record.id);if(record.cancelRequested||record.startClaimed)return record;
    const blocked=['no_callable_result','capability_changed','capability_source_changed','source_changed','feature_evidence_changed','build_evidence_unavailable','provider_changed','source_unavailable','origin_unresolved'].includes(proof.reason);
    return store.update(record.id,{status:proof.ready?'ready':blocked?'blocked':'waiting_for_runtime',buildStatus:job.status,readiness:proof,reason:proof.ready?undefined:reasonText(proof.reason),error:undefined});
  }
  async function get(value){return{continuation:publicRecord(await refresh(store.get(id(value))))};}
  async function list(options={}){
    const page=store.list(options),result={continuations:[],total:page.total,offset:page.offset,limit:page.limit,hasMore:page.hasMore,nextOffset:page.nextOffset};
    const cursors=()=>{const next=page.offset+result.continuations.length;result.hasMore=next<page.total;result.nextOffset=result.hasMore?next:null;};
    for(const record of page.records){result.continuations.push(publicRecord(await refresh(record),{summary:true}));cursors();if(Buffer.byteLength(JSON.stringify(result))>48*1024){result.continuations.pop();cursors();break;}}
    if(page.records.length&&!result.continuations.length)throw fail('continuation_output_limit','One follow-through summary exceeds its page budget.',503);return result;
  }
  async function requestBuild(input,{scope,signal}={}){
    check(signal);const reservation=store.reserve(input),key=reservation.record.id;if(scope!==undefined)scopes.set(key,scope);
    if(building.has(key))return building.get(key).promise;
    if(reservation.record.buildAttempted){const result=await get(key);let featureJob;try{const value=await getBuild(reservation.record.buildId);featureJob=value?.job||value;}catch{/* The immutable link is still returned for GET-only inspection. */}return{...result,...(featureJob?{featureJob}:{})};}
    return operation(building,key,signal,async current=>{
      let record=store.get(key);check(current);if(record.cancelRequested)throw aborted();store.update(key,{buildAttempted:true});
      let featureJob;
      try{check(current);const value=await startBuild({id:record.buildId,prompt:record.buildSpec,providerId:record.origin.providerId,autoApply:true},{signal:current});featureJob=value?.job||value;if(featureJob?.id!==record.buildId)throw fail('invalid_continuation_build','The builder did not retain its reserved identity.',502);store.update(key,{buildStatus:featureJob.status});}
      catch(error){try{const value=await getBuild(record.buildId);featureJob=value?.job||value;if(featureJob?.id!==record.buildId)featureJob=null;}catch{/* A stopped or uncertain admission never dispatches again. */}if(!featureJob){record=store.get(key);store.update(key,{status:record.cancelRequested||current.aborted?'cancelled':'interrupted',reason:'The build start was not confirmed. Inspect this retained link before requesting another build.',error:safeError(error)});throw Object.assign(error,{continuation:publicRecord(store.get(key))});}}
      const result=await get(key);return{...result,featureJob};
    });
  }
  async function continueOriginal(value,{signal}={}){
    const key=id(value);check(signal);if(starting.has(key))return starting.get(key).promise;
    const saved=store.get(key);if(saved.startClaimed)return get(key);
    return operation(starting,key,signal,async current=>{
      let record=await refresh(store.get(key));check(current);if(record.cancelRequested)throw aborted();
      if(record.status!=='ready')throw Object.assign(fail('continuation_not_ready',record.reason||record.readiness?.reason||'The installed function is not ready.'),{continuation:publicRecord(record)});
      try{await validateOrigin(record,{scope:scopes.get(key),signal:current});check(current);}catch(error){record=store.get(key);if(record.cancelRequested||current.aborted){store.cancel(key);throw Object.assign(aborted(),{continuation:publicRecord(store.get(key))});}store.update(key,{status:'blocked',originBlocked:true,reason:safeError(error).message,error:safeError(error)});throw Object.assign(error,{continuation:publicRecord(store.get(key))});}
      // Re-prove after origin checks; source can change while those checks await.
      const proof=continuationProof(await proveReady(store.get(key)));check(current);if(!proof.ready){store.update(key,{status:'blocked',readiness:proof,reason:reasonText(proof.reason)});throw Object.assign(fail('continuation_not_ready','The installed function changed before acceptance.'),{continuation:publicRecord(store.get(key))});}
      const claim=store.claim(key,proof);if(!claim.claimed)return get(key);record=claim.record;
      try{
        check(current);const value=await startWork({...record,...(scopes.has(key)?{scope:scopes.get(key)}:{})},{signal:current,proof:clone(proof)}),job=value?.job||value;
        if(!job||job.id!==record.workId)throw fail('invalid_continuation_work','Work did not retain its reserved identity.',502);
        store.update(key,{work:workSummary(job),workStatus:job.status});
        if(store.get(key).cancelRequested)await cancelWork(record.workId);
      }catch(error){const result=await reconcileWork(store.get(key));if(!['queued','running','waiting_for_review','completed','failed','cancelled'].includes(result.status))store.update(key,{status:result.cancelRequested||current.aborted?'cancelled':'interrupted',reason:'The original Work start was not confirmed. It will not be dispatched again.',error:safeError(error)});return{continuation:publicRecord(store.get(key))};}
      return{continuation:publicRecord(await reconcileWork(store.get(key)))};
    });
  }
  async function finishCancellation(key){
    let record=store.get(key);
    if(record.startClaimed){try{await cancelWork(record.workId);}catch(error){if(error?.statusCode!==404&&error?.code!=='work_not_found')store.update(key,{reason:'Work cancellation has not been confirmed. Inspect its retained outcome.',error:safeError(error)});}record=await reconcileWork(store.get(key));}
    return{continuation:publicRecord(record)};
  }
  async function cancel(value){const key=id(value);store.cancel(key);building.get(key)?.controller.abort();starting.get(key)?.controller.abort();return finishCancellation(key);}
  async function stopWhere(predicate){const selected=[];for(let offset=0;;){const page=store.list({offset,limit:20});for(const record of page.records)if(!TERMINAL.has(record.status)&&predicate(record))selected.push(record.id);if(!page.hasMore)break;offset=page.nextOffset;}for(const key of selected){store.cancel(key);building.get(key)?.controller.abort();starting.get(key)?.controller.abort();}const results=await Promise.allSettled(selected.map(finishCancellation));return{stopped:selected.length,continuations:results.filter(result=>result.status==='fulfilled').map(result=>result.value.continuation)};}
  function close(){if(closePromise)return closePromise;closed=true;for(const entry of [...building.values(),...starting.values()])entry.controller.abort();closePromise=(async()=>{await Promise.allSettled([...building.values(),...starting.values()].map(entry=>entry.promise));scopes.clear();store.close();})();return closePromise;}
  return{requestBuild,list,get,continue:continueOriginal,cancel,stopAll:()=>stopWhere(()=>true),cancelProject:binding=>stopWhere(record=>record.origin.project?.projectId===binding?.projectId&&record.origin.project?.grantEpoch===binding?.grantEpoch),async getByBuild(value){const record=store.getByBuild(id(value));return record?get(record.id):null;},async getByWork(value){const record=store.getByWork(id(value));return record?get(record.id):null;},recordForWork(value){const record=store.getByWork(id(value));return record?{...record,...(scopes.has(record.id)?{scope:scopes.get(record.id)}:{})}:null;},close};
}
