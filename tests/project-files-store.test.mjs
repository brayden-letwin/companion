import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createProjectFilesStore} from '../server/project-files-store.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-project-store-')),stores=[];const open=async()=>{const value=await createProjectFilesStore({dataDirectory});stores.push(value);return value;},store=await open();t.after(async()=>{for(const value of stores)value.close();assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir())+path.sep+'companion-project-store-'));await rm(dataDirectory,{recursive:true,force:true});});return{store,open,dataDirectory};}
const grantInput=(folder,identity='synthetic-directory-file-id')=>({canonicalPath:folder,identity,label:'Synthetic selected folder'});

test('deep private directories keep real SQLite WAL transactions and receipts durable across restart',async t=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'companion-project-store-deep-')),stores=[];
  let dataDirectory=temporary;while(path.join(dataDirectory,'project-files.sqlite').length<330)dataDirectory=path.join(dataDirectory,'bounded-private-segment-01234567890123456789');
  t.after(async()=>{for(const value of stores)value.close();assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep+'companion-project-store-deep-'));await rm(temporary,{recursive:true,force:true});});
  const open=async()=>{const value=await createProjectFilesStore({dataDirectory});stores.push(value);return value;};
  const store=await open(),grant=store.grant(grantInput(path.join(temporary,'synthetic-chosen-root'))),editId=randomUUID(),digest=hash('deep durable original edit');
  const input={id:editId,digest,projectId:grant.projectId,grantEpoch:grant.grantEpoch,path:'notes.txt',action:'write'};
  store.beginEdit(input);const result={id:editId,projectId:grant.projectId,grantEpoch:grant.grantEpoch,path:'notes.txt',status:'applied',beforeHash:null,afterHash:hash('actual recorded contents'),bytes:24,undoAvailable:true};
  store.finishEdit(editId,{state:'applied',result});const revoked=store.revoke(grant);store.close();
  const restarted=await open();assert.ok(path.join(dataDirectory,'project-files.sqlite').length>=330);assert.equal(restarted.getGrant(grant.projectId).grantEpoch,revoked.grantEpoch);assert.equal(restarted.getGrant(grant.projectId).revoked,true);
  assert.equal(restarted.beginEdit(input).replayed,true);assert.deepEqual(restarted.findEdit(editId,digest).result,result);assert.equal(restarted.edits().length,1);
});
test('grant identity/epochs persist and a different physical root cannot silently replace a previous project ID',async t=>{
  const f=await fixture(t),root=path.join(f.dataDirectory,'synthetic-root'),first=f.store.grant(grantInput(root));assert.equal(f.store.grant(grantInput(root)).projectId,first.projectId);const revoked=f.store.revoke(first);assert.equal(revoked.revoked,true);assert.ok(revoked.grantEpoch>first.grantEpoch);assert.deepEqual(f.store.revoke(first),revoked);const regranted=f.store.grant(grantInput(root));assert.equal(regranted.projectId,first.projectId);assert.ok(regranted.grantEpoch>revoked.grantEpoch);assert.throws(()=>f.store.revoke(first),{code:'project_grant_changed'});
  const replaced=f.store.grant(grantInput(root,'a-different-directory-id'));assert.notEqual(replaced.projectId,first.projectId);f.store.close();const restarted=await f.open();assert.equal(restarted.getGrant(first.projectId).identity,first.identity);assert.equal(restarted.getGrant(replaced.projectId).identity,'a-different-directory-id');
});
test('edit insertion and terminal receipts are transactional, idempotent and never prune pending/uncertain evidence',async t=>{
  const f=await fixture(t),grant=f.store.grant(grantInput(path.join(f.dataDirectory,'synthetic-root'))),id=randomUUID(),input={id,digest:hash('same operation'),projectId:grant.projectId,grantEpoch:grant.grantEpoch,path:'notes.txt',action:'write'},db=new DatabaseSync(path.join(f.dataDirectory,'project-files.sqlite'));
  db.exec("CREATE TRIGGER synthetic_edit_failure BEFORE INSERT ON project_edits BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");assert.throws(()=>f.store.beginEdit(input),/synthetic write failure/);assert.equal(f.store.findEdit(id,input.digest),null);db.exec('DROP TRIGGER synthetic_edit_failure');const pending=f.store.beginEdit(input);assert.equal(pending.replayed,false);assert.equal(f.store.beginEdit(input).replayed,true);assert.throws(()=>f.store.findEdit(id,hash('changed input')),{code:'project_operation_conflict'});assert.throws(()=>f.store.markPruned(id),{code:'project_recovery_required'});
  const uncertain={id,projectId:grant.projectId,grantEpoch:grant.grantEpoch,path:'notes.txt',status:'recovery_required',beforeHash:null,afterHash:null,bytes:0,undoAvailable:false,outcomeUnknown:true};f.store.finishEdit(id,{state:'recovery_required',result:uncertain,backupBytes:50});assert.throws(()=>f.store.markPruned(id),{code:'project_recovery_required'});const actual={...uncertain,status:'applied',beforeHash:hash('before'),afterHash:hash('after'),bytes:5,undoAvailable:true,outcomeUnknown:false};const completed=f.store.finishEdit(id,{state:'applied',result:actual,backupBytes:60});assert.deepEqual(f.store.finishEdit(id,{state:'applied',result:actual,backupBytes:60}),completed);assert.throws(()=>f.store.finishEdit(id,{state:'failed',result:actual}),{code:'project_operation_conflict'});db.close();
  const pruned=f.store.markPruned(id);assert.equal(pruned.pruned,true);assert.equal(pruned.result.undoAvailable,false);assert.equal(pruned.backupBytes,0);f.store.close();const restarted=await f.open();assert.equal(restarted.findEdit(id,input.digest).pruned,true);assert.equal(restarted.findEdit(id,input.digest).result.afterHash,actual.afterHash);
});
test('grant and receipt limits reject without changing existing private state',async t=>{
  const f=await fixture(t);for(let index=0;index<20;index++)f.store.grant(grantInput(path.join(f.dataDirectory,'root-'+index),'identity-'+index));assert.throws(()=>f.store.grant(grantInput(path.join(f.dataDirectory,'root-21'))),{code:'project_limit'});assert.equal(f.store.grants().length,20);assert.throws(()=>f.store.getEdit('../../outside'),{code:'invalid_project_id'});assert.throws(()=>f.store.beginEdit({id:randomUUID(),digest:'not a hash'}),{code:'invalid_project_operation'});
});
