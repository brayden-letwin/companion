import { formatWorkOutcome } from './work-output.mjs';

const TERMINAL=new Set(['completed','waiting_for_review','failed','cancelled','interrupted']);
const MAX_BYTES=128*1024;
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const abortError=()=>Object.assign(fail('request_cancelled','Work was stopped. Recorded actions remain.',499),{name:'AbortError'});
function summary(job){
  const {prompt,error,...publicJob}=job;
  return{...publicJob,progress:{message:job.progress?.message||'',events:[],historyOmitted:true},promptPreview:prompt.replace(/\s+/gu,' ').slice(0,240),promptLength:prompt.length,...(error?{error}:{})};
}
function progressStage(update){
  const phase=update?.phase??update?.type,state=update?.state;
  if(phase==='context')return{type:'context',message:'Reading the selected window.'};
  if(phase==='model'||phase==='queue_waiting')return{type:phase==='queue_waiting'?'queue_waiting':'model',message:phase==='queue_waiting'||state==='waiting'?'Waiting for an AI connection slot.':'Working with the selected AI.'};
  if(phase==='tool'){
    const name=typeof update.tool==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(update.tool)?update.tool.replaceAll('_',' '):'the requested action';
    return{type:'tool',message:state==='failed'?`Could not finish ${name}.`:state==='completed'?`Finished ${name}.`:`Running ${name}.`};
  }
  if(phase==='completed')return{type:'completed',message:state==='cancelled'?'Stopped. Recorded actions remain.':state==='failed'?'The turn stopped with an error.':'Finished.'};
  return null;
}

