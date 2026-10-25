import { createHash } from 'node:crypto';
import { windowContextReference } from './window-context.mjs';
import { normalizeProjectBinding, projectReference } from './project-files-context.mjs';
import {continuationReference} from './continuation-context.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ACTIVE=new Set(['queued','running']);
const TERMINAL=new Set(['completed','waiting_for_review','failed','cancelled','interrupted']);
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function text(value,max,label,empty=false){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))throw fail('invalid_work_input',`Use bounded ${label}.`);return value;}
function id(value){if(typeof value!=='string'||!UUID.test(value))throw fail('invalid_work_id','Choose an actual work job UUID.');return value;}
function optionalId(value){return value===undefined?null:id(value);}
function requestId(value){if(value===undefined)return null;if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))throw fail('invalid_work_input','Use a bounded origin request ID.');return value;}
function provider(value,providerId){
  if(value===undefined)return{id:providerId,label:providerId,type:'unknown',model:''};
  if(!object(value)||Object.keys(value).some(key=>!['id','label','type','model','baseUrl'].includes(key))||value.id!==providerId)throw fail('invalid_work_input','Use public provider metadata without credentials.');
  const result={id:providerId,label:text(value.label,100,'provider label'),type:text(value.type,40,'provider type'),model:text(value.model??'',160,'provider model',true)};
  if(value.baseUrl!==undefined){const url=text(value.baseUrl,4000,'provider URL');let parsed;try{parsed=new URL(url);}catch{throw fail('invalid_work_input','Use a public provider URL.');}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||Buffer.byteLength(JSON.stringify(url))>4100)throw fail('invalid_work_input','Do not include credentials in a provider URL.');result.baseUrl=url;}
  return result;
}

