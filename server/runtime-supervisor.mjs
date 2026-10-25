import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile, rename, unlink, open, lstat, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createFeatureBuilder as trustedFeatureBuilder } from './feature-builder.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const positive = value => Number.isInteger(value) && value > 0;

/** Stable owner of one replaceable host. No commands or process targets come from HTTP. */
export async function createRuntimeSupervisor({ root = DEFAULT_ROOT, dataDirectory, port = 4174,
  spawnHost, fetchImpl = globalThis.fetch, rollback, startupTimeoutMs = 20000,
  shutdownTimeoutMs = 30000, onFatal = () => {} } = {}) {
  const sourceRoot = await realpath(path.resolve(root));
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw new TypeError('Use an absolute private runtime data directory.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError('Choose a fixed local port from 1024 to 65535.');
  for (const value of [startupTimeoutMs, shutdownTimeoutMs]) if (!Number.isInteger(value) || value < 50 || value > 120000) throw new RangeError('Use bounded startup and shutdown timeouts.');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const storage = await realpath(dataDirectory);
  if (storage === sourceRoot || storage.startsWith(sourceRoot + path.sep)) throw new TypeError('Runtime data must stay outside application source.');
  const hostPath = path.join(sourceRoot, 'server', 'companion-host.mjs');
  const bootstrap = await readFile(new URL('./runtime-host-entry.mjs', import.meta.url), 'utf8');
  const lockPaths = [path.join(storage, 'runtime-supervisor.lock'), path.join(sourceRoot, `.companion-supervisor-${port}.lock`)];
  const recoveryPaths = lockPaths.map(file => file + '.recovery');
  const metadataPath = path.join(storage, 'runtime-supervisor.json');
  const nonce = randomUUID(), supervisorInstanceId = randomUUID();
  const claim = { pid: process.pid, nonce, port, sourceRoot };
  const metadata = { version: 1, pid: process.pid, nonce, supervisorInstanceId, port, sourceRoot, status: 'stopped',
    hostPid: null, workerPid: null, hostInstanceId: null, generation: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null };
  const locks = [];
  let recoveryGuard = null;
  const controlDirectory = path.join(storage, 'runtime-control', randomUUID());
  const bootstrapPath = path.join(controlDirectory, 'entry.mjs');
  const stopRequestPath = path.join(storage, 'runtime-supervisor.stop');
  let stopWatcher = null, checkingStop = false;
  let current = null, started = false, closing = false, closePromise = null, operations = Promise.resolve(), writes = Promise.resolve(), restartPromise = null;
  const status = () => structuredClone(metadata);
  const enqueue = callback => { const result = operations.then(callback, callback); operations = result.catch(() => {}); return result; };
  const ownStopRequest = request => request && request.action === 'shutdown' && request.pid === claim.pid && request.nonce === nonce
    && request.port === port && request.sourceRoot === sourceRoot && Object.keys(request).length === 5;
  async function removeOwnStopRequest() {
    try {
      const info = await lstat(stopRequestPath); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return false;
      const text = await readFile(stopRequestPath, 'utf8'); if (!ownStopRequest(JSON.parse(text))) return false;
      if (await readFile(stopRequestPath, 'utf8') !== text) return false;
      await unlink(stopRequestPath); return true;
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }
  async function observeStop() {
    if (checkingStop || closePromise) return;
    checkingStop = true;
    try { if (await removeOwnStopRequest()) void close().catch(error => { void update({ status: 'failed', error: error.message }).catch(() => {}); }); }
    catch { /* A malformed/unreadable local request cannot grant shutdown. */ }
    finally { checkingStop = false; }
  }
  async function update(values) {
    Object.assign(metadata, values, { updatedAt: new Date().toISOString() });
    const body = JSON.stringify(metadata), temporary = path.join(storage, `.runtime-supervisor-${randomUUID()}.tmp`);
    const operation = writes.then(async () => {
      try {
        await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, metadataPath); break; }
          catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 3) throw error; await wait(20 * (attempt + 1)); }
        }
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    writes = operation.catch(() => {}); await operation;
  }
  async function removeOwned(file, expectedNonce) {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.nonce !== expectedNonce) throw fail('supervisor_lock_changed', 'Launcher ownership changed. No other process was stopped.', 409);
    await unlink(file);
  }
  async function acquireOne(file) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let handle;
      try { handle = await open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify(claim)); return { file, handle }; }
      catch (error) {
        if (handle) { await handle.close(); throw error; }
        if (error.code !== 'EEXIST') throw error;
        let reclaim;
        const reclaimPath = file + '.reclaim';
        try {
          reclaim = await open(reclaimPath, 'wx', 0o600); await reclaim.writeFile(JSON.stringify(claim));
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink()) throw fail('supervisor_exists', 'Launcher ownership needs review. No duplicate service was started.', 409);
          const saved = JSON.parse(await readFile(file, 'utf8'));
          let absent = false;
          if (positive(saved?.pid) && UUID.test(saved.nonce || '')) {
            try { process.kill(saved.pid, 0); } catch (probe) { absent = probe.code === 'ESRCH'; }
          }
          if (!absent) throw fail('supervisor_exists', 'A launcher already owns this workspace or port, or its process cannot be verified absent. No duplicate service was started.', 409);
          await removeOwned(file, saved.nonce);
        } catch (error) {
          if (error.code === 'EEXIST') throw fail('supervisor_exists', 'Launcher recovery is already claimed. Inspect the retained claim instead of launching a duplicate.', 409);
          if (error.code !== 'ENOENT') throw error;
        } finally { if (reclaim) { await reclaim.close(); await removeOwned(reclaimPath, nonce); } }
      }
    }
    throw fail('supervisor_exists', 'Launcher ownership could not be acquired safely.', 409);
  }
  async function acquire() {
    for (const file of recoveryPaths) {
      try {
        await lstat(file);
        let ownerLive = false;
        try { const saved = JSON.parse(await readFile(file, 'utf8')); if (positive(saved.pid)) { process.kill(saved.pid, 0); ownerLive = true; } } catch { /* Absence or uncertainty never clears recovery. */ }
        throw ownerLive ? fail('supervisor_exists', 'A launcher owns this active service. No duplicate service was started.', 409)
          : fail('supervisor_recovery_required', 'A previous service did not confirm shutdown. Retained launcher ownership needs review; no locks were reclaimed or duplicate service started.', 409);
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { for (const file of lockPaths) locks.push(await acquireOne(file)); }
    catch (error) { await release(); throw error; }
  }
  async function release() {
    while (locks.length) { const owned = locks.pop(); await owned.handle.close(); await removeOwned(owned.file, nonce); }
  }
  async function retainUnconfirmed(reason) {
    // Keep this owner alive even if its child/IPC has already disappeared.
    // Durable markers also stop a later launcher reclaiming a now-dead PID.
    recoveryGuard ||= setInterval(() => {}, 60000);
    for (const file of recoveryPaths) {
      try { await writeFile(file, JSON.stringify({ ...claim, requiresManualRecovery: true, reason }), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (saved.nonce !== nonce) throw fail('supervisor_lock_changed', 'Retained recovery ownership changed. Inspect the runtime before relaunching.', 409);
      }
    }
  }
  async function clearConfirmedRecovery() {
    for (const file of recoveryPaths) await removeOwned(file, nonce).catch(error => { if (error.code !== 'ENOENT') throw error; });
    clearInterval(recoveryGuard); recoveryGuard = null;
  }
  function environment(instance) {
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'COMPANION_LOCAL_MODEL']) if (process.env[name]) env[name] = process.env[name];
    return { ...env, COMPANION_SOURCE_ROOT: sourceRoot, COMPANION_SHARED_DATA_DIR: storage, COMPANION_SHARED_PORT: String(port),
      COMPANION_SUPERVISED_HOST: '1', COMPANION_SUPERVISOR_PID: String(process.pid),
      COMPANION_SUPERVISOR_NONCE: nonce, COMPANION_SUPERVISOR_LIFETIME: supervisorInstanceId,
      COMPANION_SUPERVISOR_INSTANCE: instance };
  }
  function validReady(record, value) {
    return value && value.status === 'ready' && value.pid === record.child.pid && positive(value.workerPid)
      && value.port === port && value.sourceRoot === sourceRoot && UUID.test(value.hostInstanceId || '') && UUID.test(value.instance || '');
  }
  async function healthy(record, value) {
    if (!validReady(record, value)) return false;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok || response.headers.get('x-companion-instance') !== value.instance || Number(response.headers.get('content-length')) > 4096) return false;
      const reader = response.body?.getReader(); if (!reader) return false;
      const chunks = []; let length = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4096) { await reader.cancel(); return false; } chunks.push(value); } }
      finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks, length).toString('utf8')).service === 'companion-shared';
    } catch { return false; } finally { clearTimeout(timer); }
  }
  async function stop(record, reason) {
    if (!record) return;
    record.expectedStop = true;
    if (!record.closed) {
      try { if (record.child.connected) record.child.send({ type: 'companion:host-shutdown', instance: record.instance, reason }, error => { if (error) record.error = error; }); }
      catch (error) { record.error = error; }
      let timer;
      await Promise.race([record.close, new Promise(resolve => { timer = setTimeout(resolve, shutdownTimeoutMs); })]); clearTimeout(timer);
    }
    await record.authorization?.catch(() => {});
    if (!record.closed) { await retainUnconfirmed('owned_host_still_live'); throw fail('supervisor_stop_unconfirmed', 'The owned service has not confirmed shutdown. No replacement was started; launcher ownership is retained.'); }
    if (record.starting && !record.stopped) { await retainUnconfirmed('worker_shutdown_unconfirmed'); throw fail('supervisor_stop_unconfirmed', 'The service exited without confirming its worker stopped. No replacement or source restoration was attempted; inspect the retained runtime.'); }
    await clearConfirmedRecovery();
  }
  async function launch() {
    if (closing) throw fail('supervisor_closing', 'The launcher is shutting down.');
    if (!spawnHost) {
      const info = await lstat(hostPath), directory = await lstat(path.dirname(hostPath));
      if (!info.isFile() || info.isSymbolicLink() || directory.isSymbolicLink() || !(await realpath(hostPath)).startsWith(sourceRoot + path.sep)) throw fail('invalid_host', 'The fixed service entry must be a regular contained source file.');
    }
    const instance = randomUUID();
    await update({ status: 'starting', hostPid: null, workerPid: null, hostInstanceId: null, generation: metadata.generation + 1, error: null });
    const child = spawnHost ? spawnHost({ hostPath, bootstrapPath, cwd: sourceRoot, env: environment(instance), instance, port })
      : spawn(process.execPath, [bootstrapPath], { cwd: sourceRoot, env: environment(instance), windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let resolveClose;
    const record = { child, instance, starting: false, stopped: false, ready: false, packet: null, closed: false, expectedStop: false, restartRequested: false, close: new Promise(resolve => { resolveClose = resolve; }) };
    current = record;
    child.on('message', message => {
      if (current !== record || record.closed || message?.instance !== instance) return;
      if (message.type === 'companion:host-starting' && !record.expectedStop && !closing && !record.starting) {
        record.starting = true;
        record.authorization = (async () => {
          await retainUnconfirmed('host_lifecycle_in_progress');
          if (current !== record || record.expectedStop || record.closed || closing) return;
          record.allowed = true;
          child.send({ type: 'companion:host-start-allowed', instance }, error => { if (error) record.error = error; });
        })().catch(error => { record.error = error; });
      }
      if (message.type === 'companion:host-stopped') record.stopped = true;
      if (message.type === 'companion:host-ready' && record.allowed && !record.expectedStop && validReady(record, message.status)) record.packet = message.status;
      if (message.type === 'companion:host-restart-requested' && record.ready && !record.expectedStop && !record.restartRequested
        && (message.jobId === undefined || UUID.test(message.jobId))) {
        record.restartRequested = true; void restart({ jobId: message.jobId }).catch(() => {});
      }
    });
    child.on('error', error => {
      record.error = error;
      if (!positive(child.pid)) { record.closed = true; resolveClose(); }
    });
    child.once('close', (code, signal) => {
      record.closed = true; record.code = code; record.signal = signal; resolveClose();
      if (record.ready && !record.expectedStop && !closing) void enqueue(async () => {
        if (current !== record || closing) return;
        await retainUnconfirmed('unexpected_host_exit');
        await update({ status: 'failed', error: 'The service exited unexpectedly. Its worker shutdown is unconfirmed; automatic replacement stopped. Inspect the retained runtime before relaunching.' });
        try { onFatal(status()); } catch { /* Observation does not change ownership. */ }
      }).catch(() => {});
    });
    await update({ hostPid: child.pid || null });
    const until = Date.now() + startupTimeoutMs;
    try {
      while (Date.now() < until && !closing && !record.closed) {
        const packet = record.packet;
        if (record.starting && packet && await healthy(record, packet) && current === record && !record.closed && !closing) {
          record.ready = true;
          await update({ status: 'ready', hostPid: child.pid, workerPid: packet.workerPid, hostInstanceId: packet.hostInstanceId, error: null }); return status();
        }
        await Promise.race([record.close, wait(75)]);
      }
      throw fail(closing ? 'supervisor_closing' : 'supervisor_start_failed', closing ? 'The launcher is shutting down.' : 'The service did not establish its own healthy identity before the startup deadline.');
    } catch (error) { await stop(record, 'startup-failed'); throw error; }
  }
  async function restore(jobId) {
    if (rollback) return rollback(jobId);
    const builder = await trustedFeatureBuilder({ root: sourceRoot, dataDirectory: path.join(storage, 'feature-builds'), complete: async () => { throw new Error('Recovery never calls a model.'); } });
    try { return await builder.rollback(jobId, 'local-workspace'); } finally { await builder.close(); }
  }
  function restart({ jobId } = {}) {
    if (jobId !== undefined && (typeof jobId !== 'string' || !UUID.test(jobId))) return Promise.reject(fail('invalid_restart_request', 'Use an optional feature job UUID.', 400));
    if (restartPromise) return restartPromise;
    restartPromise = enqueue(async () => {
      if (!started || closing) throw fail('supervisor_closing', 'Start the launcher before restarting its service.');
      await update({ status: 'restarting', restartJobId: jobId || null });
      await stop(current, 'restart');
      try { return await launch(); }
      catch (error) {
        if (closing || error.code === 'supervisor_stop_unconfirmed') throw error;
        if (jobId) {
          await update({ status: 'recovering', error: 'The update could not start. Restoring its retained source backup.' });
          try { await restore(jobId); await update({ lastRollbackJobId: jobId, restartJobId: null }); return await launch(); }
          catch (recovery) { await update({ status: 'failed', error: `Source recovery could not finish: ${recovery.message} Retained backups need review.` }); throw recovery; }
        }
        await update({ status: 'failed', error: error.message }); throw error;
      }
    }).catch(async error => { await update({ status: 'failed', error: error.message }).catch(() => {}); throw error; }).finally(() => { restartPromise = null; });
    return restartPromise;
  }
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await operations;
      if (!locks.length) return;
      await update({ status: 'stopping' }); await stop(current, 'shutdown');
      await update({ status: 'stopped', hostPid: null, workerPid: null }); await writes;
      await removeOwnStopRequest(); await release();
      clearInterval(stopWatcher); stopWatcher = null;
      await unlink(bootstrapPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(controlDirectory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    })().catch(error => { closePromise = null; throw error; });
    return closePromise;
  }
  return {
    status,
    async start() {
      return enqueue(async () => {
        if (closing) throw fail('supervisor_closing', 'The launcher is shutting down.');
        if (started) return status();
        await acquire(); started = true;
        await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
        await writeFile(bootstrapPath, bootstrap, { flag: 'wx', mode: 0o600 });
        stopWatcher = setInterval(() => { void observeStop(); }, 250);
        try { return await launch(); } catch (error) { await update({ status: 'failed', error: error.message }); throw error; }
      });
    },
    restart,
    close,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node server/runtime-supervisor.mjs\nThe launcher owns one fixed Companion service and its full-host restarts. Configure COMPANION_SHARED_PORT and COMPANION_SHARED_DATA_DIR.');
  else {
    if (process.argv.length > 2) throw new Error('Configure the launcher through COMPANION_SHARED_PORT and COMPANION_SHARED_DATA_DIR.');
    const supervisor = await createRuntimeSupervisor({ dataDirectory: path.resolve(process.env.COMPANION_SHARED_DATA_DIR || path.resolve(DEFAULT_ROOT, '..', '..', 'work', 'companion-shared')),
      port: Number(process.env.COMPANION_SHARED_PORT || 4174) });
    const stop = () => { void supervisor.close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { const ready = await supervisor.start(); console.log(`Companion launcher ${ready.pid}: http://127.0.0.1:${ready.port}/assistant.html`); }
    catch (error) { console.error(error.message); process.exitCode = 1; await supervisor.close().catch(closeError => console.error(closeError.message)); }
  }
}