/** Durable, explicit background turns. No HTTP loopback, automatic retry or auto-resume. */
export function createWorkService({store,runTurn,concurrency=2}={}){
  if(!store||typeof store.createWorkJob!=='function'||typeof runTurn!=='function')throw new TypeError('A durable work store and injected turn runner are required.');
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>2)throw new TypeError('Use one or two concurrent work turns.');
  const pending=new Map(),active=new Map();let closed=false,scheduled=false,draining=false,closePromise=null;
  const publicJob=job=>summary(job);
  const schedule=()=>{if(closed||scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;drain();});};
  async function perform(entry){
    const {job,controller}=entry;
    try{
      if(controller.signal.aborted||closed)throw abortError();
      await runTurn({jobId:job.id,requestId:job.requestId,message:job.prompt,providerId:job.providerId,conversationId:job.conversationId,...(job.contextId?{contextId:job.contextId}:{}),...(job.windowContext?{windowContext:structuredClone(job.windowContext)}:{}),signal:controller.signal,scope:entry.scope,allowDelegation:false,expectedProvider:structuredClone(job.provider),onProgress:update=>{
        if(closed||controller.signal.aborted||active.get(job.id)!==entry)return;
        const stage=progressStage(update);if(!stage)return;
        try{store.progressWorkJob(job.id,stage);}catch{/* Optional progress cannot change the actual durable effect receipt. */}
      }});
      const turn=store.getWorkJobTurn(job.id);
      if(!turn||turn.status==='running')throw fail('work_turn_incomplete','The runner did not commit a terminal conversation result. Inspect recorded actions before creating another job.',503);
      store.finishWorkJob(job.id,{status:controller.signal.aborted?'cancelled':'completed'});
    }catch(error){
      const current=store.getWorkJob(job.id);
      const interrupted=closed&&!current.cancelRequested;
      store.finishWorkJob(job.id,{status:interrupted?'interrupted':controller.signal.aborted||error.name==='AbortError'?'cancelled':'failed',error:{code:interrupted?'work_interrupted':error.code||'work_failed',message:String(error.message||'Work could not finish. Inspect retained actions.').slice(0,2000)}});
    }finally{if(active.get(job.id)===entry)active.delete(job.id);schedule();}
  }
  function drain(){
    if(closed||draining)return;draining=true;
    try{
      for(const [id,request]of pending){
        if(active.size>=concurrency)break;
        const claimed=store.startWorkJob(id);
        if(!claimed.started){if(claimed.job.status!=='queued')pending.delete(id);else break;continue;}
        pending.delete(id);const entry={job:claimed.job,scope:request.scope,controller:new AbortController(),promise:null};active.set(id,entry);entry.promise=Promise.resolve().then(()=>perform(entry));void entry.promise.catch(()=>{/* A failed bookkeeping write must not trigger a duplicate turn or an unhandled rejection. */});
      }
    }finally{draining=false;}
  }
  const timer=setInterval(()=>{
    if(closed)return;
    for(const [id,entry]of active)if(store.getWorkJob(id).cancelRequested)entry.controller.abort();
    schedule();
  },250);timer.unref?.();
  function create(input){
    if(closed)throw fail('work_closed','Background work is shutting down.',503);
    if(input?.scope!==undefined&&(typeof input.scope!=='string'||!input.scope||input.scope.length>300))throw fail('invalid_work_input','Use an internal bounded session scope.');
    if(input?.contextId&&!input.scope)throw fail('work_context_unavailable','A selected source needs its original session scope.',409);
    const result=store.createWorkJob(input);
    if(!result.replayed){pending.set(result.job.id,{scope:input.scope});schedule();}
    return{job:publicJob(result.job),replayed:result.replayed};
  }
  function list(options={}){
    const page=store.listWorkJobs(options),jobs=[];
    const envelope=()=>{const next=page.offset+jobs.length;return{...page,jobs,returned:jobs.length,hasMore:next<page.total,nextOffset:next<page.total?next:null};};
    for(const raw of page.jobs){jobs.push(publicJob(raw));if(Buffer.byteLength(JSON.stringify(envelope()))>64*1024){jobs.pop();break;}}
    if(page.jobs.length&&!jobs.length)throw fail('work_output_limit','One job summary exceeds its response budget.',413);
    return envelope();
  }
  async function get(id,options={}){
    const job=store.getWorkJob(id),turn=store.getWorkJobTurn(id);
    const {modelView=false,promptOffset=0,...paging}=options;if(typeof modelView!=='boolean'||!Number.isSafeInteger(promptOffset)||promptOffset<0||promptOffset>job.prompt.length)throw fail('invalid_work_page','Use a returned work request offset.');
    if(!modelView&&promptOffset!==0)throw fail('invalid_work_page','Prompt paging belongs to the model view.');
    const {error,...full}=job;let base=full,maxBytes=MAX_BYTES;
    if(modelView){
      const high=index=>{const code=job.prompt.charCodeAt(index);return code>=0xd800&&code<=0xdbff;},low=index=>{const code=job.prompt.charCodeAt(index);return code>=0xdc00&&code<=0xdfff;};
      if(promptOffset>0&&high(promptOffset-1)&&low(promptOffset))throw fail('invalid_work_page','Do not split a Unicode character in the work request.');
      let end=Math.min(job.prompt.length,promptOffset+2000);if(end<job.prompt.length&&high(end-1)&&low(end))end--;
      base={...publicJob(job),prompt:job.prompt.slice(promptOffset,end),promptOffset,promptHasMore:end<job.prompt.length,nextPromptOffset:end<job.prompt.length?end:null};maxBytes=64*1024;
    }
    const budget=maxBytes-Buffer.byteLength(JSON.stringify(base))-256;
    if(budget<16*1024)throw fail('work_output_limit','This job metadata exceeds its response budget.',413);
    const outcome=formatWorkOutcome(job,turn,{...paging,maxBytes:budget});
    const result={...base,outcome};
    if(Buffer.byteLength(JSON.stringify(result))>maxBytes)throw fail('work_output_limit','This work page exceeds its response budget.',413);
    return result;
  }
  function cancel(id){
    const job=store.cancelWorkJob(id);pending.delete(id);
    if(!TERMINAL.has(job.status))active.get(id)?.controller.abort();
    return publicJob(job);
  }
  function stopAll(){
    const jobs=[];let offset=0;
    for(;;){const page=store.listWorkJobs({offset,limit:20});for(const job of page.jobs)if(!TERMINAL.has(job.status))jobs.push(cancel(job.id));if(!page.hasMore)break;offset=page.nextOffset;}
    return{stopped:true,jobs};
  }
  function close(){
    if(closePromise)return closePromise;closed=true;clearInterval(timer);
    for(const id of pending.keys())store.finishWorkJob(id,{status:'interrupted',error:{code:'work_interrupted',message:'The application closed before this queued job ran. It was not resumed automatically.'}});
    pending.clear();for(const entry of active.values())entry.controller.abort();
    closePromise=Promise.allSettled([...active.values()].map(entry=>entry.promise)).then(()=>undefined);return closePromise;
  }
  return{create,list,get,cancel,stopAll,cancelAll:stopAll,close};
}
