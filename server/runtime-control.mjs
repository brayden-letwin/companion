const pending = new WeakMap();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function getRuntimeStatus(runtime = process) {
  const managed = runtime.env?.COMPANION_MANAGED_HOST === '1' && typeof runtime.send === 'function'
    && runtime.connected === true && typeof runtime.env.COMPANION_HOST_INSTANCE === 'string';
  const hostInstanceId=runtime.env?.COMPANION_HOST_LIFETIME,supervisorPid=Number(runtime.env?.COMPANION_SUPERVISOR_PID);
  const supervisorInstanceId=runtime.env?.COMPANION_SUPERVISOR_LIFETIME;
  const hostRestartAvailable=managed&&runtime.env.COMPANION_SUPERVISED_HOST==='1'&&uuid.test(hostInstanceId||'')&&Number.isInteger(supervisorPid)&&supervisorPid>0&&uuid.test(runtime.env.COMPANION_SUPERVISOR_NONCE||'')&&uuid.test(runtime.env.COMPANION_SUPERVISOR_INSTANCE||'')&&uuid.test(supervisorInstanceId||'');
  return { managed, restarting: managed && pending.has(runtime), workerPid: runtime.pid,hostRestartAvailable,
    ...(managed ? { hostPid: Number(runtime.env.COMPANION_HOST_PID),workerInstanceId:runtime.env.COMPANION_HOST_INSTANCE,...(uuid.test(hostInstanceId||'')?{hostInstanceId}:{}),...(hostRestartAvailable?{supervisorPid,supervisorInstanceId}:{}) } : {}) };
}

/** A typed request to this worker's parent; never a command, path, or target PID. */
export function requestRuntimeRestart(options = {}, runtime = process) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['jobId','scope'].includes(key))
    || options.jobId !== undefined && (typeof options.jobId !== 'string' || !uuid.test(options.jobId)) || options.scope!==undefined&&!['worker','host'].includes(options.scope)) {
    throw Object.assign(new Error('Use an optional feature job UUID and worker or host restart scope.'), { statusCode: 400, code: 'invalid_restart_request' });
  }
  const status = getRuntimeStatus(runtime);
  const scope=options.scope||'worker';
  if(scope==='host'&&!status.hostRestartAvailable)throw Object.assign(new Error('This host needs a full launcher restart to load parent-process source.'),{statusCode:409,code:'manual_host_restart_required'});
  if (!status.managed) return { managed: false, restarting: false };
  if (pending.has(runtime) && (pending.get(runtime)==='host'||scope==='worker')) return { managed: true, restarting: true };
  pending.set(runtime,scope);
  try {
    runtime.send({ type: 'companion:restart-requested', instance: runtime.env.COMPANION_HOST_INSTANCE,
      ...(options.jobId ? { jobId: options.jobId } : {}),...(options.scope?{scope}:{}) }, error => { if (error&&pending.get(runtime)===scope) pending.delete(runtime); });
    return { managed: true, restarting: pending.has(runtime) };
  } catch { if(pending.get(runtime)===scope)pending.delete(runtime); return { managed: true, restarting: pending.has(runtime) }; }
}
