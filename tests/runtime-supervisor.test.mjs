import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRuntimeSupervisor } from '../server/runtime-supervisor.mjs';
const hostModule = new URL('../server/companion-host.mjs', import.meta.url).href;
const controlModule = new URL('../server/runtime-control.mjs', import.meta.url).href;
const jobId = 'ef0cf7df-05a3-4456-94f9-303e146983bd';
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function until(predicate, deadline = 7000) { const end = Date.now() + deadline; while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Fixture did not reach the expected state.'); }
function hostSource() { return `import{createCompanionHost as create}from${JSON.stringify(hostModule)};import{value}from'./dependency.mjs';process.env.COMPANION_LOCAL_MODEL=value;export const createCompanionHost=options=>create({...options,startupTimeoutMs:1000,shutdownTimeoutMs:500});`; }
const workerSource = `import http from'node:http';import{getRuntimeStatus,requestRuntimeRestart}from${JSON.stringify(controlModule)};
const instance=process.env.COMPANION_HOST_INSTANCE,port=Number(process.env.COMPANION_SHARED_PORT);const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/health'){res.setHeader('X-Companion-Instance',instance);res.end(JSON.stringify({service:'companion-shared'}));}else if(req.url==='/restart'){res.once('finish',()=>requestRuntimeRestart({scope:'host'}));res.end('{}');}else res.end(JSON.stringify({...getRuntimeStatus(),hostVersion:process.env.COMPANION_LOCAL_MODEL,secretPresent:!!process.env.SYNTHETIC_API_KEY,nodeOptions:process.env.NODE_OPTIONS||''}));});
server.listen(port,'127.0.0.1',()=>process.send({type:'companion:ready',instance,port}));let stopping=false;function stop(){if(stopping)return;stopping=true;server.close(()=>{if(process.connected)process.disconnect();});}process.on('message',message=>{if(message?.type==='companion:shutdown'&&message.instance===instance)stop();});process.once('disconnect',stop);`;
async function fixture(t, options = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-supervisor-'));
  const root = path.join(temporary, 'source'), dataDirectory = path.join(temporary, 'data'), selectedPort = await port();
  await mkdir(path.join(root, 'server'), { recursive: true });
  await writeFile(path.join(root, 'server', 'companion-host.mjs'), hostSource());
  await writeFile(path.join(root, 'server', 'dependency.mjs'), "export const value='one';");
  await writeFile(path.join(root, 'server', 'room-server.mjs'), workerSource);
  const supervisor = await createRuntimeSupervisor({ root, dataDirectory, port: selectedPort, startupTimeoutMs: 2500, shutdownTimeoutMs: 2000, ...options });
  t.after(async () => {
    await supervisor.close();
    const resolved = path.resolve(temporary), parent = path.resolve(tmpdir());
    assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('companion-supervisor-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { supervisor, root, dataDirectory, port: selectedPort,
    dependency: path.join(root, 'server', 'dependency.mjs'),
    value: () => fetch(`http://127.0.0.1:${selectedPort}/runtime`).then(response => response.json()),
    claim: () => readFile(path.join(dataDirectory, 'runtime-supervisor.lock'), 'utf8').then(JSON.parse),
  };
}

test('real full relaunch refreshes host-cached behavior and both public identities while retaining outer ownership', async t => {
  const f = await fixture(t); const first = await f.supervisor.start(), before = await f.value(), claim = await f.claim();
  assert.equal(before.hostVersion, 'one'); assert.equal(before.hostRestartAvailable, true); assert.equal(before.supervisorInstanceId, first.supervisorInstanceId);
  await writeFile(f.dependency, "export const value='two';");
  const second = await f.supervisor.restart(), after = await f.value();
  assert.equal(after.hostVersion, 'two'); assert.equal(second.pid, first.pid); assert.equal(second.supervisorInstanceId, first.supervisorInstanceId);
  assert.notEqual(second.hostPid, first.hostPid); assert.notEqual(second.workerPid, first.workerPid); assert.notEqual(after.hostInstanceId, before.hostInstanceId); assert.notEqual(after.workerInstanceId, before.workerInstanceId);
  assert.deepEqual(await f.claim(), claim); assert.equal(after.secretPresent, false); assert.equal(after.nodeOptions, '');
  assert.throws(() => process.kill(first.hostPid, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(first.workerPid, 0), { code: 'ESRCH' });
  await f.supervisor.close(); await assert.rejects(access(path.join(f.dataDirectory, 'runtime-supervisor.lock')), { code: 'ENOENT' });
});

test('worker IPC requests cross the owned host and replace the complete service once', async t => {
  const f = await fixture(t); const first = await f.supervisor.start();
  await fetch(`http://127.0.0.1:${f.port}/restart`);
  await until(() => f.supervisor.status().status === 'ready' && f.supervisor.status().generation === 2);
  assert.notEqual(f.supervisor.status().hostPid, first.hostPid); assert.equal((await f.value()).hostRestartAvailable, true);
});

test('cached trusted recovery runs once after a dependency import failure and can start restored source', async t => {
  let calls = 0, failedPid;
  const f = await fixture(t, { rollback: async id => {
    calls++; assert.equal(id, jobId); failedPid = f.supervisor.status().hostPid;
    assert.throws(() => process.kill(failedPid, 0), { code: 'ESRCH' });
    await writeFile(f.dependency, "export const value='restored';");
  } });
  await f.supervisor.start(); await writeFile(f.dependency, "throw new Error('SYNTHETIC_IMPORT_FAILURE');export const value='bad';");
  const restored = await f.supervisor.restart({ jobId });
  assert.equal(calls, 1); assert.equal(restored.lastRollbackJobId, jobId); assert.equal(restored.generation, 3); assert.equal((await f.value()).hostVersion, 'restored');
});

test('source recovery conflicts preserve later source and do not launch a third host', async t => {
  let calls = 0;
  const f = await fixture(t, { rollback: async () => { calls++; throw Object.assign(new Error('Synthetic source conflict'), { code: 'source_conflict' }); } });
  await f.supervisor.start(); const later = "throw new Error('LATER_HUMAN_EDIT');export const value='later';"; await writeFile(f.dependency, later);
  await assert.rejects(f.supervisor.restart({ jobId }), { code: 'source_conflict' });
  assert.equal(calls, 1); assert.equal(f.supervisor.status().generation, 2); assert.equal(f.supervisor.status().status, 'failed'); assert.equal(await readFile(f.dependency, 'utf8'), later); assert.ok(await f.claim());
});

function fakeHosts({ stall = false, wrong = false, pauseAfterFirst = false } = {}) {
  const children = [];
  function spawnHost({ instance, port, cwd }) {
    const child = new EventEmitter(); Object.assign(child, { pid: 900000 + children.length, connected: true, instance, closes: 0 });
    child.send = (message, callback) => {
      callback?.();
      if (message.type === 'companion:host-start-allowed') child.allowed = true;
      if (message.type === 'companion:host-start-allowed' && !(pauseAfterFirst && children.length > 1)) setImmediate(() => child.ready());
      if (message.type === 'companion:host-shutdown' && !stall) child.finish();
    };
    child.ready = () => child.emit('message', { type: 'companion:host-ready', instance, status: { status: 'ready', pid: wrong ? child.pid + 1 : child.pid, workerPid: child.pid + 1000, port, sourceRoot: cwd, hostInstanceId: randomUUID(), instance: child.workerInstance } });
    child.finish = () => { child.closes++; child.connected = false; child.emit('message', { type: 'companion:host-stopped', instance }); child.emit('close', 0, null); };
    child.workerInstance = randomUUID(); children.push(child); setImmediate(() => child.emit('message', { type: 'companion:host-starting', instance })); return child;
  }
  return { children, spawnHost, fetchImpl: async () => new Response('{"service":"companion-shared"}', { headers: { 'x-companion-instance': children.at(-1).workerInstance } }) };
}

test('both outer claims prevent duplicate owners throughout a confirmed host replacement gap', async t => {
  const fake = fakeHosts({ pauseAfterFirst: true }); const f = await fixture(t, fake); await f.supervisor.start();
  const restarting = f.supervisor.restart();
  await until(() => fake.children.length === 2);
  assert.equal(fake.children[0].closes, 1); assert.equal(f.supervisor.status().status, 'starting');
  const same = await createRuntimeSupervisor({ root: f.root, dataDirectory: f.dataDirectory, port: f.port, ...fake });
  await assert.rejects(same.start(), { code: 'supervisor_exists' }); await same.close();
  const other = await createRuntimeSupervisor({ root: f.root, dataDirectory: path.join(f.dataDirectory, 'other'), port: f.port, ...fake });
  await assert.rejects(other.start(), { code: 'supervisor_exists' }); await other.close();
  assert.equal(fake.children.length, 2); assert.equal((await f.claim()).pid, process.pid);
  await until(() => fake.children[1].allowed); fake.children[1].ready(); await restarting;
});

test('mismatched host identity never establishes readiness', async t => {
  const fake = fakeHosts({ wrong: true }); const f = await fixture(t, { ...fake, startupTimeoutMs: 70 });
  await assert.rejects(f.supervisor.start(), { code: 'supervisor_start_failed' }); assert.equal(fake.children.length, 1); assert.equal(fake.children[0].closes, 1);
});

test('an IPC error and observation deadline retain a live handle and never permit replacement or rollback', async t => {
  const fake = fakeHosts({ stall: true }); let rollbacks = 0;
  const f = await fixture(t, { ...fake, shutdownTimeoutMs: 60, rollback: async () => { rollbacks++; } }); await f.supervisor.start();
  fake.children[0].emit('error', new Error('Synthetic IPC failure'));
  await assert.rejects(f.supervisor.restart({ jobId }), { code: 'supervisor_stop_unconfirmed' });
  assert.equal(fake.children.length, 1); assert.equal(rollbacks, 0); assert.ok(await f.claim());
  fake.children[0].finish();
});

test('wrong and late launch packets cannot mark a successor ready', async t => {
  const fake = fakeHosts(); const f = await fixture(t, fake); await f.supervisor.start(); const old = fake.children[0];
  await f.supervisor.restart(); const before = f.supervisor.status();
  old.emit('message', { type: 'companion:host-ready', instance: old.instance, status: { status: 'ready', pid: old.pid, workerPid: 3, port: f.port, sourceRoot: f.root, hostInstanceId: randomUUID(), instance: old.workerInstance } });
  assert.deepEqual(f.supervisor.status(), before);
});

test('close during actual worker startup stops that owned process and never launches a successor', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'server', 'room-server.mjs'), "process.on('message',message=>{if(message?.type==='companion:shutdown')process.disconnect();});process.once('disconnect',()=>{});");
  const starting = f.supervisor.start();
  const rejected = assert.rejects(starting, { code: 'supervisor_closing' });
  let workerPid;
  await until(async () => {
    try { const value = JSON.parse(await readFile(path.join(f.dataDirectory, 'runtime-host.json'), 'utf8')); workerPid = value.workerPid; return Number.isInteger(workerPid) && workerPid > 0; }
    catch { return false; }
  });
  await f.supervisor.close(); await rejected;
  assert.equal(f.supervisor.status().generation, 1); assert.equal(f.supervisor.status().status, 'stopped');
  assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
});

test('a failed close can be retried only after the original handle actually closes', async t => {
  const fake = fakeHosts({ stall: true }); const f = await fixture(t, { ...fake, shutdownTimeoutMs: 60 }); await f.supervisor.start();
  await assert.rejects(f.supervisor.close(), { code: 'supervisor_stop_unconfirmed' });
  assert.ok(await f.claim()); assert.equal(fake.children.length, 1);
  fake.children[0].finish(); await f.supervisor.close();
  await assert.rejects(access(path.join(f.dataDirectory, 'runtime-supervisor.lock')), { code: 'ENOENT' });
});

test('durable uncertainty is recorded before startup permission and blocks reclaim after the owner actually dies', async t => {
  let probe, closed;
  t.after(async () => { if (probe && probe.exitCode === null) probe.kill('SIGKILL'); await closed; });
  const f = await fixture(t), module = new URL('../server/runtime-supervisor.mjs', import.meta.url).href;
  const script = path.join(f.root, 'owner-probe.mjs');
  await writeFile(script, `import{createRuntimeSupervisor}from${JSON.stringify(module)};import{EventEmitter}from'node:events';import{randomUUID}from'node:crypto';import{readFileSync}from'node:fs';import path from'node:path';
const root=${JSON.stringify(f.root)},dataDirectory=${JSON.stringify(f.dataDirectory)},port=${f.port},workerInstance=randomUUID();
const supervisor=await createRuntimeSupervisor({root,dataDirectory,port,fetchImpl:async()=>new Response('{"service":"companion-shared"}',{headers:{'x-companion-instance':workerInstance}}),spawnHost({instance,env}){const child=new EventEmitter();child.pid=900001;child.connected=true;child.send=message=>{if(message.type==='companion:host-start-allowed'){for(const file of[path.join(dataDirectory,'runtime-supervisor.lock.recovery'),path.join(root,'.companion-supervisor-'+port+'.lock.recovery')]){const marker=JSON.parse(readFileSync(file,'utf8'));if(marker.pid!==process.pid||marker.nonce!==env.COMPANION_SUPERVISOR_NONCE)throw new Error('Startup preceded durable ownership');}setImmediate(()=>child.emit('message',{type:'companion:host-ready',instance,status:{status:'ready',pid:child.pid,workerPid:900002,port,sourceRoot:root,hostInstanceId:randomUUID(),instance:workerInstance}}));}};setImmediate(()=>child.emit('message',{type:'companion:host-starting',instance}));return child;}});await supervisor.start();process.send({ready:true});process.on('message',message=>{if(message?.crash===true)process.exit(0);});`);
  probe = spawn(process.execPath, [script], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  closed = new Promise(resolve => probe.once('close', resolve));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic owner did not start.')), 5000); probe.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('Unexpected fixture message.')); }); probe.once('error', error => { clearTimeout(timer); reject(error); }); });
  const ownerPid = probe.pid; probe.send({ crash: true }); await closed;
  assert.throws(() => process.kill(ownerPid, 0), { code: 'ESRCH' });
  const other = await createRuntimeSupervisor({ root: f.root, dataDirectory: f.dataDirectory, port: f.port });
  await assert.rejects(other.start(), { code: 'supervisor_recovery_required' }); await other.close();
  assert.equal(JSON.parse(await readFile(path.join(f.dataDirectory, 'runtime-supervisor.lock'), 'utf8')).pid, ownerPid);
  await access(path.join(f.root, `.companion-supervisor-${f.port}.lock.recovery`));
});

test('the fixed private stop request rejects wrong ownership and gracefully stops only this actual service', async t => {
  const f = await fixture(t); const running = await f.supervisor.start(), request = path.join(f.dataDirectory, 'runtime-supervisor.stop'), claim = await f.claim();
  await writeFile(request, JSON.stringify({ ...claim, nonce: randomUUID(), action: 'shutdown' }));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(f.supervisor.status().hostPid, running.hostPid); assert.equal((await f.value()).hostVersion, 'one');
  await writeFile(request, JSON.stringify({ ...claim, action: 'shutdown' }));
  await until(() => f.supervisor.status().status === 'stopped');
  await assert.rejects(access(path.join(f.dataDirectory, 'runtime-supervisor.lock')), { code: 'ENOENT' });
  assert.throws(() => process.kill(running.hostPid, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(running.workerPid, 0), { code: 'ESRCH' });
});
