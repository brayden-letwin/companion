import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,rm,stat,link,symlink,rename,readdir} from 'node:fs/promises';
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

async function seedDirectory(directory,count){
  let next=0;await Promise.all(Array.from({length:32},async()=>{for(;;){const index=next++;if(index>=count)return;await writeFile(path.join(directory,`document-${String(index).padStart(5,'0')}.txt`),'SYNTHETIC_FILE_BODY_NOT_ENUMERATION_CONTEXT');}}));
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

test('private directory pages traverse beyond 1000 names exactly once without exposing protected aliases or file bodies',WINDOWS,async t=>{
  const f=await fixture(t);await seedDirectory(f.project,1205);await mkdir(path.join(f.project,'nested'));await writeFile(path.join(f.project,'Unicode 😀 café.txt'),'ANOTHER_SYNTHETIC_BODY');
  await writeFile(path.join(f.project,'.env'),'SYNTHETIC_PRIVATE_SECRET');await writeFile(path.join(f.project,'credentials.json'),'SYNTHETIC_PRIVATE_SECRET');
  const outside=path.join(f.directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'canary.txt'),'OUTSIDE_SYNTHETIC_CANARY');await link(path.join(outside,'canary.txt'),path.join(f.project,'linked.txt'));
  let junction=false;try{await symlink(outside,path.join(f.project,'junction'),'junction');junction=true;}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;t.diagnostic('Host denied the synthetic junction; hardlink and protected-name checks remain actual.');}
  const legacy=await f.run('list',f.common(''));assert.equal(legacy.scanLimit,1000);assert.equal(legacy.scanned,1000);assert.equal(legacy.truncated,true);
  const entries=[],tokens=[],identities=new Set();let cursor,scanned=0,protectedCount=0;
  do{
    const result=await f.run('scanDirectory',{...f.common(''),...(cursor?{cursor}:{})});assert.equal(result.scanLimit,200);assert.ok(result.scanned>=0&&result.scanned<=200);assert.equal(result.scanned,result.entries.length+result.skipped.protected+result.skipped.unavailable);assert.equal(result.skipped.unavailable,0);
    entries.push(...result.entries);scanned+=result.scanned;protectedCount+=result.skipped.protected;identities.add(result.directoryIdentity);assert.equal(result.hasMore,typeof result.nextCursor==='string');
    if(result.nextCursor){assert.match(result.nextCursor,/^[a-f0-9-]{36}$/);assert.ok(!tokens.includes(result.nextCursor));tokens.push(result.nextCursor);}cursor=result.nextCursor;
  }while(cursor);
  assert.equal(entries.length,1207);assert.equal(new Set(entries.map(entry=>entry.path)).size,1207);assert.equal(scanned,1210+(junction?1:0));assert.equal(protectedCount,3+(junction?1:0));assert.equal(identities.size,1);
  assert.ok(entries.some(entry=>entry.path==='Unicode 😀 café.txt'));assert.equal(entries.find(entry=>entry.name==='nested').kind,'directory');assert.ok(!JSON.stringify(entries).includes('SYNTHETIC_FILE_BODY'));assert.ok(!JSON.stringify(entries).includes(f.project));assert.ok(!entries.some(entry=>['.env','credentials.json','linked.txt','junction'].includes(entry.name)));
  await assert.rejects(f.run('scanDirectory',{...f.common(''),cursor:tokens[0]}),{code:'project_scan_expired'});await rename(f.project,f.project+'-complete');await rename(f.project+'-complete',f.project);
});

test('native cursors bind their exact root and directory, consume once, and close without a live grant or path read',WINDOWS,async t=>{
  const f=await fixture(t);await seedDirectory(f.project,401);await mkdir(path.join(f.project,'nested'));
  const first=await f.run('scanDirectory',f.common(''));assert.equal(first.hasMore,true);
  const next=await f.run('scanDirectory',{...f.common(''),cursor:first.nextCursor});assert.equal(next.hasMore,true);await assert.rejects(f.run('scanDirectory',{...f.common(''),cursor:first.nextCursor}),{code:'project_scan_expired'});
  await assert.rejects(f.run('scanDirectory',{...f.common('nested'),cursor:next.nextCursor}),{code:'project_scan_conflict'});await assert.rejects(f.run('scanDirectory',{...f.common(''),cursor:next.nextCursor}),{code:'project_scan_expired'});
  const wrongRoot=await f.run('scanDirectory',f.common(''));await assert.rejects(f.run('scanDirectory',{...f.common(''),rootIdentity:'different-original-root',cursor:wrongRoot.nextCursor}),{code:'project_scan_conflict'});
  const held=await f.run('scanDirectory',f.common(''));assert.deepEqual(await f.run('closeScan',{cursor:held.nextCursor}),{closed:true});await rename(f.project,f.project+'-revoked');assert.deepEqual(await f.run('closeScan',{cursor:held.nextCursor}),{closed:true});
  await assert.rejects(f.run('scanDirectory',{...f.common(''),cursor:held.nextCursor}),{code:'project_scan_expired'});await assert.rejects(f.run('closeScan',{cursor:randomUUID(),root:f.project}),{code:'invalid_project_input'});await rename(f.project+'-revoked',f.project);
});

