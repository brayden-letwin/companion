import path from 'node:path';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeProjectBinding, projectReference } from './project-files-context.mjs';
import { windowContextReference } from './window-context.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH=/^[a-f\d]{64}$/;
const STATES=new Set(['waiting_for_build','waiting_for_activation','waiting_for_runtime','ready','starting','queued','running','waiting_for_review','completed','failed','cancelled','interrupted','blocked']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function fields(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('invalid_continuation','Use only the captured follow-through fields.');}
function text(value,max,label,empty=false){if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||Buffer.from(value).toString('utf8')!==value)throw fail('invalid_continuation',`Use bounded ${label}.`);return value;}
function id(value){if(typeof value!=='string'||!UUID.test(value))throw fail('invalid_continuation_id','Use an actual follow-through UUID.');return value.toLowerCase();}
function requestId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))throw fail('invalid_continuation','Use the original request identity.');return value;}
function provider(value,providerId){
  fields(value,['id','label','type','model','baseUrl']);if(value.id!==providerId)throw fail('invalid_continuation','The provider snapshot must match its original ID.');
  const result={id:providerId,label:text(value.label??providerId,100,'provider label'),type:text(value.type,40,'provider type'),model:text(value.model??'',160,'provider model',true)};
  if(value.baseUrl!==undefined){const baseUrl=text(value.baseUrl,4000,'provider URL');let url;try{url=new URL(baseUrl);}catch{throw fail('invalid_continuation','Use public provider metadata.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('invalid_continuation','Provider metadata cannot contain credentials.');result.baseUrl=baseUrl;}
  return result;
}
export function continuationRuntime(value){
  if(value===undefined)return undefined;if(!object(value))throw fail('invalid_continuation','Use public runtime identity metadata.');
  const result={};
  for(const key of ['instance','workerInstanceId','hostInstanceId','supervisorInstanceId'])if(value[key]!==undefined)result[key]=text(value[key],100,'runtime identity');
  for(const key of ['pid','workerPid','hostPid','supervisorPid','port'])if(value[key]!==undefined){if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>2147483647)throw fail('invalid_continuation','Use actual runtime process identities.');result[key]=value[key];}
  for(const key of ['managed','hostRestartAvailable','supervised','restarting'])if(typeof value[key]==='boolean')result[key]=value[key];
  return result;
}
export function continuationProof(value){
  fields(value,['ready','reason','requiredCapabilities','runtime','sourceRevision','restartScope','buildStatus']);if(typeof value.ready!=='boolean')throw fail('invalid_continuation_proof','The host did not return a readiness decision.',502);
  const requiredCapabilities=value.requiredCapabilities??[];if(!Array.isArray(requiredCapabilities)||requiredCapabilities.length>40)throw fail('invalid_continuation_proof','Use bounded installed capability proofs.',502);
  const names=new Set(),pins=requiredCapabilities.map(pin=>{fields(pin,['name','id','version','hash']);if(typeof pin.name!=='string'||!/^cap_[a-z][a-z0-9_]{0,59}$/.test(pin.name)||names.has(pin.name)||typeof pin.id!=='string'||!/^[a-z][a-z0-9-]{0,59}$/.test(pin.id)||!Number.isSafeInteger(pin.version)||pin.version<1||!HASH.test(pin.hash))throw fail('invalid_continuation_proof','The capability proof is invalid.',502);names.add(pin.name);return{name:pin.name,id:pin.id,version:pin.version,hash:pin.hash};});
  const result={ready:value.ready,requiredCapabilities:pins,...(value.reason?{reason:text(value.reason,1000,'readiness reason')}:{})};
  if(value.runtime!==undefined)result.runtime=continuationRuntime(value.runtime);
  if(value.sourceRevision!==undefined&&value.sourceRevision!==null){if(typeof value.sourceRevision!=='string'||!HASH.test(value.sourceRevision))throw fail('invalid_continuation_proof','Use the actual source revision.',502);result.sourceRevision=value.sourceRevision;}
  if(value.restartScope!==undefined){if(!['none','worker','host','launcher'].includes(value.restartScope))throw fail('invalid_continuation_proof','Use a named runtime restart scope.',502);result.restartScope=value.restartScope;}
  if(value.buildStatus!==undefined)result.buildStatus=text(value.buildStatus,40,'build state');
  if(value.ready&&(!pins.length||!result.runtime||!Object.keys(result.runtime).length||!result.sourceRevision))throw fail('invalid_continuation_proof','Ready requires installed capability, runtime and source proofs.',502);
  return result;
}
function input(value){
  fields(value,['id','buildId','workId','origin','buildSpec']);fields(value.origin,['conversationId','requestId','requestDigest','message','providerId','provider','contextId','windowContext','project','runtime']);
  const origin=value.origin,providerId=text(origin.providerId,100,'provider ID');if(typeof origin.requestDigest!=='string'||!HASH.test(origin.requestDigest))throw fail('invalid_continuation','Retain the actual original request digest.');
  const saved={requestId:requestId(origin.requestId),requestDigest:origin.requestDigest,message:text(origin.message,12000,'original request'),providerId,provider:provider(origin.provider,providerId)};
  if(origin.conversationId!==undefined)saved.conversationId=id(origin.conversationId);
  if(origin.contextId!==undefined)saved.contextId=id(origin.contextId);
  if(origin.windowContext!==undefined){const source=windowContextReference(origin.windowContext);if(!source||source.contextId!==saved.contextId)throw fail('invalid_continuation','Selected source metadata must match its original pin.');saved.windowContext=source;}
  if(origin.project!==undefined){const selected=projectReference(origin.project);if(!selected)throw fail('invalid_continuation','Use the captured project grant.');saved.project=selected;}
  if(origin.runtime!==undefined)saved.runtime=continuationRuntime(origin.runtime);
  return{id:id(value.id),buildId:id(value.buildId),workId:id(value.workId),origin:saved,buildSpec:text(value.buildSpec,12000,'build specification')};
}
function identity(value){const source=value.origin;return{...value,origin:{...source,provider:{id:source.provider.id,type:source.provider.type,model:source.provider.model,...(source.provider.baseUrl?{baseUrl:source.provider.baseUrl}:{})},...(source.project?{project:normalizeProjectBinding({projectId:source.project.projectId,grantEpoch:source.project.grantEpoch})}:{}),windowContext:undefined,runtime:undefined}};}

/** Private intent/link ledger. It never executes models, builds or work. */
export async function createContinuationStore({dataDirectory,now=Date.now}={}){
  if(typeof dataDirectory!=='string'||!path.isAbsolute(dataDirectory))throw new TypeError('Use an absolute private runtime directory.');
  await mkdir(dataDirectory,{recursive:true,mode:0o700});const directory=await realpath(dataDirectory),file=path.join(directory,'continuations.sqlite');
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Follow-through state must be a regular private file.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const db=new DatabaseSync(path.toNamespacedPath(file));let closed=false;
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS continuations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,build_id TEXT UNIQUE NOT NULL,work_id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,record_json TEXT NOT NULL,origin_request_id TEXT NOT NULL,origin_digest TEXT NOT NULL);');
    const columns=new Set(db.prepare('PRAGMA table_info(continuations)').all().map(column=>column.name));
    if(!columns.has('origin_request_id'))db.exec('ALTER TABLE continuations ADD COLUMN origin_request_id TEXT');
    if(!columns.has('origin_digest'))db.exec('ALTER TABLE continuations ADD COLUMN origin_digest TEXT');
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const row of db.prepare('SELECT id,record_json,origin_request_id,origin_digest FROM continuations').all()){
        const record=JSON.parse(row.record_json),originId=requestId(record.origin?.requestId),originDigest=record.origin?.requestDigest;
        if(typeof originDigest!=='string'||!HASH.test(originDigest)||row.origin_request_id!==null&&row.origin_request_id!==originId||row.origin_digest!==null&&row.origin_digest!==originDigest)throw fail('continuation_history_conflict','The retained original-request identity needs recovery review.',409);
        if(row.origin_request_id===null||row.origin_digest===null)db.prepare('UPDATE continuations SET origin_request_id=?,origin_digest=? WHERE id=?').run(originId,originDigest,row.id);
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS continuations_original_request ON continuations(origin_request_id,origin_digest); COMMIT;');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }catch(error){db.close();throw error;}
  const check=()=>{if(closed)throw fail('continuation_store_closed','Follow-through state is closed.',503);};
  const transaction=callback=>{check();db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const instant=previous=>{const timestamp=now();if(!Number.isFinite(timestamp))throw new TypeError('Use a finite clock.');return new Date(Math.max(timestamp,Date.parse(previous||0)+1||0)).toISOString();};
  const find=(column,value)=>{check();const row=db.prepare(`SELECT * FROM continuations WHERE ${column}=?`).get(id(value));return row?{row,record:JSON.parse(row.record_json)}:null;};
  const get=value=>{const saved=find('id',value);if(!saved)throw fail('continuation_not_found','That follow-through was not found.',404);return clone(saved.record);};
  function save(record){if(!STATES.has(record.status)||Buffer.byteLength(JSON.stringify(record))>256*1024)throw fail('invalid_continuation','Follow-through metadata exceeds its bounds.');record.updatedAt=instant(record.updatedAt);db.prepare('UPDATE continuations SET record_json=? WHERE id=?').run(JSON.stringify(record),record.id);return clone(record);}
  function update(value,patch){return transaction(()=>{fields(patch,['status','buildStatus','workStatus','readiness','proof','reason','error','cancelRequested','buildAttempted','startClaimed','work','originBlocked','startedAt','finishedAt']);const record=get(value),previous=JSON.stringify(record);for(const[key,item]of Object.entries(patch)){if(item===undefined)delete record[key];else record[key]=clone(item);}if(patch.proof)record.proof=continuationProof(patch.proof);if(patch.readiness)record.readiness=continuationProof(patch.readiness);return JSON.stringify(record)===previous?record:save(record);});}
  function reserve(value){const captured=input(value),digest=hash(identity(captured));return transaction(()=>{
    const prior=find('id',captured.id);if(prior){if(prior.row.digest!==digest)throw fail('continuation_conflict','That follow-through identity belongs to a different original request.',409);return{record:clone(prior.record),replayed:true};}
    if(db.prepare('SELECT id FROM continuations WHERE origin_request_id=? AND origin_digest=?').get(captured.origin.requestId,captured.origin.requestDigest))throw fail('continuation_conflict','This original request already has a linked build and follow-through.',409);
    if(find('build_id',captured.buildId)||find('work_id',captured.workId))throw fail('continuation_conflict','The reserved build or work identity is already linked.',409);
    if(db.prepare('SELECT count(*) AS count FROM continuations').get().count>=200)throw fail('continuation_limit','Keep at most 200 retained follow-through links.',409);
    const at=instant(),record={...captured,status:'waiting_for_build',createdAt:at,updatedAt:at,cancelRequested:false,buildAttempted:false,startClaimed:false,readiness:{ready:false,requiredCapabilities:[],reason:'The feature build has not finished.'}};
    db.prepare('INSERT INTO continuations(id,build_id,work_id,digest,record_json,origin_request_id,origin_digest) VALUES(?,?,?,?,?,?,?)').run(record.id,record.buildId,record.workId,digest,JSON.stringify(record),record.origin.requestId,record.origin.requestDigest);return{record:clone(record),replayed:false};
  });}
  function claim(value,proof){const checked=continuationProof(proof);return transaction(()=>{const record=get(value);if(record.startClaimed)return{claimed:false,record};if(record.cancelRequested||record.status==='cancelled')throw fail('continuation_cancelled','This follow-through was stopped.',499);if(record.status!=='ready'||!checked.ready)throw fail('continuation_not_ready','The original request is not ready to continue.',409);record.startClaimed=true;record.status='starting';record.proof=checked;record.readiness=checked;record.startedAt=instant();return{claimed:true,record:save(record)};});}
  function cancel(value){return transaction(()=>{const record=get(value);record.cancelRequested=true;if(!record.startClaimed&&!['completed','failed','interrupted'].includes(record.status)){record.status='cancelled';record.reason='The follow-through was stopped. The separate coding build may still exist.';}return save(record);});}
  function list({offset=0,limit=20}={}){check();if(!Number.isSafeInteger(offset)||offset<0||offset>200||!Number.isSafeInteger(limit)||limit<1||limit>20)throw fail('invalid_continuation_page','Use bounded follow-through paging.');const rows=db.prepare('SELECT record_json FROM continuations ORDER BY sequence DESC').all();if(offset>rows.length)throw fail('invalid_continuation_page','The follow-through offset is past the end.');const records=rows.slice(offset,offset+limit).map(row=>JSON.parse(row.record_json)),next=offset+records.length;return{records,total:rows.length,offset,limit,hasMore:next<rows.length,nextOffset:next<rows.length?next:null};}
  // A restart never dispatches an uncertain attempt, even if its callback had
  // not yet returned an acknowledgement. Reconciliation only reads workId.
  transaction(()=>{for(const row of db.prepare('SELECT record_json FROM continuations').all()){const record=JSON.parse(row.record_json);if(record.status==='starting'){record.status='interrupted';record.reason='The previous follow-through start was not confirmed. Check its original work identity.';save(record);}}});
  return{reserve,get,update,claim,cancel,list,getByBuild(value){return clone(find('build_id',value)?.record??null);},getByWork(value){return clone(find('work_id',value)?.record??null);},close(){if(closed)return;closed=true;db.close();}};
}
