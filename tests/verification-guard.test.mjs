import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {VERIFICATION_GUARD_SOURCE} from '../server/verification-guard.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'companion-verification-guard-')),candidate=path.join(root,'candidate'),scratch=path.join(root,'scratch'),outside=path.join(root,'outside');for(const file of[candidate,scratch,outside])await mkdir(file);
  const outsideFile=path.join(outside,'synthetic.sqlite'),candidateFile=path.join(candidate,'readonly.sqlite');for(const file of[outsideFile,candidateFile]){const db=new DatabaseSync(file);db.exec('CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES (\'SYNTHETIC_CANARY\')');db.close();}
  const guard=path.join(scratch,'trusted-preload.cjs');await writeFile(guard,VERIFICATION_GUARD_SOURCE);
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep+'companion-verification-guard-'));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:25});});
  async function run(source,{write=scratch}={}){
    const entry=path.join(candidate,'check.mjs');await writeFile(entry,source);
    const child=spawn(process.execPath,['--permission','--allow-fs-read='+candidate,'--allow-fs-read='+scratch,'--allow-fs-write='+write,'--no-addons','--require',guard,entry,scratch,outsideFile,candidateFile],{cwd:candidate,shell:false,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,TEMP:scratch,TMP:scratch},stdio:['ignore','pipe','pipe']});
    let output='',diagnostic='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{diagnostic+=chunk;});const timer=setTimeout(()=>child.kill(),10000);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);assert.equal(code,0,diagnostic+'\n'+output);return output;
  }
  return{root,candidate,scratch,outsideFile,candidateFile,run};
}

test('trusted preload supports memory, scratch WAL, deferred/reopened databases and checked backups',async t=>{
  const f=await fixture(t);const output=await f.run(`import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync,backup} from 'node:sqlite';
const scratch=process.argv[2],db=new DatabaseSync(path.join(scratch,'work.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE data(value); INSERT INTO data VALUES(42)');assert.equal(db.prepare('SELECT value FROM data').get().value,42);assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,2);await backup(db,path.join(scratch,'backup.sqlite'));db.close();db.open();assert.equal(db.prepare('SELECT value FROM data').get().value,42);assert.throws(()=>db.exec("ATTACH DATABASE ':memory:' AS other"));db.close();
const deferred=new DatabaseSync(':memory:',{open:false});deferred.open();assert.equal(deferred.prepare('PRAGMA temp_store').get().temp_store,2);assert.throws(()=>deferred.setAuthorizer(null),{code:'ERR_COMPANION_VERIFY_SQLITE'});assert.throws(()=>deferred.enableDefensive(false),{code:'ERR_COMPANION_VERIFY_SQLITE'});assert.throws(()=>deferred.deserialize(new Uint8Array()),{code:'ERR_COMPANION_VERIFY_SQLITE'});deferred.close();
const readOnly=new DatabaseSync(path.join(scratch,'backup.sqlite'),{readOnly:true});assert.equal(readOnly.prepare('SELECT value FROM data').get().value,42);assert.throws(()=>readOnly.exec('INSERT INTO data VALUES(99)'));readOnly.close();console.log('SCRATCH_SQLITE_OK');`);assert.match(output,/SCRATCH_SQLITE_OK/);
});

test('native SQLite and backup retain long Windows path support within granted scratch directories',async t=>{
  const f=await fixture(t);await f.run(`import assert from 'node:assert/strict';import path from 'node:path';import fs from 'node:fs';import{DatabaseSync,backup}from'node:sqlite';
const directory=path.join(process.argv[2],...Array(5).fill('synthetic-long-directory-segment-1234567890'));assert.ok(directory.length>260);fs.mkdirSync(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'database.sqlite'));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE long_path(value);INSERT INTO long_path VALUES(42)');assert.equal(db.prepare('SELECT value FROM long_path').get().value,42);await backup(db,path.join(directory,'backup.sqlite'));db.close();const restored=new DatabaseSync(path.join(directory,'backup.sqlite'),{readOnly:true});assert.equal(restored.prepare('SELECT value FROM long_path').get().value,42);restored.close();`);
});

