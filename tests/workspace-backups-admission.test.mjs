import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,lstat} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createProductivityApi} from '../server/productivity-api.mjs';
import {createProductivityStore} from '../server/productivity-store.mjs';

const deferred=()=>{let resolve;const promise=new Promise(value=>{resolve=value;});return{promise,resolve};};
async function fixture(t){
 const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-backup-admission-')),actual=await createProductivityStore({dataDirectory}),afterClose=[],requests=new Set();let storeClosed=false,runtimeCalls=0;
 // Make an accidental late factory capable of opening its private directories,
 // even before the recovery-store implementation is present in this checkout.
 const defaults={workspaceImportCatalog:()=>[],getWorkspaceImport:()=>null,importWorkspaceContent:()=>{throw new Error('No import is authorized by these upload-admission tests.');}};
 const store=new Proxy(actual,{get(target,key){
  if(key==='close')return()=>{storeClosed=true;return target.close();};const value=target[key]??defaults[key];
  return typeof value==='function'?(...args)=>{if(storeClosed)afterClose.push(String(key));return value.apply(target,args);}:value;
 }});
 const api=createProductivityApi({root:path.resolve('.'),dataDirectory,createRuntime:async()=>{runtimeCalls++;return{store,router:{getStatus:async()=>({defaultProviderId:'synthetic',providers:[]})},builder:{close:async()=>{}},tools:{definitions:[],catalog:()=>[]}};}});
 function start(route,{body,headers={},scope=randomUUID(),holdResponse=false}={}){
  const readStarted=deferred(),req=new PassThrough(),nativeIterator=req[Symbol.asyncIterator].bind(req);req.readCount=0;
  req[Symbol.asyncIterator]=()=>{req.readCount++;readStarted.resolve();return nativeIterator();};req.method=body===null?'GET':'POST';req.url='/api/assistant/'+route;req.headers={'content-type':'application/json',...headers};req.socket={localPort:4174};req.aborted=false;
  const res=new EventEmitter();res.destroyed=false;res.writableEnded=false;res.writableFinished=false;res.writeHead=(status,values)=>{res.statusCode=status;res.headers=values;};
  res.finish=()=>{res.writableFinished=true;res.emit('finish');};res.close=()=>{res.destroyed=true;res.emit('close');};
  res.destroy=()=>{if(res.destroyed)return;res.destroyCount=(res.destroyCount||0)+1;res.destroyed=true;req.aborted=true;if(!req.destroyed)req.destroy(req.readCount&&!req.readableEnded?new Error('Synthetic owned response socket closed.'):undefined);res.emit('close');};
  res.end=bytes=>{res.body=JSON.parse(bytes);res.writableEnded=true;if(!holdResponse)res.finish();};
  const work=api.handle(req,res,req.url,{scope,windows:new Map()});const request={req,res,work,readStarted:readStarted.promise};requests.add(request);void work.finally(()=>requests.delete(request)).catch(()=>{});
  if(typeof body==='string')req.end(body);else if(body===null)req.end();return request;
 }
 t.after(async()=>{for(const request of requests)request.req.destroy(new Error('Test cleanup.'));await Promise.allSettled([...requests].map(x=>x.work));await api.close();actual.close();const resolved=path.resolve(dataDirectory);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep+'companion-backup-admission-'));await rm(resolved,{recursive:true,force:true,maxRetries:4,retryDelay:30});});
 return{api,start,dataDirectory,afterClose,get runtimeCalls(){return runtimeCalls;},get closed(){return storeClosed;}};
}

test('a backup request paused in its body cannot initialize private storage or touch the store after shutdown', {timeout:10000},async t=>{
 const f=await fixture(t),id=randomUUID(),request=f.start('backups');request.req.write('{"id":');await request.readStarted;
 assert.equal(f.runtimeCalls,1);assert.equal(f.closed,false);await assert.rejects(lstat(path.join(f.dataDirectory,'workspace-backups')),{code:'ENOENT'});
 await f.api.close();assert.equal(f.closed,true);await request.work;
 assert.equal(request.res.destroyed,true);assert.equal(request.req.destroyed,true);assert.equal(request.res.body,undefined);assert.deepEqual(f.afterClose,[]);assert.equal(f.runtimeCalls,1);
 await assert.rejects(lstat(path.join(f.dataDirectory,'workspace-backups')),{code:'ENOENT'});
});

test('preview upload admission is global before body buffering, leaves workspace reads usable, and releases on abort and malformed input', {timeout:10000},async t=>{
 const f=await fixture(t),first=f.start('backup-recovery/preview');first.req.write('{"archive":');await first.readStarted;
 const denied=f.start('backup-recovery/preview',{body:'{"archive":null}'});await denied.work;assert.equal(denied.res.statusCode,429);assert.equal(denied.res.body.error.code,'preview_busy');assert.equal(denied.req.readCount,0);
 const read=f.start('workspace',{body:null});await read.work;assert.equal(read.res.statusCode,200);assert.equal(read.res.body.revision,0);assert.deepEqual(read.res.body.tasks,[]);
 first.req.aborted=true;first.req.destroy(new Error('Synthetic upload aborted.'));await first.work;assert.ok(first.res.statusCode>=400);
 const malformed=f.start('backup-recovery/preview',{body:'{'});await malformed.work;assert.equal(malformed.res.statusCode,400);assert.equal(malformed.res.body.error.code,'invalid_json');assert.equal(malformed.req.readCount,1);
 const next=f.start('backup-recovery/preview');next.req.write('{');await next.readStarted;
 const deniedAgain=f.start('backup-recovery/preview',{body:'{}'});await deniedAgain.work;assert.equal(deniedAgain.res.statusCode,429);assert.equal(deniedAgain.req.readCount,0);
 next.req.end();await next.work;assert.equal(next.res.statusCode,400);assert.equal(next.res.body.error.code,'invalid_json');assert.deepEqual(f.afterClose,[]);
});

