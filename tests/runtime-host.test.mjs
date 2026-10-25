import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCompanionHost } from '../server/companion-host.mjs';
import { getRuntimeStatus, requestRuntimeRestart } from '../server/runtime-control.mjs';
import { createFeatureBuilder } from '../server/feature-builder.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const helper = new URL('../server/runtime-control.mjs', import.meta.url).href;
const jobId = '8f9ab960-3a65-4258-a433-14f825ec9a3c';
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function workerSource({ version = 'one', fail = false, crashAfter = 0, delayStart = 0, neverReady = false, ignoreShutdown = false, wrongMarker = false } = {}) {
  return `import http from 'node:http';import{requestRuntimeRestart}from${JSON.stringify(helper)};
const port=Number(process.env.COMPANION_SHARED_PORT),instance=process.env.COMPANION_HOST_INSTANCE;
if(${fail})process.exit(23);
let server,crash,starter,stopping=false;
function stop(){if(stopping)return;stopping=true;clearTimeout(starter);clearTimeout(crash);if(server)server.close(()=>{if(process.connected)process.disconnect();});else if(process.connected)process.disconnect();}
if(${neverReady})setInterval(()=>{},1000);else starter=setTimeout(()=>{
server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/health'){res.setHeader('X-Companion-Instance',${wrongMarker}?'wrong-instance':instance);res.end(JSON.stringify({service:'companion-shared'}));}
else if(req.url==='/restart'){res.once('finish',()=>requestRuntimeRestart());res.end(JSON.stringify({requested:true}));}
else res.end(JSON.stringify({version:${JSON.stringify(version)},pid:process.pid,secretPresent:!!process.env.SYNTHETIC_API_KEY,nodeOptions:process.env.NODE_OPTIONS||''}));});
server.listen(port,'127.0.0.1',()=>{process.send({type:'companion:ready',instance,port});if(${crashAfter})crash=setTimeout(()=>process.exit(19),${crashAfter});});
},${delayStart});
process.on('message',m=>{if(!${ignoreShutdown}&&m?.type==='companion:shutdown'&&m.instance===instance)stop();});
process.on('disconnect',()=>{if(!${ignoreShutdown})stop();});
`;
}
async function fixture(t, { worker = {}, ...options } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-host-'));
  const root = path.join(temporary, 'source'), dataDirectory = path.join(temporary, 'private');
  await mkdir(path.join(root, 'server'), { recursive: true });
  const workerPath = path.join(root, 'server/room-server.mjs'); await writeFile(workerPath, workerSource(worker));
  const port = await freePort(); const host = await createCompanionHost({ root, dataDirectory, port, startupTimeoutMs: 2500, shutdownTimeoutMs: 300, backoffMs: 10, ...options });
  t.after(async () => { await host.close(); const target = path.resolve(temporary); assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep + 'companion-host-')); await rm(target, { recursive: true, force: true }); });
  return { host, root, dataDirectory, port, workerPath, temporary, async value() { return (await fetch(`http://127.0.0.1:${port}/value`)).json(); } };
}
async function until(check, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Synthetic runtime condition did not settle.');
}

test('runtime restart helper only sends a typed, managed-parent message', () => {
  const unmanaged = { env: {}, pid: 1 };
  assert.deepEqual(requestRuntimeRestart({}, unmanaged), { managed: false, restarting: false });
  const messages = [], managed = { env: { COMPANION_MANAGED_HOST: '1', COMPANION_HOST_INSTANCE: 'synthetic-instance', COMPANION_HOST_PID: '42' }, pid: 43, connected: true, send: value => messages.push(value) };
  assert.equal(getRuntimeStatus(managed).managed, true);
  assert.deepEqual(requestRuntimeRestart({ jobId }, managed), { managed: true, restarting: true });
  requestRuntimeRestart({ jobId }, managed); assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { type: 'companion:restart-requested', instance: 'synthetic-instance', jobId });
  assert.throws(() => requestRuntimeRestart({ command: 'arbitrary shell' }, managed), { code: 'invalid_restart_request' });
  assert.throws(() => requestRuntimeRestart({ jobId: '../../outside' }, managed), { code: 'invalid_restart_request' });
});

