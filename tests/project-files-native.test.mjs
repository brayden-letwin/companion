import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,rm,stat,link,symlink,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createProjectFileNative} from '../server/project-files-native.mjs';

const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BASE=path.resolve(APP,'..','..','work','project-native-tests');
const WINDOWS={skip:process.platform!=='win32'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  await mkdir(BASE,{recursive:true});const directory=await mkdtemp(path.join(BASE,'run-')),project=path.join(directory,'project'),dataDirectory=path.join(directory,'private');await mkdir(project);await mkdir(dataDirectory);
  const native=await createProjectFileNative({root:APP,dataDirectory});
  t.after(async()=>{await native.close();const target=path.resolve(directory);assert.ok(target.startsWith(BASE+path.sep));await rm(target,{recursive:true,force:true});});
  async function run(action,fields,options){try{return await native.run(action,fields,options);}catch(error){if(error.nativeDiagnostic)t.diagnostic(error.nativeDiagnostic);throw error;}}
  const root=await run('inspectRoot',{path:project,protectedRoots:[]});
  const common=relative=>({root:root.canonicalPath,rootIdentity:root.identity,path:relative,protectedRoots:[]});
  const mutation=relative=>{const operationId=randomUUID();return{...common(relative),operationId,editDirectory:path.join(dataDirectory,'project-files','edits',operationId)};};
  return{directory,project,dataDirectory,native,run,root,common,mutation};
}

test('the fixed picker compiles a visible owned chooser with a message loop, without a path argument or GUI test',WINDOWS,async t=>{
  const f=await fixture(t),pickerPath=path.join(APP,'scripts','project-folder-picker.ps1'),source=await readFile(pickerPath,'utf8');
  assert.ok(source.includes("if ($args.Count -ne 0)"));assert.ok(source.includes('$picker.ShowNewFolderButton = $false'));
  const firstHide=source.indexOf('ShowWindow(owner.Handle, 0);'),secondHide=source.indexOf('ShowWindow(owner.Handle, 0);',firstHide+1),show=source.indexOf('owner.Show();'),messageLoop=source.indexOf('Application.Run(owner);');
  assert.ok(firstHide>=0&&secondHide>firstHide&&show>secondHide&&messageLoop>show);assert.ok(source.includes('ShowWindow(owner.Handle, 1);'));assert.ok(source.includes('owner.ShowInTaskbar = true;'));assert.ok(source.includes('owner.BeginInvoke(new Action(delegate {'));assert.ok(source.includes('result = picker.ShowDialog(owner);'));assert.ok(!source.includes('owner.Opacity = 0;'));
  const helper=path.join(f.directory,'compile-picker.ps1');
  await writeFile(helper,"$ErrorActionPreference='Stop'\n$taskTokens=$null;$taskErrors=$null\n[void][System.Management.Automation.Language.Parser]::ParseFile($env:FIXTURE_PICKER,[ref]$taskTokens,[ref]$taskErrors)\nif($taskErrors.Count){throw 'The fixed picker did not parse.'}\n$source=[IO.File]::ReadAllText($env:FIXTURE_PICKER)\n$match=[regex]::Match($source,\"-TypeDefinition @'\\r?\\n([\\s\\S]*?)\\r?\\n'@\")\nif(!$match.Success){throw 'The owned-dialog helper was not found.'}\nAdd-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition $match.Groups[1].Value\n$method=[CompanionProjectFolderPicker].GetMethod('Show')\nif($method.ReturnType.FullName -ne 'System.Windows.Forms.DialogResult' -or $method.GetParameters()[0].ParameterType.FullName -ne 'System.Windows.Forms.FolderBrowserDialog'){throw 'The fixed dialog signature changed.'}\n[Console]::WriteLine('COMPILED_WITHOUT_UI')\n");
  const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{shell:false,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,FIXTURE_PICKER:pickerPath},stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,error);assert.equal(output.trim(),'COMPILED_WITHOUT_UI');
});

