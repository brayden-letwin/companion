import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../server/mcp-server.mjs';

const TOKEN = 'S'.repeat(43), CSRF = 'C'.repeat(43), ORIGIN = 'http://127.0.0.1:4174';
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-test-client', version: '1.0' } };
const tool = (name, args = {}) => ({ name, arguments: args });

test('an external MCP client discovers exact routine schemas and edits one existing paused workflow without running it',async t=>{
 const [{mkdtemp,rm},{tmpdir},path,{createProductivityStore},{createProductivityTools}]=await Promise.all([import('node:fs/promises'),import('node:os'),import('node:path'),import('../server/productivity-store.mjs'),import('../server/productivity-tools.mjs')]);
 const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-mcp-routine-')),store=await createProductivityStore({dataDirectory});
 t.after(async()=>{store.close();assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir())+path.sep));await rm(dataDirectory,{recursive:true,force:true});});
 const tools=createProductivityTools({store}),workflowId=randomUUID();store.apply({operationId:workflowId,expectedRevision:0,type:'saveWorkflow',name:'MCP morning routine',enabled:false,steps:[{tool:'start_focus',arguments:{minutes:25}}]});
 const sent=[],f=await fixture(t,async(url,request)=>{
  sent.push({url,method:request.method,body:request.body?JSON.parse(request.body):undefined});
  if(url.endsWith('/integrations'))return response({tools:tools.catalog()});
  assert.ok(url.endsWith('/tools/run'));const body=JSON.parse(request.body);
  try{return response({tool:body.tool,result:await tools.execute(body.tool,body.arguments,{requestId:'mcp:'+body.operationId,callId:'direct'})});}
  catch(error){return response({error:{code:error.code,message:error.message}},error.statusCode||400);}
 });await f.initialize();
 const catalog=(await f.request('tools/call',tool('companion_list_tools'))).result.structuredContent.tools;
 assert.ok(catalog.find(item=>item.name==='save_workflow').parameters.properties.workflowId);assert.ok(catalog.find(item=>item.name==='save_workflow').parameters.properties.expectedRevision);
 async function run(name,args,operationId=randomUUID()){const value=await f.request('tools/call',tool('companion_run_tool',{tool:name,arguments:args,operationId}));assert.equal(value.result.isError,false);return value.result.structuredContent.result;}
 const listed=await run('list_workflows',{query:'MCP morning'});assert.equal(listed.total,1);assert.equal(listed.workflows[0].metadataOnly,true);assert.equal(listed.workflows[0].steps,undefined);
 const read=await run('list_workflows',{action:'read',workflowId,expectedRevision:listed.revision,expectedDefinitionHash:listed.workflows[0].definitionHash});assert.equal(read.definitionHasMore,false);const definition=JSON.parse(read.definitionText);definition.steps[0].arguments.minutes=40;
 const editId=randomUUID(),edit={workflowId,expectedRevision:read.revision,expectedDefinitionHash:read.definitionHash,steps:definition.steps};
 const changed=await run('save_workflow',edit,editId);assert.equal(changed.workflow.id,workflowId);assert.equal(changed.workflow.enabled,false);assert.equal(changed.workflow.steps[0].arguments.minutes,40);
 const retried=await run('save_workflow',edit,editId);assert.equal(retried.replayed,true);assert.deepEqual(retried.workflow,changed.workflow);assert.equal(retried.appliedRevision,changed.appliedRevision);
 assert.equal(store.snapshot().workflows.length,1);assert.equal(store.snapshot().focus,null);assert.equal(store.snapshot().notes.length,0);assert.equal(store.snapshot().tasks.length,0);
 assert.equal(sent.filter(item=>item.body?.tool==='run_workflow').length,0);assert.deepEqual(sent.filter(item=>item.body?.tool==='save_workflow').map(item=>item.body.operationId),[editId,editId]);
});
test('external MCP task scheduling preserves calendar days, explicit repeated-hour choices and original save receipts',async t=>{
 const [{mkdtemp,rm},{tmpdir},path,{createProductivityStore},{createProductivityTools}]=await Promise.all([import('node:fs/promises'),import('node:os'),import('node:path'),import('../server/productivity-store.mjs'),import('../server/productivity-tools.mjs')]);
 const dataDirectory=await mkdtemp(path.join(tmpdir(),'companion-mcp-deadline-')),store=await createProductivityStore({dataDirectory}),tools=createProductivityTools({store});t.after(async()=>{store.close();assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir())+path.sep));await rm(dataDirectory,{recursive:true,force:true});});
 const f=await fixture(t,async(url,request)=>{if(url.endsWith('/integrations'))return response({tools:tools.catalog()});const body=JSON.parse(request.body);try{return response({tool:body.tool,result:await tools.execute(body.tool,body.arguments,{requestId:'mcp:'+body.operationId,callId:'direct'})});}catch(error){return response({error:{code:error.code,message:error.message}},error.statusCode||400);}});await f.initialize();
 const catalog=(await f.request('tools/call',tool('companion_list_tools'))).result.structuredContent.tools;assert.ok(catalog.find(t=>t.name==='create_task').parameters.properties.dueDate);assert.ok(catalog.find(t=>t.name==='get_time').parameters.properties.localDateTime);
 async function run(name,args,operationId=randomUUID()){const value=await f.request('tools/call',tool('companion_run_tool',{tool:name,arguments:args,operationId}));assert.equal(value.result.isError,false,JSON.stringify(value));return value.result.structuredContent.result;}
 const createId=randomUUID(),args={title:'MCP calendar task',dueDate:'2026-10-25',dueAt:null},created=await run('create_task',args,createId);assert.equal(created.task.dueDate,'2026-10-25');assert.equal(created.task.dueAt,null);
 const today=await run('list_tasks',{status:'todo',deadline:'today',timezone:'America/Vancouver',asOf:'2026-10-25T16:00:00.000Z'});assert.equal(today.total,1);assert.equal(today.tasks[0].id,created.task.id);assert.equal(today.timezone,'America/Vancouver');
 const resolution=await run('get_time',{action:'resolve',timezone:'America/Vancouver',localDateTime:'2025-11-02T01:30:00.123'});assert.equal(resolution.status,'ambiguous');assert.equal(resolution.candidates.length,2);const later=resolution.candidates.find(c=>c.offsetMinutes===-480);assert.equal(later.dueAt,'2025-11-02T09:30:00.123Z');
 const edited=await run('update_task',{taskId:created.task.id,dueAt:later.dueAt});assert.equal(edited.task.dueAt,later.dueAt);assert.equal(edited.task.dueDate,null);const before=store.snapshot(),replay=await run('create_task',args,createId);assert.equal(replay.replayed,true);assert.deepEqual(replay.task,created.task);assert.equal(replay.appliedRevision,created.appliedRevision);assert.deepEqual(store.snapshot(),before);assert.equal(before.tasks.length,1);assert.equal(before.notes.length,0);
});