test('an asynchronous restart IPC error clears pending state without an unhandled send error', async () => {
  const runtime = { env: { COMPANION_MANAGED_HOST: '1', COMPANION_HOST_INSTANCE: 'synthetic-instance' }, connected: true,
    send(_message, callback) { queueMicrotask(() => callback(Object.assign(new Error('Synthetic disconnected channel'), { code: 'EPIPE' }))); } };
  assert.equal(requestRuntimeRestart({}, runtime).restarting, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getRuntimeStatus(runtime).restarting, false);
});

test('public host lifetimes exclude lock secrets and stronger host requests are not silently downgraded',()=>{
  const hostInstanceId=randomUUID(),supervisorInstanceId=randomUUID(),privateNonce=randomUUID(),messages=[],callbacks=[];
  const runtime={pid:103,connected:true,env:{COMPANION_MANAGED_HOST:'1',COMPANION_HOST_INSTANCE:randomUUID(),COMPANION_HOST_PID:'102',COMPANION_HOST_LIFETIME:hostInstanceId,COMPANION_SUPERVISED_HOST:'1',COMPANION_SUPERVISOR_PID:'101',COMPANION_SUPERVISOR_NONCE:privateNonce,COMPANION_SUPERVISOR_INSTANCE:randomUUID(),COMPANION_SUPERVISOR_LIFETIME:supervisorInstanceId},send(message,callback){messages.push(message);callbacks.push(callback);}};
  const status=getRuntimeStatus(runtime);assert.equal(status.hostInstanceId,hostInstanceId);assert.equal(status.supervisorInstanceId,supervisorInstanceId);assert.equal(status.hostRestartAvailable,true);assert.equal(status.supervisorPid,101);assert.ok(!JSON.stringify(status).includes(privateNonce));
  requestRuntimeRestart({},runtime);requestRuntimeRestart({scope:'host',jobId},runtime);requestRuntimeRestart({scope:'worker'},runtime);requestRuntimeRestart({scope:'host'},runtime);
  assert.equal(messages.length,2);assert.equal(messages[1].scope,'host');assert.equal(messages[1].jobId,jobId);callbacks[0](new Error('Late old worker send error'));assert.equal(getRuntimeStatus(runtime).restarting,true);callbacks[1](new Error('Host send error'));assert.equal(getRuntimeStatus(runtime).restarting,false);
  assert.throws(()=>requestRuntimeRestart({scope:'host'},{pid:1,env:{}}),{code:'manual_host_restart_required',statusCode:409});
  for(const scope of ['launcher','shell',null])assert.throws(()=>requestRuntimeRestart({scope},runtime),{code:'invalid_restart_request'});
});

test('an independent host cannot bypass either outer supervisor claim or adopt an unconnected parent',async t=>{
  const f=await fixture(t),claim={pid:process.pid,nonce:randomUUID(),port:f.port,sourceRoot:f.root},dataClaim=path.join(f.dataDirectory,'runtime-supervisor.lock'),portClaim=path.join(f.root,`.companion-supervisor-${f.port}.lock`);
  await writeFile(dataClaim,JSON.stringify(claim));await assert.rejects(f.host.start(),{code:'runtime_supervisor_exists'});assert.equal(f.host.status().workerPid,null);
  await rm(dataClaim);await writeFile(portClaim,JSON.stringify(claim));await assert.rejects(f.host.start(),{code:'runtime_supervisor_exists'});
  const names=['COMPANION_SUPERVISED_HOST','COMPANION_SUPERVISOR_PID','COMPANION_SUPERVISOR_NONCE','COMPANION_SUPERVISOR_INSTANCE','COMPANION_SUPERVISOR_LIFETIME'],previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try{
    process.env.COMPANION_SUPERVISED_HOST='1';process.env.COMPANION_SUPERVISOR_PID=String(process.ppid);process.env.COMPANION_SUPERVISOR_NONCE=claim.nonce;process.env.COMPANION_SUPERVISOR_INSTANCE=randomUUID();process.env.COMPANION_SUPERVISOR_LIFETIME=randomUUID();await writeFile(dataClaim,JSON.stringify({...claim,pid:process.ppid}));await writeFile(portClaim,JSON.stringify({...claim,pid:process.ppid}));
    await assert.rejects(createCompanionHost({root:f.root,dataDirectory:f.dataDirectory,port:f.port}),{code:'invalid_supervisor'});
  }finally{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}await rm(dataClaim);await rm(portClaim);}
});