test('native broker reads exact UTF-8/BOM/newlines and writes, replaces and restores through verified handles',WINDOWS,async t=>{
  const f=await fixture(t),filename=path.join(f.project,'notes.txt'),original='\ufeffFirst 😀 line\r\nSecond line\r\n';await writeFile(filename,original);
  const read=await f.run('read',f.common('notes.txt'));assert.equal(read.content,original);assert.equal(read.hash,hash(Buffer.from(original)));assert.equal(read.bom,true);assert.equal(read.lineEndings,'crlf');
  const operation={...f.mutation('notes.txt'),expectedHash:read.hash,content:'Rewritten 😀\n'};
  const saved=await f.run('write',operation);assert.equal(saved.status,'applied');assert.equal(saved.beforeHash,read.hash);assert.equal(saved.afterHash,hash(Buffer.from(operation.content)));assert.equal(await readFile(filename,'utf8'),operation.content);
  const journal=JSON.parse(await readFile(path.join(operation.editDirectory,'journal.json'),'utf8'));assert.equal(journal.stage,'applied');assert.equal(await readFile(path.join(operation.editDirectory,'before.bin'),'utf8'),original);assert.equal(await readFile(path.join(operation.editDirectory,'after.bin'),'utf8'),operation.content);
  const inspected=await f.run('inspect',{...f.common('notes.txt'),operationId:operation.operationId,editDirectory:operation.editDirectory,part:'before'});assert.equal(inspected.content,original);assert.equal(inspected.fileExists,true);
  const undo=await f.run('undo',{...f.mutation('notes.txt'),expectedHash:saved.afterHash,originalEditDirectory:operation.editDirectory});assert.equal(undo.status,'applied');assert.equal(await readFile(filename,'utf8'),original);
  const replace=await f.run('replace',{...f.mutation('notes.txt'),expectedHash:read.hash,oldText:'Second line',newText:'Changed literal $x `text`'});assert.equal(replace.status,'applied');assert.equal(await readFile(filename,'utf8'),original.replace('Second line','Changed literal $x `text`'));
  await assert.rejects(f.run('write',{...f.mutation('notes.txt'),expectedHash:read.hash,content:'Must not clobber'}),{code:'project_file_conflict'});
  await writeFile(path.join(f.project,'overlap.txt'),'aaa');await assert.rejects(f.run('replace',{...f.mutation('overlap.txt'),expectedHash:hash('aaa'),oldText:'aa',newText:'x'}),{code:'project_replace_conflict'});assert.equal(await readFile(path.join(f.project,'overlap.txt'),'utf8'),'aaa');
});

test('new-file undo deletes only the unchanged opened identity and later external edits are preserved',WINDOWS,async t=>{
  const f=await fixture(t),op={...f.mutation('new.txt'),expectedHash:null,content:'New fixture text'};
  const saved=await f.run('write',op);assert.equal(saved.created,true);const before=await f.run('inspect',{...f.common('new.txt'),operationId:op.operationId,editDirectory:op.editDirectory,part:'before'});assert.equal(before.fileExists,false);assert.equal(before.content,'');
  await writeFile(path.join(f.project,'new.txt'),'Later outside edit');await assert.rejects(f.run('undo',{...f.mutation('new.txt'),expectedHash:saved.afterHash,originalEditDirectory:op.editDirectory}),{code:'project_file_conflict'});assert.equal(await readFile(path.join(f.project,'new.txt'),'utf8'),'Later outside edit');
  const clean={...f.mutation('clean.txt'),expectedHash:null,content:'Delete only this owned fixture'};const created=await f.run('write',clean);const undone=await f.run('undo',{...f.mutation('clean.txt'),expectedHash:created.afterHash,originalEditDirectory:clean.editDirectory});assert.equal(undone.deleted,true);await assert.rejects(stat(path.join(f.project,'clean.txt')),{code:'ENOENT'});
  await assert.rejects(f.run('write',{...f.mutation('new.txt'),expectedHash:null,content:'Must not overwrite existing'}),error=>error.code==='project_file_conflict'&&!error.outcomeUnknown);
});

