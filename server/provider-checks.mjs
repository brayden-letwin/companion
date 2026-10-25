import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,rm,lstat,realpath} from 'node:fs/promises';
import {privateDataDirectory,normalizeProviderUrl} from './provider-settings.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i,PROVIDER=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_RECORDS=200,MAX_BYTES=1024*1024;
const ACTIVE=new Set(['queued','running','stopping']),STATES=new Set([...ACTIVE,'passed','failed','cancelled','interrupted','stale']);
const TYPES=new Set(['codex','openai','anthropic','compatible','ollama']);
const MESSAGES={provider_check_failed:'The connection check could not finish. Check this provider’s settings before testing again.',provider_check_cancelled:'The connection check was cancelled.',provider_check_interrupted:'Companion restarted before this check finished. It was not retried.',provider_configuration_changed:'This provider configuration changed. Test the current configuration explicitly.',provider_metadata_unavailable:'The saved provider metadata could not be checked.',provider_check_history_limit:'The retained connection-check history has reached its storage limit.',provider_credentials_rejected:'The provider rejected its credentials. Update the key before testing again.',provider_key_required:'Save an API key for this provider before testing it.',provider_unavailable:'The selected provider could not be reached or did not complete the check.',provider_busy:'The AI connection is busy. Wait for current work to finish or stop it before testing again.',provider_rate_limited:'The provider is rate limited or has no available credit. Try again later.',provider_timeout:'The connection check timed out. A stopping helper must finish before another test.',provider_output_limit:'The provider returned more data than this small check permits.',invalid_provider_response:'The provider did not return a valid completion for this check.',incomplete_provider_response:'The provider did not finish the small test completion.',provider_probe_mismatch:'The provider did not return the expected small test response.',probe_response_mismatch:'The provider did not return the expected small test response.',unexpected_provider_action:'The provider attempted an action outside this tool-free check.',credential_storage_unavailable:'The saved key could not be unlocked for this user.',provider_not_found:'This provider was removed or is unavailable.'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),clone=value=>structuredClone(value);
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const cancelled=()=>Object.assign(fail('request_cancelled','The connection check was stopped.',499),{name:'AbortError'});
function fields(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('invalid_provider_check','Use only the connection-check identity and saved configuration.');}
function identifier(value){if(typeof value!=='string'||!UUID.test(value))throw fail('invalid_provider_check','Use an actual connection-check UUID.');return value.toLowerCase();}
function providerId(value){if(typeof value!=='string'||!PROVIDER.test(value))throw fail('invalid_provider_check','Use a saved provider ID.');return value;}
const safeText=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value)&&Buffer.from(value).toString('utf8')===value;
const safeError=error=>{const code=error?.code==='provider_changed'?'provider_configuration_changed':Object.hasOwn(MESSAGES,error?.code)?error.code:'provider_check_failed';return{code,message:MESSAGES[code]};};
const errorFor=code=>({code,message:MESSAGES[code]});
function providerSnapshot(value){
  if(!object(value)||Object.hasOwn(value,'apiKey')||Object.hasOwn(value,'protectedKey')||!PROVIDER.test(value.id||'')||!UUID.test(value.revision||'')||!TYPES.has(value.type)||!safeText(value.label,100)||!safeText(value.model,160))throw fail('provider_metadata_unavailable',MESSAGES.provider_metadata_unavailable,503);
  const result={id:value.id,type:value.type,label:value.label,model:value.model,revision:value.revision};
  if(value.baseUrl!==undefined){if(!safeText(value.baseUrl,4000)||normalizeProviderUrl(value.baseUrl)!==value.baseUrl)throw fail('provider_metadata_unavailable',MESSAGES.provider_metadata_unavailable,503);result.baseUrl=value.baseUrl;}
  return result;
}
function validRecord(record){
  fields(record,['id','providerId','revision','provider','status','createdAt','updatedAt','startedAt','finishedAt','sessionId','error','stopReason']);
  if(identifier(record.id)!==record.id||providerId(record.providerId)!==record.providerId||!UUID.test(record.revision||'')||!UUID.test(record.sessionId||'')||!STATES.has(record.status))throw new Error('Invalid retained identity.');
  for(const key of['createdAt','updatedAt','startedAt','finishedAt'])if(record[key]!==undefined&&(!safeText(record[key],40)||!Number.isFinite(Date.parse(record[key]))))throw new Error('Invalid retained time.');
  if(!record.createdAt||!record.updatedAt)throw new Error('Missing retained time.');
  if(record.provider!==undefined){fields(record.provider,['id','type','label','model','baseUrl','revision']);const snapshot=providerSnapshot(record.provider);if(snapshot.id!==record.providerId||snapshot.revision!==record.revision)throw new Error('Mismatched retained configuration.');}
  if(record.error!==undefined){fields(record.error,['code','message']);if(!Object.hasOwn(MESSAGES,record.error.code)||record.error.message!==MESSAGES[record.error.code])throw new Error('Unexpected retained diagnostic.');}
  if(record.stopReason!==undefined&&!['cancelled','failed','stale','interrupted'].includes(record.stopReason))throw new Error('Invalid retained stop state.');
  if(['running','passed'].includes(record.status)&&!record.provider)throw new Error('Missing tested provider.');return record;
}

