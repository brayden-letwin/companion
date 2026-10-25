import {createHash,randomUUID} from 'node:crypto';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_PAGE=49152,TTL=600000,MAX_SESSIONS=8,MAX_CACHE=1048576;
const LIMITS=Object.freeze({files:5000,directories:500,entries:20000,bytes:16777216,pages:32,depth:32});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const stopped=()=>Object.assign(fail('request_cancelled','Project search was stopped. Returned matches remain historical evidence.',499),{name:'AbortError'});
const copy=value=>structuredClone(value),size=value=>Buffer.byteLength(JSON.stringify(value));
const high=(text,index)=>text.charCodeAt(index)>=0xd800&&text.charCodeAt(index)<=0xdbff,low=(text,index)=>text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff;
const boundary=(text,index)=>index>0&&index<text.length&&high(text,index-1)&&low(text,index)?index-1:index;
const validId=value=>typeof value==='string'&&UUID.test(value);
const sameBinding=(left,right)=>left.projectId===right.projectId&&left.grantEpoch===right.grantEpoch;
const expired=()=>fail('project_search_expired','This search is closed or expired. Start an explicit new search; it was not resumed.',410);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateProjectSearch(args,relative){
  if(!object(args))throw fail('invalid_project_arguments','Use bounded literal project-search arguments.');
  const continuation=args.searchId!==undefined||args.cursor!==undefined,allowed=continuation?['action','projectId','grantEpoch','searchId','cursor']:['action','projectId','grantEpoch','path','query','caseSensitive'];
  if(Object.keys(args).some(key=>!allowed.includes(key))||args.action!=='search')throw fail('invalid_project_arguments','Keep search continuation separate from its frozen original query.');
  if(continuation){if(!validId(args.searchId)||!validId(args.cursor))throw fail('invalid_project_query','Use the returned search ID and cursor together.');return{searchId:args.searchId.toLowerCase(),cursor:args.cursor.toLowerCase()};}
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>200||args.query.includes('\0')||Buffer.from(args.query).toString('utf8')!==args.query||args.caseSensitive!==undefined&&typeof args.caseSensitive!=='boolean')throw fail('invalid_project_query','Use nonblank literal text of at most 200 characters and a boolean caseSensitive.');
  return{path:relative(args.path??'',true),query:args.query,caseSensitive:args.caseSensitive??false};
}

function lines(text){const starts=[0];for(let index=0;index<text.length;index++){if(text[index]==='\r'){if(text[index+1]==='\n')index++;starts.push(index+1);}else if(text[index]==='\n')starts.push(index+1);}return starts;}
function locate(starts,index){let lo=0,hi=starts.length;while(lo+1<hi){const mid=(lo+hi)>>1;if(starts[mid]<=index)lo=mid;else hi=mid;}return{line:lo+1,column:index-starts[lo]+1};}
function hit(file,match){
  const start=boundary(file.content,Math.max(0,match.index-60)),end=boundary(file.content,Math.min(file.content.length,match.index+match[0].length+100));
  return{path:file.path,hash:file.hash,readAt:file.readAt,...locate(file.lines,match.index),matchOffset:match.index,matchLength:match[0].length,snippet:file.content.slice(start,end),snippetOffset:start,snippetTruncated:start>0||end<file.content.length};
}