async function fixture(t, handler = async () => response({ revision: 0, tasks: [] }), options = {}) {
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough(), messages = [], calls = [], waiters = [];
  let outputText = '', errorText = '', buffer = '', nextId = 1;
  output.on('data', chunk => { const value = chunk.toString('utf8'); outputText += value; buffer += value; let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); const message = JSON.parse(line); messages.push(message); for (const waiter of [...waiters]) if (waiter.check(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); } } });
  errorOutput.on('data', chunk => { errorText += chunk.toString(); });
  const fetchImpl = async (url, request) => {
    calls.push({ url, ...request });
    if (url.endsWith('/api/assistant/session')) return response({ csrfToken: CSRF }, 200, { 'Set-Cookie': `companion_assistant_session_v1_4174=${TOKEN}; Path=/api/assistant; HttpOnly; SameSite=Strict` });
    return handler(url, request);
  };
  const server = createMcpServer({ input, output, errorOutput, fetchImpl, ...options }); server.start();
  t.after(() => server.close());
  function waitFor(check) { return new Promise((resolve, reject) => { const waiter = { check, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Synthetic MCP response timeout.')); }, 3000) }; waiter.timer.unref(); waiters.push(waiter); }); }
  function request(method, params, id = nextId++) { const pending = waitFor(message => message.id === id); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n'); return pending; }
  function notify(method, params) { input.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'); }
  async function initialize() { const result = await request('initialize', init); assert.equal(result.result.protocolVersion, '2025-11-25'); notify('notifications/initialized'); return result; }
  return { server, input, messages, calls, request, notify, initialize, waitFor, outputText: () => outputText, errorText: () => errorText };
}

test('MCP retained candidate inspection uses a bounded optional attempt on the same read-only build tool',async t=>{
 const id=randomUUID(),sent=[],f=await fixture(t,async(url,request)=>{sent.push({url,method:request.method});return response({buildId:id,number:1,status:'failed',files:[{path:'src/example.mjs',diff:'Retained diff'}],verification:{passed:false}});});await f.initialize();
 const list=await f.request('tools/list'),definition=list.result.tools.find(item=>item.name==='companion_get_build');assert.equal(list.result.tools.length,23);assert.equal(definition.annotations.readOnlyHint,true);assert.equal(definition.inputSchema.properties.attempt.maximum,2);
 for(const attempt of [0,3,'1',1.5,null])assert.equal((await f.request('tools/call',tool('companion_get_build',{id,attempt}))).error.code,-32602);
 assert.equal(f.calls.length,0);
 const result=await f.request('tools/call',tool('companion_get_build',{id,attempt:1}));assert.equal(result.result.structuredContent.number,1);assert.deepEqual(sent,[{url:ORIGIN+'/api/assistant/features/'+id+'/attempts/1',method:'GET'}]);
 await f.request('tools/call',tool('companion_get_build',{id}));assert.deepEqual(sent.at(-1),{url:ORIGIN+'/api/assistant/features/'+id,method:'GET'});
});

test('MCP work handoff and paged inspection retain stable identities without rerunning status checks',async t=>{
  const sent=[],id=randomUUID(),providerId='synthetic-provider',f=await fixture(t,async(url,request)=>{sent.push({url,method:request.method,body:request.body?JSON.parse(request.body):undefined});return response(url.includes('/work?')?{jobs:[{id,status:'running'}],total:1,hasMore:false,nextOffset:null}:{job:{id,conversationId:id,status:url.endsWith('/cancel')?'cancelled':'running'}});});await f.initialize();
  const body={id,prompt:'Draft a synthetic outline in the background.',providerId};assert.equal((await f.request('tools/call',tool('companion_start_work',body))).result.isError,false);assert.deepEqual(sent.at(-1),{url:ORIGIN+'/api/assistant/work',method:'POST',body});
  await f.request('tools/call',tool('companion_list_work',{offset:20,limit:10}));assert.equal(sent.at(-1).url,ORIGIN+'/api/assistant/work?offset=20&limit=10');assert.equal(sent.at(-1).method,'GET');
  await f.request('tools/call',tool('companion_get_work',{id,textOffset:4000,actionOffset:12}));assert.equal(sent.at(-1).url,ORIGIN+'/api/assistant/work/'+id+'?textOffset=4000&actionOffset=12');assert.equal(sent.at(-1).method,'GET');
  await f.request('tools/call',tool('companion_cancel_work',{id}));assert.deepEqual(sent.at(-1),{url:ORIGIN+'/api/assistant/work/'+id+'/cancel',method:'POST',body:{}});assert.equal(sent.filter(item=>item.method==='POST'&&!item.url.endsWith('/cancel')).length,1);
  const count=sent.length;for(const[name,args]of[['companion_start_work',{...body,contextId:randomUUID()}],['companion_get_work',{id:id+'?forged=1'}],['companion_get_work',{id,textLimit:4001}],['companion_list_work',{limit:21}],['companion_cancel_work',{id,scope:'forged'}]])assert.equal((await f.request('tools/call',tool(name,args))).error.code,-32602);assert.equal(sent.length,count);
});

test('MCP chat, independent work and direct tools preserve explicit project bindings and actual edit receipts',async t=>{
  const project={projectId:randomUUID(),grantEpoch:7},operationId=randomUUID(),sent=[];
  const edit={id:operationId,...project,path:'notes.txt',status:'applied',beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64),bytes:16,undoAvailable:true};
  const f=await fixture(t,async(url,request)=>{const body=JSON.parse(request.body);sent.push({url,method:request.method,body});return response(url.endsWith('/tools/run')?{result:{projectFileEdit:edit,replayed:true}}:url.endsWith('/work')?{job:{id:body.id,status:'queued',project}}:{id:body.id,text:'Saved synthetic reply.',projectContext:project,actions:[]});});await f.initialize();
  const chat={id:'project-bound-turn',message:'Summarize the chosen project.',project};
  const reply=await f.request('tools/call',tool('companion_chat',chat));assert.equal(reply.result.isError,false);assert.deepEqual(sent.at(-1),{url:ORIGIN+'/api/assistant/chat',method:'POST',body:chat});assert.deepEqual(reply.result.structuredContent.projectContext,project);
  const work={id:randomUUID(),prompt:'Independently inspect this chosen project.',providerId:'synthetic-provider',project};
  const handedOff=await f.request('tools/call',tool('companion_start_work',work));assert.equal(handedOff.result.structuredContent.job.status,'queued');assert.deepEqual(sent.at(-1),{url:ORIGIN+'/api/assistant/work',method:'POST',body:work});
  const direct={tool:'run_capability',arguments:{name:'cap_project_files',arguments:{action:'write',...project,path:'notes.txt',content:'Synthetic change',expectedHash:'a'.repeat(64)}},operationId,project};
  const changed=await f.request('tools/call',tool('companion_run_tool',direct));assert.equal(changed.result.isError,false);assert.deepEqual(sent.at(-1),{url:ORIGIN+'/api/assistant/tools/run',method:'POST',body:direct});assert.deepEqual(changed.result.structuredContent.result.projectFileEdit,edit);
  await f.request('tools/call',tool('companion_run_tool',direct));assert.deepEqual(sent.at(-1).body,direct);assert.equal(sent.filter(item=>item.url.endsWith('/tools/run')).length,2);
  // A later unbound request must not inherit a preceding request's folder.
  await f.request('tools/call',tool('companion_chat',{id:'unbound-next-turn',message:'What time is it?'}));assert.equal(Object.hasOwn(sent.at(-1).body,'project'),false);
  const listed=await f.request('tools/list');assert.equal(listed.result.tools.length,23);
  for(const name of ['companion_chat','companion_start_work','companion_run_tool']){const definition=listed.result.tools.find(item=>item.name===name),shape=definition.inputSchema.properties.project;assert.deepEqual(shape.required,['projectId','grantEpoch']);assert.equal(shape.additionalProperties,false);assert.equal(shape.properties.grantEpoch.minimum,1);assert.equal(shape.properties.grantEpoch.maximum,Number.MAX_SAFE_INTEGER);assert.equal(definition.inputSchema.required.includes('project'),false);}
  assert.equal(listed.result.tools.some(item=>/choose.*(?:folder|project)|revoke.*(?:folder|project)/i.test(item.name)),false);
});

test('MCP rejects malformed or path-bearing project bindings before session bootstrap or any endpoint call',async t=>{
  const f=await fixture(t);await f.initialize();const projectId=randomUUID();
  const calls=[['companion_chat',{id:'project-validation',message:'Read the selected folder.'}],['companion_start_work',{id:randomUUID(),prompt:'Inspect the selected folder.',providerId:'synthetic-provider'}],['companion_run_tool',{tool:'list_capabilities',arguments:{}}]];
  const invalid=[null,[],{}, {projectId}, {grantEpoch:1}, {projectId:'not-a-uuid',grantEpoch:1}, {projectId:projectId+'?path=outside',grantEpoch:1}, {projectId,grantEpoch:0}, {projectId,grantEpoch:-1}, {projectId,grantEpoch:1.5}, {projectId,grantEpoch:'1'}, {projectId,grantEpoch:Number.MAX_SAFE_INTEGER+1}, {projectId,grantEpoch:1,path:'C:/unapproved'}, {projectId,grantEpoch:1,label:'unsupported metadata'}, {projectId,grantEpoch:1,approved:true}];
  for(const[name,base]of calls)for(const project of invalid){const reply=await f.request('tools/call',tool(name,{...base,project}));assert.equal(reply.error?.code,-32602,JSON.stringify({name,project,reply}));}
  for(const[name,base]of calls)assert.equal((await f.request('tools/call',tool(name,{...base,projectId,grantEpoch:1}))).error.code,-32602);
  assert.equal(f.calls.length,0);
});

test('targeted source MCP reads encode exact paths and preserve source without granting arbitrary file access',async t=>{
  const path='docs/notes & examples + 研究 # 100%.md',hash='a'.repeat(64),content='const apiKey = "synthetic-example";\r\nconst text = "😀";\n',sent=[];
  const f=await fixture(t,async(url,request)=>{sent.push({url,method:request.method});return response({path,hash,content,offset:0,nextOffset:null,hasMore:false,characterLength:content.length,byteLength:Buffer.byteLength(content),sourceTrust:'untrusted_source'});});await f.initialize();
  const read=await f.request('tools/call',tool('companion_read_source',{path,expectedHash:hash,limit:12000}));assert.equal(read.result.isError,false);assert.equal(read.result.structuredContent.content,content);const url=new URL(sent[0].url);assert.equal(url.pathname,'/api/assistant/features/source/file');assert.equal(url.searchParams.get('path'),path);assert.equal(url.searchParams.get('expectedHash'),hash);assert.equal(sent[0].method,'GET');
  const count=sent.length;for(const args of [{path:'../private.txt'},{path:'.env'},{path:'server/.env'},{path:'data/productivity.sqlite'},{path:'src\\app.mjs'},{path,offset:1},{path,owner:'foreign'},{path,expectedHash:'z'.repeat(64)},{path,limit:12001}])assert.equal((await f.request('tools/call',tool('companion_read_source',args))).error.code,-32602);assert.equal(sent.length,count);
});

test('an exact source page cannot silently change its content under credential redaction',async t=>{
  const f=await fixture(t,async()=>response({path:'src/fixture.mjs',hash:'a'.repeat(64),content:'const leakedSession = "'+TOKEN+'";\n',offset:0,nextOffset:null,hasMore:false,sourceTrust:'untrusted_source'}));await f.initialize();const result=await f.request('tools/call',tool('companion_read_source',{path:'src/fixture.mjs'}));assert.equal(result.result.isError,true);assert.equal(result.result.structuredContent.error.code,'source_redacted');assert.ok(!Object.hasOwn(result.result.structuredContent,'content'));assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('MCP lifecycle negotiates tools, requires initialized, and keeps stdout protocol only', async t => {
  const f = await fixture(t); assert.equal((await f.request('ping')).result.constructor, Object);
  assert.equal((await f.request('tools/list')).error.code, -32002);
  const initialized = await f.request('initialize', { ...init, protocolVersion: '2024-11-05' }); assert.equal(initialized.result.protocolVersion, '2025-11-25'); assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.equal(initialized.result.serverInfo.version, APP_VERSION);
  assert.equal((await f.request('tools/list')).error.code, -32002); f.notify('notifications/initialized');
  const listed = await f.request('tools/list'); assert.equal(listed.result.tools.length, 23); assert.equal(listed.result.tools.find(item => item.name === 'companion_workspace').annotations.readOnlyHint, true); assert.equal(listed.result.tools.find(item => item.name === 'companion_read_source').annotations.readOnlyHint,true);assert.equal(listed.result.tools.find(item => item.name === 'companion_apply_build').annotations.destructiveHint, true);
  assert.equal(listed.result.tools.find(item => item.name === 'companion_run_tool').annotations.openWorldHint, true);
  assert.equal(listed.result.tools.some(item => /approve.*desktop|desktop.*approve/.test(item.name)), false);
  assert.equal(f.calls.length, 0); assert.equal(f.errorText(), ''); for (const line of f.outputText().trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.equal((await f.request('initialize', init)).error.code, -32600);
});

test('MCP workspace and chat use fixed local endpoints with a private reusable session and exact POST Origin', async t => {
  const f = await fixture(t, async (url, request) => response(url.endsWith('/workspace') ? { revision: 2, tasks: [{ title: 'Synthetic task' }] } : { id: JSON.parse(request.body).id, text: 'Synthetic reply.', actions: [] })); await f.initialize();
  const workspace = await f.request('tools/call', tool('companion_workspace')); assert.equal(workspace.result.structuredContent.tasks[0].title, 'Synthetic task');
  const chat = await f.request('tools/call', tool('companion_chat', { id: 'synthetic-chat', message: 'Help with a task.' })); assert.equal(chat.result.structuredContent.text, 'Synthetic reply.');
  assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 1);
  const post = f.calls.find(call => call.url.endsWith('/chat')); assert.equal(post.headers.Origin, ORIGIN); assert.equal(post.headers['X-CSRF-Token'], CSRF); assert.equal(post.headers.Cookie, `companion_assistant_session_v1_4174=${TOKEN}`); assert.equal(post.redirect, 'error');
  assert.ok(f.calls.every(call => call.url.startsWith(ORIGIN + '/api/assistant/'))); assert.ok(!f.outputText().includes(TOKEN)); assert.ok(!f.outputText().includes(CSRF));
});

test('MCP discovers current registered schemas without exposing integration launch configuration', async t => {
  const registered = [{ name: 'read_note', description: 'Read one saved note.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }];
  const f = await fixture(t, async () => response({ tools: registered, mcp: { command: 'private-launch-path', args: ['private-source-path'] } })); await f.initialize();
  const result = await f.request('tools/call', tool('companion_list_tools'));
  assert.deepEqual(result.result.structuredContent, { tools: registered });
  assert.equal(f.calls.at(-1).url, ORIGIN + '/api/assistant/integrations'); assert.equal(f.calls.at(-1).method, 'GET');
  assert.ok(!f.outputText().includes('private-launch-path')); assert.ok(!f.outputText().includes('private-source-path'));
  const invalid = await fixture(t, async () => response({ tools: {} })); await invalid.initialize();
  assert.equal((await invalid.request('tools/call', tool('companion_list_tools'))).result.structuredContent.error.code, 'invalid_response');
});

test('MCP saved conversations use exact routes, current revisions and only server-owned history', async t => {
  const id = randomUUID(), sent = [];
  const f = await fixture(t, async (url, request) => {
    const body = request.body ? JSON.parse(request.body) : undefined; sent.push({ url, request, body });
    if (url.endsWith('/chat')) return response({ id: body.id, conversationId: id, conversation: { id, revision: 2, turns: [{ id: body.id, status: 'completed', message: body.message, reply: { text: 'Saved response.', actions: [{ tool: 'read_note', status: 'completed' }] } }] } });
    if (request.method === 'POST') return response({ id: body.id, title: body.title, revision: 0, turns: [] });
    if (url.endsWith('/' + id)) return response({ id, title: 'Synthetic saved discussion', revision: 1, turns: [{ id: 'earlier', status: 'completed', message: 'Original intent.' }] });
    return response({ conversations: [{ id, title: 'Synthetic saved discussion', revision: 1, turnCount: 1 }] });
  });
  await f.initialize();
  const listed = await f.request('tools/call', tool('companion_list_conversations')); assert.equal(listed.result.structuredContent.conversations[0].revision, 1);
  const fetched = await f.request('tools/call', tool('companion_get_conversation', { id })); assert.equal(fetched.result.structuredContent.turns[0].message, 'Original intent.');
  await f.request('tools/call', tool('companion_get_conversation', { id, before: 'saved_older-turn' })); assert.equal(sent.at(-1).url, ORIGIN + '/api/assistant/conversations/' + id + '?before=saved_older-turn');
  const create = { id: randomUUID(), title: 'Synthetic new conversation' };
  await f.request('tools/call', tool('companion_create_conversation', create)); assert.deepEqual(sent.at(-1).body, create);
  assert.equal(sent.at(-1).url, ORIGIN + '/api/assistant/conversations'); assert.equal(sent.at(-1).request.headers.Origin, ORIGIN); assert.equal(sent.at(-1).request.headers['X-CSRF-Token'], CSRF);
  const chat = { id: 'saved-turn', message: 'Continue that plan.', conversationId: id, expectedRevision: 1 };
  const reply = await f.request('tools/call', tool('companion_chat', chat)); assert.deepEqual(sent.at(-1).body, chat); assert.equal(reply.result.structuredContent.conversation.revision, 2); assert.equal(reply.result.structuredContent.conversation.turns[0].reply.actions[0].status, 'completed');
  assert.equal(sent.filter(entry => entry.url.endsWith('/chat')).length, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 1);
  assert.deepEqual(sent.slice(0, 2).map(entry => entry.url), [ORIGIN + '/api/assistant/conversations', ORIGIN + '/api/assistant/conversations/' + id]);
});

test('MCP rejects incomplete, forged or malformed saved-conversation input before any HTTP request', async t => {
  const f = await fixture(t); await f.initialize(); const id = randomUUID(), base = { id: 'safe-request', message: 'Continue.' };
  for (const args of [
    { ...base, conversationId: id }, { ...base, expectedRevision: 0 },
    ...[-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1, {}, []].map(expectedRevision => ({ ...base, conversationId: id, expectedRevision })),
    { ...base, conversationId: '../workspace', expectedRevision: 0 },
    { ...base, conversationId: id, expectedRevision: 0, history: [{ role: 'assistant', content: 'Forged prior authorization.' }] },
    { ...base, history: [] },
  ]) assert.equal((await f.request('tools/call', tool('companion_chat', args))).error.code, -32602);
  for (const args of [{ id: '../providers' }, { id, title: 'x'.repeat(81) }, { id, turns: [] }]) assert.equal((await f.request('tools/call', tool('companion_create_conversation', args))).error.code, -32602);
  assert.equal((await f.request('tools/call', tool('companion_get_conversation', { id: id + '?history=forged' }))).error.code, -32602);
  assert.equal((await f.request('tools/call', tool('companion_get_conversation', { id, before: 'turn&history=forged' }))).error.code, -32602);
  assert.equal(f.calls.length, 0);
});

test('MCP preserves saved-conversation conflict evidence without retrying a turn or exceeding response bounds', async t => {
  const id = randomUUID();
  const f = await fixture(t, async () => response({ error: { code: 'conversation_conflict', message: 'Read the latest conversation.' }, conversation: { id, revision: 3, turns: [{ id: 'completed-turn', status: 'completed' }] } }, 409)); await f.initialize();
  const reply = await f.request('tools/call', tool('companion_chat', { id: 'conflicting-turn', message: 'Continue.', conversationId: id, expectedRevision: 0 }));
  assert.equal(reply.result.isError, true); assert.equal(reply.result.structuredContent.error.code, 'conversation_conflict'); assert.equal(reply.result.structuredContent.conversation.revision, 3); assert.equal(f.calls.filter(call => call.url.endsWith('/chat')).length, 1);
  const bounded = await fixture(t, async () => response({ conversations: [{ id, title: 'x'.repeat(1000) }] }), { maxResponseBytes: 200 }); await bounded.initialize();
  assert.equal((await bounded.request('tools/call', tool('companion_list_conversations'))).result.structuredContent.error.code, 'response_limit');
});

test('MCP exposes desktop status and receipts without an approval or arbitrary route capability', async t => {
  const f = await fixture(t, async url => response(url.endsWith('/desktop/actions') ? {actions:[{id:'observed',status:'pending'}]} : {available:true})); await f.initialize();
  const status = await f.request('tools/call',tool('companion_desktop_status')); assert.equal(status.result.structuredContent.available,true);
  const actions = await f.request('tools/call',tool('companion_desktop_actions')); assert.equal(actions.result.structuredContent.actions[0].status,'pending');
  const denied = await f.request('tools/call',tool('companion_desktop_approve',{id:'observed'})); assert.ok(denied.error);
  assert.ok(f.calls.some(call => call.url.endsWith('/api/assistant/desktop')));
  assert.ok(f.calls.some(call => call.url.endsWith('/api/assistant/desktop/actions')));
  assert.equal(f.calls.some(call => call.url.includes('/approve')),false);
});

test('MCP source, build, activation and patch tools map actual backend envelopes without arbitrary paths', async t => {
  const buildId = randomUUID(), payloads = [];
  const f = await fixture(t, async (url, request) => { payloads.push({ url, request, body: request.body ? JSON.parse(request.body) : undefined }); if (url.includes('/source')) return response({ revision: 'synthetic-hash', files: [{ path: 'src/features/example.mjs', hash: 'a'.repeat(64) }] }); if (request.method === 'GET') return response({ jobs: [] }); return response({ id: buildId, status: url.endsWith('/apply') ? 'applied' : 'queued' }, 202); }); await f.initialize();
  await f.request('tools/call', tool('companion_source', { includeContent: true })); assert.ok(payloads[0].url.endsWith('/features/source?content=1'));
  const build = await f.request('tools/call', tool('companion_build_feature', { prompt: 'Add a synthetic feature.', autoApply: false })); assert.equal(build.result.structuredContent.status, 'queued'); assert.deepEqual(payloads[1].body, { prompt: 'Add a synthetic feature.', autoApply: false });
  await f.request('tools/call', tool('companion_get_build', { id: buildId }));
  const applied = await f.request('tools/call', tool('companion_apply_build', { id: buildId })); assert.equal(applied.result.structuredContent.status, 'applied'); assert.deepEqual(payloads.at(-1).body, {});
  await f.request('tools/call', tool('companion_rollback_build', { id: buildId })); assert.ok(payloads.at(-1).url.endsWith('/rollback'));
  const patch = { summary: 'Original synthetic patch', files: [{ path: 'src/features/example.mjs', content: 'export const example = true;' }], baseHashes: { 'src/features/example.mjs': null }, autoApply: false };
  await f.request('tools/call', tool('companion_submit_patch', patch)); assert.ok(payloads.at(-1).url.endsWith('/features/patch')); assert.deepEqual(payloads.at(-1).body, patch);
  const launchers = { summary: 'Supported root source files', files: [{ path: 'Start Desktop Companion.cmd', content: '@echo off\n' }, { path: 'Stop Companion.cmd', content: '@echo off\n' }, { path: 'mcp.example.json', content: '{}\n' }], baseHashes: { 'Start Desktop Companion.cmd': 'a'.repeat(64), 'Stop Companion.cmd': null, 'mcp.example.json': 'b'.repeat(64) }, autoApply: false };
  assert.equal((await f.request('tools/call', tool('companion_submit_patch', launchers))).result.isError, false); assert.deepEqual(payloads.at(-1).body, launchers);
  const count = payloads.length;
  for (const bad of [{ ...patch, files: [{ path: '../private.txt', content: 'x' }] }, { ...patch, files: [{ path: 'server/.env', content: 'x' }] }, { ...patch, files: [{ path: 'C:/outside.txt', content: 'x' }] }, { ...patch, baseHashes: {} }, { ...patch, providerId: 'not-an-external-patch-field' }]) assert.equal((await f.request('tools/call', tool('companion_submit_patch', bad))).error.code, -32602);
  assert.equal(payloads.length, count); assert.equal((await f.request('tools/call', tool('companion_workspace', { url: 'https://external.example' }))).error.code, -32602);
});

test('MCP errors preserve failed-action evidence while redacting credentials and rejecting key configuration', async t => {
  const f = await fixture(t, async url => url.endsWith('/providers') ? response({ providers: [{ id: 'fake', hasKey: true, apiKey: 'synthetic-api-key', protectedKey: 'synthetic-cipher' }], csrfToken: CSRF, diagnostic: `session=${TOKEN}` }) : response({ error: { code: 'revision_conflict', message: 'Review the latest workspace.' }, actions: [{ tool: 'create_task', status: 'completed' }] }, 409)); await f.initialize();
  const providers = await f.request('tools/call', tool('companion_connections')); assert.equal(providers.result.structuredContent.providers[0].hasKey, true); assert.equal(providers.result.structuredContent.providers[0].apiKey, '[redacted]');
  for (const secret of [TOKEN, CSRF, 'synthetic-api-key', 'synthetic-cipher']) assert.ok(!f.outputText().includes(secret));
  const failed = await f.request('tools/call', tool('companion_run_tool', { tool: 'create_task', arguments: { title: 'Synthetic task' }, operationId: randomUUID() })); assert.equal(failed.result.isError, true); assert.equal(failed.result.structuredContent.actions[0].status, 'completed');
  assert.equal((await f.request('tools/call', tool('companion_configure_provider', { apiKey: 'must-not-forward' }))).error.code, -32602);
});

test('MCP refreshes expired assistant sessions once, but never retries rejected provider credentials', async t => {
  let workspaceCalls = 0;
  const f = await fixture(t, async url => {
    if (url.endsWith('/workspace')) return ++workspaceCalls === 1 ? response({ error: { code: 'assistant_session_required', message: 'Refresh session.' } }, 401) : response({ revision: 1, tasks: [] });
    return response({ error: { code: 'provider_credentials_rejected', message: 'Update this provider key.' } }, 401);
  });
  await f.initialize(); assert.equal((await f.request('tools/call', tool('companion_workspace'))).result.isError, false); assert.equal(workspaceCalls, 2); assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 2);
  const chat = await f.request('tools/call', tool('companion_chat', { id: 'credential-failure', message: 'A synthetic request.' })); assert.equal(chat.result.isError, true); assert.equal(chat.result.structuredContent.error.code, 'provider_credentials_rejected'); assert.equal(f.calls.filter(call => call.url.endsWith('/chat')).length, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 2);
});

test('MCP cancellation aborts pending HTTP, frees admission and suppresses even a late reply', async t => {
  let began, resolveFetch, requestSignal; const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, (_url, request) => { requestSignal = request.signal; began(); return new Promise(resolve => { resolveFetch = resolve; }); }, { maxInFlight: 1 }); await f.initialize();
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: tool('companion_workspace') }) + '\n'); await started;
  assert.equal((await f.request('ping')).error.code, -32000); f.notify('notifications/cancelled', { requestId: 'cancel-me', reason: 'Synthetic user cancellation' }); assert.equal(requestSignal.aborted, true);
  assert.deepEqual((await f.request('ping')).result, {}); resolveFetch(response({ text: 'Late reply must be ignored.' })); await turn(); assert.ok(!f.messages.some(message => message.id === 'cancel-me'));
  const before = f.messages.length; f.notify('notifications/cancelled', { requestId: 'unknown' }); f.notify('notifications/unknown'); await turn(); assert.equal(f.messages.length, before);
});

test('MCP HTTP timeouts and response limits return bounded tool errors without raw network diagnostics', async t => {
  const timed = await fixture(t, () => new Promise(() => {}), { requestTimeoutMs: 15 }); await timed.initialize(); const timeout = await timed.request('tools/call', tool('companion_workspace')); assert.equal(timeout.result.isError, true); assert.equal(timeout.result.structuredContent.error.code, 'companion_timeout');
  const large = await fixture(t, async () => response({ text: 'x'.repeat(1000) }), { maxResponseBytes: 100 }); await large.initialize(); const limit = await large.request('tools/call', tool('companion_workspace')); assert.equal(limit.result.structuredContent.error.code, 'response_limit');
  const offline = await fixture(t, async () => { throw new Error('synthetic-private-network-detail'); }); await offline.initialize(); const failed = await offline.request('tools/call', tool('companion_workspace')); assert.equal(failed.result.structuredContent.error.code, 'companion_unavailable'); assert.ok(!offline.outputText().includes('synthetic-private-network-detail'));
});

test('MCP framing rejects malformed UTF-8, batches and oversized messages, then recovers on the next newline', async t => {
  const f = await fixture(t, undefined, { maxFrameBytes: 512 });
  let pending = f.waitFor(message => message.error?.code === -32700); f.input.write(Buffer.from([0xc3, 0x28, 10])); await pending;
  pending = f.waitFor(message => message.error?.code === -32600); f.input.write('[]\n'); await pending;
  pending = f.waitFor(message => message.error?.message.includes('input limit')); f.input.write('x'.repeat(600) + '\n'); await pending;
  assert.deepEqual((await f.request('ping')).result, {}); await f.initialize(); assert.equal((await f.request('missing/method')).error.code, -32601);
  assert.equal((await f.request('ping', [])).error.code, -32602);
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'unicode', method: 'tools/call', params: tool('companion_chat', { id: 'unicode-chat', message: 'Plan café work → done.' }) }) + '\n'); const index = bytes.indexOf(Buffer.from('é')); pending = f.waitFor(message => message.id === 'unicode'); f.input.write(bytes.subarray(0, index + 1)); f.input.write(bytes.subarray(index + 1)); assert.equal((await pending).result.isError, false);
  assert.equal(JSON.parse(f.calls.find(call => call.url.endsWith('/chat')).body).message, 'Plan café work → done.');
});

