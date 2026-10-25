import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectFileService} from '../server/project-files-service.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex'),clone=value=>structuredClone(value);
const fault=(code,statusCode=409)=>Object.assign(new Error('Synthetic native fixture failure.'),{code,statusCode});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function until(check){for(let index=0;index<100;index++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Synthetic search did not reach its expected phase.');}
function content(text){const bytes=Buffer.from(text),rest=text.replaceAll('\r\n',''),styles=[text.includes('\r\n')&&'crlf',rest.includes('\r')&&'cr',rest.includes('\n')&&'lf'].filter(Boolean);return{content:text,hash:hash(bytes),byteLength:bytes.length,characterLength:text.length,readAt:'2026-10-25T12:00:00.000Z',lineEndings:styles.length>1?'mixed':styles[0]||'none',bom:text.startsWith('\ufeff')};}
function nativeFixture(folder,initial={}){
  const files=new Map(Object.entries(initial)),tokens=new Map(),calls=[];let closed=false;
  const native={files,tokens,calls,scanHook:null,readHook:null,inspectHook:null,
    async chooseFolder(){return{path:folder};},
    async run(action,fields,options={}){
      calls.push({action,fields:clone(fields),signal:options.signal});
      if(action==='inspectRoot'){if(native.inspectHook)await native.inspectHook(fields,options);return{canonicalPath:folder,identity:'synthetic-original-root',label:'Synthetic search project'};}
      if(action==='closeScan'){tokens.delete(fields.cursor);return{closed:true};}
      if(action==='read'){
        if(native.readHook)await native.readHook(fields,options);const value=files.get(fields.path);if(value===undefined)throw fault('project_file_not_found',404);if(value?.error)throw fault(value.error,value.statusCode||415);return content(typeof value==='string'?value:value.text);
      }
      if(action==='scanDirectory'){
        if(native.scanHook)await native.scanHook(fields,options);let scan;
        if(fields.cursor){scan=tokens.get(fields.cursor);if(!scan||scan.path!==fields.path)throw fault('project_scan_expired',410);tokens.delete(fields.cursor);}
        else{
          const prefix=fields.path?fields.path+'/':'',found=new Map();for(const[file,value]of files){if(!file.startsWith(prefix))continue;const remaining=file.slice(prefix.length),name=remaining.split('/')[0];if(!name)continue;const directory=remaining.includes('/');if(!found.has(name))found.set(name,{name,path:prefix+name,kind:directory?'directory':'file',byteLength:directory?0:typeof value==='string'?Buffer.byteLength(value):value.bytes??Buffer.byteLength(value.text||'')});}
          scan={path:fields.path,entries:[...found.values()].sort((a,b)=>a.path.localeCompare(b.path)),offset:0};
        }
        const raw=scan.entries.slice(scan.offset,scan.offset+200),entries=raw.filter(entry=>!entry.name.startsWith('.'));scan.offset+=raw.length;const hasMore=scan.offset<scan.entries.length,nextCursor=hasMore?randomUUID():null;if(nextCursor)tokens.set(nextCursor,scan);
        return{entries,scanned:raw.length,scanLimit:200,skipped:{protected:raw.length-entries.length,unavailable:0},hasMore,nextCursor,directoryIdentity:'synthetic-directory:'+fields.path};
      }
      throw fault('unexpected_native_action',400);
    },
    async close(){closed=true;tokens.clear();},get closed(){return closed;}
  };return native;
}
async function fixture(t,files={},options={}){
  const temporary=await mkdtemp(path.join(tmpdir(),'companion-project-search-')),root=path.join(temporary,'source'),dataDirectory=path.join(temporary,'private'),folder=path.join(temporary,'project');for(const directory of[root,dataDirectory,folder])await mkdir(directory,{recursive:true});const native=nativeFixture(folder,files),service=await createProjectFileService({root,dataDirectory,native,...options});
  const selected=(await service.choose()).project,binding={projectId:selected.projectId,grantEpoch:selected.grantEpoch};
  t.after(async()=>{await service.close();const target=path.resolve(temporary);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep+'companion-project-search-'));await rm(target,{recursive:true,force:true});});
  return{service,native,binding,start:(query,fields={},context={})=>service.execute({action:'search',...binding,query,...fields},{binding,operationId:randomUUID(),...context}),next:(page,context={})=>service.execute({action:'search',...binding,searchId:page.searchId,cursor:page.nextCursor},{binding,...context})};
}
const ioCalls=native=>native.calls.filter(call=>['read','scanDirectory'].includes(call.action)).length;

