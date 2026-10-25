import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCodexCompletion, getCodexStatus } from '../server/codex-runner.mjs';

function fakeSpawn(handler) {
  return (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.input = '';
    child.kill = () => { child.killed = true; child.exitCode = 137; queueMicrotask(() => child.emit('close', 137)); return true; };
    child.stdin = new Writable({ write(chunk, _, callback) { child.input += chunk.toString(); callback(); } });
    if (args[0] === 'login') queueMicrotask(() => handler(child, args, options, command));
    else child.stdin.on('finish', () => handler(child, args, options, command));
    return child;
  };
}
function finish(child, text = 'Synthetic answer.') { child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n'); child.stdout.write('{"type":"turn.completed"}\n'); child.exitCode = 0; child.emit('close', 0); }
async function directory(t) { const folder = await mkdtemp(path.join(tmpdir(), 'companion-codex-test-')); t.after(async () => { assert.ok(path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(folder, { recursive: true, force: true }); }); return folder; }

test('Codex completion uses stdin, a private empty job, strict read-only flags and the existing default model', async t => {
  const dataDirectory = await directory(t); const events = [];let started=0;
  const spawnImpl = fakeSpawn(async (child, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.ok(options.cwd.startsWith(dataDirectory + path.sep)); assert.deepEqual(await readdir(options.cwd), []);
    for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check']) assert.ok(args.includes(flag)); assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert.ok(args.includes('mcp_servers={}')); assert.ok(!args.includes('--model')); assert.ok(!args.includes('--ignore-user-config'));
    assert.ok(!args.some(arg => arg.includes('synthetic user request'))); assert.match(child.input, /synthetic user request/);
    assert.equal(started,1,'Ownership is announced before the prompt is sent.');
    child.stdout.write('{"type":"turn.started"}\n'); finish(child);
  });
  assert.deepEqual(await runCodexCompletion({ prompt: 'A synthetic user request with `shell characters` and $variables.', dataDirectory, spawnImpl, onEvent: event => events.push(event),onHelperStarted(...args){assert.deepEqual(args,[]);started++;throw new Error('Observer failure cannot change ownership.');} }), { text: 'Synthetic answer.', toolCalls: [] });
  assert.deepEqual(await readdir(dataDirectory), []); assert.ok(events.length > 1);
});

test('Codex structured output passes a schema file and a user-selected model without shell expansion', async t => {
  const dataDirectory = await directory(t); const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  const spawnImpl = fakeSpawn(async (child, args) => { assert.equal(args[args.indexOf('--model') + 1], 'user-chosen-model'); assert.deepEqual(JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8')), schema); finish(child, '{"answer":"structured"}'); });
  assert.equal((await runCodexCompletion({ prompt: 'Return structured data.', schema, model: 'user-chosen-model', dataDirectory, spawnImpl })).text, '{"answer":"structured"}');
});

test('Codex JSONL decoding preserves Unicode across split pipe chunks', async t => {
  const dataDirectory = await directory(t), expected = 'Plan café tasks → done';
  const spawnImpl = fakeSpawn(child => { const event = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: expected } }) + '\n'); const index = event.indexOf(Buffer.from('é')); child.stdout.write(event.subarray(0, index + 1)); child.stdout.write(event.subarray(index + 1)); child.stdout.write('{"type":"turn.completed"}\n'); child.exitCode = 0; child.emit('close', 0); });
  assert.equal((await runCodexCompletion({ prompt: 'Return Unicode.', dataDirectory, spawnImpl })).text, expected);
});

test('Codex login status returns only readiness and never diagnostic or credential text', async () => {
  const ready = fakeSpawn(child => { child.stderr.write('Logged in using ChatGPT\n'); child.emit('close', 0); }); assert.deepEqual(await getCodexStatus({ spawnImpl: ready }), { ready: true, unavailableReason: null });
  const failed = fakeSpawn(child => { child.stderr.write('synthetic-private-diagnostic'); child.emit('close', 1); }); const value = await getCodexStatus({ spawnImpl: failed }); assert.equal(value.ready, false); assert.ok(!JSON.stringify(value).includes('synthetic-private-diagnostic'));
});

test('Codex cancellation, timeout, malformed output and unexpected actions cannot publish late answers', async t => {
  const dataDirectory = await directory(t); let started;
  const ready = new Promise(resolve => { started = resolve; }); let child;
  const controller = new AbortController(); const pending = runCodexCompletion({ prompt: 'Synthetic pending task.', signal: controller.signal, dataDirectory, spawnImpl: fakeSpawn(value => { child = value; started(); }) });
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError', code: 'request_cancelled' }); assert.equal(child.killed, true);
  await assert.rejects(runCodexCompletion({ prompt: 'Synthetic timeout.', timeoutMs: 10, dataDirectory, spawnImpl: fakeSpawn(() => {}) }), { code: 'provider_timeout' });
  await assert.rejects(runCodexCompletion({ prompt: 'Bad events.', dataDirectory, spawnImpl: fakeSpawn(child => { child.stdout.write('not-json-synthetic-secret\n'); }) }), error => error.code === 'invalid_provider_response' && !error.message.includes('synthetic-secret'));
  await assert.rejects(runCodexCompletion({ prompt: 'No commands.', dataDirectory, spawnImpl: fakeSpawn(child => { child.stdout.write('{"type":"item.started","item":{"type":"command_execution"}}\n'); }) }), { code: 'unexpected_provider_action' });
  await assert.rejects(runCodexCompletion({ prompt: 'Bound output.', maxOutputBytes: 20, dataDirectory, spawnImpl: fakeSpawn(child => { child.stdout.write('x'.repeat(30)); }) }), { code: 'provider_output_limit' });
  assert.deepEqual(await readdir(dataDirectory), []);
});

test('Codex admits at most two completions and releases both slots after cancellation', async t => {
  const dataDirectory = await directory(t), children = []; let notify;
  const started = new Promise(resolve => { notify = resolve; }); const spawnImpl = fakeSpawn(child => { children.push(child); if (children.length === 2) notify(); }); const firstController = new AbortController(), secondController = new AbortController();
  const first = runCodexCompletion({ prompt: 'First.', dataDirectory, spawnImpl, signal: firstController.signal }); const second = runCodexCompletion({ prompt: 'Second.', dataDirectory, spawnImpl, signal: secondController.signal });
  await started; await assert.rejects(runCodexCompletion({ prompt: 'Third.', dataDirectory, spawnImpl }), { code: 'provider_busy' });
  // Register both rejection observers before aborting either concurrent request.
  const rejections=[assert.rejects(first,{name:'AbortError'}),assert.rejects(second,{name:'AbortError'})];
  firstController.abort(); secondController.abort(); await Promise.all(rejections);
  assert.equal((await runCodexCompletion({ prompt: 'Next.', dataDirectory, spawnImpl: fakeSpawn(child => finish(child)) })).text, 'Synthetic answer.');
});

test('bounded cancellation retains both real helper leases and private job files until actual close',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const dataDirectory=await directory(t),children=[],settlements=[],callbacks=[0,0];let notify,spawned=0;
  const started=new Promise(resolve=>{notify=resolve;});
  const settled=Array.from({length:2},(_,index)=>new Promise(resolve=>{settlements[index]=resolve;}));
  const spawnImpl=fakeSpawn((child,_args,options)=>{
    const index=Number(/Synthetic no-close helper (\d)/.exec(child.input)[1]);child.pid=10000+index;child.cwd=options.cwd;child.kill=()=>{child.killed=true;return true;};children[index]=child;if(++spawned===2)notify();
  });
  const controllers=[new AbortController(),new AbortController()];
  const pending=controllers.map((controller,index)=>runCodexCompletion({prompt:'Synthetic no-close helper '+index,dataDirectory,spawnImpl,signal:controller.signal,
    schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
    onHelperSettled(...args){assert.deepEqual(args,[]);callbacks[index]++;settlements[index]();if(index===0)throw new Error('Observer failure cannot retain its lease.');},
  }));
  const rejected=pending.map(promise=>assert.rejects(promise,{name:'AbortError',code:'request_cancelled'}));
  try{
    await started;controllers.forEach(controller=>controller.abort());t.mock.timers.tick(1500);await Promise.all(rejected);
    assert.deepEqual(callbacks,[0,0]);assert.equal((await readdir(dataDirectory)).length,2);
    for(const child of children)assert.deepEqual(await readdir(child.cwd),['output-schema.json']);
    let deniedStarted=0;await assert.rejects(runCodexCompletion({prompt:'Third cannot start while either cancelled process is unconfirmed.',dataDirectory,spawnImpl,onHelperStarted(){deniedStarted++;}}),{code:'provider_busy'});assert.equal(children.length,2);assert.equal(deniedStarted,0);
    // Even a complete late answer cannot replace the cancellation. Only its
    // actual close releases the old lease and permits another owned helper.
    finish(children[0],'Late answer must not be published.');await settled[0];assert.deepEqual(callbacks,[1,0]);
    assert.equal((await readdir(dataDirectory)).length,1);
    assert.equal((await runCodexCompletion({prompt:'Next after confirmed close.',dataDirectory,spawnImpl:fakeSpawn(child=>finish(child))})).text,'Synthetic answer.');
    assert.equal((await readdir(dataDirectory)).length,1);
    children[1].exitCode=137;children[1].emit('close',137);await settled[1];assert.deepEqual(callbacks,[1,1]);assert.deepEqual(await readdir(dataDirectory),[]);
    children[0].emit('close',0);assert.deepEqual(callbacks,[1,1]);
  }finally{for(const child of children)if(child.exitCode===null){child.exitCode=137;child.emit('close',137);}await Promise.all(settled);}
});