test('directory moves, membership and same-name identity changes fail continuations without mixing snapshots',WINDOWS,async t=>{
  const f=await fixture(t);await seedDirectory(f.project,205);await mkdir(path.join(f.project,'sub'));await seedDirectory(path.join(f.project,'sub'),205);
  const moved=await f.run('scanDirectory',f.common('sub'));await rename(path.join(f.project,'sub'),path.join(f.project,'sub-held'));await assert.rejects(f.run('scanDirectory',{...f.common('sub'),cursor:moved.nextCursor}),{code:'project_directory_changed'});await rename(path.join(f.project,'sub-held'),path.join(f.project,'sub'));
  const rootMoved=await f.run('scanDirectory',f.common(''));await rename(f.project,f.project+'-moved');await assert.rejects(f.run('scanDirectory',{...f.common(''),cursor:rootMoved.nextCursor}),{code:'project_directory_changed'});await rename(f.project+'-moved',f.project);
  const first=await f.run('scanDirectory',f.common('sub'));await writeFile(path.join(f.project,'sub','added.txt'),'NEW_SYNTHETIC_MEMBER');await assert.rejects(f.run('scanDirectory',{...f.common('sub'),cursor:first.nextCursor}),{code:'project_directory_changed'});await rename(path.join(f.project,'sub'),path.join(f.project,'sub-after'));await rename(path.join(f.project,'sub-after'),path.join(f.project,'sub'));
  const second=await f.run('scanDirectory',f.common(''));const replaced=path.join(f.project,'document-00204.txt');await rename(replaced,path.join(f.directory,'old-identity.txt'));await writeFile(replaced,'SYNTHETIC_FILE_BODY_NOT_ENUMERATION_CONTEXT');
  await assert.rejects(f.run('scanDirectory',{...f.common(''),cursor:second.nextCursor}),{code:'project_directory_changed'});await rename(f.project,f.project+'-released');await rename(f.project+'-released',f.project);
});

test('cancelling actual native enumeration and continuation releases cursors without creating edits or touching file bytes',WINDOWS,async t=>{
  const f=await fixture(t);await seedDirectory(f.project,5000);
  const controller=new AbortController(),pending=f.run('scanDirectory',f.common(''),{signal:controller.signal});const timer=setTimeout(()=>controller.abort(),15);
  try{await assert.rejects(pending,error=>error.code==='request_cancelled');}finally{clearTimeout(timer);}
  await rename(f.project,f.project+'-cancelled');await rename(f.project+'-cancelled',f.project);
  const first=await f.run('scanDirectory',f.common(''));const stop=new AbortController(),continuation=f.run('scanDirectory',{...f.common(''),cursor:first.nextCursor},{signal:stop.signal});const secondTimer=setTimeout(()=>stop.abort(),15);
  try{await assert.rejects(continuation,error=>error.code==='request_cancelled');}finally{clearTimeout(secondTimer);}
  await rename(f.project,f.project+'-stopped');await rename(f.project+'-stopped',f.project);assert.deepEqual(await f.run('closeScan',{cursor:first.nextCursor}),{closed:true});
  assert.equal(await readFile(path.join(f.project,'document-00000.txt'),'utf8'),'SYNTHETIC_FILE_BODY_NOT_ENUMERATION_CONTEXT');assert.deepEqual(await readdir(path.join(f.dataDirectory,'project-files')),['native-tmp']);
});

test('native cursor admission is bounded and helper closure releases every retained root handle',WINDOWS,async t=>{
  const f=await fixture(t);await seedDirectory(f.project,201);const cursors=[];
  for(let index=0;index<8;index++)cursors.push((await f.run('scanDirectory',f.common(''))).nextCursor);
  await assert.rejects(f.run('scanDirectory',f.common('')),{code:'project_scan_busy'});
  await f.run('closeScan',{cursor:cursors.pop()});cursors.push((await f.run('scanDirectory',f.common(''))).nextCursor);await f.native.close();await rename(f.project,f.project+'-closed');await rename(f.project+'-closed',f.project);
});