test('literal search preserves exact whitespace and reports actual hashes, UTF-16 locations and safe snippets',async t=>{
  const text='\ufeffIntro\r\n😀 NeedLe.*(X) \rnext line',f=await fixture(t,{'nested/alpha.txt':text,'nested/plain.txt':'Not the requested phrase.'}),page=await f.start(' needle.*(x) ',{path:'nested'});
  assert.equal(page.query,' needle.*(x) ');assert.equal(page.caseSensitive,false);assert.equal(page.complete,true);assert.equal(page.snapshot,false);assert.equal(page.sourceTrust,'untrusted_project_search');assert.equal(page.returned,1);assert.equal(page.nextCursor,null);assert.equal(page.matches[0].path,'nested/alpha.txt');assert.equal(page.matches[0].hash,hash(text));assert.equal(page.matches[0].line,2);assert.equal(page.matches[0].column,3);assert.equal(text.slice(page.matches[0].matchOffset,page.matches[0].matchOffset+page.matches[0].matchLength),' NeedLe.*(X) ');assert.equal(page.matches[0].snippet,text.slice(page.matches[0].snippetOffset,page.matches[0].snippetOffset+page.matches[0].snippet.length));
  assert.equal((await f.start(' needle.*(x) ',{path:'nested',caseSensitive:true})).matches.length,0);assert.equal((await f.start('.*',{path:'nested'})).matches.length,1,'Regex metacharacters remain literal.');
  const read=await f.service.execute({action:'read',...f.binding,path:page.matches[0].path,expectedHash:page.matches[0].hash},{binding:f.binding});assert.equal(read.content,text);f.native.files.set('nested/alpha.txt','Later edited content');await assert.rejects(f.service.execute({action:'read',...f.binding,path:page.matches[0].path,expectedHash:page.matches[0].hash},{binding:f.binding}),{code:'project_file_conflict'});
});

test('all matching pages are bounded, stable retries do not rescan, and invalid cursors cannot advance a search',async t=>{
  const f=await fixture(t,{'matches.txt':'needle\n'.repeat(85)}),id=randomUUID(),first=await f.start('needle',{}, {operationId:id});assert.equal(first.matches.length,20);assert.equal(first.scanHasMore,true);const before=ioCalls(f.native);assert.deepEqual(await f.start('needle',{}, {operationId:id}),first);assert.equal(ioCalls(f.native),before);
  await assert.rejects(f.service.execute({action:'search',...f.binding,searchId:first.searchId,cursor:randomUUID()},{binding:f.binding}),{code:'project_search_cursor_conflict'});assert.equal(ioCalls(f.native),before);
  const second=await f.next(first),afterSecond=ioCalls(f.native);assert.deepEqual(await f.next(first),second);assert.equal(ioCalls(f.native),afterSecond);const all=[...first.matches,...second.matches];let page=second;
  for(let count=0;page.scanHasMore;count++){assert.ok(count<10);page=await f.next(page);assert.ok(page.matches.length<=20);assert.ok(Buffer.byteLength(JSON.stringify(page))<=49152);all.push(...page.matches);}
  assert.equal(all.length,85);assert.equal(new Set(all.map(hit=>hit.path+':'+hit.matchOffset)).size,85);assert.equal(page.complete,true);assert.equal(page.scanned.files,1);assert.equal(page.scanned.bytes,Buffer.byteLength('needle\n'.repeat(85)));
  await assert.rejects(f.start('different',{}, {operationId:id}),{code:'project_search_conflict'});await assert.rejects(f.service.execute({action:'search',...f.binding,searchId:first.searchId,cursor:first.nextCursor,query:'changed'},{binding:f.binding}),{code:'invalid_project_arguments'});
});