test('native containment rejects protected roots, path escapes, hidden/credential files, hardlinks and static junctions',WINDOWS,async t=>{
  const f=await fixture(t),canary=path.join(f.directory,'canary.txt');await writeFile(canary,'SYNTHETIC_PRIVATE_CANARY');await writeFile(path.join(f.project,'.env'),'SYNTHETIC_KEY');
  await assert.rejects(f.run('inspectRoot',{path:f.directory,protectedRoots:[f.dataDirectory]}),{code:'project_root_forbidden'});
  await assert.rejects(f.run('inspectRoot',{path:APP,protectedRoots:[]}),{code:'project_root_forbidden'});
  for(const relative of ['../canary.txt','C:/canary.txt','a\\b.txt','name.txt:stream','.env','credentials.json'])await assert.rejects(f.run('read',f.common(relative)),{code:'project_path_forbidden'});
  await link(canary,path.join(f.project,'linked.txt'));await assert.rejects(f.run('read',f.common('linked.txt')),{code:'project_path_forbidden'});await assert.rejects(f.run('write',{...f.mutation('linked.txt'),expectedHash:hash('SYNTHETIC_PRIVATE_CANARY'),content:'Must not touch outside alias'}),{code:'project_path_forbidden'});assert.equal(await readFile(canary,'utf8'),'SYNTHETIC_PRIVATE_CANARY');
  const outside=path.join(f.directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'private.txt'),'OUTSIDE_FIXTURE');
  try{await symlink(outside,path.join(f.project,'junction'),'junction');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('Host cannot create junction fixture.');return;}throw error;}
  await assert.rejects(f.run('read',f.common('junction/private.txt')),{code:'project_path_forbidden'});
  const listed=await f.run('list',f.common(''));assert.ok(!listed.entries.some(entry=>['.env','linked.txt','junction'].includes(entry.name)));assert.ok(listed.omitted>=3);
  await rename(f.project,f.project+'-old');await mkdir(f.project);await assert.rejects(f.run('read',f.common('missing.txt')),{code:'project_identity_changed'});
});