test('oversized preview headers reject without consuming a body or retaining the sole upload slot', {timeout:10000},async t=>{
 const f=await fixture(t),oversized=f.start('backup-recovery/preview',{headers:{'content-length':String(96*1024*1024+1025)}});await oversized.work;
 assert.equal(oversized.res.statusCode,413);assert.equal(oversized.res.body.error.code,'body_too_large');assert.equal(oversized.req.readCount,0);oversized.req.destroy();
 const accepted=f.start('backup-recovery/preview',{body:'{'});await accepted.work;assert.equal(accepted.res.statusCode,400);assert.equal(accepted.res.body.error.code,'invalid_json');assert.equal(accepted.req.readCount,1);
});

test('a preview upload paused before shutdown never persists a preview after its body finally arrives', {timeout:10000},async t=>{
 const f=await fixture(t),request=f.start('backup-recovery/preview');request.req.write('{"archive":');await request.readStarted;await f.api.close();await request.work;
 assert.equal(request.res.destroyed,true);assert.equal(request.req.destroyed,true);assert.equal(request.res.body,undefined);assert.deepEqual(f.afterClose,[]);await assert.rejects(lstat(path.join(f.dataDirectory,'workspace-backups')),{code:'ENOENT'});
});

test('completed download handlers retain global admission until the actual responses finish or close', {timeout:10000},async t=>{
 const f=await fixture(t),id=randomUUID(),created=f.start('backups',{body:JSON.stringify({id})});await created.work;assert.equal(created.res.statusCode,201);
 const one=f.start('backups/'+id+'/download',{body:null,holdResponse:true}),two=f.start('backups/'+id+'/download',{body:null,holdResponse:true});await Promise.all([one.work,two.work]);
 for(const value of [one,two]){assert.equal(value.res.statusCode,200);assert.equal(value.res.writableEnded,true);assert.equal(value.res.writableFinished,false);assert.equal(value.res.body.id,id);}
 const denied=f.start('backups',{body:null});await denied.work;assert.equal(denied.res.statusCode,429);assert.equal(denied.res.body.error.code,'backups_busy');
 const read=f.start('workspace',{body:null});await read.work;assert.equal(read.res.statusCode,200);assert.equal(read.res.body.revision,0);
 one.res.finish();one.res.close(); // Repeated settlement must not free the second download's slot.
 const next=f.start('backups/'+id+'/download',{body:null,holdResponse:true});await next.work;assert.equal(next.res.statusCode,200);
 const stillFull=f.start('backups',{body:null});await stillFull.work;assert.equal(stillFull.res.statusCode,429);
 two.res.close();const reopened=f.start('backups',{body:null});await reopened.work;assert.equal(reopened.res.statusCode,200);assert.equal(reopened.res.body.backups.length,1);next.res.finish();
});

test('an early response close cannot free global admission while its body-reading handler still owns resources', {timeout:10000},async t=>{
 const f=await fixture(t),one=f.start('backups'),two=f.start('backups');one.req.write('{');two.req.write('{');await Promise.all([one.readStarted,two.readStarted]);one.res.close();
 const denied=f.start('backups',{body:null});await denied.work;assert.equal(denied.res.statusCode,429);assert.equal(denied.res.body.error.code,'backups_busy');
 one.req.end();await one.work;const reopened=f.start('backups',{body:null});await reopened.work;assert.equal(reopened.res.statusCode,200);assert.deepEqual(reopened.res.body.backups,[]);
 two.req.aborted=true;two.req.destroy(new Error('Synthetic remaining upload aborted.'));await two.work;assert.deepEqual(f.afterClose,[]);
});

test('shutdown interrupts owned stalled backup downloads while leaving an unrelated workspace response alone', {timeout:10000},async t=>{
 const f=await fixture(t),id=randomUUID(),created=f.start('backups',{body:JSON.stringify({id})});await created.work;
 const one=f.start('backups/'+id+'/download',{body:null,holdResponse:true}),two=f.start('backups/'+id+'/download',{body:null,holdResponse:true}),unrelated=f.start('workspace',{body:null,holdResponse:true});await Promise.all([one.work,two.work,unrelated.work]);
 assert.equal(one.res.statusCode,200);assert.equal(two.res.statusCode,200);assert.equal(one.res.writableFinished,false);assert.equal(two.res.writableFinished,false);assert.equal(unrelated.res.statusCode,200);
 await f.api.close();assert.equal(f.closed,true);
 for(const owned of[one,two]){assert.equal(owned.res.destroyed,true);assert.equal(owned.res.destroyCount,1);assert.equal(owned.req.destroyed,true);}
 assert.equal(unrelated.res.destroyed,false);assert.equal(unrelated.res.destroyCount,undefined);assert.deepEqual(f.afterClose,[]);unrelated.res.finish();
 await f.api.close();assert.equal(one.res.destroyCount,1);assert.equal(two.res.destroyCount,1);
});
