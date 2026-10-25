import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir,realpath,lstat,rm } from 'node:fs/promises';
import { createProjectFilesStore } from './project-files-store.mjs';
import { createProjectFileNative } from './project-files-native.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i,HASH=/^[a-f\d]{64}$/;
const MAX_PAGE=49152,MAX_BACKUPS=67108864,EDIT_RESERVATION=532000;
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))).digest('hex');
const stopped=()=>Object.assign(fail('request_cancelled','The file operation was stopped. Inspect its retained receipt before retrying.',499),{name:'AbortError'});
const id=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail('invalid_project_id','Use an actual project or edit UUID.');return value;};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('invalid_project_query','Use the returned offsets and bounded limits.');return value;};
const fields=(value,allowed)=>{if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('invalid_project_arguments','Use only fields for this file operation.');};
function binding(value){fields(value,['projectId','grantEpoch']);id(value.projectId);integer(value.grantEpoch,1,Number.MAX_SAFE_INTEGER);return{projectId:value.projectId.toLowerCase(),grantEpoch:value.grantEpoch};}
function relative(value,empty=false){
  if(typeof value!=='string'||value.length>240||(!value&&!empty)||/[\\:\u0000-\u001f\u007f<>"|?*~]/u.test(value)||value.startsWith('/')||Buffer.from(value).toString('utf8')!==value)throw fail('invalid_project_path','Use a relative slash-separated project path.');
  if(!value&&empty)return value;
  for(const part of value.split('/'))if(!part||part.startsWith('.')||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||/^(?:node_modules|credentials?|secrets?|sessions?|backups?|id_rsa|id_ed25519|auth\.json|tokens?(?:\..*)?)$/i.test(part)||/\.(?:pem|key|pfx|p12)$/i.test(part))throw fail('invalid_project_path','Hidden, credential and unsafe paths are outside project-file access.');
  return value;
}
function text(value,max,nonempty=false){if(typeof value!=='string'||value.length>max||value.includes('\0')||Buffer.from(value).toString('utf8')!==value||nonempty&&!value)throw fail('invalid_project_arguments','Provide bounded exact UTF-8 text.');return value;}
function expected(value,nullable=false){if(nullable&&value===null)return null;if(typeof value!=='string'||!HASH.test(value))throw fail('invalid_project_arguments','Use the exact file SHA-256 hash, or null only for a new file.');return value;}
const publicProject=(grant,available=true,local=false)=>({projectId:grant.projectId,grantEpoch:grant.grantEpoch,label:grant.label,mode:'read_write',available:available&&!grant.revoked,...(grant.revoked?{revoked:true}:{}),...(local?{localPath:grant.canonicalPath}:{})});
const high=(text,index)=>{const code=text.charCodeAt(index);return code>=0xd800&&code<=0xdbff;},low=(text,index)=>{const code=text.charCodeAt(index);return code>=0xdc00&&code<=0xdfff;};
const boundary=(text,index)=>index>0&&index<text.length&&high(text,index-1)&&low(text,index)?index-1:index;
function lineEndings(content){const pair=content.includes('\r\n'),rest=content.replaceAll('\r\n',''),styles=[pair&&'crlf',rest.includes('\r')&&'cr',rest.includes('\n')&&'lf'].filter(Boolean);return styles.length>1?'mixed':styles[0]||'none';}
function captured(value){
  if(!object(value)||typeof value.content!=='string'||typeof value.hash!=='string'||!HASH.test(value.hash))throw fail('invalid_project_response','The file reader returned invalid text.',502);
  const bytes=Buffer.from(value.content,'utf8');
  if(bytes.length>250000||bytes.includes(0)||bytes.toString('utf8')!==value.content||bytes.length!==value.byteLength||value.characterLength!==value.content.length||hash(bytes)!==value.hash||value.lineEndings!==lineEndings(value.content)||value.bom!==value.content.startsWith('\ufeff')||typeof value.readAt!=='string'||!Number.isFinite(Date.parse(value.readAt)))throw fail('invalid_project_response','The file reader returned mismatched text metadata.',502);
  return value;
}
function pageText(value,base,{offset=0,limit=12000,expectedHash,requireHash=true}={}){
  const source=captured(value);integer(offset,0,250000);integer(limit,1,12000);
  if(expectedHash!==undefined)expected(expectedHash);if(offset>0&&requireHash&&expectedHash===undefined)throw fail('invalid_project_query','Continuation reads require their original expectedHash.');
  if(expectedHash!==undefined&&expectedHash!==source.hash)throw fail('project_file_conflict','The file changed. Start a new read before combining pages.',409);
  if(offset>source.content.length||boundary(source.content,offset)!==offset)throw fail('invalid_project_query','The offset is past the end or splits a Unicode character.');
  let end=boundary(source.content,Math.min(source.content.length,offset+limit));if(offset<source.content.length&&end===offset)throw fail('invalid_project_query','Use a limit of at least two for this Unicode character.');
  const make=stop=>({...base,hash:source.hash,content:source.content.slice(offset,stop),offset,nextOffset:stop<source.content.length?stop:null,hasMore:stop<source.content.length,characterLength:source.characterLength,byteLength:source.byteLength,readAt:source.readAt,sourceTrust:'untrusted_project_file',lineEndings:source.lineEndings,bom:source.bom});
  if(Buffer.byteLength(JSON.stringify(make(end)))>MAX_PAGE){let min=offset,max=end;while(min<max){const candidate=Math.ceil((min+max)/2);if(Buffer.byteLength(JSON.stringify(make(boundary(source.content,candidate))))<=MAX_PAGE)min=candidate;else max=candidate-1;}end=boundary(source.content,min);}
  const result=make(end);if(offset<source.content.length&&end<=offset||Buffer.byteLength(JSON.stringify(result))>MAX_PAGE)throw fail('project_output_limit','This file page exceeds its response budget.',413);return result;
}
function nativeError(error){
  if(error?.name==='AbortError')return stopped();
  const code=typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(error.code)?error.code:'project_file_failed',statusCode=Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<=599?error.statusCode:503;
  const messages={project_file_conflict:'The file changed. Read its current hash before editing.',file_conflict:'The file changed. Read its current hash before editing.',file_locked:'The file is in use. Close the editor or try again later.',project_root_changed:'The selected folder changed. Choose it again.',project_path_unsafe:'This path is outside safe project-file access.',project_recovery_required:'The edit needs recovery review. Its retained backup has not been discarded.'};
  return Object.assign(fail(code,messages[code]||'The project-file operation could not finish. Inspect its retained receipt before retrying.',statusCode),{outcomeUnknown:error?.outcomeUnknown===true});
}

/** One local OS-user workspace: selected folders are shared with connected AI tools. */
export async function createProjectFileService({root,dataDirectory,native,now=Date.now}={}){
  if(native!==undefined&&(!native||typeof native.chooseFolder!=='function'||typeof native.run!=='function'))throw new TypeError('Use the trusted native project-files adapter.');
  const sourceRoot=await realpath(root);if(typeof dataDirectory!=='string'||!path.isAbsolute(dataDirectory))throw new TypeError('Use an absolute private runtime directory.');
  await mkdir(dataDirectory,{recursive:true,mode:0o700});const runtimeRoot=await realpath(dataDirectory),inside=(child,parent)=>child.toLowerCase()===parent.toLowerCase()||child.toLowerCase().startsWith(parent.toLowerCase()+path.sep);
  if(inside(runtimeRoot,sourceRoot))throw new TypeError('Project-file state must stay outside application source.');
  const directory=path.join(runtimeRoot,'project-files'),editsDirectory=path.join(directory,'edits');await mkdir(editsDirectory,{recursive:true,mode:0o700});
  native ||= await createProjectFileNative({root:sourceRoot,dataDirectory:runtimeRoot});
  let store;try{store=await createProjectFilesStore({dataDirectory:directory,now});}catch(error){await Promise.resolve().then(()=>native.close?.()).catch(()=>{});throw error;}
  const protectedRoots=[sourceRoot,runtimeRoot],active=new Set(),writers=new Map(),listeners=new Set();let closed=false,closePromise;
  const check=signal=>{if(signal?.aborted)throw stopped();if(closed)throw fail('project_files_closed','Project files are shutting down.',503);};
  const editDirectory=editId=>path.join(editsDirectory,id(editId));
  function withActive(selected,signal,callback){check(signal);if(active.size>=8)throw fail('project_files_busy','Too many project-file operations are active.',429);const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();const entry={binding:selected,controller,promise:null};active.add(entry);entry.promise=Promise.resolve().then(()=>callback(controller.signal)).finally(()=>{signal?.removeEventListener('abort',abort);active.delete(entry);});return entry.promise;}
  async function validateGrant(selected,signal){check(signal);const grant=store.getGrant(selected.projectId);if(grant.revoked||grant.grantEpoch!==selected.grantEpoch)throw fail('project_grant_changed','Project access was removed or changed. Choose an approved folder again.',409);let observed;try{observed=await native.run('inspectRoot',{path:grant.canonicalPath,protectedRoots},{signal});}catch(error){throw nativeError(error);}check(signal);const current=store.getGrant(selected.projectId);if(current.revoked||current.grantEpoch!==selected.grantEpoch||observed?.canonicalPath!==grant.canonicalPath||observed?.identity!==grant.identity)throw fail('project_grant_changed','The selected folder or its access changed. Choose it again.',409);return grant;}
  const common=grant=>({root:grant.canonicalPath,rootIdentity:grant.identity,protectedRoots});
  const metadata=edit=>({...edit.result||{id:edit.id,projectId:edit.projectId,grantEpoch:edit.grantEpoch,path:edit.path,status:edit.state,beforeHash:null,afterHash:null,bytes:0,undoAvailable:false,...(['pending','recovery_required'].includes(edit.state)?{outcomeUnknown:true}:{})},createdAt:edit.createdAt,updatedAt:edit.updatedAt,...(edit.pruned?{undoAvailable:false,backupsRetained:false}:{}),...(edit.error?{error:edit.error}:{})});
  function mutationResult(value,edit){
    if(!object(value)||value.id!==edit.id||value.path!==edit.path||!['applied','interrupted','recovery_required'].includes(value.status)||![value.beforeHash,value.afterHash].every(item=>item===null||typeof item==='string'&&HASH.test(item))||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>250000||typeof value.undoAvailable!=='boolean')throw Object.assign(fail('invalid_project_response','The native edit returned invalid outcome metadata.',502),{outcomeUnknown:true});
    return{id:edit.id,projectId:edit.projectId,grantEpoch:edit.grantEpoch,path:edit.path,status:value.status,beforeHash:value.beforeHash,afterHash:value.afterHash,bytes:value.bytes,undoAvailable:value.status==='applied'&&value.undoAvailable,...(value.outcomeUnknown||value.status==='recovery_required'?{outcomeUnknown:true}:{}),...(typeof value.created==='boolean'?{created:value.created}:{}),...(typeof value.deleted==='boolean'?{deleted:value.deleted}:{})};
  }
  async function backupBytes(editId){let bytes=0;for(const filename of ['before.bin','after.bin','journal.json']){try{const info=await lstat(path.join(editDirectory(editId),filename));if(!info.isFile()||info.isSymbolicLink())throw fail('project_recovery_required','Private edit evidence is not a regular file.',409);bytes+=info.size;}catch(error){if(error.code!=='ENOENT')throw error;}}return bytes;}
  async function removePrivateEdit(editId){const target=editDirectory(editId);try{const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(target)!==target)throw fail('project_recovery_required','Private edit evidence changed location.',409);await rm(target,{recursive:true,force:true});}catch(error){if(error.code!=='ENOENT')throw error;}}
  async function prune(){
    try{const all=store.edits();for(const edit of all.filter(item=>item.pruned))await removePrivateEdit(edit.id);
      const terminal=all.filter(edit=>!edit.pruned&&['applied','interrupted','failed'].includes(edit.state));let count=terminal.length,total=all.reduce((sum,edit)=>sum+(edit.pruned?0:edit.backupBytes),0);
      for(const edit of [...terminal].reverse()){if(count<=100&&total<=MAX_BACKUPS)break;store.markPruned(edit.id);await removePrivateEdit(edit.id);count--;total-=edit.backupBytes;}
    }catch{throw fail('project_backup_cleanup_required','Retained backup cleanup needs review before another edit.',409);}
  }
  async function recover(edit){
    const grant=store.getGrant(edit.projectId);let result,terminalOnly=true;
    if(!grant.revoked&&grant.grantEpoch===edit.grantEpoch){try{await validateGrant({projectId:grant.projectId,grantEpoch:grant.grantEpoch});terminalOnly=false;}catch{/* Unavailable or revoked roots permit private terminal-journal inspection only. */}}
    try{result=mutationResult(await native.run('recover',{...common(grant),path:edit.path,operationId:edit.id,editDirectory:editDirectory(edit.id),terminalOnly},{}),edit);}
    catch{result={id:edit.id,projectId:edit.projectId,grantEpoch:edit.grantEpoch,path:edit.path,status:'recovery_required',beforeHash:null,afterHash:null,bytes:0,undoAvailable:false,outcomeUnknown:true};}
    return store.finishEdit(edit.id,{state:result.status,result,backupBytes:await backupBytes(edit.id)});
  }
  try{for(const edit of store.edits().filter(item=>['pending','recovery_required'].includes(item.state)))await recover(edit);await prune();}catch(error){await Promise.resolve().then(()=>native.close?.()).catch(()=>{});store.close();throw error;}
  async function projects({includeLocalPaths=false}={}){
    if(typeof includeLocalPaths!=='boolean')throw fail('invalid_project_query','Choose whether human-facing folder paths are needed.');check();
    const result=[];for(const grant of store.grants()){let available=false;if(!grant.revoked){try{await validateGrant({projectId:grant.projectId,grantEpoch:grant.grantEpoch});available=true;}catch{/* Unavailable grants retain their identity and history. */}}result.push(publicProject(grant,available,includeLocalPaths));}return{projects:result};
  }
  async function choose({signal}={}){return withActive(null,signal,async current=>{
    let selection;try{selection=await native.chooseFolder({signal:current});}catch(error){throw nativeError(error);}check(current);if(!selection||selection.cancelled)return{project:null,cancelled:true};
    if(typeof selection.path!=='string'||!path.isAbsolute(selection.path))throw fail('invalid_project_response','The folder chooser returned invalid metadata.',502);
    let observed;try{observed=await native.run('inspectRoot',{path:selection.path,protectedRoots},{signal:current});}catch(error){throw nativeError(error);}check(current);
    if(!observed||typeof observed.canonicalPath!=='string'||!path.isAbsolute(observed.canonicalPath)||protectedRoots.some(target=>inside(observed.canonicalPath,target)||inside(target,observed.canonicalPath)))throw fail('protected_project_root','Application source, private runtime and their ancestors cannot be granted as project folders.',403);
    const grant=store.grant({...observed,label:text(observed.label,100,true)});return{project:publicProject(grant,true,true)};
  });}
  async function validateBinding(value){const selected=binding(value);return withActive(selected,undefined,async signal=>publicProject(await validateGrant(selected,signal)));}
  async function revoke(value){check();const selected=binding(value),before=store.getGrant(selected.projectId),grant=store.revoke(selected);if(!before.revoked){for(const entry of active)if(entry.binding?.projectId===selected.projectId)entry.controller.abort();await Promise.allSettled([...listeners].map(listener=>Promise.resolve().then(()=>listener(selected))));}return{project:publicProject(grant,false,true),revoked:true};}
  function parse(args){
    let encoded;try{encoded=JSON.stringify(args);}catch{}if(!encoded||Buffer.byteLength(encoded)>80000||!object(args))throw fail('invalid_project_arguments','Use bounded project-file arguments.');
    const allowed={projects:['action'],list:['action','projectId','grantEpoch','path','offset','limit','expectedDirectoryHash'],read:['action','projectId','grantEpoch','path','offset','limit','expectedHash'],write:['action','projectId','grantEpoch','path','content','expectedHash'],replace:['action','projectId','grantEpoch','path','oldText','newText','expectedHash'],history:['action','projectId','grantEpoch','offset','limit'],inspect:['action','projectId','grantEpoch','changeId','part','offset','limit','expectedHash'],undo:['action','projectId','grantEpoch','changeId','expectedHash']}[args.action];
    if(!allowed)throw fail('invalid_project_arguments','Choose a supported project-file action.');fields(args,allowed);if(args.action==='projects')return args;binding({projectId:args.projectId,grantEpoch:args.grantEpoch});
    if(['offset','limit'].some(key=>Object.hasOwn(args,key)&&args[key]===null))throw fail('invalid_project_query','Use numeric paging fields.');
    if(['list','read','write','replace'].includes(args.action))relative(args.path===undefined&&args.action==='list'?'':args.path,args.action==='list');
    if(['inspect','undo'].includes(args.action))id(args.changeId);
    if(['list','history'].includes(args.action)){integer(args.offset??0,0,20000);integer(args.limit??40,1,40);}
    if(['read','inspect'].includes(args.action)){integer(args.offset??0,0,250000);integer(args.limit??12000,1,12000);if(args.expectedHash!==undefined)expected(args.expectedHash);if(args.action==='read'&&(args.offset||0)>0&&args.expectedHash===undefined)throw fail('invalid_project_query','Continuation reads require their expectedHash.');}
    if(args.action==='list'&&((args.offset||0)>0||args.expectedDirectoryHash!==undefined))expected(args.expectedDirectoryHash);
    if(['write','replace'].includes(args.action))expected(args.expectedHash,args.action==='write');
    if(args.action==='write')text(args.content,24000);
    if(args.action==='replace'){text(args.oldText,12000,true);text(args.newText,12000);}
    if(args.action==='inspect'&&!['metadata','before','after'].includes(args.part))throw fail('invalid_project_arguments','Choose metadata, before or after backup content.');
    if(args.action==='undo'&&args.expectedHash!==undefined)expected(args.expectedHash,true);return args;
  }
  function bound(args,context){const selected=binding(context.binding);if(selected.projectId!==args.projectId.toLowerCase()||selected.grantEpoch!==args.grantEpoch)throw fail('project_binding_mismatch','The tool arguments must match the captured project selection.',409);return selected;}
  const replay=edit=>{if(edit.state==='failed'){const error=fail(edit.error?.code||'project_file_failed',edit.error?.message||'This edit did not complete.',edit.error?.statusCode||503);throw Object.assign(error,{projectFileEdit:metadata(edit),replayed:true});}return{projectFileEdit:metadata(edit),replayed:true};};
  async function execute(raw,context={}){
    const args=parse(raw);if(args.action==='projects')return projects();const selected=bound(args,context),mutating=['write','replace','undo'].includes(args.action);
    let editId,digest;
    if(mutating){editId=id(context.operationId);digest=hash({binding:selected,arguments:args});const prior=store.findEdit(editId,digest);if(prior)return replay(prior);}
    if(args.action==='inspect')return getEdit(args.changeId,{binding:selected,part:args.part,offset:args.offset,limit:args.limit,expectedHash:args.expectedHash});
    return withActive(selected,context.signal,async signal=>{
      const grant=await validateGrant(selected,signal);
      if(args.action==='history')return history(grant,args);
      if(args.action==='list'){
        const folder=relative(args.path??'',true);let result;try{result=await native.run('list',{...common(grant),path:folder},{signal});}catch(error){throw nativeError(error);}check(signal);
        if(!object(result)||!Array.isArray(result.entries)||result.entries.length>1000||!Number.isSafeInteger(result.scanned)||result.scanned<result.entries.length||result.scanned>1000||result.scanLimit!==1000||typeof result.truncated!=='boolean')throw fail('invalid_project_response','The directory reader returned invalid metadata.',502);
        const entries=result.entries.map(entry=>{if(!object(entry)||typeof entry.name!=='string'||entry.name.includes('/')||!['file','directory'].includes(entry.kind)||entry.path!==(folder?folder+'/':'')+entry.name)throw fail('invalid_project_response','The directory reader returned an invalid entry.',502);relative(entry.path);if(entry.byteLength!==undefined&&(!Number.isSafeInteger(entry.byteLength)||entry.byteLength<0))throw fail('invalid_project_response','The directory reader returned an invalid size.',502);return{name:entry.name,path:entry.path,kind:entry.kind,...(entry.byteLength!==undefined?{byteLength:entry.byteLength}:{})};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
        const directoryHash=hash({path:folder,entries,scanned:result.scanned,truncated:result.truncated});if(args.expectedDirectoryHash!==undefined&&args.expectedDirectoryHash!==directoryHash)throw fail('project_directory_conflict','The directory changed. Start its listing again.',409);
        const offset=args.offset??0,limit=args.limit??40;if(offset>entries.length)throw fail('invalid_project_query','The directory offset is past the scanned entries.');
        const output={...selected,path:folder,entries:[],offset,hasMore:false,nextOffset:null,directoryHash,complete:!result.truncated,scanLimitReached:result.truncated,scanned:result.scanned,...(!result.truncated?{total:entries.length}:{})};
        const update=()=>{const next=offset+output.entries.length;output.hasMore=next<entries.length;output.nextOffset=output.hasMore?next:null;};
        for(const entry of entries.slice(offset,offset+limit)){output.entries.push(entry);update();if(Buffer.byteLength(JSON.stringify(output))>MAX_PAGE){output.entries.pop();update();break;}}
        if(offset<entries.length&&!output.entries.length)throw fail('project_output_limit','One directory entry exceeds its page limit.',413);return output;
      }
      if(args.action==='read'){let value;try{value=await native.run('read',{...common(grant),path:args.path},{signal});}catch(error){throw nativeError(error);}check(signal);return pageText(value,{...selected,path:args.path},args);}
      const original=args.action==='undo'?store.getEdit(args.changeId):null;if(original&&(original.projectId!==selected.projectId||original.pruned||original.state!=='applied'||original.result?.undoAvailable!==true))throw fail('project_undo_unavailable','That edit has no available undo version in this project.',409);
      if(original&&args.expectedHash!==undefined&&args.expectedHash!==original.result.afterHash)throw fail('project_file_conflict','Undo requires the edit’s original afterHash.',409);
      const target=original?original.path:args.path;await prune();check(signal);const all=store.edits(),reserved=all.reduce((sum,item)=>sum+(item.pruned?0:item.backupBytes)+(item.state==='pending'?EDIT_RESERVATION:0),0);if(reserved+EDIT_RESERVATION>MAX_BACKUPS)throw fail('project_backup_limit','Retained recovery evidence fills the backup budget. Review it before another edit.',409);
      const begun=store.beginEdit({id:editId,digest,...selected,path:target,action:args.action});if(begun.replayed)return replay(begun.edit);
      const key=grant.projectId+':'+target.toLowerCase(),previous=writers.get(key)||Promise.resolve();let release;const barrier=new Promise(resolve=>release=resolve),tail=previous.catch(()=>{}).then(()=>barrier);writers.set(key,tail);
      let nativeReturned=false,observedResult=null;
      try{
        await previous.catch(()=>{});check(signal);await validateGrant(selected,signal);check(signal);
        const call={...common(grant),path:target,operationId:editId,editDirectory:editDirectory(editId),expectedHash:original?original.result.afterHash:args.expectedHash,...(args.action==='write'?{content:args.content}:{}),...(args.action==='replace'?{oldText:args.oldText,newText:args.newText}:{}),...(original?{originalEditDirectory:editDirectory(original.id)}:{})};
        const nativeResult=await native.run(args.action,call,{signal});nativeReturned=true;const result=mutationResult(nativeResult,begun.edit);observedResult=result;store.finishEdit(editId,{state:result.status,result,backupBytes:await backupBytes(editId)});try{await prune();}catch{/* A committed effect stays authoritative; the next edit must retry cleanup before dispatch. */}return{projectFileEdit:metadata(store.getEdit(editId)),replayed:false};
      }catch(rawError){
        const committed=store.getEdit(editId);if(committed.state==='applied')return{projectFileEdit:metadata(committed),replayed:false};
        const error=nativeError(rawError);let saved;
        try{
          if(nativeReturned||error.outcomeUnknown||error.name==='AbortError')saved=await recover(store.getEdit(editId));
          else{const result={id:editId,...selected,path:target,status:'failed',beforeHash:null,afterHash:null,bytes:0,undoAvailable:false};saved=store.finishEdit(editId,{state:'failed',result,error:{code:error.code,message:error.message,statusCode:error.statusCode},backupBytes:await backupBytes(editId)});}
        }catch{throw Object.assign(fail('project_receipt_unavailable','The file operation could not finalize its durable receipt. Inspect this edit before another request.',503),{projectFileEdit:{...(observedResult||metadata(store.getEdit(editId))),receiptPending:true},replayed:false,outcomeUnknown:!observedResult||observedResult.outcomeUnknown===true});}
        if(saved.state==='applied')return{projectFileEdit:metadata(saved),replayed:false};
        throw Object.assign(error,{projectFileEdit:metadata(saved),replayed:false,outcomeUnknown:saved.state==='recovery_required'});
      }finally{release();if(writers.get(key)===tail)writers.delete(key);}
    });
  }
  function history(grant,args){const all=store.edits({projectId:grant.projectId}),offset=args.offset??0;if(offset>all.length)throw fail('invalid_project_query','The edit offset is past history.');const output={projectId:grant.projectId,grantEpoch:grant.grantEpoch,edits:[],offset,hasMore:false,nextOffset:null,total:all.length};const update=()=>{const next=offset+output.edits.length;output.hasMore=next<all.length;output.nextOffset=output.hasMore?next:null;};for(const edit of all.slice(offset,offset+(args.limit??40))){output.edits.push(metadata(edit));update();if(Buffer.byteLength(JSON.stringify(output))>MAX_PAGE){output.edits.pop();update();break;}}return output;}
  async function getEdit(editId,{binding:value,part='metadata',offset=0,limit=12000,expectedHash}={}){
    const edit=store.getEdit(id(editId)),selected=binding(value);if(edit.projectId!==selected.projectId)throw fail('project_binding_mismatch','That edit belongs to another selected project.',409);
    if(part==='metadata')return{projectFileEdit:metadata(edit)};
    if(!['before','after'].includes(part))throw fail('invalid_project_query','Choose metadata, before or after.');
    return withActive(selected,undefined,async signal=>{const grant=await validateGrant(selected,signal);if(edit.pruned||edit.state!=='applied')throw fail('project_backup_unavailable','That confirmed backup is no longer retained or needs recovery review.',409);let value;try{value=await native.run('inspect',{...common(grant),path:edit.path,operationId:edit.id,editDirectory:editDirectory(edit.id),part},{signal});}catch(error){throw nativeError(error);}check(signal);return pageText(value,{...selected,path:edit.path,changeId:edit.id,part,...(typeof value.fileExists==='boolean'?{fileExists:value.fileExists}:{})},{offset,limit,expectedHash,requireHash:false});});
  }
  function close(){if(closePromise)return closePromise;closed=true;for(const entry of active)entry.controller.abort();closePromise=(async()=>{try{await native.close?.();}finally{await Promise.allSettled([...active].map(entry=>entry.promise));store.close();}})();return closePromise;}
  return{projects,choose,revoke,validateBinding,execute,getEdit,onRevoke(listener){if(typeof listener!=='function')throw new TypeError('Use a revoke callback.');listeners.add(listener);return()=>listeners.delete(listener);},close};
}