test('directory snapshot metadata refuses oversized admission instead of truncating or retaining handles',WINDOWS,async t=>{
  const f=await fixture(t);await seedDirectory(f.project,8000);await assert.rejects(f.run('scanDirectory',f.common('')),{code:'project_scan_limit'});await rename(f.project,f.project+'-budget');await rename(f.project+'-budget',f.project);
});

test('idle native expiry disposes retained root and parent scopes through the real cleanup timer',WINDOWS,async t=>{
  const f=await fixture(t);await mkdir(path.join(f.project,'sub'));await seedDirectory(path.join(f.project,'sub'),205);
  const helper=path.join(f.directory,'expire-native-scan.ps1');
  await writeFile(helper,`$ErrorActionPreference='Stop'
$script=[IO.File]::ReadAllText($env:FIXTURE_BROKER)
$start=$script.IndexOf("@'")+2
$end=$script.IndexOf(([string][char]10)+"'@",$start)
Add-Type -TypeDefinition $script.Substring($start,$end-$start) -ReferencedAssemblies 'System.Web.Extensions.dll'
$init=@{id='init';action='init';fields=@{sourceRoot=$env:FIXTURE_SOURCE;dataDirectory=$env:FIXTURE_DATA}} | ConvertTo-Json -Compress
$ready=[CompanionProjectFiles]::Dispatch($init) | ConvertFrom-Json
if(!$ready.value.ready){throw 'Synthetic broker initialization failed.'}
$frame=@{id='scan';action='scanDirectory';fields=($env:FIXTURE_FIELDS | ConvertFrom-Json)} | ConvertTo-Json -Compress
$result=[CompanionProjectFiles]::Dispatch($frame) | ConvertFrom-Json
if(!$result.value.hasMore){throw 'Synthetic scan did not retain its next page.'}
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$scans=[CompanionProjectFiles].GetField('Scans',$flags).GetValue($null)
$scan=$scans[$result.value.nextCursor]
$type=$scan.GetType()
$root=$type.GetField('RootScope').GetValue($scan)
$parent=$type.GetField('DirectoryScope').GetValue($scan)
foreach($scope in @($root,$parent)){foreach($handle in $scope.GetType().GetField('Handles').GetValue($scope)){if($handle.IsClosed){throw 'A retained scan handle closed early.'}}}
[Console]::WriteLine('RETAINED')
if([Console]::ReadLine() -ne 'expire'){throw 'Missing synthetic expiry step.'}
# Move only this synthetic cursor's expiry into the past; the production timer and
# original dispose path run unchanged, without waiting ten real minutes.
$type.GetField('ExpiresAt').SetValue($scan,[DateTime]::UtcNow.AddSeconds(-1))
$deadline=[DateTime]::UtcNow.AddSeconds(5)
while(!$type.GetField('Disposed').GetValue($scan) -and [DateTime]::UtcNow -lt $deadline){[Threading.Thread]::Sleep(25)}
if(!$type.GetField('Disposed').GetValue($scan) -or $scans.Count -ne 0){throw 'Native idle expiry did not retire its scan.'}
foreach($scope in @($root,$parent)){foreach($handle in $scope.GetType().GetField('Handles').GetValue($scope)){if(!$handle.IsClosed){throw 'Native idle expiry retained an ancestor handle.'}}}
[Console]::WriteLine('EXPIRED_DISPOSED')
`);
  const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{shell:false,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,FIXTURE_BROKER:path.join(APP,'scripts','project-files-bridge.ps1'),FIXTURE_SOURCE:APP,FIXTURE_DATA:f.dataDirectory,FIXTURE_FIELDS:JSON.stringify(f.common('sub'))},stdio:['pipe','pipe','pipe']});
  const lines=[],waiters=[];let buffer='',diagnostic='';child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const index=buffer.indexOf('\n');if(index<0)break;const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(waiters.length)waiters.shift()(line);else lines.push(line);}});child.stderr.on('data',chunk=>{diagnostic+=chunk;});
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const next=()=>Promise.race([lines.length?Promise.resolve(lines.shift()):new Promise(resolve=>waiters.push(resolve)),exit.then(code=>{throw new Error('Synthetic expiry helper exited before proof: '+code+' '+diagnostic);})]);
  try{assert.equal(await next(),'RETAINED');child.stdin.end('expire\n');assert.equal(await next(),'EXPIRED_DISPOSED');assert.equal(await exit,0,diagnostic);}
  finally{if(child.exitCode===null){child.stdin.end();await exit;}}
});