test('SQLite cannot read outside fixtures or open readonly candidate files with ungranted native sidecar access',async t=>{
  const f=await fixture(t);const before=await readFile(f.outsideFile);await f.run(`import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
const outside=process.argv[3],candidate=process.argv[4];for(const file of[outside,Buffer.from(outside),pathToFileURL(outside),path.toNamespacedPath(outside),candidate])assert.throws(()=>new DatabaseSync(file,{readOnly:true}),{code:'ERR_COMPANION_VERIFY_SQLITE'});
const memory=new DatabaseSync(':memory:');assert.throws(()=>memory.prepare('ATTACH DATABASE ? AS outside').run(outside));assert.throws(()=>memory.exec('VACUUM INTO '+JSON.stringify(outside)));assert.throws(()=>new memory.constructor(outside),{code:'ERR_COMPANION_VERIFY_SQLITE'});memory.close();`);assert.deepEqual(await readFile(f.outsideFile),before);
  await f.run(`import assert from 'node:assert/strict';import path from 'node:path';import{DatabaseSync}from'node:sqlite';assert.throws(()=>new DatabaseSync(path.join(process.argv[2],'exact.sqlite')),{code:'ERR_COMPANION_VERIFY_SQLITE'});`,{write:path.join(f.scratch,'exact.sqlite')});
});

test('saved SQLite controls survive public permission, prototype and global monkeypatches',async t=>{
  const f=await fixture(t);await f.run(`import assert from 'node:assert/strict';import path from 'node:path';import sqlite from 'node:sqlite';
const db=new sqlite.DatabaseSync(':memory:'),originalIncludes=Array.prototype.includes,originalString=globalThis.String;Array.prototype.includes=()=>false;globalThis.String=()=> 'harmless';process.permission.has=()=>true;try{path.resolve=()=>process.argv[2]}catch{}
let tempDenied=false,outsideDenied=false;try{db.exec('PRAGMA temp_store=FILE')}catch(error){tempDenied=error.errcode===23||error.code==='ERR_SQLITE_ERROR'}try{new sqlite.DatabaseSync(process.argv[3])}catch(error){outsideDenied=error.code==='ERR_COMPANION_VERIFY_SQLITE'}
Array.prototype.includes=originalIncludes;globalThis.String=originalString;assert.equal(tempDenied,true);assert.equal(outsideDenied,true);assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,2);assert.throws(()=>sqlite.DatabaseSync.prototype.setAuthorizer.call(db,()=>sqlite.constants.SQLITE_OK),{code:'ERR_COMPANION_VERIFY_SQLITE'});assert.throws(()=>db.loadExtension('anything'),{code:'ERR_COMPANION_VERIFY_SQLITE'});assert.throws(()=>db.enableLoadExtension(true),{code:'ERR_COMPANION_VERIFY_SQLITE'});assert.throws(()=>Object.defineProperty(sqlite,'DatabaseSync',{value:function(){}}));db.close();`);
});

test('inherited option getters and setters cannot suppress native authorizer installation',async t=>{
  const f=await fixture(t);await f.run(`import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';
let reads=0;Object.defineProperty(Object.prototype,'open',{configurable:true,get(){return ++reads%2===1},set(){}});Object.defineProperty(Object.prototype,'allowExtension',{configurable:true,get(){return true},set(){}});let deniedDefault=false,deniedInherited=false,tempDefault,tempInherited;
try{const first=new DatabaseSync(':memory:');try{first.exec("ATTACH DATABASE ':memory:' AS escaped")}catch{deniedDefault=true}tempDefault=first.prepare('PRAGMA temp_store').get().temp_store;first.close();const inherited=new DatabaseSync(':memory:',{});try{inherited.exec("ATTACH DATABASE ':memory:' AS escaped")}catch{deniedInherited=true}tempInherited=inherited.prepare('PRAGMA temp_store').get().temp_store;inherited.close();}finally{delete Object.prototype.open;delete Object.prototype.allowExtension;}
assert.equal(deniedDefault,true);assert.equal(deniedInherited,true);assert.equal(tempDefault,2);assert.equal(tempInherited,2);assert.equal(reads,1);`);
});

test('existing network denial covers globals and native CommonJS/ESM/builtin entry points',async t=>{
  const f=await fixture(t);await f.run(`import assert from 'node:assert/strict';import http from 'node:http';import {createConnection} from 'node:net';import{resolve4}from'node:dns/promises';
const deny={code:'ERR_COMPANION_VERIFY_NETWORK'};assert.throws(()=>fetch('http://127.0.0.1:1/'),deny);assert.throws(()=>http.get('http://127.0.0.1:1/'),deny);assert.throws(()=>createConnection({port:1,host:'127.0.0.1'}),deny);assert.throws(()=>resolve4('example.invalid'),deny);assert.throws(()=>process.getBuiltinModule('https').get('https://example.invalid/'),deny);`);
});
