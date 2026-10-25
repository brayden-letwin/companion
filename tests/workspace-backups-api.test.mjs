import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSharedServer} from '../server/shared-server.mjs';
import {createProductivityStore} from '../server/productivity-store.mjs';
import {createProductivityTools} from '../server/productivity-tools.mjs';

async function fixture(t){
 const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-backup-http-'));
 const calls=[];
 const router={getStatus:async()=>({defaultProviderId:'synthetic',providers:[{id:'synthetic',type:'compatible',model:'synthetic',label:'Synthetic',ready:true}]}),complete:async()=>{calls.push('model');throw Error('Recovery must never call a model.');},close:async()=>{}};
 const builder={list:async()=>[],close:async()=>{}};
 const provider={getStatus:async()=>({reasoningReady:false,transcriptionReady:false}),ask:async()=>{throw Error('No legacy model calls are allowed.');},transcribe:async()=>{throw Error('No transcription is allowed.');},cancel(){},cancelScope(){}};
 let store,app,origin;
 async function start(){store=await createProductivityStore({dataDirectory});const tools=createProductivityTools({store,builder});app=await createSharedServer({dbPath:path.join(dataDirectory,'room.sqlite'),port:0,assistantProvider:provider,assistantOptions:{createProductivityRuntime:async()=>({store,router,builder,tools})}});origin=new URL((await app.listen()).url).origin;}
 t.after(async()=>{await app?.close();store?.close();const target=path.resolve(dataDirectory);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep+'companion-backup-http-'));await rm(target,{recursive:true,force:true});});
 await start();
 async function request(method,route,body,user,headers={}){const response=await fetch(origin+'/api/assistant/'+route,{method,headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrfToken}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'});return{status:response.status,headers:response.headers,value:await response.json()};}
 async function session(){const result=await request('GET','session');return{cookie:result.headers.get('set-cookie').split(';')[0],csrfToken:result.value.csrfToken};}
 return{request,session,calls,get store(){return store;},get origin(){return origin;},restart:async()=>{await app.close();store.close();await start();}};
}

test('workspace archive routes require local authentication, origin and CSRF; reads cannot create snapshots or imports',async t=>{
 const f=await fixture(t),id=randomUUID();
 for(const route of ['backups','backups/'+id+'/download','backup-recovery/previews/'+id,'backup-recovery/imports/'+id])assert.equal((await f.request('GET',route)).status,401);
 const user=await f.session(),before=f.store.snapshot();
 assert.deepEqual((await f.request('GET','backups',undefined,user)).value.backups,[]);
 for(const headers of [{Origin:'https://example.invalid'},{'X-CSRF-Token':'wrong'}])assert.equal((await f.request('POST','backups',{id},user,headers)).status,403);
 assert.equal((await f.request('POST','backups',{id,path:'C:/outside'},user)).status,400);
 for(const route of ['backups?path=outside','backup-recovery/previews/'+id+'?limit=not-a-number','backups/'+id+'/download?path=outside'])assert.equal((await f.request('GET',route,undefined,user)).status,400);
 assert.equal((await f.request('GET','backup-recovery/import',undefined,user)).status,405);
 assert.equal((await f.request('GET','backups/'+id+'/delete',undefined,user)).status,405);
 assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(f.calls,[]);
});

test('actual HTTP download and preview recover explicit copies once, retain current history and reconcile receipts after restart',async t=>{
 const f=await fixture(t),user=await f.session(),taskId=randomUUID(),noteId=randomUUID(),routineId=randomUUID();
 const apply=value=>f.store.apply({operationId:randomUUID(),expectedRevision:f.store.snapshot().revision,...value});
 apply({operationId:taskId,type:'addTask',title:'Synthetic calendar task',dueDate:'2026-11-01',details:'Exact task body 😀'});
 apply({operationId:noteId,type:'addNote',title:'Synthetic note',text:'Exact note body\r\nsecond line',tags:['qa']});
 apply({operationId:routineId,type:'saveWorkflow',name:'Synthetic routine',steps:[{tool:'start_focus',arguments:{minutes:25,label:'Synthetic focus'}}]});
 apply({type:'rememberPreference',key:'synthetic-style',value:'Use brief explanations'});
 const conversation=f.store.createConversation({id:randomUUID(),title:'Excluded private chat'});
 const before=f.store.snapshot(),backupId=randomUUID(),created=await f.request('POST','backups',{id:backupId},user);
 assert.equal(created.status,201,JSON.stringify(created.value));assert.equal(created.value.backup.id,backupId);
 assert.deepEqual(created.value.backup.counts,{tasks:1,notes:1,workflows:1,preferences:1});
 const download=await f.request('GET','backups/'+backupId+'/download',undefined,user);
 assert.equal(download.status,200);assert.equal(download.headers.get('content-disposition'),`attachment; filename="companion-workspace-${backupId}.json"`);assert.match(download.headers.get('content-type'),/^application\/json/);assert.equal(download.headers.get('cache-control'),'no-store');
 assert.equal(download.value.format,'companion-workspace-content');assert.deepEqual(download.value.workspace.tasks,before.tasks);
 assert.ok(!JSON.stringify(download.value).includes('Excluded private chat'));assert.deepEqual(Object.keys(download.value.workspace).sort(),['notes','preferences','tasks','workflows']);
 const replay=await f.request('POST','backups',{id:backupId},user);assert.deepEqual(replay.value.backup,created.value.backup);
 const previewed=await f.request('POST','backup-recovery/preview',{archive:download.value},user);assert.equal(previewed.status,201,JSON.stringify(previewed.value));
 const preview=previewed.value.preview;assert.equal(preview.archiveId,backupId);assert.equal(preview.items.length,3);assert.ok(preview.items.every(item=>item.recoverable));assert.deepEqual(f.store.snapshot(),before);
 assert.equal((await f.request('GET','backup-recovery/previews/'+preview.id+'?limit=999',undefined,user)).status,400);
 const selection=[{kind:'task',id:taskId},{kind:'workflow',id:routineId}],id=randomUUID(),request={id,previewId:preview.id,expectedRevision:before.revision,selection};
 const imported=await f.request('POST','backup-recovery/import',request,user);assert.equal(imported.status,200,JSON.stringify(imported.value));
 const receipt=imported.value.receipt;assert.equal(receipt.id,id);assert.equal(receipt.imported.length,2);assert.equal(receipt.appliedRevision,before.revision+1);
 const current=f.store.snapshot();assert.equal(current.tasks.length,2);assert.equal(current.notes.length,1);assert.equal(current.workflows.length,2);assert.deepEqual(current.tasks[0],before.tasks[0]);assert.deepEqual(current.workflows[0],before.workflows[0]);assert.deepEqual(current.preferences,before.preferences);assert.equal(current.focus,null);
 assert.equal(current.workflows[1].enabled,false);assert.deepEqual(current.workflows[1].steps,before.workflows[0].steps);assert.equal(current.tasks[1].dueDate,'2026-11-01');assert.notEqual(current.tasks[1].id,taskId);
 assert.equal(f.store.getConversation(conversation.id).title,'Excluded private chat');
 assert.deepEqual((await f.request('GET','backup-recovery/imports/'+id,undefined,user)).value.receipt,receipt);
 assert.equal((await f.request('POST','backup-recovery/import',{...request,selection:[{kind:'note',id:noteId}]},user)).status,409);
 assert.deepEqual((await f.request('POST','backup-recovery/import',request,user)).value.receipt,receipt);assert.deepEqual(f.store.snapshot(),current);
 await f.restart();const next=await f.session();assert.deepEqual((await f.request('GET','backup-recovery/imports/'+id,undefined,next)).value.receipt,receipt);assert.deepEqual((await f.request('POST','backup-recovery/import',request,next)).value.receipt,receipt);assert.deepEqual(f.store.snapshot(),current);
 const deleted=await f.request('POST','backups/'+backupId+'/delete',{},next);assert.equal(deleted.status,200);assert.deepEqual((await f.request('GET','backups',undefined,next)).value.backups,[]);assert.equal((await f.request('GET','backups/'+backupId+'/download',undefined,next)).status,404);assert.deepEqual(f.calls,[]);
});

test('backup controls stay outside model/MCP catalogs and malformed archives cannot change the live workspace',async t=>{
 const f=await fixture(t),user=await f.session(),before=f.store.snapshot();
 const catalog=(await f.request('GET','integrations',undefined,user)).value.tools;
 assert.ok(catalog.every(tool=>!/(backup|recover|import)/i.test(tool.name)));
 const bad={format:'companion-workspace-content',version:1,id:randomUUID(),appVersion:'0.21.0',createdAt:new Date().toISOString(),revision:0,workspace:{tasks:[],notes:[],workflows:[],preferences:[]},credentials:'must reject'};
 assert.equal((await f.request('POST','backup-recovery/preview',{archive:bad},user)).status,400);
 assert.equal((await f.request('POST','backup-recovery/import',{id:randomUUID(),previewId:randomUUID(),expectedRevision:0,selection:[{kind:'preference',id:randomUUID()}]},user)).status,400);
 assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(f.calls,[]);
 const module=await fetch(f.origin+'/src/workspace-backups.mjs');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);assert.match(await module.text(),/createWorkspaceBackupsUI/);
});