test('a real exclusive external editor lock prevents a native edit before any target mutation',WINDOWS,async t=>{
  const f=await fixture(t),target=path.join(f.project,'busy.txt');await writeFile(target,'Original locked fixture');
  const helper=path.join(f.directory,'hold.ps1');await writeFile(helper,"$s=[IO.File]::Open($env:FIXTURE_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null}finally{$s.Dispose()}");
  const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{shell:false,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,FIXTURE_FILE:target},stdio:['pipe','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('close',resolve));
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Synthetic editor did not lock fixture.')),5000);child.stdout.once('data',chunk=>{clearTimeout(timer);String(chunk).includes('LOCKED')?resolve():reject(new Error('Unexpected fixture output'));});child.once('error',reject);});await assert.rejects(f.run('write',{...f.mutation('busy.txt'),expectedHash:hash('Original locked fixture'),content:'Must not overwrite'}),{code:'project_file_busy'});}
  finally{child.stdin.end('\n');await exited;}
  assert.equal(await readFile(target,'utf8'),'Original locked fixture');
});

test('terminal retries do not reread a changed root and interrupted journals reconcile without replaying writes',WINDOWS,async t=>{
  const f=await fixture(t);await writeFile(path.join(f.project,'recover.txt'),'Before');const op={...f.mutation('recover.txt'),expectedHash:hash('Before'),content:'After'};const saved=await f.run('write',op),journalPath=path.join(op.editDirectory,'journal.json');
  const before=await stat(path.join(f.project,'recover.txt'));let journal=JSON.parse(await readFile(journalPath,'utf8'));journal.stage='committing';delete journal.result;await writeFile(journalPath,JSON.stringify(journal));
  const reconciled=await f.run('recover',{...f.common('recover.txt'),operationId:op.operationId,editDirectory:op.editDirectory});assert.equal(reconciled.status,'applied');assert.equal(reconciled.reconciled,true);assert.equal((await stat(path.join(f.project,'recover.txt'))).mtimeMs,before.mtimeMs);
  await writeFile(path.join(f.project,'recover.txt'),'Uncertain later outside edit');const uncertain=await f.run('recover',{...f.common('recover.txt'),operationId:op.operationId,editDirectory:op.editDirectory});assert.equal(uncertain.status,'recovery_required');assert.equal(uncertain.outcomeUnknown,true);assert.equal(await readFile(path.join(f.project,'recover.txt'),'utf8'),'Uncertain later outside edit');
  journal.stage='applied';journal.result=saved;await writeFile(journalPath,JSON.stringify(journal));await rename(f.project,f.project+'-gone');assert.deepEqual(await f.run('recover',{...f.common('recover.txt'),operationId:op.operationId,editDirectory:op.editDirectory}),saved);
  journal.stage='committing';delete journal.result;await writeFile(journalPath,JSON.stringify(journal));const revoked=await f.run('recover',{...f.common('recover.txt'),operationId:op.operationId,editDirectory:op.editDirectory,terminalOnly:true});assert.equal(revoked.status,'recovery_required');assert.equal(revoked.outcomeUnknown,true);
  const controller=new AbortController();controller.abort();await assert.rejects(f.native.run('write',{...op,operationId:randomUUID()},{signal:controller.signal}),error=>error.statusCode===400||error.name==='AbortError');
});

test('private prepare/commit barrier holds verified handles and cancellation cannot mutate the target',WINDOWS,async t=>{
  const f=await fixture(t),target=path.join(f.project,'barrier.txt');await writeFile(target,'Before commit');const fields={...f.mutation('barrier.txt'),expectedHash:hash('Before commit'),content:'After commit'};
  const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(APP,'scripts','project-files-bridge.ps1')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=[],waiters=[];let buffer='',diagnostics='';const exit=new Promise(resolve=>child.once('close',resolve));child.stderr.on('data',chunk=>{diagnostics+=chunk;});child.stdout.on('data',chunk=>{buffer+=chunk.toString('utf8');for(;;){const end=buffer.indexOf('\n');if(end<0)break;const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(waiters.length)waiters.shift()(value);else lines.push(value);}});
  const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise(resolve=>waiters.push(resolve));
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  try{
    assert.equal((await next()).type,'ready');send({id:'init',action:'init',fields:{sourceRoot:APP,dataDirectory:f.dataDirectory}});assert.equal((await next()).value.ready,true);
    send({id:'held-edit',action:'write',fields});const prepared=await next();assert.equal(prepared.type,'commit_ready');assert.equal(prepared.id,'held-edit');
    const journal=JSON.parse(await readFile(path.join(fields.editDirectory,'journal.json'),'utf8'));assert.equal(journal.stage,'prepared');assert.equal(await readFile(path.join(fields.editDirectory,'before.bin'),'utf8'),'Before commit');
    await assert.rejects(rename(f.project,f.project+'-moved'),error=>['EPERM','EACCES','EBUSY'].includes(error.code));
    send({action:'cancel',target:'held-edit'});const cancelled=await next();assert.equal(cancelled.error.code,'request_cancelled');assert.notEqual(cancelled.error.outcomeUnknown,true);assert.equal(await readFile(target,'utf8'),'Before commit');
    const queued={...f.mutation('barrier.txt'),expectedHash:hash('Before commit'),content:'Must not dispatch'};const controller=new AbortController(),pending=f.native.run('write',queued,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(await readFile(target,'utf8'),'Before commit');
  }finally{child.stdin.end();await exit;if(diagnostics)t.diagnostic(diagnostics);}
});