/** Isolated tables: jobs reference the existing durable conversation/effect ledger. */
export function installWorkStore({db,now=Date.now,conversationLimit=200,checkOpen=()=>{}}){
  db.exec(`CREATE TABLE IF NOT EXISTS work_jobs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,title TEXT NOT NULL,prompt TEXT NOT NULL,provider_id TEXT NOT NULL,provider_json TEXT NOT NULL,conversation_id TEXT UNIQUE NOT NULL,request_id TEXT UNIQUE NOT NULL,origin_conversation_id TEXT,origin_request_id TEXT,context_id TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,progress_json TEXT NOT NULL,error_json TEXT);`);
  if(!db.prepare('PRAGMA table_info(work_jobs)').all().some(column=>column.name==='window_context_json'))db.exec('ALTER TABLE work_jobs ADD COLUMN window_context_json TEXT');
  if(!db.prepare('PRAGMA table_info(work_jobs)').all().some(column=>column.name==='project_json'))db.exec('ALTER TABLE work_jobs ADD COLUMN project_json TEXT');
  if(!db.prepare('PRAGMA table_info(work_jobs)').all().some(column=>column.name==='continuation_json'))db.exec('ALTER TABLE work_jobs ADD COLUMN continuation_json TEXT');
  const transaction=callback=>{checkOpen();db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const row=jobId=>{checkOpen();const saved=db.prepare('SELECT * FROM work_jobs WHERE id=?').get(id(jobId));if(!saved)throw fail('work_not_found','That work job was not found.',404);return saved;};
  const instant=previous=>new Date(Math.max(now(),Date.parse(previous||0)+1||0)).toISOString();
  function progressEvent(saved,type,message,at){const previous=JSON.parse(saved.progress_json);return JSON.stringify({message,events:[...(previous.events||[]),{at,type,message}].slice(-40)});}
  function turnFor(saved){
    const turn=db.prepare('SELECT * FROM conversation_turns WHERE request_id=?').get(saved.request_id);
    if(!turn)return null;
    if(turn.conversation_id!==saved.conversation_id||turn.message!==saved.prompt.trim()||turn.provider_id!==saved.provider_id)throw fail('work_turn_conflict','The work job conversation identity does not match its original request.',409);
    if(saved.project_json&&turn.status!=='running'){
      const expected=JSON.parse(saved.project_json),outcome=turn.outcome_json?JSON.parse(turn.outcome_json):{},recorded=projectReference(outcome.projectContext);
      // A crash can precede the engine's first checkpoint. No file operation
      // was dispatched in that gap; retain the frozen job selection and stop.
      const beforeCheckpoint=!Object.hasOwn(outcome,'projectContext')&&turn.status==='interrupted'&&Array.isArray(outcome.actions)&&outcome.actions.length===0;
      if(!beforeCheckpoint&&(!recorded||recorded.projectId!==expected.projectId||recorded.grantEpoch!==expected.grantEpoch))throw fail('work_turn_conflict','The work result does not match its original project folder.',409);
    }
    return turn;
  }
  function reconcile(saved){
    if(!ACTIVE.has(saved.status))return saved;
    const turn=turnFor(saved);if(!turn||turn.status==='running')return saved;
    const outcome=turn.outcome_json?JSON.parse(turn.outcome_json):{};
    const status=turn.status==='completed'?((outcome.actions||[]).some(action=>action.status==='pending'||action.result?.desktopAction?.status==='pending')?'waiting_for_review':'completed'):turn.status;
    if(!TERMINAL.has(status))return saved;
    const at=turn.finished_at||instant(saved.updated_at),error=turn.status==='completed'?null:JSON.stringify({code:outcome.code||'work_failed',message:String(outcome.message||'The work stopped. Inspect retained actions.').slice(0,2000)});
    const progress=progressEvent(saved,status,status==='waiting_for_review'?'Stopped for human review.':status==='completed'?'Completed.':`Work ${status}.`,at);
    db.prepare('UPDATE work_jobs SET status=?,updated_at=?,finished_at=?,error_json=?,progress_json=? WHERE id=? AND status IN (\'queued\',\'running\')').run(status,at,at,error,progress,saved.id);
    return{...saved,status,updated_at:at,finished_at:at,error_json:error,progress_json:progress};
  }
  function dto(saved){
    saved=reconcile(saved);
    return{id:saved.id,title:saved.title,prompt:saved.prompt,providerId:saved.provider_id,provider:JSON.parse(saved.provider_json),conversationId:saved.conversation_id,requestId:saved.request_id,
      ...(saved.origin_conversation_id?{originConversationId:saved.origin_conversation_id}:{}),...(saved.origin_request_id?{originRequestId:saved.origin_request_id}:{}),...(saved.context_id?{contextId:saved.context_id}:{}),
      status:saved.status,createdAt:saved.created_at,updatedAt:saved.updated_at,...(saved.started_at?{startedAt:saved.started_at}:{}),...(saved.finished_at?{finishedAt:saved.finished_at}:{}),cancelRequested:saved.cancel_requested===1,progress:JSON.parse(saved.progress_json),...(saved.error_json?{error:JSON.parse(saved.error_json)}:{}),...(saved.window_context_json?{windowContext:JSON.parse(saved.window_context_json)}:{}),...(saved.project_json?{project:JSON.parse(saved.project_json)}:{}),...(saved.continuation_json?{continuation:JSON.parse(saved.continuation_json)}:{})};
  }
  function createWorkJob(value){
    if(!object(value)||Object.keys(value).some(key=>!['id','prompt','title','providerId','provider','originConversationId','originRequestId','contextId','windowContext','scope','project','continuation'].includes(key)))throw fail('invalid_work_input','Use supported work job fields.');
    const jobId=id(value.id),prompt=text(value.prompt,12000,'original prompt'),title=value.title===undefined?prompt.replace(/\s+/gu,' ').trim().slice(0,80):text(value.title,100,'job title'),providerId=text(value.providerId,100,'provider ID');
    const originConversationId=optionalId(value.originConversationId),originRequestId=requestId(value.originRequestId),contextId=optionalId(value.contextId);
    const continuation=value.continuation===undefined?null:continuationReference(value.continuation);if(value.continuation!==undefined&&(!continuation||continuation.workId!==jobId))throw fail('invalid_work_input','Use the original reserved continuation identity.');
    const project=value.project===undefined?null:projectReference(value.project);
    if(value.project!==undefined&&!project)throw fail('invalid_work_input','Use a valid frozen project binding.');
    const projectBinding=project?normalizeProjectBinding({projectId:project.projectId,grantEpoch:project.grantEpoch}):null;
    const hash=digest({id:jobId,prompt,title,providerId,originConversationId,originRequestId,contextId,...(projectBinding?{project:projectBinding}:{}),...(continuation?{continuation}:{})});
    return transaction(()=>{
      const existing=db.prepare('SELECT * FROM work_jobs WHERE id=?').get(jobId);if(existing){if(existing.hash!==hash)throw fail('work_conflict','That work job ID was already used for different input.',409);return{job:dto(existing),replayed:true};}
      if(db.prepare('SELECT count(*) AS count FROM work_jobs').get().count>=200)throw fail('work_history_limit','Keep at most 200 retained work jobs.',409);
      if(db.prepare("SELECT count(*) AS count FROM work_jobs WHERE status='queued'").get().count>=10)throw fail('work_queue_limit','Ten work jobs are already queued. Wait or cancel one before adding more.',429);
      if(db.prepare('SELECT count(*) AS count FROM conversations').get().count>=conversationLimit)throw fail('conversation_limit','This workspace reached its retained conversation limit.',409);
      if(db.prepare('SELECT id FROM conversations WHERE id=?').get(jobId)||db.prepare('SELECT id FROM chat_receipts WHERE id=?').get('work_'+jobId))throw fail('work_conflict','This job identity already belongs to another saved conversation or request.',409);
      const descriptor=provider(value.provider,providerId),at=instant(),context=value.windowContext===undefined?null:windowContextReference(value.windowContext);
      if(value.windowContext!==undefined&&(!context||context.contextId!==contextId))throw fail('invalid_work_input','Selected source metadata must match the original context ID.');
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run(jobId,title.slice(0,80),0,0,at,at,null,null);
      db.prepare('INSERT INTO work_jobs(id,hash,title,prompt,provider_id,provider_json,conversation_id,request_id,origin_conversation_id,origin_request_id,context_id,status,created_at,updated_at,progress_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId,hash,title,prompt,providerId,JSON.stringify(descriptor),jobId,'work_'+jobId,originConversationId,originRequestId,contextId,'queued',at,at,JSON.stringify({message:'Queued.',events:[{at,type:'queued',message:'Queued.'}]}));
      if(context)db.prepare('UPDATE work_jobs SET window_context_json=? WHERE id=?').run(JSON.stringify(context),jobId);
      if(project)db.prepare('UPDATE work_jobs SET project_json=? WHERE id=?').run(JSON.stringify(project),jobId);
      if(continuation)db.prepare('UPDATE work_jobs SET continuation_json=? WHERE id=?').run(JSON.stringify(continuation),jobId);
      return{job:dto(row(jobId)),replayed:false};
    });
  }
  function getWorkJob(jobId){return transaction(()=>dto(row(jobId)));}
  function listWorkJobs({offset=0,limit=20}={}){
    if(!Number.isSafeInteger(offset)||offset<0||offset>200||!Number.isSafeInteger(limit)||limit<1||limit>20)throw fail('invalid_work_page','Use a work page offset from 0 to 200 and a limit from 1 to 20.');
    return transaction(()=>{const all=db.prepare('SELECT * FROM work_jobs ORDER BY sequence DESC').all(),total=all.length;if(offset>total)throw fail('invalid_work_page','The work page offset is past the end.');const jobs=all.slice(offset,offset+limit).map(dto),next=offset+jobs.length;return{jobs,total,offset,limit,hasMore:next<total,nextOffset:next<total?next:null};});
  }
  function startWorkJob(jobId){return transaction(()=>{
    let saved=reconcile(row(jobId));if(saved.status!=='queued')return{job:dto(saved),started:false};
    for(const active of db.prepare("SELECT * FROM work_jobs WHERE status='running'").all())reconcile(active);
    if(db.prepare("SELECT count(*) AS count FROM work_jobs WHERE status='running'").get().count>=2)return{job:dto(saved),started:false};
    const at=instant(saved.updated_at);db.prepare("UPDATE work_jobs SET status='running',started_at=?,updated_at=?,progress_json=? WHERE id=? AND status='queued'").run(at,at,progressEvent(saved,'running','Running.',at),jobId);return{job:dto(row(jobId)),started:true};
  });}
  function progressWorkJob(jobId,value={}){return transaction(()=>{
    const saved=reconcile(row(jobId));if(saved.status!=='running')return dto(saved);
    const message=text(value.message??'Working.',500,'progress message',true),type=text(value.type??'progress',40,'progress type'),at=instant(saved.updated_at),progress=JSON.parse(saved.progress_json);
    progress.message=message;progress.events=[...(progress.events||[]),{at,type,message}].slice(-40);
    db.prepare('UPDATE work_jobs SET progress_json=?,updated_at=? WHERE id=?').run(JSON.stringify(progress),at,jobId);return dto(row(jobId));
  });}
  function finishWorkJob(jobId,{status,error}={}){return transaction(()=>{
    const saved=reconcile(row(jobId));if(TERMINAL.has(saved.status))return dto(saved);
    if(!TERMINAL.has(status))throw fail('invalid_work_status','Choose a terminal work status.');
    if(['completed','waiting_for_review'].includes(status))throw fail('work_turn_incomplete','A committed original conversation result is required before reporting work complete.',409);
    const at=instant(saved.updated_at),failure=error?{code:text(error.code??'work_failed',100,'error code'),message:text(error.message??'Work could not finish.',2000,'error message')}:null;
    db.prepare('UPDATE work_jobs SET status=?,updated_at=?,finished_at=?,error_json=?,progress_json=? WHERE id=?').run(status,at,at,failure?JSON.stringify(failure):null,progressEvent(saved,status,`Work ${status}.`,at),jobId);return dto(row(jobId));
  });}
  function cancelWorkJob(jobId){return transaction(()=>{
    const saved=reconcile(row(jobId));if(TERMINAL.has(saved.status))return dto(saved);
    if(saved.cancel_requested===1)return dto(saved);
    const at=instant(saved.updated_at);if(saved.status==='queued')db.prepare("UPDATE work_jobs SET status='cancelled',cancel_requested=1,updated_at=?,finished_at=?,progress_json=? WHERE id=?").run(at,at,progressEvent(saved,'cancelled','Cancelled before running.',at),jobId);
    else db.prepare('UPDATE work_jobs SET cancel_requested=1,updated_at=?,progress_json=? WHERE id=?').run(at,progressEvent(saved,'stop_requested','Stop requested. Waiting for the active turn to settle.',at),jobId);return dto(row(jobId));
  });}
  function getWorkJobTurn(jobId){const saved=row(jobId),turn=turnFor(saved);if(!turn)return null;const outcome=turn.outcome_json?JSON.parse(turn.outcome_json):{};return{id:turn.request_id,message:turn.message,providerId:turn.provider_id,status:turn.status,startedAt:turn.started_at,...(turn.finished_at?{finishedAt:turn.finished_at}:{}),actions:outcome.actions||[],...(outcome.windowContext?{windowContext:outcome.windowContext}:{}),...(turn.status==='completed'?{reply:outcome}:turn.status!=='running'?{error:outcome}:{})};}
  // A worker restart never repeats queued or uncertain effects. A committed
  // original turn is authoritative even if the job wrapper had not finalized.
  transaction(()=>{for(const saved of db.prepare("SELECT * FROM work_jobs WHERE status IN ('queued','running')").all()){const current=reconcile(saved);if(ACTIVE.has(current.status)){const at=instant(current.updated_at);db.prepare("UPDATE work_jobs SET status='interrupted',updated_at=?,finished_at=?,error_json=?,progress_json=? WHERE id=?").run(at,at,JSON.stringify({code:'work_interrupted',message:'The application restarted. Recorded actions remain; this job was not automatically resumed.'}),progressEvent(current,'interrupted','Interrupted by application restart.',at),current.id);}}});
  return{createWorkJob,listWorkJobs,getWorkJob,startWorkJob,progressWorkJob,finishWorkJob,cancelWorkJob,getWorkJobTurn};
}
