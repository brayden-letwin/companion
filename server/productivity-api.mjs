import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModelRouter } from './model-router.mjs';
import { createFeatureBuilder } from './feature-builder.mjs';
import { createProductivityStore } from './productivity-store.mjs';
import { createProductivityTools } from './productivity-tools.mjs';
import { getRuntimeStatus, requestRuntimeRestart } from './runtime-control.mjs';
import { createDesktopService } from './desktop-service.mjs';
import { loadCapabilities } from './capability-registry.mjs';
import { windowContextReference } from './window-context.mjs';
import { normalizeAssistantBody, runAssistantTurn } from './assistant-turn.mjs';
import { createWorkService } from './work-service.mjs';
import { validateSourceReadOptions } from './source-read.mjs';

const OWNER = 'local-workspace';
const BASE = '/api/assistant';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
function fields(body, allowed) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw fail(400, 'invalid_input', 'The request contains unsupported fields.'); }
function text(value, limit, label, empty = false) { if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw fail(400, 'invalid_input', `${label} must contain ${empty ? '0' : '1'}–${limit} characters.`); return value.trim(); }
function workQuery(req,detail=false){const query=new URL(req.url,'http://localhost').searchParams,allowed=detail?['textOffset','textLimit','actionOffset','actionLimit']:['offset','limit'],result={};for(const key of query.keys()){const value=query.get(key);if(!allowed.includes(key)||query.getAll(key).length!==1||!/^\d{1,7}$/.test(value))throw fail(400,'invalid_work_query','Use the returned work paging offsets and bounded limits.');result[key]=Number(value);}return result;}
function sourceFileQuery(req){const query=new URL(req.url,'http://localhost').searchParams,result={};for(const key of query.keys()){const value=query.get(key);if(!['path','expectedHash','offset','limit'].includes(key)||query.getAll(key).length!==1)throw fail(400,'invalid_source_query','Use one source path and its returned paging fields.');if(['offset','limit'].includes(key)){if(!/^\d{1,6}$/.test(value))throw fail(400,'invalid_source_query','Use bounded source paging integers.');result[key]=Number(value);}else result[key]=value;}return validateSourceReadOptions(result);}
function conversationPage(conversation, before) {
  let end = conversation.turns.length;
  if (before !== undefined) {
    if (typeof before !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(before)) throw fail(400, 'invalid_cursor', 'Use an earlier-message cursor from this conversation.');
    end = conversation.turns.findIndex(turn => turn.id === before);
    if (end < 0) throw fail(400, 'invalid_cursor', 'That earlier-message cursor is not in this conversation.');
  }
  const turns = []; let bytes = 0, start = end;
  while (start > 0 && turns.length < 20) {
    const next = conversation.turns[start - 1], size = Buffer.byteLength(JSON.stringify(next));
    if (turns.length && bytes + size > 1024 * 1024) break;
    turns.unshift(next); bytes += size; start -= 1;
  }
  return { ...conversation, turns, totalTurns: conversation.turns.length, hasMore: start > 0, olderThan: turns[0]?.id || null };
}
function json(res, status, data) { if (res.destroyed || res.writableEnded) return; const body = JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(body); }
async function readJson(req, limit = 2 * 1024 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'json_required', 'Send JSON data.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw fail(415, 'unsupported_encoding', 'Send uncompressed data.');
  if (Number(req.headers['content-length'] || 0) > limit) throw fail(413, 'body_too_large', 'The request is too large.');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw fail(413, 'body_too_large', 'The request is too large.'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'invalid_json', 'Provide a JSON object.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_json', 'Provide a JSON object.'); return body;
}
const routeMatches = route => ['/chat','/work','/context','/conversations','/providers','/providers/configure','/providers/select','/providers/remove','/workspace','/workspace/operations','/tools/run','/features','/features/source','/features/source/file','/features/patch','/integrations','/runtime','/runtime/restart','/desktop','/desktop/actions','/desktop/stop','/stop'].some(suffix => route === BASE + suffix)
  || /^\/api\/assistant\/(?:work\/[a-f\d-]+(?:\/cancel)?|context\/[a-f\d-]+\/clear|conversations\/[a-f\d-]+|features\/[a-f\d-]+(?:\/(?:apply|rollback|cancel))?|workspace\/workflows\/[a-f\d-]+\/run|desktop\/actions\/[a-f\d-]+\/(?:approve|cancel))$/i.test(route);