test('a live helper error is not proof of process exit and cannot release its private cwd early',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const dataDirectory=await directory(t);let child,started,notify,settledCount=0;
  const entered=new Promise(resolve=>{started=resolve;}),closed=new Promise(resolve=>{notify=resolve;});
  const pending=runCodexCompletion({prompt:'Synthetic live-error helper.',dataDirectory,spawnImpl:fakeSpawn((value,_args,options)=>{child=value;child.pid=12000;child.cwd=options.cwd;child.kill=()=>true;started();}),onHelperSettled(){settledCount++;notify();}});
  const rejected=assert.rejects(pending,{code:'provider_unavailable'});
  try{await entered;child.emit('error',new Error('Synthetic failed IPC while process remains alive.'));t.mock.timers.tick(1500);await rejected;assert.equal(settledCount,0);assert.deepEqual(await readdir(child.cwd),[]);child.exitCode=1;child.emit('close',1);await closed;assert.equal(settledCount,1);assert.deepEqual(await readdir(dataDirectory),[]);}
  finally{if(child&&child.exitCode===null){child.exitCode=1;child.emit('close',1);}await closed;}
});

test('pre-spawn cancellation, invalid input and confirmed spawn failures notify settlement once without data',async t=>{
  const dataDirectory=await directory(t),controller=new AbortController();controller.abort();
  const variants=[{prompt:'',code:'validation_error'},{prompt:'Synthetic pre-abort.',signal:controller.signal,code:'request_cancelled'},{prompt:'Synthetic spawn throw.',spawnImpl:()=>{throw new Error('Synthetic private spawn diagnostic.');},code:'provider_unavailable'},{prompt:'Synthetic absent-pid spawn error.',spawnImpl:fakeSpawn(child=>child.emit('error',new Error('Synthetic failed spawn.'))),code:'provider_unavailable'}];
  for(const {code,...options}of variants){let count=0,started=0;await assert.rejects(runCodexCompletion({dataDirectory,...options,onHelperStarted(){started++;},onHelperSettled(...args){assert.deepEqual(args,[]);count++;throw new Error('Synthetic observer failure.');}}),{code});assert.equal(count,1);assert.equal(started,options.spawnImpl&&options.prompt.includes('absent-pid')?1:0);assert.deepEqual(await readdir(dataDirectory),[]);}
});