test('live-child IPC errors do not prove exit or permit replacement before owned-handle termination', async t => {
  const children = [];
  const f = await fixture(t, {
    shutdownTimeoutMs: 60,
    spawnWorker({ instance, port }) {
      const child = new EventEmitter(); Object.assign(child, { pid: 900000 + children.length, connected: true, exitCode: null, kills: 0, instance });
      child.send = (_message, callback) => { setImmediate(() => { const error = Object.assign(new Error('Synthetic IPC error while child remains alive'), { code: 'EPIPE' }); callback?.(error); child.emit('error', error); }); };
      child.kill = signal => { child.kills += 1; child.exitCode = 0; child.emit('exit', 0, signal); return true; };
      setTimeout(() => child.emit('message', { type: 'companion:ready', instance, port }), 5);
      children.push(child); return child;
    },
    fetchImpl: async () => new Response(JSON.stringify({ service: 'companion-shared' }), { headers: { 'x-companion-instance': children.at(-1).instance } }),
  });
  await f.host.start(); await f.host.restart();
  assert.equal(children.length, 2); assert.equal(children[0].kills, 1);
  assert.equal(f.host.status().workerPid, children[1].pid);
  await f.host.close(); assert.equal(children[1].kills, 1);
});

test('managed restart starts fresh source behavior on the same public port and stops its old worker', async t => {
  const f = await fixture(t); const first = await f.host.start();
  assert.equal(first.status, 'ready'); assert.equal((await f.value()).version, 'one');
  const oldPid = first.workerPid;
  await writeFile(f.workerPath, workerSource({ version: 'two' }));
  const second = await f.host.restart();
  assert.equal(second.hostInstanceId,first.hostInstanceId);assert.notEqual(second.instance,first.instance);
  assert.equal(second.port, first.port); assert.notEqual(second.workerPid, oldPid);
  assert.equal((await f.value()).version, 'two');
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  await f.host.close();
  await assert.rejects(access(path.join(f.dataDirectory, 'runtime-host.lock')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(f.dataDirectory, 'runtime-host.json'), 'utf8')).status, 'stopped');
});

test('worker IPC restart requests use the managed supervisor', async t => {
  const f = await fixture(t); await f.host.start(); const oldPid = f.host.status().workerPid;
  await fetch(`http://127.0.0.1:${f.port}/restart`);
  await until(() => f.host.status().status === 'ready' && f.host.status().workerPid !== oldPid);
  assert.equal((await f.value()).version, 'one');
});

test('a live supervisor lock prevents duplicates during a worker restart gap', async t => {
  const f = await fixture(t); await f.host.start();
  await writeFile(f.workerPath, workerSource({ version: 'two', delayStart: 300 }));
  const restarting = f.host.restart(); await until(() => f.host.status().generation === 2);
  const other = await createCompanionHost({ root: f.root, dataDirectory: f.dataDirectory, port: f.port, startupTimeoutMs: 1000 });
  await assert.rejects(other.start(), { code: 'runtime_host_exists' }); await other.close();
  assert.equal(JSON.parse(await readFile(path.join(f.dataDirectory, 'runtime-host.lock'), 'utf8')).nonce, f.host.status().nonce);
  await restarting; assert.equal((await f.value()).version, 'two');
});

test('a different data directory cannot steal the same source and port during restart', async t => {
  const f = await fixture(t); await f.host.start();
  await writeFile(f.workerPath, workerSource({ version: 'two', delayStart: 300 }));
  const restarting = f.host.restart(); await until(() => f.host.status().generation === 2);
  const other = await createCompanionHost({ root: f.root, dataDirectory: path.join(f.temporary, 'other-private'), port: f.port });
  await assert.rejects(other.start(), { code: 'runtime_host_exists' }); await other.close();
  await restarting; assert.equal((await f.value()).version, 'two');
});

test('failed updated startup invokes recorded source rollback once and restarts the old worker', async t => {
  const rollbacks = []; let target;
  const f = await fixture(t, { rollback: async id => { rollbacks.push(id); await writeFile(target, workerSource({ version: 'restored' })); } }); target = f.workerPath;
  await f.host.start(); await writeFile(f.workerPath, workerSource({ fail: true }));
  const restored = await f.host.restart({ jobId });
  assert.deepEqual(rollbacks, [jobId]); assert.equal(restored.status, 'ready'); assert.equal(restored.lastRollbackJobId, jobId);
  assert.equal((await f.value()).version, 'restored'); assert.equal(restored.generation, 3);
});

