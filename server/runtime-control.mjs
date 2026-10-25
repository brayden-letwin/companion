const pending = new WeakSet();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function getRuntimeStatus(runtime = process) {
  const managed = runtime.env?.COMPANION_MANAGED_HOST === '1' && typeof runtime.send === 'function'
    && runtime.connected === true && typeof runtime.env.COMPANION_HOST_INSTANCE === 'string';
  return { managed, restarting: managed && pending.has(runtime), workerPid: runtime.pid,
    ...(managed ? { hostPid: Number(runtime.env.COMPANION_HOST_PID) } : {}) };
}

/** A typed request to this worker's parent; never a command, path, or target PID. */
export function requestRuntimeRestart(options = {}, runtime = process) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'jobId')
    || options.jobId !== undefined && (typeof options.jobId !== 'string' || !uuid.test(options.jobId))) {
    throw Object.assign(new Error('Use an optional feature job UUID for a runtime restart.'), { statusCode: 400, code: 'invalid_restart_request' });
  }
  const status = getRuntimeStatus(runtime);
  if (!status.managed) return { managed: false, restarting: false };
  if (pending.has(runtime)) return { managed: true, restarting: true };
  pending.add(runtime);
  try {
    runtime.send({ type: 'companion:restart-requested', instance: runtime.env.COMPANION_HOST_INSTANCE,
      ...(options.jobId ? { jobId: options.jobId } : {}) }, error => { if (error) pending.delete(runtime); });
    return { managed: true, restarting: pending.has(runtime) };
  } catch { pending.delete(runtime); return { managed: true, restarting: false }; }
}