test('MCP endpoint configuration cannot target external hosts, credentials, paths or non-HTTP schemes', () => {
  for (const companionUrl of ['https://example.com', 'http://example.com:4174', 'http://127.0.0.1:4174/arbitrary', 'http://user:synthetic-secret@localhost:4174', 'file:///private', 'http://localhost:4174/?token=secret', 'http://localhost:4174/#fragment']) assert.throws(() => createMcpServer({ companionUrl }), /COMPANION_URL/);
});

test('real stdio subprocess bridges a disposable loopback API without protocol pollution', { timeout: 10000 }, async t => {
  let port, writes = [];
  const api = http.createServer((request, result) => {
    const send = (value, headers = {}) => { result.writeHead(200, { 'Content-Type': 'application/json', ...headers }); result.end(JSON.stringify(value)); };
    if (request.url === '/api/assistant/session') return send({ csrfToken: CSRF }, { 'Set-Cookie': `companion_assistant_session_v1_${port}=${TOKEN}; Path=/api/assistant; HttpOnly; SameSite=Strict` });
    assert.equal(request.headers.cookie, `companion_assistant_session_v1_${port}=${TOKEN}`);
    if (request.url === '/api/assistant/workspace') return send({ revision: 7, tasks: [{ title: 'Disposable stdio test' }] });
    if (request.url === '/api/assistant/features') { assert.equal(request.headers.origin, `http://127.0.0.1:${port}`); assert.equal(request.headers['x-csrf-token'], CSRF); const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { writes.push(JSON.parse(Buffer.concat(chunks))); send({ id: randomUUID(), status: 'queued' }); }); return; }
    result.writeHead(404); result.end('{}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); port = api.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/mcp-server.mjs', import.meta.url))], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { COMPANION_URL: `http://127.0.0.1:${port}`, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  let buffer = '', stdout = '', stderr = ''; const received = [], waiters = new Map();
  child.stdout.on('data', chunk => { stdout += chunk.toString(); buffer += chunk.toString(); let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); received.push(message); waiters.get(message.id)?.(message); waiters.delete(message.id); } }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise(resolve => child.on('close', resolve));
  t.after(async () => { child.kill(); await exited; await new Promise(resolve => api.close(resolve)); });
  const call = (id, method, params) => new Promise(resolve => { waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  assert.equal((await call(1, 'initialize', init)).result.protocolVersion, '2025-11-25'); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal((await call(2, 'tools/call', tool('companion_workspace'))).result.structuredContent.revision, 7);
  assert.equal((await call(3, 'tools/call', tool('companion_build_feature', { prompt: 'A disposable feature request.', autoApply: false }))).result.structuredContent.status, 'queued'); assert.equal(writes[0].autoApply, false);
  child.stdin.end(); assert.equal(await exited, 0); assert.equal(received.length, 3); assert.equal(stderr, ''); assert.ok(!stdout.includes(TOKEN)); assert.ok(!stdout.includes(CSRF));
});
