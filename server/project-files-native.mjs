import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MUTATIONS=new Set(['write','replace','undo']);
const COMMON=['root','rootIdentity','path','protectedRoots'];
const FIELDS={inspectRoot:['path','protectedRoots'],list:COMMON,read:COMMON,write:[...COMMON,'operationId','editDirectory','expectedHash','content'],replace:[...COMMON,'operationId','editDirectory','expectedHash','oldText','newText'],undo:[...COMMON,'operationId','editDirectory','expectedHash','originalEditDirectory'],recover:[...COMMON,'operationId','editDirectory','terminalOnly'],inspect:[...COMMON,'operationId','editDirectory','part']};
const fail=(code,message,statusCode=503,extra={})=>Object.assign(new Error(message),{code,statusCode,...extra});
const stopped=()=>Object.assign(fail('request_cancelled','Project access was stopped.',499),{name:'AbortError'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Fixed Windows helper, private JSON protocol; never accepts shell text. */
export async function createProjectFileNative({root,dataDirectory}={}){
  const sourceRoot=await realpath(path.resolve(root));
  if(typeof dataDirectory!=='string'||!path.isAbsolute(dataDirectory))throw new TypeError('Use an absolute private project data directory.');
  await mkdir(dataDirectory,{recursive:true,mode:0o700});const storage=await realpath(dataDirectory);
  if(storage===sourceRoot||storage.startsWith(sourceRoot+path.sep))throw new TypeError('Keep project recovery outside application source.');
  const scratch=path.join(storage,'project-files','native-tmp');await mkdir(scratch,{recursive:true,mode:0o700});
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=name=>path.join(sourceRoot,'scripts',name);
  let closed=false,broker=null,starting=null,queue=Promise.resolve(),closePromise=null;const pickers=new Set();
  function environment(){const env={};for(const key of ['SystemRoot','WINDIR','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];return{...env,TEMP:scratch,TMP:scratch};}
  async function fixedScript(name){const file=script(name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||!(await realpath(file)).startsWith(sourceRoot+path.sep))throw fail('project_native_unavailable','The fixed project helper is unavailable.');return file;}
  function ensureWindows(){if(process.platform!=='win32')throw fail('project_native_unavailable','Project folders currently require Windows.');if(closed)throw stopped();}
  async function startBroker(){
    ensureWindows();if(broker&&!broker.exited&&!broker.invalid)return broker;if(starting)return starting;
    if(broker&&!broker.exited){const old=broker;let timer;await Promise.race([old.exit,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);if(!old.exited)throw fail('project_native_unavailable','The previous project helper has not confirmed it stopped.');}
    starting=(async()=>{
      const file=await fixedScript('project-files-bridge.ps1');if(closed)throw stopped();
      const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{shell:false,windowsHide:true,env:environment(),stdio:['pipe','pipe','pipe']});
      let resolveReady,rejectReady,resolveExit;const record={child,exited:false,pending:null,buffer:'',stderr:'',ready:new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;}),exit:new Promise(resolve=>{resolveExit=resolve;})};broker=record;
      const decoder=new StringDecoder('utf8');
      const invalidate=error=>{record.invalid=true;rejectReady(error);if(record.pending){const current=record.pending;record.pending=null;clearTimeout(current.timer);current.signal?.removeEventListener('abort',current.cancel);current.reject(Object.assign(error,{...(current.mutation?{outcomeUnknown:true}:{})}));}};
      child.stdout.on('data',chunk=>{
        record.buffer+=decoder.write(chunk);
        if(Buffer.byteLength(record.buffer)>2*1024*1024){invalidate(fail('project_native_response_limit','The project helper exceeded its response limit.'));child.kill();return;}
        for(;;){const index=record.buffer.indexOf('\n');if(index<0)break;const line=record.buffer.slice(0,index);record.buffer=record.buffer.slice(index+1);let value;try{value=JSON.parse(line);}catch{invalidate(fail('invalid_project_native_response','The project helper returned unreadable data.'));child.kill();return;}
          if(value.type==='ready'){resolveReady();continue;}
          const pending=record.pending;if(!pending||value.id!==pending.id){invalidate(fail('invalid_project_native_response','The project helper response could not be matched.'));child.kill();return;}
          if(value.type==='commit_ready'){
            if(!pending.mutation||pending.commitRequested){invalidate(fail('invalid_project_native_response','The commit request could not be matched.'));child.kill();return;}
            pending.commitRequested=true;child.stdin.write(JSON.stringify({action:pending.signal?.aborted||closed?'cancel':'commit',target:pending.id})+'\n');continue;
          }
          record.pending=null;clearTimeout(pending.timer);pending.signal?.removeEventListener('abort',pending.cancel);
          if(value.error){const error=fail(typeof value.error.code==='string'?value.error.code:'project_io_failed',typeof value.error.message==='string'?value.error.message:'The project operation failed.',Number.isInteger(value.error.statusCode)?value.error.statusCode:503,{...(value.error.outcomeUnknown?{outcomeUnknown:true}:{})});pending.reject(error);}
          else if(!object(value.value)){pending.reject(fail('invalid_project_native_response','The project helper returned invalid data.'));}
          else pending.resolve(value.value);
        }
      });
      child.stderr.on('data',chunk=>{if(record.stderr.length<8000)record.stderr+=chunk.toString('utf8').slice(0,8000-record.stderr.length);});
      child.stdin.on('error',()=>invalidate(fail('project_native_unavailable','The project helper connection closed.')));
      child.on('error',()=>{if(!child.pid){record.exited=true;resolveExit();}invalidate(fail('project_native_unavailable','The project helper could not run.'));});
      child.once('close',()=>{record.exited=true;resolveExit();if(broker===record)broker=null;invalidate(fail('project_native_interrupted','The project helper stopped before returning a receipt.'));});
      const timer=setTimeout(()=>{rejectReady(fail('project_native_unavailable','The project helper did not start in time.'));child.kill();},15000);timer.unref?.();
      try{await record.ready;if(closed)throw stopped();await send(record,'init',{sourceRoot,dataDirectory:storage});return record;}
      catch(error){child.kill();Object.defineProperty(error,'nativeDiagnostic',{value:record.stderr,enumerable:false});throw error;}
      finally{clearTimeout(timer);}
    })().finally(()=>{starting=null;});return starting;
  }
  function send(record,action,fields,signal){
    if(record.exited)throw fail('project_native_unavailable','The project helper is unavailable.');
    const id=randomUUID(),body=JSON.stringify({id,action,fields});if(Buffer.byteLength(body)>2*1024*1024)throw fail('invalid_project_input','The private project request is too large.',413);
    return new Promise((resolve,reject)=>{const pending={id,resolve,reject,signal,cancel:null,mutation:MUTATIONS.has(action),timer:null};pending.cancel=()=>{if(record.pending===pending&&!pending.commitRequested)record.child.stdin.write(JSON.stringify({action:'cancel',target:id})+'\n');};pending.timer=setTimeout(()=>{if(record.pending!==pending)return;record.pending=null;record.invalid=true;signal?.removeEventListener('abort',pending.cancel);reject(fail('project_native_timeout','The project operation did not return a receipt in time.',504,pending.mutation?{outcomeUnknown:true}:{}));record.child.kill();},30000);pending.timer.unref?.();record.pending=pending;signal?.addEventListener('abort',pending.cancel,{once:true});record.child.stdin.write(body+'\n',error=>{if(error&&record.pending===pending){record.pending=null;record.invalid=true;clearTimeout(pending.timer);signal?.removeEventListener('abort',pending.cancel);reject(fail('project_native_unavailable','The project helper connection closed.',503,pending.mutation?{outcomeUnknown:true}:{}));}});if(signal?.aborted)pending.cancel();});
  }
  function validate(action,fields){
    if(!Object.hasOwn(FIELDS,action)||!object(fields)||Object.keys(fields).some(key=>!FIELDS[action].includes(key)))throw fail('invalid_project_input','Use a supported fixed project operation.',400);
    for(const key of ['editDirectory','originalEditDirectory'])if(fields[key]!==undefined){const directory=path.resolve(fields[key]);if(!UUID.test(path.basename(directory))||path.dirname(directory)!==path.join(storage,'project-files','edits')||key==='editDirectory'&&path.basename(directory)!==fields.operationId)throw fail('invalid_project_input','Use an owned private edit directory.',400);}
    return structuredClone(fields);
  }
  function run(action,fields,{signal}={}){
    let input;try{input=validate(action,fields);}catch(error){return Promise.reject(error);}
    const operation=queue.then(async()=>{ensureWindows();if(signal?.aborted)throw stopped();const record=await startBroker();if(signal?.aborted||closed)throw stopped();const result=await send(record,action,input,signal);if(signal?.aborted&&!MUTATIONS.has(action))throw stopped();return result;});queue=operation.catch(()=>{});return operation;
  }
  async function chooseFolder({signal}={}){
    ensureWindows();if(signal?.aborted)throw stopped();const file=await fixedScript('project-folder-picker.ps1');if(signal?.aborted||closed)throw stopped();
    const child=spawn(powershell,['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',file],{shell:false,windowsHide:true,env:environment(),stdio:['ignore','pipe','pipe']});pickers.add(child);
    return new Promise((resolve,reject)=>{let output='',settled=false;const cancel=()=>child.kill();signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,10*60*1000);timer.unref?.();
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);pickers.delete(child);error?reject(error):resolve(value);};
      child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>12000)child.kill();});child.stderr.resume();child.once('error',()=>finish(fail('project_picker_unavailable','The project folder picker could not open.')));
      child.once('close',code=>{if(signal?.aborted||closed)return finish(stopped());if(code!==0)return finish(fail('project_picker_unavailable','The folder selection did not finish.'));try{const value=JSON.parse(output.trim());if(!object(value)||value.cancelled!==true&&typeof value.path!=='string')throw new Error();finish(null,value.cancelled?{cancelled:true}:{path:value.path});}catch{finish(fail('invalid_project_native_response','The folder selection could not be read.'));}});
      if(signal?.aborted||closed)cancel();
    });
  }
  function close(){if(closePromise)return closePromise;closed=true;for(const child of pickers)child.kill();closePromise=(async()=>{await queue;const record=broker;if(record&&!record.exited){record.child.stdin.end();let timer;await Promise.race([record.exit,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);if(!record.exited){record.child.kill();await record.exit;}}})();return closePromise;}
  return{chooseFolder,run,close};
}