/** Durable, context-free checks. Never owns workspace tools or user conversations. */
export async function createProviderCheckService({dataDirectory,listProviders,probeConnection,now=Date.now,timeoutMs=60000}={}){
  if(typeof listProviders!=='function'||typeof probeConnection!=='function'||typeof now!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new TypeError('Use trusted provider metadata/probe callbacks and a bounded deadline.');
  const directory=await privateDataDirectory(dataDirectory),filename=path.join(directory,'provider-checks.json'),sessionId=randomUUID(),records=new Map(),entries=new Map(),providerEpochs=new Map();let closed=false,stopEpoch=0,writes=Promise.resolve(),storageError=null,closePromise;
  const instant=previous=>{const time=now(),prior=previous?Date.parse(previous):NaN;if(!Number.isFinite(time))throw new TypeError('Use a finite clock.');return new Date(Math.max(time,Number.isFinite(prior)?prior+1:time)).toISOString();};
  const touch=record=>{record.updatedAt=instant(record.updatedAt);};
  const snapshot=()=>{const payload=JSON.stringify({version:1,checks:[...records.values()]});if(Buffer.byteLength(payload)>MAX_BYTES)throw fail('provider_check_history_limit',MESSAGES.provider_check_history_limit,429);return payload;};
  try{
    const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1||info.size>MAX_BYTES||(await realpath(filename))!==filename)throw new Error('Invalid retained file.');
    const bytes=await readFile(filename);if(bytes.length>MAX_BYTES)throw new Error('Oversized retained file.');const saved=JSON.parse(bytes.toString('utf8'));fields(saved,['version','checks']);if(saved.version!==1||!Array.isArray(saved.checks)||saved.checks.length>MAX_RECORDS)throw new Error('Invalid retained checks.');
    for(const value of saved.checks){const record=validRecord(value);if(records.has(record.id))throw new Error('Duplicate retained identity.');records.set(record.id,record);}
  }catch(error){if(error.code!=='ENOENT')throw fail('provider_checks_unavailable','Connection-check history could not be read safely. Retain its file for review.',503);}
  function persist(){
    let payload;try{payload=snapshot();}catch(error){storageError=error;return Promise.reject(error);}
    const work=writes.then(async()=>{const temporary=path.join(directory,'.provider-checks-'+randomUUID()+'.tmp');try{await writeFile(temporary,payload,{flag:'wx',mode:0o600});for(let attempt=0;;attempt++){try{await rename(temporary,filename);break;}catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,20*(attempt+1)));}}}finally{await rm(temporary,{force:true}).catch(()=>{});}});
    writes=work.catch(()=>{storageError=fail('provider_checks_unavailable','Connection-check history could not be saved. Retain its file for review.',503);});return work.catch(()=>{throw storageError;});
  }
  let recovered=false;for(const record of records.values())if(ACTIVE.has(record.status)){record.status='interrupted';record.error=errorFor('provider_check_interrupted');record.finishedAt=instant();delete record.stopReason;touch(record);recovered=true;}if(recovered)await persist();
  async function metadata(){const values=await listProviders();if(!Array.isArray(values)||values.length>20)throw fail('provider_metadata_unavailable',MESSAGES.provider_metadata_unavailable,503);const result=values.map(providerSnapshot);if(new Set(result.map(value=>value.id)).size!==result.length)throw fail('provider_metadata_unavailable',MESSAGES.provider_metadata_unavailable,503);return result;}
  async function publicCheck(record,providers){
    if(providers===undefined)try{providers=await metadata();}catch{providers=[];}
    return{id:record.id,providerId:record.providerId,revision:record.revision,provider:record.provider?clone(record.provider):null,status:record.status,createdAt:record.createdAt,updatedAt:record.updatedAt,...(record.startedAt?{startedAt:record.startedAt}:{}),...(record.finishedAt?{finishedAt:record.finishedAt}:{}),...(record.error?{error:clone(record.error)}:{}),configurationMatches:providers.some(value=>value.id===record.providerId&&value.revision===record.revision),observedThisSession:record.sessionId===sessionId,completionOnly:true,scope:'app_configuration'};
  }
  const found=value=>{const record=records.get(identifier(value));if(!record)throw fail('provider_check_not_found','That connection check was not found.',404);return record;};
  function stop(entry,reason,code){
    const record=records.get(entry.id);if(!ACTIVE.has(record.status))return;
    record.stopReason??=reason;record.error??=errorFor(code);record.status=entry.probeStarted?'stopping':record.stopReason;touch(record);if(!entry.probeStarted)record.finishedAt=instant();entry.controller.abort();
  }
  function blocked(entry,signal){return closed||signal?.aborted||entry.epoch!==stopEpoch||entry.providerEpoch!==(providerEpochs.get(entry.providerId)||0)||records.get(entry.id).stopReason!==undefined;}
  async function finish(record,status,error){record.status=status;record.finishedAt=instant();if(error)record.error=error;else delete record.error;delete record.stopReason;touch(record);await persist();}
  async function runProbe(entry){
    const record=records.get(entry.id);
    try{
      const providers=await metadata();if(blocked(entry)){if(ACTIVE.has(record.status))await finish(record,record.stopReason||'cancelled',record.error||errorFor('provider_check_cancelled'));return;}
      const provider=providers.find(value=>value.id===record.providerId);if(!provider||provider.revision!==record.revision){await finish(record,'stale',errorFor('provider_configuration_changed'));return;}
      const previous=record.provider;record.provider=provider;try{snapshot();}catch(error){if(previous)record.provider=previous;else delete record.provider;throw error;}
      record.status='running';record.startedAt=instant();touch(record);await persist();
      if(blocked(entry)){await finish(record,record.stopReason||'cancelled',record.error||errorFor('provider_check_cancelled'));return;}
      // Re-read after persistence: configuration can change during async I/O.
      const current=(await metadata()).find(value=>value.id===record.providerId);if(blocked(entry)){await finish(record,record.stopReason||'cancelled',record.error||errorFor('provider_check_cancelled'));return;}if(!current||current.revision!==record.revision){await finish(record,'stale',errorFor('provider_configuration_changed'));return;}
      entry.admitted=true;entry.signal?.removeEventListener('abort',entry.cancelAdmission);entry.probeStarted=true;
      let value,error;
      try{value=await probeConnection({providerId:record.providerId,expectedRevision:record.revision,signal:entry.controller.signal,onStopping(){if(ACTIVE.has(record.status)){record.status='stopping';touch(record);void persist().catch(()=>{});}}});}catch(cause){error=cause;}
      const stopped=record.stopReason;
      if(stopped){await finish(record,stopped,record.error||errorFor('provider_check_cancelled'));return;}
      const after=(await metadata()).find(provider=>provider.id===record.providerId);
      if(record.stopReason){await finish(record,record.stopReason,record.error||errorFor('provider_check_cancelled'));return;}
      if(blocked(entry)||!after||after.revision!==record.revision){await finish(record,'stale',errorFor('provider_configuration_changed'));return;}
      if(error){const diagnostic=safeError(error);await finish(record,diagnostic.code==='provider_configuration_changed'?'stale':error.name==='AbortError'?'cancelled':'failed',error.name==='AbortError'?errorFor('provider_check_cancelled'):diagnostic);return;}
      if(record.status==='stopping'||!object(value)||Object.keys(value).some(key=>!['passed','providerId','revision'].includes(key))||value.passed!==true||value.providerId!==record.providerId||value.revision!==record.revision){await finish(record,'failed',errorFor('invalid_provider_response'));return;}
      await finish(record,'passed');
    }catch(error){if(ACTIVE.has(record.status))await finish(record,record.stopReason||'failed',record.error||safeError(error));}
    finally{clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.cancelAdmission);if(entries.get(entry.id)===entry)entries.delete(entry.id);}
  }
  async function start(input,{signal}={}){
    fields(input,['id','providerId','revision']);const id=identifier(input.id),target=providerId(input.providerId);if(typeof input.revision!=='string'||!UUID.test(input.revision))throw fail('invalid_provider_check','Use the saved provider configuration revision.');
    const previous=records.get(id);if(previous){if(previous.providerId!==target||previous.revision!==input.revision)throw fail('provider_check_conflict','That check ID belongs to a different provider configuration.',409);if(entries.get(id)?.admission)await entries.get(id).admission;return get(id);}
    if(closed||signal?.aborted)throw cancelled();if(storageError)throw storageError;if(records.size>=MAX_RECORDS)throw fail('provider_check_history_limit',MESSAGES.provider_check_history_limit,429);
    if([...records.values()].some(record=>record.providerId===target&&ACTIVE.has(record.status)))throw fail('provider_check_active','A check for this provider is already running or stopping. Inspect that original check.',409);
    const at=instant(),record={id,providerId:target,revision:input.revision,status:'queued',createdAt:at,updatedAt:at,sessionId};records.set(id,record);try{snapshot();}catch(error){records.delete(id);throw error;}const entry={id,providerId:target,epoch:stopEpoch,providerEpoch:providerEpochs.get(target)||0,controller:new AbortController(),probeStarted:false,signal,task:null,admission:null};entries.set(id,entry);
    entry.cancelAdmission=()=>{if(!entry.admitted){stop(entry,'cancelled','provider_check_cancelled');void persist().catch(()=>{});}};signal?.addEventListener('abort',entry.cancelAdmission,{once:true});
    entry.timer=setTimeout(()=>{if(ACTIVE.has(record.status)){stop(entry,'failed','provider_timeout');void persist().catch(()=>{});}},timeoutMs);entry.timer.unref?.();
    const admission=(async()=>{try{await persist();if(blocked(entry,signal)){stop(entry,'cancelled','provider_check_cancelled');await persist();return;}entry.task=runProbe(entry);void entry.task.catch(()=>{});}catch(error){throw error;}finally{if(!entry.task){clearTimeout(entry.timer);signal?.removeEventListener('abort',entry.cancelAdmission);entries.delete(id);}}})();entry.admission=admission;await admission;return get(id);
  }
  async function settledWrites(){for(;;){const pending=writes;await pending;if(pending===writes)break;}if(storageError)throw storageError;}
  async function get(value){const record=found(value);let providers;try{providers=await metadata();}catch{providers=[];}await settledWrites();return{check:await publicCheck(clone(record),providers)};}
  async function list(){const providers=await metadata();await settledWrites();const ids=new Set(providers.map(provider=>provider.id)),latest=new Map();for(const record of records.values())if(ids.has(record.providerId))latest.set(record.providerId,clone(record));const checks=[];for(const record of latest.values())checks.push(await publicCheck(record,providers));return{checks,total:checks.length};}
  async function cancel(value){const record=found(value),entry=entries.get(record.id);if(entry)stop(entry,'cancelled','provider_check_cancelled');else if(ACTIVE.has(record.status))await finish(record,'interrupted',errorFor('provider_check_interrupted'));await persist();return{check:await publicCheck(record,[])};}
  async function stopAll(){stopEpoch++;const selected=[];for(const entry of entries.values())if(ACTIVE.has(records.get(entry.id).status)){stop(entry,'cancelled','provider_check_cancelled');selected.push(entry.id);}let persistenceUnavailable=false;try{await persist();}catch{persistenceUnavailable=true;}return{stopped:selected.length,checks:await Promise.all(selected.map(id=>publicCheck(records.get(id),[]))),...(persistenceUnavailable?{persistenceUnavailable:true}:{})};}
  async function invalidateProvider(value){const target=providerId(value);providerEpochs.set(target,(providerEpochs.get(target)||0)+1);for(const entry of entries.values())if(entry.providerId===target)stop(entry,'stale','provider_configuration_changed');await persist();return{invalidated:target};}
  function close(){if(closePromise)return closePromise;closed=true;stopEpoch++;for(const entry of entries.values())stop(entry,'interrupted','provider_check_interrupted');closePromise=(async()=>{let failure;try{await persist();}catch(error){failure=error;}await Promise.allSettled([...entries.values()].map(entry=>entry.task||entry.admission));await writes;if(failure)throw failure;})();return closePromise;}
  return{start,get,list,cancel,stopAll,invalidateProvider,close};
}