test('failed source rollback reports manual recovery and does not loop or overwrite source', async t => {
  let count = 0;
  const f = await fixture(t, { rollback: async () => { count += 1; throw Object.assign(new Error('A later human edit prevents rollback'), { code: 'source_conflict' }); } });
  await f.host.start(); const broken = workerSource({ fail: true }); await writeFile(f.workerPath, broken);
  await assert.rejects(f.host.restart({ jobId }), { code: 'source_conflict' });
  assert.equal(count, 1); assert.equal(f.host.status().status, 'failed'); assert.match(f.host.status().error, /manual review/);
  assert.equal(await readFile(f.workerPath, 'utf8'), broken);
});

test('default recovery uses the retained feature-builder backup without asking any model', async t => {
  const f = await fixture(t); await f.host.start();
  const original = await readFile(f.workerPath, 'utf8');
  const builder = await createFeatureBuilder({ root: f.root, dataDirectory: path.join(f.dataDirectory, 'feature-builds'),
    complete: async () => ({ summary: 'Synthetic protected update with a startup failure', files: [{ path: 'server/room-server.mjs', content: workerSource({ fail: true }) }], tests: [] }) });
  const queued = await builder.request({ prompt: 'Prepare test update', providerId: 'synthetic', autoApply: false }, 'local-workspace');
  const prepared = await until(async () => { const job = await builder.get(queued.id, 'local-workspace'); return ['review_required','failed'].includes(job.status) && job; });
  assert.equal(prepared.status, 'review_required'); await builder.apply(prepared.id, 'local-workspace'); await builder.close();
  const recovered = await f.host.restart({ jobId: prepared.id });
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.lastRollbackJobId, prepared.id);
  assert.equal(await readFile(f.workerPath, 'utf8'), original); assert.equal((await f.value()).version, 'one');
  const metadata = JSON.parse(await readFile(path.join(f.dataDirectory, 'feature-builds', prepared.id, 'job.json'), 'utf8'));
  assert.equal(metadata.status, 'rolled_back');
});

test('unexpected worker crashes have a finite restart budget', async t => {
  const f = await fixture(t, { worker: { crashAfter: 200 }, maxCrashRestarts: 2 });
  await f.host.start(); await until(() => f.host.status().status === 'failed');
  assert.equal(f.host.status().crashRestarts, 2); assert.equal(f.host.status().generation, 3);
  assert.match(f.host.status().error, /Automatic recovery stopped/);
});

test('startup deadlines and instance health checks reject unready or unrelated workers', async t => {
  const hanging = await fixture(t, { worker: { neverReady: true, ignoreShutdown: true }, startupTimeoutMs: 150, shutdownTimeoutMs: 100 });
  await assert.rejects(hanging.host.start(), { code: 'runtime_start_failed' });
  assert.equal(hanging.host.status().status, 'failed');
  const mismatched = await fixture(t, { worker: { wrongMarker: true }, startupTimeoutMs: 300 });
  await assert.rejects(mismatched.host.start(), { code: 'runtime_start_failed' });
});

test('workers receive an allowlisted environment without API secrets or Node option injection', async t => {
  const previousKey = process.env.SYNTHETIC_API_KEY, previousOptions = process.env.NODE_OPTIONS;
  process.env.SYNTHETIC_API_KEY = 'synthetic-private-key'; process.env.NODE_OPTIONS = '--require=invalid-private-option.cjs';
  try {
    const f = await fixture(t); await f.host.start(); const value = await f.value();
    assert.equal(value.secretPresent, false); assert.equal(value.nodeOptions, '');
  } finally {
    if (previousKey === undefined) delete process.env.SYNTHETIC_API_KEY; else process.env.SYNTHETIC_API_KEY = previousKey;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
  }
});

test('the actual room worker reports managed readiness and restarts using disposable data only', async t => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'companion-host-real-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = await freePort();
  const host = await createCompanionHost({ root, dataDirectory, port, startupTimeoutMs: 5000, shutdownTimeoutMs: 2000 });
  t.after(async () => { await host.close(); const target = path.resolve(dataDirectory); assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep + 'companion-host-real-')); await rm(target, { recursive: true, force: true }); });
  const first = await host.start();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.headers.get('x-companion-instance'), first.instance);
  assert.equal((await response.json()).setupRequired, true);
  const second = await host.restart(); assert.notEqual(second.workerPid, first.workerPid); assert.equal(second.status, 'ready');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).setupRequired, true);
});