test('Codex connection-probe mode disables available tools without changing the configured default model',async t=>{
  const dataDirectory=await directory(t);let inspected=false;
  const spawnImpl=fakeSpawn(async(child,args,options)=>{
    assert.deepEqual(await readdir(options.cwd),['connection-probe-instructions.txt']);assert.ok(!args.includes('--ignore-user-config'));assert.ok(!args.includes('--model'));assert.ok(!args.includes('--output-schema'));assert.equal(options.shell,false);
    for(const feature of ['shell_tool','hooks','memories','multi_agent','multi_agent_v2','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use','view_image','image_generation','skill_search','skill_mcp_dependency_install','workspace_dependencies','sleep_tool','goals','tool_suggest'])assert.ok(args.some((value,index)=>value==='--disable'&&args[index+1]===feature),feature);
    for(const option of ['mcp_servers={}','features.apps=false','features.plugins=false','web_search="disabled"','tools.view_image=false','project_doc_max_bytes=0','developer_instructions=""'])assert.ok(args.includes(option));
    const instructionsPath=JSON.parse(args.find(arg=>arg.startsWith('model_instructions_file=')).slice('model_instructions_file='.length));assert.equal(instructionsPath,path.join(options.cwd,'connection-probe-instructions.txt'));assert.match(await readFile(instructionsPath,'utf8'),/one fixed synthetic connection check/);assert.ok(!child.input.includes(options.cwd));
    inspected=true;finish(child,'COMPANION_CONNECTION_OK');
  });
  assert.equal((await runCodexCompletion({connectionProbe:true,prompt:'Synthetic connection check only.',dataDirectory,spawnImpl})).text,'COMPANION_CONNECTION_OK');assert.equal(inspected,true);
});