test('recursive search reaches beyond the old1000-entry directory ceiling and empty pages retain continuation',async t=>{
  const files=Object.fromEntries(Array.from({length:1205},(_,index)=>['file-'+String(index).padStart(4,'0')+'.txt',index===1204?'the unique needle':'ordinary text']));files['child/nested.txt']='another needle';const f=await fixture(t,files);let page=await f.start('needle'),all=[...page.matches],pages=1;assert.equal(page.matches.length,0);assert.equal(page.scanHasMore,true);assert.ok(page.nextCursor);
  while(page.scanHasMore){assert.ok(pages++<20);const previous=page.scanned.files;page=await f.next(page);assert.ok(page.scanned.files>=previous);all.push(...page.matches);}
  assert.deepEqual(all.map(hit=>hit.path).sort(),['child/nested.txt','file-1204.txt']);assert.equal(page.complete,true);assert.equal(page.scanned.files,1206);assert.equal(page.scanned.directories,2);assert.equal(f.native.tokens.size,0);assert.ok(f.native.calls.filter(call=>call.action==='scanDirectory').length>=7);assert.equal(f.native.calls.some(call=>call.action==='list'),false);
});

test('skipped protected, binary, oversized and unavailable files are explicit and never support a false absence claim',async t=>{
  const f=await fixture(t,{'.private':'needle','binary.bin':{error:'project_text_required',bytes:200},'large.txt':{text:'',bytes:250001},'busy.txt':{error:'project_file_busy',statusCode:409,bytes:100},'ordinary.txt':'No matching phrase.'}),page=await f.start('needle');
  assert.deepEqual(page.skipped,{protected:1,unavailable:1,binary:1,oversized:1});assert.equal(page.matches.length,0);assert.equal(page.complete,false);assert.equal(page.stopReason,'unavailable_files');assert.equal(page.scanHasMore,false);assert.equal(f.native.calls.some(call=>call.action==='read'&&['.private','large.txt'].includes(call.fields.path)),false);
});

test('stricter service privacy exclusions skip adjacent native entries instead of blocking the permitted project',async t=>{
  const f=await fixture(t,{'sessions/private.txt':'needle','backups/private.txt':'needle','auth.json':'needle','ordinary.txt':'the permitted needle'}),page=await f.start('needle');assert.equal(page.skipped.protected,3);assert.deepEqual(page.matches.map(hit=>hit.path),['ordinary.txt']);assert.equal(page.complete,true);assert.equal(f.native.calls.some(call=>call.action==='read'&&call.fields.path!=='ordinary.txt'),false);assert.equal(f.native.calls.some(call=>call.action==='scanDirectory'&&call.fields.path!==''),false);
});

test('revoke while a native read is pending suppresses late source and disposes retained directory cursors',async t=>{
  const files=Object.fromEntries(Array.from({length:230},(_,index)=>['f'+String(index).padStart(3,'0')+'.txt','needle'])),f=await fixture(t,files),gate=deferred();let entered=false;f.native.readHook=async()=>{entered=true;await gate.promise;};const pending=f.start('needle');await until(()=>entered);const revoking=f.service.revoke(f.binding);gate.resolve();await assert.rejects(pending,error=>error.name==='AbortError'||error.code==='project_grant_changed');await revoking;assert.equal(f.native.tokens.size,0);const closes=f.native.calls.filter(call=>call.action==='closeScan');assert.ok(closes.length);assert.ok(closes.every(call=>call.signal===undefined));await assert.rejects(f.start('needle'),{code:'project_grant_changed'});
});

