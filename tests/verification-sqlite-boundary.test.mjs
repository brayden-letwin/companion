import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {VERIFICATION_GUARD_SOURCE} from '../server/verification-guard.mjs';

const PRELUDE=String.raw`
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import sqliteDefault,{DatabaseSync,backup,constants} from 'node:sqlite';
const require=createRequire(import.meta.url),fixture=JSON.parse(process.argv[2]);
const outside=fixture.outside,candidate=fixture.candidate,scratch=fixture.scratch;
const sqlitePath=value=>path.toNamespacedPath(value);
const deniedError=error=>error?.code==='ERR_ACCESS_DENIED'||/^ERR_COMPANION_VERIFY_/.test(error?.code||'')||error?.code==='ERR_SQLITE_ERROR'&&(error.errcode===23||/not authorized|authorization denied|readonly|read-only/i.test(error.message));
async function denied(label,callback){let failure;try{await callback();}catch(error){failure=error;}assert.ok(failure&&deniedError(failure),label+' must be denied, received '+String(failure?.code||'success')+': '+String(failure?.message||''));}
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function scratchDb(name='scratch.sqlite'){return new DatabaseSync(sqlitePath(path.join(scratch,name)));}
function readExternal(Constructor=DatabaseSync,filename=outside,options){let db;try{db=new Constructor(filename,options);db.prepare('SELECT value FROM synthetic').get();}finally{db?.close();}}
`;