/** Lazy initialization keeps the legacy reader and protocol tests independent. */
export function createProductivityApi({ root, dataDirectory, createRuntime } = {}) {
  let runtimePromise = null, closed = false;
  const active = new Map(), contextPins = new Map(), contextRequests = new Map();
  function ownedContext(contextId,scope){
    const pin=contextPins.get(contextId);
    if(!pin||pin.scope!==scope||Date.parse(pin.context.expiresAt)<=Date.now())throw fail(409,'window_context_unavailable','The selected window context is unavailable. Clear it or choose the window again.');
    return pin;
  }
  async function releaseContext(contextId,scope,services){
    const pin=contextPins.get(contextId);if(!pin||pin.scope!==scope)return{released:true};
    contextPins.delete(contextId);for(const controller of contextRequests.get(contextId)||[])controller.abort();contextRequests.delete(contextId);
    await services.desktop?.releaseContext?.(contextId);return{released:true};
  }
  function removeContextReader(id,controller){const readers=contextRequests.get(id);readers?.delete(controller);if(readers&&!readers.size)contextRequests.delete(id);}
  async function readSelectedContext(services,id,scope,controller,{onSelected}={}){
    const selected=contextPins.get(id);if(selected?.scope===scope)onSelected?.(windowContextReference({contextId:selected.context.id,windowId:selected.context.window.id,title:selected.context.window.title,appName:selected.context.window.appName}));
    const pin=ownedContext(id,scope);const readers=contextRequests.get(id)||new Set();readers.add(controller);contextRequests.set(id,readers);
    if(controller.signal.aborted)throw Object.assign(fail(499,'request_cancelled','Request stopped.'),{name:'AbortError'});
    if(typeof services.desktop?.readContext!=='function')throw fail(503,'window_context_unavailable','Window context is unavailable in this runtime.');
    const result=await services.desktop.readContext(id,{signal:controller.signal});
    if(result?.contextId!==id||result?.window?.id!==pin.context.window.id)throw fail(409,'window_context_unavailable','The selected source could not be matched.');
    return result;
  }
  async function acceptWork(input,services,{signal}={}){
    const check=()=>{if(signal?.aborted)throw Object.assign(fail(499,'request_cancelled','Stopped before this work was handed off.'),{name:'AbortError'});};check();
    if(typeof input.id!=='string'||!UUID.test(input.id))throw fail(400,'invalid_work','Use a stable work job UUID.');
    const prompt=text(input.prompt,12000,'Work request');if(input.title!==undefined)text(input.title,80,'Work title');
    if(input.providerId!==undefined)text(input.providerId,100,'Provider ID');
    if(input.contextId!==undefined&&(typeof input.contextId!=='string'||!UUID.test(input.contextId)))throw fail(400,'invalid_context','Choose a valid window context.');
    let existing;try{existing=await services.work.get(input.id);}catch(error){if((error.statusCode||error.status)!==404)throw error;}
    check();
    const status=existing?null:await services.router.getStatus(),providerId=input.providerId||existing?.providerId||status?.defaultProviderId;
    const provider=existing?.provider||status?.providers?.find(entry=>entry.id===providerId);
    if(!existing&&(!provider||provider.ready!==true))throw fail(409,'provider_unavailable','Choose a ready AI connection before handing off work.');
    let windowContext=existing?.windowContext;
    if(!existing&&input.contextId){const pin=ownedContext(input.contextId,input.scope);windowContext=windowContextReference({contextId:pin.context.id,windowId:pin.context.window.id,title:pin.context.window.title,appName:pin.context.window.appName});}
    check();
    return services.work.create({...input,prompt,providerId,provider:provider&&{id:provider.id,label:provider.label||provider.id,type:provider.type,model:provider.model??'',...(provider.baseUrl?{baseUrl:provider.baseUrl}:{})},...(windowContext?{windowContext}:{})});
  }
  async function attachWorkRuntime(services){
    services.work=await createWorkService({store:services.store,runTurn:async input=>{
      const controller=new AbortController(),abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)controller.abort();
      const timer=setTimeout(()=>controller.abort(),240000);timer.unref?.();
      try{return await runAssistantTurn({body:{id:input.requestId,message:input.message??input.prompt,providerId:input.providerId,conversationId:input.conversationId,expectedRevision:0,...(input.contextId?{contextId:input.contextId}:{})},services,signal:controller.signal,scope:input.scope,allowDelegation:false,expectedProvider:input.expectedProvider||input.provider,onProgress:input.onProgress,readContext:(id,options)=>{if(input.windowContext)options.onSelected?.(input.windowContext);return readSelectedContext(services,id,input.scope,controller,options);}});}
      finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);removeContextReader(input.contextId,controller);}
    }});
    services.tools.setWorkService?.({create:(input,options)=>acceptWork(input,services,options),list:options=>services.work.list(options),get:(id,options)=>services.work.get(id,options),cancel:id=>services.work.cancel(id)});
    return services;
  }
  async function selectContext(req,res,body,session,services){
    fields(body,['windowId']);
    const windowId=text(body.windowId,100,'Window ID');
    if(!/^[A-Za-z0-9_-]+$/.test(windowId))throw fail(400,'invalid_context','Choose an actual window.');
    if(typeof services.desktop?.createContext!=='function')throw fail(503,'window_context_unavailable','Window context is unavailable in this runtime.');
    for(const [id,pin]of contextPins)if(Date.parse(pin.context.expiresAt)<=Date.now())await releaseContext(id,pin.scope,services);
    const context=await guardedRequest(req,res,session,randomUUID(),async signal=>{
      let selected;
      try{
        selected=await services.desktop.createContext(windowId,{signal});
        const created=Date.parse(selected?.createdAt),expires=Date.parse(selected?.expiresAt);
        if(!selected||!UUID.test(selected.id)||selected.window?.id!==windowId||typeof selected.window.title!=='string'||selected.window.title.length>600||typeof selected.window.appName!=='string'||!selected.window.appName.trim()||selected.window.appName.length>200||/[\\/:]/.test(selected.window.appName)||!Number.isFinite(created)||!Number.isFinite(expires)||expires<=Date.now()||expires<=created||expires-created>8*60*60*1000||contextPins.has(selected.id))throw fail(502,'invalid_context_source','The selected window returned invalid context metadata.');
        if(signal.aborted||closed)throw Object.assign(fail(499,'request_cancelled','Stopped before selecting this window.'),{name:'AbortError'});
        if(contextPins.size>=20)throw fail(429,'window_context_limit','Clear an existing selected window context before adding another.');
        // Copy only public metadata; never return bridge identity or source text here.
        const value={id:selected.id,window:{id:windowId,title:selected.window.title,appName:selected.window.appName,...(Number.isSafeInteger(selected.window.pid)?{pid:selected.window.pid}:{})},createdAt:new Date(created).toISOString(),expiresAt:new Date(expires).toISOString()};
        contextPins.set(value.id,{scope:session.scope,context:value});return value;
      }catch(error){if(selected?.id&&UUID.test(selected.id)&&!contextPins.has(selected.id))await Promise.resolve().then(()=>services.desktop.releaseContext?.(selected.id)).catch(()=>{});throw error;}
    });
    if(req.aborted||res.destroyed){await releaseContext(context.id,session.scope,services);throw fail(499,'request_cancelled','Stopped before selecting this window.');}
    json(res,200,{context});
  }
  async function runtime() {
    if (closed) throw fail(503, 'shutting_down', 'Companion is shutting down.');
    if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw fail(503, 'workspace_unavailable', 'Start Companion with its private data directory.');
    if (!runtimePromise) runtimePromise = (async () => {
      if (createRuntime) return createRuntime();
      const router = await createModelRouter({ dataDirectory });
      const store = await createProductivityStore({ dataDirectory });
      const builder = await createFeatureBuilder({ root, dataDirectory: path.join(dataDirectory, 'feature-builds'), complete: options => router.complete(options) });
      const desktop = await createDesktopService({ root, dataDirectory: path.join(dataDirectory, 'desktop') });
      let capabilities = [], capabilityStatus = { ready: true };
      try { capabilities = await loadCapabilities({ root }); }
      catch { capabilityStatus = { ready: false, code: 'capability_registry_unavailable', message: 'Installed capabilities could not load. Their workflows are unavailable; use build history to inspect or roll back the source change.' }; }
      const tools = createProductivityTools({ store, builder, desktop, root, capabilities, capabilityStatus, owner: OWNER });
      return { router, store, builder, tools, desktop, capabilityStatus };
    })().then(attachWorkRuntime).catch(error => { runtimePromise = null; throw error; });
    return runtimePromise;
  }
  const providerStatus = async router => { const status = await router.getStatus(); return { ...status, activeProviderId: status.defaultProviderId }; };
  function scheduleRestart(res, jobId) {
    const status = getRuntimeStatus();
    if (status.managed) res.once('finish', () => requestRuntimeRestart(jobId ? { jobId } : {}));
    return { ...status, restartRequested: status.managed, requiresManualRestart: !status.managed };
  }
  async function guardedRequest(req, res, session, id, run) {
    const key = `${session.scope}:direct:${id}`;
    if (active.has(key)) throw fail(409, 'request_active', 'This direct action is already running. Inspect its result before retrying.');
    if (active.size >= 3) throw fail(429, 'assistant_busy', 'Companion is working on three requests. Stop one or try again shortly.');
    const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
    active.set(key,controller);res.once('close',disconnected);req.once('aborted',disconnected);
    if (req.aborted || res.destroyed) controller.abort();
    const timeout = setTimeout(()=>controller.abort(),240000);timeout.unref?.();
    try {
      if (controller.signal.aborted) throw Object.assign(fail(499,'request_cancelled','Stopped before this action could begin.'),{name:'AbortError'});
      return await run(controller.signal);
    } finally { clearTimeout(timeout);res.off('close',disconnected);req.off('aborted',disconnected);if(active.get(key)===controller)active.delete(key); }
  }
  function directOperationId(body) {
    if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !UUID.test(body.operationId))) throw fail(400,'invalid_id','Use a stable UUID for an explicit action retry.');
    return body.operationId || randomUUID();
  }
  async function chat(req,res,body,session,services){
    const normalized=normalizeAssistantBody(body),key=session.scope+':'+normalized.id;
    if(active.has(key))throw fail(409,'request_active','That request is already running.');
    if(active.size>=3)throw fail(429,'assistant_busy','Companion is working on three foreground requests. Stop one or try again shortly.');
    const controller=new AbortController(),disconnected=()=>{if(!res.writableEnded)controller.abort();};
    active.set(key,controller);res.once('close',disconnected);req.once('aborted',disconnected);if(req.aborted||res.destroyed)controller.abort();
    const timer=setTimeout(()=>controller.abort(),240000);timer.unref?.();
    try{json(res,200,await runAssistantTurn({body,services,scope:session.scope,signal:controller.signal,readContext:(id,options)=>readSelectedContext(services,id,session.scope,controller,options)}));}
    finally{clearTimeout(timer);res.off('close',disconnected);req.off('aborted',disconnected);if(active.get(key)===controller)active.delete(key);removeContextReader(body.contextId,controller);}
  }
  return {
    async handle(req, res, route, session) {
      if (!routeMatches(route)) return false;
      try {
        const now = Date.now(), window = session.windows?.get('productivity') || { count: 0, until: now + 60000 };
        if (window.until <= now) { window.count = 0; window.until = now + 60000; }
        if (++window.count > 240) throw fail(429, 'rate_limited', 'Too many workspace requests. Try again in a minute.');
        session.windows?.set('productivity', window);
        const services = await runtime();
        if (req.method === 'GET') {
          if(route===BASE+'/work'){json(res,200,await services.work.list(workQuery(req)));return true;}
          const work=/^\/api\/assistant\/work\/([a-f\d-]+)$/i.exec(route);
          if(work){json(res,200,{job:await services.work.get(work[1],workQuery(req,true))});return true;}
          if (route === BASE + '/runtime') { json(res, 200, getRuntimeStatus()); return true; }
          if (route === BASE + '/desktop') { json(res, 200, services.desktop ? await services.desktop.status() : { available: false, reason: 'Desktop actions are unavailable in this runtime.' }); return true; }
          if (route === BASE + '/desktop/actions') { json(res, 200, { actions: services.desktop ? await services.desktop.listActions() : [] }); return true; }
          if (route === BASE + '/workspace') { json(res, 200, services.store.snapshot()); return true; }
          if (route === BASE + '/conversations') { json(res, 200, services.store.listConversations()); return true; }
          const conversation = /^\/api\/assistant\/conversations\/([a-f\d-]+)$/i.exec(route);
          if (conversation) { const query = new URL(req.url, 'http://localhost').searchParams; json(res, 200, conversationPage(services.store.getConversation(conversation[1]), query.has('before') ? query.get('before') : undefined)); return true; }
          if (route === BASE + '/providers') { json(res, 200, await providerStatus(services.router)); return true; }
          if (route === BASE + '/features') { json(res, 200, { jobs: await services.builder.list(OWNER) }); return true; }
          if (route === BASE + '/features/source') { json(res, 200, await services.builder.source(OWNER, { includeContent: new URL(req.url, 'http://localhost').searchParams.get('content') === '1' })); return true; }
          if(route===BASE+'/features/source/file'){const options=sourceFileQuery(req);if(typeof services.builder.sourceFile!=='function')throw fail(503,'source_read_unavailable','Targeted source reads are unavailable in this runtime.');json(res,200,await services.builder.sourceFile(OWNER,options));return true;}
          if (route === BASE + '/integrations') { json(res, 200, { mcp: { command: process.execPath, args: [path.join(root, 'server', 'mcp-server.mjs')], env: { COMPANION_URL: `http://127.0.0.1:${req.socket.localPort}` } }, tools: services.tools.catalog?.() || services.tools.definitions.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), capabilityStatus: services.capabilityStatus || { ready: true } }); return true; }
          const match = /^\/api\/assistant\/features\/([a-f\d-]+)$/i.exec(route);
          if (match) { json(res, 200, await services.builder.get(match[1], OWNER)); return true; }
          throw fail(405, 'method_not_allowed', 'Use POST for this action.');
        }
        if (req.method !== 'POST') throw fail(405, 'method_not_allowed', 'Use GET or POST.');
        const body = await readJson(req);
        if(route===BASE+'/work'){fields(body,['id','prompt','title','providerId','contextId']);text(body.providerId,100,'Provider ID');if(typeof body.id!=='string'||!UUID.test(body.id))throw fail(400,'invalid_work','Use a stable work job UUID.');json(res,202,await guardedRequest(req,res,session,body.id,signal=>acceptWork({...body,scope:session.scope},services,{signal})));return true;}
        const workCancel=/^\/api\/assistant\/work\/([a-f\d-]+)\/cancel$/i.exec(route);
        if(workCancel){fields(body,[]);json(res,200,{job:await services.work.cancel(workCancel[1])});return true;}
        if(route===BASE+'/context'){await selectContext(req,res,body,session,services);return true;}
        const contextClear=/^\/api\/assistant\/context\/([a-f\d-]+)\/clear$/i.exec(route);
        if(contextClear){fields(body,[]);if(!UUID.test(contextClear[1]))throw fail(400,'invalid_context','Choose a valid window context.');json(res,200,await releaseContext(contextClear[1],session.scope,services));return true;}
        if (route === BASE + '/conversations') { fields(body, ['id','title']); json(res, 200, services.store.createConversation(body)); return true; }
        if (route === BASE + '/stop') {
          fields(body, []);
          for (const controller of active.values()) controller.abort();
          const work=await services.work.stopAll();
          const desktop = await services.desktop?.cancelAll();
          const builds = services.builder.stopPending ? (await services.builder.stopPending(OWNER)).builds : [];
          if (!services.builder.stopPending) for (const job of await services.builder.list(OWNER)) {
            if (!['queued','generating','validating'].includes(job.status)) continue;
            try { const result = await services.builder.cancel(job.id, OWNER); builds.push({ id: job.id, status: result.status }); }
            catch { builds.push({ id: job.id, status: 'check_required' }); }
          }
          json(res, 200, { stopped: true, desktop: desktop || null, builds,work }); return true;
        }
        if (route === BASE + '/desktop/stop') {
          fields(body, []);
          const result = await services.desktop?.cancelAll();
          json(res, 200, { stopped: true, ...result }); return true;
        }
        const desktopAction = /^\/api\/assistant\/desktop\/actions\/([a-f\d-]+)\/(approve|cancel)$/i.exec(route);
        if (desktopAction) {
          fields(body, []);
          if (!services.desktop) throw fail(503, 'desktop_unavailable', 'Desktop actions are unavailable in this runtime.');
          const id = desktopAction[1], method = desktopAction[2];
          const key = `${session.scope}:desktop:${id}`, controller = new AbortController();
          if (active.has(key)) throw fail(409, 'desktop_action_running', 'This desktop action is already running.');
          const disconnected = () => { if (!res.writableEnded) controller.abort(); };
          active.set(key, controller); res.once('close', disconnected); req.once('aborted', disconnected);
          try { json(res, 200, { desktopAction: await services.desktop[method](id, { signal: controller.signal }), workspace: services.store.snapshot() }); }
          finally { res.off('close', disconnected); req.off('aborted', disconnected); if (active.get(key) === controller) active.delete(key); }
          return true;
        }
        if (route === BASE + '/runtime/restart') {
          fields(body, ['jobId']);
          if (body.jobId) { const job = await services.builder.get(body.jobId, OWNER); if (job.status !== 'applied') throw fail(409, 'feature_not_applied', 'Only an activated feature can be used for a managed update restart.'); }
          if (!getRuntimeStatus().managed) throw fail(409, 'manual_restart_required', 'This development server is not managed. Restart it through Start Companion.cmd.');
          json(res, 202, scheduleRestart(res, body.jobId)); return true;
        }
        if (route === BASE + '/chat') { await chat(req, res, body, session, services); return true; }
        if (route === BASE + '/workspace/operations') { json(res, 200, services.store.apply(body)); return true; }
        if (route === BASE + '/providers/configure') { fields(body, ['id','type','label','model','baseUrl','apiKey']); await services.router.configure(body); json(res, 200, await providerStatus(services.router)); return true; }
        if (route === BASE + '/providers/select') { fields(body, ['id']); await services.router.select(body.id); json(res, 200, await providerStatus(services.router)); return true; }
        if (route === BASE + '/providers/remove') { fields(body, ['id']); await services.router.remove(body.id); json(res, 200, await providerStatus(services.router)); return true; }
        if (route === BASE + '/tools/run') {
          fields(body, ['tool','arguments','operationId']); const requestId = directOperationId(body);
          const result = await guardedRequest(req,res,session,requestId,signal=>services.tools.execute(body.tool, body.arguments || {}, { requestId: `${OWNER}:${requestId}`, callId: 'direct', signal,scope:session.scope }));
          json(res, 200, { tool: body.tool, result, requestId, workspace: services.store.snapshot() }); return true;
        }
        const workflow = /^\/api\/assistant\/workspace\/workflows\/([a-f\d-]+)\/run$/i.exec(route);
        if (workflow) { fields(body, ['operationId']); const requestId=directOperationId(body); json(res, 200, await guardedRequest(req,res,session,requestId,signal=>services.tools.runWorkflow(workflow[1], { requestId: `${OWNER}:${requestId}`, signal }))); return true; }
        if (route === BASE + '/features') {
          fields(body, ['prompt','providerId','autoApply']); const status = await services.router.getStatus();
          json(res, 202, await services.builder.request({ ...body, providerId: body.providerId || status.defaultProviderId }, OWNER)); return true;
        }
        if (route === BASE + '/features/patch') { json(res, 202, await services.builder.submitPatch(body, OWNER)); return true; }
        const action = /^\/api\/assistant\/features\/([a-f\d-]+)\/(apply|rollback|cancel)$/i.exec(route);
        if (action) {
          fields(body, []); const job = await services.builder[action[2]](action[1], OWNER);
          const needsRestart = ['apply','rollback'].includes(action[2]) && job.files?.some(file => file.path.startsWith('server/'));
          json(res, 200, { ...job, ...(needsRestart ? { runtime: scheduleRestart(res, action[2] === 'apply' ? job.id : undefined) } : {}) }); return true;
        }
        throw fail(404, 'not_found', 'That action was not found.');
      } catch (error) {
        const status = error.statusCode || error.status || 500;
        json(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: { code: error.code || 'productivity_error', message: error.statusCode || error.status ? error.message : 'Companion could not complete this action. Check its connection and try again.' }, ...(error.workspace ? { workspace: error.workspace } : {}), ...(error.actions ? { actions: error.actions } : {}), ...(error.windowContext ? {windowContext:windowContextReference(error.windowContext)} : {}), ...(Array.isArray(error.hostActions) ? { hostActions: error.hostActions } : {}), ...(error.capability ? { capability: error.capability } : {}), ...(error.conversation ? { conversation: conversationPage(error.conversation) } : {}), ...(error.conversationId ? { conversationId: error.conversationId } : {}) });
      }
      return true;
    },
    cancel(scope, id) { active.get(`${scope}:${id}`)?.abort(); },
    async close() {
      closed = true; for (const controller of active.values()) controller.abort(); active.clear();contextPins.clear();contextRequests.clear();
      if (runtimePromise) { const services = await runtimePromise.catch(() => null);await services?.work?.close?.(); await services?.desktop?.close?.(); await services?.builder.close?.(); services?.store.close(); }
    },
  };
}