test('global Stop prevents late admission and waits for an uncooperative read without returning a late page',async t=>{
  const f=await fixture(t,{'a.txt':'needle'}),queued=f.start('needle'),earlyStop=f.service.stopSearches();await assert.rejects(queued,error=>error.name==='AbortError');await earlyStop;
  const gate=deferred();let entered=false;f.native.readHook=async()=>{entered=true;await gate.promise;};const pending=f.start('needle');await until(()=>entered);let finished=false;const stopping=f.service.stopSearches().then(value=>{finished=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);gate.resolve();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal((await stopping).stopped,1);assert.equal(f.native.tokens.size,0);f.native.readHook=null;assert.equal((await f.start('needle')).matches.length,1,'Only a new explicit request starts after Stop.');
});

test('close, expiry and wrong-binding cancellation release only the selected ephemeral search',async t=>{
  let clock=Date.parse('2026-10-25T12:00:00Z');const files=Object.fromEntries(Array.from({length:230},(_,index)=>['f'+String(index).padStart(3,'0')+'.txt','needle'])),f=await fixture(t,files,{now:()=>clock}),first=await f.start('needle');assert.ok(f.native.tokens.size);
  await assert.rejects(f.service.closeSearch(first.searchId,{binding:{...f.binding,grantEpoch:2}}),{code:'project_binding_mismatch'});assert.ok(f.native.tokens.size);assert.equal((await f.service.closeSearch(first.searchId,{binding:f.binding})).closed,true);assert.equal(f.native.tokens.size,0);assert.equal((await f.service.closeSearch(first.searchId,{binding:f.binding})).closed,true);await assert.rejects(f.next(first),{code:'project_search_expired'});
  const next=await f.start('needle');clock+=600001;await assert.rejects(f.next(next),{code:'project_search_expired'});assert.equal(f.native.tokens.size,0);const last=await f.start('needle');await f.service.close();assert.equal(f.native.closed,true);assert.equal(f.native.tokens.size,0);await assert.rejects(f.next(last),{code:'project_files_closed'});
});

test('changed native directory evidence fails closed rather than rescanning or substituting another folder',async t=>{
  const files=Object.fromEntries(Array.from({length:230},(_,index)=>['f'+String(index).padStart(3,'0')+'.txt','ordinary'])),f=await fixture(t,files);let count=0;f.native.scanHook=async()=>{if(++count===2)throw fault('project_directory_changed');};await assert.rejects(f.start('needle'),{code:'project_directory_changed'});assert.equal(f.native.tokens.size,0);assert.equal(f.native.calls.some(call=>['write','replace','undo'].includes(call.action)),false);
});

test('Unicode and escaped snippets honor the whole byte envelope without dropping or splitting matches',async t=>{
  const files=Object.fromEntries(Array.from({length:24},(_,index)=>['d'.repeat(120)+'/file-'+index+'.txt','😀'+'\u0001'.repeat(55)+'needle'+'\u0002'.repeat(100)+'😀'])),f=await fixture(t,files);let page=await f.start('needle'),all=[];
  for(let count=0;;count++){assert.ok(count<10);assert.ok(Buffer.byteLength(JSON.stringify(page))<=49152);for(const hit of page.matches){assert.equal(Buffer.from(hit.snippet).toString('utf8'),hit.snippet);assert.equal(files[hit.path].slice(hit.matchOffset,hit.matchOffset+hit.matchLength),'needle');}all.push(...page.matches);if(!page.scanHasMore)break;page=await f.next(page);}
  assert.equal(all.length,24);assert.equal(page.complete,true);
});

test('fixed page and byte budgets return explicit incomplete results and close their native cursors',async t=>{
  const f=await fixture(t,{'many.txt':'needle '.repeat(900)});let page=await f.start('needle'),pages=1,count=page.matches.length;while(page.scanHasMore){assert.ok(pages++<=32);page=await f.next(page);count+=page.matches.length;}assert.equal(page.complete,false);assert.equal(page.stopReason,'page_limit');assert.ok(count<=640);assert.equal(page.nextCursor,null);
  const binary=await fixture(t,Object.fromEntries(Array.from({length:100},(_,index)=>['b'+index+'.bin',{error:'project_text_required',bytes:1}]))),limited=await binary.start('needle');assert.equal(limited.stopReason,'byte_limit');assert.equal(limited.complete,false);assert.ok(limited.skipped.binary>0&&limited.skipped.binary<100);assert.equal(binary.native.tokens.size,0);
});

test('strict query validation does not grant roots, accept regex modes or read before rejecting invalid input',async t=>{
  const f=await fixture(t,{'a.txt':'needle'});for(const fields of[{query:'   '},{query:'a'.repeat(201)},{query:'\0'},{query:'needle',path:'../outside'},{query:'needle',regex:true},{query:'needle',caseSensitive:'false'},{searchId:randomUUID(),query:'needle'},{searchId:randomUUID(),cursor:randomUUID(),path:''}]){const before=ioCalls(f.native);await assert.rejects(f.service.execute({action:'search',...f.binding,...fields},{binding:f.binding}),error=>error.statusCode===400);assert.equal(ioCalls(f.native),before);}
});
