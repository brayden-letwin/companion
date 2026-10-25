import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {executeCapability} from '../server/capability-runtime.mjs';

test('callable capability children cannot use SQLite and retain their normal broker contract',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'companion-cap-sqlite-')),file=path.join(directory,'synthetic.sqlite');
  t.after(async()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'companion-cap-sqlite-'));await rm(directory,{recursive:true,force:true});});
  const db=new DatabaseSync(file);db.exec('CREATE TABLE marker(value TEXT);INSERT INTO marker VALUES(\'Synthetic fixture only\')');db.close();const before=await readFile(file);
  const source=`import sqlite,{DatabaseSync,backup}from'node:sqlite';import{createRequire}from'node:module';export async function execute(args,ctx){const results={};const require=createRequire(import.meta.url);for(const[name,entry]of Object.entries({named:()=>new DatabaseSync(args.file,{readOnly:true}),default:()=>new sqlite.DatabaseSync(args.file),commonjs:()=>new(require('node:sqlite').DatabaseSync)(args.file),builtin:()=>new(process.getBuiltinModule('node:sqlite').DatabaseSync)(args.file),memory:()=>new DatabaseSync(':memory:'),backup:()=>backup({},args.output),namespace:()=>new DatabaseSync(args.namespaced),buffer:()=>new DatabaseSync(Buffer.from(args.file)),url:()=>new DatabaseSync(new URL(args.url))})){try{await entry();results[name]='allowed';}catch(error){results[name]=error.code;}}const note=await ctx.runTool('save_note',{text:'Ordinary broker still works'});return{results,noteId:note.note.id};}`;
  const modulePath=path.join(directory,'example.mjs');await writeFile(modulePath,source);const digest=createHash('sha256').update(source).digest('hex');let calls=0;
  const result=await executeCapability({root:directory,capability:{id:'example',modulePath,moduleHash:digest,hash:digest,version:1,effectPolicy:'workspace',tool:{name:'cap_example'}},arguments:{file,namespaced:path.toNamespacedPath(file),url:new URL('file:///'+file.replaceAll('\\','/')).href,output:path.join(directory,'no-output.sqlite')},runTool:async(name,args)=>{calls++;assert.equal(name,'save_note');assert.equal(args.text,'Ordinary broker still works');return{note:{id:'synthetic-note'}};}});
  for(const value of Object.values(result.value.results))assert.equal(value,'ERR_COMPANION_CAPABILITY_DENIED');assert.equal(calls,1);assert.equal(result.value.noteId,'synthetic-note');assert.deepEqual(await readFile(file),before);
});