async function fixture(t){
  const temporary=await mkdtemp(path.join(tmpdir(),'companion-sqlite-boundary-')),candidateRoot=path.join(temporary,'candidate'),scratch=path.join(temporary,'scratch'),external=path.join(temporary,'externalX');
  for(const folder of [candidateRoot,scratch,external])await mkdir(folder);
  const candidate=path.join(candidateRoot,'fixture.sqlite'),outside=path.join(external,'fixture.sqlite');
  for(const [filename,value]of [[candidate,41],[outside,777]]){const db=new DatabaseSync(filename);db.exec('CREATE TABLE synthetic(value INTEGER); INSERT INTO synthetic VALUES('+value+')');db.close();}
  const before=await readFile(outside),guard=path.join(scratch,'trusted-preload.cjs');await writeFile(guard,VERIFICATION_GUARD_SOURCE);
  const extension=path.join(external,'synthetic-not-a-library.dll');await writeFile(extension,'Synthetic text fixture; never executable code.');
  t.after(async()=>{assert.deepEqual(await readFile(outside),before,'The outside synthetic database must remain byte-identical.');assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep+'companion-sqlite-boundary-'));await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:25});});
  async function run(code,{writeGrant=scratch,extra={}}={}){
    const source=path.join(candidateRoot,'attack.mjs');await writeFile(source,PRELUDE+'\n'+code+'\nconsole.log("GUARD_PROOF_OK");\n');
    const payload={candidate,outside,scratch,external,extension,...extra},env={TEMP:scratch,TMP:scratch,USERPROFILE:scratch,APPDATA:scratch,LOCALAPPDATA:scratch,CI:'1',NO_COLOR:'1'};for(const key of ['SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
    return new Promise((resolve,reject)=>{let output='',settled=false;const child=spawn(process.execPath,['--permission','--allow-fs-read='+candidateRoot,'--allow-fs-read='+scratch,'--allow-fs-write='+writeGrant,'--no-addons','--require',guard,source,JSON.stringify(payload)],{cwd:candidateRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const timer=setTimeout(()=>{child.kill();finish(new Error('The isolated SQLite proof timed out.'));},8000);
      function finish(error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(output);}
      function data(bytes){output+=bytes.toString('utf8');if(output.length>32000){child.kill();finish(new Error('The isolated proof output exceeded its limit.'));}}
      child.stdout.on('data',data);child.stderr.on('data',data);child.once('error',finish);child.once('close',code=>{if(code!==0)return finish(new Error('Restricted child failed ('+code+'):\n'+output));try{assert.match(output,/GUARD_PROOF_OK/);finish();}catch(error){finish(error);}});
    });
  }
  return{temporary,candidateRoot,candidate,scratch,outside,external,run};
}

test('SQLite constructor forms and delayed opens cannot read outside the actual restricted roots',async t=>{
  const f=await fixture(t);await f.run(String.raw`
assert.equal(process.permission.has('fs.read',outside),false);
for(const filename of [outside,sqlitePath(outside),Buffer.from(outside),pathToFileURL(outside)]){
  await denied('outside constructor',()=>readExternal(DatabaseSync,filename));
  await denied('outside readonly constructor',()=>readExternal(DatabaseSync,filename,{readOnly:true}));
  await denied('outside deferred open',()=>{let db;try{db=new DatabaseSync(filename,{open:false,readOnly:true});db.open();db.prepare('SELECT value FROM synthetic').get();}finally{try{db?.close();}catch{}}});
}
for(const filename of [candidate,sqlitePath(candidate),Buffer.from(candidate),pathToFileURL(candidate)])await denied('readonly candidate has no writable sidecar parent',()=>readExternal(DatabaseSync,filename,{readOnly:true}));
`);
});

test('all builtin export and constructor reflection routes retain the native file boundary',async t=>{
  const f=await fixture(t);await f.run(String.raw`
const common=require('node:sqlite'),builtin=process.getBuiltinModule('node:sqlite'),memory=new DatabaseSync(':memory:');
const constructors=[DatabaseSync,sqliteDefault.DatabaseSync,common.DatabaseSync,builtin.DatabaseSync,memory.constructor,Object.getPrototypeOf(memory).constructor,memory.createTagStore().db.constructor];
for(const Constructor of constructors)await denied('export/prototype constructor',()=>readExternal(Constructor,outside));
await denied('Reflect.construct alternate newTarget',()=>{const db=Reflect.construct(DatabaseSync,[outside],function Alternate(){});try{db.prepare('SELECT value FROM synthetic').get();}finally{db.close();}});
const parent=Object.getPrototypeOf(DatabaseSync);
if(parent!==Function.prototype){let leaked;try{leaked=Reflect.construct(parent,[outside]);}catch(error){assert.ok(error instanceof TypeError||deniedError(error));}if(leaked){try{assert.fail('The wrapper exposes a constructible native parent.');}finally{leaked.close?.();}}}
memory.close();
if(typeof process.binding==='function'){try{process.binding('sqlite');assert.fail('The internal SQLite binding must not provide an unguarded database constructor.');}catch(error){assert.ok(error.code==='ERR_ACCESS_DENIED'||/No such module|not allowed|restricted|denied/i.test(error.message));}}
`);
});

test('captured permission and path helpers cannot be replaced to authorize an excluded database',async t=>{
  const f=await fixture(t);await f.run(String.raw`
const savedHas=process.permission.has,savedPermission=process.permission,savedResolve=path.resolve;
try{try{process.permission.has=()=>true;}catch{}await denied('patched permission.has',()=>readExternal());}finally{try{process.permission.has=savedHas;}catch{}}
try{try{process.permission={has:()=>true};}catch{}await denied('replaced permission object',()=>readExternal());}finally{try{process.permission=savedPermission;}catch{}}
try{try{path.resolve=()=>path.join(scratch,'allowed.sqlite');}catch{}await denied('patched path.resolve',()=>readExternal());}finally{try{path.resolve=savedResolve;}catch{}}
`);
});

test('options getters cannot flip readOnly or mutate Buffer and URL targets after validation',async t=>{
  const f=await fixture(t),allowed=path.join(f.scratch,'xxfixture.sqlite');await copyFile(f.candidate,allowed);const before=await readFile(allowed);
  await f.run(String.raw`
let reads=0;await denied('readonly getter flip',()=>{let db;try{db=new DatabaseSync(fixture.allowed,{get readOnly(){return reads++===0;}});db.exec('INSERT INTO synthetic VALUES(999)');}finally{db?.close();}});
const filename=Buffer.from(fixture.allowed),outsideName=Buffer.from(outside);assert.equal(filename.length,outsideName.length);
let buffered;try{buffered=new DatabaseSync(filename,{get readOnly(){outsideName.copy(filename);return true;}});assert.equal(buffered.prepare('SELECT value FROM synthetic').get().value,41,'A Buffer mutation must not read the excluded database.');}catch(error){assert.ok(deniedError(error),error.message);}finally{buffered?.close();}
const url=pathToFileURL(fixture.allowed);let linked;try{linked=new DatabaseSync(url,{get readOnly(){url.href=pathToFileURL(outside).href;return true;}});assert.equal(linked.prepare('SELECT value FROM synthetic').get().value,41,'A URL mutation must not read the excluded database.');}catch(error){assert.ok(deniedError(error),error.message);}finally{linked?.close();}
`,{extra:{allowed}});assert.deepEqual(await readFile(allowed),before);
});

test('native SQL cannot attach excluded files or create ungranted VACUUM output',async t=>{
  const f=await fixture(t),vacuum=path.join(f.external,'vacuum-output.sqlite');
  await f.run(String.raw`
const db=scratchDb();db.exec('CREATE TABLE local(value);INSERT INTO local VALUES(1)');
for(const target of [outside,sqlitePath(outside),'file:'+outside.replaceAll('\\','/')+'?mode=ro']){
  await denied('exec ATTACH',()=>db.exec('ATTACH DATABASE '+quote(target)+' AS leaked'));
  await denied('bound ATTACH',()=>db.prepare('ATTACH DATABASE ? AS leaked').run(target));
}
await denied('VACUUM INTO excluded target',()=>db.exec('VACUUM INTO '+quote(fixture.vacuum)));
await denied('bound VACUUM INTO excluded target',()=>db.prepare('VACUUM INTO ?').run(fixture.vacuum));
db.close();
`,{extra:{vacuum}});await assert.rejects(access(vacuum),{code:'ENOENT'});
});

test('authorizer replacement, shadowing, borrowed methods and reopen cannot restore ATTACH',async t=>{
  const f=await fixture(t);await f.run(String.raw`
const db=scratchDb(),proto=Object.getPrototypeOf(db),saved=proto.setAuthorizer;
for(const change of [()=>db.setAuthorizer(null),()=>db.setAuthorizer(()=>constants.SQLITE_OK),()=>Object.defineProperty(db,'setAuthorizer',{value:()=>{}}),()=>Object.defineProperty(proto,'setAuthorizer',{value:()=>{}}),()=>saved.call(db,()=>constants.SQLITE_OK)]){
  try{change();}catch(error){assert.ok(error instanceof TypeError||deniedError(error));}
  await denied('immutable mandatory authorizer',()=>db.prepare('ATTACH DATABASE ? AS leaked').run(outside));
}
const serialized=db.serialize();try{db.deserialize(serialized);}catch(error){assert.ok(deniedError(error));}assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,2);await denied('authorizer after deserialize or safe refusal',()=>db.prepare('ATTACH DATABASE ? AS leaked').run(outside));
await denied('defensive mode cannot be disabled',()=>db.enableDefensive(false));
db.close();db.open();await denied('authorizer after reopen',()=>db.prepare('ATTACH DATABASE ? AS leaked').run(outside));db.close();
const deferred=new DatabaseSync(sqlitePath(path.join(scratch,'deferred.sqlite')),{open:false});deferred.open();assert.equal(deferred.prepare('PRAGMA temp_store').get().temp_store,2);await denied('mandatory authorizer after deferred open',()=>deferred.prepare('ATTACH DATABASE ? AS leaked').run(outside));deferred.close();
`);
});

test('backup destinations cannot escape through string, namespaced, Buffer, URL or builtin exports',async t=>{
  const f=await fixture(t),destinations=Array.from({length:5},(_,index)=>path.join(f.external,'backup-'+index+'.sqlite'));
  await f.run(String.raw`
const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE saved(value);INSERT INTO saved VALUES(42)');
const targets=[fixture.destinations[0],sqlitePath(fixture.destinations[1]),Buffer.from(fixture.destinations[2]),pathToFileURL(fixture.destinations[3])];
for(const target of targets)await denied('backup excluded target',()=>backup(db,target));
await denied('backup overwrite excluded existing DB',()=>sqliteDefault.backup(db,outside));
await denied('getBuiltinModule backup excluded target',()=>process.getBuiltinModule('node:sqlite').backup(db,fixture.destinations[4]));
db.close();
`,{extra:{destinations}});for(const filename of destinations)await assert.rejects(access(filename),{code:'ENOENT'});
});

test('extension loading stays disabled through constructor options, methods and SQL',async t=>{
  const f=await fixture(t);await f.run(String.raw`
let db;try{db=new DatabaseSync(':memory:',{allowExtension:true});}catch(error){assert.ok(deniedError(error));db=new DatabaseSync(':memory:');}
await denied('enable native extension',()=>db.enableLoadExtension(true));
await denied('native loadExtension',()=>db.loadExtension(fixture.extension));
await denied('SQL extension loading',()=>db.prepare('SELECT load_extension(?)').get(fixture.extension));db.close();
`);
});

test('native temporary storage cannot spill through replaced environment variables or unsafe pragmas',async t=>{
  const f=await fixture(t);await f.run(String.raw`
process.env.TEMP=fixture.external;process.env.TMP=fixture.external;
const db=new DatabaseSync(':memory:');assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,2);
await denied('temp_store FILE',()=>db.exec('PRAGMA temp_store=FILE'));
await denied('temp_store default may spill',()=>db.exec('PRAGMA temp_store=DEFAULT'));
await denied('native temp directory',()=>db.exec('PRAGMA temp_store_directory='+quote(fixture.external)));
await denied('native data directory',()=>db.exec('PRAGMA data_store_directory='+quote(fixture.external)));
const names=new Set(db.prepare('PRAGMA function_list').all().map(row=>row.name));
for(const name of ['readfile','writefile','load_extension'])if(names.has(name))await denied('unsafe native SQL function '+name,()=>db.prepare('SELECT '+name+'(?)').get(outside));
assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,2);db.close();
`);
});

test('candidate prototype and global replacements cannot turn off native temporary-storage restrictions',async t=>{
  const f=await fixture(t);await f.run(String.raw`
const db=new DatabaseSync(':memory:'),savedIncludes=Array.prototype.includes,savedString=globalThis.String;
try{try{Array.prototype.includes=()=>false;}catch{}await denied('patched array includes cannot allow FILE spill',()=>db.exec('PRAGMA temp_store=FILE'));}finally{try{Array.prototype.includes=savedIncludes;}catch{}}
try{try{globalThis.String=()=> 'safe_unrelated_name';}catch{}await denied('replaced String cannot hide unsafe pragma',()=>db.exec('PRAGMA temp_store=FILE'));}finally{try{globalThis.String=savedString;}catch{}}
assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,2);db.close();
`);
});

test('a file-only write grant cannot authorize writable native SQLite sidecars',async t=>{
  const f=await fixture(t),exact=path.join(f.scratch,'exact-only.sqlite');await copyFile(f.candidate,exact);
  const before=await readFile(exact);await f.run(String.raw`
await denied('RW SQLite requires parent write grant',()=>{let db;try{db=new DatabaseSync(sqlitePath(fixture.exact));db.exec('PRAGMA journal_mode=WAL;INSERT INTO synthetic VALUES(999)');}finally{db?.close();}});
`,{writeGrant:exact,extra:{exact}});assert.deepEqual(await readFile(exact),before);for(const suffix of ['-wal','-shm','-journal'])await assert.rejects(access(exact+suffix),{code:'ENOENT'});
});

test('readonly candidate WAL cannot create an ungranted shared-memory file',async t=>{
  const f=await fixture(t),writerPath=path.join(f.temporary,'wal-source.sqlite'),target=path.join(f.candidateRoot,'readonly-wal.sqlite'),writer=new DatabaseSync(writerPath);
  try{writer.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE synthetic(value);INSERT INTO synthetic VALUES(42)');await copyFile(writerPath,target);await copyFile(writerPath+'-wal',target+'-wal');}finally{writer.close();}
  await f.run(String.raw`await denied('readonly WAL requires writable sidecar parent',()=>readExternal(DatabaseSync,fixture.wal,{readOnly:true}));`,{extra:{wal:target}});
  await assert.rejects(access(target+'-shm'),{code:'ENOENT'});
});

test('legitimate in-memory and scratch WAL, readonly and backup SQLite remain usable',async t=>{
  const f=await fixture(t);await f.run(String.raw`
const memory=new DatabaseSync(':memory:');memory.exec('CREATE TABLE memory(value);INSERT INTO memory VALUES(42)');assert.equal(memory.prepare('SELECT value FROM memory').get().value,42);
const filename=path.join(scratch,'legitimate.sqlite'),db=new DatabaseSync(sqlitePath(filename));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE real(value);INSERT INTO real VALUES(42)');assert.equal(db.prepare('SELECT value FROM real').get().value,42);db.close();
for(const value of [filename,sqlitePath(filename),Buffer.from(filename),pathToFileURL(filename)]){const read=new DatabaseSync(value,{readOnly:true});assert.equal(read.prepare('SELECT value FROM real').get().value,42);read.close();}
const destination=path.join(scratch,'valid-backup.sqlite');await backup(memory,pathToFileURL(destination));const copied=new DatabaseSync(sqlitePath(destination),{readOnly:true});assert.equal(copied.prepare('SELECT value FROM memory').get().value,42);copied.close();memory.close();
await denied('fixed network preload remains active',()=>import('node:net').then(module=>module.connect({host:'127.0.0.1',port:1})));
`);
});