/** Ephemeral read-only traversal. All filesystem access stays in the fixed native broker. */
export function createProjectFilesSearch({native,validateGrant,assertGrant,common,captureFile,relative,now=Date.now}){
  const sessions=new Map(),tombstones=new Map();let closed=false,stopEpoch=0,closePromise;
  const authority=(binding,signal,epoch)=>{if(signal?.aborted||epoch!==undefined&&epoch!==stopEpoch)throw stopped();if(closed)throw fail('project_files_closed','Project search is shutting down.',503);return assertGrant(binding,signal);};
  function tombstone(session){tombstones.set(session.id,now()+TTL);while(tombstones.size>128)tombstones.delete(tombstones.keys().next().value);}
  async function releaseCursor(session){const cursor=session.nativeCursor;session.nativeCursor=null;if(!cursor)return true;try{const result=await native.run('closeScan',{cursor},{});return result?.closed===true;}catch{return false;}}
  async function dispose(session){if(session.disposal)return session.disposal;session.closed=true;session.controller.abort();sessions.delete(session.id);tombstone(session);session.disposal=(async()=>({searchId:session.id,closed:true,resourceReleased:await releaseCursor(session)}))();return session.disposal;}
  async function retire(){for(const[id,until]of tombstones)if(until<=now())tombstones.delete(id);for(const session of [...sessions.values()])if(session.expiresAt<=now())await dispose(session);}
  function packet(session,matches,pageId){
    const pending=Boolean(session.file||session.entries.length||session.currentDirectory||session.frontier.length),hasMore=pending&&!session.stopReason;
    return{searchId:session.id,...session.binding,path:session.path,query:session.query,caseSensitive:session.caseSensitive,startedAt:session.startedAt,observedAt:new Date(now()).toISOString(),expiresAt:new Date(session.expiresAt).toISOString(),pageId,matches,returned:matches.length,scanHasMore:hasMore,nextCursor:hasMore?randomUUID():null,complete:!pending&&!session.stopReason&&session.skipped.unavailable===0,stopReason:session.stopReason||(session.skipped.unavailable?'unavailable_files':null),scanned:copy(session.scanned),skipped:copy(session.skipped),scope:'Permitted UTF-8 files up to 250000 bytes in the chosen folder',snapshot:false,locationUnits:'UTF-16, one-based line/column and zero-based character offsets',sourceTrust:'untrusted_project_search',limits:LIMITS};
  }
  async function scan(session,grant,signal){
    if(!session.currentDirectory){const next=session.frontier.shift();if(!next)return;session.currentDirectory=next;session.scanned.directories++;}
    const dir=session.currentDirectory,reply=await native.run('scanDirectory',{...common(grant),path:dir.path,...(session.nativeCursor?{cursor:session.nativeCursor}:{})},{signal});
    // Capture a returned opaque resource before post-await authority checks so
    // cancellation/revocation cleanup can still dispose it.
    if(validId(reply?.nextCursor))session.nativeCursor=reply.nextCursor;else if(reply?.nextCursor===null)session.nativeCursor=null;
    authority(session.binding,signal);
    if(!object(reply)||!Array.isArray(reply.entries)||!Number.isSafeInteger(reply.scanned)||reply.scanned<0||reply.scanned>200||reply.scanLimit!==200||typeof reply.hasMore!=='boolean'||reply.hasMore&&(!validId(reply.nextCursor)||reply.scanned===0)||!reply.hasMore&&reply.nextCursor!==null||typeof reply.directoryIdentity!=='string'||!reply.directoryIdentity||reply.directoryIdentity.length>2000||!object(reply.skipped)||!['protected','unavailable'].every(key=>Number.isSafeInteger(reply.skipped[key])&&reply.skipped[key]>=0)||reply.entries.length+reply.skipped.protected+reply.skipped.unavailable!==reply.scanned||dir.identity&&dir.identity!==reply.directoryIdentity)throw fail('invalid_project_response','The directory scanner returned mismatched search metadata.',502);
    dir.identity=reply.directoryIdentity;dir.hasMore=reply.hasMore;session.scanned.entries+=reply.scanned;session.skipped.protected+=reply.skipped.protected;session.skipped.unavailable+=reply.skipped.unavailable;
    session.entries=reply.entries.flatMap(entry=>{if(!object(entry)||typeof entry.name!=='string'||entry.name.includes('/')||!['file','directory'].includes(entry.kind)||entry.path!==(dir.path?dir.path+'/':'')+entry.name||!Number.isSafeInteger(entry.byteLength)||entry.byteLength<0)throw fail('invalid_project_response','The directory scanner returned an invalid entry.',502);try{relative(entry.path);}catch(error){if(error?.code!=='invalid_project_path')throw error;session.skipped.protected++;return[];}return[{...entry,depth:dir.depth+1}];});
    if(session.scanned.entries>LIMITS.entries)session.stopReason='entry_limit';
  }
  async function advance(session,key,signal,epoch){
    authority(session.binding,signal,epoch);if(session.closed||session.expiresAt<=now())throw expired();
    const grant=await validateGrant(session.binding,signal);authority(session.binding,signal,epoch);if(session.closed)throw expired();
    if(session.cache.has(key))return copy(session.cache.get(key));
    if(key!==session.nextKey)throw fail('project_search_cursor_conflict','Use this search’s exact returned cursor. No page was advanced.',409);
    if(session.cache.size>=LIMITS.pages-1)session.stopReason='page_limit';if(session.cacheBytes+MAX_PAGE>MAX_CACHE)session.stopReason='cache_limit';
    const matches=[],pageId=randomUUID(),began=now(),baseFiles=session.scanned.files,baseBytes=session.scanned.bytes,baseEntries=session.scanned.entries;
    while(!session.stopReason){
      authority(session.binding,signal,epoch);if(session.closed)throw expired();if(session.expiresAt<=now())throw expired();
      if(session.file){const match=session.regex.exec(session.file.content);if(match){const value=hit(session.file,match),preview=packet(session,[...matches,value],pageId);if(size(preview)>MAX_PAGE){session.regex.lastIndex=match.index;break;}matches.push(value);if(matches.length>=20)break;continue;}session.file=null;}
      if(session.scanned.files-baseFiles>=256||session.scanned.bytes-baseBytes>=2097152||session.scanned.entries-baseEntries>=1000||now()-began>=2000)break;
      if(!session.entries.length){
        if(session.currentDirectory&&!session.currentDirectory.hasMore)session.currentDirectory=null;
        if(!session.currentDirectory&&!session.frontier.length)break;
        if(session.scanned.entries+200>LIMITS.entries){session.stopReason='entry_limit';break;}
        try{await scan(session,grant,signal);}catch(error){authority(session.binding,signal,epoch);if(error?.code==='project_scan_limit'){session.stopReason='directory_limit';break;}throw error;}
        authority(session.binding,signal,epoch);continue;
      }
      const entry=session.entries.shift();
      if(entry.kind==='directory'){
        if(entry.depth>LIMITS.depth){session.stopReason='depth_limit';break;}
        if(session.scanned.directories+session.frontier.length>=LIMITS.directories){session.stopReason='directory_limit';break;}
        const key=entry.path.toLowerCase();if(session.seenDirectories.has(key))throw fail('invalid_project_response','The directory scan repeated an already visited path.',502);session.seenDirectories.add(key);session.frontier.push({path:entry.path,depth:entry.depth});continue;
      }
      if(entry.byteLength>250000){session.skipped.oversized++;continue;}
      if(session.scanned.files>=LIMITS.files){session.stopReason='file_limit';break;}
      // Reserve a whole permitted file before reading; an external editor can
      // grow a listed file, but the native maximum cannot exceed this reserve.
      if(session.readBudgetCharged+250000>LIMITS.bytes){session.stopReason='byte_limit';break;}
      let observed;session.scanned.files++;
      try{observed=await native.run('read',{...common(grant),path:entry.path},{signal});authority(session.binding,signal,epoch);observed=captureFile(observed);}catch(error){authority(session.binding,signal,epoch);session.readBudgetCharged+=250000;if(error?.code==='project_text_required')session.skipped.binary++;else if(error?.code==='project_file_limit')session.skipped.oversized++;else if(['project_path_forbidden','project_path_unsafe'].includes(error?.code))session.skipped.protected++;else if(['project_file_not_found','project_file_busy','project_access_denied','project_io_failed'].includes(error?.code))session.skipped.unavailable++;else throw error;continue;}
      session.readBudgetCharged+=observed.byteLength;session.scanned.bytes+=observed.byteLength;session.file={...observed,path:entry.path,lines:lines(observed.content)};session.regex.lastIndex=0;
    }
    const result=packet(session,matches,pageId);if(!result.scanHasMore){await releaseCursor(session);authority(session.binding,signal,epoch);session.frontier=[];session.entries=[];session.currentDirectory=null;session.file=null;session.terminal=true;}
    if(size(result)>MAX_PAGE)throw fail('project_output_limit','One search page exceeds its bounded response size.',413);
    session.cache.set(key,copy(result));session.cacheBytes+=size(result);session.nextKey=result.nextCursor;return result;
  }
  async function execute(args,{binding,operationId,signal}={}){
    const query=validateProjectSearch(args,relative),epoch=stopEpoch;authority(binding,signal,epoch);await retire();authority(binding,signal,epoch);
    let session,key;
    if(query.searchId){session=sessions.get(query.searchId);if(!session)throw expired();if(!sameBinding(session.binding,binding))throw fail('project_binding_mismatch','This search belongs to a different selected project or access version.',409);key=query.cursor;}
    else{
      let id=operationId===undefined?randomUUID():operationId;if(!validId(id))throw fail('invalid_project_query','Use an actual search request identity.');id=id.toLowerCase();if(tombstones.has(id))throw expired();session=sessions.get(id);
      const requestHash=digest({binding,...query});if(session&&session.digest!==requestHash)throw fail('project_search_conflict','That search identity already belongs to different input.',409);
      if(!session){
        if(sessions.size>=MAX_SESSIONS){const previous=[...sessions.values()].find(value=>value.terminal&&!value.busy);if(previous){await dispose(previous);authority(binding,signal,epoch);}}
        if(sessions.size>=MAX_SESSIONS)throw fail('project_search_limit','Close a previous project search before starting another.',429);
        session={id,binding:copy(binding),...query,digest:requestHash,startedAt:new Date(now()).toISOString(),expiresAt:now()+TTL,controller:new AbortController(),closed:false,disposal:null,tail:Promise.resolve(),busy:0,frontier:[{path:query.path,depth:0}],seenDirectories:new Set([query.path.toLowerCase()]),currentDirectory:null,nativeCursor:null,entries:[],file:null,regex:new RegExp(query.query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),query.caseSensitive?'gu':'giu'),scanned:{directories:0,entries:0,files:0,bytes:0},skipped:{protected:0,unavailable:0,binary:0,oversized:0},readBudgetCharged:0,cache:new Map(),cacheBytes:0,nextKey:'start',stopReason:null,terminal:false};sessions.set(session.id,session);
      }key='start';
    }
    if(!session.cache.has(key)&&key!==session.nextKey)throw fail('project_search_cursor_conflict','Use this search’s exact returned cursor. No page was advanced.',409);
    const target=session,abort=()=>target.controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const combined=signal?AbortSignal.any([signal,target.controller.signal]):target.controller.signal;
    const operation=target.tail.then(()=>advance(target,key,combined,epoch));target.busy++;target.tail=operation.catch(()=>{});
    try{const result=await operation;authority(binding,combined,epoch);return result;}catch(error){await dispose(target);await releaseCursor(target);throw error;}finally{target.busy--;signal?.removeEventListener('abort',abort);}
  }
  async function closeSearch(searchId,{binding}={}){if(!validId(searchId))throw fail('invalid_project_query','Choose the actual search ID.');const session=sessions.get(searchId.toLowerCase());if(!session)return{searchId:searchId.toLowerCase(),closed:true,resourceReleased:true};if(!sameBinding(session.binding,binding))throw fail('project_binding_mismatch','That search belongs to a different selected project or access version.',409);const result=await dispose(session);await session.tail;return{...result,resourceReleased:await releaseCursor(session)&&result.resourceReleased};}
  async function stopSearches(){stopEpoch++;const all=[...sessions.values()],results=await Promise.all(all.map(dispose));await Promise.allSettled(all.map(value=>value.tail));const late=await Promise.all(all.map(releaseCursor));return{stopped:all.length,cleanupPending:results.filter((value,index)=>!value.resourceReleased||!late[index]).length};}
  async function revoke(binding){const all=[...sessions.values()].filter(session=>sameBinding(session.binding,binding));await Promise.all(all.map(dispose));await Promise.allSettled(all.map(value=>value.tail));await Promise.all(all.map(releaseCursor));}
  function close(){if(closePromise)return closePromise;closed=true;closePromise=stopSearches();return closePromise;}
  return{execute,closeSearch,stopSearches,revoke,close};
}