test('connection probes reject every non-message item proposal, repeated answers and outputs beyond their fixed cap',async t=>{
  const dataDirectory=await directory(t);
  for(const type of ['command_execution','mcp_tool_call','web_search','file_change','custom_tool_call','collab_tool_call','todo_list','future_unknown_action'])await assert.rejects(runCodexCompletion({connectionProbe:true,prompt:'Synthetic check.',dataDirectory,spawnImpl:fakeSpawn(child=>{child.stdout.write(JSON.stringify({type:'item.updated',item:{type}})+'\n');})}),{code:'unexpected_provider_action'});
  await assert.rejects(runCodexCompletion({connectionProbe:true,prompt:'Synthetic check.',dataDirectory,spawnImpl:fakeSpawn(child=>{child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'First'}})+'\n');finish(child,'COMPANION_CONNECTION_OK');})}),{code:'invalid_provider_response'});
  await assert.rejects(runCodexCompletion({connectionProbe:true,prompt:'Synthetic check.',maxOutputBytes:2000000,dataDirectory,spawnImpl:fakeSpawn(child=>child.stdout.write('x'.repeat(32769)))}),{code:'provider_output_limit'});
  const result=await runCodexCompletion({connectionProbe:true,prompt:'Synthetic check.',dataDirectory,spawnImpl:fakeSpawn(child=>{child.stdout.write('{"type":"item.completed","item":{"type":"reasoning","text":"Synthetic reasoning omitted"}}\n');finish(child,'COMPANION_CONNECTION_OK');})});assert.equal(result.text,'COMPANION_CONNECTION_OK');
});

test('fixed CLI startup diagnostic items are discarded and cannot replace real probe completion',async t=>{
  const dataDirectory=await directory(t),diagnostic=JSON.stringify({type:'item.completed',item:{id:'synthetic-diagnostic',type:'error',message:'SYNTHETIC_PRIVATE_DIAGNOSTIC_NEVER_RETURNED'}})+'\n';
  const result=await runCodexCompletion({connectionProbe:true,prompt:'Synthetic fixed check.',dataDirectory,spawnImpl:fakeSpawn(child=>{child.stdout.write('{"type":"thread.started"}\n');child.stdout.write(diagnostic);child.stdout.write('{"type":"turn.started"}\n');finish(child,'COMPANION_CONNECTION_OK');})});assert.deepEqual(result,{text:'COMPANION_CONNECTION_OK',toolCalls:[]});assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  for(const completed of [false,true])await assert.rejects(runCodexCompletion({connectionProbe:true,prompt:'Synthetic fixed check.',dataDirectory,spawnImpl:fakeSpawn(child=>{child.stdout.write(diagnostic);if(completed)child.stdout.write('{"type":"turn.completed"}\n');child.exitCode=0;child.emit('close',0);})}),error=>error.code==='provider_unavailable'&&!error.message.includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
});
