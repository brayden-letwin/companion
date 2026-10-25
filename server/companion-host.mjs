import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile, rename, unlink, open, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
// This cached import survives a worker's self-update and is used for recovery.
import { createFeatureBuilder as trustedFeatureBuilder } from './feature-builder.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });

function workerEnvironment(dataDirectory, port, instance, lifetime, supervisor) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'COMPANION_LOCAL_MODEL']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, COMPANION_SHARED_DATA_DIR: dataDirectory, COMPANION_SHARED_PORT: String(port),
    COMPANION_MANAGED_HOST: '1', COMPANION_HOST_INSTANCE: instance, COMPANION_HOST_PID: String(process.pid), COMPANION_HOST_LIFETIME: lifetime,
    ...(supervisor ? { COMPANION_SUPERVISED_HOST: '1', COMPANION_SUPERVISOR_PID: String(supervisor.pid), COMPANION_SUPERVISOR_NONCE: supervisor.nonce, COMPANION_SUPERVISOR_INSTANCE: supervisor.instance, COMPANION_SUPERVISOR_LIFETIME: supervisor.lifetime } : {}) };
}

/** One fixed-port worker, managed restarts, bounded crash recovery and source rollback. */
export async function createCompanionHost({ root = DEFAULT_ROOT, dataDirectory, port = 4174,
  spawnWorker, fetchImpl = globalThis.fetch, rollback, startupTimeoutMs = 15000, shutdownTimeoutMs = 10000,
  maxCrashRestarts = 3, backoffMs = 250, onFatal = () => {}, onHostRestart } = {}) {
  const sourceRoot = await realpath(path.resolve(root));
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw new TypeError('Use an absolute private runtime data directory.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError('Choose a fixed local port from 1024 to 65535.');
  for (const value of [startupTimeoutMs, shutdownTimeoutMs]) if (!Number.isInteger(value) || value < 50 || value > 120000) throw new RangeError('Use bounded startup and shutdown timeouts.');
  if (!Number.isInteger(maxCrashRestarts) || maxCrashRestarts < 0 || maxCrashRestarts > 5 || !Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > 5000) throw new RangeError('Use bounded crash recovery settings.');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const storage = await realpath(dataDirectory);
  if (storage === sourceRoot || storage.startsWith(sourceRoot + path.sep)) throw new TypeError('Runtime data must stay outside application source.');
  const lockPath = path.join(storage, 'runtime-host.lock'), metadataPath = path.join(storage, 'runtime-host.json');
  const portLockPath = path.join(sourceRoot, `.companion-runtime-${port}.lock`);
  const workerPath = path.join(sourceRoot, 'server', 'room-server.mjs');
  const supervisorClaims = [path.join(storage, 'runtime-supervisor.lock'), path.join(sourceRoot, `.companion-supervisor-${port}.lock`)];
  async function verifiedSupervisor() {
    const supervised = process.env.COMPANION_SUPERVISED_HOST === '1';
    const claims = await Promise.all(supervisorClaims.map(async file => {
      try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('invalid claim'); return JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw fail('invalid_supervisor', 'Supervisor ownership could not be verified. No worker was launched.', 409); }
    }));
    if (!supervised) {
      if (claims.some(Boolean)) throw fail('runtime_supervisor_exists', 'A supervisor owns this workspace or port. Use its normal launcher; no independent host was started.', 409);
      return null;
    }
    const pid = Number(process.env.COMPANION_SUPERVISOR_PID), supervisorNonce = process.env.COMPANION_SUPERVISOR_NONCE, instance = process.env.COMPANION_SUPERVISOR_INSTANCE,lifetime=process.env.COMPANION_SUPERVISOR_LIFETIME;
    if (typeof process.send !== 'function' || !process.connected || !Number.isInteger(pid) || pid <= 0 || pid !== process.ppid || !uuid.test(supervisorNonce || '') || !uuid.test(instance || '') || !uuid.test(lifetime||'')
      || claims.some(claim => !claim || claim.pid !== pid || claim.nonce !== supervisorNonce || claim.port !== port || claim.sourceRoot !== sourceRoot)) throw fail('invalid_supervisor', 'The connected parent and both supervisor claims must match. No worker was launched.', 409);
    return { pid, nonce: supervisorNonce, instance,lifetime };
  }
  const supervisor = await verifiedSupervisor(), hostInstanceId = randomUUID();
  if (onHostRestart !== undefined && typeof onHostRestart !== 'function') throw new TypeError('Use a typed host restart callback.');
  const nonce = randomUUID(); let lock = null, portLock = null, current = null, closing = false, started = false, closePromise = null;
  let operations = Promise.resolve(), writes = Promise.resolve(), crashRestarts = 0;
  const metadata = { version: 1, pid: process.pid, nonce, port, sourceRoot, status: 'stopped', workerPid: null,
    generation: 0, hostInstanceId, ...(supervisor ? { supervisorPid: supervisor.pid } : {}), crashRestarts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const status = () => structuredClone(metadata);
  function enqueue(callback) { const work = operations.then(callback, callback); operations = work.catch(() => {}); return work; }
  async function update(values) {
    Object.assign(metadata, values, { updatedAt: new Date().toISOString() });
    const body = JSON.stringify(metadata); const temporary = path.join(storage, `.runtime-host-${randomUUID()}.tmp`);
    const work = writes.then(async () => {
      try {
        await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, metadataPath); break; }
          catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 3) throw error; await wait(20 * (attempt + 1)); }
        }
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    writes = work.catch(() => {}); await work;
  }
  async function removeOwned(file, expectedNonce) {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.nonce !== expectedNonce) throw fail('runtime_lock_changed', 'The runtime lock changed ownership. No process was stopped.', 409);
    await unlink(file);
  }
  async function claimLock(file) {
    let ownedHandle;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { ownedHandle = await open(file, 'wx', 0o600); await ownedHandle.writeFile(JSON.stringify({ pid: process.pid, nonce, port, sourceRoot })); return ownedHandle; }
      catch (error) {
        if (ownedHandle) { await ownedHandle.close(); throw error; }
        if (error.code !== 'EEXIST') throw error;
        let claim; const claimPath = file + '.reclaim';
        try {
          claim = await open(claimPath, 'wx', 0o600); await claim.writeFile(JSON.stringify({ pid: process.pid, nonce }));
          let saved; try { saved = JSON.parse(await readFile(file, 'utf8')); } catch {}
          let absent = false;
          if (Number.isInteger(saved?.pid) && saved.pid > 0 && typeof saved.nonce === 'string') {
            try { process.kill(saved.pid, 0); } catch (probe) { absent = probe.code === 'ESRCH'; }
          }
          if (!absent) throw fail('runtime_host_exists', 'A Companion host already owns this data directory, or its PID cannot be verified absent. It may be restarting; do not launch a duplicate.', 409);
          await removeOwned(file, saved.nonce);
        } catch (claimError) { if (!['ENOENT'].includes(claimError.code)) { if (claimError.code === 'EEXIST') throw fail('runtime_host_exists', 'A runtime lock recovery claim already exists. If its owner has stopped, the retained claim requires manual review; it is not removed automatically.', 409); throw claimError; } }
        finally { if (claim) { await claim.close(); await removeOwned(claimPath, nonce); } }
      }
    }
    throw fail('runtime_host_exists', 'The runtime host lock could not be acquired safely.', 409);
  }
  async function acquire() {
    if (lock) return;
    await verifiedSupervisor();
    lock = await claimLock(lockPath);
    try { portLock = await claimLock(portLockPath); }
    catch (error) { await lock.close(); lock = null; await removeOwned(lockPath, nonce); throw error; }
  }
  async function stop(record, reason) {
    if (!record || record.exited) return;
    record.expectedStop = true;
    try { if (record.child.connected) record.child.send({ type: 'companion:shutdown', instance: record.instance, reason }, error => { if (error) record.error = error; }); } catch (error) { record.error = error; }
    const waitForExit = milliseconds => new Promise(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      record.exit.then(() => { clearTimeout(timer); resolve(); });
    });
    await waitForExit(shutdownTimeoutMs);
    if (!record.exited) { record.child.kill('SIGKILL'); await waitForExit(2000); }
    if (!record.exited) throw fail('runtime_stop_failed', 'The owned worker did not stop. Manual recovery is required.');
  }
  async function healthy(record) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(1500, startupTimeoutMs));
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok || response.headers.get('x-companion-instance') !== record.instance) return false;
      if (Number(response.headers.get('content-length')) > 4096) return false;
      const reader = response.body?.getReader(); if (!reader) return false;
      const chunks = []; let length = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4096) { await reader.cancel(); return false; } chunks.push(value); }
      } finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); return body?.service === 'companion-shared';
    } catch { return false; } finally { clearTimeout(timer); }
  }
  function scheduleCrash(record) {
    if (closing || record.expectedStop || !record.ready) return;
    void enqueue(async () => {
      if (closing || current !== record) return;
      if (crashRestarts >= maxCrashRestarts) {
        await update({ status: 'failed', workerPid: null, error: 'The worker repeatedly exited. Automatic recovery stopped; inspect the app logs and retained source backups.' });
        onFatal(status()); return;
      }
      crashRestarts += 1; await update({ status: 'restarting', workerPid: null, crashRestarts, error: `Worker exited (${record.code ?? record.signal ?? 'unknown'}). Restarting within the bounded crash budget.` });
      await wait(Math.min(5000, backoffMs * 2 ** (crashRestarts - 1)));
      if (!closing) {
        try { await launch(); }
        catch (error) { await update({ status: 'failed', workerPid: null, error: error.message }); onFatal(status()); }
      }
    }).catch(async error => { await update({ status: 'failed', error: error.message }).catch(() => {}); onFatal(status()); });
  }
  async function launch() {
    if (closing) throw fail('runtime_closing', 'The runtime host is shutting down.');
    await verifiedSupervisor();
    if (!spawnWorker) {
      const info = await lstat(workerPath); const directory = await lstat(path.dirname(workerPath));
      if (!info.isFile() || info.isSymbolicLink() || directory.isSymbolicLink() || !(await realpath(workerPath)).startsWith(sourceRoot + path.sep)) throw fail('invalid_worker', 'The fixed worker entry must be a regular contained source file.');
    }
    const instance = randomUUID();
    await update({ status: 'starting', workerPid: null, generation: metadata.generation + 1, instance, error: null });
    const child = spawnWorker ? spawnWorker({ workerPath, cwd: sourceRoot, env: workerEnvironment(storage, port, instance, hostInstanceId, supervisor), instance, port })
      : spawn(process.execPath, [workerPath], { cwd: sourceRoot, env: workerEnvironment(storage, port, instance, hostInstanceId, supervisor), windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let resolveExit;
    const record = { child, instance, ready: false, ipcReady: false, expectedStop: false, exited: false, exit: new Promise(resolve => { resolveExit = resolve; }) };
    current = record;
    child.on('message', message => {
      if (!message || message.instance !== instance || current !== record) return;
      if (message.type === 'companion:ready' && message.port === port) record.ipcReady = true;
      if (message.type === 'companion:restart-requested' && record.ipcReady && !closing
        && (message.jobId === undefined || typeof message.jobId === 'string' && uuid.test(message.jobId)) && (message.scope === undefined || ['worker', 'host'].includes(message.scope))
        && Object.keys(message).every(key => ['type', 'instance', 'jobId', 'scope'].includes(key))) {
        if (message.scope === 'host') {
          if (!supervisor || !onHostRestart || record.hostRestartRequested) return;
          record.hostRestartRequested = true; Promise.resolve().then(() => onHostRestart({ ...(message.jobId ? { jobId: message.jobId } : {}) })).catch(() => { record.hostRestartRequested = false; });
        } else if(!record.restartRequested&&!record.hostRestartRequested) { record.restartRequested = true; void restart({ jobId: message.jobId }).catch(() => {}); }
      }
    });
    child.on('error', error => {
      record.error = error;
      // IPC sends and failed kill attempts also emit 'error'. A child with a
      // PID remains ours until its actual exit event proves termination.
      if (!Number.isInteger(child.pid) || child.pid <= 0) { record.exited = true; resolveExit(); }
    });
    child.once('exit', (code, signal) => { record.exited = true; record.code = code; record.signal = signal; resolveExit(); scheduleCrash(record); });
    await update({ workerPid: child.pid || null });
    const until = Date.now() + startupTimeoutMs;
    try {
      while (Date.now() < until && !closing && !record.exited) {
        if (record.ipcReady && await healthy(record)) { record.ready = true; await update({ status: 'ready', workerPid: child.pid || null, error: null }); return status(); }
        await Promise.race([record.exit, wait(75)]);
      }
      throw fail(closing ? 'runtime_closing' : 'runtime_start_failed', closing ? 'The runtime host is shutting down.' : `The worker did not become healthy on port ${port}${record.exited ? ' before exiting' : ' before its startup deadline'}.`);
    } catch (error) { await stop(record, 'startup-failed'); throw error; }
  }
  async function restore(jobId) {
    if (rollback) return rollback(jobId);
    const builder = await trustedFeatureBuilder({ root: sourceRoot, dataDirectory: path.join(storage, 'feature-builds'), complete: async () => { throw new Error('Recovery never requests a model completion.'); } });
    try { return await builder.rollback(jobId, 'local-workspace'); } finally { await builder.close(); }
  }
  async function restart({ jobId } = {}) {
    if (jobId !== undefined && (typeof jobId !== 'string' || !uuid.test(jobId))) throw fail('invalid_restart_request', 'Use an optional feature job UUID.', 400);
    return enqueue(async () => {
      if (!started || closing) throw fail('runtime_closing', 'Start a live host before requesting a restart.');
      await update({ status: 'restarting', restartJobId: jobId || null });
      await stop(current, 'restart');
      try { return await launch(); }
      catch (error) {
        if (closing) throw error;
        if (jobId) {
          await update({ status: 'recovering', workerPid: null, error: 'The updated worker failed startup. Restoring the recorded feature backup.' });
          try {
            await restore(jobId); await update({ lastRollbackJobId: jobId, restartJobId: null });
            return await launch();
          } catch (recovery) { await update({ status: 'failed', workerPid: null, error: `Automatic source recovery could not finish: ${recovery.message}. Retained backups require manual review.` }); onFatal(status()); throw recovery; }
        }
        await update({ status: 'failed', workerPid: null, error: error.message }); onFatal(status()); throw error;
      }
    });
  }
  return {
    status,
    async start() {
      return enqueue(async () => {
        if (closing) throw fail('runtime_closing', 'The runtime host is shutting down.');
        if (started) return status();
        await acquire(); started = true;
        try { return await launch(); } catch (error) { await update({ status: 'failed', workerPid: null, error: error.message }); throw error; }
      });
    },
    restart,
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await operations;
        if (lock) {
          await update({ status: 'stopping' }); await stop(current, 'shutdown');
          await update({ status: 'stopped', workerPid: null }); await writes;
          if (portLock) { await portLock.close(); portLock = null; await removeOwned(portLockPath, nonce); }
          await lock.close(); lock = null; await removeOwned(lockPath, nonce);
        }
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node server/companion-host.mjs\nCOMPANION_SHARED_PORT sets the fixed loopback port; COMPANION_SHARED_DATA_DIR sets private runtime data. The host manages only its own Node worker.');
  else {
    if (process.argv.length > 2) throw new Error('Configure the host with COMPANION_SHARED_PORT and COMPANION_SHARED_DATA_DIR.');
    let host,creating,stopping,stopRequested=false;
    const supervised = process.env.COMPANION_SUPERVISED_HOST === '1', instance = process.env.COMPANION_SUPERVISOR_INSTANCE;
    const send=message=>new Promise((resolve,reject)=>{if(typeof process.send!=='function'||!process.connected){reject(fail('supervisor_unavailable','The supervisor connection closed.'));return;}try{process.send(message,error=>error?reject(error):resolve());}catch(error){reject(error);}});
    const stop = () => {stopRequested=true;return stopping ||= Promise.resolve().then(async()=>{
      await creating?.catch(()=>{});await host?.close();
      if(supervised&&process.connected){await send({type:'companion:host-stopped',instance});if(process.connected)process.disconnect();}
    }).catch(error=>{process.exitCode=1;console.error('Companion host could not confirm shutdown: '+error.message);});};
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (supervised) { process.on('message', message => { if (message?.type === 'companion:host-shutdown' && message.instance === instance && Object.keys(message).every(key => ['type', 'instance'].includes(key))) void stop(); }); process.once('disconnect', () => { void stop(); }); }
    try {
      if(supervised)await send({type:'companion:host-starting',instance});
      if(!stopRequested){
        creating=createCompanionHost({dataDirectory:path.resolve(process.env.COMPANION_SHARED_DATA_DIR||path.resolve(DEFAULT_ROOT,'..','..','work','companion-shared')),port:Number(process.env.COMPANION_SHARED_PORT||4174),onFatal:()=>{process.exitCode=1;void stop();},...(supervised?{onHostRestart:({jobId})=>send({type:'companion:host-restart-requested',instance,...(jobId?{jobId}:{})})}:{})}).then(value=>{host=value;return value;});
        await creating;if(stopRequested)await stop();else{const ready=await host.start();if(!stopRequested){if(supervised)await send({type:'companion:host-ready',instance,status:ready});console.log(`Companion managed host ${ready.pid}: http://127.0.0.1:${ready.port}/assistant.html`);}}
      }
    }catch(error){console.error(error.message);process.exitCode=1;await stop();}
  }
}
